import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { createQueue, type RunTurn, type TurnResult } from "../src/runner.ts";
import { createApi } from "../src/api.ts";
import { startPush, type Notice } from "../src/push.ts";

function setup(runTurn: RunTurn) {
  const home = mkdtempSync(join(tmpdir(), "simon-test-"));
  const store = openStore(home);
  store.addPerson({ name: "Alex", login: "alex@example.com", configDir: "/config/alex" });
  store.addPerson({ name: "Robin", login: "robin@example.com", configDir: "/config/robin" });
  const queue = createQueue(store, runTurn);
  const app = createApi(store, queue);
  const call = async (login: string, method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { "Tailscale-User-Login": login, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  /** Sends a message the way the app does, as a form with any files. */
  const say = async (login: string, agentId: string, body: string, files: File[] = []) => {
    const form = new FormData();
    form.append("body", body);
    for (const file of files) form.append("files", file);
    const response = await app.request(`/agents/${agentId}/messages`, { method: "POST", headers: { "Tailscale-User-Login": login }, body: form });
    return { status: response.status, json: await response.json() };
  };
  return { store, queue, call, say, app };
}

const reply = (text: string, sessionId = "session-1", contextTokens = 0): TurnResult => ({ reply: text, sessionId, contextTokens });

const ME = "alex@example.com";
const HER = "robin@example.com";

test("a message gets the agent's reply, run in the agent's folder under its owner's login", async () => {
  const turns: Parameters<RunTurn>[0][] = [];
  const { store, queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    return reply(`You said: ${turn.prompt}`);
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Wedding", petId: "mochi" })).json;

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
  assert.match(readFileSync(join(store.agentHome(agent.id), "CLAUDE.md"), "utf8"), /You are Wedding, one of Alex's agents/);
});

test("messages sent while the agent is busy run one at a time, in order, on the same session", async () => {
  let running = 0;
  let most = 0;
  const seen: [string, string | null][] = [];
  const { queue, call, say } = setup(async (turn) => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push([turn.prompt, turn.sessionId]);
    running--;
    return reply("ok");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Money", petId: "cog" })).json;

  for (const body of ["one", "two", "three"]) await say(ME, agent.id, body);
  await queue.kick(agent.id);

  assert.equal(most, 1);
  assert.deepEqual(seen, [
    ["one", null],
    ["two", "session-1"],
    ["three", "session-1"],
  ]);
});

test("a failed turn keeps the message and adds a note from Simon saying why", async () => {
  const { queue, call, say } = setup(async () => {
    throw new Error("You've reached your usage limit.");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Scout", petId: "moss" })).json;

  await say(ME, agent.id, "find me a flat");
  await queue.kick(agent.id);

  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "find me a flat", "failed"],
      ["simon", "Simon couldn't finish this. You've reached your usage limit.", "failed"],
    ],
  );
});

test("each person only reaches their own agents", async () => {
  const { call, say } = setup(async () => reply("ok"));
  const mine = (await call(ME, "POST", "/agents", { name: "Gym", petId: "hop" })).json;

  assert.deepEqual((await call(HER, "GET", "/agents")).json, []);
  assert.equal((await call(HER, "GET", `/agents/${mine.id}/messages`)).status, 404);
  assert.equal((await say(HER, mine.id, "hi")).status, 404);
  assert.equal((await call("stranger@example.com", "GET", "/agents")).status, 403);
});

test("the event stream carries the person's own messages and their status changes, and nobody else's", async () => {
  let finish!: () => void;
  const { queue, call, say, app } = setup(() => new Promise((resolve) => (finish = () => resolve(reply("done")))));
  const mine = (await call(ME, "POST", "/agents", { name: "Wedding", petId: "mochi" })).json;
  const hers = (await call(HER, "POST", "/agents", { name: "Garden", petId: "moss" })).json;

  const response = await app.request("/events", { headers: { "Tailscale-User-Login": ME } });
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
      ["person", "hello", "queued", "Wedding", true],
      ["person", "hello", "running", "Wedding", true],
      ["agent", "done", "done", "Wedding", true],
      ["person", "hello", "done", "Wedding", false],
    ],
  );
});

test("after a known message returns only what came later", async () => {
  const { queue, call, say } = setup(async (turn) => reply(`re: ${turn.prompt}`));
  const agent = (await call(ME, "POST", "/agents", { name: "Books", petId: "wisp" })).json;
  const first = (await say(ME, agent.id, "first")).json;
  await queue.kick(agent.id);

  const later = (await call(ME, "GET", `/agents/${agent.id}/messages?after=${first.id}`)).json;
  assert.deepEqual(later.map((m: { body: string }) => m.body), ["re: first"]);
});

test("files sent with a message go into the agent's folder, the agent is told where, and only their owner can open them", async () => {
  const prompts: string[] = [];
  const { store, queue, call, say, app } = setup(async (turn) => {
    prompts.push(turn.prompt);
    return reply("nice");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Scout", petId: "moss" })).json;

  const sent = await say(ME, agent.id, "what is this?", [new File(["jpeg bytes"], "IMG%20 0042.jpg", { type: "image/jpeg" })]);
  await queue.kick(agent.id);

  const [path] = sent.json.attachments as string[];
  assert.match(path, /^attachments\/[0-9a-f]{8}-IMG-0042\.jpg$/);
  assert.equal(readFileSync(join(store.agentHome(agent.id), path), "utf8"), "jpeg bytes");
  assert.equal(prompts[0], `what is this?\n\nSent with this message: ${path}`);

  const mine = await app.request(`/agents/${agent.id}/${path}`, { headers: { "Tailscale-User-Login": ME } });
  assert.equal(mine.headers.get("Content-Type"), "image/jpeg");
  assert.equal(await mine.text(), "jpeg bytes");
  assert.equal((await app.request(`/agents/${agent.id}/${path}`, { headers: { "Tailscale-User-Login": HER } })).status, 404);
  assert.equal((await app.request(`/agents/${agent.id}/attachments/..`, { headers: { "Tailscale-User-Login": ME } })).status, 404);
  assert.equal((await say(ME, agent.id, "  ")).status, 400);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/messages`, { body: "text alone, as JSON" })).json.body, "text alone, as JSON");
});

test("a fresh start has the agent save its memory, then gives the next message a new session that is shown the chat so far", async () => {
  const turns: Parameters<RunTurn>[0][] = [];
  const { queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    return reply("sure", `session-${turns.length}`);
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Wedding", petId: "mochi" })).json;
  await say(ME, agent.id, "book the band");
  await queue.kick(agent.id);

  const marker = await call(ME, "POST", `/agents/${agent.id}/fresh-start`);
  assert.equal(marker.status, 201);
  await say(ME, agent.id, "any news?");
  await queue.kick(agent.id);

  assert.deepEqual(turns.map((turn) => turn.sessionId), [null, "session-1", null]);
  assert.match(turns[1].prompt, /Save what is worth keeping .* learned about Alex/);
  assert.equal(
    turns[2].prompt,
    "This is a fresh session in a chat that was already going. The latest messages in it:\n\nAlex: book the band\n\nYou: sure\n\nAlex's new message:\n\nany news?",
  );
  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "book the band", "done"],
      ["agent", "sure", "done"],
      ["simon", "Fresh start", "done"],
      ["person", "any news?", "done"],
      ["agent", "sure", "done"],
    ],
  );
});

test("a session that has grown large gets a fresh start by itself after its reply", async () => {
  const sessions: (string | null)[] = [];
  const { queue, call, say } = setup(async (turn) => {
    sessions.push(turn.sessionId);
    return reply("ok", "big", 150_000);
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Money", petId: "cog" })).json;
  await say(ME, agent.id, "budget");
  await queue.kick(agent.id);

  assert.deepEqual(sessions, [null, "big"]);
  assert.equal((await call(ME, "GET", "/agents")).json[0].session_id, null);
  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(messages.map((m: { body: string }) => m.body), ["budget", "ok", "Fresh start"]);
});

test("a search, by an agent or from the app, reaches all of the person's chats and nobody else's", async () => {
  const searches: string[] = [];
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt === "search") searches.push(turn.searchHistory("florist"));
    return reply("ok");
  });
  const wedding = (await call(ME, "POST", "/agents", { name: "Wedding", petId: "mochi" })).json;
  const money = (await call(ME, "POST", "/agents", { name: "Money", petId: "cog" })).json;
  const hers = (await call(HER, "POST", "/agents", { name: "Garden", petId: "moss" })).json;
  await say(ME, wedding.id, "The florist quoted 400");
  await say(HER, hers.id, "my florist is a secret");
  await queue.kick(wedding.id);
  await queue.kick(hers.id);

  await say(ME, money.id, "search");
  await queue.kick(money.id);

  assert.match(searches[0], /^\d{4}-\d{2}-\d{2}, chat with Wedding, the person: The florist quoted 400$/);

  const found = (await call(ME, "GET", "/search?text=florist")).json;
  assert.deepEqual(
    found.map((m: { agent_id: string; body: string }) => [m.agent_id, m.body]),
    [[wedding.id, "The florist quoted 400"]],
  );
});

test("a reply or a failed turn notifies the person's phones, and a phone Apple has dropped is forgotten", async () => {
  let fail = false;
  const { store, queue, call, say } = setup(async () => {
    if (fail) throw new Error("Signed out.");
    return reply("Booked.");
  });
  const sent: [string, Notice][] = [];
  startPush(store, async (device, notice) => {
    sent.push([device.token, notice]);
    return device.token === OLD_PHONE ? "gone" : "sent";
  });
  const PHONE = "a".repeat(64);
  const OLD_PHONE = "b".repeat(64);
  const HER_PHONE = "c".repeat(64);
  for (const [login, token] of [[ME, PHONE], [ME, OLD_PHONE], [HER, HER_PHONE]]) {
    assert.equal((await call(login, "POST", "/devices", { token, topic: "com.example.simon", environment: "production" })).status, 201);
  }
  assert.equal((await call(ME, "POST", "/devices", { token: "nope", topic: "com.example.simon", environment: "production" })).status, 400);
  const agent = (await call(ME, "POST", "/agents", { name: "Wedding", petId: "mochi" })).json;

  await say(ME, agent.id, "book the band");
  await queue.kick(agent.id);
  await new Promise((resolve) => setTimeout(resolve, 1));
  fail = true;
  await say(ME, agent.id, "and the florist");
  await queue.kick(agent.id);
  await call(ME, "POST", `/agents/${agent.id}/fresh-start`);
  await queue.kick(agent.id);

  assert.deepEqual(
    sent.map(([token, notice]) => [token, notice.title, notice.body, notice.badge, notice.agentId]),
    [
      [PHONE, "Wedding", "Booked.", 1, agent.id],
      [OLD_PHONE, "Wedding", "Booked.", 1, agent.id],
      [PHONE, "Wedding", "Simon couldn't finish this. Signed out.", 2, agent.id],
    ],
  );

  // Reading the chat clears the count. A fresh start is nothing to read.
  assert.equal((await call(ME, "GET", "/agents")).json[0].unread, 2);
  assert.equal((await call(ME, "POST", `/agents/${agent.id}/read`)).json.unread, 0);
  assert.equal((await call(HER, "POST", `/agents/${agent.id}/read`)).status, 404);
});
