// The runner runs each agent's turns one at a time, on the provider the agent
// runs on, and gives every provider the same tools for the agent.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CONNECTIONS, MESSAGE_BYTES, PROVIDERS, fenced, runsFast, scheduleWords, selectionWords } from "./contract.ts";
import type { Agent, Ask, Connection, Effort, Found, Job, Limit, Message, Model, Provider, Question, Schedule, Selection, Switched, TurnKind } from "./contract.ts";
import { CONNECTION_TOOLS, type Connections, type Servers } from "./connections.ts";
import { selectionOf, type Person, type Store, type Upload } from "./store.ts";

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
  /** What the session has cost up to this turn, in US dollars, and the tokens it has used. A provider that counts a run's own tokens adds this turn's to them. */
  spent: { cost: number; tokens: number };
  /** The person's config folder for the provider. */
  configDir: string;
  /** The person's API key for the provider. Without one, the turn runs on the login in `configDir`. */
  apiKey?: string;
  model: Model;
  effort: Effort;
  /** Whether the turn runs in the provider's fast mode, which its model then has. */
  fast: boolean;
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
  /** Asks the person to connect one of their apps, with a card that takes them through its sign-in, and waits for them. Answers in words the agent reads. */
  connect: (connection: Connection) => Promise<string>;
  /** Uses a tool of one of the person's connections as them. Answers in words the agent reads. */
  useConnection: (tool: string, input: unknown) => Promise<string>;
  /** The tool servers of the person's connections whose makers run one, each with a token that lasts the turn. A provider reads each server's tools and uses them itself. */
  servers: () => Promise<Servers>;
  /** Asks the person before the agent does something, and waits for their answer. `withdrawn` aborts when the provider no longer wants one. */
  ask: (question: Question, withdrawn: AbortSignal) => Promise<Answer>;
  /** The provider says where limits of the person's plan stand. */
  limits: (limits: Limit[]) => void;
};
/**
 * `contextTokens` is how much the session held when the turn ended. `cost` is
 * what the session has cost since it began, in US dollars at the provider's
 * prices, and `tokens` is all its model has read and written since then, what
 * it read again from its cache among them.
 */
export type TurnResult = { sessionId: string; contextTokens: number; cost: number; tokens: number };
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
 * `limits` asks the provider where the limits of the plan on the login in
 * `configDir` stand, with no turn run, and ends what it started for that once
 * `giveUp` aborts. It answers null when that login is an API key, which has
 * no plan.
 */
export type Driver = {
  runTurn: RunTurn;
  failure: (words: string) => string;
  forget: (cwd: string, configDir: string) => void | Promise<void>;
  limits: (configDir: string, giveUp: AbortSignal) => Promise<Limit[] | null>;
};
/** A driver for each provider. */
export type Drivers = Record<Provider, Driver>;

/**
 * A tool Sidebots gives the agent: its name, what the agent is told it does,
 * what it takes, and what it does, in words the agent reads. A tool that is
 * `checked` is one a driver doesn't just run: it `reads` the machine's files,
 * or it `acts` as the person outside the machine, as sending a mail does. The
 * rest always run.
 */
export type Tool<Input extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  checked?: "reads" | "acts";
  input: Input;
  run(input: z.infer<z.ZodObject<Input>>): string | Promise<string>;
};
const define = <Input extends z.ZodRawShape>(tool: Tool<Input>): Tool => tool as Tool;

// The most facts a tool's ask lists from what it was given, and the longest a value among them can be.
const FACTS = 4;
const FACT_CHARS = 80;
/** A name as code writes one, as words: `send_email` is "Send email". */
const words = (name: string) => name.replace(/[_-]+/g, " ").trim().replace(/^./, (first) => first.toUpperCase());

/**
 * A call to a tool, in the parts the person reads to say yes or no: `from` is
 * whose tool it is, when it is somebody's, and the tool's name is what it
 * does. What it was given in a few words is its facts, a short list as its
 * items in a line, and all of it is its detail.
 */
export function toolQuestion(from: string | undefined, name: string, input: Record<string, unknown>): Question {
  const facts = Object.entries(input).flatMap(([key, value]): Question["facts"] => {
    const text = Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(", ") : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    return text && text.length <= FACT_CHARS && !text.includes("\n") ? [[words(key), text]] : [];
  });
  return { kind: "tool", title: from ? `Use ${from}` : "Use a tool", what: words(name), facts: facts.slice(0, FACTS), detail: JSON.stringify(input, null, 2) };
}

/**
 * Added to every provider's own prompt: when a reply comes with something to
 * look at. A tool's description tells an agent how to use the tool once it has
 * thought of it, and an agent that can answer in words doesn't think of
 * `send_files`.
 */
export const SHOW =
  "The person reads you in a chat, so show them what is better seen than read. Answer numbers that compare or change with a chart, and things to choose between with a card for each, as a page you send with `send_files`. Asked what something looks like, send a picture of it. Your reply then keeps to the short of it. A plain answer stays plain words.";

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
        "Send the person files: a photo, a chart, a PDF, anything you made or found for them. The files go with the next message you send, which is your reply unless you send an update first, and show above its text: a picture as a picture, a page as a page, any other file as a card that opens it. Use it whenever the person should have the file itself and not only your words about it. Up to 95 MB to a message. A file whose name ends in .html is a page: it is drawn in the chat and opens larger, so use one for what words can't carry, such as a chart, a table or a layout. Write it as one file that fits a phone's width and wider ones, with its styles and scripts inside it. A picture goes inside it too, or stays on the web as an https address. The chat shows the file's name above the page as its title, so name it as one, such as `Flats in Brunswick.html`, and give the page no title of its own and no space around its edges. The chat shows the top of a long page until the person opens it, so what matters most goes first. The page is given the chat's background and text colour, which change between light and dark, so set neither yourself. Colour the rest with the CSS variables it is also given: var(--ink) for text, var(--ink2) for quiet text, var(--line) for rules, var(--field) for a fill behind something, and var(--tint) for the one thing to pick out. Any colour of your own has to read on both white and black.",
      checked: "reads",
      input: { paths: z.array(z.string()).describe("Each file's path, in full or from your home folder") },
      run: ({ paths }) => turn.sendFiles(paths),
    }),
    define({
      name: "connect",
      description: `Connect one of the person's apps, so that you and their other agents can use it as them: ${Object.entries(CONNECTIONS)
        .map(([id, { name }]) => `\`${id}\` for ${name}`)
        .join(", ")}. It puts a card in the chat that takes the person through the app's own sign-in, and waits for them. An app with no tools among yours gives you its own once it is connected. Use it when they ask you to connect an app, when one of an app's tools answers that it isn't connected, or when they ask for something in one of these apps and you have no tools of its.`,
      input: { app: z.enum(Object.keys(CONNECTIONS) as [Connection, ...Connection[]]).describe("The app to connect") },
      run: ({ app }) => turn.connect(app),
    }),
    ...CONNECTION_TOOLS.map(({ name, description, checked, input }) => define({ name, description, checked, input, run: (given) => turn.useConnection(name, given) })),
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
/** What a change of what the agent answers with shows in the chat, in an app that doesn't draw it. */
const switchedWords = ({ from, to }: Switched) => `Switched from ${selectionWords(from, to).join(" ")} to ${selectionWords(to, from).join(" ")}`;
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
// How long what a provider said of a plan's limits stands before it is asked again, and how long it is given to answer: half as long as the phone waits for Usage.
const LIMITS_FRESH_MS = 60_000;
const LIMITS_WAIT_MS = 5_000;
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

/** What the agent is asked before its session is replaced: by a fresh one, or by one on another provider. */
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

Your reply is sent to ${person.name} as a message and notifies them. If this run found nothing worth telling them, reply with only the word ${SILENT}.`;
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
  return `${chat}${from.name}, another of ${person.name}'s agents, sent you the message below. ${person.name} didn't write it. Your reply goes back to ${from.name} and not to ${person.name}, so say what ${from.name} needs.\n\n${message.body}`;
}

/**
 * Runs each agent's work one turn at a time: the messages it was sent, in the
 * order they came, and then any job whose time has come. A message the person
 * sends during a turn goes into that turn instead of waiting for the next.
 *
 * A turn runs on what the agent answers with as the turn starts. When the
 * person has picked something else since the agent's last turn, the chat says
 * so first. A session doesn't cross to another provider, so an agent moved to
 * one is handed over as for a fresh start: it saves what is worth keeping to
 * its memory in the session it had, and starts a new one on the new provider
 * with the latest of the chat.
 *
 * An agent can ask another of the person's agents something. What it asks
 * waits in the other's queue as a message, and the other's reply comes back
 * the same way, so each agent's turn ends before the other's begins and
 * neither holds a turn open while it waits.
 */
export function createQueue(store: Store, drivers: Drivers, connections: Connections, now: () => number = Date.now) {
  const busy = new Map<string, Promise<void>>();
  // What stops the turn each working agent is running.
  const stops = new Map<string, AbortController>();
  // The agents being deleted, whose queues end with the turn they are running.
  const removed = new Set<string>();
  // For an agent running a turn the person can talk to, what to call when they send another message.
  const arrivals = new Map<string, () => void>();
  // The asks that wait for the person, by the message that asks: whose agent's it is, the connection it asks for when it asks for one, what to call with the person's answer, and what closes it unanswered, with what the agent is told.
  const asks = new Map<string, { agentId: string; connection?: Connection; answer: (allow: boolean) => void; close: (words: string) => void }>();
  // The last time each person's provider was asked where the limits of their plan stand: when, and the ask itself, which ends once what it said is kept.
  const limitsAsked = new Map<string, { at: number; done: Promise<void> }>();
  // The logins a provider last said are API keys, each as the person and the provider.
  const keyLogins = new Set<string>();
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
        // The chat says so, unless the stop changed nothing in it: it came as the turn's last reply landed, or it called off what another agent asked before the turn had read it.
        if (!ids || read.length || unread.length) store.addMessage(agent.id, "sidebots", STOPPED, "done");
        for (const id of read) store.setStatus(id, asksMe(store.message(agent.id, id)) ? "failed" : "done");
        for (const id of unread) store.setStatus(id, "failed");
      };
      // How the person's agents run on a provider: its driver, the person's config folder for it, and their API key when they gave one.
      const signedIn = (provider: Provider) => ({ driver: drivers[provider], account: store.account(person.id, provider), apiKey: store.apiKey(person.id, provider) });
      const { driver, apiKey } = signedIn(agent.provider);
      // What the agent's session is on: what its last turn ran on.
      const ranOn = agent.switched_from ?? selectionOf(agent);
      const message = store.nextQueued(agentId);
      const job = message ? undefined : store.dueJob(agentId, now());
      // The files the agent has asked to send, which its next message takes.
      const files: Upload[] = [];
      const others = () => store.agentsFor(person.id).filter((each) => each.id !== agent.id);
      // Runs a turn on what the agent answers with, or on `on` when its session is still on something else.
      const turn = async (text: string, rest: Pick<Turn, "followUps" | "seen" | "replied" | "sendUpdate"> & { id?: string; kind: TurnKind }, on: Selection = agent) => {
        const { driver, account, apiKey } = signedIn(on.provider);
        if (!account) throw new Error(`${person.name} hasn't set up ${PROVIDERS[on.provider].name} on this computer.`);
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
              connection: question.connection,
              answer: (allow) => settle(allow ? "allowed" : "refused", `${person.name} said no to this. Don't do it, or the same thing another way. Finish the rest and say in your reply what you left out.`),
              close: (words) => settle("unanswered", words),
            });
          });
        // A job's run is a session of its own, which nothing comes back to. Any other turn carries on the chat's session.
        const sessionId = rest.kind === "job" ? null : agent.session_id;
        const before = sessionId === null ? undefined : store.sessionUsed(agent.id, sessionId);
        const result = await driver.runTurn({
          prompt: { id: rest.id ?? randomUUID(), text },
          followUps: rest.followUps,
          seen: rest.seen,
          replied: rest.replied,
          sendUpdate: rest.sendUpdate,
          ask,
          limits: (limits) => store.setLimits(person.id, on.provider, limits),
          cwd: store.agentHome(agent.id),
          sessionId,
          spent: { cost: before?.cost ?? 0, tokens: before?.tokens ?? 0 },
          configDir: account.config_dir,
          apiKey,
          model: on.model,
          effort: on.effort,
          fast: runsFast(on),
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
          connect: async (connection) => {
            const { name, allows } = CONNECTIONS[connection];
            const already = connections.account(person.id, connection);
            if (already) return `${name} is already connected, as ${already}.`;
            const answer = await ask({ kind: "connection", connection, title: `Connect ${name}`, what: allows, facts: [], detail: "" }, stop.signal);
            return answer.allowed ? `${name} is connected, as ${connections.account(person.id, connection)}. You and ${person.name}'s other agents can use it from now on. If you have no tools of its yet, they reach you on your next turn: tell ${person.name} it is connected, and to ask again.` : answer.words;
          },
          useConnection: (tool, input) => connections.use(person.id, tool, input),
          servers: () => connections.servers(person.id),
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

      // A fresh start is no turn of the agent's own, so what the person picked waits for the turn after it.
      if (agent.switched_from && (job || (message && message.sender !== "sidebots"))) {
        const handsOver = ranOn.provider !== agent.provider && agent.session_id !== null;
        const notice = store.addMessage(agent.id, "sidebots", switchedWords({ from: ranOn, to: selectionOf(agent) }), handsOver ? "running" : "done", { switched: { from: ranOn, to: selectionOf(agent) } });
        if (handsOver) {
          // The session goes even when the agent couldn't save first, as for a fresh start.
          await turn(remember(person), { kind: "memory", seen: () => undefined, replied: () => undefined }, ranOn).catch(() => undefined);
          store.setSession(agent.id, null);
          store.setStatus(notice.id, "done");
        }
        store.setRunsOn(agent.id, selectionOf(agent));
        // Stopped while it handed over, the turn it was for doesn't run.
        if (stop.signal.aborted) stopped();
        continue;
      }

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
        if (agent.session_id) await turn(remember(person), { kind: "memory", seen: () => undefined, replied: () => undefined }, ranOn).catch(() => undefined);
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
              // What another agent asked and has called off gets no answer, though the turn was too far along to end without one.
              if (store.message(agent.id, message.id)?.status === "failed") return;
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
      // What the agent asked other agents is called off with it. An agent at work on it is stopped, and one that hasn't read it never does.
      for (const asked of store.asked(agentId)) {
        this.stop(asked.peer_id!, stopping);
        if (asked.status === "queued" || !busy.has(asked.peer_id!)) store.setStatus(asked.id, "failed");
      }
    },

    /** Gives an ask the person's answer, and the agent goes on with it. False when the agent has no such ask waiting, and for a yes to an ask for a connection, which only making the connection says. */
    answer(agentId: string, messageId: string, allow: boolean): boolean {
      const ask = asks.get(messageId);
      if (ask?.agentId !== agentId || (allow && ask.connection)) return false;
      ask.answer(allow);
      return true;
    },

    /** Has the agents that wait for the person to make a connection go on, once they have made it. */
    connected(personId: string, connection: Connection): void {
      for (const ask of [...asks.values()]) if (ask.connection === connection && store.agent(ask.agentId)?.person_id === personId) ask.answer(true);
    },

    /** Stops whatever the agent is running, waits for it to end, and removes the sessions each provider it ran on keeps for it, as the agent is deleted. */
    async remove(agent: Agent): Promise<void> {
      removed.add(agent.id);
      stops.get(agent.id)?.abort();
      await busy.get(agent.id)?.catch(() => undefined);
      try {
        for (const { provider, config_dir } of store.accounts(agent.person_id)) await drivers[provider].forget(store.agentHome(agent.id), config_dir);
      } finally {
        removed.delete(agent.id);
      }
    },

    /**
     * Asks each provider the person's agents sign in to with the login in
     * their config folder where the limits of that login's plan stand, and
     * keeps what it says. A provider asked in the last minute isn't asked
     * again: a call made while that ask is out waits for it. One that fails
     * or doesn't answer in time leaves what it last said. Answers the
     * providers whose login is an API key, which has no plan.
     */
    async askLimits(personId: string): Promise<Provider[]> {
      const accounts = store.accounts(personId);
      await Promise.all(
        accounts.map(async ({ provider, config_dir }) => {
          if (store.apiKey(personId, provider) !== undefined) return;
          const key = `${personId} ${provider}`;
          const last = limitsAsked.get(key);
          if (last && now() - last.at < LIMITS_FRESH_MS) return last.done;
          const giveUp = AbortSignal.timeout(LIMITS_WAIT_MS);
          const late = new Promise<never>((_, reject) => giveUp.addEventListener("abort", () => reject(giveUp.reason)));
          const done = Promise.race([drivers[provider].limits(config_dir, giveUp), late]).then(
            (limits) => {
              if (limits) {
                keyLogins.delete(key);
                store.setLimits(personId, provider, limits);
              } else keyLogins.add(key);
            },
            () => undefined,
          );
          limitsAsked.set(key, { at: now(), done });
          return done;
        }),
      );
      return accounts.map(({ provider }) => provider).filter((provider) => keyLogins.has(`${personId} ${provider}`));
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
