import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { createQueue, type Turn, type TurnResult } from "../src/runner.ts";
import { createApi } from "../src/api.ts";
import { startPush, type Notice } from "../src/push.ts";

/** A turn's reply, as a fake Claude Code gives it. No reply means the fake gave its replies itself. */
type Answer = TurnResult & { reply?: string };

/**
 * A Simon whose turns `answer` runs instead of Claude Code. The fake reads
 * the turn's first message, then replies to it.
 */
function setup(answer: (turn: Turn) => Promise<Answer>, now: () => number = Date.now) {
  const runTurn = async (turn: Turn): Promise<TurnResult> => {
    turn.seen([turn.prompt.id]);
    const { reply: text, ...result } = await answer(turn);
    if (text !== undefined) turn.replied(text, [turn.prompt.id]);
    return result;
  };
  const home = mkdtempSync(join(tmpdir(), "simon-test-"));
  const store = openStore(home);
  store.addPerson({ name: "Alex", login: "alex@example.com", configDir: "/config/alex" });
  store.addPerson({ name: "Robin", login: "robin@example.com", configDir: "/config/robin" });
  const queue = createQueue(store, runTurn, now);
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
  return { home, store, queue, call, say, app };
}

const reply = (text: string, sessionId = "session-1", contextTokens = 0): Answer => ({ reply: text, sessionId, contextTokens });

const ME = "alex@example.com";
const HER = "robin@example.com";

test("a message gets the agent's reply, run in the agent's folder under its owner's login", async () => {
  const turns: Turn[] = [];
  const { store, queue, call, say } = setup(async (turn) => {
    turns.push(turn);
    return reply(`You said: ${turn.prompt.text}`);
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
    seen.push([turn.prompt.text, turn.sessionId]);
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
  const { queue, call, say } = setup(async (turn) => reply(`re: ${turn.prompt.text}`));
  const agent = (await call(ME, "POST", "/agents", { name: "Books", petId: "wisp" })).json;
  const first = (await say(ME, agent.id, "first")).json;
  await queue.kick(agent.id);

  const later = (await call(ME, "GET", `/agents/${agent.id}/messages?after=${first.id}`)).json;
  assert.deepEqual(later.map((m: { body: string }) => m.body), ["re: first"]);
});

test("files sent with a message go into the agent's folder, the agent is told where, and only their owner can open them", async () => {
  const prompts: string[] = [];
  const { store, queue, call, say, app } = setup(async (turn) => {
    prompts.push(turn.prompt.text);
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
  const turns: Turn[] = [];
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
    if (turn.prompt.text === "search") searches.push(turn.searchHistory("florist"));
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
  // A reply counts as unread when it is newer than the chat was read, which begins at the agent's creation.
  await new Promise((resolve) => setTimeout(resolve, 1));

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

test("an agent's name, pet, model and effort can be changed, and its turns run on its model at its effort", async () => {
  const models: string[][] = [];
  const { store, queue, call, say } = setup(async (turn) => {
    models.push([turn.model, turn.effort]);
    return reply("ok");
  });
  store.installStarterPets(join(import.meta.dirname, "..", "..", "pets"));
  const agent = (await call(ME, "POST", "/agents", { name: "Money", petId: "cog" })).json;
  assert.deepEqual([agent.model, agent.effort], ["opus", "medium"]);

  const changed = await call(ME, "PATCH", `/agents/${agent.id}`, { name: "Budget", petId: "moss", model: "haiku", effort: "high" });
  assert.deepEqual([changed.json.name, changed.json.pet_id, changed.json.model, changed.json.effort], ["Budget", "moss", "haiku", "high"]);
  assert.match(readFileSync(join(store.agentHome(agent.id), "CLAUDE.md"), "utf8"), /^# Budget\n\nYou are Budget, one of Alex's agents/);
  await say(ME, agent.id, "hello");
  await queue.kick(agent.id);
  assert.deepEqual(models, [["haiku", "high"]]);

  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { model: "gpt" })).status, 400);
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { effort: "ultracode" })).status, 400);
  assert.equal((await call(ME, "PATCH", `/agents/${agent.id}`, { petId: "dragon" })).status, 400);
  assert.equal((await call(HER, "PATCH", `/agents/${agent.id}`, { name: "Mine" })).status, 404);
});

test("deleting an agent removes its messages, its jobs, its folder and its Claude Code sessions", async () => {
  const { home, store, queue, call, say } = setup(async (turn) => {
    turn.scheduleJob({ what: "check", every_minutes: 5 });
    return reply("ok");
  });
  const configDir = join(home, "claude");
  store.addPerson({ name: "Sam", login: "sam@example.com", configDir });
  const agent = (await call("sam@example.com", "POST", "/agents", { name: "Scout", petId: "moss" })).json;
  const folder = store.agentHome(agent.id);
  const sessions = join(configDir, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "session-1.jsonl"), "{}");
  await say("sam@example.com", agent.id, "hello");
  await queue.kick(agent.id);

  assert.equal((await call(ME, "DELETE", `/agents/${agent.id}`)).status, 404);
  assert.equal((await call("sam@example.com", "DELETE", `/agents/${agent.id}`)).status, 200);

  assert.deepEqual((await call("sam@example.com", "GET", "/agents")).json, []);
  assert.equal((await call("sam@example.com", "GET", `/agents/${agent.id}/messages`)).status, 404);
  assert.deepEqual(store.jobs(agent.id), []);
  assert.equal(existsSync(folder), false);
  assert.equal(existsSync(sessions), false);
});

test("a job runs when its time comes, in a session of its own, and only a run with something to say sends a message", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const runs: [string, string | null, boolean][] = [];
  let found = "SILENT";
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "watch the price") {
      assert.match(turn.scheduleJob({ what: "Check the price. Stay silent unless it dropped.", every_minutes: 5 }), /^Saved job \w+: Every 5 minutes\. It first runs at 2026-11-16T09:05\. It is now 2026-11-16T09:00\.$/);
      assert.equal(turn.scheduleJob({ what: "x", every_minutes: 5, daily_at: "08:00" }), "Give exactly one of every_minutes, daily_at and once_at.");
      assert.match(turn.scheduleJob({ what: "x", once_at: "2026-11-16T08:00" }), /^That time has passed/);
      return reply("Watching.");
    }
    runs.push([turn.prompt.text, turn.sessionId, turn.keepSession]);
    return turn.prompt.text.startsWith("This is a run of one of your jobs") ? reply(found, "job-session") : reply("ok");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Scout", petId: "moss" })).json;
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
  assert.match(runs[0][0], /\(Every 5 minutes\)[\s\S]*Check the price\. Stay silent unless it dropped\.[\s\S]*reply with only the word SILENT/);
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
  assert.match(runs[2][0], /your jobs sent Alex these messages[\s\S]*You: The price dropped to 300\.[\s\S]*Alex's new message:\n\nbuy it$/);
  assert.deepEqual(runs[2].slice(1), ["session-1", true]);

  // The person can remove it, and then nothing runs.
  assert.equal((await call(HER, "DELETE", `/agents/${agent.id}/jobs/${job.id}`)).status, 404);
  assert.equal((await call(ME, "DELETE", `/agents/${agent.id}/jobs/${job.id}`)).status, 200);
  time += 60 * 60_000;
  await queue.kick(agent.id);
  assert.equal(runs.length, 3);
});

test("a job set for one time runs once, a daily one keeps to its days, and a job that keeps failing says so once", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime(); // A Monday.
  let fail = false;
  const { store, queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "set up") {
      turn.scheduleJob({ what: "Say it is time to call the garage.", once_at: "2026-11-16T17:00" });
      assert.match(turn.scheduleJob({ what: "Morning brief.", daily_at: "08:00", weekdays: [1, 5] }), /Mon, Fri at 08:00\. It first runs at 2026-11-20T08:00/);
      assert.match(turn.listJobs(), /Once, 16 Nov at 17:00, next at 2026-11-16T17:00\. Say it is time to call the garage\.[\s\S]*It is now 2026-11-16T09:00\.$/);
      return reply("Done.");
    }
    if (fail) throw new Error("You've reached your usage limit.");
    return reply("Time to call the garage.");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Errands", petId: "hop" })).json;
  await say(ME, agent.id, "set up");
  await queue.kick(agent.id);

  time = new Date(2026, 10, 16, 17, 0).getTime();
  await queue.kick(agent.id);
  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.equal(messages.at(-1).body, "Time to call the garage.");
  assert.equal(typeof messages.at(-1).job_id, "string");
  assert.deepEqual(store.jobs(agent.id).map((job) => job.what), ["Morning brief."]);

  // Friday's run fails, and so does the next Monday's. Simon says so once.
  fail = true;
  time = new Date(2026, 10, 20, 8, 0).getTime();
  await queue.kick(agent.id);
  assert.equal(store.jobs(agent.id)[0].next_at, new Date(2026, 10, 23, 8, 0).getTime());
  time = new Date(2026, 10, 23, 8, 0).getTime();
  await queue.kick(agent.id);
  const after = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json.map((m: { body: string }) => m.body);
  assert.deepEqual(after.slice(-2), ["Time to call the garage.", "Simon couldn't run a job. You've reached your usage limit."]);
});

test("a reply to a message tells the agent which one, and the chat pages back through older messages", async () => {
  const prompts: string[] = [];
  const { store, queue, call, say, app } = setup(async (turn) => {
    prompts.push(turn.prompt.text);
    return reply("The florist is Petal & Co.");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Wedding", petId: "mochi" })).json;
  await say(ME, agent.id, "who is the florist?");
  await queue.kick(agent.id);
  const [, answer] = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;

  const form = new FormData();
  form.append("body", "call them");
  form.append("replyTo", answer.id);
  const sent = await (await app.request(`/agents/${agent.id}/messages`, { method: "POST", headers: { "Tailscale-User-Login": ME }, body: form })).json();
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
  const { store, queue, call, say } = setup(async () => reply("Booked."));
  const sent: Notice[] = [];
  startPush(store, async (_device, notice) => {
    sent.push(notice);
    return "sent";
  });
  await call(ME, "POST", "/devices", { token: "a".repeat(64), topic: "com.example.simon", environment: "production" });
  const loud = (await call(ME, "POST", "/agents", { name: "Errands", petId: "hop" })).json;
  const quiet = (await call(ME, "POST", "/agents", { name: "Scout", petId: "moss" })).json;
  await call(ME, "PATCH", `/agents/${loud.id}`, { hidden: true });
  await call(ME, "PATCH", `/agents/${quiet.id}`, { hidden: true, muted: true });

  await say(ME, quiet.id, "book it");
  await queue.kick(quiet.id);
  await say(ME, loud.id, "book it");
  await queue.kick(loud.id);

  const agents = (await call(ME, "GET", "/agents")).json as { id: string; hidden: boolean; unread: number }[];
  const of = (id: string) => agents.find((agent) => agent.id === id)!;
  assert.deepEqual([of(loud.id).hidden, of(quiet.id).hidden, of(quiet.id).unread], [false, true, 1]);
  assert.deepEqual(sent.map((notice) => [notice.agentId, notice.badge]), [[loud.id, 1]]);
});

test("a database from before a column was added gets it, with what it held kept", () => {
  const home = mkdtempSync(join(tmpdir(), "simon-test-"));
  const old = new DatabaseSync(join(home, "simon.sqlite"));
  old.exec(`
    create table people (id text primary key, name text not null, tailscale_login text not null unique, claude_config_dir text not null);
    create table agents (id text primary key, person_id text not null references people(id), name text not null, pet_id text not null, session_id text, read_at integer not null default 0, created_at integer not null);
    create table messages (id text primary key, agent_id text not null references agents(id), sender text not null, body text not null, attachments text not null default '[]', status text not null, created_at integer not null);
    insert into people values ('p', 'Alex', 'alex@example.com', '/config');
    insert into agents values ('a', 'p', 'Scout', 'moss', 's', 0, 1);
    insert into messages values ('m', 'a', 'person', 'hello', '[]', 'done', 1);
  `);
  old.close();

  for (const _open of [1, 2]) {
    const store = openStore(home);
    assert.deepEqual(store.agent("a"), { id: "a", person_id: "p", name: "Scout", pet_id: "moss", model: "opus", effort: "medium", muted: false, hidden: false, session_id: "s", read_at: 0, created_at: 1 });
    assert.deepEqual(store.messages("a").map((m) => [m.body, m.reply_to, m.job_id]), [["hello", null, null]]);
    store.close();
  }
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
    return { sessionId: "session-1", contextTokens: 0 };
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Wedding", petId: "mochi" })).json;
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
  const { store, queue, call, say } = setup(async (turn) => {
    answers.push(turn.sendUpdate!("Started."));
    time += 2 * 60_000;
    answers.push(turn.sendUpdate!("Found three flats, checking the third."));
    time += 60_000;
    answers.push(turn.sendUpdate!("Still checking."));
    return reply("Here are the three flats.");
  }, () => time);
  const sent: Notice[] = [];
  startPush(store, async (_device, notice) => {
    sent.push(notice);
    return "sent";
  });
  await call(ME, "POST", "/devices", { token: "a".repeat(64), topic: "com.example.simon", environment: "production" });
  const agent = (await call(ME, "POST", "/agents", { name: "Scout", petId: "moss" })).json;
  await new Promise((resolve) => setTimeout(resolve, 1));
  await say(ME, agent.id, "find me a flat");
  await queue.kick(agent.id);

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

test("a job's run can't send updates", async () => {
  let time = new Date(2026, 10, 16, 9, 0).getTime();
  const updates: boolean[] = [];
  const { queue, call, say } = setup(async (turn) => {
    if (turn.prompt.text === "set up") turn.scheduleJob({ what: "Check.", every_minutes: 5 });
    else updates.push(turn.sendUpdate !== undefined);
    return reply("SILENT");
  }, () => time);
  const agent = (await call(ME, "POST", "/agents", { name: "Scout", petId: "moss" })).json;
  await say(ME, agent.id, "set up");
  await queue.kick(agent.id);
  time += 5 * 60_000;
  await queue.kick(agent.id);
  assert.deepEqual(updates, [false]);
});
