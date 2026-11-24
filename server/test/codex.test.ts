import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexOn, costOf, effortOn, limitsIn, newest, question, tierOn } from "../src/codex.ts";
import type { FollowUps, Prompt, Turn } from "../src/runner.ts";
import type { Limit, Question } from "../src/contract.ts";

test("a kind of model is the newest version of it that Codex offers", () => {
  const offered = ["gpt-6-sol", "gpt-6.2-sol", "gpt-6.10-sol", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-reserve"].map((model) => ({ model }));
  assert.equal(newest(offered, "sol")?.model, "gpt-6.10-sol");
  assert.equal(newest(offered, "astra")?.model, "gpt-6.2-astra");
  assert.equal(newest(offered, "luna"), undefined);
});

test("a turn runs at the agent's effort, or at the highest its model has when it hasn't that one", () => {
  const luna = { model: "gpt-6-luna", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort })) };
  assert.equal(effortOn(luna, "xhigh"), "xhigh");
  assert.equal(effortOn(luna, "ultra"), "max");
});

test("a fast turn answers at the mildest of its model's faster tiers, and any other at its standard one", () => {
  const efforts = [{ reasoningEffort: "medium" }];
  const sol = { model: "gpt-6.2-sol", supportedReasoningEfforts: efforts, serviceTiers: [{ id: "priority" }, { id: "ultrafast" }] };
  assert.equal(tierOn(sol, true), "priority");
  assert.equal(tierOn(sol, false), "default");
  // A model with no faster tier answers at its standard one.
  assert.equal(tierOn({ model: "gpt-5-sol", supportedReasoningEfforts: efforts }, true), "default");
});

test("a plan's limits are the windows Codex gives its own limit, named for how long each runs", () => {
  const resetsAt = 1795111200;
  const window = (windowDurationMins: number | null, usedPercent: number) => ({ usedPercent, windowDurationMins, resetsAt });
  assert.deepEqual(limitsIn({ limitId: "codex", primary: window(300, 40), secondary: window(10080, 2) }, 5), [
    { name: "5-hour limit", used: 0.4, resets_at: resetsAt * 1000, at: 5 },
    { name: "Weekly limit", used: 0.02, resets_at: resetsAt * 1000, at: 5 },
  ]);
  assert.deepEqual(limitsIn({ limitId: null, primary: window(43200, 100), secondary: null }, 5), [{ name: "Monthly limit", used: 1, resets_at: resetsAt * 1000, at: 5 }]);
  // A limit one model has apart from the plan's is none of the plan's.
  assert.deepEqual(limitsIn({ limitId: "codex_other", primary: window(300, 40), secondary: null }, 5), []);
});

test("tokens are priced at the model's API prices, with the ones read from the cache and written to it counted apart", () => {
  const tokens = { totalTokens: 0, inputTokens: 1_000_000, cachedInputTokens: 600_000, cacheWriteInputTokens: 100_000, outputTokens: 10_000 };
  // 300,000 fresh at $2, 600,000 cached at $0.10, 100,000 written at $2.50 and 10,000 out at $10, each for a million.
  assert.equal(costOf(tokens, "sol").toFixed(4), "1.0100");
  assert.equal(costOf(tokens, "luna").toFixed(4), "0.0535");
});

test("what Codex asks leads with plain words and keeps the thing itself as its detail", () => {
  assert.deepEqual(question({ command: "/bin/zsh -lc 'curl -X POST https://shop.example/book'", cwd: `${homedir()}/work`, commandActions: [{ command: "curl -X POST https://shop.example/book" }], reason: "It sends data." }), {
    kind: "command",
    title: "Run a command",
    what: "curl -X POST https://shop.example/book",
    facts: [["In", "~/work"]],
    detail: "/bin/zsh -lc 'curl -X POST https://shop.example/book'",
    why: "It sends data.",
  });
  const plan = { path: `${homedir()}/Documents/plan.md`, kind: { type: "add" as const }, diff: "+one line" };
  assert.deepEqual(question({ changes: [plan] }), {
    kind: "file",
    title: "Write a file",
    what: "plan.md",
    facts: [["In", "~/Documents"]],
    detail: `${plan.path}\n\n+one line`,
  });
  const both = question({ changes: [plan, { path: "/tmp/old.md", kind: { type: "delete" }, diff: "-gone" }] });
  assert.deepEqual([both.title, both.what, both.facts], ["Change files", "2 files", []]);
});

/** The Codex driver, run against the stand-in for Codex in a config folder of its own. */
function setup({ signedIn = true, keyLogin = false } = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "sidebots-codex-"));
  if (signedIn) writeFileSync(join(configDir, "auth.json"), keyLogin ? '{"OPENAI_API_KEY":"sk-saved-key"}' : "{}");
  const driver = codexOn(async () => ({ command: [process.execPath, fileURLToPath(new URL("./codex-peer.ts", import.meta.url))], env: process.env }));
  const seen: string[] = [];
  const replies: [string, string[]][] = [];
  const asks: Question[] = [];
  const limits: Limit[][] = [];
  /** A turn on a message, with whatever else the test says of it. */
  const turn = (text: string, rest: Partial<Turn> = {}): Turn => ({
    prompt: { id: "first", text },
    seen: (ids) => seen.push(...ids),
    replied: (reply, ids) => replies.push([reply, ids]),
    cwd: "/agents/maya",
    sessionId: null,
    spent: { cost: 0, tokens: 0 },
    configDir,
    model: "sol",
    effort: "medium",
    fast: false,
    keepSession: true,
    stop: new AbortController(),
    searchHistory: (search) => `Found ${search}.`,
    scheduleJob: () => "",
    listJobs: () => "",
    cancelJob: () => "",
    sendFiles: () => "",
    listAgents: () => "",
    askAgent: () => "",
    connect: async () => "",
    useConnection: async (tool) => `Used ${tool}.`,
    servers: async () => ({}),
    ask: async (question) => (asks.push(question), { allowed: true }),
    limits: (said) => limits.push(said),
    ...rest,
  });
  /** What the driver asked of Codex, in order: each request's method and what it sent with it. */
  const requests = () =>
    readFileSync(join(configDir, "requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params: Record<string, never> })
      .filter((each) => each.method);
  return { driver, configDir, turn, seen, replies, asks, limits, requests };
}

/** Messages the person sends once the turn has read its first, the way the runner hands them over. */
function arriving(messages: Prompt[], when: { seen: string[] }): FollowUps {
  let waiting: Prompt[] = [];
  return {
    take: () => waiting.splice(0),
    onArrival: (listener) => {
      const timer = setInterval(() => {
        if (when.seen.length === 0) return;
        clearInterval(timer);
        waiting = messages;
        listener();
      }, 5);
      return () => clearInterval(timer);
    },
  };
}

test("a turn starts a thread with the agent's tools, on the newest model of its kind, and its reply is the agent's answer", async () => {
  const { driver, turn, seen, replies, limits, requests } = setup();
  const result = await driver.runTurn(turn("hello"));
  assert.deepEqual(seen, ["first"]);
  // What the agent said as it worked is no part of the reply.
  assert.deepEqual(replies, [["Read: hello", ["first"]]]);
  // A million tokens read on Sol, as Codex counts the thread so far, and the 5,000 its last step held.
  assert.deepEqual(result, { sessionId: "thread-1", contextTokens: 5000, cost: 2, tokens: 1_000_000 });
  assert.deepEqual(limits.at(-1)!.map(({ name, used, resets_at }) => [name, used, resets_at]), [["5-hour limit", 0.25, 1795111200000]]);

  const started = requests().find((each) => each.method === "thread/start")!.params;
  assert.deepEqual(
    [started.cwd, started.model, started.approvalPolicy, started.approvalsReviewer, started.sandbox, started.ephemeral],
    ["/agents/maya", "gpt-6.2-sol", "on-request", "auto_review", "workspace-write", false],
  );
  // Every tool is there from the start, `send_update` too, since a thread keeps the tools it started with.
  const tools = (started.dynamicTools as { name: string; inputSchema: { properties: object } }[]).map((tool) => tool.name);
  assert.deepEqual(tools, [
    ...["search_history", "schedule_job", "list_jobs", "cancel_job", "list_agents", "ask_agent", "send_files", "connect"],
    ...["gmail_search", "gmail_read", "gmail_send", "calendar_events", "calendar_event", "calendar_list", "calendar_add_event", "calendar_change_event", "calendar_remove_event", "send_update"],
  ]);
  assert.match(started.developerInstructions, /memory\/MEMORY\.md/);
  // The agent is told when its reply comes with something to look at.
  assert.match(started.developerInstructions, /better seen than read/);
  const first = requests().find((each) => each.method === "turn/start")!.params;
  assert.deepEqual([first.effort, first.serviceTier], ["medium", "default"]);
});

test("a fast turn asks Codex for its model's fast tier", async () => {
  const { driver, turn, requests } = setup();
  await driver.runTurn(turn("hello", { fast: true }));
  assert.equal(requests().find((each) => each.method === "turn/start")!.params.serviceTier, "priority");
});

test("a later turn resumes the thread, and a job's run has a thread that isn't kept", async () => {
  const { driver, turn, requests } = setup();
  // The thread had used three million tokens and cost $10. This turn's million are read on Luna, whatever the ones before were read on.
  const result = await driver.runTurn(turn("hello", { sessionId: "thread-9", spent: { cost: 10, tokens: 3_000_000 }, model: "luna" }));
  assert.equal(result.sessionId, "thread-9");
  assert.equal(result.cost.toFixed(2), "10.10");
  assert.equal(result.tokens, 4_000_000);
  const methods = () => requests().map((each) => each.method);
  assert.ok(methods().includes("thread/resume") && !methods().includes("thread/start"));
  assert.equal(requests().find((each) => each.method === "thread/resume")!.params.threadId, "thread-9");

  await driver.runTurn(turn("hello", { keepSession: false }));
  assert.equal(requests().find((each) => each.method === "thread/start")!.params.ephemeral, true);
});

test("a message sent while the turn runs goes into it, and the reply answers both", async () => {
  const { driver, turn, seen, replies } = setup();
  await driver.runTurn(turn("hold on", { followUps: arriving([{ id: "second", text: "and this" }], { seen }) }));
  assert.deepEqual(seen, ["first", "second"]);
  assert.deepEqual(replies, [["Read: hold on | and this", ["first", "second"]]]);
});

test("a message that arrives as the turn is ending gets a turn and a reply of its own, in the same thread", async () => {
  const { driver, turn, seen, replies, requests } = setup();
  const result = await driver.runTurn(turn("refuse the next", { followUps: arriving([{ id: "second", text: "too late" }], { seen }) }));
  assert.deepEqual(replies, [
    ["Read: refuse the next", ["first"]],
    ["Read: too late", ["second"]],
  ]);
  assert.deepEqual(requests().filter((each) => each.method === "turn/start").map((each) => each.params.clientUserMessageId), ["first", "second"]);
  // Two turns of a million tokens each, as Codex counts the thread.
  assert.equal(result.cost, 4);
  assert.equal(result.tokens, 2_000_000);
});

test("the agent's tools answer in words, and a call that is wrong says so to the agent", async () => {
  const { driver, turn, replies } = setup();
  await driver.runTurn(turn("tool search_history bikes"));
  await driver.runTurn(turn("tool send_update Nearly"));
  await driver.runTurn(turn("tool send_update Nearly", { sendUpdate: (text) => `Sent ${text}.` }));
  await driver.runTurn(turn("tool fly away"));
  assert.deepEqual(
    replies.map(([reply]) => reply),
    ["Tool said: Found bikes.", "Tool said: Nobody is waiting on this turn, so there is nobody to update. Carry on.", "Tool said: Sent Nearly.", "Tool failed: You have no tool called fly."],
  );
  // A call without what the tool takes.
  await driver.runTurn(turn("tool search_history"));
  assert.match(replies.at(-1)![0], /^Tool failed: .*expected string/s);
});

test("a tool that acts as the person outside the machine asks them first, and one that only reads runs", async () => {
  const { driver, turn, replies, asks } = setup();
  await driver.runTurn(turn("tool gmail_read m1"));
  assert.deepEqual(asks, []);
  await driver.runTurn(turn("tool calendar_remove_event e1"));
  await driver.runTurn(turn("tool calendar_remove_event e1", { ask: async () => ({ allowed: false, words: "No." }) }));
  assert.deepEqual(asks, [{ kind: "tool", title: "Use Sidebots", what: "Calendar remove event", facts: [["Id", "e1"]], detail: JSON.stringify({ id: "e1" }, null, 2) }]);
  assert.deepEqual(replies.map(([reply]) => reply), ["Tool said: Used gmail_read.", "Tool said: Used calendar_remove_event.", "Tool failed: No."]);

  // A yes that comes once the person has stopped the turn acts on nothing.
  const stop = new AbortController();
  const used: string[] = [];
  await driver.runTurn(turn("tool calendar_remove_event e1", { stop, ask: async () => (stop.abort(), { allowed: true }), useConnection: async (tool) => (used.push(tool), "") }));
  assert.deepEqual(used, []);
});

test("a thread is given the tool servers of the person's connections as it starts and as it resumes, each with its token, as Codex's settings name one", async () => {
  const { driver, turn, requests } = setup();
  const servers = async () => ({ notion: { url: "https://mcp.notion.com/mcp", token: "access-1" } });
  const { sessionId } = await driver.runTurn(turn("hello", { servers }));
  // A thread reads its servers as it starts and as it resumes, so one made since the last turn is there.
  await driver.runTurn(turn("hello", { sessionId, servers }));
  for (const method of ["thread/start", "thread/resume"]) {
    assert.deepEqual(requests().find((each) => each.method === method)!.params.config, {
      "memories.use_memories": false,
      "memories.generate_memories": false,
      "mcp_servers.notion": { url: "https://mcp.notion.com/mcp", http_headers: { Authorization: "Bearer access-1" } },
    });
  }
});

test("what Codex asks its client before it acts goes to the person, whose answer it takes", async () => {
  const { driver, turn, replies, asks } = setup();
  await driver.runTurn(turn("command"));
  await driver.runTurn(turn("patch", { ask: async (question) => (asks.push(question), { allowed: false, words: "No." }) }));
  assert.deepEqual(asks.map((ask) => [ask.title, ask.what, ask.detail, ask.why]), [
    ["Run a command", "rm -rf old", "/bin/zsh -lc 'rm -rf old'", "It deletes files."],
    ["Change a file", "plan.md", "/work/plan.md\n\n-a\n+b", undefined],
  ]);
  assert.deepEqual(replies.map(([reply]) => reply), ["The command: accept.", "The change: decline."]);
});

test("a stopped turn ends with no reply and keeps its thread", async () => {
  const { driver, turn, seen, replies, requests } = setup();
  const stopped = turn("hold on");
  const poll = setInterval(() => seen.length && stopped.stop.abort(), 5);
  const result = await driver.runTurn(stopped);
  clearInterval(poll);
  assert.equal(result.sessionId, "thread-1");
  assert.deepEqual(replies, []);
  assert.equal(requests().find((each) => each.method === "turn/interrupt")!.params.turnId, "turn-1");
});

test("a turn runs on the person's API key when they have one, handed to Codex to keep in its memory", async () => {
  const { driver, turn, replies, requests } = setup({ signedIn: false });
  await driver.runTurn(turn("hello", { apiKey: "sk-alexs-key" }));
  assert.deepEqual(replies, [["Read: hello", ["first"]]]);
  assert.deepEqual(requests().find((each) => each.method === "account/login/start")!.params, { type: "apiKey", apiKey: "sk-alexs-key" });
});

test("a failed turn says why in words for the phone", async () => {
  const signedOut = setup({ signedIn: false });
  const words = async (run: Promise<unknown>, driver: typeof signedOut.driver) => driver.failure(await run.then(() => "", (error: Error) => error.message));
  assert.equal(await words(signedOut.driver.runTurn(signedOut.turn("hello")), signedOut.driver), "Codex on your computer is signed out. Sign in to it there.");

  const { driver, turn } = setup();
  assert.equal(await words(driver.runTurn(turn("fail")), driver), "Your Codex usage limit is reached. It resets at 3:37 PM.");
  assert.equal(await words(driver.runTurn(turn("hello", { model: "astra" })), driver), "Codex offers this account no GPT-6.2 Astra model.");
  assert.equal(driver.failure("Incorrect API key provided: sk-12345."), "OpenAI refused your API key. Save a new one on your computer.");
  assert.equal(driver.failure("stream disconnected before completion"), "stream disconnected before completion");
});

test("asked where a plan's limits stand, Codex says with no thread started, and the plan's own limit is the one that counts", async () => {
  const { driver, configDir, requests } = setup();
  const limits = await driver.limits(configDir, new AbortController().signal);
  assert.deepEqual(limits!.map(({ name, used, resets_at }) => [name, used, resets_at]), [["Weekly limit", 0.03, 1795623087000]]);
  assert.deepEqual(requests().map((each) => each.method), ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
});

test("a login that is an API key has no plan, so Codex isn't asked for its limits", async () => {
  const { driver, configDir, requests } = setup({ keyLogin: true });
  assert.equal(await driver.limits(configDir, new AbortController().signal), null);
  assert.deepEqual(requests().map((each) => each.method), ["initialize", "initialized", "account/read"]);
});

test("a deleted agent's threads go, the ones Codex lists for its folder", async () => {
  const { driver, configDir, requests } = setup();
  await driver.forget("/agents/maya", configDir);
  assert.ok(existsSync(join(configDir, "deleted")));
  assert.equal(requests().find((each) => each.method === "thread/list")!.params.cwd, "/agents/maya");
  assert.deepEqual(requests().filter((each) => each.method === "thread/delete").map((each) => each.params.threadId), ["thread-1", "thread-2"]);
});
