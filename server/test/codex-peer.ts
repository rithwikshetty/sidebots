// A stand-in for `codex app-server` that the Codex driver's tests drive it against. It answers the
// requests the driver makes, runs a turn by what its first message says, and writes every request
// it gets to `requests.jsonl` in its config folder. It does nothing unless it is run as Codex is.

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Message = { id?: number; method?: string; params?: Record<string, never>; result?: never };

if (process.argv[2] === "app-server") {
  const home = process.env.CODEX_HOME!;
  const send = (message: object) => void process.stdout.write(`${JSON.stringify(message)}\n`);
  const note = (method: string, params: object) => send({ method, params });
  const usage = (tokens: number) => ({ totalTokens: tokens, inputTokens: tokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 });
  // Signed in with the login in the config folder, unless it was started to keep a login in its memory.
  let signedIn = !process.argv.includes('cli_auth_credentials_store="ephemeral"') && existsSync(join(home, "auth.json"));
  // The turn that is running: its id, the messages the agent has read in it, and whether it waits for another before it ends.
  let turn: { id: string; read: string[]; holding: boolean } | null = null;
  let turns = 0;
  // The tokens a thread it resumes had used before, which it says as it resumes it.
  let before = 0;
  let asked = 0;
  const answers = new Map<number, (result: never) => void>();
  /** Asks the driver something, as Codex asks its client. */
  const ask = (method: string, params: object) => new Promise<never>((resolve) => (answers.set(++asked + 1000, resolve), send({ id: asked + 1000, method, params })));
  const read = (id: string, words: string) => {
    turn!.read.push(words);
    note("item/completed", { item: { type: "userMessage", id: `user-${id}`, clientId: id, content: [{ type: "text", text: words }] } });
  };
  const end = (status: string, answer?: string, error?: string) => {
    if (answer !== undefined) {
      note("item/completed", { item: { type: "agentMessage", id: "said", text: "Working on it.", phase: "commentary" } });
      note("item/completed", { item: { type: "agentMessage", id: "answer", text: answer, phase: "final_answer" } });
    }
    note("thread/tokenUsage/updated", { turnId: turn!.id, tokenUsage: { total: usage(before + 1_000_000 * turns), last: usage(5000), modelContextWindow: 258400 } });
    note("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1795111200 }, secondary: null } });
    note("turn/completed", { turn: { id: turn!.id, status, error: error ? { message: error } : null } });
    turn = null;
  };
  const answer = () => `Read: ${turn!.read.join(" | ")}`;

  const handlers: Record<string, (params: Record<string, never>) => object | Promise<object>> = {
    initialize: () => ({ userAgent: "peer" }),
    "account/read": () => ({ account: signedIn ? { type: "chatgpt" } : null, requiresOpenaiAuth: true }),
    "account/login/start": () => ((signedIn = true), { type: "apiKey" }),
    "account/rateLimits/read": () => {
      const weekly = { limitId: "codex", primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1795623087 }, secondary: null };
      return { rateLimits: { ...weekly, limitId: "codex_other" }, rateLimitsByLimitId: { codex: weekly } };
    },
    "model/list": () => ({ data: ["gpt-6-sol", "gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-luna"].map((model) => ({ model })), nextCursor: null }),
    "thread/start": () => ({ thread: { id: "thread-1" } }),
    "thread/resume": ({ threadId }) => {
      before = 3_000_000;
      setImmediate(() => note("thread/tokenUsage/updated", { turnId: "turn-before", tokenUsage: { total: usage(before), last: usage(5000), modelContextWindow: 258400 } }));
      return { thread: { id: threadId } };
    },
    "thread/list": () => ({ data: existsSync(join(home, "deleted")) ? [] : [{ id: "thread-1" }, { id: "thread-2" }] }),
    "thread/delete": () => (appendFileSync(join(home, "deleted"), "x"), {}),
    "turn/start": ({ clientUserMessageId, input }) => {
      const words: string = input[0]["text"];
      turn = { id: `turn-${++turns}`, read: [], holding: /^(hold|refuse)/.test(words) };
      const started = { turn: { id: turn.id } };
      // What the turn does comes after the answer that it has started.
      setImmediate(async () => {
        read(clientUserMessageId, words);
        if (words === "fail") return end("failed", undefined, "You've hit your usage limit. Upgrade to Pro, or try again at 3:37 PM.");
        if (words.startsWith("tool ")) {
          const [, tool, text] = words.split(" ");
          const { contentItems, success }: { contentItems: { text: string }[]; success: boolean } = await ask("item/tool/call", { tool, arguments: { text } });
          return end("completed", `${success ? "Tool said" : "Tool failed"}: ${contentItems[0].text}`);
        }
        if (words === "command") {
          const { decision }: { decision: string } = await ask("item/commandExecution/requestApproval", { command: "/bin/zsh -lc 'rm -rf old'", cwd: "/work", commandActions: [{ command: "rm -rf old" }], reason: "It deletes files." });
          return end("completed", `The command: ${decision}.`);
        }
        if (words === "patch") {
          note("item/started", { item: { type: "fileChange", id: "patch-1", changes: [{ path: "/work/plan.md", kind: { type: "update" }, diff: "-a\n+b" }] } });
          const { decision }: { decision: string } = await ask("item/fileChange/requestApproval", { itemId: "patch-1", reason: null });
          return end("completed", `The change: ${decision}.`);
        }
        if (!turn!.holding) end("completed", answer());
      });
      return started;
    },
    // A turn that holds takes the message into itself and ends. One that refuses is ending already, and ends once it has said so.
    "turn/steer": ({ clientUserMessageId, input }) => {
      if (!turn || turn.read[0].startsWith("refuse")) {
        if (turn) setImmediate(() => end("completed", answer()));
        throw new Error("no active turn to steer");
      }
      const running = turn;
      setImmediate(() => {
        read(clientUserMessageId, input[0]["text"]);
        end("completed", answer());
      });
      return { turnId: running.id };
    },
    "turn/interrupt": () => (setImmediate(() => end("interrupted")), {}),
  };

  createInterface({ input: process.stdin }).on("line", async (line) => {
    const message = JSON.parse(line) as Message;
    appendFileSync(join(home, "requests.jsonl"), `${line}\n`);
    if (message.method === undefined) return answers.get(message.id!)?.(message.result!);
    if (message.id === undefined) return;
    try {
      send({ id: message.id, result: await handlers[message.method](message.params!) });
    } catch (error) {
      send({ id: message.id, error: { code: -32600, message: (error as Error).message } });
    }
  });
}
