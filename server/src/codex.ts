// Codex as a provider: the agent's turns run through `codex app-server`, the
// program Codex's own apps drive it with, which speaks JSON-RPC on its input
// and output, one message to a line. It runs the Codex the person installed,
// and is the only module that starts it.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { PROVIDERS, type Limit, type Question } from "./contract.ts";
import { environment, inFolder, later, program } from "./programs.ts";
import { short, toolsFor, type Driver, type Prompt, type RunTurn } from "./runner.ts";

// Added to Codex's own prompt. Codex keeps what it remembers in its config folder, for everything that runs there, so an agent keeps its own in its folder, in the files its page in the app shows.
const MEMORY = `You have a memory that outlives every session: the folder \`memory/\` in your home folder. Each memory is a file of its own there, named for what it is about and ending in \`.md\`. It starts with a name and a one-line description between \`---\` lines, then the memory itself:

---
name: A few words
description: One line that says what this memory holds
---

\`memory/MEMORY.md\` lists the memories, one line each. Read it when a session starts, and read a memory it lists when it bears on what you are asked. Save what is worth keeping as you learn it: who the person is, what they want from you, what was decided. Change a memory that is no longer true, remove one that no longer matters, and keep MEMORY.md in step.`;

// The longest Codex is given to end a turn it was told to stop, before its process is ended for it.
const STOP_WAIT_MS = 10_000;

/**
 * OpenAI's API prices for each kind of model, in US dollars for a million
 * tokens: ones the model reads, ones it reads from its cache, ones it writes
 * there, and ones it writes as its answer.
 */
const PRICES: Record<keyof typeof PROVIDERS.codex.models, { input: number; cached: number; written: number; output: number }> = {
  astra: { input: 8, cached: 0.4, written: 10, output: 40 },
  sol: { input: 2, cached: 0.1, written: 2.5, output: 10 },
  terra: { input: 1, cached: 0.05, written: 1.25, output: 5 },
  luna: { input: 0.1, cached: 0.01, written: 0.125, output: 0.5 },
};

/** The tokens a session has used, as Codex counts them. It counts the ones read from the cache and written to it among the ones read. */
type Tokens = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number };
/** Where Codex's count of a thread stands after one of its turns: all the thread has used, and what its last step held. */
type Count = { turnId: string; tokenUsage: { total: Tokens; last: Tokens } };

/** What tokens cost on a kind of model, in US dollars at OpenAI's API prices. Codex counts tokens and says nothing of money. */
export function costOf(tokens: Tokens, model: string): number {
  const price = PRICES[model as keyof typeof PRICES];
  const fresh = tokens.inputTokens - tokens.cachedInputTokens - tokens.cacheWriteInputTokens;
  return (fresh * price.input + tokens.cachedInputTokens * price.cached + tokens.cacheWriteInputTokens * price.written + tokens.outputTokens * price.output) / 1_000_000;
}

/**
 * The newest model of a kind among the ones Codex offers, by Codex's own
 * name for it, as `gpt-6.2-sol` is for `sol`. Codex names a model for its
 * version and its kind, and offers the older versions beside the newest.
 */
export function newest(models: { model: string }[], kind: string): string | undefined {
  const versions = models.flatMap(({ model }) => {
    const version = new RegExp(`^gpt-([\\d.]+)-${kind}$`).exec(model)?.[1];
    return version ? [{ model, version }] : [];
  });
  return versions.sort((a, b) => later(b.version, a.version))[0]?.model;
}

type Window = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
/** What Codex says of one limit: its id, and the windows it runs in. */
type Said = { limitId: string | null; primary: Window | null; secondary: Window | null };
const HOUR = 60;
const DAY = 24 * HOUR;
/** What a limit is called, from how long it runs before it resets. */
function limitName(minutes: number): string {
  if (minutes >= 28 * DAY) return "Monthly limit";
  if (minutes === 7 * DAY) return "Weekly limit";
  return minutes >= DAY ? `${Math.round(minutes / DAY)}-day limit` : `${Math.round(minutes / HOUR)}-hour limit`;
}

/**
 * Where limits of the person's plan stand, from what Codex says of them at
 * `at`, as a turn runs: the part of each that is used and, in seconds, when
 * it resets. Codex speaks of the plan's own limits under the id `codex`, and
 * of a limit one model has apart from them under another, which is left out.
 */
export function limitsIn(said: Said, at: number): Limit[] {
  if (said.limitId !== null && said.limitId !== "codex") return [];
  return [said.primary, said.secondary].flatMap((window) =>
    window?.windowDurationMins ? [{ name: limitName(window.windowDurationMins), used: window.usedPercent / 100, resets_at: window.resetsAt === null ? null : window.resetsAt * 1000, at }] : [],
  );
}

/** A change Codex wants to make to a file: the file, whether it is new, going or changing, and the change as a diff. */
type Change = { path: string; kind: { type: "add" | "delete" | "update" }; diff: string };
/** What Codex asks its client before it acts: a command, with where it runs and how Codex read it out of its shell, or changes to files, and its reason for asking. */
type Asked = { command?: string | null; cwd?: string | null; commandActions?: { command: string }[] | null; changes?: Change[]; reason?: string | null };

/**
 * What Codex asks before it runs a command or changes files outside its
 * sandbox, in the parts the person reads to say yes or no. A command leads
 * with its first line, as Codex read it out of the shell it runs in. A change
 * leads with its file, or with how many files it is to. `why` is Codex's
 * reason for asking.
 */
export function question(asked: Asked): Question {
  const ask = (kind: Question["kind"], title: string, what: string, detail: string, where: string | null | undefined): Question => ({
    kind,
    title,
    what,
    facts: where ? [["In", where.replace(homedir(), "~")]] : [],
    detail,
    ...(asked.reason ? { why: asked.reason } : {}),
  });
  if (!asked.changes) {
    const command = asked.command ?? "";
    return ask("command", "Run a command", short((asked.commandActions?.[0]?.command ?? command).split("\n")[0]), command, asked.cwd);
  }
  const detail = asked.changes.map((change) => `${change.path}\n\n${change.diff}`).join("\n\n");
  const [only] = asked.changes;
  if (asked.changes.length !== 1) return ask("file", "Change files", `${asked.changes.length} files`, detail, null);
  const title = { add: "Write a file", delete: "Delete a file", update: "Change a file" }[only.kind.type];
  return ask("file", title, basename(only.path), detail, dirname(only.path));
}

/** A step of a turn, as Codex tells of it: a message the agent was sent, something it said, a change to files. Each kind has its own parts. */
type Item = { type: string; id: string; clientId?: string | null; text?: string; phase?: string | null; changes?: Change[] };
/** How a turn of Codex's ended. */
type Ended = { status: "completed" | "interrupted" | "failed"; error: { message: string } | null };

/** How Codex is started: its command, with what comes before `app-server` on its line, and what it runs with. */
export type Start = { command: string[]; env: NodeJS.ProcessEnv };

/**
 * A running `codex app-server` in the person's config folder. `request` asks
 * it something and waits for its answer. `on` hears what it says by itself,
 * and `serve` answers what it asks, with a signal that aborts when it stops
 * waiting for the answer. `gone` rejects once the process has ended. With
 * `keyed`, it keeps the login it is given in its memory and reads none from
 * the config folder.
 */
function connect({ command, env }: Start, configDir: string, keyed = false) {
  // Codex won't start in a config folder that isn't there, as one is for a person who has yet to sign in.
  mkdirSync(configDir, { recursive: true });
  const child = spawn(command[0], [...command.slice(1), "app-server", ...(keyed ? ["-c", 'cli_auth_credentials_store="ephemeral"'] : [])], {
    env: inFolder("codex", configDir, env),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const answers = new Map<number, { resolve: (result: never) => void; reject: (error: Error) => void }>();
  const heard = new Map<string, (params: never) => void>();
  const served = new Map<string, (params: never, withdrawn: AbortSignal) => unknown>();
  // What Codex has asked and not been answered, each with what tells its answerer that Codex stopped waiting.
  const asked = new Map<number | string, AbortController>();
  let sent = 0;
  let ended: Error | null = null;
  let lost!: (error: Error) => void;
  const gone = new Promise<never>((_, reject) => (lost = reject));
  gone.catch(() => undefined);
  const end = (error: Error) => {
    if (ended) return;
    ended = error;
    for (const answer of answers.values()) answer.reject(error);
    for (const waiting of asked.values()) waiting.abort();
    lost(error);
  };
  const send = (message: object) => void (ended || child.stdin.write(`${JSON.stringify(message)}\n`));
  child.stdin.on("error", () => undefined);
  child.on("error", (error) => end(new Error(`Codex couldn't start. ${error.message}`)));
  child.on("exit", () => end(new Error("Codex stopped without a reply")));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: { id?: number | string; method?: string; params?: never; result?: never; error?: { message: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === undefined) {
      const answer = answers.get(message.id as number);
      answers.delete(message.id as number);
      return message.error ? answer?.reject(new Error(message.error.message)) : answer?.resolve(message.result!);
    }
    if (message.id === undefined) return heard.get(message.method)?.(message.params!);
    // What Codex asks. One with nobody to answer it is refused, so Codex never waits on it.
    const { id, method, params } = message;
    const withdrawn = new AbortController();
    asked.set(id, withdrawn);
    Promise.resolve()
      .then(() => {
        const answer = served.get(method);
        if (!answer) throw new Error(`Sidebots doesn't answer ${method}.`);
        return answer(params!, withdrawn.signal);
      })
      .then(
        (result) => send({ id, result }),
        (error: Error) => send({ id, error: { code: -32601, message: error.message } }),
      )
      .finally(() => asked.delete(id));
  });
  heard.set("serverRequest/resolved", ({ requestId }: { requestId: number | string }) => asked.get(requestId)?.abort());
  return {
    gone,
    request: <Result = unknown>(method: string, params: object) =>
      new Promise<Result>((resolve, reject) => {
        if (ended) return reject(ended);
        answers.set(++sent, { resolve, reject });
        send({ id: sent, method, params });
      }),
    notify: (method: string) => send({ method }),
    on: <Said>(method: string, hear: (params: Said) => void) => void heard.set(method, hear),
    serve: <Wanted>(method: string, answer: (params: Wanted, withdrawn: AbortSignal) => unknown) => void served.set(method, answer),
    close: () => void child.kill(),
  };
}
type Codex = ReturnType<typeof connect>;

/** Greets Codex, as its protocol asks before anything else. Sidebots uses parts of the protocol Codex still calls experimental: the agent's tools and the reviewer of what it does. */
async function greet(codex: Codex): Promise<void> {
  await codex.request("initialize", { clientInfo: { name: "sidebots", title: "Sidebots", version: "1" }, capabilities: { experimentalApi: true } });
  codex.notify("initialized");
}

const text = (words: string) => [{ type: "text", text: words, text_elements: [] }];
const said = (words: string, success = true) => ({ contentItems: [{ type: "inputText", text: words }], success });

/**
 * Runs a turn through Codex, in a thread of Codex's, which is the agent's
 * session. A message the person sends while the turn runs is steered into it:
 * Codex hands it to the agent at its next pause between steps, and the reply
 * answers both. One that arrives as the turn is finishing gets a turn of
 * Codex's own, in the same thread, and so a reply of its own.
 *
 * The agent works in Codex's sandbox, which lets it write in its own folder
 * and read the rest of the machine. Whatever needs more, such as the network
 * or a file elsewhere, goes to Codex's own reviewer, a model that allows what
 * is safe and what the person asked for. What Codex asks its client instead
 * goes to the person.
 *
 * A turn that is stopped ends through Codex's own interrupt, which ends the
 * command it was running and writes into the thread that the turn was
 * stopped. The thread stays whole, so the next turn resumes it.
 */
const runTurn = (start: () => Promise<Start>): RunTurn => async (turn) => {
  const { prompt, followUps, seen, replied, ask, limits, cwd, sessionId, spent, configDir, apiKey, model, effort, keepSession, stop } = turn;
  const codex = connect(await start(), configDir, apiKey !== undefined);
  // The thread the turn runs in, and whether Codex has anything of it to come back to: a new one is kept from its first turn.
  let threadId: string | null = null;
  let kept = sessionId !== null;
  // Codex counts a thread's tokens from its start, the turns before this run included, and says after which turn each count stands. The first it
  // says and the latest: as it resumes a thread, the first is where the count stood after a turn before this run.
  let counted: { first: Count; latest: Count } | undefined;
  // The turns this run started. The tokens they used are the run's own, and cost what its model does.
  const mine = new Set<string>();
  const result = (sessionId: string) => {
    const before = counted && !mine.has(counted.first.turnId) ? counted.first.tokenUsage.total : undefined;
    // What the run added to a count of the thread's tokens.
    const added = (count: (tokens: Tokens) => number) => (counted ? count(counted.latest.tokenUsage.total) - (before ? count(before) : 0) : 0);
    return {
      sessionId,
      contextTokens: counted?.latest.tokenUsage.last.totalTokens ?? 0,
      cost: spent.cost + added((tokens) => costOf(tokens, model)),
      tokens: spent.tokens + added((tokens) => tokens.totalTokens),
    };
  };
  // The turn of Codex's that is running.
  let running: string | null = null;
  const interrupt = () => void (running && codex.request("turn/interrupt", { threadId, turnId: running }).catch(() => undefined));
  let endLate: ReturnType<typeof setTimeout> | undefined;
  const onStop = () => {
    endLate = setTimeout(codex.close, STOP_WAIT_MS);
    interrupt();
  };
  stop.signal.addEventListener("abort", onStop);
  let stopListening: (() => void) | undefined;
  try {
    await greet(codex);
    // A key is handed to this one process, which keeps it in its memory, so the login in the config folder is left as it is.
    if (apiKey) await codex.request("account/login/start", { type: "apiKey", apiKey });
    else {
      const { account, requiresOpenaiAuth } = await codex.request<{ account: object | null; requiresOpenaiAuth: boolean }>("account/read", { refreshToken: false });
      if (!account && requiresOpenaiAuth) throw new Error("Not logged in");
    }
    const name = newest((await codex.request<{ data: { model: string }[] }>("model/list", {})).data, model);
    if (!name) throw new Error(`Codex offers this account no ${PROVIDERS.codex.models[model as keyof typeof PRICES]} model.`);
    const settings = {
      cwd,
      model: name,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      developerInstructions: MEMORY,
      // Codex's own memory is one for the whole config folder, and stays out of an agent's sessions both ways.
      config: { "memories.use_memories": false, "memories.generate_memories": false },
    };
    // A thread keeps the tools it starts with, so it starts with them all, and `send_update` answers for itself in a turn nobody waits on.
    const tools = toolsFor({ ...turn, sendUpdate: turn.sendUpdate ?? (() => "Nobody is waiting on this turn, so there is nobody to update. Carry on.") });
    const dynamicTools = tools.map((each) => ({ type: "function", name: each.name, description: each.description, inputSchema: z.toJSONSchema(z.object(each.input)) }));
    // Codex says where a thread's count stands straight after it resumes it.
    codex.on<Count>("thread/tokenUsage/updated", (count) => void (counted = { first: counted?.first ?? count, latest: count }));
    const { thread } = await (sessionId
      ? codex.request<{ thread: { id: string } }>("thread/resume", { threadId: sessionId, ...settings })
      : codex.request<{ thread: { id: string } }>("thread/start", { ...settings, dynamicTools, ephemeral: !keepSession }));
    threadId = thread.id;

    // Every tool runs as it is called. Codex's sandbox lets an agent read any file on the machine, which is all a checked tool does there.
    codex.serve<{ tool: string; arguments: unknown }>("item/tool/call", ({ tool, arguments: input }) => {
      const called = tools.find((each) => each.name === tool);
      const given = called && z.object(called.input).safeParse(input);
      if (!given) return said(`You have no tool called ${tool}.`, false);
      return given.success ? said(called.run(given.data)) : said(z.prettifyError(given.error), false);
    });

    // The files Codex is about to change, by the step that changes them, which its ask names.
    const changes = new Map<string, Change[]>();
    codex.on<{ item: Item }>("item/started", ({ item }) => void (item.changes && changes.set(item.id, item.changes)));
    const decide = async (asked: Asked, withdrawn: AbortSignal) => ({ decision: (await ask(question(asked), withdrawn)).allowed ? "accept" : "decline" });
    codex.serve<Asked>("item/commandExecution/requestApproval", decide);
    codex.serve<{ itemId: string; reason?: string | null }>("item/fileChange/requestApproval", ({ itemId, reason }, withdrawn) => decide({ changes: changes.get(itemId) ?? [], reason }, withdrawn));

    codex.on<{ rateLimits: Parameters<typeof limitsIn>[0] }>("account/rateLimits/updated", ({ rateLimits }) => limits(limitsIn(rateLimits, Date.now())));

    // The messages that wait for Codex's next turn, and those in the turn that is running: the ones Codex took into it, and the ones the agent has read.
    const next: Prompt[] = [prompt, ...(followUps?.take() ?? [])];
    const taken = new Map<string, Prompt>();
    const read = new Set<string>();
    // The agent's answer in the running turn so far, and what to call when the turn ends.
    let answer = "";
    let finish: (ended: Ended) => void = () => undefined;
    codex.on<{ item: Item }>("item/completed", ({ item }) => {
      if (item.type === "userMessage" && item.clientId && taken.has(item.clientId) && !read.has(item.clientId)) {
        read.add(item.clientId);
        seen([item.clientId]);
      }
      // What the agent says as it works is not its answer.
      if (item.type === "agentMessage" && item.phase !== "commentary") answer = item.text ?? "";
    });
    codex.on<{ turn: Ended }>("turn/completed", ({ turn: ended }) => finish(ended));

    // Messages go into the running turn one after another. Each counts as taken from when it is sent, since Codex can say the agent read it along with its answer that it took it. One Codex won't take, as the turn is ending, waits for the next.
    let steering = Promise.resolve();
    const steer = (message: Prompt) => {
      steering = steering.then(() => {
        taken.set(message.id, message);
        return codex.request("turn/steer", { threadId, expectedTurnId: running, clientUserMessageId: message.id, input: text(message.text) }).then(
          () => undefined,
          () => void (taken.delete(message.id), next.push(message)),
        );
      });
    };
    stopListening = followUps?.onArrival(() => {
      if (stop.signal.aborted) return;
      for (const message of followUps.take()) running ? steer(message) : next.push(message);
    });

    while (next.length && !stop.signal.aborted) {
      // The first message starts the turn and the rest go into it, each under its own id, so Codex says when the agent has read each.
      const [first, ...rest] = next.splice(0);
      taken.clear();
      read.clear();
      answer = "";
      taken.set(first.id, first);
      const ended = new Promise<Ended>((resolve) => (finish = resolve));
      const started = await codex.request<{ turn: { id: string } }>("turn/start", { threadId, clientUserMessageId: first.id, input: text(first.text), effort });
      running = started.turn.id;
      mine.add(running);
      kept = true;
      if (stop.signal.aborted) interrupt();
      rest.forEach(steer);
      const { status, error } = await Promise.race([ended, codex.gone]);
      running = null;
      await steering;
      if (status === "failed") throw new Error(error?.message || "Codex couldn't finish the turn");
      if (status !== "completed") break;
      // The turn answers the message that started it. One Codex took into it that the agent never read gets the next turn.
      read.add(first.id);
      next.unshift(...[...taken.values()].filter((each) => !read.has(each.id)));
      replied(answer, [...read]);
    }
    if (!kept) throw new Error("Codex stopped without a reply");
    return result(threadId);
  } catch (error) {
    // A turn that was told to stop and ran on has its process ended for it. Its thread is kept all the same.
    if (stop.signal.aborted && threadId && kept) return result(threadId);
    throw error;
  } finally {
    clearTimeout(endLate);
    stop.signal.removeEventListener("abort", onStop);
    stopListening?.();
    codex.close();
  }
};

/**
 * Why a turn failed, in words for the person on their phone. Codex's words
 * for the common causes are instructions for its own terminal, so those say
 * what to do on the computer instead. Anything else keeps Codex's words.
 */
function failure(words: string): string {
  if (/incorrect api key|invalid api key/i.test(words)) return "OpenAI refused your API key. Save a new one on your computer.";
  if (/not logged in|sign in again|401 unauthorized/i.test(words)) return "Codex on your computer is signed out. Sign in to it there.";
  if (/usage limit/i.test(words)) {
    const resets = /try again at ([^.\n]+)/i.exec(words)?.[1].trim();
    return `Your Codex usage limit is reached. ${resets ? `It resets at ${resets}.` : "Try again once it resets."}`;
  }
  return words;
}

/**
 * Codex keeps its threads in its config folder, and lists the ones that ran
 * in a folder. A Codex that can't be reached leaves them there, and the agent
 * goes all the same.
 */
const forget = (start: () => Promise<Start>) => async (cwd: string, configDir: string): Promise<void> => {
  const codex = await start()
    .then((started) => connect(started, configDir))
    .catch(() => undefined);
  if (!codex) return;
  try {
    await greet(codex);
    for (;;) {
      const { data } = await codex.request<{ data: { id: string }[] }>("thread/list", { cwd, sourceKinds: ["cli", "vscode", "appServer", "exec"] });
      if (data.length === 0) return;
      for (const thread of data) await codex.request("thread/delete", { threadId: thread.id });
    }
  } catch {
    // Left as they are.
  } finally {
    codex.close();
  }
};

/** Asks Codex where the plan's limits stand, with no thread started. It lists every limit by its id, the plan's own among them. A login that is an API key has no plan, and Codex refuses to say of one. */
const limitsNow = (start: () => Promise<Start>): Driver["limits"] => async (configDir, giveUp) => {
  const codex = connect(await start(), configDir);
  giveUp.addEventListener("abort", codex.close);
  try {
    await greet(codex);
    const { account } = await codex.request<{ account: { type: string } | null }>("account/read", { refreshToken: false });
    if (account?.type === "apiKey") return null;
    const { rateLimits, rateLimitsByLimitId } = await codex.request<{ rateLimits: Said; rateLimitsByLimitId: Record<string, Said> | null }>("account/rateLimits/read", {});
    return limitsIn(rateLimitsByLimitId?.codex ?? rateLimits, Date.now());
  } finally {
    codex.close();
  }
};

/** A driver that starts Codex as `start` says. */
export function codexOn(start: () => Promise<Start>): Driver {
  return { runTurn: runTurn(start), failure, forget: forget(start), limits: limitsNow(start) };
}

/** The Codex on this computer. */
export const codex: Driver = codexOn(async () => ({ command: [await program("codex")], env: await environment() }));
