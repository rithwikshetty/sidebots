// The runner runs each agent's turns one at a time, on the provider the agent
// runs on, and gives every provider the same tools for the agent.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MESSAGE_BYTES, PROVIDERS, fenced, scheduleWords } from "./contract.ts";
import type { Agent, Ask, Effort, Found, Job, Limit, Message, Model, Provider, Question, Schedule, TurnKind } from "./contract.ts";
import type { Person, Store, Upload } from "./store.ts";

/** A job as an agent asks for one: what to do on each run, and one of three ways to say when. */
export type JobRequest = { what: string; every_minutes?: number; daily_at?: string; weekdays?: number[]; once_at?: string };

/** A message as the agent is given it: its id, which the provider names again once the agent has read it, and its words. */
export type Prompt = { id: string; text: string };

/**
 * Where a running turn finds the messages the person sent after it started.
 * `take` hands over the ones it hasn't had yet, and `onArrival` calls back
 * when another comes, until the function it returns is called.
 */
export type FollowUps = { take: () => Prompt[]; onArrival: (listener: () => void) => () => void };

/** The person's answer to an ask. When it isn't yes, `words` tell the agent what to do instead. */
export type Answer = { allowed: true } | { allowed: false; words: string };

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
  /** What the session has cost up to this turn, in US dollars. A provider that counts a turn's tokens and not its money adds this turn's to it. */
  spent: number;
  /** The person's config folder for the provider. */
  configDir: string;
  /** The person's API key for the provider. Without one, the turn runs on the login in `configDir`. */
  apiKey?: string;
  model: Model;
  effort: Effort;
  /** False for a job's run, whose session nothing comes back to. */
  keepSession: boolean;
  /** Stops the turn part way, when the person stops it or its agent is deleted. */
  stop: AbortController;
  /** Finds messages in any of the person's chats, for the agent's `search_history` tool. */
  searchHistory: (text: string) => string;
  /** The agent's tools for its jobs. Each answers in words the agent reads. */
  scheduleJob: (request: JobRequest) => string;
  listJobs: () => string;
  cancelJob: (id: string) => string;
  /** Adds files, by their paths, to the next message the agent sends: its reply, or an update that comes first. Answers in words the agent reads. */
  sendFiles: (paths: string[]) => string;
  /** Sends the person a short update while the agent works, for a turn they are waiting on. Answers in words the agent reads. */
  sendUpdate?: (text: string) => string;
  /** The agent's tools for the person's other agents: their names, and a message to one of them. Each answers in words the agent reads. */
  listAgents: () => string;
  askAgent: (name: string, text: string) => string;
  /** Asks the person before the agent does something, and waits for their answer. `withdrawn` aborts when the provider no longer wants one. */
  ask: (question: Question, withdrawn: AbortSignal) => Promise<Answer>;
  /** The provider says where limits of the person's plan stand. */
  limits: (limits: Limit[]) => void;
};
/**
 * `contextTokens` is how much the session held when the turn ended. `cost` is
 * what the session has cost since it began, in US dollars at the provider's
 * prices.
 */
export type TurnResult = { sessionId: string; contextTokens: number; cost: number };
export type RunTurn = (turn: Turn) => Promise<TurnResult>;

/**
 * What the runner needs from a provider. `runTurn` runs a turn on it. A turn
 * runs on the person's API key for the provider when they have one, and
 * otherwise on the login in their config folder for it. It keeps the session
 * open while the turn runs, so that a message the person sends meanwhile goes
 * into it, and replies to every message it was sent. What its safety check
 * won't decide by itself, it asks the person through `turn.ask`. It passes on
 * what the provider says of the person's plan as the turn runs. A turn whose
 * `stop` is aborted ends soon after, with no reply, and still names its
 * session when it has one, kept so that the next turn carries on from where
 * this one stopped. `failure` puts why a turn failed in words for the person
 * on their phone, from the provider's own. `forget` removes the sessions the
 * provider keeps for the agent that works in `cwd`, once the agent is deleted.
 */
export type Driver = {
  runTurn: RunTurn;
  failure: (words: string) => string;
  forget: (cwd: string, configDir: string) => void | Promise<void>;
};
/** A driver for each provider. */
export type Drivers = Record<Provider, Driver>;

/**
 * A tool Sidebots gives the agent: its name, what the agent is told it does,
 * what it takes, and what it does, in words the agent reads. A tool that is
 * `checked` reaches the machine's files, so the provider's safety check judges
 * each call to it, as it does the agent's own actions. The rest always run.
 */
export type Tool<Input extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  checked?: true;
  input: Input;
  run(input: z.infer<z.ZodObject<Input>>): string;
};
const define = <Input extends z.ZodRawShape>(tool: Tool<Input>): Tool => tool as Tool;

/** The agent's tools for a turn, which a driver hands to its provider. `send_update` is there only for a turn the person is waiting on. */
export function toolsFor(turn: Turn): Tool[] {
  const { sendUpdate } = turn;
  return [
    define({
      name: "search_history",
      description:
        "Search the messages in every chat this person has in Sidebots, with this agent and their other agents. Use it for things said before this session or to another agent.",
      input: { text: z.string().describe("A word or phrase the messages contain") },
      run: (search) => turn.searchHistory(search.text),
    }),
    define({
      name: "schedule_job",
      description:
        "Save a job that Sidebots runs for you later with nobody asking: once at a time, at a time of day, or every so many minutes. Use it for a reminder, a regular check, or anything the person wants done or watched without asking again. Each run is a session of its own that is given `what` and remembers nothing else, and what you reply then is sent to the person, so write `what` as full instructions to yourself, including when a run should stay silent. Give exactly one of every_minutes, daily_at and once_at. Times are this machine's local time, and the answer tells you the time now.",
      input: {
        what: z.string().describe("What to do on each run, written to yourself"),
        every_minutes: z.number().optional().describe("Run every this many minutes"),
        daily_at: z.string().optional().describe("Run at this time of day, as HH:MM on a 24-hour clock"),
        weekdays: z.array(z.number()).optional().describe("With daily_at, the days it runs on, where 0 is Sunday. Leave out for every day."),
        once_at: z.string().optional().describe("Run once at this time, as YYYY-MM-DDTHH:MM"),
      },
      run: (request) => turn.scheduleJob(request),
    }),
    define({ name: "list_jobs", description: "List the jobs you have saved, with when each next runs and the time now.", input: {}, run: () => turn.listJobs() }),
    define({
      name: "cancel_job",
      description: "Remove one of your jobs.",
      input: { id: z.string().describe("The job's id, as list_jobs gives it") },
      run: ({ id }) => turn.cancelJob(id),
    }),
    define({ name: "list_agents", description: "List the person's other agents by name. You can ask any of them something with ask_agent.", input: {}, run: () => turn.listAgents() }),
    define({
      name: "ask_agent",
      description:
        "Ask another of the person's agents something, or hand it a piece of work. Each agent has its own chat, memory and skills, so ask the one that knows the thing or does it. It reads your message in its own session, which hasn't seen this chat, so say everything it needs. Its answer comes to you later as a message, in a turn of its own. Don't wait for it: end your reply now, and say in a line that you've asked. Until the answer comes, what you say to the person arrives quietly as an update, and your reply once you have the answer is what tells them you are done. The person can read what you ask and what it answers.",
      input: { agent: z.string().describe("The other agent's name, as list_agents gives it"), message: z.string().describe("What to ask or hand over, written to that agent") },
      run: ({ agent, message }) => turn.askAgent(agent, message),
    }),
    define({
      name: "send_files",
      description:
        "Send the person files: a photo, a chart, a PDF, anything you made or found for them. The files go with the next message you send, which is your reply unless you send an update first, and show above its text: a picture as a picture, a page as a page, any other file as a card that opens it. Use it whenever the person should have the file itself and not only your words about it. Up to 95 MB to a message. A file whose name ends in .html is a page: it is drawn in the chat and opens full screen, so use one for what words can't carry, such as a chart, a table or a layout. Write it as one file for a phone's width, with its styles, scripts and images inside it, and name it for what it shows. The page is given the chat's background and text colour, which change between light and dark, so set neither yourself. Colour the rest with the CSS variables it is also given: var(--ink) for text, var(--ink2) for quiet text, var(--line) for rules, var(--field) for a fill behind something, and var(--tint) for the one thing to pick out. Any colour of your own has to read on both white and black.",
      checked: true,
      input: { paths: z.array(z.string()).describe("Each file's path, in full or from your home folder") },
      run: ({ paths }) => turn.sendFiles(paths),
    }),
    ...(sendUpdate
      ? [
          define({
            name: "send_update",
            description:
              "Send the person a short text while you are still working. Use it only when the work is taking a long time: after a minute or more, and then no more than every few minutes. Say in a sentence or two what you have done and what is left. It arrives quietly, without a notification; your final reply is what tells them you are done, so don't repeat the update there. Don't use it for work that will be done soon.",
            input: { text: z.string().describe("The update, as a short plain text") },
            run: (update) => sendUpdate(update.text),
          }),
        ]
      : []),
  ];
}

/** What a fresh start shows in the chat. */
const FRESH_START = "Fresh start";
/** What a stopped turn shows in the chat. */
const STOPPED = "Stopped";
// A session this large gets a fresh start once its reply is in.
const FRESH_START_TOKENS = 120_000;
// How much of the chat a new session is shown before its first message.
const RECENT_MESSAGES = 20;
const RECENT_MESSAGE_CHARS = 1500;
// How much of the message a reply answers the agent is shown.
const QUOTE_CHARS = 300;
// How often the clock looks for jobs whose time has come.
const CLOCK_MS = 15_000;
// How long a turn runs before the agent may send an update, and how long between updates.
const FIRST_UPDATE_MS = 60_000;
const UPDATE_GAP_MS = 3 * 60_000;
// How long an ask waits for the person.
const ASK_WAIT_MS = 30 * 60_000;
/** What a job's run replies when it has nothing to tell the person. */
const SILENT = "SILENT";
/** Text cut to a line a card can lead with. */
export const short = (text: string) => (text.length > 120 ? `${text.slice(0, 119)}…` : text);

function found(messages: Found[]): string {
  if (messages.length === 0) return "No messages match.";
  return messages
    .map((message) => `${new Date(message.created_at).toISOString().slice(0, 10)}, chat with ${message.agent}, ${message.sender === "person" ? "the person" : message.agent}: ${message.body}`)
    .join("\n\n");
}


/**
 * An ask in words, for a search and for an app that doesn't draw its card:
 * what it is, its facts, the thing itself set apart as code, and the
 * provider's reason. The detail is whole, since Allow lets all of it happen.
 */
function asking({ title, what, facts, detail, why }: Question): string {
  const lines = facts.map(([label, value]) => `${label}: ${value}`).join("\n");
  return [`${title}: ${what}`, lines, detail.trim() && fenced(detail), why?.trim() && `> ${why.trim().replace(/\s+/g, " ")}`].filter(Boolean).join("\n\n");
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
 * A message as the agent reads it: the message it answers, the files sent
 * with it, and what the session hasn't seen. For a new session that is the
 * chat so far, and for one going it is whatever the agent's jobs have sent.
 * A message from another of the person's agents, `from`, says so first: that
 * agent asks something, or answers what this agent asked it, which is
 * `quoted`.
 */
function promptFor(message: Message, person: Person, unseen: { recent: Message[]; quoted?: Message; fromJobs: Message[] }, from?: Agent): string {
  if (from) return fromAgent(message, person, unseen, from);
  const { recent, quoted, fromJobs } = unseen;
  const quote = quoted ? `Replying to ${quoted.sender === "person" ? "their own earlier message" : "your message"}: "${quoted.body.slice(0, QUOTE_CHARS)}"\n\n` : "";
  const files = message.attachments.length ? `\n\nSent with this message: ${message.attachments.join(", ")}` : "";
  const sent = `${quote}${message.body}${files}`.trim();
  const lines = (messages: Message[]) => messages.map((earlier) => `${earlier.sender === "person" ? person.name : "You"}: ${earlier.body.slice(0, RECENT_MESSAGE_CHARS)}`).join("\n\n");
  if (recent.length) return `This is a fresh session in a chat that was already going. The latest messages in it:\n\n${lines(recent)}\n\n${person.name}'s new message:\n\n${sent}`;
  if (fromJobs.length) return `Since your last reply in this chat, your jobs sent ${person.name} these messages, which this session hasn't seen:\n\n${lines(fromJobs)}\n\n${person.name}'s new message:\n\n${sent}`;
  return sent;
}

/** A message from another of the person's agents as the agent reads it, with the chat so far when its session is new. */
function fromAgent(message: Message, person: Person, { recent, quoted }: { recent: Message[]; quoted?: Message }, from: Agent): string {
  const lines = recent.map((earlier) => `${earlier.sender === "person" ? person.name : "You"}: ${earlier.body.slice(0, RECENT_MESSAGE_CHARS)}`).join("\n\n");
  const chat = lines ? `This is a fresh session in a chat that was already going. The latest messages between you and ${person.name}:\n\n${lines}\n\n` : "";
  if (quoted) return `${chat}${from.name} answered what you asked it ("${quoted.body.slice(0, QUOTE_CHARS)}"):\n\n${message.body}`;
  return `${chat}${from.name}, another of ${person.name}'s agents, sent you the message below. ${person.name} didn't write it. Your reply goes back to ${from.name} and not to ${person.name}'s phone, so say what ${from.name} needs.\n\n${message.body}`;
}

/**
 * Runs each agent's work one turn at a time: the messages it was sent, in the
 * order they came, and then any job whose time has come. A message the person
 * sends during a turn goes into that turn instead of waiting for the next.
 *
 * An agent can ask another of the person's agents something. What it asks
 * waits in the other's queue as a message, and the other's reply comes back
 * the same way, so each agent's turn ends before the other's begins and
 * neither holds a turn open while it waits.
 */
export function createQueue(store: Store, drivers: Drivers, now: () => number = Date.now) {
  const busy = new Map<string, Promise<void>>();
  // What stops the turn each working agent is running.
  const stops = new Map<string, AbortController>();
  // The agents being deleted, whose queues end with the turn they are running.
  const removed = new Set<string>();
  // For an agent running a turn the person can talk to, what to call when they send another message.
  const arrivals = new Map<string, () => void>();
  // The asks that wait for the person, by the message that asks: whose agent's it is, what to call with the person's answer, and what closes it unanswered, with what the agent is told.
  const asks = new Map<string, { agentId: string; answer: (allow: boolean) => void; close: (words: string) => void }>();
  /** Closes the asks an agent has waiting, unanswered. */
  const stopWaiting = (agentId: string, words: string) => {
    for (const ask of [...asks.values()]) if (ask.agentId === agentId) ask.close(words);
  };

  async function drain(agentId: string): Promise<void> {
    while (!removed.has(agentId)) {
      const agent = store.agent(agentId);
      const person = agent && store.person(agent.person_id);
      if (!agent || !person) return;
      const stop = new AbortController();
      stops.set(agentId, stop);
      // Whether a message is something another agent asks this one, whose reply is owed to that agent.
      const asksMe = (each: Message | undefined) => each?.peer_id === agent.id && each.reply_to === null;
      // A turn the person stopped. Its messages that the agent had read are done with, and the messages the stop named that are still unread are left to send again. What another agent asked gets no answer.
      const stopped = (ids?: Iterable<string>) => {
        if (removed.has(agentId)) return;
        const read = [...(ids ?? [])].filter((id) => store.message(agent.id, id)?.status === "running");
        const unread = ((stop.signal.reason as string[] | undefined) ?? []).filter((id) => store.message(agent.id, id)?.status === "queued");
        // The chat says so, unless the stop came as the turn's last reply landed and changed nothing.
        if (!ids || read.length || unread.length) store.addMessage(agent.id, "sidebots", STOPPED, "done");
        for (const id of read) store.setStatus(id, asksMe(store.message(agent.id, id)) ? "failed" : "done");
        for (const id of unread) store.setStatus(id, "failed");
      };
      const driver = drivers[agent.provider];
      const account = store.account(person.id, agent.provider);
      const apiKey = store.apiKey(person.id, agent.provider);
      const message = store.nextQueued(agentId);
      const job = message ? undefined : store.dueJob(agentId, now());
      // The files the agent has asked to send, which its next message takes.
      const files: Upload[] = [];
      const others = () => store.agentsFor(person.id).filter((each) => each.id !== agent.id);
      const turn = async (text: string, rest: Pick<Turn, "followUps" | "seen" | "replied" | "sendUpdate"> & { id?: string; kind: TurnKind }) => {
        if (!account) throw new Error(`${person.name} hasn't set up ${PROVIDERS[agent.provider].name} on this computer.`);
        const ask = (question: Question, withdrawn: AbortSignal) =>
          new Promise<Answer>((resolve) => {
            // An ask raised while working on what another agent asked shows in that agent's chat too, where the person may be.
            const message = store.addMessage(agent.id, "agent", asking(question), "done", { ask: "waiting", question, jobId: job?.id, peerId: store.askedOf(agent.id)[0]?.agent_id });
            const settle = (answer: Exclude<Ask, "waiting">, words: string) => {
              clearTimeout(timer);
              withdrawn.removeEventListener("abort", late);
              asks.delete(message.id);
              store.answerAsk(message.id, answer);
              resolve(answer === "allowed" ? { allowed: true } : { allowed: false, words });
            };
            const late = () => settle("unanswered", `${person.name} didn't answer in time. Skip it, finish the rest, and say in your reply what you couldn't do.`);
            const timer = setTimeout(late, ASK_WAIT_MS);
            withdrawn.addEventListener("abort", late);
            asks.set(message.id, {
              agentId: agent.id,
              answer: (allow) => settle(allow ? "allowed" : "refused", `${person.name} said no to this. Don't do it, or the same thing another way. Finish the rest and say in your reply what you left out.`),
              close: (words) => settle("unanswered", words),
            });
          });
        // A job's run is a session of its own, which nothing comes back to. Any other turn carries on the chat's session.
        const sessionId = rest.kind === "job" ? null : agent.session_id;
        const result = await driver.runTurn({
          prompt: { id: rest.id ?? randomUUID(), text },
          followUps: rest.followUps,
          seen: rest.seen,
          replied: rest.replied,
          sendUpdate: rest.sendUpdate,
          ask,
          limits: (limits) => store.setLimits(person.id, agent.provider, limits),
          cwd: store.agentHome(agent.id),
          sessionId,
          spent: (sessionId !== null && store.sessionCost(agent.id, sessionId)) || 0,
          configDir: account.config_dir,
          apiKey,
          model: agent.model,
          effort: agent.effort,
          keepSession: rest.kind !== "job",
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
          listAgents: () => others().map((each) => each.name).join("\n") || `${person.name} has no other agents.`,
          askAgent: (name, text) => {
            const other = others().find((each) => each.name.toLowerCase() === name.trim().toLowerCase());
            if (!other) return `${person.name} has no other agent called ${name}. Their other agents: ${others().map((each) => each.name).join(", ") || "none"}.`;
            if (!text.trim()) return "Say what to ask.";
            store.addMessage(agent.id, "agent", text.trim(), "queued", { peerId: other.id });
            void kick(other.id);
            return `Sent to ${other.name}. Its answer will come to you as a message, in a turn of its own. Don't wait for it here: end your reply now, and say in a line that you've asked ${other.name}.`;
          },
          sendFiles: (paths) => {
            // Each file is read as it is counted, so a call that can't fit stops at the file that takes it too far.
            const added: Upload[] = [];
            let room = MESSAGE_BYTES - files.reduce((total, file) => total + file.bytes.byteLength, 0);
            for (const path of paths) {
              const file = store.fileToSend(agent.id, path);
              if (!file) return `There is no file at ${path}. Nothing was added, so give the paths again.`;
              room -= file.bytes.byteLength;
              if (room < 0) return "A message carries up to 95 MB of files. Nothing was added, so send fewer or smaller ones.";
              added.push(file);
            }
            files.push(...added);
            return "Added. They go with the next message you send.";
          },
        })
          // An ask the turn leaves behind, as when it fails or is stopped, waits for nobody.
          .finally(() => stopWaiting(agent.id, "The turn ended."));
        store.addUsage(agent.id, rest.kind, result, sessionId !== null);
        return result;
      };
      // Why a turn failed, as the chat says it. An error can quote what the turn ran with, and the person's API key never goes with it.
      const reason = (error: unknown) => {
        const words = driver.failure(error instanceof Error ? error.message : String(error));
        return apiKey ? words.replaceAll(apiKey, "your API key") : words;
      };

      if (job) {
        try {
          const replies: string[] = [];
          await turn(jobPrompt(job, person), { kind: "job", seen: () => undefined, replied: (reply) => replies.push(reply) });
          const reply = replies.at(-1) ?? "";
          if (!silent(reply)) store.addMessage(agent.id, "agent", reply, "done", { jobId: job.id, files });
        } catch (error) {
          // A job that keeps failing says so once, not on every run.
          const latest = store.agentWithLatest(agent.id)?.latest;
          if (!stop.signal.aborted && (latest?.sender !== "sidebots" || latest.status !== "failed")) store.addMessage(agent.id, "sidebots", `Sidebots couldn't run a job. ${reason(error)}`, "failed");
        }
        if (stop.signal.aborted) stopped();
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
        if (agent.session_id) await turn(remember(person), { kind: "memory", seen: () => undefined, replied: () => undefined }).catch(() => undefined);
        if (stop.signal.aborted) {
          // Stopped, a fresh start is called off, and the session stays.
          stopped([message.id]);
          continue;
        }
        store.setSession(agent.id, null);
        store.setStatus(message.id, "done");
        continue;
      }

      // The agent that sent this message, when another of the person's agents did: it asks something, or answers what this agent asked it.
      const from = message.peer_id === agent.id ? store.agent(message.agent_id) : undefined;
      if (message.peer_id === agent.id && !from) {
        store.setStatus(message.id, "failed");
        continue;
      }
      /**
       * Sends a reply to whoever it is owed. While the agent waits to hear
       * from another agent, its answer is still to come, so what it says goes
       * to the person as an update. Otherwise the reply answers the agents
       * that asked it something, or goes to the person.
       */
      const deliver = (reply: string) => {
        const sending = files.splice(0);
        if (store.asked(agent.id).length) return void store.addMessage(agent.id, "agent", reply, "done", { interim: true, files: sending });
        const owed = store.askedOf(agent.id);
        if (owed.length === 0) return void store.addMessage(agent.id, "agent", reply, "done", { files: sending });
        for (const asked of owed) {
          store.addMessage(agent.id, "agent", reply, "queued", { peerId: asked.agent_id, replyTo: asked.id });
          store.setStatus(asked.id, "done");
          void kick(asked.agent_id);
        }
      };

      // The messages sent into this turn, the first and any the person sends while it runs.
      const sent = new Set([message.id]);
      const quotedBy = (each: Message) => (each.reply_to ? store.message(agent.id, each.reply_to) : undefined);
      const followUps: FollowUps = {
        take: () => {
          const arrived = store.waitingFromPerson(agent.id).filter((each) => !sent.has(each.id));
          // The agent can't read a message while it waits on an ask, so a message is the person's answer to it.
          if (arrived.length) stopWaiting(agent.id, `${person.name} sent a message instead of answering. Leave this undone and read their message.`);
          return arrived.map((each) => {
            sent.add(each.id);
            return { id: each.id, text: promptFor(each, person, { recent: [], quoted: quotedBy(each), fromJobs: [] }) };
          });
        },
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
        store.addMessage(agent.id, "agent", update.trim(), "done", { interim: true, files: files.splice(0) });
        return "Sent. Carry on with the work.";
      };
      try {
        const result = await turn(
          promptFor(
            message,
            person,
            {
              recent: agent.session_id ? [] : store.messagesBefore(agent.id, message.id, RECENT_MESSAGES),
              quoted: quotedBy(message),
              fromJobs: store.sentByJobsBefore(agent.id, message.id),
            },
            from,
          ),
          {
            kind: "reply",
            id: message.id,
            // Another agent's message is a turn of its own, as a job's run is: the person isn't waiting on it, and a message of theirs gets its own turn.
            ...(from ? {} : { followUps, sendUpdate }),
            seen: (ids) => store.markSeen(ids),
            replied: (reply, ids) => {
              store.markSeen(ids);
              deliver(reply);
              // What another agent asked is done with once its answer goes, which `deliver` sees to.
              for (const id of ids) if (!asksMe(store.message(agent.id, id))) store.setStatus(id, "done");
            },
          },
        );
        store.setSession(agent.id, result.sessionId);
        if (!stop.signal.aborted && result.contextTokens > FRESH_START_TOKENS) store.addMessage(agent.id, "sidebots", FRESH_START, "queued");
      } catch (error) {
        if (stop.signal.aborted) {
          // Stopped, which `stopped` sees to.
        } else if (from && asksMe(message)) {
          // The agent that asked hears why it has no answer.
          store.addMessage(agent.id, "agent", `I couldn't finish this. ${reason(error)}`, "queued", { peerId: from.id, replyTo: message.id });
          store.setStatus(message.id, "failed");
          void kick(from.id);
        } else {
          store.addMessage(agent.id, "sidebots", `Sidebots couldn't finish this. ${reason(error)}`, "failed");
          for (const id of sent) if (store.message(agent.id, id)?.status !== "done") store.setStatus(id, "failed");
        }
      }
      if (stop.signal.aborted) stopped(sent);
    }
  }

  /** Starts the agent's queue if it isn't running. If it is running a turn the person can talk to, a new message of theirs goes into that turn. */
  function kick(agentId: string): Promise<void> {
    const running = busy.get(agentId);
    if (running) {
      arrivals.get(agentId)?.();
      return running;
    }
    const done = drain(agentId).finally(() => {
      busy.delete(agentId);
      stops.delete(agentId);
    });
    busy.set(agentId, done);
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

    /**
     * Stops the turn the agent is running: its work on the person's messages,
     * a job's run or a fresh start. The messages of theirs that the agent
     * hasn't read, sent into the turn or waiting for it to end, are left to
     * send again. The chat says "Stopped" once the turn has ended. The agent
     * keeps its session, so its next turn carries on from there. An agent
     * that waits to hear from another has no turn of its own to stop, and
     * stopping it stops that other agent's work for it.
     */
    stop(agentId: string, stopping = new Set<string>()): void {
      if (stopping.has(agentId)) return;
      stopping.add(agentId);
      const stop = stops.get(agentId);
      // The stop carries the messages that were unread as it was asked for, so one sent after it gets its turn.
      if (stop && !stop.signal.aborted) stop.abort(store.waitingFromPerson(agentId).map((unread) => unread.id));
      // What the agent asked other agents is called off with it. An agent at work on it is stopped, and one that hasn't started never reads it.
      for (const asked of store.asked(agentId)) {
        this.stop(asked.peer_id!, stopping);
        if (!busy.has(asked.peer_id!)) store.setStatus(asked.id, "failed");
      }
    },

    /** Gives an ask the person's answer, and the agent goes on with it. False when the agent has no such ask waiting. */
    answer(agentId: string, messageId: string, allow: boolean): boolean {
      const ask = asks.get(messageId);
      if (ask?.agentId !== agentId) return false;
      ask.answer(allow);
      return true;
    },

    /** Stops whatever the agent is running, waits for it to end, and removes the sessions its provider keeps for it, as the agent is deleted. */
    async remove(agent: Agent): Promise<void> {
      removed.add(agent.id);
      stops.get(agent.id)?.abort();
      await busy.get(agent.id)?.catch(() => undefined);
      const account = store.account(agent.person_id, agent.provider);
      try {
        if (account) await drivers[agent.provider].forget(store.agentHome(agent.id), account.config_dir);
      } finally {
        removed.delete(agent.id);
      }
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
