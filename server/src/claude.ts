// Claude Code as a provider: the agent's turns run through the Claude Agent
// SDK, which starts the Claude Code program. It is the only module that
// imports the SDK.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, query, tool, type SDKControlInterruptResponse, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { toolsFor, type Driver, type Prompt, type RunTurn } from "./runner.ts";

// The longest a session stays open, after its replies are in, for background work the agent started.
const BACKGROUND_WAIT_MS = 30 * 60_000;
// The longest Claude Code is given to end a turn it was told to stop, before its process is ended for it.
const STOP_WAIT_MS = 10_000;

const text = (words: string) => ({ content: [{ type: "text" as const, text: words }] });

/** The messages a frame from Claude Code says it has read, by the ids they were sent with. */
const readIds = (message: SDKMessage): string[] => ("user_message_uuids" in message && message.user_message_uuids) || [];

/** Whether a result ends a turn that was stopped part way. It carries no reply. */
const stoppedPartWay = (result: SDKResultMessage) => result.terminal_reason === "aborted_streaming" || result.terminal_reason === "aborted_tools";

/**
 * A query whose `interrupt` also drops the messages queued behind the turn.
 * The option is the interrupt request's `cancel_queued`, which the SDK's own
 * type for the method leaves out.
 */
type Interruptible = { interrupt(options: { cancelQueued: true }): Promise<SDKControlInterruptResponse | undefined> };

/** Messages for Claude Code, handed over as they come, until `end`. */
function inbox() {
  const waiting: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(message: SDKUserMessage) {
      waiting.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *messages(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (waiting.length) yield waiting.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

/**
 * Runs a turn through Claude Code. A message the person sends while the turn
 * runs goes into its session: Claude Code reads it at its next pause between
 * steps, and its reply answers both. One that arrives as the turn is finishing
 * gets a reply of its own in the same session. The session closes once every
 * message sent to it has its reply and no background work the agent started,
 * such as a long command, is still running. When such work finishes, Claude
 * Code wakes the agent by itself, and what it says then is a reply too. The
 * session waits for that work for half an hour at most.
 *
 * A turn that is stopped ends through Claude Code's own interrupt, which ends
 * the command it was running and writes into the session that the person
 * interrupted it. The session stays whole, so the next turn resumes it and
 * the agent knows it was stopped. Ending the process instead would leave the
 * command looking as if it had failed. A message that was sent into the turn
 * and not yet read is dropped from it unread, and one that comes after the
 * stop is left for the next turn.
 */
const runTurn: RunTurn = async (turn) => {
  const { prompt, followUps, seen, replied, cwd, sessionId, configDir, apiKey, model, effort, keepSession, stop } = turn;
  const tools = toolsFor(turn);
  const sidebots = createSdkMcpServer({
    name: "sidebots",
    tools: tools.map((each) => tool(each.name, each.description, each.input, async (input) => text(each.run(input)))),
  });
  const input = inbox();
  // Sent to Claude Code and not yet answered.
  const unanswered = new Set<string>();
  let open = true;
  // The session the replies came from, once there is one, and the background work it has running.
  let session: string | null = null;
  let background = 0;
  let waitForBackground: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    if (waitForBackground) clearTimeout(waitForBackground);
    open = false;
    input.end();
  };
  // Closes the session when nothing is left for it to do, or waits for its background work.
  const settle = () => {
    if (!open || session === null || unanswered.size > 0) return;
    if (background === 0) close();
    else waitForBackground ??= setTimeout(close, BACKGROUND_WAIT_MS);
  };
  const send = ({ id, text: words }: Prompt) => {
    if (waitForBackground) clearTimeout(waitForBackground);
    waitForBackground = null;
    unanswered.add(id);
    input.push({ type: "user", message: { role: "user", content: words }, parent_tool_use_id: null, uuid: id as SDKUserMessage["uuid"], priority: "next" });
  };
  const takeFollowUps = () => {
    if (open) followUps?.take().forEach(send);
  };
  send(prompt);
  takeFollowUps();
  const stopListening = followUps?.onArrival(takeFollowUps);

  // Ends Claude Code's process, for a turn that was told to stop and hasn't.
  const end = new AbortController();
  let endLate: ReturnType<typeof setTimeout> | null = null;
  const run = query({
    prompt: input.messages(),
    options: {
      cwd,
      resume: sessionId ?? undefined,
      persistSession: keepSession,
      model,
      effort,
      abortController: end,
      // Claude Code uses a key in its environment ahead of a login in the config folder.
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...(apiKey && { ANTHROPIC_API_KEY: apiKey }) },
      settingSources: ["user", "project"],
      // Claude Code's full prompt. Left out, the SDK gives a short one that says nothing of memory.
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Claude Code's own memory, kept in the agent's folder so it outlives
      // every session. It is on for a Sidebots agent even when its owner has
      // turned it off for their own Claude Code.
      settings: { autoMemoryEnabled: true, autoMemoryDirectory: join(cwd, "memory"), env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } },
      skills: "all",
      mcpServers: { sidebots },
      allowedTools: tools.map((each) => `mcp__sidebots__${each.name}`),
      permissionMode: "auto",
      // Auto mode asks here when its classifier can't decide. Nobody is at
      // the keyboard, so the agent carries on without the action.
      canUseTool: async () => ({
        behavior: "deny",
        message: "Nobody is available to approve this. Skip it, finish the rest, and say in your reply what you couldn't do.",
      }),
    },
  });
  const onStop = () => {
    open = false;
    endLate = setTimeout(() => end.abort(), STOP_WAIT_MS);
    void (run as Interruptible)
      .interrupt({ cancelQueued: true })
      .then((interrupted) => {
        // With every message dropped before Claude Code read it, there is no turn to end, and Claude Code would wait on for one.
        const dropped = new Set(interrupted?.cancelled);
        if ([...unanswered].every((id) => dropped.has(id))) end.abort();
      })
      .catch(() => undefined)
      .finally(close);
  };
  stop.signal.addEventListener("abort", onStop);
  let contextTokens = 0;
  try {
    for await (const message of run) {
      const read = readIds(message).filter((id) => unanswered.has(id));
      if (read.length) seen(read);
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        // Each of the agent's own steps reports everything the model read for it, which is the session so far.
        const usage = message.message.usage;
        contextTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens;
      }
      if (message.type === "system" && message.subtype === "background_tasks_changed") {
        background = message.tasks.filter((task) => !task.ambient).length;
        settle();
      }
      if (message.type !== "result") continue;
      if (stoppedPartWay(message)) {
        session = message.session_id;
        continue;
      }
      if (message.subtype !== "success") throw new Error(message.errors.join("; ") || message.subtype);
      if (message.is_error) throw new Error(message.result || "Claude Code returned an error");
      // A result names the messages it answers. One for finished background work names none.
      read.forEach((id) => unanswered.delete(id));
      replied(message.result, read);
      session = message.session_id;
      settle();
    }
  } catch (error) {
    // Claude Code exits with an error after a turn it was told to stop.
    if (!stop.signal.aborted) throw error;
  } finally {
    if (waitForBackground) clearTimeout(waitForBackground);
    if (endLate) clearTimeout(endLate);
    stop.signal.removeEventListener("abort", onStop);
    open = false;
    stopListening?.();
    input.end();
  }
  if (session !== null && (unanswered.size === 0 || stop.signal.aborted)) return { sessionId: session, contextTokens };
  throw new Error("Claude Code stopped without a reply");
};

/**
 * Why a turn failed, in words for the person on their phone. Claude Code's
 * words for the common causes are instructions for its own terminal, such as
 * "Not logged in · Please run /login", so those say what to do on the computer
 * instead. Anything else keeps Claude Code's words.
 */
function failure(words: string): string {
  if (/invalid api key|invalid x-api-key/i.test(words)) return "Anthropic refused your API key. Save a new one on your computer.";
  if (/not logged in|please run \/login|sign in again/i.test(words)) return "Claude Code on your computer is signed out. Sign in to it there.";
  if (/you've (?:hit|reached) your|usage limit/i.test(words)) {
    const resets = /resets ([^·\n]+)/.exec(words)?.[1].trim();
    return `Your Claude usage limit is reached. ${resets ? `It resets at ${resets}.` : "Try again once it resets."}`;
  }
  return words;
}

/**
 * Claude Code keeps a folder's sessions in its config folder, under
 * `projects`, in a folder named after the path with every other character
 * turned into a dash.
 */
function forget(cwd: string, configDir: string): void {
  rmSync(join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true });
}

export const claude: Driver = { runTurn, failure, forget };
