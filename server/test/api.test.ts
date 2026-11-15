import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { createQueue, type RunTurn } from "../src/runner.ts";
import { createApi } from "../src/api.ts";

function setup(runTurn: RunTurn) {
  const home = mkdtempSync(join(tmpdir(), "julius-test-"));
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
  return { store, queue, call };
}

const ME = "alex@example.com";
const HER = "robin@example.com";

test("a message gets the agent's reply, run in the agent's folder under its owner's login", async () => {
  const turns: Parameters<RunTurn>[0][] = [];
  const { store, queue, call } = setup(async (turn) => {
    turns.push(turn);
    return { reply: `You said: ${turn.prompt}`, sessionId: "session-1" };
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Wedding", petId: "mochi" })).json;

  const sent = await call(ME, "POST", `/agents/${agent.id}/messages`, { body: "hello" });
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
  const { queue, call } = setup(async (turn) => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push([turn.prompt, turn.sessionId]);
    running--;
    return { reply: "ok", sessionId: "session-1" };
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Money", petId: "cog" })).json;

  for (const body of ["one", "two", "three"]) await call(ME, "POST", `/agents/${agent.id}/messages`, { body });
  await queue.kick(agent.id);

  assert.equal(most, 1);
  assert.deepEqual(seen, [
    ["one", null],
    ["two", "session-1"],
    ["three", "session-1"],
  ]);
});

test("a failed turn keeps the message and adds a note from Julius saying why", async () => {
  const { queue, call } = setup(async () => {
    throw new Error("You've reached your usage limit.");
  });
  const agent = (await call(ME, "POST", "/agents", { name: "Scout", petId: "moss" })).json;

  await call(ME, "POST", `/agents/${agent.id}/messages`, { body: "find me a flat" });
  await queue.kick(agent.id);

  const messages = (await call(ME, "GET", `/agents/${agent.id}/messages`)).json;
  assert.deepEqual(
    messages.map((m: { sender: string; body: string; status: string }) => [m.sender, m.body, m.status]),
    [
      ["person", "find me a flat", "failed"],
      ["julius", "Julius couldn't finish this. You've reached your usage limit.", "done"],
    ],
  );
});

test("each person only reaches their own agents", async () => {
  const { call } = setup(async () => ({ reply: "ok", sessionId: "s" }));
  const mine = (await call(ME, "POST", "/agents", { name: "Gym", petId: "hop" })).json;

  assert.deepEqual((await call(HER, "GET", "/agents")).json, []);
  assert.equal((await call(HER, "GET", `/agents/${mine.id}/messages`)).status, 404);
  assert.equal((await call(HER, "POST", `/agents/${mine.id}/messages`, { body: "hi" })).status, 404);
  assert.equal((await call("stranger@example.com", "GET", "/agents")).status, 403);
});

test("after a known message returns only what came later", async () => {
  const { queue, call } = setup(async (turn) => ({ reply: `re: ${turn.prompt}`, sessionId: "s" }));
  const agent = (await call(ME, "POST", "/agents", { name: "Books", petId: "wisp" })).json;
  const first = (await call(ME, "POST", `/agents/${agent.id}/messages`, { body: "first" })).json;
  await queue.kick(agent.id);

  const later = (await call(ME, "GET", `/agents/${agent.id}/messages?after=${first.id}`)).json;
  assert.deepEqual(later.map((m: { body: string }) => m.body), ["re: first"]);
});
