// The runner runs turns. It is the only module that imports the Agent SDK.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createSdkMcpServer, query, tool, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { scheduleWords } from "./contract.ts";
import type { Effort, Found, Job, Message, Model, Schedule } from "./contract.ts";
import type { Person, Store } from "./store.ts";

/** A job as an agent asks for one: what to do on each run, and one of three ways to say when. */
export type JobRequest = { what: string; every_minutes?: number; daily_at?: string; weekdays?: number[]; once_at?: string };

/** A message as the agent is given it: its id, which Claude Code names again once it has read it, and its words. */
export type Prompt = { id: string; text: string };

/**
 * Where a running turn finds the messages the person sent after it started.
 * `take` hands over the ones it hasn't had yet, and `onArrival` calls back
 * when another comes, until the function it returns is called.
 */
export type FollowUps = { take: () => Prompt[]; onArrival: (listener: () => void) => () => void };

export type Turn = {
  prompt: Prompt;
  /** Messages the person sends while the turn runs. Absent for a turn nobody talks to, such as a job's run. */
  followUps?: FollowUps;
  /** The agent has read these messages. */
  seen: (ids: string[]) => void;
  /** A reply, with the messages it answers. */
  replied: (text: string, ids: string[]) => void;
  cwd: string;
  sessionId: string | null;
  configDir: string;
  /** The person's Anthropic API key. Without one, the turn runs on the Claude login in `configDir`. */
  apiKey?: string;
  model: Model;
  effort: Effort;
  /** False for a job's run, whose session nothing comes back to. */
  keepSession: boolean;
  /** Stops the turn part way, as when its agent is deleted. */
  stop: AbortController;
  /** Finds messages in any of the person's chats, for the agent's `search_history` tool. */
  searchHistory: (text: string) => string;
  /** The agent's tools for its jobs. Each answers in words the agent reads. */
  scheduleJob: (request: JobRequest) => string;
  listJobs: () => string;
  cancelJob: (id: string) => string;
  /** Sends the person a short update while the agent works, for a turn they are waiting on. Answers in words the agent reads. */
  sendUpdate?: (text: string) => string;
};
/** `contextTokens` is how much the session held when the turn ended. */
export type TurnResult = { sessionId: string; contextTokens: number };
export type RunTurn = (turn: Turn) => Promise<TurnResult>;

/** What a fresh start shows in the chat. */
const FRESH_START = "Fresh start";
// A session this large gets a fresh start once its reply is in.
const FRESH_START_TOKENS = 120_000;
// How much of the chat a new session is shown before its first message.
const RECENT_MESSAGES = 20;
const RECENT_MESSAGE_CHARS = 1500;
// How much of the message a reply answers the agent is shown.
const QUOTE_CHARS = 300;
// How often the clock looks for jobs whose time has come.
const CLOCK_MS = 15_000;
// The longest a session stays open, after its replies are in, for background work the agent started.
const BACKGROUND_WAIT_MS = 30 * 60_000;
// How long a turn runs before the agent may send an update, and how long between updates.
const FIRST_UPDATE_MS = 60_000;
const UPDATE_GAP_MS = 3 * 60_000;
/** What a job's run replies when it has nothing to tell the person. */
const SILENT = "SILENT";
const TOOLS = ["search_history", "schedule_job", "list_jobs", "cancel_job"];

const text = (words: string) => ({ content: [{ type: "text" as const, text: words }] });

/** The messages a frame from Claude Code says it has read, by the ids they were sent with. */
const readIds = (message: SDKMessage): string[] => ("user_message_uuids" in message && message.user_message_uuids) || [];

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
 * Runs a turn through Claude Code, paid for by the person who owns the agent:
 * on their API key when they have one, and otherwise on the Claude login in
 * their config folder. The session stays open while the turn runs, so a
 * message the person sends meanwhile goes into it: Claude Code reads it at its
 * next pause between steps, and its reply answers both. One that arrives as the turn is finishing
 * gets a reply of its own in the same session. The session closes once every
 * message sent to it has its reply and no background work the agent started,
 * such as a long command, is still running. When such work finishes, Claude
 * Code wakes the agent by itself, and what it says then is a reply too. The
 * session waits for that work for half an hour at most.
 */
export const claudeTurn: RunTurn = async ({
  prompt,
  followUps,
  seen,
  replied,
  cwd,
  sessionId,
  configDir,
  apiKey,
  model,
  effort,
  keepSession,
  stop,
  searchHistory,
  scheduleJob,
  listJobs,
  cancelJob,
  sendUpdate,
}) => {
  const sidebots = createSdkMcpServer({
    name: "sidebots",
    tools: [
      tool(
        "search_history",
        "Search the messages in every chat this person has in Sidebots, with this agent and their other agents. Use it for things said before this session or to another agent.",
        { text: z.string().describe("A word or phrase the messages contain") },
        async (search) => text(searchHistory(search.text)),
      ),
      tool(
        "schedule_job",
        "Save a job that Sidebots runs for you later with nobody asking: once at a time, at a time of day, or every so many minutes. Use it for a reminder, a regular check, or anything the person wants done or watched without asking again. Each run is a session of its own that is given `what` and remembers nothing else, and what you reply then is sent to the person, so write `what` as full instructions to yourself, including when a run should stay silent. Give exactly one of every_minutes, daily_at and once_at. Times are this machine's local time, and the answer tells you the time now.",
        {
          what: z.string().describe("What to do on each run, written to yourself"),
          every_minutes: z.number().optional().describe("Run every this many minutes"),
          daily_at: z.string().optional().describe("Run at this time of day, as HH:MM on a 24-hour clock"),
          weekdays: z.array(z.number()).optional().describe("With daily_at, the days it runs on, where 0 is Sunday. Leave out for every day."),
          once_at: z.string().optional().describe("Run once at this time, as YYYY-MM-DDTHH:MM"),
        },
        async (request) => text(scheduleJob(request)),
      ),
      tool("list_jobs", "List the jobs you have saved, with when each next runs and the time now.", {}, async () => text(listJobs())),
      tool("cancel_job", "Remove one of your jobs.", { id: z.string().describe("The job's id, as list_jobs gives it") }, async ({ id }) => text(cancelJob(id))),
      ...(sendUpdate
        ? [
            tool(
              "send_update",
              "Send the person a short text while you are still working. Use it only when the work is taking a long time: after a minute or more, and then no more than every few minutes. Say in a sentence or two what you have done and what is left. It arrives quietly, without a notification; your final reply is what tells them you are done, so don't repeat the update there. Don't use it for work that will be done soon.",
              { text: z.string().describe("The update, as a short plain text") },
              async (update) => text(sendUpdate(update.text)),
            ),
          ]
        : []),
    ],
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

  const run = query({
    prompt: input.messages(),
    options: {
      cwd,
      resume: sessionId ?? undefined,
      persistSession: keepSession,
      model,
      effort,
      abortController: stop,
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
      allowedTools: [...TOOLS, ...(sendUpdate ? ["send_update"] : [])].map((name) => `mcp__sidebots__${name}`),
      permissionMode: "auto",
      // Auto mode asks here when its classifier can't decide. Nobody is at
      // the keyboard, so the agent carries on without the action.
      canUseTool: async () => ({
        behavior: "deny",
        message: "Nobody is available to approve this. Skip it, finish the rest, and say in your reply what you couldn't do.",
      }),
    },
  });
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
      if (message.subtype !== "success") throw new Error(message.errors.join("; ") || message.subtype);
      if (message.is_error) throw new Error(message.result || "Claude Code returned an error");
      // A result names the messages it answers. One for finished background work names none.
      read.forEach((id) => unanswered.delete(id));
      replied(message.result, read);
      session = message.session_id;
      settle();
    }
  } finally {
    if (waitForBackground) clearTimeout(waitForBackground);
    open = false;
    stopListening?.();
    input.end();
  }
  if (session !== null && unanswered.size === 0) return { sessionId: session, contextTokens };
  throw new Error("Claude Code stopped without a reply");
};

function found(messages: Found[]): string {
  if (messages.length === 0) return "No messages match.";
  return messages
    .map((message) => `${new Date(message.created_at).toISOString().slice(0, 10)}, chat with ${message.agent}, ${message.sender === "person" ? "the person" : message.agent}: ${message.body}`)
    .join("\n\n");
}

/** What the agent is asked before its session is replaced. */
function remember(person: Person): string {
  return `This session is about to be replaced by a fresh one. Save what is worth keeping from it to your memory now: what you are in the middle of, what was decided, and what you learned about ${person.name}. Then reply "Saved."`;
}

/** A time as the agent reads and writes one, by this machine's clock. */
function clock(time: number): string {
  const at = new Date(time);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** The schedule an agent asked for, or what is wrong with the request. */
function toSchedule(request: JobRequest, now: number): Schedule | string {
  const ways = [request.every_minutes, request.daily_at, request.once_at].filter((way) => way !== undefined);
  if (ways.length !== 1) return "Give exactly one of every_minutes, daily_at and once_at.";
  if (request.every_minutes !== undefined) {
    return Number.isInteger(request.every_minutes) && request.every_minutes >= 1 ? { type: "every", minutes: request.every_minutes } : "every_minutes must be a whole number, 1 or more.";
  }
  if (request.daily_at !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(request.daily_at)) return "daily_at must be HH:MM on a 24-hour clock.";
    const weekdays = [...new Set(request.weekdays ?? [])];
    if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return "weekdays must be numbers from 0, for Sunday, to 6.";
    return weekdays.length ? { type: "daily", time: request.daily_at, weekdays } : { type: "daily", time: request.daily_at };
  }
  // A time with no zone is read as this machine's own.
  const at = new Date(request.once_at!).getTime();
  if (Number.isNaN(at)) return "once_at must be a time such as 2026-11-16T17:00.";
  return at > now ? { type: "once", at } : `That time has passed. It is now ${clock(now)}.`;
}

/** When a job next runs after `after`. A job that runs once has no run after its time. */
export function nextRun(schedule: Schedule, after: number): number | null {
  if (schedule.type === "every") return after + schedule.minutes * 60_000;
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  const [hours, minutes] = schedule.time.split(":").map(Number);
  const next = new Date(after);
  next.setHours(hours, minutes, 0, 0);
  // Today if the time is still to come and today is one of its days, or the first of its days after.
  while (next.getTime() <= after || (schedule.weekdays && !schedule.weekdays.includes(next.getDay()))) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** What the agent is asked on a run of one of its jobs. */
function jobPrompt(job: Job, person: Person): string {
  return `This is a run of one of your jobs (${scheduleWords(job.schedule)}), started by Sidebots' clock. ${person.name} hasn't sent anything. What you saved for it:

${job.what}

Do it now. This run is a session of its own. It remembers no earlier run and nothing from the chat, so keep what the next run needs in your memory, such as what you have already told ${person.name}.

Your reply is sent to ${person.name} as a message and notifies their phone. If this run found nothing worth telling them, reply with only the word ${SILENT}.`;
}

/** Whether a job's run chose to send nothing. */
const silent = (reply: string) => reply.trim() === "" || new RegExp(`^\\W*${SILENT}\\W*$`, "i").test(reply);

/**
 * A person's message as the agent reads it: the message it answers, the files
 * sent with it, and what the session hasn't seen. For a new session that is
 * the chat so far, and for one going it is whatever the agent's jobs have sent.
 */
function promptFor(message: Message, person: Person, unseen: { recent: Message[]; quoted?: Message; fromJobs: Message[] }): string {
  const { recent, quoted, fromJobs } = unseen;
  const quote = quoted ? `Replying to ${quoted.sender === "person" ? "their own earlier message" : "your message"}: "${quoted.body.slice(0, QUOTE_CHARS)}"\n\n` : "";
  const files = message.attachments.length ? `\n\nSent with this message: ${message.attachments.join(", ")}` : "";
  const sent = `${quote}${message.body}${files}`.trim();
  const lines = (messages: Message[]) => messages.map((earlier) => `${earlier.sender === "person" ? person.name : "You"}: ${earlier.body.slice(0, RECENT_MESSAGE_CHARS)}`).join("\n\n");
  if (recent.length) return `This is a fresh session in a chat that was already going. The latest messages in it:\n\n${lines(recent)}\n\n${person.name}'s new message:\n\n${sent}`;
  if (fromJobs.length) return `Since your last reply in this chat, your jobs sent ${person.name} these messages, which this session hasn't seen:\n\n${lines(fromJobs)}\n\n${person.name}'s new message:\n\n${sent}`;
  return sent;
}

/**
 * Runs each agent's work one turn at a time: the messages it was sent, in the
 * order they came, and then any job whose time has come. A message the person
 * sends during a turn goes into that turn instead of waiting for the next.
 */
export function createQueue(store: Store, runTurn: RunTurn, now: () => number = Date.now) {
  const busy = new Map<string, Promise<void>>();
  const stops = new Map<string, AbortController>();
  // For an agent running a turn the person can talk to, what to call when they send another message.
  const arrivals = new Map<string, () => void>();

  async function drain(agentId: string, stop: AbortController): Promise<void> {
    while (!stop.signal.aborted) {
      const agent = store.agent(agentId);
      const person = agent && store.person(agent.person_id);
      if (!agent || !person) return;
      const apiKey = store.apiKey(person.id);
      const message = store.nextQueued(agentId);
      const job = message ? undefined : store.dueJob(agentId, now());
      const turn = (text: string, rest: Pick<Turn, "followUps" | "seen" | "replied" | "sendUpdate"> & { id?: string; ofJob?: boolean }) =>
        runTurn({
          prompt: { id: rest.id ?? randomUUID(), text },
          followUps: rest.followUps,
          seen: rest.seen,
          replied: rest.replied,
          sendUpdate: rest.sendUpdate,
          cwd: store.agentHome(agent.id),
          sessionId: rest.ofJob ? null : agent.session_id,
          configDir: person.claude_config_dir,
          apiKey,
          model: agent.model,
          effort: agent.effort,
          keepSession: !rest.ofJob,
          stop,
          searchHistory: (search) => found(store.searchMessages(person.id, search)),
          scheduleJob: (request) => {
            const schedule = toSchedule(request, now());
            if (typeof schedule === "string") return schedule;
            if (!request.what.trim()) return "Say what the job is to do.";
            const saved = store.addJob(agent.id, request.what.trim(), schedule, nextRun(schedule, now())!);
            return `Saved job ${saved.id}: ${scheduleWords(schedule)}. It first runs at ${clock(saved.next_at)}. It is now ${clock(now())}.`;
          },
          listJobs: () => {
            const jobs = store.jobs(agent.id).map((each) => `${each.id}: ${scheduleWords(each.schedule)}, next at ${clock(each.next_at)}. ${each.what}`);
            return `${jobs.join("\n\n") || "You have no jobs."}\n\nIt is now ${clock(now())}.`;
          },
          cancelJob: (id) => (store.removeJob(agent.id, id) ? "Removed." : "You have no job with that id."),
        });
      // Why a turn failed, as the chat says it. An error can quote what the turn ran with, and the person's API key never goes with it.
      const reason = (error: unknown) => {
        const words = error instanceof Error ? error.message : String(error);
        return apiKey ? words.replaceAll(apiKey, "your API key") : words;
      };

      if (job) {
        try {
          const replies: string[] = [];
          await turn(jobPrompt(job, person), { ofJob: true, seen: () => undefined, replied: (reply) => replies.push(reply) });
          const reply = replies.at(-1) ?? "";
          if (!silent(reply)) store.addMessage(agent.id, "agent", reply, "done", { jobId: job.id });
        } catch (error) {
          if (stop.signal.aborted) return;
          // A job that keeps failing says so once, not on every run.
          const latest = store.agentWithLatest(agent.id)?.latest;
          if (latest?.sender !== "sidebots" || latest.status !== "failed") store.addMessage(agent.id, "sidebots", `Sidebots couldn't run a job. ${reason(error)}`, "failed");
        }
        // The next run counts from the end of this one. A job that ran its one time is done.
        const next = nextRun(job.schedule, now());
        if (next === null) store.removeJob(agent.id, job.id);
        else store.setJobNext(job.id, next);
        continue;
      }
      if (!message) return;

      if (message.sender === "sidebots") {
        // A fresh start. The session goes even when the agent couldn't save
        // first, since the chat itself is still there to search.
        store.setStatus(message.id, "running");
        if (agent.session_id) await turn(remember(person), { seen: () => undefined, replied: () => undefined }).catch(() => undefined);
        if (stop.signal.aborted) return;
        store.setSession(agent.id, null);
        store.setStatus(message.id, "done");
        continue;
      }

      // The messages sent into this turn, the first and any the person sends while it runs.
      const sent = new Set([message.id]);
      const quotedBy = (each: Message) => (each.reply_to ? store.message(agent.id, each.reply_to) : undefined);
      const followUps: FollowUps = {
        take: () =>
          store
            .waitingFromPerson(agent.id)
            .filter((each) => !sent.has(each.id))
            .map((each) => {
              sent.add(each.id);
              return { id: each.id, text: promptFor(each, person, { recent: [], quoted: quotedBy(each), fromJobs: [] }) };
            }),
        onArrival: (listener) => {
          arrivals.set(agent.id, listener);
          return () => arrivals.delete(agent.id);
        },
      };
      // Updates while the agent works: none in the first minute, then at most one every few minutes.
      const started = now();
      let lastUpdate: number | null = null;
      const sendUpdate = (update: string) => {
        const at = now();
        if (!update.trim()) return "Say what the update is.";
        if (at - started < FIRST_UPDATE_MS) return "Too soon for an update. Carry on, and send one only if the work runs well past a minute.";
        if (lastUpdate !== null && at - lastUpdate < UPDATE_GAP_MS) return "You sent an update moments ago. Carry on, and tell the rest in your reply.";
        lastUpdate = at;
        store.addMessage(agent.id, "agent", update.trim(), "done", { interim: true });
        return "Sent. Carry on with the work.";
      };
      try {
        const result = await turn(
          promptFor(message, person, {
            recent: agent.session_id ? [] : store.messagesBefore(message.id, RECENT_MESSAGES),
            quoted: quotedBy(message),
            fromJobs: store.sentByJobsBefore(message.id),
          }),
          {
            id: message.id,
            followUps,
            sendUpdate,
            seen: (ids) => store.markSeen(ids),
            replied: (reply, ids) => {
              store.addMessage(agent.id, "agent", reply, "done");
              store.markSeen(ids);
              ids.forEach((id) => store.setStatus(id, "done"));
            },
          },
        );
        store.setSession(agent.id, result.sessionId);
        if (result.contextTokens > FRESH_START_TOKENS) store.addMessage(agent.id, "sidebots", FRESH_START, "queued");
      } catch (error) {
        if (stop.signal.aborted) return;
        store.addMessage(agent.id, "sidebots", `Sidebots couldn't finish this. ${reason(error)}`, "failed");
        for (const id of sent) if (store.message(agent.id, id)?.status !== "done") store.setStatus(id, "failed");
      }
    }
  }

  /** Starts the agent's queue if it isn't running. If it is running a turn the person can talk to, a new message of theirs goes into that turn. */
  function kick(agentId: string): Promise<void> {
    const running = busy.get(agentId);
    if (running) {
      arrivals.get(agentId)?.();
      return running;
    }
    const stop = new AbortController();
    const done = drain(agentId, stop).finally(() => {
      busy.delete(agentId);
      stops.delete(agentId);
    });
    busy.set(agentId, done);
    stops.set(agentId, stop);
    return done;
  }

  return {
    kick,

    /**
     * Replaces the agent's session once the turns ahead of it are done. The
     * agent first saves what is worth keeping to its memory.
     */
    freshStart(agentId: string): Message {
      const message = store.addMessage(agentId, "sidebots", FRESH_START, "queued");
      void kick(agentId);
      return message;
    },

    /** Stops whatever the agent is running and waits for it to end, as before the agent is deleted. */
    async stop(agentId: string): Promise<void> {
      stops.get(agentId)?.abort();
      await busy.get(agentId)?.catch(() => undefined);
    },

    /** Starts the clock that runs each job when its time comes. Returns a function that stops it. */
    startClock(): () => void {
      const tick = () => store.agentsWithDueJobs(now()).forEach((agentId) => void kick(agentId));
      tick();
      const timer = setInterval(tick, CLOCK_MS);
      return () => clearInterval(timer);
    },
  };
}

export type Queue = ReturnType<typeof createQueue>;
