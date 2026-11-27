import { test, type TestContext } from "node:test";
import { createDecipheriv, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { openStore } from "../src/store.ts";
import { createConnections } from "../src/connections.ts";
import { addFirstAgent, createQueue, type Turn, type TurnResult } from "../src/runner.ts";
import { claude } from "../src/claude.ts";
import { codex } from "../src/codex.ts";
import { createApi } from "../src/api.ts";
import { CONTRACT_VERSION, MESSAGE_BYTES, type AgentWithLatest, type Day, type Job, type Limit, type Message, type Question, type Used } from "../src/contract.ts";
import { startPush, type Ended, type Notice, type Sealed } from "../src/push.ts";

/** A turn's reply, as a fake provider gives it. No reply means the fake gave its replies itself. */
type Answer = TurnResult & { reply?: string };

/** Waits until push has told the phones of what came, which it does a moment after, and at once in these tests. */
const pushed = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * A Sidebots whose turns `answer` runs instead of Claude Code and Codex,
 * which still word the failures. Claude Code forgets the sessions too. The
 * fake reads the turn's first message, then replies to it. With `starts`,
 * the turn waits for it before it reads the message, as a provider's turn
 * takes a moment to start. Asked where a plan's limits stand, either answers
 * as `plan.limits` does. What Sidebots asks Google, `web.request` answers.
 */
function setup(answer: (turn: Turn) => Promise<Answer>, now: () => number = Date.now, starts?: (turn: Turn) => Promise<void>) {
  const runTurn = async (turn: Turn): Promise<TurnResult> => {
    if (starts) await starts(turn);
    turn.seen([turn.prompt.id]);
    const { reply: text, ...result } = await answer(turn);
    if (text !== undefined) turn.replied(text, [turn.prompt.id]);
    return result;
  };
  const home = mkdtempSync(join(tmpdir(), "sidebots-test-"));
  const store = openStore(home);
  store.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" });
  store.addPerson({ name: "Robin", provider: "claude", configDir: "/config/robin" });
  const plan = { limits: async (): Promise<Limit[] | null> => [] };
  const limits = () => plan.limits();
  const web = { request: async (_url: string, _init?: RequestInit): Promise<Response> => Response.json({}) };
  const connections = createConnections(store, { google: "sidebots-test.apps.googleusercontent.com" }, (url, init) => web.request(String(url), init), now);
  const queue = createQueue(store, { claude: { ...claude, runTurn, limits }, codex: { ...codex, runTurn, forget: () => undefined, limits } }, connections, now);
  const app = createApi(store, queue, connections, "Test computer", true);
  const notificationKeys = new Map<string, string>();
  /** Pairs another phone as the person, and returns what it sends with each request. */
  const pair = (name: string) => {
    const keys = store.pair(store.addPairing(store.personByName(name)!.id).code, `${name}'s phone`, "phone")!;
    notificationKeys.set(keys.key, keys.notificationKey);
    return { Authorization: `Bearer ${keys.key}` };
  };
  /** Opens a notice sealed for a phone, with that phone's notification key. */
  const open = (phone: { Authorization: string }, push: Sealed | Ended): Notice => {
    assert.ok("sealed" in push);
    const bytes = Buffer.from(push.sealed, "base64");
    const key = Buffer.from(notificationKeys.get(phone.Authorization.slice("Bearer ".length))!, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString()) as Notice;
  };
  const phones = new Map<string, { Authorization: string }>();
  /** What the person's phone sends with each request. The phone pairs the first time it is used. */
  const phoneOf = (name: string) => phones.get(name) ?? phones.set(name, pair(name)).get(name)!;
  const call = async (who: string | { Authorization: string }, method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { ...(typeof who === "string" ? phoneOf(who) : who), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  /** Sends a message the way the app does, as a form with any files. */
  const say = async (name: string, agentId: string, body: string, files: File[] = []) => {
    const form = new FormData();
    form.append("body", body);
    for (const file of files) form.append("files", file);
    const response = await app.request(`/agents/${agentId}/messages`, { method: "POST", headers: phoneOf(name), body: form });
    return { status: response.status, json: await response.json() };
  };
  return { home, store, queue, connections, plan, web, call, say, app, phoneOf, pair, open };
}

const reply = (text: string, sessionId = "session-1", contextTokens = 0, cost = 0, tokens = 0): Answer => ({ reply: text, sessionId, contextTokens, cost, tokens });

/** An ask to run a command, as a driver hands the runner one. */
const command = (detail: string, why?: string): Question => ({ kind: "command", title: "Run a command", what: "Clear the old folder", facts: [], detail, ...(why ? { why } : {}) });

const ME = "Alex";
const HER = "Robin";

test("a phone pairs once with a code, and only a paired phone is let in", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 16, 9, 0) });
  const { store, call, app } = setup(async () => reply("ok"));
  const alex = store.personByName(ME)!;
  const pairWith = async (code: string) => {
    const response = await app.request("/pair", {
      method: "POST",
      headers: { Authorization: `Pairing ${code}`, "Content-Type": "application/json", "Sidebots-Contract": String(CONTRACT_VERSION) },
      body: JSON.stringify({ name: "Alex's phone" }),
    });
    return { status: response.status, json: await response.json() };
  };

  assert.equal((await app.request("/agents")).status, 401);
  assert.equal((await call({ Authorization: "Bearer made-up" }, "GET", "/agents")).status, 401);
  assert.equal((await pairWith("made-up")).status, 401);

  const { code } = store.addPairing(alex.id);
  const paired = await pairWith(code);
  assert.equal(paired.status, 201);
  assert.equal(paired.json.machine, "Test computer");
  assert.equal((await pairWith(code)).status, 401);
  // The code works as a code only, and the key as a key only.
  assert.equal((await call({ Authorization: `Bearer ${code}` }, "GET", "/agents")).status, 401);
  assert.deepEqual((await call({ Authorization: `Bearer ${paired.json.key}` }, "GET", "/agents")).json, []);

  // Asked how it stands, the server answers a paired phone with nothing, and anyone with the version of the contract it speaks.
  const [known, unknown] = await Promise.all([paired.json.key, "made-up"].map((key) => app.request("/status", { headers: { Authorization: `Bearer ${key}` } })));
  assert.deepEqual([known.status, await known.text(), unknown.status], [204, "", 401]);
  for (const answer of [known, unknown]) assert.equal(answer.headers.get("Sidebots-Contract"), String(CONTRACT_VERSION));

  const late = store.addPairing(alex.id);
  assert.equal(late.expiresAt, Date.now() + 10 * 60_000);
  t.mock.timers.tick(10 * 60_000);
  assert.equal((await pairWith(late.code)).status, 401);

  // A code made to work for longer pairs until its own time is up.
  const DAY = 24 * 60 * 60_000;
  const [used, unused] = [store.addPairing(alex.id, 14 * DAY), store.addPairing(alex.id, 14 * DAY)];
  t.mock.timers.tick(14 * DAY - 1);
  assert.equal((await pairWith(used.code)).status, 201);
  t.mock.timers.tick(1);
  assert.equal((await pairWith(unused.code)).status, 401);
});

test("a phone that pairs again with the key it had takes the place of its earlier pairing", async () => {
  const { store, call, pair, app } = setup(async () => reply("ok"));
  const alex = store.personByName(ME)!;
  /** Pairs as the app does, which sends the hash of the key it still holds from a pairing it lost. */
  const pairWith = async (code: string, lost?: string) => {
    const replaces = lost && createHash("sha256").update(lost).digest("hex");
    const response = await app.request("/pair", {
      method: "POST",
      headers: { Authorization: `Pairing ${code}`, "Content-Type": "application/json", "Sidebots-Contract": String(CONTRACT_VERSION) },
      body: JSON.stringify({ name: "iPhone", replaces }),
    });
    return { status: response.status, key: ((await response.json()) as { key?: string }).key };
  };
  const other = pair(ME);
  const lost = await pairWith(store.addPairing(alex.id).code);

  const again = await pairWith(store.addPairing(alex.id).code, lost.key);
  assert.equal((await call({ Authorization: `Bearer ${lost.key}` }, "GET", "/agents")).status, 401);
  assert.equal((await call({ Authorization: `Bearer ${again.key}` }, "GET", "/agents")).status, 200);
  assert.equal((await call(other, "GET", "/agents")).status, 200);
  assert.deepEqual(store.devices().map((device) => device.name), ["Alex's phone", "iPhone"]);

  // A key without a code that works replaces nothing.
  assert.equal((await pairWith("made-up", again.key)).status, 401);
  assert.equal((await call({ Authorization: `Bearer ${again.key}` }, "GET", "/agents")).status, 200);
});

test("the desktop app pairs as a desktop, a device that names no kind is a phone, and a kind the server doesn't know is refused before the code is used", async () => {
  const { store, call, app } = setup(async () => reply("ok"));
  const alex = store.personByName(ME)!;
  const pairAs = async (code: string, body: { name: string; kind?: string }) => {
    const response = await app.request("/pair", {
      method: "POST",
      headers: { Authorization: `Pairing ${code}`, "Content-Type": "application/json", "Sidebots-Contract": String(CONTRACT_VERSION) },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as { key?: string; error?: string } };
  };

  const desktop = await pairAs(store.addPairing(alex.id).code, { name: "Alex's Mac", kind: "desktop" });
  assert.equal(desktop.status, 201);
  assert.equal((await call({ Authorization: `Bearer ${desktop.json.key}` }, "GET", "/agents")).status, 200);
  assert.equal((await pairAs(store.addPairing(alex.id).code, { name: "iPhone" })).status, 201);
  assert.equal((await pairAs(store.addPairing(alex.id).code, { name: "iPad", kind: "phone" })).status, 201);

  const { code } = store.addPairing(alex.id);
  const refused = await pairAs(code, { name: "Watch", kind: "watch" });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, "A device is a phone or a desktop.");
  assert.equal((await pairAs(code, { name: "iPhone 2" })).status, 201);

  assert.deepEqual(store.devices().map((device) => [device.name, device.kind]), [
    ["Alex's Mac", "desktop"],
    ["iPhone", "phone"],
    ["iPad", "phone"],
    ["iPhone 2", "phone"],
  ]);
});

test("a phone removed on the computer is refused from its next request, and the person's other phones stay paired", async () => {
  const { store, call, pair } = setup(async () => reply("ok"));
  const kept = pair(ME);
  const removed = pair(ME);
  const [, phone] = store.devices();

  assert.equal(store.removeDevice(phone.id)?.name, "Alex's phone");
  assert.equal(store.removeDevice(phone.id), undefined);
  assert.equal((await call(removed, "GET", "/agents")).status, 401);
  assert.equal((await call(kept, "GET", "/agents")).status, 200);
  assert.deepEqual(store.devices().map((device) => device.id), [store.deviceByKey(kept.Authorization.slice("Bearer ".length))!.id]);
});

test("a phone that unpairs itself is forgotten by the computer, and the person's other phones stay paired", async () => {
  const { store, call, pair } = setup(async () => reply("ok"));
  const kept = pair(ME);
  const leaving = pair(ME);
  await call(leaving, "PUT", "/push-token", { token: "ab".repeat(32), environment: "production" });

  assert.equal((await call(leaving, "DELETE", "/device")).status, 200);
  assert.equal((await call(leaving, "GET", "/agents")).status, 401);
  assert.equal((await call(kept, "GET", "/agents")).status, 200);
  assert.deepEqual(store.devices().map((device) => device.id), [store.deviceByKey(kept.Authorization.slice("Bearer ".length))!.id]);
  assert.deepEqual(store.pushTargetsFor(store.personByName(ME)!.id), []);
});

test("an app on another version of the contract can't pair, and its code still works once the versions match", async () => {
  const { store, app } = setup(async () => reply("ok"));
  const { code } = store.addPairing(store.personByName(ME)!.id);
  const pairAs = async (version?: number) => {
    const headers: Record<string, string> = { Authorization: `Pairing ${code}`, "Content-Type": "application/json" };
    if (version !== undefined) headers["Sidebots-Contract"] = String(version);
    const response = await app.request("/pair", { method: "POST", headers, body: JSON.stringify({ name: "Alex's phone" }) });
    return { status: response.status, version: response.headers.get("Sidebots-Contract"), json: await response.json() };
  };

  // An older app, a newer one, and one that sends no version. Each hears the server's version, so it can say which side to update.
  for (const version of [CONTRACT_VERSION - 1, CONTRACT_VERSION + 1, undefined]) {
    const refused = await pairAs(version);
    assert.equal(refused.status, 409);
    assert.equal(refused.version, String(CONTRACT_VERSION));
    assert.equal(refused.json.key, undefined);
  }
  // A phone is stored only as its code is used, so the code still pairing shows none was stored before.
  const paired = await pairAs(CONTRACT_VERSION);
  assert.equal(paired.status, 201);
  assert.equal(store.deviceByKey(paired.json.key)?.name, "Alex's phone");
});

test("every answer says which version of the contract the server speaks", async () => {
  const { store, app, phoneOf } = setup(async () => reply("ok"));
  const pairWith = (code: string) =>
    app.request("/pair", {
      method: "POST",
      headers: { Authorization: `Pairing ${code}`, "Content-Type": "application/json", "Sidebots-Contract": String(CONTRACT_VERSION) },
      body: JSON.stringify({ name: "Alex's phone" }),
    });
  const phone = phoneOf(ME);
  const events = await app.request("/events", { headers: phone });
  const answers = [
    await pairWith(store.addPairing(store.personByName(ME)!.id).code),
    await pairWith("made-up"),
    await app.request("/agents"),
    await app.request("/agents", { headers: phone }),
    await app.request("/agents/none/messages", { headers: phone }),
    await app.request("/nowhere", { headers: phone }),
    events,
  ];
  await events.body?.cancel();
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [201, 401, 401, 200, 404, 404, 200],
  );
  for (const answer of answers) assert.equal(answer.headers.get("Sidebots-Contract"), String(CONTRACT_VERSION));
});

test("a message gets the agent's reply, run in the agent's folder under its owner's login", async () => {
  const turns: Turn[] = [];
  const { store, queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    return reply(`You said: ${turn.prompt.text}`);
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;

  const sent = await say(ME, agent.id, "hello");
  assert.equal(sent.status, 201);
  assert.equal(sent.json.status, "queued");
  await queue.kick(agent.id);

  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "hello", "done"],
      ["agent", "You said: hello", "done"],
    ],
  );
  assert.equal(turns[0].cwd, store.agentHome(agent.id));
  assert.equal(turns[0].configDir, "/config/alex");
  assert.equal(turns[0].sessionId, null);
  assert.match(readFileSync(join(store.agentHome(agent.id), "CLAUDE.md"), "utf8"), /You are Theo, one of Alex's agents/);
});

test("messages sent while the agent is busy run one at a time, in order, on the same session", async () => {
  let running = 0;
  let most = 0;
  const seen: [string, string | null][] = [];
  const { queue, call, say } = setup(async (turn) => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push([turn.prompt.text, turn.sessionId]);
    running--;
    return reply("ok");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Money", avatarId: "cog" })).json;

  for (const body of ["one", "two", "three"]) await say(ME, agent.id, body);
  await queue.kick(agent.id);

  assert.equal(most, 1);
  assert.deepEqual(seen, [
    ["one", null],
    ["two", "session-1"],
    ["three", "session-1"],
  ]);
});

test("a failed turn keeps the message and adds a note from Sidebots saying why", async () => {
  const { queue, call, say } = setup(async () => {
    throw new Error("Claude Code process exited with code 1");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;

  await say(ME, agent.id, "find me a flat");
  await queue.kick(agent.id);

  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "find me a flat", "failed"],
      ["sidebots", "Sidebots couldn't finish this. Claude Code process exited with code 1", "failed"],
    ],
  );
});

test("a turn that fails for a reason the person can fix says what to do on the computer, not in Claude Code", async () => {
  // Each turn fails with what the person's newest message says, which ends the prompt.
  const { queue, call, say } = setup(async (turn) => {
    throw new Error(turn.prompt.text.split("\n").at(-1));
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  const failures = [
    "Not logged in · Please run /login",
    "Invalid API key · Fix external API key",
    "You've hit your 5-hour limit · resets 3pm (Europe/London)",
    "Claude usage limit reached.",
  ];
  for (const failure of failures) {
    await say(ME, agent.id, failure);
    await queue.kick(agent.id);
  }

  const notices = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.filter((m: { sender: string }) => m.sender === "sidebots");
  assert.deepEqual(
    notices.map((m: { body: string }) => m.body),
    [
      "Sidebots couldn't finish this. Claude Code on your computer is signed out. Sign in to it there.",
      "Sidebots couldn't finish this. Anthropic refused your API key. Save a new one on your computer.",
      "Sidebots couldn't finish this. Your Claude usage limit is reached. It resets at 3pm (Europe/London).",
      "Sidebots couldn't finish this. Your Claude usage limit is reached. Try again once it resets.",
    ],
  );
});

test("a person with an API key has every turn, job and fresh start run on it, and the key reaches nothing the phone sees", async () => {
  const KEY = "sk-ant-robins-key";
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const turns: Turn[] = [];
  const { home, store, queue, call, say, phoneOf, open } = setup(async (turn) => {
    turns.push(turn);
    if (turn.prompt.text === "watch the price") turn.scheduleJob({ title: "Watch", what: "Check the price.", every_minutes: 5 });
    if (turn.prompt.text.endsWith("buy it")) throw new Error(`Anthropic refused ${KEY}.`);
    return reply("ok");
  }, () => time);
  store.setApiKey(store.personByName(HER)!.id, "claude", KEY);
  assert.equal(statSync(join(home, "api-keys.json")).mode & 0o777, 0o600);
  const notices: Notice[] = [];
  startPush(store, async (_device, notice) => {
    if ("sealed" in notice) notices.push(open(phoneOf(HER), notice));
    return "sent";
  }, 0);
  await call(HER, "PUT", "/push-token", { token: "c".repeat(64), environment: "production" });

  const hers = (await call(HER, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  await say(HER, hers.id, "watch the price");
  await queue.kick(hers.id);
  time += 5 * 60_000;
  await queue.kick(hers.id);
  await call(HER, "POST", `/agents/${hers.id}/fresh-start`);
  await queue.kick(hers.id);
  await say(HER, hers.id, "buy it");
  await queue.kick(hers.id);

  // A message, a job's run, the save before a fresh start, and a turn that fails.
  assert.deepEqual(
    turns.map((turn) => [turn.prompt.text.slice(0, 20), turn.apiKey, turn.configDir]),
    [
      ["watch the price", KEY, "/config/robin"],
      ["This is a run of one", KEY, "/config/robin"],
      ["This session is abou", KEY, "/config/robin"],
      ["This is a fresh sess", KEY, "/config/robin"],
    ],
  );

  // Alex has no key, so his turns run on the login in his config folder.
  const mine = (await call(ME, "POST", "/agents", { name: "Gym", avatarId: "hop" })).json;
  await say(ME, mine.id, "hello");
  await queue.kick(mine.id);
  assert.deepEqual([turns[4].apiKey, turns[4].configDir], [undefined, "/config/alex"]);

  const messages = (await call(HER, "GET", `/agents/${hers.id}/messages`)).json;
  assert.equal(messages.at(-1).body, "Sidebots couldn't finish this. Anthropic refused your API key.");
  // The same notice goes to the chat list and to the phone as a notification.
  await pushed();
  const sent = [messages, (await call(HER, "GET", "/agents")).json, notices];
  assert.equal(JSON.stringify(sent).includes(KEY), false);

  // Without her key, her turns run on the login in her config folder.
  store.setApiKey(store.personByName(HER)!.id, "claude", null);
  await say(HER, hers.id, "hello again");
  await queue.kick(hers.id);
  assert.deepEqual([turns.at(-1)!.apiKey, turns.at(-1)!.configDir], [undefined, "/config/robin"]);
});

test("each person only reaches their own agents", async () => {
  const { call, say } = setup(async () => reply("ok"));
  const mine = (await call(ME, "POST", "/agents", { name: "Gym", avatarId: "hop" })).json;

  assert.deepEqual((await call(HER, "GET", "/agents")).json, []);
  assert.equal((await call(HER, "GET", `/agents/${mine.id}/messages`)).status, 404);
  assert.equal((await say(HER, mine.id, "hi")).status, 404);
});

test("the event stream carries the person's own messages and their status changes, and nobody else's", async () => {
  let finish!: () => void;
  const { queue, call, say, app, phoneOf } = setup(() => new Promise((resolve) => (finish = () => resolve(reply("done")))));
  const mine = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  const hers = (await call(HER, "POST", "/agents", { name: "Garden", avatarId: "moss" })).json;

  const response = await app.request("/events", { headers: phoneOf(ME) });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  await say(HER, hers.id, "not for you");
  await say(ME, mine.id, "hello");
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  finish();
  await queue.kick(mine.id);

  let text = "";
  while ((text.match(/event: message/g) ?? []).length < 4) text += (await reader.read()).value;
  await reader.cancel();
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as { message: { sender: string; body: string; status: string }; agent: { name: string; working: boolean } });
  assert.deepEqual(
    events.map(({ message, agent }) => [message.sender, message.body, message.status, agent.name, agent.working]),
    [
      ["person", "hello", "queued", "Theo", true],
      ["person", "hello", "running", "Theo", true],
      ["agent", "done", "done", "Theo", true],
      ["person", "hello", "done", "Theo", false],
    ],
  );
});

test("a message costs the database the same however many devices listen for it", async (t) => {
  const { store, call, app, pair } = setup(async () => reply("ok"));
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  // Every statement the store runs.
  const ran = (["get", "all", "run"] as const).map((method) => t.mock.method(StatementSync.prototype, method));
  const cost = (body: string) => {
    const before = ran.reduce((total, each) => total + each.mock.callCount(), 0);
    store.addMessage(agent.id, "agent", body, "done");
    return ran.reduce((total, each) => total + each.mock.callCount(), 0) - before;
  };
  const unheard = cost("Nobody hears this.");

  const readers = [];
  for (const phone of [pair(ME), pair(ME), pair(ME)]) {
    const reader = (await app.request("/events", { headers: phone })).body!.pipeThrough(new TextDecoderStream()).getReader();
    t.after(() => reader.cancel());
    // The stream's first ping says it is listening.
    await reader.read();
    readers.push(reader);
  }
  assert.equal(cost("Three hear this."), unheard);
  for (const reader of readers) {
    let text = "";
    while (!text.includes("event: message")) text += (await reader.read()).value;
    const heard = JSON.parse(text.split("\n").find((line) => line.startsWith("data: {"))!.slice(6)) as { message: Message; agent: AgentWithLatest };
    assert.deepEqual([heard.message.body, heard.agent.name, heard.agent.latest?.body], ["Three hear this.", "Theo", "Three hear this."]);
  }
});

test("the event stream carries the agents the person adds, changes and deletes on another phone, and nobody else's", async () => {
  const { call, app, phoneOf, pair } = setup(async () => reply("ok"));
  const otherPhone = pair(ME);
  const response = await app.request("/events", { headers: phoneOf(ME) });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const hers = (await call(HER, "POST", "/agents", { name: "Garden", avatarId: "moss" })).json;
  await call(HER, "PATCH", `/agents/${hers.id}`, { muted: true });
  const added = (await call(otherPhone, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  const changed = (await call(otherPhone, "PATCH", `/agents/${added.id}`, { name: "Theodore", muted: true, hidden: true })).json;
  // A change that names nothing to change, or reads a chat, tells nobody.
  await call(otherPhone, "PATCH", `/agents/${added.id}`, {});
  await call(otherPhone, "POST", `/agents/${added.id}/read`);
  await call(otherPhone, "DELETE", `/agents/${added.id}`);

  let text = "";
  while (!text.includes("event: deleted")) text += (await reader.read()).value;
  await reader.cancel();
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual([changed.name, changed.muted, changed.hidden], ["Theodore", true, true]);
  assert.deepEqual(events, [
    { message: null, agent: { ...added, latest: null, working: false, work: [], unread: 0, waiting_on: null } },
    { message: null, agent: changed },
    { deleted: added.id },
  ]);
});

test("a message's line breaks are kept as plain newlines, however the app that sent it wrote them", async () => {
  const { call, say } = setup(async () => reply("ok"));
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  // A form made as a browser makes one writes each line break as CRLF.
  assert.equal((await say(ME, agent.id, "one\ntwo\n\nthree\n")).json.body, "one\ntwo\n\nthree");
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/messages`, { body: "four\r\nfive" })).json.body, "four\nfive");
  const kept = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.filter((message: { sender: string }) => message.sender === "person");
  assert.deepEqual(kept.map((message: { body: string }) => message.body), ["one\ntwo\n\nthree", "four\nfive"]);
});

test("after a known message returns only what came later", async () => {
  const { queue, call, say } = setup(async (turn) => reply(`re: ${turn.prompt.text}`));
  const agent = (await call(ME, "POST", "/agents", { name: "Books", avatarId: "wisp" })).json;
  const first = (await say(ME, agent.id, "first")).json;
  await queue.kick(agent.id);

  const later = (await call(ME, "GET", `/agents/${agent.id}/messages?after=${first.id}`)).json;
  assert.deepEqual(later.map((m: { body: string }) => m.body), ["re: first"]);
});

test("files sent with a message go into the agent's folder, the agent is told where, only their owner can open them, and HEAD says how big each is", async () => {
  const prompts: string[] = [];
  const { store, queue, call, say, app, phoneOf } = setup(async (turn) => {
    prompts.push(turn.prompt.text);
    return reply("nice");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;

  const sent = await say(ME, agent.id, "what is this?", [new File(["jpeg bytes"], "IMG%20 0042.jpg", { type: "image/jpeg" })]);
  await queue.kick(agent.id);

  const [path] = sent.json.attachments as string[];
  assert.match(path, /^attachments\/[0-9a-f]{8}-IMG-0042\.jpg$/);
  assert.equal(readFileSync(join(store.agentHome(agent.id), path), "utf8"), "jpeg bytes");
  assert.equal(prompts[0], `what is this?\n\nSent with this message: ${path}`);

  const mine = await app.request(`/agents/${agent.id}/${path}`, { headers: phoneOf(ME) });
  assert.equal(mine.headers.get("Content-Type"), "image/jpeg");
  assert.equal(await mine.text(), "jpeg bytes");
  const sized = await app.request(`/agents/${agent.id}/${path}`, { method: "HEAD", headers: phoneOf(ME) });
  assert.equal(sized.status, 200);
  assert.equal(sized.headers.get("Content-Length"), "10");
  assert.equal(await sized.text(), "");
  // A large file comes a piece at a time.
  writeFileSync(join(store.agentHome(agent.id), "attachments", "film.mov"), new Uint8Array(1024 * 1024));
  const film = (await app.request(`/agents/${agent.id}/attachments/film.mov`, { headers: phoneOf(ME) })).body!.getReader();
  const pieces: number[] = [];
  for (let piece = await film.read(); !piece.done; piece = await film.read()) pieces.push(piece.value.byteLength);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.reduce((total, piece) => total + piece, 0), 1024 * 1024);
  assert.equal((await app.request(`/agents/${agent.id}/${path}`, { headers: phoneOf(HER) })).status, 404);
  assert.equal((await app.request(`/agents/${agent.id}/attachments/..`, { headers: phoneOf(ME) })).status, 404);
  assert.equal((await say(ME, agent.id, "  ")).status, 400);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/messages`, { body: "text alone, as JSON" })).json.body, "text alone, as JSON");
});

test("a fresh start has the agent save its memory, then gives the next message a new session that is shown the chat so far", async () => {
  const turns: Turn[] = [];
  const { queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    return reply("sure", `session-${turns.length}`);
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  await say(ME, agent.id, "book the band");
  await queue.kick(agent.id);

  const marker = await call(ME, "POST", `/agents/${agent.id}/fresh-start`);
  assert.equal(marker.status, 201);
  await say(ME, agent.id, "any news?");
  await queue.kick(agent.id);

  assert.deepEqual(turns.map((turn) => turn.sessionId), [null, "session-1", null]);
  assert.match(turns[1].prompt.text, /Save what is worth keeping .* learned about Alex/);
  assert.equal(
    turns[2].prompt.text,
    "This is a fresh session in a chat that was already going. The latest messages in it:\n\nAlex: book the band\n\nYou: sure\n\nAlex's new message:\n\nany news?",
  );
  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "book the band", "done"],
      ["agent", "sure", "done"],
      ["sidebots", "Fresh start", "done"],
      ["person", "any news?", "done"],
      ["agent", "sure", "done"],
    ],
  );
});

test("an agent moved to another provider hands over: it saves its memory where it was, and answers in a new session there that is shown the chat so far", async () => {
  const turns: Turn[] = [];
  const { home, store, queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    return reply("sure", `session-${turns.length}`);
  });
  store.addAccount(store.personByName(ME)!.id, "codex", "/config/alex-codex");
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  await say(ME, agent.id, "book the band");
  await queue.kick(agent.id);

  // A provider the person hasn't set up is refused, and so is a model of the provider the agent leaves.
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { provider: "abacus" })).status, 400);
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { provider: "codex", model: "opus" })).status, 400);
  // A Claude Code model sent from another device as the move lands is checked against the provider the agent has moved to.
  const [move, late] = await Promise.all([call(ME, "PATCH", `/agents/${agent.id}`, { provider: "codex" }), call(ME, "PATCH", `/agents/${agent.id}`, { model: "haiku" })]);
  assert.equal(late.status, 400);
  const moved = move.json;
  const opus = { provider: "claude", model: "opus", effort: "medium", fast: false };
  const sol = { provider: "codex", model: "sol", effort: "medium", fast: false };
  assert.deepEqual([moved.provider, moved.model, moved.effort, moved.ran_on, moved.session_id], ["codex", "sol", "medium", opus, "session-1"]);
  // Its instructions went with it, to the file Codex reads.
  assert.match(readFileSync(join(home, "agents", agent.id, "AGENTS.md"), "utf8"), /^# Theo\n/);
  assert.equal(existsSync(join(home, "agents", agent.id, "CLAUDE.md")), false);
  // Nothing in the chat says so until a turn runs on it.
  assert.equal((await call(ME, "GET", `/agents/${agent.id}/messages`)).json.length, 2);

  await say(ME, agent.id, "any news?");
  await queue.kick(agent.id);
  // The memory is saved in the session on Claude Code, and the reply comes from a new one on Codex.
  assert.deepEqual(
    turns.map((turn) => [turn.configDir, turn.model, turn.sessionId]),
    [
      ["/config/alex", "opus", null],
      ["/config/alex", "opus", "session-1"],
      ["/config/alex-codex", "sol", null],
    ],
  );
  assert.match(turns[1].prompt.text, /Save what is worth keeping/);
  assert.equal(
    turns[2].prompt.text,
    "This is a fresh session in a chat that was already going. The latest messages in it:\n\nAlex: book the band\n\nYou: sure\n\nAlex's new message:\n\nany news?",
  );
  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "book the band", "done"],
      ["agent", "sure", "done"],
      ["person", "any news?", "done"],
      ["sidebots", "Switched from Claude Opus 5.5 Medium to GPT-6.2 Sol Medium", "done"],
      ["agent", "sure", "done"],
    ],
  );
  assert.deepEqual(messages[3].switched, { from: opus, to: sol });
  const [after] = (await call(ME, "GET", "/agents")).json;
  assert.deepEqual([after.ran_on, after.session_id], [sol, "session-3"]);
});

test("a move to another provider while a turn runs hands over before the next turn, as the session is the old provider's", async () => {
  const turns: Turn[] = [];
  const { store, queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    // The person picks Claude Code as the agent's first reply arrives, before its turn on Codex has ended.
    if (turns.length === 1) await call(ME, "PATCH", `/agents/${agent.id}`, { provider: "claude" });
    return reply("sure", `session-${turns.length}`);
  });
  store.addAccount(store.personByName(ME)!.id, "codex", "/config/alex-codex");
  const agent = (await call(ME, "POST", "/agents", { name: "Tony", avatarId: "mochi", provider: "codex" })).json;
  await say(ME, agent.id, "hi");
  await queue.kick(agent.id);
  await say(ME, agent.id, "hi again");
  await queue.kick(agent.id);
  // The Codex thread is saved to on Codex and never handed to Claude Code.
  assert.deepEqual(
    turns.map((turn) => [turn.configDir, turn.sessionId]),
    [
      ["/config/alex-codex", null],
      ["/config/alex-codex", "session-1"],
      ["/config/alex", null],
    ],
  );
  const notices = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.filter((m: { sender: string }) => m.sender === "sidebots");
  assert.deepEqual(notices.map((m: { body: string; status: string }) => [m.body, m.status]), [["Switched from GPT-6.2 Sol Medium to Claude Opus 5.5 Medium", "done"]]);
});

test("another model, effort or speed on the same provider keeps the session, and the chat says what changed before the turn that first runs on it", async () => {
  const turns: Turn[] = [];
  const { queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    return reply("sure");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  // An agent that has yet to answer has nothing to switch from.
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { model: "sonnet" })).json.ran_on, null);
  await call(ME, "PATCH", `/agents/${agent.id}`, { model: "opus" });
  await say(ME, agent.id, "book the band");
  await queue.kick(agent.id);
  const notices = async () => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.filter((m: { sender: string }) => m.sender === "sidebots").map((m: { body: string }) => m.body);

  // A choice the person takes back before a turn runs on it changes nothing.
  await call(ME, "PATCH", `/agents/${agent.id}`, { model: "haiku" });
  await call(ME, "PATCH", `/agents/${agent.id}`, { model: "opus" });
  // Several choices before the next turn are one change.
  await call(ME, "PATCH", `/agents/${agent.id}`, { effort: "high" });
  await call(ME, "PATCH", `/agents/${agent.id}`, { fast: true });
  await say(ME, agent.id, "any news?");
  await queue.kick(agent.id);
  assert.deepEqual(await notices(), ["Switched from Medium Standard to High Fast"]);
  assert.deepEqual(
    turns.map((turn) => [turn.model, turn.effort, turn.fast, turn.sessionId]),
    [
      ["opus", "medium", false, null],
      ["opus", "high", true, "session-1"],
    ],
  );

  // Sonnet has no fast mode, so its turns run without it.
  await call(ME, "PATCH", `/agents/${agent.id}`, { model: "sonnet" });
  await say(ME, agent.id, "and now?");
  await queue.kick(agent.id);
  assert.deepEqual((await notices()).at(-1), "Switched from Claude Opus 5.5 Fast to Claude Sonnet 5.5 Standard");
  assert.deepEqual([turns[2].model, turns[2].fast], ["sonnet", false]);
});

test("a session its provider compacts is marked in the chat before the reply, and a job's own session is not", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "watch the price") turn.scheduleJob({ title: "Watch", what: "Check the price.", every_minutes: 5 });
    turn.compacted();
    return reply("ok");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Money", avatarId: "cog" })).json;
  await say(ME, agent.id, "watch the price");
  await queue.kick(agent.id);
  time += 5 * 60_000;
  await queue.kick(agent.id);

  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(messages.map((m: Message) => [m.sender, m.body, m.status]), [
    ["person", "watch the price", "done"],
    ["sidebots", "Compacted", "done"],
    ["agent", "ok", "done"],
    ["agent", "ok", "done"],
  ]);
});

test("a large Claude Code session that has sat an hour is compacted before the next message's turn, and a smaller or fresher one is read as it is", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 16, 9, 0) });
  const prompts: string[] = [];
  let held = 250_000;
  const { queue, call, say } = setup(async (turn) => {
    prompts.push(turn.prompt.text);
    if (turn.prompt.text === "/compact") {
      held = 30_000;
      turn.compacted();
    }
    return reply("ok", "chat", held);
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Money", avatarId: "cog" })).json;
  const sayAfter = async (minutes: number, text: string) => {
    t.mock.timers.tick(minutes * 60_000);
    await say(ME, agent.id, text);
    await queue.kick(agent.id);
  };
  await sayAfter(0, "budget");
  await sayAfter(59, "and rent");
  await sayAfter(60, "and savings");
  await sayAfter(60, "and the deposit");

  assert.deepEqual(prompts, ["budget", "and rent", "/compact", "and savings", "and the deposit"]);
  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(messages.map((m: Message) => m.body), ["budget", "ok", "and rent", "ok", "and savings", "Compacted", "ok", "and the deposit", "ok"]);
});

test("a search, by an agent or from the app, reaches all of the person's chats and nobody else's", async () => {
  const searches: string[] = [];
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "search") searches.push(turn.searchHistory("florist"));
    return reply("ok");
  });
  const theo = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  const money = (await call(ME, "POST", "/agents", { name: "Money", avatarId: "cog" })).json;
  const hers = (await call(HER, "POST", "/agents", { name: "Garden", avatarId: "moss" })).json;
  await say(ME, theo.id, "The florist quoted 400");
  await say(HER, hers.id, "my florist is a secret");
  await queue.kick(theo.id);
  await queue.kick(hers.id);

  await say(ME, money.id, "search");
  await queue.kick(money.id);

  assert.match(searches[0], /^\d{4}-\d{2}-\d{2}, chat with Theo, the person: The florist quoted 400$/);

  const found = (await call(ME, "GET", "/search?text=florist")).json;
  assert.deepEqual(
    found.map((m: { agent_id: string; body: string }) => [m.agent_id, m.body]),
    [[theo.id, "The florist quoted 400"]],
  );
});

test("a reply or a failed turn notifies the person's phones, and a phone Apple has dropped is forgotten", async () => {
  let fail = false;
  const { store, queue, call, say, phoneOf, pair, open } = setup(async () => {
    if (fail) throw new Error("Signed out.");
    return reply("Booked.");
  });
  const sent: [string, Notice][] = [];
  const myPhone = phoneOf(ME);
  const oldPhone = pair(ME);
  const read: string[] = [];
  startPush(store, async (device, notice) => {
    if ("read" in notice) return read.push(device.token), "sent";
    const phone = device.token === OLD_PHONE ? oldPhone : device.token === PHONE ? myPhone : phoneOf(HER);
    // Each phone's notice opens with its own key, and with no other phone's.
    assert.throws(() => open(phone === oldPhone ? myPhone : oldPhone, notice));
    sent.push([device.token, open(phone, notice)]);
    return device.token === OLD_PHONE ? "gone" : "sent";
  }, 0);
  const PHONE = "a".repeat(64);
  const OLD_PHONE = "b".repeat(64);
  const HER_PHONE = "c".repeat(64);
  for (const [phone, token] of [[myPhone, PHONE], [oldPhone, OLD_PHONE], [phoneOf(HER), HER_PHONE]] as const) {
    assert.equal((await call(phone, "PUT", "/push-token", { token, environment: "production" })).status, 200);
  }
  assert.equal((await call(ME, "PUT", "/push-token", { token: "nope", environment: "production" })).status, 400);
  assert.equal((await call(ME, "PUT", "/push-token", { token: PHONE, environment: "sandbox", app: "not an app" })).status, 400);
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  // A reply counts as unread when it is newer than the chat was read, which begins at the agent's creation.
  await new Promise((resolve) => setTimeout(resolve, 1));

  await say(ME, agent.id, "book the band");
  await queue.kick(agent.id);
  await pushed();
  fail = true;
  await say(ME, agent.id, "and the florist");
  await queue.kick(agent.id);
  await call(ME, "POST", `/agents/${agent.id}/fresh-start`);
  await queue.kick(agent.id);
  await pushed();

  assert.deepEqual(
    sent.map(([token, notice]) => [token, notice.title, notice.body, notice.badge, notice.agentId]),
    [
      [PHONE, "Theo", "Booked.", 1, agent.id],
      [OLD_PHONE, "Theo", "Booked.", 1, agent.id],
      [PHONE, "Theo", "Sidebots couldn't finish this. Signed out.", 2, agent.id],
    ],
  );

  // Reading the chat clears the count, and the phone that was notified is told, so its notifications go. A fresh start is nothing to read.
  assert.equal((await call(ME, "GET", "/agents")).json[0].unread, 2);
  assert.deepEqual(read, []);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/read`)).json.unread, 0);
  assert.deepEqual(read, [PHONE]);
  assert.equal((await call(HER, "POST", `/agents/${agent.id}/read`)).status, 404);
  // A chat with nothing unread is read already, which is nothing to tell.
  await call(ME, "POST", `/agents/${agent.id}/read`);
  assert.deepEqual(read, [PHONE]);
});

test("a reply the person reads as it comes reaches no phone", async () => {
  const { store, queue, call, say } = setup(async () => reply("Booked."));
  const sent: string[] = [];
  const HOLD_MS = 20;
  startPush(store, async (_device, push) => (sent.push("read" in push ? "read" : "notice"), "sent"), HOLD_MS);
  await call(ME, "PUT", "/push-token", { token: "a".repeat(64), environment: "production" });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  await new Promise((resolve) => setTimeout(resolve, 1));

  // The chat is open on another device, which marks the reply read as it shows it.
  await say(ME, agent.id, "book the band");
  await queue.kick(agent.id);
  await call(ME, "POST", `/agents/${agent.id}/read`);
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS * 2));
  assert.deepEqual(sent, []);

  // Nobody is looking at the next one. The phone is told, and told again when the agent is deleted with it unread.
  await say(ME, agent.id, "and the florist");
  await queue.kick(agent.id);
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS * 2));
  assert.deepEqual(sent, ["notice"]);
  await call(ME, "DELETE", `/agents/${agent.id}`);
  assert.deepEqual(sent, ["notice", "read"]);
});

test("the Live Activity a phone shows for a working agent ends with the agent's work, on the state its avatar is left in", async () => {
  let fail = false;
  let finish = () => {};
  const { store, queue, connections, call, say, phoneOf } = setup(async (turn) => {
    // A prompt that starts a session comes with the chat so far, so the newest message is looked for first.
    if (turn.prompt.text.includes("clear the old folder")) await turn.ask(command("rm -rf ~/old"), new AbortController().signal);
    else if (turn.prompt.text.includes("wait there")) return untilStopped(turn);
    else await new Promise<void>((resolve) => (finish = resolve));
    if (fail) throw new Error("Signed out.");
    return reply("Booked.");
  });
  const ended: unknown[] = [];
  startPush(store, async (to, push) => {
    if ("ended" in push) ended.push([to, push]);
    return "sent";
  });
  const activity = { token: "d".repeat(256), environment: "sandbox", app: "app.sidebots.dev" };
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  const token = (who: string | { Authorization: string }, body: unknown = activity) => call(who, "PUT", `/agents/${agent.id}/activity-token`, body);
  /** Sends a message, gives the server the activity's token while the agent works, then lets the turn end. */
  const work = async (start: () => Promise<unknown>) => {
    await start();
    const turn = queue.kick(agent.id);
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal((await token(ME)).status, 200);
    finish();
    await turn;
  };

  // An agent with no work has no activity to end, and nobody gives a token for another person's agent.
  assert.equal((await token(ME)).status, 409);
  assert.equal((await token(HER)).status, 404);
  assert.equal((await token(ME, { token: "nope", environment: "sandbox" })).status, 400);

  await new Promise((resolve) => setTimeout(resolve, 1));
  await work(() => say(ME, agent.id, "book the band"));
  // The push is the token and the state. The agent's name and what it said are in the notification, which is encrypted.
  assert.deepEqual(ended, [[activity, { ended: "replied" }]]);

  // The token was for that activity, so the next turn ends nothing until the phone shows another.
  // A server with no relay could never end one, and says so while the agent works.
  await say(ME, agent.id, "and the florist");
  const unshown = queue.kick(agent.id);
  await new Promise((resolve) => setTimeout(resolve, 1));
  const noRelay = createApi(store, queue, connections, "Test computer", false);
  const refused = await noRelay.request(`/agents/${agent.id}/activity-token`, { method: "PUT", headers: { ...phoneOf(ME), "Content-Type": "application/json" }, body: JSON.stringify(activity) });
  assert.equal(refused.status, 501);
  finish();
  await unshown;
  assert.equal(ended.length, 1);

  fail = true;
  await work(() => say(ME, agent.id, "and the cake"));
  assert.deepEqual(ended.at(-1), [activity, { ended: "failed" }]);

  // A fresh start leaves nothing to read once the chat has been read, so the activity goes at once.
  fail = false;
  await call(ME, "POST", `/agents/${agent.id}/read`);
  await work(() => call(ME, "POST", `/agents/${agent.id}/fresh-start`));
  assert.deepEqual(ended.at(-1), [activity, { ended: "resting" }]);
  assert.equal(ended.length, 3);

  // A turn the person stops leaves the agent resting too.
  await say(ME, agent.id, "wait there");
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await token(ME)).status, 200);
  await call(ME, "POST", `/agents/${agent.id}/stop`);
  await queue.kick(agent.id);
  assert.deepEqual(ended.at(-1), [activity, { ended: "resting" }]);
  assert.equal(ended.length, 4);

  // An agent that waits on an ask is still at work, so its activity stays until the turn the answer lets go on has ended.
  await say(ME, agent.id, "clear the old folder");
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await token(ME)).status, 200);
  const asked = ((await call(ME, "GET", `/agents/${agent.id}/messages`)).json as { id: string; ask: string | null }[]).at(-1)!;
  assert.equal(asked.ask, "waiting");
  assert.equal(ended.length, 4);
  await call(ME, "POST", `/agents/${agent.id}/asks/${asked.id}`, { allow: true });
  await queue.kick(agent.id);
  assert.deepEqual(ended.at(-1), [activity, { ended: "replied" }]);
  assert.equal(ended.length, 5);
});

test("an agent's name, avatar, model and effort can be changed, and its turns run on its model at its effort", async () => {
  const models: string[][] = [];
  const { store, queue, call, say } = setup(async (turn) => {
    models.push([turn.model, turn.effort]);
    return reply("ok");
  });
  store.installStarterAvatars(join(import.meta.dirname, "..", "..", "avatars"));
  const agent = (await call(ME, "POST", "/agents", { name: "Money", avatarId: "cog" })).json;
  assert.deepEqual([agent.model, agent.effort], ["opus", "medium"]);

  const changed = await call(ME, "PATCH", `/agents/${agent.id}`, { name: "Budget", avatarId: "moss", model: "haiku", effort: "high" });
  assert.deepEqual([changed.json.name, changed.json.avatar_id, changed.json.model, changed.json.effort], ["Budget", "moss", "haiku", "high"]);
  assert.match(readFileSync(join(store.agentHome(agent.id), "CLAUDE.md"), "utf8"), /^# Budget\n\nYou are Budget, one of Alex's agents/);
  await say(ME, agent.id, "hello");
  await queue.kick(agent.id);
  assert.deepEqual(models, [["haiku", "high"]]);

  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { model: "gpt" })).status, 400);
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { effort: "ultracode" })).status, 400);
  // Each provider has its own efforts: Claude Code goes up to Max, and Ultra is Codex's alone.
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { effort: "max" })).json.effort, "max");
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { effort: "ultra" })).status, 400);
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { avatarId: "dragon" })).status, 400);
  assert.equal((await call(HER, "PATCH", `/agents/${agent.id}`, { name: "Mine" })).status, 404);
});

test("an agent's chat takes its avatar's colour until the person picks one, and goes back to it on null", async () => {
  const { store, call } = setup(async () => reply("ok"));
  store.installStarterAvatars(join(import.meta.dirname, "..", "..", "avatars"));
  // Each avatar's colour is its body colour, dark enough to read white text on.
  const colors = Object.fromEntries((await call(ME, "GET", "/avatars")).json.map((avatar: { id: string; color: string }) => [avatar.id, avatar.color]));
  assert.equal(colors.mochi, "#E31775");
  assert.equal(colors.skye, "#286BF5");

  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "mochi" })).json;
  assert.equal(agent.color, null);
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { color: "#0b7a6a" })).json.color, "#0B7A6A");
  assert.equal((await call(ME, "GET", "/agents")).json[0].color, "#0B7A6A");
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { color: null })).json.color, null);
  for (const color of ["teal", "#0B7A6", 7]) assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { color })).status, 400);
});

test("deleting an agent removes its messages, its jobs, what it used, its folder and its Claude Code sessions", async () => {
  const { home, store, queue, call, say } = setup(async (turn) => {
    turn.scheduleJob({ title: "Watch", what: "check", every_minutes: 5 });
    return reply("ok");
  });
  const configDir = join(home, "claude");
  store.addPerson({ name: "Sam", provider: "claude", configDir });
  const agent = (await call("Sam", "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  const folder = store.agentHome(agent.id);
  const sessions = join(configDir, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "session-1.jsonl"), "{}");
  await say("Sam", agent.id, "hello");
  await queue.kick(agent.id);

  assert.equal((await call(ME, "DELETE", `/agents/${agent.id}`)).status, 404);
  assert.equal((await call("Sam", "DELETE", `/agents/${agent.id}`)).status, 200);

  assert.deepEqual((await call("Sam", "GET", "/agents")).json, []);
  assert.equal((await call("Sam", "GET", `/agents/${agent.id}/messages`)).status, 404);
  assert.deepEqual(store.jobs(agent.id), []);
  assert.deepEqual((await call("Sam", "GET", "/usage")).json.used, []);
  assert.equal(existsSync(folder), false);
  assert.equal(existsSync(sessions), false);
});

test("each agent's turns are counted with what they cost and the tokens they used, a job's runs apart from its replies, by day for seven days and for their owner alone", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 16, 23, 30) });
  // Claude Code says what a session has cost and used in all. The chat's session goes on from turn to turn, and each of a job's runs is a session of its own.
  let chat = 0;
  let runs = 0;
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "watch the price") turn.scheduleJob({ title: "Watch", what: "Check the price.", every_minutes: 5 });
    if (turn.prompt.text.startsWith("This is a run of one of your jobs")) return reply("SILENT", `run-${++runs}`, 0, 0.125, 1000);
    chat += turn.prompt.text === "watch the price" ? 0.5 : 0.25;
    return reply("ok", "chat", 0, chat, chat * 40_000);
  }, () => Date.now());
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  const used = async (who: string) =>
    (await call(who, "GET", "/usage")).json.used.map((each: Used) => [each.agent_id, each.kind, each.turns, each.cost, each.tokens]).sort();
  const days = async (who: string) => (await call(who, "GET", "/usage")).json.days.map((each: Day) => [each.day, each.cost, each.tokens]);

  await say(ME, agent.id, "watch the price");
  await queue.kick(agent.id);
  for (let run = 0; run < 2; run++) {
    t.mock.timers.tick(5 * 60_000);
    await queue.kick(agent.id);
  }
  await say(ME, agent.id, "buy it");
  await queue.kick(agent.id);
  await call(ME, "POST", `/agents/${agent.id}/fresh-start`);
  await queue.kick(agent.id);

  assert.deepEqual(await used(ME), [
    [agent.id, "job", 2, 0.25, 2000],
    [agent.id, "memory", 1, 0.25, 10_000],
    [agent.id, "reply", 2, 0.75, 30_000],
  ]);
  // Every one of the seven days is there, the oldest first, and all the turns ran today.
  assert.deepEqual(await days(ME), [
    ["2026-11-10", 0, 0],
    ["2026-11-11", 0, 0],
    ["2026-11-12", 0, 0],
    ["2026-11-13", 0, 0],
    ["2026-11-14", 0, 0],
    ["2026-11-15", 0, 0],
    ["2026-11-16", 1.25, 42_000],
  ]);
  assert.deepEqual(await used(HER), []);
  assert.deepEqual((await days(HER)).at(-1), ["2026-11-16", 0, 0]);

  // A reply after midnight falls in the next day, as does the job's run that had come due.
  t.mock.timers.tick(60 * 60_000);
  await say(ME, agent.id, "is it here yet");
  await queue.kick(agent.id);
  assert.deepEqual((await days(ME)).slice(-2), [
    ["2026-11-16", 1.25, 42_000],
    ["2026-11-17", 0.375, 11_000],
  ]);

  // The sixth day after is the last that counts the first day's turns.
  t.mock.timers.tick(5 * 24 * 60 * 60_000);
  assert.deepEqual((await days(ME)).slice(0, 2), [
    ["2026-11-16", 1.25, 42_000],
    ["2026-11-17", 0.375, 11_000],
  ]);
  t.mock.timers.tick(24 * 60 * 60_000);
  assert.deepEqual(await used(ME), [
    [agent.id, "job", 1, 0.125, 1000],
    [agent.id, "reply", 1, 0.25, 10_000],
  ]);
  assert.deepEqual((await days(ME))[0], ["2026-11-17", 0.375, 11_000]);
});

test("a session that ran turns before they were counted uses nothing on its first counted turn, and one whose count starts again uses all of it", async () => {
  const totals = [[5, 900_000], [6, 950_000], [0.5, 20_000]];
  const { store, queue, call, say } = setup(async () => reply("ok", "old", 0, ...totals.shift()!));
  const agent = (await call(ME, "POST", "/agents", { name: "Money", avatarId: "cog" })).json;
  store.setSession(agent.id, "old");
  const used = async () => (({ cost, tokens }: Used) => [cost, tokens])((await call(ME, "GET", "/usage")).json.used[0]);

  await say(ME, agent.id, "budget");
  await queue.kick(agent.id);
  assert.deepEqual(await used(), [0, 0]);
  await say(ME, agent.id, "and savings");
  await queue.kick(agent.id);
  assert.deepEqual(await used(), [1, 50_000]);
  await say(ME, agent.id, "and the deposit");
  await queue.kick(agent.id);
  assert.deepEqual(await used(), [1.5, 70_000]);
});

test("a plan's limits stand as the provider last said while a turn ran, even one that failed, until they reset; an API key has none", async (t) => {
  const start = new Date(2026, 10, 16, 9, 0).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const HOUR = 60 * 60_000;
  const { store, queue, call, say } = setup(async (turn) => {
    turn.limits([
      { name: "Weekly limit", used: turn.prompt.text === "hello" ? 0.32 : 0.4, resets_at: start + 48 * HOUR, at: Date.now() },
      ...(turn.prompt.text === "hello" ? [{ name: "5-hour limit", used: 1.02, resets_at: start + 2 * HOUR, at: Date.now() }] : []),
    ]);
    if (turn.prompt.text === "hello") throw new Error("You've hit your limit · resets 11am");
    return reply("ok");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Gym", avatarId: "hop" })).json;
  const accounts = async (who: string) => (await call(who, "GET", "/usage")).json.accounts;
  assert.deepEqual(await accounts(ME), [{ provider: "claude", apiKey: false, limits: [] }]);

  await say(ME, agent.id, "hello");
  await queue.kick(agent.id);
  assert.deepEqual(await accounts(ME), [
    {
      provider: "claude",
      apiKey: false,
      limits: [
        { name: "5-hour limit", used: 1.02, resets_at: start + 2 * HOUR, at: start },
        { name: "Weekly limit", used: 0.32, resets_at: start + 48 * HOUR, at: start },
      ],
    },
  ]);
  assert.deepEqual(await accounts(HER), [{ provider: "claude", apiKey: false, limits: [] }]);

  // A later turn says where one limit stands now. The other keeps what was last said of it, and goes once it has reset.
  t.mock.timers.tick(HOUR);
  await say(ME, agent.id, "hello again");
  await queue.kick(agent.id);
  const weekly = { name: "Weekly limit", used: 0.4, resets_at: start + 48 * HOUR, at: start + HOUR };
  assert.deepEqual((await accounts(ME))[0].limits, [{ name: "5-hour limit", used: 1.02, resets_at: start + 2 * HOUR, at: start }, weekly]);
  t.mock.timers.tick(HOUR);
  assert.deepEqual((await accounts(ME))[0].limits, [weekly]);

  store.setApiKey(store.personByName(ME)!.id, "claude", "sk-ant-alexs-key");
  assert.deepEqual(await accounts(ME), [{ provider: "claude", apiKey: true, limits: [] }]);
});

/** Opens the person's event stream, and returns what reads the next plan it brings. */
async function plansOn(app: ReturnType<typeof setup>["app"], phone: { Authorization: string }, t: TestContext): Promise<() => Promise<unknown>> {
  const reader = (await app.request("/events", { headers: phone })).body!.pipeThrough(new TextDecoderStream()).getReader();
  t.after(() => reader.cancel());
  let text = "";
  return async () => {
    for (;;) {
      const end = text.indexOf("\n\n");
      if (end < 0) {
        text += (await reader.read()).value;
        continue;
      }
      const frame = text.slice(0, end);
      text = text.slice(end + 2);
      if (frame.startsWith("event: plan")) return JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
    }
  };
}

test("asking for usage answers at once with what the provider last said, and asks it again once a minute at most, once for requests that come together; what it says reaches the person's devices, and one that fails leaves what it last said", async (t) => {
  const start = new Date(2026, 10, 16, 9, 0).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { store, call, plan, app, phoneOf } = setup(async () => reply("ok"), () => Date.now());
  let asked = 0;
  const fable = (used: number, at: number) => ({ name: "Fable limit", used, resets_at: start + 48 * 60 * 60_000, at });
  plan.limits = async () => [fable(0.02 * ++asked, Date.now())];
  const limits = async (who = ME) => (await call(who, "GET", "/usage")).json.accounts[0].limits;
  const mine = await plansOn(app, phoneOf(ME), t);
  const hers = await plansOn(app, phoneOf(HER), t);

  // Nothing has been said yet. Two requests at once share the one ask, and its answer comes on the stream.
  assert.deepEqual(await Promise.all([limits(), limits()]), [[], []]);
  assert.deepEqual(await mine(), { plan: { provider: "claude", apiKey: false, limits: [fable(0.02, start)] } });
  assert.equal(asked, 1);
  t.mock.timers.tick(59_000);
  assert.deepEqual(await limits(), [fable(0.02, start)]);
  assert.equal(asked, 1);
  t.mock.timers.tick(1000);
  assert.deepEqual(await limits(), [fable(0.02, start)]);
  assert.deepEqual(await mine(), { plan: { provider: "claude", apiKey: false, limits: [fable(0.04, start + 60_000)] } });

  plan.limits = async () => {
    asked++;
    throw new Error("Not logged in");
  };
  t.mock.timers.tick(60_000);
  assert.deepEqual(await limits(), [fable(0.04, start + 60_000)]);
  assert.equal(asked, 3);

  // What another person's provider says goes to their devices only, so the next plan this stream brings is the next one of the person's own.
  plan.limits = async () => [fable(0.5, Date.now())];
  assert.deepEqual(await limits(HER), []);
  assert.deepEqual(await hers(), { plan: { provider: "claude", apiKey: false, limits: [fable(0.5, start + 120_000)] } });
  plan.limits = async () => [fable(0.08, Date.now())];
  t.mock.timers.tick(60_000);
  await limits();
  assert.deepEqual(await mine(), { plan: { provider: "claude", apiKey: false, limits: [fable(0.08, start + 180_000)] } });

  // An API key has no plan to ask about.
  plan.limits = async () => {
    asked++;
    return [];
  };
  store.setApiKey(store.personByName(ME)!.id, "claude", "sk-ant-alexs-key");
  t.mock.timers.tick(60_000);
  assert.deepEqual(await limits(), []);
  assert.equal(asked, 3);
});

test("a login that is an API key is billed as one, with no plan, until the provider says of a plan again", async (t) => {
  const start = new Date(2026, 10, 16, 9, 0).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { call, plan, app, phoneOf } = setup(async () => reply("ok"), () => Date.now());
  const accounts = async () => (await call(ME, "GET", "/usage")).json.accounts;
  const next = await plansOn(app, phoneOf(ME), t);
  const weekly = { name: "Weekly limit", used: 0.1, resets_at: start + 48 * 60 * 60_000, at: start };
  plan.limits = async () => [weekly];
  await accounts();
  assert.deepEqual(await next(), { plan: { provider: "claude", apiKey: false, limits: [weekly] } });

  // The person saves a key as the login. The limits of the plan they left are no longer theirs to see.
  plan.limits = async () => null;
  t.mock.timers.tick(60_000);
  assert.deepEqual(await accounts(), [{ provider: "claude", apiKey: false, limits: [weekly] }]);
  assert.deepEqual(await next(), { plan: { provider: "claude", apiKey: true, limits: [] } });
  assert.deepEqual(await accounts(), [{ provider: "claude", apiKey: true, limits: [] }]);
  // A provider that fails to answer leaves what it last said, and tells nobody.
  plan.limits = async () => {
    throw new Error("Codex stopped without a reply");
  };
  t.mock.timers.tick(60_000);
  assert.deepEqual(await accounts(), [{ provider: "claude", apiKey: true, limits: [] }]);

  plan.limits = async () => [{ ...weekly, at: Date.now() }];
  t.mock.timers.tick(60_000);
  await accounts();
  assert.deepEqual(await next(), { plan: { provider: "claude", apiKey: false, limits: [{ ...weekly, at: start + 180_000 }] } });
  assert.deepEqual(await accounts(), [{ provider: "claude", apiKey: false, limits: [{ ...weekly, at: start + 180_000 }] }]);
});

test("an agent runs on a provider its owner has set up: the one they pick, or the first they set up", async () => {
  const ranIn: string[] = [];
  const { home, store, queue, call, say } = setup(async (turn) => {
    ranIn.push(turn.configDir);
    return reply("ok");
  });
  // Alex has set up Claude Code alone.
  const refused = await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss", provider: "codex" });
  assert.deepEqual([refused.status, refused.json.error], [400, "Codex isn't set up on your computer."]);
  assert.equal((await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss", provider: "abacus" })).json.error, "That isn't set up on your computer.");

  store.addAccount(store.personByName(ME)!.id, "codex", "/config/alex-codex");
  const maya = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss", provider: "codex" })).json;
  assert.deepEqual([maya.provider, maya.model, maya.effort], ["codex", "sol", "medium"]);
  // Its instructions are in the file Codex reads.
  assert.match(readFileSync(join(home, "agents", maya.id, "AGENTS.md"), "utf8"), /^# Maya\n/);
  // It takes Codex's models, and none of Claude Code's.
  assert.equal((await call(ME, "PATCH", `/agents/${maya.id}`, { model: "opus" })).status, 400);
  assert.equal((await call(ME, "PATCH", `/agents/${maya.id}`, { model: "luna" })).json.model, "luna");

  const gym = (await call(ME, "POST", "/agents", { name: "Gym", avatarId: "hop" })).json;
  assert.equal(gym.provider, "claude");
  // Each runs on its own provider's config folder.
  for (const agent of [maya, gym]) {
    await say(ME, agent.id, "hello");
    await queue.kick(agent.id);
  }
  assert.deepEqual(ranIn, ["/config/alex-codex", "/config/alex"]);
  assert.deepEqual((await call(ME, "GET", "/usage")).json.accounts.map((account: { provider: string }) => account.provider), ["claude", "codex"]);
});

test("a job runs when its time comes, in a session of its own, and only a run with something to say sends a message", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const runs: [string, string | null, boolean][] = [];
  let found = "SILENT";
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "watch the price") {
      assert.match(turn.scheduleJob({ title: "Watch", what: "Check the price. Stay silent unless it dropped.", every_minutes: 5 }), /^Saved job \w+, "Watch": Every 5 min, next at 2026-11-16T09:05, never run\. It is now 2026-11-16T09:00\.$/);
      assert.match(turn.scheduleJob({ title: "Watch", what: "x", every_minutes: 5, daily_at: "08:00" }), /^Give exactly one of every_minutes, daily_at and once_at\./);
      assert.match(turn.scheduleJob({ title: "Watch", what: "x", once_at: "2026-11-16T08:00" }), /^That time has passed/);
      return reply("Watching.");
    }
    runs.push([turn.prompt.text, turn.sessionId, turn.keepSession]);
    return turn.prompt.text.startsWith("This is a run of one of your jobs") ? reply(found, "job-session") : reply("ok");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  await say(ME, agent.id, "watch the price");
  await queue.kick(agent.id);
  const bodies = async () => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.map((m: { body: string }) => m.body);

  // Before its time nothing runs. At its time it runs and stays silent.
  time += 4 * 60_000;
  await queue.kick(agent.id);
  assert.equal(runs.length, 0);
  time += 60_000;
  await queue.kick(agent.id);
  assert.equal(runs.length, 1);
  assert.match(runs[0][0], /"Watch" \(Every 5 min\), started by Sidebots' clock[\s\S]*Check the price\. Stay silent unless it dropped\.[\s\S]*reply with only the word SILENT/);
  assert.deepEqual(runs[0].slice(1), [null, false]);
  assert.deepEqual(await bodies(), ["watch the price", "Watching."]);
  const [job] = (await call(ME, "GET", `/agents/${agent.id}/about`)).json.jobs;
  assert.deepEqual([job.what, job.schedule, job.next_at], ["Check the price. Stay silent unless it dropped.", { type: "every", minutes: 5 }, time + 5 * 60_000]);

  // The next run has something to say, which arrives as the agent's message and leaves the chat's session alone.
  time += 5 * 60_000;
  found = "The price dropped to 300.";
  await queue.kick(agent.id);
  assert.deepEqual(await bodies(), ["watch the price", "Watching.", "The price dropped to 300."]);
  assert.equal((await call(ME, "GET", "/agents")).json[0].session_id, "session-1");

  // The chat's session hears what the job sent with the next message.
  await say(ME, agent.id, "buy it");
  await queue.kick(agent.id);
  assert.match(runs[2][0], /They sent Alex these messages[\s\S]*You: The price dropped to 300\.[\s\S]*Alex's new message:\n\nbuy it$/);
  assert.deepEqual(runs[2].slice(1), ["session-1", true]);

  // The person can remove it, and then nothing runs.
  assert.equal((await call(HER, "DELETE", `/agents/${agent.id}/jobs/${job.id}`)).status, 404);
  assert.equal((await call(ME, "DELETE", `/agents/${agent.id}/jobs/${job.id}`)).status, 200);
  time += 60 * 60_000;
  await queue.kick(agent.id);
  assert.equal(runs.length, 3);
});

test("a person starts with an agent that knows it briefs them every morning, has the job for it, and says so first", async (t) => {
  let time = new Date(2026, 10, 16, 21, 0).getTime();
  // The agent and its first message are saved in the same millisecond.
  t.mock.timers.enable({ apis: ["Date"], now: time });
  const runs: string[] = [];
  const { store, queue, call } = setup(async (turn) => {
    runs.push(turn.prompt.text);
    return reply("Standup at 10, and Sam wants an answer on the quote.", "job-session");
  }, () => time);
  const ruby = addFirstAgent(store, store.personByName(ME)!, "08:00", time);

  // It is in the person's list with its first message unread, and its instructions say what it is for.
  const [listed] = (await call(ME, "GET", "/agents")).json;
  assert.deepEqual([listed.name, listed.avatar_id, listed.unread], ["Ruby", "cog", 1]);
  assert.match(listed.latest.body, /^Hi, I'm Ruby\. Every morning at 8/);
  // Under it are the two apps a brief reads, each offered as a card that connects it.
  const offered = (await call(ME, "GET", `/agents/${ruby.id}/messages`)).json.slice(1);
  assert.deepEqual(offered.map((m: { ask: string; question: Question }) => [m.ask, m.question.kind, m.question.what, m.question.connection]), [
    ["waiting", "work", "Connect Google Calendar", "calendar"],
    ["waiting", "work", "Connect Gmail", "gmail"],
  ]);
  // A yes to one is making the connection, as for an agent's own ask for one.
  assert.equal((await call(ME, "POST", `/agents/${ruby.id}/asks/${offered[0].id}`, { allow: true })).status, 409);
  const about = (await call(ME, "GET", `/agents/${ruby.id}/about`)).json;
  assert.match(about.instructions, /You brief Alex every morning/);
  assert.doesNotMatch(about.instructions, /You don't know what you're for yet/);
  assert.deepEqual([about.jobs[0].schedule, about.jobs[0].next_at], [{ type: "daily", time: "08:00" }, new Date(2026, 10, 17, 8, 0).getTime()]);

  // Nothing runs that evening. The next morning its brief arrives.
  await queue.kick(ruby.id);
  assert.equal(runs.length, 0);
  time = new Date(2026, 10, 17, 8, 0).getTime();
  await queue.kick(ruby.id);
  assert.match(runs[0], /"Morning brief" \(Daily at 08:00\)[\s\S]*Brief Alex on their day[\s\S]*offer it with `suggest`/);
  const bodies = (await call(ME, "GET", `/agents/${ruby.id}/messages`)).json.map((m: { body: string }) => m.body);
  assert.equal(bodies.at(-1), "Standup at 10, and Sam wants an answer on the quote.");
  assert.equal(bodies.length, 4);
});

test("the first agent briefs at the time the person chose, or has no brief when they chose none", async () => {
  const now = new Date(2026, 10, 16, 21, 0).getTime();
  const { store, call } = setup(async () => reply("unused", "session"));
  const early = addFirstAgent(store, store.personByName(ME)!, "07:30", now);
  const about = (await call(ME, "GET", `/agents/${early.id}/about`)).json;
  assert.deepEqual([about.jobs[0].schedule, about.jobs[0].next_at], [{ type: "daily", time: "07:30" }, new Date(2026, 10, 17, 7, 30).getTime()]);
  const hello = (await call(ME, "GET", `/agents/${early.id}/messages`)).json[0];
  assert.match(hello.body, /^Hi, I'm Ruby\. Every morning at 7:30 I'll send you a short brief/);

  const plain = addFirstAgent(store, store.personByName("Robin")!, null, now);
  const without = (await call("Robin", "GET", `/agents/${plain.id}/about`)).json;
  assert.deepEqual(without.jobs, []);
  assert.match(without.instructions, /\nYou help Robin with whatever they ask\./);
  const messages = (await call("Robin", "GET", `/agents/${plain.id}/messages`)).json;
  assert.match(messages[0].body, /^Hi, I'm Ruby\. Ask me for anything\./);
  assert.doesNotMatch(messages[0].body, /brief/);
  // The two apps are offered either way.
  assert.deepEqual(messages.slice(1).map((m: Message) => m.question?.connection), ["calendar", "gmail"]);
});

test("connecting an app from the first agent's suggestion starts the agent on what it now sees there", async () => {
  const runs: string[] = [];
  const { store, queue, web, call } = setup(async (turn) => {
    runs.push(turn.prompt.text);
    return reply("Two emails need you.", "work-session");
  });
  google(web, "alex@example.com");
  const ruby = addFirstAgent(store, store.personByName(ME)!);
  const gmail = (await call(ME, "GET", `/agents/${ruby.id}/messages`)).json[2];

  const signIn = (await call(ME, "POST", "/connections/gmail/sign-in")).json as { url: string; redirect: string };
  const made = await call(ME, "PUT", "/connections/gmail", { url: `${signIn.redirect}?state=${new URL(signIn.url).searchParams.get("state")}&code=one-time` });
  assert.equal(made.status, 200);
  await queue.kick(ruby.id);

  const after = (await call(ME, "GET", `/agents/${ruby.id}/messages`)).json.slice(1);
  assert.deepEqual(after.map((m: Message) => [m.question?.what ?? m.body, m.ask, m.status, m.reply_to]), [
    ["Connect Google Calendar", "waiting", "done", null],
    ["Connect Gmail", "allowed", "done", null],
    ["Two emails need you.", null, "done", gmail.id],
  ]);
  assert.match(runs[0], /^Alex started a piece of work you suggested: "Connect Gmail"\.[\s\S]*Gmail is connected now\./);
  assert.equal(runs.length, 1);
});

test("a reply is shown the latest twenty of what the agent's jobs sent that its session hasn't been told of, and told when there were more", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const prompts: string[] = [];
  let posts = 0;
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "watch the price") {
      turn.scheduleJob({ title: "Watch", what: "Say the price.", every_minutes: 5 });
      return reply("Watching.");
    }
    if (turn.prompt.text.startsWith("This is a run of one of your jobs")) return reply(`Post ${++posts}.`, "job-session");
    prompts.push(turn.prompt.text);
    return reply("ok");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  await say(ME, agent.id, "watch the price");
  await queue.kick(agent.id);
  /** Lets the job run so many times, then sends the agent a message. */
  const sayAfter = async (runs: number, text: string) => {
    for (let run = 0; run < runs; run++) {
      time += 5 * 60_000;
      await queue.kick(agent.id);
    }
    await say(ME, agent.id, text);
    await queue.kick(agent.id);
  };
  const shown = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `You: Post ${from + index}.`).join("\n\n");

  // Twenty is all of them.
  await sayAfter(20, "how is it going");
  assert.equal(prompts[0], `Your jobs and the work Alex started run in sessions of their own. They sent Alex these messages, which this session hasn't seen:\n\n${shown(1, 20)}\n\nAlex's new message:\n\nhow is it going`);

  // Of twenty-two since that reply, the first two are left out.
  await sayAfter(22, "buy it");
  assert.equal(
    prompts[1],
    `Your jobs and the work Alex started run in sessions of their own. They sent Alex messages this session hasn't seen. These are the latest 20, and \`search_history\` finds earlier ones by a word or phrase in them:\n\n${shown(23, 42)}\n\nAlex's new message:\n\nbuy it`,
  );
});

test("a job set for one time runs once, a daily one keeps to its days, and a job that keeps failing says so once", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime(); // A Monday.
  let fail = false;
  const { store, queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "set up") {
      turn.scheduleJob({ title: "Watch", what: "Say it is time to call the garage.", once_at: "2026-11-16T17:00" });
      assert.match(turn.scheduleJob({ title: "Watch", what: "Morning brief.", daily_at: "08:00", weekdays: [1, 5] }), /"Watch": Mon, Fri at 08:00, next at 2026-11-20T08:00, never run\./);
      assert.match(turn.listJobs(), /"Watch": Once, 16 Nov at 17:00, next at 2026-11-16T17:00, never run\. Say it is time to call the garage\.[\s\S]*It is now 2026-11-16T09:00\.$/);
      return reply("Done.");
    }
    if (fail) throw new Error("You've reached your usage limit.");
    return reply("Time to call the garage.");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Errands", avatarId: "hop" })).json;
  await say(ME, agent.id, "set up");
  await queue.kick(agent.id);

  time = new Date(2026, 10, 16, 17, 0).getTime();
  await queue.kick(agent.id);
  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.equal(messages.at(-1).body, "Time to call the garage.");
  assert.equal(typeof messages.at(-1).job_id, "string");
  // The job that ran its one time stays, with no run to come.
  const sinceRun = (job: Job) => [job.what, job.next_at, job.last_run_status, job.run_count];
  assert.deepEqual(store.jobs(agent.id).map(sinceRun), [
    ["Morning brief.", new Date(2026, 10, 20, 8, 0).getTime(), "never", 0],
    ["Say it is time to call the garage.", null, "succeeded", 1],
  ]);

  // Friday's run fails, and so does the next Monday's. Sidebots says so once.
  fail = true;
  time = new Date(2026, 10, 20, 8, 0).getTime();
  await queue.kick(agent.id);
  assert.equal(store.jobs(agent.id)[0].next_at, new Date(2026, 10, 23, 8, 0).getTime());
  time = new Date(2026, 10, 23, 8, 0).getTime();
  await queue.kick(agent.id);
  const after = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.map((m: { body: string }) => m.body);
  assert.deepEqual(after.slice(-2), ["Time to call the garage.", "Sidebots couldn't run a job. Your Claude usage limit is reached. Try again once it resets."]);
  const [failed] = store.jobs(agent.id);
  assert.deepEqual([failed.last_run_status, failed.last_run_error, failed.run_count], ["failed", "Your Claude usage limit is reached. Try again once it resets.", 2]);
});

test("the person makes, changes, pauses and runs a job from the app, and the agent does the same with its tools", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime(); // A Monday.
  const runs: string[] = [];
  let jobId = "";
  const { store, queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text.endsWith("pause it, and run it once")) {
      assert.match(turn.scheduleJob({ id: jobId, enabled: false }), /^Saved job \w+, "Water the plants": Every 30 min, paused, last run at 2026-11-16T09:00, succeeded\./);
      assert.match(turn.scheduleJob({ id: "nope", title: "Plants" }), /^No such job\. It is now 2026-11-16T09:00\.$/);
      assert.equal(turn.runJobNow(jobId), "It runs now, in a session of its own, and what it replies goes to the person.");
      return reply("Done.");
    }
    runs.push(turn.prompt.text);
    return reply("Water the plants.", "job-session");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Errands", avatarId: "hop" })).json;
  const jobs = `/agents/${agent.id}/jobs`;
  const plants = { title: "Plants", what: "Remind me to water the plants.", schedule: { type: "daily", time: "18:00", weekdays: [1, 3] } };
  const stands = (job: Job) => ({ title: job.title, enabled: job.enabled, next_at: job.next_at, last_run_status: job.last_run_status, run_count: job.run_count });

  // A job needs a title, what it does and a schedule that can run, and is the agent's person's alone.
  assert.deepEqual((await call(ME, "POST", jobs, { ...plants, title: " " })).json, { error: "Give the job a name." });
  assert.deepEqual((await call(ME, "POST", jobs, { ...plants, schedule: { type: "daily", time: "6pm" } })).json, { error: "Give the time of day as HH:MM on a 24-hour clock." });
  assert.deepEqual((await call(ME, "POST", jobs, { ...plants, schedule: { type: "daily", time: "18:00", weekdays: [] } })).json, { error: "Pick at least one day." });
  assert.equal((await call(HER, "POST", jobs, plants)).status, 404);
  const made = await call(ME, "POST", jobs, plants);
  assert.equal(made.status, 201);
  jobId = made.json.id;
  assert.deepEqual(stands(made.json), { title: "Plants", enabled: true, next_at: new Date(2026, 10, 16, 18, 0).getTime(), last_run_status: "never", run_count: 0 });

  // Run now runs it beside its schedule, which it keeps.
  assert.equal((await call(HER, "POST", `${jobs}/${jobId}/run`)).status, 404);
  assert.equal((await call(ME, "POST", `${jobs}/${jobId}/run`)).status, 200);
  await queue.kick(agent.id);
  assert.match(runs[0], /"Plants" \(Mon, Wed at 18:00\), started now, beside its schedule/);
  assert.deepEqual(stands(store.job(agent.id, jobId)!), { title: "Plants", enabled: true, next_at: new Date(2026, 10, 16, 18, 0).getTime(), last_run_status: "succeeded", run_count: 1 });

  // Paused, it doesn't run at its time, and turned back on it runs at the next.
  assert.equal((await call(ME, "PATCH", `${jobs}/${jobId}`, { enabled: false })).json.enabled, false);
  time = new Date(2026, 10, 16, 18, 0).getTime();
  await queue.kick(agent.id);
  assert.equal(runs.length, 1);
  time = new Date(2026, 10, 16, 18, 30).getTime();
  assert.equal((await call(ME, "PATCH", `${jobs}/${jobId}`, { enabled: true })).json.next_at, new Date(2026, 10, 18, 18, 0).getTime());

  // A new schedule works out its next run again, and new words alone leave it.
  const moved = (await call(ME, "PATCH", `${jobs}/${jobId}`, { schedule: { type: "every", minutes: 30 } })).json;
  assert.equal(moved.next_at, time + 30 * 60_000);
  const renamed = (await call(ME, "PATCH", `${jobs}/${jobId}`, { title: "Water the plants" })).json;
  assert.deepEqual([renamed.title, renamed.what, renamed.next_at], ["Water the plants", plants.what, moved.next_at]);
  assert.equal((await call(ME, "PATCH", `${jobs}/nope`, { title: "x" })).status, 404);

  // The agent pauses it and runs it once with its tools, and a paused job runs when it is asked to.
  time = new Date(2026, 10, 16, 9, 0).getTime();
  await say(ME, agent.id, "pause it, and run it once");
  await queue.kick(agent.id);
  await queue.kick(agent.id);
  assert.equal(runs.length, 2);
  assert.deepEqual(stands(store.job(agent.id, jobId)!), { title: "Water the plants", enabled: false, next_at: moved.next_at, last_run_status: "succeeded", run_count: 2 });

  // A one-time job whose time passed while it was paused can't be turned back on.
  const once = (await call(ME, "POST", jobs, { title: "Garage", what: "Say it is time to call the garage.", schedule: { type: "once", at: time + 60_000 }, enabled: false })).json;
  time += 2 * 60_000;
  assert.deepEqual((await call(ME, "PATCH", `${jobs}/${once.id}`, { enabled: true })).json, { error: "That time has passed. Pick a time still to come." });
});

test("a reply to a message tells the agent which one, and the chat pages back through older messages", async () => {
  const prompts: string[] = [];
  const { store, queue, call, say, app, phoneOf } = setup(async (turn) => {
    prompts.push(turn.prompt.text);
    return reply("The florist is Petal & Co.");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  await say(ME, agent.id, "who is the florist?");
  await queue.kick(agent.id);
  const [, answer] = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;

  const form = new FormData();
  form.append("body", "call them");
  form.append("replyTo", answer.id);
  const sent = await (await app.request(`/agents/${agent.id}/messages`, { method: "POST", headers: phoneOf(ME), body: form })).json();
  assert.equal(sent.reply_to, answer.id);
  await queue.kick(agent.id);
  assert.equal(prompts[1], 'Replying to your message: "The florist is Petal & Co."\n\ncall them');

  for (let count = 0; count < 60; count++) store.addMessage(agent.id, "agent", `note ${count}`, "done");
  const latest = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.equal(latest.length, 50);
  const older = (await call(ME, "GET", `/agents/${agent.id}/messages?before=${latest[0].id}`)).json;
  assert.deepEqual(older.map((m: { body: string }) => m.body).slice(0, 2), ["who is the florist?", "The florist is Petal & Co."]);
  assert.equal(older.length, 14);
});

test("a muted agent notifies nobody, and a hidden one comes back when it has something to say unless it is muted", async () => {
  const { store, queue, call, say, phoneOf, open } = setup(async () => reply("Booked."));
  const sent: Notice[] = [];
  startPush(store, async (_device, notice) => {
    if ("sealed" in notice) sent.push(open(phoneOf(ME), notice));
    return "sent";
  }, 0);
  await call(ME, "PUT", "/push-token", { token: "a".repeat(64), environment: "production" });
  const loud = (await call(ME, "POST", "/agents", { name: "Errands", avatarId: "hop" })).json;
  const quiet = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  await call(ME, "PATCH", `/agents/${loud.id}`, { hidden: true });
  await call(ME, "PATCH", `/agents/${quiet.id}`, { hidden: true, muted: true });

  await say(ME, quiet.id, "book it");
  await queue.kick(quiet.id);
  await say(ME, loud.id, "book it");
  await queue.kick(loud.id);

  await pushed();
  const agents = (await call(ME, "GET", "/agents")).json as { id: string; hidden: boolean; unread: number }[];
  const of = (id: string) => agents.find((agent) => agent.id === id)!;
  assert.deepEqual([of(loud.id).hidden, of(quiet.id).hidden, of(quiet.id).unread], [false, true, 1]);
  assert.deepEqual(sent.map((notice) => [notice.agentId, notice.badge]), [[loud.id, 1]]);
});

test("a message sent while the agent works goes into the turn it is running, and reads as read once the agent takes it in", async () => {
  let release: (() => void) | undefined;
  const prompts: string[] = [];
  const { queue, call, say } = setup(async (turn) => {
    prompts.push(turn.prompt.text);
    await new Promise<void>((resolve) => (release = resolve));
    const [later] = turn.followUps!.take();
    prompts.push(later.text);
    turn.seen([later.id]);
    turn.replied("Booked the band and the florist.", [turn.prompt.id, later.id]);
    return { sessionId: "session-1", contextTokens: 0, cost: 0, tokens: 0 };
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  await say(ME, agent.id, "book the band");
  const working = queue.kick(agent.id);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  const followUp = (await say(ME, agent.id, "and the florist")).json;
  const before = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  release();
  await working;

  const status = (messages: { id: string; status: string; seen_at: number | null }[], id: string) => messages.find((m) => m.id === id);
  assert.deepEqual([status(before, followUp.id)?.status, status(before, followUp.id)?.seen_at], ["queued", null]);
  const after = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    after.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "book the band", "done"],
      ["person", "and the florist", "done"],
      ["agent", "Booked the band and the florist.", "done"],
    ],
  );
  assert.equal(typeof status(after, followUp.id)?.seen_at, "number");
  assert.deepEqual(prompts, ["book the band", "and the florist"]);
});

test("an agent's updates while it works wait a minute, then come no more than every few minutes, and notify nobody; its reply does", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const answers: string[] = [];
  const { store, queue, call, say, phoneOf, open } = setup(async (turn) => {
    answers.push(turn.sendUpdate!("Started."));
    time += 2 * 60_000;
    answers.push(turn.sendUpdate!("Found three flats, checking the third."));
    time += 60_000;
    answers.push(turn.sendUpdate!("Still checking."));
    return reply("Here are the three flats.");
  }, () => time);
  const sent: Notice[] = [];
  startPush(store, async (_device, notice) => {
    if ("sealed" in notice) sent.push(open(phoneOf(ME), notice));
    return "sent";
  }, 0);
  await call(ME, "PUT", "/push-token", { token: "a".repeat(64), environment: "production" });
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  await new Promise((resolve) => setTimeout(resolve, 1));
  await say(ME, agent.id, "find me a flat");
  await queue.kick(agent.id);
  await pushed();

  assert.match(answers[0], /^Too soon/);
  assert.equal(answers[1], "Sent. Carry on with the work.");
  assert.match(answers[2], /^You sent an update moments ago/);
  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; interim: boolean }) => [m.sender, m.body, m.interim]),
    [
      ["person", "find me a flat", false],
      ["agent", "Found three flats, checking the third.", true],
      ["agent", "Here are the three flats.", false],
    ],
  );
  assert.deepEqual(sent.map((notice) => [notice.body, notice.badge]), [["Here are the three flats.", 1]]);
});

test("an agent's files go with its next message, an update or its reply, and open as the person's own do", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const answers: string[] = [];
  const { home, queue, call, say, app, phoneOf } = setup(async (turn) => {
    if (turn.prompt.text !== "chart my week") {
      // A run of the job: a file sent with nothing to say goes nowhere, and one sent with a reply goes with it.
      writeFileSync(join(turn.cwd, "week.png"), "this week");
      turn.sendFiles(["week.png"]);
      return reply(time > new Date(2026, 10, 16, 9, 10).getTime() ? "Your week so far." : "SILENT");
    }
    turn.scheduleJob({ title: "Watch", what: "Chart the week.", every_minutes: 5 });
    writeFileSync(join(turn.cwd, "chart.png"), "first draft");
    writeFileSync(join(home, "Week 47 report.pdf"), "the report");
    answers.push(turn.sendFiles(["chart.png", "missing.png"]));
    answers.push(turn.sendFiles(["chart.png"]));
    // What is sent is the file as it was when the agent named it, whatever becomes of it after.
    writeFileSync(join(turn.cwd, "chart.png"), "final");
    time += 2 * 60_000;
    turn.sendUpdate!("Here is the chart so far.");
    answers.push(turn.sendFiles(["chart.png", join(home, "Week 47 report.pdf")]));
    // Files that would take the message past what it can carry are left out, and the ones already added stay.
    writeFileSync(join(turn.cwd, "film.mov"), "");
    truncateSync(join(turn.cwd, "film.mov"), MESSAGE_BYTES);
    answers.push(turn.sendFiles(["film.mov"]));
    // A file is sized before it is read, so one too large to read at all is left out the same way.
    truncateSync(join(turn.cwd, "film.mov"), 3 * 1024 ** 3);
    answers.push(turn.sendFiles(["film.mov"]));
    return reply("Both are here.");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  await say(ME, agent.id, "chart my week");
  await queue.kick(agent.id);
  for (const minutes of [5, 10]) {
    time += minutes * 60_000;
    await queue.kick(agent.id);
  }

  assert.deepEqual(answers, [
    "There is no file at missing.png. Nothing was added, so give the paths again.",
    "Added. They go with the next message you send.",
    "Added. They go with the next message you send.",
    "A message carries up to 95 MB of files. Nothing was added, so send fewer or smaller ones.",
    "A message carries up to 95 MB of files. Nothing was added, so send fewer or smaller ones.",
  ]);
  const [, update, answer, fromJob, ...rest] = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json as { body: string; attachments: string[] }[];
  assert.deepEqual(rest, []);
  const names = (message: { attachments: string[] }) => message.attachments.map((path) => path.replace(/^attachments\/[0-9a-f]{8}-/, ""));
  assert.deepEqual([update.body, names(update)], ["Here is the chart so far.", ["chart.png"]]);
  assert.deepEqual([answer.body, names(answer)], ["Both are here.", ["chart.png", "Week-47-report.pdf"]]);
  assert.deepEqual([fromJob.body, names(fromJob)], ["Your week so far.", ["week.png"]]);

  const open = async (path: string) => app.request(`/agents/${agent.id}/${path}`, { headers: phoneOf(ME) });
  assert.equal(await (await open(update.attachments[0])).text(), "first draft");
  assert.equal(await (await open(answer.attachments[0])).text(), "final");
  assert.equal(await (await open(answer.attachments[1])).text(), "the report");
});

test("a job's run can't send updates", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const updates: boolean[] = [];
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "set up") turn.scheduleJob({ title: "Watch", what: "Check.", every_minutes: 5 });
    else updates.push(turn.sendUpdate !== undefined);
    return reply("SILENT");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  await say(ME, agent.id, "set up");
  await queue.kick(agent.id);
  time += 5 * 60_000;
  await queue.kick(agent.id);
  assert.deepEqual(updates, [false]);
});

test("an agent asks before it does what its provider won't decide, waits for the person's answer, and goes on by it", async () => {
  // Longer than a notification shows, with its end the part that matters.
  const long = `echo ${"a".repeat(3000)} && rm -rf ~/Downloads`;
  const answers: string[] = [];
  const { store, queue, call, say, phoneOf, open } = setup(async (turn) => {
    const question = turn.prompt.text === "and the downloads" ? command(long) : command("rm -rf ~/old", "It deletes\na folder.");
    const answer = await turn.ask(question, new AbortController().signal);
    answers.push(answer.allowed ? "allowed" : answer.words);
    return reply(answer.allowed ? "Deleted." : "Left it.");
  });
  const sent: Notice[] = [];
  startPush(store, async (_device, notice) => {
    if ("sealed" in notice) sent.push(open(phoneOf(ME), notice));
    return "sent";
  }, 0);
  await call(ME, "PUT", "/push-token", { token: "a".repeat(64), environment: "production" });
  const agent = (await call(ME, "POST", "/agents", { name: "Tidy", avatarId: "mochi" })).json;
  await new Promise((resolve) => setTimeout(resolve, 1));
  const chat = async () => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json as Message[];

  await say(ME, agent.id, "clear out the old folder");
  await pushed();
  const first = (await chat()).at(-1)!;
  assert.deepEqual([first.sender, first.ask, first.body], ["agent", "waiting", "Run a command: Clear the old folder\n\n```\nrm -rf ~/old\n```\n\n> It deletes a folder."]);
  // The phone draws the card from the question's parts.
  assert.deepEqual(first.question, command("rm -rf ~/old", "It deletes\na folder."));
  // The agent is still at work, and its ask is something to read.
  const [row] = (await call(ME, "GET", "/agents")).json;
  assert.deepEqual([row.working, row.unread], [true, 1]);
  assert.equal((await call(HER, "POST", `/agents/${agent.id}/asks/${first.id}`, { allow: true })).status, 404);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${first.id}`, {})).status, 400);
  const allowed = await call(ME, "POST", `/agents/${agent.id}/asks/${first.id}`, { allow: true });
  assert.deepEqual([allowed.status, allowed.json.ask], [200, "allowed"]);
  // An ask takes one answer.
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${first.id}`, { allow: false })).status, 409);
  await queue.kick(agent.id);
  await pushed();

  await say(ME, agent.id, "and the downloads");
  await pushed();
  const second = (await chat()).at(-1)!;
  // The chat shows all of what Allow would let happen.
  assert.equal(second.body, `Run a command: Clear the old folder\n\n\`\`\`\n${long}\n\`\`\``);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${second.id}`, { allow: false })).json.ask, "refused");
  await queue.kick(agent.id);
  await pushed();

  assert.equal(answers[0], "allowed");
  assert.match(answers[1], /^Alex said no to this\./);
  assert.deepEqual(
    (await chat()).map((message) => [message.sender, message.body.split("\n")[0], message.ask]),
    [
      ["person", "clear out the old folder", null],
      ["agent", "Run a command: Clear the old folder", "allowed"],
      ["agent", "Deleted.", null],
      ["person", "and the downloads", null],
      ["agent", "Run a command: Clear the old folder", "refused"],
      ["agent", "Left it.", null],
    ],
  );
  // The ask notifies the phone as a reply does, in its plain words. Its answer notifies nobody.
  assert.deepEqual(sent.map((notice) => notice.body.slice(0, 60)), ["Run a command: Clear the old folder", "Deleted.", "Run a command: Clear the old folder", "Left it."]);
});

test("an ask closes unanswered when the person sends a message instead, takes too long, or the turn ends, and a restart closes the ones it left", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answers: string[] = [];
  const withdrawn = new AbortController();
  const { store, queue, call, say } = setup(async (turn) => {
    const later: string[] = [];
    turn.followUps!.onArrival(() => later.push(...turn.followUps!.take().map((each) => each.id)));
    const asking = turn.ask(command("make clean"), withdrawn.signal);
    if (turn.prompt.text === "and crash") throw new Error("Claude Code stopped.");
    const answer = await asking;
    answers.push(answer.allowed ? "allowed" : answer.words);
    turn.seen(later);
    turn.replied("Done.", [turn.prompt.id, ...later]);
    return { sessionId: "session-1", contextTokens: 0, cost: 0, tokens: 0 };
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Tidy", avatarId: "mochi" })).json;
  const chat = async () => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json as { id: string; ask: string | null }[];
  const asks = async () => (await chat()).flatMap((message) => message.ask ?? []);

  await say(ME, agent.id, "tidy up");
  assert.deepEqual(await asks(), ["waiting"]);
  await say(ME, agent.id, "wait, not the build folder");
  await queue.kick(agent.id);

  await say(ME, agent.id, "tidy up again");
  assert.deepEqual(await asks(), ["unanswered", "waiting"]);
  t.mock.timers.tick(30 * 60_000);
  await queue.kick(agent.id);

  // This turn ends with its ask still waiting.
  await say(ME, agent.id, "and crash");
  await queue.kick(agent.id);

  // Claude Code takes this one back.
  await say(ME, agent.id, "once more");
  assert.deepEqual(await asks(), ["unanswered", "unanswered", "unanswered", "waiting"]);
  withdrawn.abort();
  await queue.kick(agent.id);

  assert.match(answers[0], /^Alex sent a message instead of answering\./);
  assert.match(answers[1], /^Alex didn't answer in time\./);
  assert.deepEqual(await asks(), ["unanswered", "unanswered", "unanswered", "unanswered"]);
  // Nothing is left for an answer to reach.
  const last = (await chat()).findLast((message) => message.ask)!;
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${last.id}`, { allow: true })).status, 409);

  // A server that stops mid-turn leaves its ask waiting, and the next start closes it.
  store.addMessage(agent.id, "agent", "Can I run this command?", "done", { ask: "waiting" });
  store.requeueInterrupted();
  assert.deepEqual((await asks()).at(-1), "unanswered");
});

test("the switch notice a server leaves when it stops mid hand-over is done with, and not taken for a fresh start", async () => {
  const { store, queue, call, say } = setup(async () => reply("sure"));
  const agent = (await call(ME, "POST", "/agents", { name: "Tony", avatarId: "mochi" })).json;
  const opus = { provider: "claude", model: "opus", effort: "medium", fast: false } as const;
  const sol = { provider: "codex", model: "sol", effort: "medium", fast: false } as const;
  store.addMessage(agent.id, "sidebots", "Switched from Claude Opus 5.5 Medium to GPT-6.2 Sol Medium", "running", { switched: { from: opus, to: sol } });
  store.requeueInterrupted();
  assert.equal(store.nextQueued(agent.id), undefined);
  await say(ME, agent.id, "hi");
  await queue.kick(agent.id);
  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]);
  assert.deepEqual(messages, [
    ["sidebots", "Switched from Claude Opus 5.5 Medium to GPT-6.2 Sol Medium", "done"],
    ["person", "hi", "done"],
    ["agent", "sure", "done"],
  ]);
});

/** A turn that works until it is stopped, as a provider's does: it then ends with no reply, in the session it had. */
const untilStopped = (turn: Turn, sessionId = "session-1") =>
  new Promise<Answer>((resolve) => turn.stop.signal.addEventListener("abort", () => resolve({ sessionId, contextTokens: 0, cost: 0, tokens: 0 })));

test("stopping an agent ends the turn it is running, says so in the chat, and the next message carries on in the same session", async () => {
  const turns: Turn[] = [];
  const { store, queue, call, say, phoneOf, open } = setup(async (turn) => {
    turns.push(turn);
    return turn.prompt.text === "book the band" ? untilStopped(turn) : reply("Carrying on.");
  });
  const sent: Notice[] = [];
  startPush(store, async (_device, notice) => {
    if ("sealed" in notice) sent.push(open(phoneOf(ME), notice));
    return "sent";
  }, 0);
  await call(ME, "PUT", "/push-token", { token: "a".repeat(64), environment: "production" });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  const shown = async () => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]);

  // With nothing running there is nothing to stop, and nothing is said.
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/stop`)).status, 200);
  assert.deepEqual(await shown(), []);

  await say(ME, agent.id, "book the band");
  const working = queue.kick(agent.id);
  assert.equal((await call(HER, "POST", `/agents/${agent.id}/stop`)).status, 404);
  assert.equal(turns[0].stop.signal.aborted, false);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/stop`)).status, 200);
  await working;

  assert.deepEqual(await shown(), [
    ["person", "book the band", "done"],
    ["sidebots", "Stopped", "done"],
  ]);
  // The agent rests, with the session the stopped turn was in. Stopping it is nothing to read or be told of.
  const [stopped] = (await call(ME, "GET", "/agents")).json;
  assert.deepEqual([stopped.working, stopped.session_id, stopped.unread], [false, "session-1", 0]);
  await pushed();
  assert.deepEqual(sent, []);

  await say(ME, agent.id, "carry on");
  await queue.kick(agent.id);
  assert.deepEqual([turns[1].sessionId, turns[1].prompt.text], ["session-1", "carry on"]);
  assert.deepEqual((await shown()).slice(-2), [
    ["person", "carry on", "done"],
    ["agent", "Carrying on.", "done"],
  ]);
});

test("a stopped turn leaves what the agent never read to send again, and a message sent after the stop gets its own turn", async () => {
  const turns: Turn[] = [];
  let read: (() => void) | undefined;
  let end: (() => void) | undefined;
  const { queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    if (turns.length > 1) return reply("On it.");
    // The agent reads the first follow-up at a pause, then works on. Like a provider, the turn takes what is sent into it until it is stopped, and then takes a moment to end, in which it reports one more message read.
    await new Promise<void>((resolve) => (read = resolve));
    turn.seen(turn.followUps!.take().map((each) => each.id));
    const taken: { id: string; text: string }[] = [];
    const stopTaking = turn.followUps!.onArrival(() => taken.push(...turn.followUps!.take()));
    await new Promise<void>((resolve) => turn.stop.signal.addEventListener("abort", () => resolve()));
    stopTaking();
    turn.seen(taken.filter((each) => each.text === "and a DJ").map((each) => each.id));
    await new Promise<void>((resolve) => (end = resolve));
    return { sessionId: "session-1", contextTokens: 0, cost: 0, tokens: 0 };
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  await say(ME, agent.id, "book the band");
  const working = queue.kick(agent.id);
  await say(ME, agent.id, "and the florist");
  read!();
  await say(ME, agent.id, "and a cake");
  await say(ME, agent.id, "and a DJ");
  await call(ME, "POST", `/agents/${agent.id}/stop`);
  await say(ME, agent.id, "only the band, after all");
  end!();
  await working;

  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "book the band", "done"],
      ["person", "and the florist", "done"],
      ["person", "and a cake", "failed"],
      ["person", "and a DJ", "done"],
      ["person", "only the band, after all", "done"],
      ["sidebots", "Stopped", "done"],
      ["agent", "On it.", "done"],
    ],
  );
  assert.deepEqual([turns.length, turns[1].prompt.text, turns[1].sessionId], [2, "only the band, after all", "session-1"]);
});

test("a job runs beside the chat, so a message sent meanwhile has its turn, and removing the job stops its run", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const runs: Turn[] = [];
  const { store, queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "watch the price") {
      turn.scheduleJob({ title: "Watch", what: "Check the price.", every_minutes: 5 });
      return reply("Watching.");
    }
    if (!turn.prompt.text.startsWith("This is a run of one of your jobs")) return reply("Not yet.");
    runs.push(turn);
    return untilStopped(turn, "job-session");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  await say(ME, agent.id, "watch the price");
  await queue.kick(agent.id);

  time += 5 * 60_000;
  const running = queue.kick(agent.id);
  await say(ME, agent.id, "any drop yet?");
  await pushed();
  // The chat had its turn while the job's run goes on, and stopping the chat leaves the run alone.
  const bodies = async () => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]);
  assert.deepEqual(await bodies(), [
    ["person", "watch the price", "done"],
    ["agent", "Watching.", "done"],
    ["person", "any drop yet?", "done"],
    ["agent", "Not yet.", "done"],
  ]);
  await call(ME, "POST", `/agents/${agent.id}/stop`);
  assert.equal(runs[0].stop.signal.aborted, false);

  time += 60_000;
  const [job] = store.jobs(agent.id);
  assert.equal((await call(ME, "DELETE", `/agents/${agent.id}/jobs/${job.id}`)).status, 200);
  await running;
  assert.equal(runs[0].stop.signal.aborted, true);
  assert.equal((await bodies()).length, 4);
  assert.deepEqual(store.jobs(agent.id), []);
  // The chat's session is the one it had.
  assert.equal((await call(ME, "GET", "/agents")).json[0].session_id, "session-1");
});

test("an agent offers work as suggestions under its reply, which tell nobody by themselves, and its next ones take the place of those left unanswered", async () => {
  const { store, queue, call, say, phoneOf, open } = setup(async (turn) => {
    if (turn.prompt.text === "what's on today?") {
      assert.match(turn.suggest({ title: "Reply to the plumber's quote", why: "Marlow Plumbing asked for an answer by Friday.", what: "Draft a yes to the quote." }), /^Offered\. It goes to Alex as a card under your reply\./);
      assert.match(turn.suggest({ title: "Renew the car insurance", why: "It runs out on 3 December.", what: "Compare three quotes." }), /^Offered\./);
      assert.equal(turn.suggest({ title: " ", why: "", what: "Something." }), "A suggestion needs a title and what you will do.");
      assert.match(turn.suggest({ title: "Book the dentist", why: "", what: "Find a slot next week." }), /^Offered\./);
      assert.equal(turn.suggest({ title: "A fourth", why: "", what: "Something." }), "3 is the most to suggest at once. Keep the ones that matter most.");
      return reply("The dentist at 11:30, and two emails need a reply.");
    }
    turn.suggest({ title: "Water the plants", why: "", what: "Remind Alex this evening." });
    return reply("Nothing new.");
  });
  const sent: Notice[] = [];
  startPush(store, async (_device, notice) => {
    if ("sealed" in notice) sent.push(open(phoneOf(ME), notice));
    return "sent";
  }, 0);
  await call(ME, "PUT", "/push-token", { token: "a".repeat(64), environment: "production" });
  const agent = (await call(ME, "POST", "/agents", { name: "Ruby", avatarId: "cog" })).json;
  type Said = { id: string; body: string; ask: string | null; interim: boolean; status: string; question: Question | null };
  const chat = async (): Promise<Said[]> => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;

  await say(ME, agent.id, "what's on today?");
  await queue.kick(agent.id);
  await pushed();
  const first = await chat();
  // The reply comes first, and what the agent offered follows it.
  assert.deepEqual(first.map((m) => [m.body.split("\n")[0], m.ask, m.interim]), [
    ["what's on today?", null, false],
    ["The dentist at 11:30, and two emails need a reply.", null, false],
    ["Suggestion: Reply to the plumber's quote", "waiting", true],
    ["Suggestion: Renew the car insurance", "waiting", true],
    ["Suggestion: Book the dentist", "waiting", true],
  ]);
  assert.deepEqual(first[2].question, { kind: "work", title: "Suggestion", what: "Reply to the plumber's quote", facts: [], detail: "Draft a yes to the quote.", why: "Marlow Plumbing asked for an answer by Friday." });
  assert.deepEqual(first[4].question, { kind: "work", title: "Suggestion", what: "Book the dentist", facts: [], detail: "Find a slot next week." });
  // Only the reply notified the person, and only it is unread.
  assert.deepEqual(sent.map((notice) => notice.body), ["The dentist at 11:30, and two emails need a reply."]);
  const [shown] = (await call(ME, "GET", "/agents")).json;
  assert.deepEqual([shown.unread, shown.working, shown.work], [1, false, []]);

  // Not now, which only the person the agent belongs to can say.
  assert.equal((await call(HER, "POST", `/agents/${agent.id}/asks/${first[3].id}`, { allow: false })).status, 404);
  const refused = await call(ME, "POST", `/agents/${agent.id}/asks/${first[3].id}`, { allow: false });
  assert.deepEqual([refused.status, refused.json.ask, refused.json.status], [200, "refused", "done"]);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${first[3].id}`, { allow: true })).status, 409);

  await say(ME, agent.id, "anything else?");
  await queue.kick(agent.id);
  assert.deepEqual((await chat()).filter((m) => m.question).map((m) => [m.question!.what, m.ask]), [
    ["Reply to the plumber's quote", "unanswered"],
    ["Renew the car insurance", "refused"],
    ["Book the dentist", "unanswered"],
    ["Water the plants", "waiting"],
  ]);
  // One that gave way can no longer be started.
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${first[2].id}`, { allow: true })).status, 409);
});

test("work the person starts from a suggestion runs beside the chat, in a session of its own, and its reply answers the suggestion", async () => {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve));
  const turns: [string, string | null, boolean, boolean][] = [];
  const { queue, call, say } = setup(async (turn) => {
    turns.push([turn.prompt.text, turn.sessionId, turn.keepSession, turn.followUps !== undefined]);
    if (turn.prompt.text === "what's on today?") {
      turn.suggest({ title: "Reply to the plumber's quote", why: "Marlow Plumbing asked for an answer by Friday.", what: "Draft a yes to the quote." });
      return reply("Two emails need a reply.");
    }
    if (turn.prompt.text.includes("started a piece of work you suggested")) {
      await held;
      turn.suggest({ title: "Book the plumber's visit", why: "The quote is accepted.", what: "Offer Thursday morning." });
      return reply("The draft is ready.", "work-session");
    }
    return reply(turn.prompt.text.endsWith("send it") ? "Sent." : "Dinner is at 7.");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Ruby", avatarId: "cog" })).json;
  type Said = { id: string; body: string; ask: string | null; status: string; reply_to: string | null; job_id: string | null; interim: boolean };
  const chat = async (): Promise<Said[]> => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  const shown = async () => (await call(ME, "GET", "/agents")).json[0];
  await say(ME, agent.id, "what's on today?");
  await queue.kick(agent.id);
  const card = (await chat())[2];

  const started = await call(ME, "POST", `/agents/${agent.id}/asks/${card.id}`, { allow: true });
  assert.deepEqual([started.status, started.json.ask, started.json.status], [200, "allowed", "running"]);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${card.id}`, { allow: true })).status, 409);

  // While its run goes on, the chat is free: the agent answers there, and counts as at work beside it.
  await say(ME, agent.id, "what time is dinner?");
  await pushed();
  assert.deepEqual((await chat()).slice(3).map((m) => m.body), ["what time is dinner?", "Dinner is at 7."]);
  let agentNow = await shown();
  assert.deepEqual([agentNow.working, agentNow.work.map((work: Said) => [work.id, work.status])], [false, [[card.id, "running"]]]);
  assert.equal((await call(ME, "PUT", `/agents/${agent.id}/activity-token`, { token: "b".repeat(128), environment: "production" })).status, 200);

  finish();
  await queue.kick(agent.id);
  const after = await chat();
  // What the run replied answers the suggestion, and what it offered next follows.
  assert.deepEqual(after.slice(5).map((m) => [m.body.split("\n")[0], m.reply_to, m.job_id, m.interim]), [
    ["The draft is ready.", card.id, card.id, false],
    ["Suggestion: Book the plumber's visit", null, card.id, true],
  ]);
  assert.equal(after[2].status, "done");
  agentNow = await shown();
  assert.deepEqual([agentNow.work, agentNow.session_id, agentNow.unread], [[], "session-1", 3]);
  // The run was given what the agent wrote for it, in a session of its own that nobody talks to.
  const run = turns.find(([text]) => text.includes("started a piece of work you suggested"))!;
  assert.match(run[0], /^Alex started a piece of work you suggested: "Reply to the plumber's quote"\. You offered it because: Marlow Plumbing asked for an answer by Friday\. What you wrote for it:\n\nDraft a yes to the quote\.\n\nDo it now\./);
  assert.deepEqual(run.slice(1), [null, false, false]);
  assert.deepEqual((await call(ME, "GET", `/agents/${agent.id}/about`)).json.work.map((work: Said) => [work.id, work.status]), [[card.id, "done"]]);

  // The chat's session hears what the run sent with the next message, though it replied in between, and hears it once.
  await say(ME, agent.id, "send it");
  await queue.kick(agent.id);
  assert.match(turns.at(-1)![0], /^Your jobs and the work Alex started run in sessions of their own\. They sent Alex these messages, which this session hasn't seen:\n\nYou: The draft is ready\.\n\nYou: Suggestion: Book the plumber's visit[\s\S]*Alex's new message:\n\nsend it$/);
  assert.deepEqual(turns.at(-1)!.slice(1), ["session-1", true, true]);
  await say(ME, agent.id, "thanks");
  await queue.kick(agent.id);
  assert.equal(turns.at(-1)![0], "thanks");
});

test("work started as the agent's own lane finds nothing to do still runs", async () => {
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text !== "plan the week") return reply("Chased.", "work-session");
    turn.suggest({ title: "Chase the invoice", why: "", what: "Chase it." });
    return reply("One thing.");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Ruby", avatarId: "cog" })).json;
  await say(ME, agent.id, "plan the week");
  await queue.kick(agent.id);
  const card = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json[2];

  // A kick finds the lane with nothing to do, and the start comes before the lane has let go.
  const idle = queue.kick(agent.id);
  assert.equal(queue.answer(agent.id, card.id, true), true);
  await idle;
  const after = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual([after[2].status, after.at(-1).body, after.at(-1).reply_to], ["done", "Chased.", card.id]);
});

test("work that fails says so, an ask it raises answers its suggestion and outlasts the chat's turns, and a no to work that was started stops it", async () => {
  const runs: Turn[] = [];
  let fails = true;
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "plan the week") {
      for (const title of ["Chase the invoice", "Tidy the inbox", "Book the van"]) turn.suggest({ title, why: "", what: `${title}.` });
      return reply("Three things.");
    }
    if (!turn.prompt.text.includes("started a piece of work you suggested")) return reply("ok");
    if (fails) throw new Error("The provider is down.");
    runs.push(turn);
    if (turn.prompt.text.includes('"Tidy the inbox"')) {
      const answer = await turn.ask(command("rm -rf ~/old"), turn.stop.signal);
      return reply(answer.allowed ? "Tidied." : "Left as it was.", "work-session");
    }
    return untilStopped(turn, "work-session");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Ruby", avatarId: "cog" })).json;
  type Said = { id: string; sender: string; body: string; ask: string | null; status: string; reply_to: string | null };
  const chat = async (): Promise<Said[]> => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  const answer = (id: string, allow: boolean) => call(ME, "POST", `/agents/${agent.id}/asks/${id}`, { allow });
  await say(ME, agent.id, "plan the week");
  await queue.kick(agent.id);
  const [invoice, inbox, van] = (await chat()).slice(2);

  // A run that fails leaves the work failed, and the chat says why.
  await answer(invoice.id, true);
  await queue.kick(agent.id);
  let now = await chat();
  assert.deepEqual([now[2].ask, now[2].status], ["allowed", "failed"]);
  assert.deepEqual([now.at(-1)!.sender, now.at(-1)!.body, now.at(-1)!.status], ["sidebots", 'Sidebots couldn\'t finish "Chase the invoice". The provider is down.', "failed"]);

  // An ask the run raises answers its suggestion. A message in the chat has its own turn, and doesn't close it.
  fails = false;
  await answer(inbox.id, true);
  await pushed();
  const asked = (await chat()).at(-1)!;
  assert.deepEqual([asked.ask, asked.reply_to], ["waiting", inbox.id]);
  await say(ME, agent.id, "how is it going?");
  await pushed();
  assert.deepEqual((await chat()).slice(-2).map((m) => m.body), ["how is it going?", "ok"]);
  assert.equal((await chat()).find((m) => m.id === asked.id)!.ask, "waiting");

  // Work that waits for its run leaves the line on a no, and a no to the one that runs stops it.
  await answer(van.id, true);
  assert.equal((await chat()).find((m) => m.id === van.id)!.status, "queued");
  assert.deepEqual([(await answer(van.id, false)).status, (await chat()).find((m) => m.id === van.id)!.status], [200, "failed"]);
  assert.equal((await answer(van.id, false)).status, 409);
  // The answer says the work is over at once, before its run has ended.
  const stopped = await answer(inbox.id, false);
  assert.deepEqual([stopped.status, stopped.json.status], [200, "failed"]);
  await queue.kick(agent.id);
  now = await chat();
  assert.deepEqual([runs.length, runs[0].stop.signal.aborted], [1, true]);
  assert.deepEqual([now.find((m) => m.id === inbox.id)!.status, now.find((m) => m.id === asked.id)!.ask], ["failed", "unanswered"]);
  // Nothing was sent for the stopped run, and the agent has no work left.
  assert.deepEqual(now.slice(-2).map((m) => m.body), ["how is it going?", "ok"]);
  assert.deepEqual((await call(ME, "GET", "/agents")).json[0].work, []);
});

test("stopping a fresh start calls it off, and the agent keeps its session", async () => {
  const turns: Turn[] = [];
  const { queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    return turn.prompt.text.startsWith("This session is about to be replaced") ? untilStopped(turn) : reply("sure");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  await say(ME, agent.id, "book the band");
  await queue.kick(agent.id);

  await call(ME, "POST", `/agents/${agent.id}/fresh-start`);
  await call(ME, "POST", `/agents/${agent.id}/stop`);
  await say(ME, agent.id, "any news?");
  await queue.kick(agent.id);

  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "book the band", "done"],
      ["agent", "sure", "done"],
      ["sidebots", "Fresh start", "done"],
      ["sidebots", "Stopped", "done"],
      ["person", "any news?", "done"],
      ["agent", "sure", "done"],
    ],
  );
  assert.deepEqual([turns[2].sessionId, turns[2].prompt.text], ["session-1", "any news?"]);
});

test("deleting an agent stops the turn it is running, and runs nothing that waited for it", async () => {
  const turns: Turn[] = [];
  const { store, queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    return untilStopped(turn);
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  await call(ME, "POST", `/agents/${agent.id}/fresh-start`);
  const working = queue.kick(agent.id);
  await say(ME, agent.id, "find me a flat");
  const said: string[] = [];
  store.onChange((change) => "message" in change && said.push(change.message.body));

  assert.equal((await call(ME, "DELETE", `/agents/${agent.id}`)).status, 200);
  await working;
  assert.deepEqual([turns.length, said], [1, []]);
  assert.deepEqual((await call(ME, "GET", "/agents")).json, []);
});

test("a message the agent never answered is sent again as it was, with its file and the message it answers", async () => {
  const prompts: string[] = [];
  const { queue, call, app, phoneOf } = setup(async (turn) => {
    prompts.push(turn.prompt.text);
    if (prompts.length === 2) throw new Error("Signed out.");
    return reply("It is a receipt.");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Maya", avatarId: "moss" })).json;
  const first = (await call(ME, "POST", `/agents/${agent.id}/messages`, { body: "what is this?" })).json;
  await queue.kick(agent.id);
  const [, answer] = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;

  // A photo with no words, in answer to the agent's reply, in a turn that fails.
  const form = new FormData();
  form.append("body", "");
  form.append("replyTo", answer.id);
  form.append("files", new File(["jpeg bytes"], "IMG_0042.jpg", { type: "image/jpeg" }));
  const photo = await (await app.request(`/agents/${agent.id}/messages`, { method: "POST", headers: phoneOf(ME), body: form })).json();
  await queue.kick(agent.id);
  const status = async () => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.find((m: { id: string }) => m.id === photo.id).status;
  assert.equal(await status(), "failed");

  assert.equal((await call(HER, "POST", `/agents/${agent.id}/messages/${photo.id}/resend`)).status, 404);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/messages/${first.id}/resend`)).status, 404);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/messages/${photo.id}/resend`)).status, 200);
  await queue.kick(agent.id);

  assert.equal(await status(), "done");
  assert.ok(prompts[2].startsWith('Replying to your message: "It is a receipt."') && prompts[2].endsWith(`Sent with this message: ${photo.attachments[0]}`));
  assert.equal(prompts[2], prompts[1]);
});

test("a stop that lands as the last reply comes in says nothing, unless a message of the person's was still unread", async () => {
  let end: (() => void) | undefined;
  let turns = 0;
  // Each turn replies, then takes a moment to end, in which it takes no more messages.
  const { queue, call, say } = setup(async (turn) => {
    turns++;
    turn.replied("Booked.", [turn.prompt.id]);
    await new Promise<void>((resolve) => (end = resolve));
    return { sessionId: "session-1", contextTokens: 0, cost: 0, tokens: 0 };
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  const shown = async () => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]);

  await say(ME, agent.id, "book the band");
  let working = queue.kick(agent.id);
  await call(ME, "POST", `/agents/${agent.id}/stop`);
  end!();
  await working;
  const replied = [
    ["person", "book the band", "done"],
    ["agent", "Booked.", "done"],
  ];
  assert.deepEqual(await shown(), replied);

  await say(ME, agent.id, "and the florist");
  working = queue.kick(agent.id);
  await say(ME, agent.id, "and a cake");
  await call(ME, "POST", `/agents/${agent.id}/stop`);
  end!();
  await working;
  assert.deepEqual(await shown(), [
    ...replied,
    ["person", "and the florist", "done"],
    ["agent", "Booked.", "done"],
    ["person", "and a cake", "failed"],
    ["sidebots", "Stopped", "done"],
  ]);
  assert.equal(turns, 2);
});

test("stopping a turn that waits on an ask closes the ask, and the turn is counted with what it cost", async () => {
  const answers: string[] = [];
  const { queue, call, say } = setup(async (turn) => {
    void turn.ask(command("rm -rf ~/old"), new AbortController().signal).then((answer) => answers.push(answer.allowed ? "allowed" : answer.words));
    return { ...(await untilStopped(turn)), cost: 0.5 };
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Tidy", avatarId: "mochi" })).json;
  const chat = async () => (await call(ME, "GET", `/agents/${agent.id}/messages`)).json as { id: string; sender: string; body: string; status: string; ask: string | null }[];

  await say(ME, agent.id, "clear out the old folder");
  const ask = (await chat()).at(-1)!;
  assert.equal(ask.ask, "waiting");
  await call(ME, "POST", `/agents/${agent.id}/stop`);
  await queue.kick(agent.id);

  assert.deepEqual(
    (await chat()).map((message) => [message.sender, message.body.split("\n")[0], message.status, message.ask]),
    [
      ["person", "clear out the old folder", "done", null],
      ["agent", "Run a command: Clear the old folder", "done", "unanswered"],
      ["sidebots", "Stopped", "done", null],
    ],
  );
  assert.deepEqual(answers, ["The turn ended."]);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${ask.id}`, { allow: true })).status, 409);
  assert.equal((await call(ME, "GET", "/agents")).json[0].working, false);
  const used = (await call(ME, "GET", "/usage")).json.used.map((each: { kind: string; turns: number; cost: number }) => [each.kind, each.turns, each.cost]);
  assert.deepEqual(used, [["reply", 1, 0.5]]);
});

/** Two of Alex's agents, and a fake provider that is handed each turn with whether it is Cog's. */
async function twoAgents(answer: (turn: Turn, cogs: boolean) => Promise<Answer>, starts?: (turn: Turn, cogs: boolean) => Promise<void>) {
  let cogId = "";
  const cogs = (turn: Turn) => turn.cwd.endsWith(cogId);
  const sidebots = setup((turn) => answer(turn, cogs(turn)), Date.now, starts && ((turn) => starts(turn, cogs(turn))));
  const mochi = (await sidebots.call(ME, "POST", "/agents", { name: "Mochi", avatarId: "mochi" })).json as { id: string };
  const cog = (await sidebots.call(ME, "POST", "/agents", { name: "Cog", avatarId: "cog" })).json as { id: string };
  cogId = cog.id;
  const chat = async (agentId: string) => (await sidebots.call(ME, "GET", `/agents/${agentId}/messages`)).json as Message[];
  const rows = async () => Object.fromEntries(((await sidebots.call(ME, "GET", "/agents")).json as AgentWithLatest[]).map((row) => [row.name, row]));
  return { ...sidebots, mochi, cog, chat, rows };
}

test("an agent asks another, which answers in a turn of its own, and the first tells the person once it has heard", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const prompts: string[] = [];
  const { store, queue, call, say, phoneOf, open, mochi, cog, chat, rows } = await twoAgents(async (turn, cogs) => {
    prompts.push(turn.prompt.text);
    if (turn.prompt.text === "is my bike sorted?") {
      assert.equal(turn.listAgents(), "Cog");
      assert.equal(turn.askAgent("Nobody", "hello"), "Alex has no other agent called Nobody. Their other agents: Cog.");
      assert.match(turn.askAgent("cog", " What did the shop quote? "), /^Sent to Cog\. Its answer will come to you as a message/);
      return reply("I've asked Cog.");
    }
    if (!cogs) return reply("It's sorted: £85.");
    await held;
    return reply("They quoted £85.", "session-cog");
  });
  const sent: Notice[] = [];
  startPush(store, async (_device, notice) => {
    if ("sealed" in notice) sent.push(open(phoneOf(ME), notice));
    return "sent";
  }, 0);
  await call(ME, "PUT", "/push-token", { token: "a".repeat(64), environment: "production" });

  await say(ME, mochi.id, "is my bike sorted?");
  await queue.kick(mochi.id);
  // Mochi's turn is over and it waits on Cog, which is at work on what Mochi asked. What Mochi said meanwhile is an update.
  const waiting = await rows();
  assert.deepEqual([waiting.Mochi.working, waiting.Mochi.waiting_on, waiting.Mochi.unread], [false, cog.id, 0]);
  assert.deepEqual([waiting.Cog.working, waiting.Cog.waiting_on, waiting.Cog.latest], [true, null, null]);
  const asked = (await chat(mochi.id))[1];
  assert.deepEqual(
    (await chat(mochi.id)).map((message) => [message.sender, message.body, message.peer_id, message.status, message.interim]),
    [
      ["person", "is my bike sorted?", null, "done", false],
      ["agent", "What did the shop quote?", cog.id, "running", false],
      ["agent", "I've asked Cog.", null, "done", true],
    ],
  );
  // What Mochi asked is in Cog's chat too.
  assert.deepEqual((await chat(cog.id)).map((message) => message.id), [asked.id]);
  assert.equal(prompts[1], "Mochi, another of Alex's agents, sent you the message below. Alex didn't write it. Your reply goes back to Mochi and not to Alex, so say what Mochi needs.\n\nWhat did the shop quote?");

  release();
  await queue.kick(cog.id);
  await queue.kick(mochi.id);
  assert.equal(prompts[2], 'Cog answered what you asked it ("What did the shop quote?"):\n\nThey quoted £85.');
  assert.deepEqual(
    (await chat(mochi.id)).slice(3).map((message) => [message.agent_id, message.body, message.peer_id, message.reply_to, message.status]),
    [
      [cog.id, "They quoted £85.", mochi.id, asked.id, "done"],
      [mochi.id, "It's sorted: £85.", null, null, "done"],
    ],
  );
  assert.deepEqual((await chat(cog.id)).map((message) => [message.body, message.status]), [["What did the shop quote?", "done"], ["They quoted £85.", "done"]]);
  // Only Mochi's reply to the person is something to read, and to be told of.
  const done = await rows();
  assert.deepEqual([done.Mochi.waiting_on, done.Mochi.unread, done.Mochi.latest?.body], [null, 1, "It's sorted: £85."]);
  assert.deepEqual([done.Cog.working, done.Cog.unread, done.Cog.latest], [false, 0, null]);
  await pushed();
  assert.deepEqual(sent.map((notice) => [notice.title, notice.body]), [["Mochi", "It's sorted: £85."]]);
});

test("an ask raised while working for another agent is in that agent's chat too, and stopping the agent that waits stops the work", async () => {
  const prompts: string[] = [];
  const { queue, call, say, mochi, cog, chat, rows } = await twoAgents(async (turn, cogs) => {
    prompts.push(turn.prompt.text);
    if (!cogs) {
      turn.askAgent("Cog", "Book the repair.");
      return reply("I've asked Cog.");
    }
    void turn.ask(command("curl -X POST https://shop.example/book"), new AbortController().signal);
    return untilStopped(turn, "session-cog");
  });
  await say(ME, mochi.id, "book my bike in");
  await queue.kick(mochi.id);
  const ask = (await chat(cog.id)).at(-1)!;
  assert.deepEqual([ask.agent_id, ask.ask, ask.peer_id], [cog.id, "waiting", mochi.id]);
  assert.ok((await chat(mochi.id)).some((message) => message.id === ask.id));
  // It is still Cog's ask, to read and to answer.
  assert.equal((await rows()).Cog.unread, 1);

  assert.equal((await call(ME, "POST", `/agents/${mochi.id}/stop`)).status, 200);
  await queue.kick(cog.id);
  assert.deepEqual((await chat(cog.id)).map((message) => [message.sender, message.body.split("\n")[0], message.status, message.ask]), [
    ["agent", "Book the repair.", "failed", null],
    ["agent", "Run a command: Clear the old folder", "done", "unanswered"],
    ["sidebots", "Stopped", "done", null],
  ]);
  // Mochi waits on nothing, and no answer wakes it.
  const stopped = await rows();
  assert.deepEqual([stopped.Mochi.waiting_on, stopped.Mochi.working, stopped.Cog.working], [null, false, false]);
  assert.equal(prompts.length, 2);
});

test("stopping an agent calls off what it asked another that hasn't read it yet, though that agent's turn for it had begun", async () => {
  // Cog's turn for what Mochi asked is stopped while it starts. A provider's turn then ends with nothing read, and one too far along to end answers all the same.
  for (const answersAnyway of [false, true]) {
    let starting = true;
    const { queue, call, say, mochi, cog, chat, rows } = await twoAgents(
      async (turn, cogs) => {
        if (cogs) return reply("Booked.", "session-cog");
        if (turn.prompt.text === "book my bike in") turn.askAgent("Cog", "Book the repair.");
        return reply(turn.prompt.text === "book my bike in" ? "I've asked Cog." : "It's booked.");
      },
      async (turn, cogs) => {
        if (!cogs || !starting) return;
        starting = false;
        await new Promise<void>((resolve) => turn.stop.signal.addEventListener("abort", () => resolve()));
        if (!answersAnyway) throw new Error("The turn was stopped before it started");
      },
    );
    await say(ME, mochi.id, "book my bike in");
    await queue.kick(mochi.id);
    const waiting = await rows();
    assert.deepEqual([waiting.Mochi.waiting_on, waiting.Cog.working], [cog.id, true]);

    assert.equal((await call(ME, "POST", `/agents/${mochi.id}/stop`)).status, 200);
    await queue.kick(cog.id);
    await queue.kick(mochi.id);
    // Cog gives no answer, to Mochi or to Alex, and Mochi waits on nothing.
    assert.deepEqual((await chat(cog.id)).map((message) => [message.body, message.status]), [["Book the repair.", "failed"]]);
    assert.deepEqual((await chat(mochi.id)).map((message) => [message.body, message.status]), [
      ["book my bike in", "done"],
      ["Book the repair.", "failed"],
      ["I've asked Cog.", "done"],
    ]);
    const stopped = await rows();
    assert.deepEqual([stopped.Mochi.waiting_on, stopped.Mochi.working, stopped.Cog.working, stopped.Cog.latest], [null, false, false, null]);
  }
});

test("an agent that can't finish what another asked tells it why, and a deleted agent's side of an exchange goes with it", async () => {
  const prompts: string[] = [];
  const { queue, call, say, mochi, cog, chat, rows } = await twoAgents(async (turn, cogs) => {
    prompts.push(turn.prompt.text);
    if (cogs) throw new Error("The shop's site is down.");
    if (turn.prompt.text === "book my bike in") turn.askAgent("Cog", "Book the repair.");
    return reply(turn.prompt.text === "book my bike in" ? "I've asked Cog." : "Cog couldn't book it.");
  });
  await say(ME, mochi.id, "book my bike in");
  await queue.kick(mochi.id);
  await queue.kick(cog.id);
  await queue.kick(mochi.id);
  assert.match(prompts[2], /^Cog answered what you asked it \("Book the repair\."\):\n\nI couldn't finish this\. /);
  assert.deepEqual((await chat(mochi.id)).map((message) => [message.agent_id === cog.id, message.body.split(". ")[0], message.status]), [
    [false, "book my bike in", "done"],
    [false, "Book the repair.", "failed"],
    [false, "I've asked Cog.", "done"],
    [true, "I couldn't finish this", "done"],
    [false, "Cog couldn't book it.", "done"],
  ]);
  // Cog's failure is Mochi's to tell, so Cog's own chat shows nothing to read.
  assert.equal((await rows()).Cog.unread, 0);

  assert.equal((await call(ME, "DELETE", `/agents/${cog.id}`)).status, 200);
  assert.deepEqual((await chat(mochi.id)).map((message) => message.body), ["book my bike in", "I've asked Cog.", "Cog couldn't book it."]);
});

test("each message the stream brings carries its chat's count of changes, one more than the last, and the agent a deleted one talked with comes after it", async () => {
  const { queue, call, say, app, phoneOf, mochi, cog, rows } = await twoAgents(async (turn, cogs) => {
    if (cogs) return reply("£85, ready Friday.");
    if (turn.prompt.text === "is my bike sorted?") turn.askAgent("Cog", "What did the shop quote?");
    return reply(turn.prompt.text === "is my bike sorted?" ? "I've asked Cog." : "It's sorted: £85.");
  });
  const response = await app.request("/events", { headers: phoneOf(ME) });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  await say(ME, mochi.id, "is my bike sorted?");
  await queue.kick(mochi.id);
  await queue.kick(cog.id);
  await queue.kick(mochi.id);
  const stood = await rows();
  assert.equal((await call(ME, "DELETE", `/agents/${cog.id}`)).status, 200);

  let text = "";
  while (!/event: deleted[^]*event: agent/.test(text)) text += (await reader.read()).value;
  await reader.cancel();
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as { message: Message | null; agent: AgentWithLatest } | { deleted: string });
  const counts = (agentId: string) => events.flatMap((event) => ("agent" in event && event.message && event.agent.id === agentId ? [event.agent.chat_changes] : []));
  // What the two said to each other is in both chats, so it counts in both.
  for (const agent of [stood.Mochi, stood.Cog]) {
    assert.deepEqual(counts(agent.id), Array.from({ length: agent.chat_changes }, (_, index) => index + 1));
    assert.ok(agent.chat_changes > 0);
  }
  assert.ok(stood.Cog.chat_changes < stood.Mochi.chat_changes);
  // Cog goes, and what it and Mochi said to each other goes from Mochi's chat, so Mochi comes after it with a new count.
  const now = (await rows()).Mochi;
  assert.ok(now.chat_changes > stood.Mochi.chat_changes);
  assert.equal(now.waiting_on, null);
  assert.deepEqual(events.slice(-2), [{ deleted: cog.id }, { message: null, agent: now }]);
});

const GMAIL_SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

/**
 * Google, as it answers Sidebots: tokens for the account `email`, which let
 * their holder do what `allows` names, and a Gmail with one unread mail. It
 * keeps what it was asked, each as the request and what came with it.
 */
function google(web: ReturnType<typeof setup>["web"], email: string, allows = GMAIL_SCOPES) {
  const asked: [request: string, body: string][] = [];
  const state = { ended: false };
  let granted = 0;
  const mail = {
    id: "m1",
    threadId: "t1",
    labelIds: ["UNREAD"],
    snippet: "See you at 3",
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Anna <anna@example.com>" }, { name: "Subject", value: "Friday" }], body: { data: Buffer.from("See you at 3, at the shop.").toString("base64url") } },
  };
  web.request = async (url, init) => {
    asked.push([`${init?.method ?? "GET"} ${url.split("?")[0]}`, `${new Headers(init?.headers).get("Authorization") ?? ""} ${String(init?.body ?? "")}`.trim()]);
    if (url === "https://oauth2.googleapis.com/token") {
      if (state.ended) return Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
      const first = new URLSearchParams(String(init?.body)).get("grant_type") === "authorization_code";
      const who = Buffer.from(JSON.stringify({ email })).toString("base64url");
      return Response.json({ access_token: `access-${++granted}`, expires_in: 3600, scope: allows, ...(first && { refresh_token: "lasting", id_token: `head.${who}.signature` }) });
    }
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return Response.json({ messages: [{ id: "m1" }] });
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?")) return Response.json(mail);
    return Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 });
  };
  return { asked, state };
}

test("an agent asks for a connection, the person makes it by signing in on their phone, and all their agents then use it", async () => {
  const told: string[] = [];
  const { home, queue, web, call, say } = setup(async (turn) => {
    if (turn.prompt.text.includes("check my mail")) {
      told.push(await turn.useConnection("gmail_search", { query: "is:unread" }));
      told.push(await turn.connect("gmail"));
      told.push(await turn.useConnection("gmail_search", { query: "is:unread" }));
    } else told.push(await turn.useConnection("gmail_read", { id: "m1" }));
    return reply("Done.");
  });
  const { asked } = google(web, "alex@example.com");
  const theo = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  const ruby = (await call(ME, "POST", "/agents", { name: "Ruby", avatarId: "mochi" })).json;
  const hers = (await call(HER, "POST", "/agents", { name: "Leo", avatarId: "mochi" })).json;
  const NOT_CONNECTED = "Gmail isn't connected. Call `connect` with `gmail`, which asks the person to sign in to it.";

  // The agent finds Gmail isn't connected, and asks for it with a card in the chat.
  await say(ME, theo.id, "check my mail");
  const turn = queue.kick(theo.id);
  await new Promise((resolve) => setTimeout(resolve, 1));
  const ask = ((await call(ME, "GET", `/agents/${theo.id}/messages`)).json as Message[]).at(-1)!;
  assert.deepEqual([ask.ask, ask.body, ask.question?.kind, ask.question?.connection], ["waiting", "Connect Gmail: Your agents can search, read and send your mail.", "connection", "gmail"]);
  // Each comes with what the app draws it from, its logo among it, so the app lists one it has never heard of.
  const listed = (await call(ME, "GET", "/connections")).json as { connection: string; name: string; allows: string; logo: { path: string; color: string | null }; account: string | null }[];
  assert.deepEqual(
    listed.map(({ logo, ...rest }) => [rest, logo.color, /^M[\d\s.,a-zA-Z-]+$/.test(logo.path)]),
    [
      [{ connection: "gmail", name: "Gmail", allows: "Your agents can search, read and send your mail.", account: null }, "#EA4335", true],
      [{ connection: "calendar", name: "Google Calendar", allows: "Your agents can read your calendars, and add, change and remove their events.", account: null }, "#4285F4", true],
      [{ connection: "notion", name: "Notion", allows: "Your agents can search and read your Notion, and add to it and change it.", account: null }, null, true],
    ],
  );

  // The phone opens Google's page, which is asked for what Gmail needs and comes back to the app.
  const signIn = (await call(ME, "POST", "/connections/gmail/sign-in")).json as { url: string; redirect: string };
  const page = new URL(signIn.url);
  assert.equal(signIn.redirect, "com.googleusercontent.apps.sidebots-test:/oauth2redirect");
  assert.equal(`${page.origin}${page.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(
    ["client_id", "redirect_uri", "response_type", "scope", "access_type", "code_challenge_method"].map((name) => page.searchParams.get(name)),
    ["sidebots-test.apps.googleusercontent.com", signIn.redirect, "code", "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send", "offline", "S256"],
  );
  const back = `${signIn.redirect}?state=${page.searchParams.get("state")}&code=one-time`;
  // A sign-in is its own person's to finish, and Sidebots has no connection by another name.
  assert.equal((await call(HER, "PUT", "/connections/gmail", { url: `${signIn.redirect}?state=made-up&code=one-time` })).status, 400);
  assert.equal((await call(ME, "POST", "/connections/outlook/sign-in")).status, 404);

  // The code is swapped for Google's tokens with the secret whose hash the page was given, and the agent goes on.
  const connected = await call(ME, "PUT", "/connections/gmail", { url: back });
  assert.deepEqual([connected.status, connected.json.connection, connected.json.account], [200, "gmail", "alex@example.com"]);
  const swap = new URLSearchParams(asked.find(([request]) => request === "POST https://oauth2.googleapis.com/token")![1]);
  assert.deepEqual([swap.get("code"), swap.get("client_id"), swap.get("redirect_uri")], ["one-time", "sidebots-test.apps.googleusercontent.com", signIn.redirect]);
  assert.equal(createHash("sha256").update(swap.get("code_verifier")!).digest("base64url"), page.searchParams.get("code_challenge"));
  await turn;
  assert.deepEqual(told, [NOT_CONNECTED, "Gmail is connected, as alex@example.com. You and Alex's other agents can use it from now on. If you have no tools of its yet, they reach you on your next turn: tell Alex it is connected, and to ask again.", "id m1, unread\nFrom: Anna <anna@example.com>\nSubject: Friday\nSee you at 3"]);
  assert.equal(((await call(ME, "GET", `/agents/${theo.id}/messages`)).json as Message[]).find((message) => message.id === ask.id)!.ask, "allowed");
  // The code works once, and the token that lasts is in a file only this account can read.
  assert.equal((await call(ME, "PUT", "/connections/gmail", { url: back })).json.error, "That sign-in has run out. Start it again.");
  assert.equal(statSync(join(home, "connections.json")).mode & 0o777, 0o600);

  // Another of the person's agents has the connection too, on the token in hand. Another person's has none of it.
  await say(ME, ruby.id, "read it");
  await queue.kick(ruby.id);
  assert.equal(told.at(-1), "From: Anna <anna@example.com>\nSubject: Friday\n\nSee you at 3, at the shop.");
  assert.deepEqual(asked.filter(([request]) => request.startsWith("GET")).map(([, sent]) => sent), ["Bearer access-1", "Bearer access-1", "Bearer access-1"]);
  await say(HER, hers.id, "read it");
  await queue.kick(hers.id);
  assert.equal(told.at(-1), NOT_CONNECTED);
  assert.equal((await call(HER, "GET", "/connections")).json[0].account, null);

  // What Gmail refuses, the agent is told. A connection the person removes is gone for all their agents.
  web.request = async () => Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 });
  await say(ME, ruby.id, "read it");
  await queue.kick(ruby.id);
  assert.equal(told.at(-1), "Gmail refused that: Requested entity was not found.");
  assert.equal((await call(ME, "DELETE", "/connections/gmail")).status, 200);
  await say(ME, ruby.id, "read it");
  await queue.kick(ruby.id);
  assert.equal(told.at(-1), NOT_CONNECTED);
});

test("an agent is told when the person doesn't make a connection, or allows less than it needs", async () => {
  const told: string[] = [];
  const { queue, web, call, say } = setup(async (turn) => {
    told.push(await turn.connect("gmail"));
    return reply("Done.");
  });
  google(web, "alex@example.com", "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly");
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  await say(ME, agent.id, "connect my mail");
  const turn = queue.kick(agent.id);
  await new Promise((resolve) => setTimeout(resolve, 1));
  const ask = ((await call(ME, "GET", `/agents/${agent.id}/messages`)).json as Message[]).at(-1)!;

  // A person who unticks part of what Gmail asks for has made no connection, and the agent waits on.
  const signIn = (await call(ME, "POST", "/connections/gmail/sign-in")).json as { url: string; redirect: string };
  const finished = await call(ME, "PUT", "/connections/gmail", { url: `${signIn.redirect}?state=${new URL(signIn.url).searchParams.get("state")}&code=one-time` });
  assert.deepEqual([finished.status, finished.json.error], [400, "Google didn't allow everything Gmail needs. Connect it again, and allow all it asks for."]);
  assert.equal((await call(ME, "GET", "/connections")).json[0].account, null);
  // One who leaves Google's page comes back with no code.
  const left = (await call(ME, "POST", "/connections/gmail/sign-in")).json as { url: string; redirect: string };
  assert.equal((await call(ME, "PUT", "/connections/gmail", { url: `${left.redirect}?state=${new URL(left.url).searchParams.get("state")}&error=access_denied` })).json.error, "Google didn't sign you in.");

  // Only signing in says yes to a connection. No is said as it is to any ask.
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${ask.id}`, { allow: true })).status, 409);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/asks/${ask.id}`, { allow: false })).json.ask, "refused");
  await turn;
  assert.deepEqual(told, ["Alex said no to this. Don't do it, or the same thing another way. Finish the rest and say in your reply what you left out."]);
});

test("a connection gets a new token once the one in hand has run out, and is forgotten once Google has ended it", async () => {
  let time = new Date(2026, 10, 20, 9, 0).getTime();
  const told: string[] = [];
  const { queue, web, call, say } = setup(
    async (turn) => {
      told.push(await turn.useConnection("gmail_read", { id: "m1" }));
      return reply("Done.");
    },
    () => time,
  );
  const { asked, state } = google(web, "alex@example.com");
  const agent = (await call(ME, "POST", "/agents", { name: "Theo", avatarId: "mochi" })).json;
  const signIn = (await call(ME, "POST", "/connections/gmail/sign-in")).json as { url: string; redirect: string };
  await call(ME, "PUT", "/connections/gmail", { url: `${signIn.redirect}?state=${new URL(signIn.url).searchParams.get("state")}&code=one-time` });
  const read = async () => {
    await say(ME, agent.id, "read it");
    await queue.kick(agent.id);
    return asked.at(-1)!;
  };

  assert.equal((await read())[1], "Bearer access-1");
  time += 3600_000;
  assert.equal((await read())[1], "Bearer access-2");
  assert.deepEqual(asked.at(-2), ["POST https://oauth2.googleapis.com/token", "client_id=sidebots-test.apps.googleusercontent.com&grant_type=refresh_token&refresh_token=lasting"]);

  // The person took the connection back at Google, which the next token asked for finds out.
  state.ended = true;
  time += 3600_000;
  await read();
  assert.equal(told.at(-1), "Gmail is no longer connected. Call `connect` with `gmail`, which asks the person to sign in to it.");
  assert.equal((await call(ME, "GET", "/connections")).json[0].account, null);
});
