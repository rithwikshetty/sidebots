import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_HEADER, CONTRACT_VERSION, KEEPALIVE_MS, PAGE, type AgentWithLatest, type Connected, type Message, type StreamEvent } from "../../server/src/contract.ts";
import { ApiError } from "../api.ts";
import { createStore } from "../store.ts";

const agent = (id: string, more: Partial<AgentWithLatest> = {}): AgentWithLatest => ({
  id,
  person_id: "me",
  name: id,
  avatar_id: "mochi",
  provider: "claude",
  model: "opus",
  effort: "medium",
  fast: false,
  ran_on: null,
  muted: false,
  hidden: false,
  color: null,
  session_id: null,
  read_at: 0,
  created_at: 0,
  latest: null,
  working: false,
  unread: 0,
  waiting_on: null,
  ...more,
});

/** A message in Mochi's chat, named by what it says, unless `more` says otherwise. */
const row = (body: string, more: Partial<Message> = {}): Message => ({
  id: body,
  agent_id: "mochi",
  sender: "agent",
  body,
  attachments: [],
  status: "done",
  seen_at: null,
  reply_to: null,
  job_id: null,
  interim: false,
  ask: null,
  question: null,
  peer_id: null,
  switched: null,
  created_at: 0,
  ...more,
});

const gmail: Connected = { connection: "gmail", name: "Gmail", allows: "Read and send your mail", logo: { path: "", color: null }, account: null };

type Call = { method: string; path: string; body: unknown };

/** An event stream the test speaks through, as a computer on `version` of the contract answers with it. */
function stream(version = CONTRACT_VERSION) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start: (given) => void (controller = given), cancel: () => void (cancelled = true) });
  const write = (text: string) => controller.enqueue(new TextEncoder().encode(text));
  return {
    response: new Response(body, { status: 200, headers: { [CONTRACT_HEADER]: String(version) } }),
    write,
    say: (event: StreamEvent) => write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => controller.close(),
    cancelled: () => cancelled,
  };
}

/** Lets what the store has started run as far as it can without a timer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A store with a made-up computer behind it. `answers` are the computer's, by
 * method and path, and a call it has none for is refused as not found.
 * `streams` are what it answers the event stream with, one for each time the
 * stream is opened. `saved` is the copy a store before this one left.
 * `heard.changed` calls a listener each time the store changes, as a screen
 * showing what the test last read of the store is called, until the function
 * it returns is called, as when the screen closes.
 */
function app(t: TestContext, saved: object = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls: Call[] = [];
  const answers: Record<string, (call: Call) => unknown> = {
    "GET /avatars": () => [],
    "GET /connections": () => [],
  };
  const streams: (() => Promise<Response> | Response)[] = [];
  const opened: AbortSignal[] = [];
  const kept: Record<string, string> = { "cache-6": JSON.stringify(saved) };
  const heard = { front: (_dropped = false) => {}, refused: 0, signIn: null as string | null, changed: (_listener: () => void) => () => {} };
  const store = createStore<string>({
    async request<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      const call = { method: init.method ?? "GET", path, body: init.body };
      calls.push(call);
      const answer = answers[`${call.method} ${path}`];
      if (!answer) throw new ApiError("Not found.", 404);
      return answer(call) as T;
    },
    async events(signal) {
      opened.push(signal);
      const next = streams.shift();
      if (!next) throw new Error("no answer");
      return next();
    },
    storage: { getItem: (key) => kept[key] ?? null, setItem: (key, value) => void (kept[key] = value) },
    onFront(listener) {
      heard.front = (dropped = false) => listener(dropped);
      return () => void (heard.front = () => {});
    },
    attach: (form, file) => form.append("files", file),
    signIn: async () => heard.signIn,
    onRefused: () => void heard.refused++,
    useSyncExternalStore: (subscribe, snapshot) => {
      heard.changed = subscribe;
      return snapshot();
    },
  });
  /** What the store has saved, once the wait before a save has passed. */
  const savedNow = () => {
    t.mock.timers.tick(300);
    return JSON.parse(kept["cache-6"]);
  };
  const asked = () => calls.map((call) => `${call.method} ${call.path}`);
  return { store, calls, asked, answers, streams, opened, heard, savedNow, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("a store starts from the copy the app saved, and saves what it learns under the same key without what is only true for now", async (t) => {
  const { store, answers, savedNow } = app(t, { agents: [agent("mochi")], messages: { mochi: [row("hello")] } });
  assert.deepEqual(store.useAgents(), [agent("mochi")]);
  assert.deepEqual(store.useMessages("mochi"), [row("hello")]);
  assert.equal(store.useUsage(), null);
  assert.equal(store.useOnline(), true);

  answers["GET /usage"] = () => ({ used: [], days: [], accounts: [] });
  await store.loadUsage();
  assert.deepEqual(savedNow(), {
    agents: [agent("mochi")],
    messages: { mochi: [row("hello")] },
    avatars: [],
    about: {},
    usage: { used: [], days: [], accounts: [] },
    connections: null,
    pending: {},
  });
});

test("the event stream brings an agent to the top with its message, which lands only in a chat the app has opened", async (t) => {
  const { store, answers, streams } = app(t, { messages: { mochi: [row("hello")] } });
  answers["GET /agents"] = () => [agent("mochi"), agent("cog")];
  answers["GET /agents/mochi/messages"] = () => [row("hello")];
  const events = stream();
  streams.push(() => events.response);
  const told: string[][] = [];
  store.onAgents((agents) => told.push(agents.map((each) => each.id)));
  store.startSync();
  await settle();
  assert.deepEqual(told, [["mochi", "cog"]]);

  events.say({ message: row("hi", { agent_id: "cog" }), agent: agent("cog", { unread: 1 }) });
  // An event the connection brings in two pieces is read once it is whole.
  const working = `data: ${JSON.stringify({ message: row("on it", { status: "running" }), agent: agent("mochi", { working: true }) })}\n\n`;
  events.write(working.slice(0, 40));
  await settle();
  assert.deepEqual(store.useAgents().map((each) => each.id), ["cog", "mochi"]);
  assert.equal(store.useAgent("cog")?.unread, 1);
  assert.deepEqual(store.useMessages("cog"), []);

  events.write(working.slice(40));
  await settle();
  assert.deepEqual(store.useAgents().map((each) => each.id), ["mochi", "cog"]);
  assert.deepEqual(store.useMessages("mochi"), [row("hello"), row("on it", { status: "running" })]);

  // A message the app has is replaced by the stream's newer copy of it.
  events.say({ message: row("on it"), agent: agent("mochi") });
  await settle();
  assert.deepEqual(store.useMessages("mochi"), [row("hello"), row("on it")]);
  assert.deepEqual(told.slice(1), [["cog", "mochi"], ["mochi", "cog"], ["mochi", "cog"]]);

  events.say({ deleted: "mochi" });
  await settle();
  assert.deepEqual(store.useAgents().map((each) => each.id), ["cog"]);
  assert.deepEqual(store.useMessages("mochi"), []);
  store.stopSync();
});

test("an agent the app has that the stream brings with no message keeps its place, and a new one goes to the top", async (t) => {
  const { store, answers, streams } = app(t);
  answers["GET /agents"] = () => [agent("mochi"), agent("cog"), agent("pip")];
  const events = stream();
  streams.push(() => events.response);
  const told: (string | undefined)[] = [];
  store.onAgents((agents) => told.push(agents.find((each) => each.id === "cog")?.name));
  store.startSync();
  await settle();

  // Another device renames and mutes Cog.
  events.say({ message: null, agent: agent("cog", { name: "Cogsworth", muted: true }) });
  await settle();
  assert.deepEqual(store.useAgents().map((each) => each.id), ["mochi", "cog", "pip"]);
  assert.deepEqual(store.useAgent("cog"), agent("cog", { name: "Cogsworth", muted: true }));
  assert.deepEqual(told, ["cog", "Cogsworth"]);

  events.say({ message: null, agent: agent("ember") });
  await settle();
  assert.deepEqual(store.useAgents().map((each) => each.id), ["ember", "mochi", "cog", "pip"]);
  store.stopSync();
});

test("a chat is held from the moment it is opened, an empty one too, so a message the stream brings lands in it", async (t) => {
  const { store, answers, streams, savedNow } = app(t);
  answers["GET /agents"] = () => [agent("mochi"), agent("cog")];
  answers["GET /agents/mochi/messages"] = () => [];
  const events = stream();
  streams.push(() => events.response);
  store.startSync();
  await settle();

  await store.loadMessages("mochi");
  assert.deepEqual(savedNow().messages, { mochi: [] });
  events.say({ message: row("hello"), agent: agent("mochi", { unread: 1 }) });
  await settle();
  assert.deepEqual(store.useMessages("mochi"), [row("hello")]);

  // A chat whose page can't be fetched is held all the same.
  await assert.rejects(store.loadMessages("cog"), { status: 404 });
  events.say({ message: row("hi", { agent_id: "cog" }), agent: agent("cog", { unread: 1 }) });
  await settle();
  assert.deepEqual(store.useMessages("cog"), [row("hi", { agent_id: "cog" })]);
  store.stopSync();
});

test("a message that reaches a chat while its newest page is fetched goes after the page", async (t) => {
  const { store, answers, streams, asked } = app(t, { messages: { cog: [row("one", { agent_id: "cog" }), row("two", { agent_id: "cog" })] } });
  answers["GET /agents"] = () => [agent("mochi"), agent("cog")];
  answers["GET /agents/cog/messages"] = () => [row("one", { agent_id: "cog" }), row("two", { agent_id: "cog" })];
  const events = stream();
  streams.push(() => events.response);
  store.startSync();
  await settle();

  // The computer makes each page before the message the stream then brings, and the page reaches the app after it.
  let fetched!: (page: Message[]) => void;
  answers["GET /agents/mochi/messages"] = () => new Promise<Message[]>((resolve) => (fetched = resolve));
  const opening = store.loadMessages("mochi");
  events.say({ message: row("three"), agent: agent("mochi", { unread: 1 }) });
  await settle();
  assert.deepEqual(store.useMessages("mochi"), [row("three")]);
  fetched([row("one"), row("two")]);
  await opening;
  assert.deepEqual(store.useMessages("mochi").map((message) => message.id), ["one", "two", "three"]);

  // The page may be older than what the stream brought ahead of it, so the chat is fetched again when it is next opened. A page that holds the message takes its place, and a message the person sends meanwhile is kept as the stream's is.
  answers["POST /agents/mochi/messages"] = () => row("four", { sender: "person", status: "queued" });
  const again = store.loadMessages("mochi");
  await store.send("mochi", "four");
  fetched([row("two"), row("three")]);
  await again;
  assert.deepEqual(store.useMessages("mochi").map((message) => message.id), ["one", "two", "three", "four"]);
  assert.equal(asked().filter((call) => call === "GET /agents/mochi/messages").length, 2);

  // A chat that has moved on by more than a page lets go of what the app had before, and of nothing that came since.
  store.stopSync();
  answers["GET /agents/cog/messages"] = () => new Promise<Message[]>((resolve) => (fetched = resolve));
  answers["POST /agents/cog/messages"] = () => row("ten", { agent_id: "cog", sender: "person", status: "queued" });
  const moved = store.loadMessages("cog");
  await store.send("cog", "ten");
  fetched([row("eight", { agent_id: "cog" }), row("nine", { agent_id: "cog" })]);
  await moved;
  assert.deepEqual(store.useMessages("cog").map((message) => message.id), ["eight", "nine", "ten"]);
});

test("catching up with the computer lets go of what the app kept of agents that are gone", async (t) => {
  const { store, answers, streams, savedNow } = app(t, {
    agents: [agent("mochi"), agent("cog")],
    messages: { mochi: [row("hello")], cog: [row("hi", { agent_id: "cog" })] },
    about: { cog: { instructions: "", memories: [], jobs: [] } },
    pending: { cog: { muted: true } },
  });
  answers["GET /agents"] = () => [agent("mochi")];
  answers["GET /agents/mochi/messages"] = () => [row("hello")];
  streams.push(() => stream().response);
  store.startSync();
  await settle();
  const { agents, messages, about, pending } = savedNow();
  assert.deepEqual([agents.length, Object.keys(messages), about, pending], [1, ["mochi"], {}, {}]);
  store.stopSync();
});

test("the newest page of a chat joins onto the messages the app has when they run up to it, and stands alone when the chat has moved on by more", async (t) => {
  const { store, answers } = app(t, { messages: { mochi: [row("one"), row("two"), row("three", { status: "running" })] } });
  answers["GET /agents/mochi/messages"] = () => [row("three"), row("four")];
  await store.loadMessages("mochi");
  assert.deepEqual(store.useMessages("mochi"), [row("one"), row("two"), row("three"), row("four")]);

  answers["GET /agents/mochi/messages"] = () => [];
  await store.loadMessages("mochi");
  assert.equal(store.useMessages("mochi").length, 4);

  answers["GET /agents/mochi/messages"] = () => [row("eight"), row("nine")];
  await store.loadMessages("mochi");
  assert.deepEqual(store.useMessages("mochi"), [row("eight"), row("nine")]);
});

test("an ask never goes back to waiting", async (t) => {
  const { store, answers } = app(t, { messages: { mochi: [row("May I send it?", { ask: "allowed" }), row("May I pay?", { ask: "waiting" })] } });
  answers["GET /agents/mochi/messages"] = () => [row("May I send it?", { ask: "waiting" }), row("May I pay?", { ask: "unanswered" })];
  await store.loadMessages("mochi");
  assert.deepEqual(store.useMessages("mochi").map((message) => message.ask), ["allowed", "unanswered"]);
});

test("an older page goes before the messages the app has, until the chat's beginning", async (t) => {
  const { store, answers, asked } = app(t, { messages: { mochi: [row("three"), row("four")] } });
  answers["GET /agents/mochi/messages?before=three"] = () => [row("one"), row("two")];
  answers["GET /agents/mochi/messages?before=one"] = () => [];
  assert.equal(await store.loadOlder("mochi"), true);
  assert.deepEqual(store.useMessages("mochi").map((message) => message.id), ["one", "two", "three", "four"]);
  assert.equal(await store.loadOlder("mochi"), false);
  assert.equal(store.useMessages("mochi").length, 4);

  // A chat the app has nothing of has nothing to page back from.
  assert.equal(await store.loadOlder("cog"), false);
  assert.equal(asked().length, 2);
});

test("an older page asked for twice at once is fetched once, and both askers get it", async (t) => {
  const { store, answers, asked, heard } = app(t, { messages: { mochi: [row("three"), row("four")] } });
  const older: ((page: Message[]) => void)[] = [];
  answers["GET /agents/mochi/messages?before=three"] = () => new Promise<Message[]>((resolve) => older.push(resolve));
  answers["GET /agents/mochi/messages?before=one"] = () => [];
  // A screen looking for a message from further back asks for the next page as soon as it sees one come.
  let next: Promise<boolean> | undefined;
  store.useMessages("mochi");
  heard.changed(() => (next ??= store.loadOlder("mochi")));
  const both = [store.loadOlder("mochi"), store.loadOlder("mochi")];
  older.forEach((answer) => answer([row("one"), row("two")]));
  assert.deepEqual(await Promise.all(both), [true, true]);
  assert.deepEqual(store.useMessages("mochi").map((message) => message.id), ["one", "two", "three", "four"]);
  assert.equal(await next, false);
  assert.deepEqual(asked(), ["GET /agents/mochi/messages?before=three", "GET /agents/mochi/messages?before=one"]);
});

test("an older page is dropped when the chat was replaced while it was fetched", async (t) => {
  const { store, answers, asked } = app(t, { messages: { mochi: [row("three"), row("four")] } });
  let older!: (page: Message[]) => void;
  answers["GET /agents/mochi/messages?before=three"] = () => new Promise<Message[]>((resolve) => (older = resolve));
  answers["GET /agents/mochi/messages"] = () => [row("eight"), row("nine")];
  const loading = store.loadOlder("mochi");
  await store.loadMessages("mochi");
  // Whoever pages back from the chat as it now is fetches the page before its new oldest message, not the one on its way.
  answers["GET /agents/mochi/messages?before=eight"] = () => [row("seven")];
  const next = store.loadOlder("mochi");
  assert.equal(asked().at(-1), "GET /agents/mochi/messages?before=eight");
  older([row("one"), row("two")]);
  assert.deepEqual(await Promise.all([loading, next]), [true, true]);
  assert.deepEqual(store.useMessages("mochi").map((message) => message.id), ["seven", "eight", "nine"]);
});

test("an older page that reaches a chat while its newest page is fetched stays before the newest page, or goes with what the app had", async (t) => {
  const { store, answers } = app(t, { messages: { mochi: [row("three"), row("four")] } });
  const ids = () => store.useMessages("mochi").map((message) => message.id);
  let fetched!: (page: Message[]) => void;
  answers["GET /agents/mochi/messages"] = () => new Promise<Message[]>((resolve) => (fetched = resolve));
  answers["GET /agents/mochi/messages?before=three"] = () => [row("one"), row("two")];
  answers["POST /agents/mochi/messages"] = (call) => row((call.body as FormData).get("body") as string, { sender: "person", status: "queued" });

  // The chat has moved on by more than a page. While its newest page is fetched, the page before what the app has arrives, and the person sends a message.
  const moved = store.loadMessages("mochi");
  assert.equal(await store.loadOlder("mochi"), true);
  await store.send("mochi", "ten");
  assert.deepEqual(ids(), ["one", "two", "three", "four", "ten"]);
  fetched([row("eight"), row("nine")]);
  await moved;
  assert.deepEqual(ids(), ["eight", "nine", "ten"]);

  // A newest page that runs up to what the app has keeps the older page before it.
  answers["GET /agents/mochi/messages?before=eight"] = () => [row("six"), row("seven")];
  const joined = store.loadMessages("mochi");
  assert.equal(await store.loadOlder("mochi"), true);
  await store.send("mochi", "twelve");
  fetched([row("nine"), row("ten"), row("eleven")]);
  await joined;
  assert.deepEqual(ids(), ["six", "seven", "eight", "nine", "ten", "eleven", "twelve"]);
});

test("a change to an agent shows at once over what the server says, and changes go one at a time in the order they were made", async (t) => {
  const { store, calls, answers, streams, savedNow } = app(t, { agents: [agent("mochi", { name: "Mochi" }), agent("cog")] });
  const taken: (() => void)[] = [];
  // The computer takes a change when the test lets it, and answers with the agent as it then stands.
  let server = agent("mochi", { name: "Mochi" });
  answers["PATCH /agents/mochi"] = ({ body }) => new Promise((resolve) => taken.push(() => resolve((server = { ...server, ...(body as object) }))));
  answers["GET /agents"] = () => [server, agent("cog")];
  const events = stream();
  streams.push(() => events.response);
  store.startSync();
  await settle();

  const first = store.changeAgent("mochi", { name: "Mo" });
  assert.equal(store.useAgent("mochi")?.name, "Mo");
  const second = store.changeAgent("mochi", { muted: true });
  const third = store.changeAgent("mochi", { name: "Momo" });
  assert.deepEqual(calls.filter((call) => call.method === "PATCH").map((call) => call.body), [{ name: "Mo" }]);
  assert.deepEqual(savedNow().pending, { mochi: { name: "Momo", muted: true } });

  // The server's own word on the agent, while a change waits, doesn't undo the change.
  events.say({ message: null, agent: agent("mochi", { name: "Mochi", working: true }) });
  await settle();
  assert.deepEqual([store.useAgent("mochi")?.name, store.useAgent("mochi")?.muted, store.useAgent("mochi")?.working], ["Momo", true, true]);

  taken.shift()!();
  await settle();
  assert.equal(store.useAgent("mochi")?.name, "Momo");
  assert.deepEqual(calls.filter((call) => call.method === "PATCH").map((call) => call.body), [{ name: "Mo" }, { name: "Momo", muted: true }]);

  taken.shift()!();
  await Promise.all([first, second, third]);
  assert.deepEqual([store.useAgent("mochi")?.name, store.useAgent("mochi")?.muted], ["Momo", true]);
  assert.deepEqual(savedNow().pending, {});
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 2);

  // An agent the app doesn't have takes no change.
  await store.changeAgent("gone", { muted: true });
  assert.deepEqual(savedNow().pending, {});
  store.stopSync();
});

test("a change the server refuses fails, and the agent goes back to what the server has", async (t) => {
  const { store, answers, savedNow } = app(t, { agents: [agent("mochi", { name: "Mochi" })] });
  answers["PATCH /agents/mochi"] = () => {
    throw new ApiError("A name can't be empty.", 400);
  };
  answers["GET /agents"] = () => [agent("mochi", { name: "Mochi", unread: 3 })];
  const changing = store.changeAgent("mochi", { name: "" });
  assert.equal(store.useAgent("mochi")?.name, "");
  await assert.rejects(changing, { message: "A name can't be empty.", status: 400 });
  assert.deepEqual(store.useAgents(), [agent("mochi", { name: "Mochi", unread: 3 })]);
  assert.deepEqual(savedNow().pending, {});
});

test("a change made while the server is out of reach waits on the device, and goes when the stream is back", async (t) => {
  const { store, calls, answers, streams, savedNow } = app(t, { agents: [agent("mochi")] });
  answers["PATCH /agents/mochi"] = () => {
    throw new ApiError("Can't reach Sidebots.", 0);
  };
  await store.changeAgent("mochi", { hidden: true, avatarId: "ember" });
  assert.deepEqual([store.useAgent("mochi")?.hidden, store.useAgent("mochi")?.avatar_id], [true, "ember"]);
  assert.deepEqual(savedNow().pending, { mochi: { hidden: true, avatarId: "ember" } });

  answers["PATCH /agents/mochi"] = () => agent("mochi", { hidden: true, avatar_id: "ember" });
  answers["GET /agents"] = () => [agent("mochi")];
  streams.push(() => stream().response);
  store.startSync();
  await settle();
  assert.deepEqual(calls.filter((call) => call.method === "PATCH").map((call) => call.body), [
    { hidden: true, avatarId: "ember" },
    { hidden: true, avatarId: "ember" },
  ]);
  assert.deepEqual(store.useAgents(), [agent("mochi", { hidden: true, avatar_id: "ember" })]);
  assert.deepEqual(savedNow().pending, {});
  store.stopSync();
});

test("reading a chat clears its count at once and tells the server, and a chat with nothing unread tells it nothing", async (t) => {
  const { store, answers, asked } = app(t, { agents: [agent("mochi", { unread: 2 }), agent("cog")] });
  let read!: (agent: AgentWithLatest) => void;
  answers["POST /agents/mochi/read"] = () => new Promise<AgentWithLatest>((resolve) => (read = resolve));
  store.markRead("mochi");
  store.markRead("cog");
  assert.equal(store.useAgent("mochi")?.unread, 0);
  assert.deepEqual(asked(), ["POST /agents/mochi/read"]);
  read(agent("mochi", { read_at: 5 }));
  await settle();
  assert.deepEqual(store.useAgent("mochi"), agent("mochi", { read_at: 5 }));
});

test("a message goes as a form with its files, and its answer joins the chat unless the stream brought it first", async (t) => {
  const { store, calls, answers } = app(t, { messages: { mochi: [row("hello")] } });
  answers["POST /agents/mochi/messages"] = () => row("and the lights?", { sender: "person", status: "queued" });
  await store.send("mochi", "and the lights?", ["a.png", "b.pdf"], "hello");
  const form = calls[0].body as FormData;
  assert.deepEqual([form.get("body"), form.get("replyTo"), form.getAll("files")], ["and the lights?", "hello", ["a.png", "b.pdf"]]);
  assert.deepEqual(store.useMessages("mochi").map((message) => message.status), ["done", "queued"]);

  // The answer is the message as it was made, so the copy the app has, which may be newer, stays.
  answers["POST /agents/mochi/messages"] = () => row("hello", { status: "queued" });
  await store.send("mochi", "hello");
  assert.equal((calls[1].body as FormData).has("replyTo"), false);
  assert.deepEqual(store.useMessages("mochi").map((message) => message.status), ["done", "queued"]);
});

test("an answered ask closes in both chats it shows in", async (t) => {
  const ask = row("May I look it up?", { agent_id: "cog", peer_id: "mochi", ask: "waiting" });
  const { store, calls, answers } = app(t, { messages: { mochi: [ask], cog: [ask] } });
  answers["POST /agents/cog/asks/May I look it up?"] = () => ({ ...ask, ask: "allowed" });
  await store.answerAsk(ask, true);
  assert.deepEqual(calls[0].body, { allow: true });
  assert.deepEqual([store.useMessages("mochi")[0].ask, store.useMessages("cog")[0].ask], ["allowed", "allowed"]);
});

test("a sign-in that ends on an address makes the connection, and one the person closes makes none", async (t) => {
  const { store, calls, answers, heard, asked } = app(t, { connections: [gmail] });
  answers["POST /connections/gmail/sign-in"] = () => ({ url: "https://accounts.example/sign-in", redirect: "sidebots://connected" });
  answers["PUT /connections/gmail"] = () => ({ ...gmail, account: "me@example.com" });
  await store.connect("gmail");
  assert.deepEqual(asked(), ["POST /connections/gmail/sign-in"]);
  assert.deepEqual(store.useConnections(), [gmail]);

  heard.signIn = "sidebots://connected?code=1";
  await store.connect("gmail");
  assert.deepEqual(calls.at(-1), { method: "PUT", path: "/connections/gmail", body: { url: "sidebots://connected?code=1" } });
  assert.deepEqual(store.useConnections(), [{ ...gmail, account: "me@example.com" }]);
});

test("a stream that can't be opened is tried again after a wait that doubles up to fifteen seconds, and starts over once one opens", async (t) => {
  const { store, answers, streams, opened, tick } = app(t, { agents: [agent("mochi")] });
  answers["GET /agents"] = () => [agent("mochi")];
  // The server answers once that it is broken, and after that nothing answers.
  streams.push(() => new Response("broken", { status: 500, headers: { [CONTRACT_HEADER]: String(CONTRACT_VERSION) } }));
  store.startSync();
  await settle();
  assert.equal(store.useOnline(), false);
  for (const [tries, wait] of [1000, 2000, 4000, 8000, 15_000, 15_000].entries()) {
    tick(wait - 1);
    await settle();
    assert.equal(opened.length, tries + 1);
    tick(1);
    await settle();
    assert.equal(opened.length, tries + 2);
  }
  assert.equal(store.useOnline(), false);

  const events = stream();
  streams.push(() => events.response);
  tick(15_000);
  await settle();
  assert.equal(store.useOnline(), true);

  // The computer ends the stream, and the wait is a second again.
  events.end();
  await settle();
  assert.equal(store.useOnline(), false);
  tick(1000);
  await settle();
  assert.equal(opened.length, 9);
  store.stopSync();
});

test("a computer on another version of the contract is told apart from one out of reach, read nothing of, and asked again", async (t) => {
  const { store, answers, streams, asked, tick } = app(t, { agents: [agent("mochi")] });
  answers["GET /agents"] = () => [];
  const old = stream(CONTRACT_VERSION - 1);
  const ahead = stream(CONTRACT_VERSION + 1);
  streams.push(() => old.response, () => ahead.response, () => stream().response);
  store.startSync();
  await settle();
  assert.deepEqual([store.useBehind(), store.useOnline()], ["computer", false]);
  // The stream of a computer nothing is read from is closed, not left open.
  assert.equal(old.cancelled(), true);

  tick(1000);
  await settle();
  assert.equal(store.useBehind(), "app");
  assert.deepEqual([asked(), store.useAgents()], [[], [agent("mochi")]]);

  tick(2000);
  await settle();
  assert.deepEqual([store.useBehind(), store.useOnline(), store.useAgents()], [null, true, []]);
  store.stopSync();
});

test("a computer that doesn't know the device ends the sync and tells the app, which can start it again", async (t) => {
  const { store, streams, opened, heard, asked, tick } = app(t, { agents: [agent("mochi")] });
  streams.push(() => new Response(JSON.stringify({ error: "This device isn't paired with this computer." }), { status: 401, headers: { [CONTRACT_HEADER]: String(CONTRACT_VERSION) } }));
  store.startSync();
  await settle();
  assert.equal(heard.refused, 1);
  tick(60_000);
  await settle();
  assert.deepEqual([opened.length, asked(), store.useAgents()], [1, [], [agent("mochi")]]);

  store.startSync();
  await settle();
  assert.equal(opened.length, 2);
  store.stopSync();
});

test("the app coming back to the front leaves a stream the computer spoke on lately, and opens another in place of one gone quiet or one the system may have dropped", async (t) => {
  const { store, answers, streams, opened, heard, asked, tick } = app(t, { messages: { mochi: [row("hello")] } });
  answers["GET /agents"] = () => [agent("mochi")];
  answers["GET /agents/mochi/messages"] = () => [row("hello")];
  const events = stream();
  streams.push(() => events.response, () => stream().response, () => stream().response);
  store.startSync();
  store.startSync();
  await settle();
  assert.equal(opened.length, 1);
  const caughtUp = ["GET /agents", "GET /avatars", "GET /connections", "GET /agents/mochi/messages"];
  assert.deepEqual(asked(), caughtUp);

  // The computer pings the stream every keepalive, so a stream it spoke on since then is open, and nothing is asked again.
  tick(KEEPALIVE_MS);
  events.write("event: ping\ndata: \n\n");
  await settle();
  tick(KEEPALIVE_MS);
  heard.front();
  await settle();
  assert.deepEqual([opened.length, asked()], [1, caughtUp]);

  // A stream quiet for longer has dropped without a word.
  tick(KEEPALIVE_MS);
  heard.front();
  await settle();
  assert.deepEqual(opened.map((signal) => signal.aborted), [true, false]);
  assert.deepEqual(asked(), [...caughtUp, ...caughtUp]);
  assert.equal(store.useOnline(), true);

  // One the system may have dropped, as iOS does in the background, is opened again however lately it was heard.
  heard.front(true);
  await settle();
  assert.deepEqual(opened.map((signal) => signal.aborted), [true, true, false]);

  store.stopSync();
  heard.front();
  tick(60_000);
  await settle();
  assert.deepEqual(opened.map((signal) => signal.aborted), [true, true, true]);
});

test("a page that comes after a later one caught the chat up is dropped", async (t) => {
  const { store, answers, streams } = app(t, { messages: { mochi: [row("hello", { sender: "person", status: "queued" })] } });
  answers["GET /agents"] = () => [agent("mochi")];
  // The app opens on the chat before the stream is up, and that page is slow.
  let early!: (page: Message[]) => void;
  answers["GET /agents/mochi/messages"] = () => new Promise<Message[]>((resolve) => (early = resolve));
  const opening = store.loadMessages("mochi");
  answers["GET /agents/mochi/messages"] = () => [row("hello", { sender: "person", status: "running" })];
  const events = stream();
  streams.push(() => events.response);
  store.startSync();
  await settle();
  events.say({ message: row("hello", { sender: "person" }), agent: agent("mochi") });
  await settle();

  early([row("hello", { sender: "person", status: "queued" })]);
  await opening;
  assert.deepEqual(store.useMessages("mochi"), [row("hello", { sender: "person" })]);
  store.stopSync();
});

test("a chat fetched while the stream is open isn't fetched again until the stream opens again", async (t) => {
  const { store, answers, streams, asked, tick } = app(t, { messages: { mochi: [row("hello")] } });
  answers["GET /agents"] = () => [agent("mochi"), agent("cog")];
  answers["GET /agents/mochi/messages"] = () => [row("hello")];
  answers["GET /agents/cog/messages"] = () => [row("hi", { agent_id: "cog" })];
  const pages = () => asked().filter((call) => call.endsWith("/messages"));

  // With no stream open nothing keeps a chat as the computer has it, so each opening fetches it.
  await store.loadMessages("mochi");
  await store.loadMessages("mochi");
  assert.equal(pages().length, 2);

  const events = stream();
  const next = stream();
  streams.push(() => events.response, () => next.response);
  store.startSync();
  await settle();
  assert.equal(pages().length, 3);

  // The person goes from chat to chat and back.
  await store.loadMessages("cog");
  await store.loadMessages("mochi");
  await store.loadMessages("cog");
  assert.deepEqual(pages().slice(3), ["GET /agents/cog/messages"]);
  events.say({ message: row("more"), agent: agent("mochi", { unread: 1 }) });
  await settle();
  assert.deepEqual(store.useMessages("mochi"), [row("hello"), row("more")]);

  // The stream ends and another opens, which catches each chat up once.
  answers["GET /agents/mochi/messages"] = () => [row("hello"), row("more")];
  events.end();
  await settle();
  tick(1000);
  await settle();
  await store.loadMessages("mochi");
  assert.deepEqual(pages().slice(4).sort(), ["GET /agents/cog/messages", "GET /agents/mochi/messages"]);

  // An agent that goes takes what it said out of the other chats on the computer, so those are fetched when next opened.
  next.say({ deleted: "cog" });
  await settle();
  await store.loadMessages("mochi");
  await store.loadMessages("mochi");
  assert.equal(pages().length, 7);

  store.stopSync();
  await store.loadMessages("mochi");
  assert.equal(pages().length, 8);
});

test("a chat holds what was fetched and said of it only while it is on screen, and its newest page is what is saved", async (t) => {
  const { store, answers, streams, heard, savedNow } = app(t);
  const said = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => row(`m${from + index}`, { created_at: from + index }));
  const ids = (messages: Message[]) => messages.map((message) => message.id);
  answers["GET /agents"] = () => [agent("mochi")];
  answers["GET /agents/mochi/messages"] = () => said(250, 300);
  for (const oldest of [250, 200, 150, 100, 50]) answers[`GET /agents/mochi/messages?before=m${oldest}`] = () => said(oldest - PAGE, oldest);
  const events = stream();
  streams.push(() => events.response);
  store.startSync();
  await settle();

  // A chat is opened and paged back to its beginning, and a long turn's messages come over the stream.
  store.useMessages("mochi");
  const close = heard.changed(() => {});
  await store.loadMessages("mochi");
  for (let page = 0; page < 5; page++) assert.equal(await store.loadOlder("mochi"), true);
  for (const message of said(300, 400)) events.say({ message, agent: agent("mochi") });
  await settle();
  assert.deepEqual(ids(store.useMessages("mochi")), ids(said(0, 400)));
  assert.deepEqual(ids(savedNow().messages.mochi), ids(said(350, 400)));

  // Closed, it goes back to its newest page, and what comes then takes the place of the oldest.
  close();
  assert.deepEqual(ids(store.useMessages("mochi")), ids(said(350, 400)));
  events.say({ message: row("m400", { created_at: 400 }), agent: agent("mochi") });
  // A message from before that page that changes, as one sent again, is no new message at the chat's end.
  events.say({ message: row("m10", { created_at: 10, status: "queued" }), agent: agent("mochi") });
  await settle();
  assert.deepEqual(ids(store.useMessages("mochi")), ids(said(351, 401)));
  assert.deepEqual(ids(savedNow().messages.mochi), ids(said(351, 401)));
  store.stopSync();
});

test("a store that starts from a copy with more than a page of a chat holds its newest page", async (t) => {
  const { store } = app(t, { messages: { mochi: Array.from({ length: PAGE + 10 }, (_, index) => row(`m${index}`)) } });
  assert.deepEqual([store.useMessages("mochi").length, store.useMessages("mochi")[0].id], [PAGE, "m10"]);
});

test("clearing the store lets go of everything it kept", async (t) => {
  const { store, savedNow } = app(t, { agents: [agent("mochi")], messages: { mochi: [row("hello")] }, pending: { mochi: { muted: true } } });
  store.clear();
  assert.deepEqual([store.useAgents(), store.useMessages("mochi"), store.useOnline()], [[], [], true]);
  assert.deepEqual(savedNow(), { agents: [], messages: {}, avatars: [], about: {}, usage: null, connections: null, pending: {} });
});
