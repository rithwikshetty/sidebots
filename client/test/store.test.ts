import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_HEADER, CONTRACT_VERSION, KEEPALIVE_MS, PAGE, RUN, type AgentWithLatest, type Connected, type Message, type StreamEvent, type Usage } from "../../server/src/contract.ts";
import { openStore } from "../../server/src/store.ts";
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
  chat_changes: 0,
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
  order: 0,
  created_at: 0,
  ...more,
});

/** Messages of Mochi's chat in the order they came, named `m` and their place in it. A page of the chat is fifty of them. */
const said = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => row(`m${from + index}`, { order: from + index, created_at: from + index }));

const gmail: Connected = { connection: "gmail", name: "Gmail", allows: "Read and send your mail", logo: { path: "", color: null }, account: null };

type Call = { method: string; path: string; body: unknown };

// What closes each stream a test made, as the signal a stream is opened with closes it.
const closes = new WeakMap<Response, () => void>();

/** An event stream the test speaks through, as a computer on `version` of the contract answers with it. */
function stream(version = CONTRACT_VERSION) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({ start: (given) => void (controller = given) });
  const write = (text: string) => controller.enqueue(new TextEncoder().encode(text));
  const response = new Response(body, { status: 200, headers: { [CONTRACT_HEADER]: String(version) } });
  closes.set(response, () => {
    if (!closed) controller.error(new Error("The app stopped listening."));
    closed = true;
  });
  return {
    response,
    write,
    say: (event: StreamEvent) => write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => {
      closed = true;
      controller.close();
    },
    /** Whether the app closed the stream, or the computer ended it. */
    closed: () => closed,
  };
}

/** Lets what the store has started run as far as it can without a timer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A store with a made-up computer behind it. `answers` are the computer's, by
 * method and path, or by method and path with `?` for a path with any query,
 * and a call it has none for is refused as not found.
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
  const kept: Record<string, string> = { "cache-7": JSON.stringify(saved) };
  const heard = { front: (_dropped = false) => {}, refused: 0, signIn: null as string | null, changed: (_listener: () => void) => () => {} };
  const store = createStore<string>({
    async request<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      const call = { method: init.method ?? "GET", path, body: init.body };
      calls.push(call);
      const answer = answers[`${call.method} ${path}`] ?? answers[`${call.method} ${path.replace(/\?.*/, "")}?`];
      if (!answer) throw new ApiError("Not found.", 404);
      return answer(call) as T;
    },
    async events(signal) {
      opened.push(signal);
      const next = streams.shift();
      if (!next) throw new Error("no answer");
      const response = await next();
      signal.addEventListener("abort", () => closes.get(response)?.());
      return response;
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
    return JSON.parse(kept["cache-7"]);
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
    caughtUp: {},
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

  events.say({ message: row("hi", { agent_id: "cog" }), agent: agent("cog", { unread: 1, chat_changes: 1 }) });
  // An event the connection brings in two pieces is read once it is whole.
  const working = `data: ${JSON.stringify({ message: row("on it", { status: "running" }), agent: agent("mochi", { working: true, chat_changes: 1 }) })}\n\n`;
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
  events.say({ message: row("on it"), agent: agent("mochi", { chat_changes: 2 }) });
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

test("a provider's plan from the stream takes its place in the usage the app has, and an event the app doesn't know is passed over", async (t) => {
  const { store, answers, streams, tick } = app(t);
  answers["GET /agents"] = () => [agent("mochi")];
  const events = stream();
  streams.push(() => events.response);
  const told: number[] = [];
  store.onAgents((agents) => told.push(agents.length));
  store.startSync();
  await settle();
  const weekly = { name: "Weekly limit", used: 0.4, resets_at: 100, at: 1 };

  // An app that hasn't fetched usage has none to change.
  events.say({ plan: { provider: "claude", apiKey: false, limits: [weekly] } });
  await settle();
  assert.equal(store.useUsage(), null);

  // A plan the stream brings while usage is on its way is newer than what the computer answers with.
  const codex = { provider: "codex" as const, apiKey: false, limits: [] };
  let answer!: (usage: Usage) => void;
  answers["GET /usage"] = () => new Promise((resolve) => (answer = resolve));
  const loading = store.loadUsage();
  await settle();
  events.say({ plan: { provider: "claude", apiKey: false, limits: [weekly] } });
  await settle();
  answer({ used: [], days: [], accounts: [{ provider: "claude", apiKey: false, limits: [] }, codex] });
  await loading;
  assert.deepEqual(store.useUsage()?.accounts, [{ provider: "claude", apiKey: false, limits: [weekly] }, codex]);

  events.say({ plan: { provider: "codex", apiKey: true, limits: [] } });
  await settle();
  assert.deepEqual(store.useUsage()?.accounts, [{ provider: "claude", apiKey: false, limits: [weekly] }, { provider: "codex", apiKey: true, limits: [] }]);

  // A plan that waits for a fetch may name a limit that resets meanwhile, which is left out, as the computer leaves it out.
  const reset = { name: "5-hour limit", used: 1, resets_at: 4, at: 1 };
  const refetched = store.loadUsage();
  await settle();
  events.say({ plan: { provider: "claude", apiKey: false, limits: [reset, weekly] } });
  await settle();
  tick(5);
  answer({ used: [], days: [], accounts: [{ provider: "claude", apiKey: false, limits: [weekly] }, codex] });
  await refetched;
  assert.deepEqual(store.useUsage()?.accounts[0], { provider: "claude", apiKey: false, limits: [weekly] });
  // So is one in a plan that comes late.
  events.say({ plan: { provider: "claude", apiKey: false, limits: [reset, weekly] } });
  await settle();
  assert.deepEqual(store.useUsage()?.accounts[0], { provider: "claude", apiKey: false, limits: [weekly] });

  // What a newer computer might send, which this app reads nothing of, and the stream goes on.
  events.write(`event: news\ndata: ${JSON.stringify({ news: "something new" })}\n\n`);
  events.say({ message: null, agent: agent("mochi", { name: "Mochi" }) });
  await settle();
  assert.equal(store.useAgent("mochi")?.name, "Mochi");
  assert.equal(events.closed(), false);
  assert.deepEqual(told, [1, 1]);
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
  events.say({ message: row("hello"), agent: agent("mochi", { unread: 1, chat_changes: 1 }) });
  await settle();
  assert.deepEqual(store.useMessages("mochi"), [row("hello")]);

  // A chat whose page can't be fetched is held all the same.
  await assert.rejects(store.loadMessages("cog"), { status: 404 });
  events.say({ message: row("hi", { agent_id: "cog" }), agent: agent("cog", { unread: 1, chat_changes: 1 }) });
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
  events.say({ message: row("three"), agent: agent("mochi", { unread: 1, chat_changes: 1 }) });
  await settle();
  assert.deepEqual(store.useMessages("mochi"), [row("three")]);
  fetched([row("one"), row("two")]);
  await opening;
  assert.deepEqual(store.useMessages("mochi").map((message) => message.id), ["one", "two", "three"]);

  // The page may be older than what the stream brought ahead of it, so the chat is fetched again when it is next opened. A page that holds the message takes its place, and a message the person sends meanwhile is kept as the stream's is.
  answers["POST /agents/mochi/messages"] = () => row("four", { sender: "person", status: "queued" });
  const again = store.loadMessages("mochi");
  await store.send("mochi", "four");
  fetched([row("one"), row("two"), row("three")]);
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

test("a full newest page joins onto the messages the app has when they run up to it and stands alone when the chat has moved on by more, and a page short of a full one is the whole chat", async (t) => {
  const { store, answers, heard } = app(t, { messages: { mochi: [...said(0, 49), row("m49", { order: 49, created_at: 49, status: "running" })] } });
  const ids = () => store.useMessages("mochi").map((message) => message.id);
  // The chat is on screen, where it keeps what it had from before a page.
  store.useMessages("mochi");
  heard.changed(() => {});
  answers["GET /agents/mochi/messages"] = () => said(10, 60);
  await store.loadMessages("mochi");
  assert.deepEqual(ids(), said(0, 60).map((message) => message.id));
  assert.equal(store.useMessages("mochi")[49].status, "done");

  answers["GET /agents/mochi/messages"] = () => said(200, 250);
  await store.loadMessages("mochi");
  assert.deepEqual(ids(), said(200, 250).map((message) => message.id));

  // What the chat has that a short page hasn't is gone from the computer, as what a deleted agent said in it, wherever in the chat it was.
  answers["GET /agents/mochi/messages"] = () => [row("m210"), row("m249")];
  await store.loadMessages("mochi");
  assert.deepEqual(ids(), ["m210", "m249"]);
  answers["GET /agents/mochi/messages"] = () => [];
  await store.loadMessages("mochi");
  assert.deepEqual(ids(), []);
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
  const { store, answers, heard } = app(t, { messages: { mochi: said(100, 150) } });
  const ids = () => store.useMessages("mochi").map((message) => message.id);
  const idsOf = (from: number, to: number) => said(from, to).map((message) => message.id);
  store.useMessages("mochi");
  heard.changed(() => {});
  let fetched!: (page: Message[]) => void;
  answers["GET /agents/mochi/messages"] = () => new Promise<Message[]>((resolve) => (fetched = resolve));
  answers["GET /agents/mochi/messages?before=m100"] = () => said(50, 100);
  answers["POST /agents/mochi/messages"] = (call) => row((call.body as FormData).get("body") as string, { sender: "person", status: "queued" });

  // The chat has moved on by more than a page. While its newest page is fetched, the page before what the app has arrives, and the person sends a message.
  const moved = store.loadMessages("mochi");
  assert.equal(await store.loadOlder("mochi"), true);
  await store.send("mochi", "ten");
  assert.deepEqual(ids(), [...idsOf(50, 150), "ten"]);
  fetched(said(300, 350));
  await moved;
  assert.deepEqual(ids(), [...idsOf(300, 350), "ten"]);

  // A newest page that runs up to what the app has keeps the older page before it.
  answers["GET /agents/mochi/messages?before=m300"] = () => said(250, 300);
  const joined = store.loadMessages("mochi");
  assert.equal(await store.loadOlder("mochi"), true);
  await store.send("mochi", "twelve");
  fetched([...said(302, 350), row("ten", { sender: "person" }), row("eleven")]);
  await joined;
  assert.deepEqual(ids(), [...idsOf(250, 350), "ten", "eleven", "twelve"]);
});

test("a message any distance back in a chat thousands long is a request or two away, and the chat holds it as a stretch with a hole after it that it pages across", async (t) => {
  const { store, answers, streams, heard, asked } = app(t);
  // The computer's own store answers, with a chat of 5,000 messages, each a moment after the one before.
  const computer = openStore(mkdtempSync(join(tmpdir(), "sidebots-client-")));
  const person = computer.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" });
  const mochi = computer.createAgent(person, "Mochi", "mochi", "claude");
  const chat = Array.from({ length: 5_000 }, (_, index) => {
    t.mock.timers.tick(1);
    return computer.addMessage(mochi.id, index % 2 ? "agent" : "person", `message ${index}`, "done");
  });
  const id = mochi.id;
  answers["GET /agents"] = () => [agent(id, { chat_changes: computer.agent(id)!.chat_changes })];
  answers[`GET /agents/${id}/messages?`] = ({ path }) => {
    const query = new URL(path, "http://computer").searchParams;
    return computer.messages(id, { before: query.get("before") ?? undefined, through: query.get("through") ?? undefined });
  };
  const events = stream();
  streams.push(() => events.response);
  store.startSync();
  await settle();
  const place = new Map(chat.map((message, index) => [message.id, index]));
  const held = () => store.useMessages(id).map((message) => place.get(message.id));
  const run = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);
  const fetches = () => asked().filter((call) => call.startsWith(`GET /agents/${id}/messages`));

  // Opened at the newest messages, then at one 4,900 back, the chat asks for the run from it, and the page before it for the rows above it.
  store.useMessages(id);
  const close = heard.changed(() => {});
  await store.loadMessages(id);
  assert.equal(await store.loadOlder(id, chat[100].id), true);
  assert.equal(await store.loadOlder(id), true);
  assert.equal(fetches().length, 3);
  assert.deepEqual(held(), [...run(50, 100 + RUN), ...run(5_000 - PAGE, 5_000)]);
  assert.equal(store.useHole(id), chat[99 + RUN].id);

  // A message in the hole that changes is no new message at the chat's end. It has no place in the chat, which leaves the chat behind its count, and a change among the newest messages still lands.
  const changed = (index: number) => {
    computer.setStatus(chat[index].id, "failed");
    return { message: computer.message(id, chat[index].id)!, agent: agent(id, { chat_changes: computer.agent(id)!.chat_changes }) };
  };
  events.say(changed(2_000));
  events.say(changed(4_990));
  await settle();
  assert.equal(store.useMessages(id).length, 300);
  assert.equal(store.useMessages(id).at(-10)?.status, "failed");

  // Caught up as a new stream opens, the chat fetches only its newest page, which joins its newest messages and leaves the stretch and its hole as they were. Caught up, it isn't fetched again.
  const before = fetches().length;
  store.stopSync();
  streams.push(() => stream().response);
  store.startSync();
  await settle();
  assert.deepEqual(fetches().slice(before), [`GET /agents/${id}/messages`]);
  assert.deepEqual(held(), [...run(50, 100 + RUN), ...run(5_000 - PAGE, 5_000)]);
  assert.equal(store.useHole(id), chat[99 + RUN].id);
  await store.loadMessages(id);
  assert.equal(fetches().length, before + 1);

  // Paging down across the hole fetches a run at a time, until the chat is whole.
  let runs = 0;
  for (let hole = store.useHole(id); hole; hole = store.useHole(id), runs++) await store.loadOlder(id, hole);
  assert.equal(runs, Math.ceil((5_000 - PAGE - (100 + RUN)) / (RUN - 1)));
  assert.deepEqual(held(), run(50, 5_000));

  // A message a few pages back from the newest comes with everything after it, in one answer.
  close();
  store.useMessages(id);
  heard.changed(() => {});
  const near = fetches().length;
  assert.equal(await store.loadOlder(id, chat[4_850].id), true);
  assert.equal(fetches().length, near + 1);
  assert.deepEqual(held(), run(4_850, 5_000));
  assert.equal(store.useHole(id), undefined);

  // Back at the newest, the stretch and its hole go, as they do when the chat leaves the screen.
  await store.loadOlder(id, chat[10].id);
  assert.equal(store.useHole(id), chat[9 + RUN].id);
  store.backToNewest(id);
  assert.deepEqual(held(), run(4_850, 5_000));
  assert.equal(store.useHole(id), undefined);
  computer.close();
  store.stopSync();
});

test("a run that comes after the chat asked for another, or went back to its newest messages, is dropped", async (t) => {
  const { store, answers } = app(t, { messages: { mochi: [row("nine"), row("ten")] } });
  const ids = () => store.useMessages("mochi").map((message) => message.id);
  const waiting: Record<string, (page: Message[]) => void> = {};
  for (const from of ["one", "five"]) answers[`GET /agents/mochi/messages?before=nine&through=${from}`] = () => new Promise<Message[]>((resolve) => (waiting[from] = resolve));
  store.useMessages("mochi");

  // Opened at one message, then at another, then at the first again before either has come, the chat asks for the first run again and takes only that one, whichever comes first.
  const first = store.loadOlder("mochi", "one");
  const stale = waiting.one;
  const second = store.loadOlder("mochi", "five");
  const third = store.loadOlder("mochi", "one");
  assert.notEqual(waiting.one, stale);
  waiting.five([row("five"), row("six")]);
  waiting.one([row("one"), row("two")]);
  stale([row("one"), row("two"), row("three")]);
  await Promise.all([first, second, third]);
  assert.deepEqual(ids(), ["one", "two", "nine", "ten"]);
  assert.equal(store.useHole("mochi"), "two");

  // Back at the newest messages, the run fetched for the hole that was there doesn't bring it back.
  answers["GET /agents/mochi/messages?before=nine&through=two"] = () => new Promise<Message[]>((resolve) => (waiting.two = resolve));
  const filling = store.loadOlder("mochi", "two");
  store.backToNewest("mochi");
  waiting.two([row("two"), row("three")]);
  await filling;
  assert.deepEqual(ids(), ["nine", "ten"]);
  assert.equal(store.useHole("mochi"), undefined);
});

test("a run keeps the chat's copy of the message it runs from only when the stream changed it meanwhile, and a hole whose message has gone from the chat lets its stretch go", async (t) => {
  const { store, answers } = app(t, { messages: { mochi: [row("nine"), row("ten")] } });
  const ids = () => store.useMessages("mochi").map((message) => message.id);
  store.useMessages("mochi");
  answers["GET /agents/mochi/messages?before=nine&through=one"] = () => [row("one"), row("two", { ask: "waiting" })];
  await store.loadOlder("mochi", "one");
  assert.equal(store.useHole("mochi"), "two");

  // The person answers the ask that ends the stretch while the run after it is on its way, and the run's copy of it is from before.
  let fill!: (page: Message[]) => void;
  answers["GET /agents/mochi/messages?before=nine&through=two"] = () => new Promise<Message[]>((resolve) => (fill = resolve));
  answers["POST /agents/mochi/asks/two"] = () => row("two", { ask: "allowed" });
  const filling = store.loadOlder("mochi", "two");
  await store.answerAsk(row("two", { ask: "waiting" }), true);
  fill([row("two", { ask: "waiting" }), row("three"), row("nine")]);
  await filling;
  assert.deepEqual(ids(), ["one", "two", "three", "nine", "ten"]);
  assert.equal(store.useMessages("mochi")[1].ask, "allowed");
  assert.equal(store.useHole("mochi"), undefined);

  // An ask answered on another device while this one was away comes answered with the run, and the chat's copy from before gives way to it.
  answers["GET /agents/mochi/messages?before=one&through=zero"] = () => [row("zero", { ask: "waiting" })];
  await store.loadOlder("mochi", "zero");
  assert.equal(store.useHole("mochi"), "zero");
  answers["GET /agents/mochi/messages?before=one&through=zero"] = () => [row("zero", { ask: "allowed" }), row("one")];
  await store.loadOlder("mochi", "zero");
  assert.deepEqual(ids(), ["zero", "one", "two", "three", "nine", "ten"]);
  assert.equal(store.useMessages("mochi")[0].ask, "allowed");
  assert.equal(store.useHole("mochi"), undefined);

  // The message a hole comes after has gone from the chat on the computer, so the run from it is empty.
  answers["GET /agents/mochi/messages?before=zero&through=minus"] = () => [row("minus")];
  await store.loadOlder("mochi", "minus");
  assert.equal(store.useHole("mochi"), "minus");
  answers["GET /agents/mochi/messages?before=zero&through=minus"] = () => [];
  assert.equal(await store.loadOlder("mochi", "minus"), false);
  assert.deepEqual(ids(), ["zero", "one", "two", "three", "nine", "ten"]);
  assert.equal(store.useHole("mochi"), undefined);
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

test("a stream the app can't catch up from is closed before another is opened", async (t) => {
  const { store, answers, streams, opened, tick } = app(t);
  const first = stream();
  const second = stream();
  streams.push(() => first.response, () => second.response);
  // The stream opens, and then the computer can't be reached for what the app asks next, as on a bad connection.
  answers["GET /agents"] = () => {
    throw new ApiError("Can't reach Sidebots.", 0);
  };
  store.startSync();
  await settle();
  assert.deepEqual([opened.length, first.closed(), store.useOnline()], [1, true, false]);

  answers["GET /agents"] = () => [];
  tick(1000);
  await settle();
  assert.deepEqual([opened.length, second.closed(), store.useOnline()], [2, false, true]);
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
  assert.equal(old.closed(), true);

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
  const agents = ["GET /agents", "GET /avatars", "GET /connections"];
  const caughtUp = [...agents, "GET /agents/mochi/messages"];
  assert.deepEqual(asked(), caughtUp);

  // The computer pings the stream every keepalive, so a stream it spoke on since then is open, and nothing is asked again.
  tick(KEEPALIVE_MS);
  events.write("event: ping\ndata: \n\n");
  await settle();
  tick(KEEPALIVE_MS);
  heard.front();
  await settle();
  assert.deepEqual([opened.length, asked()], [1, caughtUp]);

  // A stream quiet for longer has dropped without a word. Nothing changed in the chat meanwhile, so the app asks how the agents stand and fetches no page.
  tick(KEEPALIVE_MS);
  heard.front();
  await settle();
  assert.deepEqual(opened.map((signal) => signal.aborted), [true, false]);
  assert.deepEqual(asked(), [...caughtUp, ...agents]);
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

test("a page asked for before another of the same chat is dropped, whichever of the two comes first", async (t) => {
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
  events.say({ message: row("hello", { sender: "person" }), agent: agent("mochi", { chat_changes: 1 }) });
  await settle();

  early([row("hello", { sender: "person", status: "queued" })]);
  await opening;
  assert.deepEqual(store.useMessages("mochi"), [row("hello", { sender: "person" })]);
  store.stopSync();

  // Cog's chat is fetched twice at once. The first page was made while Cog's chat held what Pip said to it, and the second once Pip was deleted. The first comes first, and what it holds isn't taken for something said since the second was asked for.
  const pages: ((page: Message[]) => void)[] = [];
  answers["GET /agents/cog/messages"] = () => new Promise<Message[]>((resolve) => pages.push(resolve));
  const both = [store.loadMessages("cog"), store.loadMessages("cog")];
  pages[0]([row("Looks fine.", { agent_id: "pip", peer_id: "cog" })]);
  pages[1]([]);
  await Promise.all(both);
  assert.deepEqual(store.useMessages("cog"), []);
});

test("catching up waits for the page asked for last of a chat fetched twice, and fails when that one does and not when an earlier one does", async (t) => {
  const sent = (status: Message["status"]) => row("on it", { sender: "person", status });
  const { store, answers, streams, opened, tick } = app(t, { agents: [agent("mochi", { chat_changes: 2 })], messages: { mochi: [sent("queued")] }, caughtUp: { mochi: 2 } });
  answers["GET /agents"] = () => [agent("mochi", { chat_changes: 3 })];
  let pages: { came: (page: Message[]) => void; failed: (failure: Error) => void }[] = [];
  answers["GET /agents/mochi/messages"] = () => new Promise<Message[]>((came, failed) => pages.push({ came, failed }));
  // The stream is open by the time Mochi's turn fails, so it brings the failure once the app has caught up.
  const events = stream();
  events.say({ message: sent("failed"), agent: agent("mochi", { chat_changes: 4 }) });
  streams.push(() => events.response, () => stream().response, () => stream().response);
  store.startSync();
  await settle();
  // The person opens the chat while the catch-up's page of it is on its way. Both pages were made while the turn ran.
  const opening = store.loadMessages("mochi");
  pages[0].came([sent("running")]);
  await settle();
  pages[1].came([sent("running")]);
  await opening;
  await settle();
  assert.deepEqual(store.useMessages("mochi"), [sent("failed")]);

  // The stream drops, and the same happens as the next one opens, but the page asked for last can't be had. The catch-up has failed with it, so the stream is opened again.
  pages = [];
  answers["GET /agents"] = () => [agent("mochi", { chat_changes: 5 })];
  events.end();
  await settle();
  tick(1000);
  await settle();
  const again = store.loadMessages("mochi");
  pages[0].came([sent("failed")]);
  await settle();
  pages[1].failed(new ApiError("Sidebots couldn't be reached.", 0));
  await assert.rejects(again);
  await settle();
  tick(2000);
  await settle();
  assert.equal(opened.length, 3);

  // On the stream opened then, the page asked for last comes and the one before it can't be had, which fails nothing.
  const third = store.loadMessages("mochi");
  pages[3].came([sent("failed")]);
  pages[2].failed(new ApiError("Sidebots couldn't be reached.", 0));
  await third;
  await settle();
  tick(4000);
  await settle();
  assert.deepEqual([opened.length, store.useOnline()], [3, true]);
  store.stopSync();
});

test("a chat is fetched when its count of changes isn't the one the app caught it up at, and each change the stream brings keeps a caught-up chat so", async (t) => {
  const { store, answers, streams, asked, tick } = app(t, { messages: { mochi: [row("hello")] } });
  const counts = { mochi: 4, cog: 7 };
  answers["GET /agents"] = () => [agent("mochi", { chat_changes: counts.mochi }), agent("cog", { chat_changes: counts.cog })];
  answers["GET /agents/mochi/messages"] = () => [row("hello")];
  answers["GET /agents/cog/messages"] = () => [row("hi", { agent_id: "cog" })];
  const pages = () => asked().filter((call) => call.endsWith("/messages"));

  // With no stream open nothing says how the chats stand now, so each opening fetches.
  await store.loadMessages("mochi");
  await store.loadMessages("mochi");
  assert.equal(pages().length, 2);

  // The stream opens, and the chat the app holds is caught up once.
  const [first, second, third] = [stream(), stream(), stream()];
  streams.push(() => first.response, () => second.response, () => third.response);
  store.startSync();
  await settle();
  assert.equal(pages().length, 3);

  // The person goes from chat to chat and back.
  await store.loadMessages("cog");
  await store.loadMessages("mochi");
  await store.loadMessages("cog");
  assert.deepEqual(pages().slice(3), ["GET /agents/cog/messages"]);
  // A message the stream brings is the one change since, so the chat it lands in is caught up at the new count.
  first.say({ message: row("more"), agent: agent("mochi", { unread: 1, chat_changes: ++counts.mochi }) });
  await settle();
  await store.loadMessages("mochi");
  assert.deepEqual(store.useMessages("mochi"), [row("hello"), row("more")]);
  assert.equal(pages().length, 4);

  // The stream ends and another opens. Nothing changed meanwhile, so no chat is fetched, when the stream opens or when a chat does.
  const reopen = async (ended: ReturnType<typeof stream>) => {
    ended.end();
    await settle();
    tick(1000);
    await settle();
  };
  await reopen(first);
  await store.loadMessages("mochi");
  await store.loadMessages("cog");
  assert.equal(asked().filter((call) => call === "GET /agents").length, 2);
  assert.equal(pages().length, 4);

  // While it is down again, Mochi reads a message, which changes it where it is. Only Mochi's chat is fetched.
  counts.mochi++;
  answers["GET /agents/mochi/messages"] = () => [row("hello"), row("more", { seen_at: 9 })];
  await reopen(second);
  assert.deepEqual(pages().slice(4), ["GET /agents/mochi/messages"]);
  assert.deepEqual(store.useMessages("mochi"), [row("hello"), row("more", { seen_at: 9 })]);

  // With the stream closed, nothing says the chat is still as the computer has it.
  store.stopSync();
  await store.loadMessages("mochi");
  assert.equal(pages().length, 6);
});

test("catching up fetches only the chats that changed while the app was away, however a message in them changed", async (t) => {
  const chats = { mochi: [row("hello")], cog: [row("on it", { agent_id: "cog", sender: "person", status: "queued" })], pip: [row("hi", { agent_id: "pip" })], ember: [row("hey", { agent_id: "ember" })] };
  const { store, answers, streams, asked, savedNow } = app(t, {
    agents: [agent("mochi", { chat_changes: 3 }), agent("cog", { chat_changes: 5 }), agent("pip", { chat_changes: 2 }), agent("ember", { chat_changes: 1 })],
    messages: chats,
    // Ember's chat was opened once with the computer out of reach, so the app never had it as the computer does.
    caughtUp: { mochi: 3, cog: 5, pip: 2 },
  });
  // While the app was away Cog read the person's message, and Mochi asked Pip something, which is in Pip's chat and is nobody's latest.
  answers["GET /agents"] = () => [agent("mochi", { chat_changes: 3 }), agent("cog", { chat_changes: 6 }), agent("pip", { chat_changes: 3 }), agent("ember", { chat_changes: 1 })];
  const read = row("on it", { agent_id: "cog", sender: "person", status: "running", seen_at: 9 });
  const between = row("What do you think?", { agent_id: "mochi", peer_id: "pip", status: "queued" });
  answers["GET /agents/cog/messages"] = () => [read];
  answers["GET /agents/pip/messages"] = () => [...chats.pip, between];
  answers["GET /agents/ember/messages"] = () => chats.ember;
  streams.push(() => stream().response);
  store.startSync();
  await settle();

  assert.deepEqual(asked().filter((call) => call.endsWith("/messages")).sort(), ["GET /agents/cog/messages", "GET /agents/ember/messages", "GET /agents/pip/messages"]);
  assert.deepEqual([store.useMessages("mochi"), store.useMessages("cog"), store.useMessages("pip")], [chats.mochi, [read], [...chats.pip, between]]);
  assert.deepEqual(savedNow().caughtUp, { mochi: 3, cog: 6, pip: 3, ember: 1 });
  store.stopSync();
});

test("a change the stream brings out of step leaves its chat to be fetched when it is next opened", async (t) => {
  const { store, answers, streams, asked } = app(t, {
    agents: [agent("mochi", { chat_changes: 3 }), agent("cog", { chat_changes: 5 }), agent("pip", { chat_changes: 2 })],
    messages: { mochi: [row("hello")], cog: [row("Looks fine.", { agent_id: "pip", peer_id: "cog" }), row("hi", { agent_id: "cog" })] },
    caughtUp: { mochi: 3, cog: 5 },
  });
  let agents = [agent("mochi", { chat_changes: 3 }), agent("cog", { chat_changes: 5 }), agent("pip", { chat_changes: 2 })];
  answers["GET /agents"] = () => agents;
  answers["GET /agents/mochi/messages"] = () => [row("hello"), row("one"), row("two")];
  answers["GET /agents/cog/messages"] = () => [row("hi", { agent_id: "cog" })];
  const pages = () => asked().filter((call) => call.endsWith("/messages"));
  const events = stream();
  streams.push(() => events.response);
  store.startSync();
  await settle();
  assert.deepEqual(pages(), []);

  // Pip is deleted, which takes what it said to Cog out of Cog's chat on the computer. Cog comes after it with a new count and no message.
  events.say({ deleted: "pip" });
  events.say({ message: null, agent: agent("cog", { chat_changes: 6 }) });
  await settle();
  await store.loadMessages("mochi");
  await store.loadMessages("cog");
  await store.loadMessages("cog");
  assert.deepEqual(pages(), ["GET /agents/cog/messages"]);
  assert.deepEqual(store.useMessages("cog"), [row("hi", { agent_id: "cog" })]);

  // A message that isn't the next change to its chat came after one the app never heard of, so landing it doesn't catch the chat up.
  events.say({ message: row("two"), agent: agent("mochi", { chat_changes: 5 }) });
  await settle();
  assert.deepEqual(store.useMessages("mochi"), [row("hello"), row("two")]);
  await store.loadMessages("mochi");
  await store.loadMessages("mochi");
  assert.deepEqual(pages().slice(1), ["GET /agents/mochi/messages"]);
  assert.deepEqual(store.useMessages("mochi"), [row("hello"), row("one"), row("two")]);

  // A page that a change reached the chat ahead of may be older than the change, so it catches the chat up at nothing.
  agents = [agent("mochi", { chat_changes: 5 }), agent("cog", { chat_changes: 6 })];
  let fetched!: (page: Message[]) => void;
  answers["GET /agents/ember/messages"] = () => new Promise<Message[]>((resolve) => (fetched = resolve));
  events.say({ message: null, agent: agent("ember", { chat_changes: 1 }) });
  await settle();
  const opening = store.loadMessages("ember");
  events.say({ message: row("hey", { agent_id: "ember" }), agent: agent("ember", { chat_changes: 2 }) });
  await settle();
  fetched([]);
  await opening;
  answers["GET /agents/ember/messages"] = () => [row("hey", { agent_id: "ember" })];
  await store.loadMessages("ember");
  await store.loadMessages("ember");
  assert.equal(pages().filter((call) => call === "GET /agents/ember/messages").length, 2);
  store.stopSync();
});

test("a message the stream brings from before the app caught up is left as the page has it", async (t) => {
  const { store, answers, streams, asked } = app(t, { agents: [agent("cog", { chat_changes: 5 })], messages: { cog: [row("hi", { agent_id: "cog" })] }, caughtUp: { cog: 5 } });
  // The stream opens, Pip says something to Cog and is deleted, which takes it out of Cog's chat again, and only then does the app ask how the agents stand. The stream brings all of it after the app has caught up.
  answers["GET /agents"] = () => [agent("cog", { chat_changes: 7 })];
  answers["GET /agents/cog/messages"] = () => [row("hi", { agent_id: "cog" })];
  const events = stream();
  events.say({ message: row("Looks fine.", { agent_id: "pip", peer_id: "cog" }), agent: agent("cog", { chat_changes: 6 }) });
  events.say({ deleted: "pip" });
  events.say({ message: null, agent: agent("cog", { chat_changes: 7 }) });
  streams.push(() => events.response);
  store.startSync();
  await settle();

  assert.deepEqual(store.useMessages("cog"), [row("hi", { agent_id: "cog" })]);
  await store.loadMessages("cog");
  assert.equal(asked().filter((call) => call === "GET /agents/cog/messages").length, 1);
  store.stopSync();
});

test("how the agents stood for a stream that has closed since is dropped when it comes, as is the page of a chat the app has let go of", async (t) => {
  const { store, answers, streams, heard, savedNow } = app(t, { agents: [agent("mochi"), agent("cog")] });
  let late!: (agents: AgentWithLatest[]) => void;
  answers["GET /agents"] = () => new Promise<AgentWithLatest[]>((resolve) => (late = resolve));
  let page!: (page: Message[]) => void;
  answers["GET /agents/cog/messages"] = () => new Promise<Message[]>((resolve) => (page = resolve));
  streams.push(() => stream().response, () => stream().response);
  store.startSync();
  const opening = store.loadMessages("cog");
  await settle();

  // The app comes back to the front and opens another stream, which catches up first: Cog is gone and Mochi has a new name.
  answers["GET /agents"] = () => [agent("mochi", { name: "Mochi the second" })];
  heard.front(true);
  await settle();
  late([agent("mochi"), agent("cog")]);
  page([row("hi", { agent_id: "cog" })]);
  await opening;
  await settle();
  assert.deepEqual(store.useAgents().map((each) => [each.id, each.name]), [["mochi", "Mochi the second"]]);
  assert.deepEqual(savedNow().messages, {});
  store.stopSync();
});

test("a message that reaches the app after a later one this device sent goes before it, by the order they came in", async (t) => {
  const { store, answers, streams, asked } = app(t, {
    agents: [agent("mochi", { chat_changes: 3 }), agent("cog", { chat_changes: 0 })],
    messages: { mochi: [row("hello", { order: 5 })], cog: [] },
    caughtUp: { mochi: 3, cog: 0 },
  });
  answers["GET /agents"] = () => [agent("mochi", { chat_changes: 3 }), agent("cog", { chat_changes: 0 })];
  const events = stream();
  streams.push(() => events.response);
  store.startSync();
  await settle();
  const sent = (agentId: string, body: string, order: number) => row(body, { agent_id: agentId, sender: "person", status: "queued", order });

  // Another device sends Mochi a message a moment before this one does, and the computer's answer to this device comes ahead of what the stream says of the other's.
  answers["POST /agents/mochi/messages"] = () => sent("mochi", "mine", 11);
  await store.send("mochi", "mine");
  events.say({ message: sent("mochi", "theirs", 10), agent: agent("mochi", { chat_changes: 4 }) });
  events.say({ message: sent("mochi", "mine", 11), agent: agent("mochi", { chat_changes: 5 }) });
  await settle();
  assert.deepEqual(store.useMessages("mochi").map((message) => message.id), ["hello", "theirs", "mine"]);
  await store.loadMessages("mochi");
  assert.deepEqual(asked().filter((call) => call.endsWith("/messages")), ["POST /agents/mochi/messages"]);

  // The same in a chat that held nothing: what this device sent is all the chat holds, so the other's message looks like one from before it. The chat is left behind its count, and has the message once it is next opened.
  answers["POST /agents/cog/messages"] = () => sent("cog", "mine", 13);
  await store.send("cog", "mine");
  events.say({ message: sent("cog", "theirs", 12), agent: agent("cog", { chat_changes: 1 }) });
  events.say({ message: sent("cog", "mine", 13), agent: agent("cog", { chat_changes: 2 }) });
  await settle();
  answers["GET /agents/cog/messages"] = () => [sent("cog", "theirs", 12), sent("cog", "mine", 13)];
  await store.loadMessages("cog");
  assert.deepEqual(store.useMessages("cog").map((message) => message.id), ["theirs", "mine"]);
  store.stopSync();
});

test("a chat holds what was fetched and said of it only while it is on screen, and its newest page is what is saved", async (t) => {
  const { store, answers, streams, heard, asked, savedNow } = app(t);
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
  said(300, 400).forEach((message, index) => events.say({ message, agent: agent("mochi", { chat_changes: index + 1 }) }));
  await settle();
  assert.deepEqual(ids(store.useMessages("mochi")), ids(said(0, 400)));
  assert.deepEqual(ids(savedNow().messages.mochi), ids(said(350, 400)));

  // Closed, it goes back to its newest page, and what comes then takes the place of the oldest.
  close();
  assert.deepEqual(ids(store.useMessages("mochi")), ids(said(350, 400)));
  events.say({ message: row("m400", { order: 400, created_at: 400 }), agent: agent("mochi", { chat_changes: 101 }) });
  const fetches = () => asked().filter((call) => call === "GET /agents/mochi/messages").length;
  await settle();
  await store.loadMessages("mochi");
  assert.equal(fetches(), 1);
  // A message from before that page that changes, as one sent again, is no new message at the chat's end, though it was made in the same millisecond as the oldest message the chat holds. The chat has no place for it.
  events.say({ message: row("m10", { order: 10, created_at: 351, status: "queued" }), agent: agent("mochi", { chat_changes: 102 }) });
  await settle();
  assert.deepEqual(ids(store.useMessages("mochi")), ids(said(351, 401)));
  assert.deepEqual(ids(savedNow().messages.mochi), ids(said(351, 401)));
  // A new message goes at the chat's end, though the computer's clock went back before it was made.
  events.say({ message: row("m401", { order: 401, created_at: 5 }), agent: agent("mochi", { chat_changes: 103 }) });
  await settle();
  assert.deepEqual(ids(store.useMessages("mochi")), ids(said(352, 402)));
  // The message the chat had no place for left it behind its count, so it is fetched again when it is next opened.
  answers["GET /agents/mochi/messages"] = () => [...said(352, 401), row("m401", { order: 401, created_at: 5 })];
  await store.loadMessages("mochi");
  assert.equal(fetches(), 2);
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
  assert.deepEqual(savedNow(), { agents: [], messages: {}, caughtUp: {}, avatars: [], about: {}, usage: null, connections: null, pending: {} });
});
