// The runner runs each agent's turns on the provider the agent runs on, and
// gives every provider the same tools for the agent. An agent's chat has one
// turn at a time, and what the agent runs by itself, a job or work the person
// started, has one at a time beside it.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CONNECTIONS, JOB_RUN, MESSAGE_BYTES, PROVIDERS, fenced, isSuggestion, nextRun, runsFast, sameSelection, scheduleProblem, scheduleWords, selectionOf, selectionWords } from "./contract.ts";
import type { Agent, Ask, Connection, Effort, Found, Job, JobFields, Limit, Message, Model, Provider, Question, Schedule, Selection, Switched, TurnKind } from "./contract.ts";
import { CONNECTION_TOOLS, type Connections, type Servers } from "./connections.ts";
import type { Person, Store, Upload } from "./store.ts";

/**
 * A job as an agent saves one: its title, what to do on each run, one of three
 * ways to say when, and whether it runs. With `id` it changes that job, and
 * what it leaves out stays as it was.
 */
export type JobRequest = { id?: string; title?: string; what?: string; every_minutes?: number; daily_at?: string; weekdays?: number[]; once_at?: string; enabled?: boolean };

/** Work an agent offers to do: what the card names it, why it is worth doing now, and what the agent will do once the person starts it. */
export type Offer = { title: string; why: string; what: string };

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
  runJobNow: (id: string) => string;
  /** Offers the person a piece of work as a suggestion, which goes to them once the agent's reply has. Answers in words the agent reads. */
  suggest: (offer: Offer) => string;
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
  /** The provider compacted the session: it put a summary in the place of the oldest of what the session held, to make room. */
  compacted: () => void;
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
  /**
   * For a provider that reads a session anew at the full price once it has
   * sat a while: the message that has it compact the session before a turn
   * in it, or null when the turn is to read the session as it is. `held` is
   * what the session held after its last turn, `idleMs` how long ago that
   * turn ended, and `onKey` whether the person pays by API key.
   */
  compactFirst?: (session: { held: number; idleMs: number; onKey: boolean }) => string | null;
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
        "Save a job that Sidebots runs for you later with nobody asking: once at a time, at a time of day, or every so many minutes. Use it for a reminder, a regular check, or anything the person wants done or watched without asking again. Each run is a session of its own that is given `what` and remembers nothing else, and what you reply then is sent to the person, so write `what` as full instructions to yourself, including when a run should stay silent. A new job needs a short `title` the person knows it by, `what`, and exactly one of every_minutes, daily_at and once_at. With `id`, it changes that job instead: give only what changes, and `enabled: false` pauses it until `enabled: true`. Times are this machine's local time, and the answer tells you the time now.",
      input: {
        id: z.string().optional().describe("The job to change, as list_jobs gives it. Leave out for a new job."),
        title: z.string().optional().describe("A few words the person knows the job by, such as Morning brief"),
        what: z.string().optional().describe("What to do on each run, written to yourself"),
        every_minutes: z.number().optional().describe("Run every this many minutes"),
        daily_at: z.string().optional().describe("Run at this time of day, as HH:MM on a 24-hour clock"),
        weekdays: z.array(z.number()).optional().describe("With daily_at, the days it runs on, where 0 is Sunday. Leave out for every day."),
        once_at: z.string().optional().describe("Run once at this time, as YYYY-MM-DDTHH:MM"),
        enabled: z.boolean().optional().describe("False pauses the job, and true runs it again. A new job runs unless this is false."),
      },
      run: (request) => turn.scheduleJob(request),
    }),
    define({ name: "list_jobs", description: "List the jobs you have saved, with when each next runs, how its last run went, and the time now.", input: {}, run: () => turn.listJobs() }),
    define({
      name: "cancel_job",
      description: "Remove one of your jobs.",
      input: { id: z.string().describe("The job's id, as list_jobs gives it") },
      run: ({ id }) => turn.cancelJob(id),
    }),
    define({
      name: "run_job_now",
      description: "Run one of your jobs now, in a session of its own as on its schedule, which it keeps.",
      input: { id: z.string().describe("The job's id, as list_jobs gives it") },
      run: ({ id }) => turn.runJobNow(id),
    }),
    define({
      name: "suggest",
      description:
        "Offer the person a piece of work you could do for them by yourself. It shows under your reply as a card with a Start button. Use it when what you found leaves something you could take off their hands, such as drafting an answer or comparing options, instead of asking in words whether you should. Don't do the work now. If they start it, it runs later in a session of its own, beside the chat, that is given `what` and remembers nothing else, so write `what` as full instructions to yourself. What that run replies is sent to them as the answer to the suggestion. Suggest up to three at once, the one that matters most first. Your next suggestions take the place of the ones they haven't answered.",
      input: {
        title: z.string().describe("The work in a few words, as the card names it"),
        why: z.string().describe("In a sentence, what you found that makes it worth doing now"),
        what: z.string().describe("What to do once they start it, written to yourself"),
      },
      run: (offer) => turn.suggest(offer),
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
export function switchedWords({ from, to }: Switched): string {
  return `Switched from ${selectionWords(from, to).join(" ")} to ${selectionWords(to, from).join(" ")}`;
}
/** What a stopped turn shows in the chat. */
const STOPPED = "Stopped";
/** What the chat shows where the agent's provider compacted its session. */
const COMPACTED = "Compacted";
// How many messages a session is shown that it hasn't seen: the chat so far for a new session, and what its own runs sent for one that is going.
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
// The most an agent suggests in one turn.
const SUGGESTIONS = 3;
// How long what a provider said of a plan's limits stands before it is asked again, and how long it is given to answer.
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

/**
 * The schedule an agent asked for, or what is wrong with the request. A
 * request that gives none of the ways to say when, as a change to a job's
 * title alone does, leaves the schedule undefined.
 */
function toSchedule(request: JobRequest): Schedule | string | undefined {
  if (request.weekdays !== undefined && request.daily_at === undefined) return "Give weekdays with daily_at.";
  const ways = [request.every_minutes, request.daily_at, request.once_at].filter((way) => way !== undefined);
  if (ways.length === 0 && request.id !== undefined) return undefined;
  if (ways.length !== 1) return "Give exactly one of every_minutes, daily_at and once_at.";
  if (request.every_minutes !== undefined) return { type: "every", minutes: request.every_minutes };
  if (request.daily_at !== undefined) {
    // Days are kept in their order by number, as the apps save them, so a schedule saved again unchanged reads the same.
    const weekdays = [...new Set(request.weekdays ?? [])].sort((a, b) => a - b);
    return weekdays.length ? { type: "daily", time: request.daily_at, weekdays } : { type: "daily", time: request.daily_at };
  }
  // A time with no zone is read as this machine's own.
  const at = new Date(request.once_at!).getTime();
  return Number.isNaN(at) ? "once_at must be a time such as 2026-11-16T17:00." : { type: "once", at };
}

/**
 * Makes the agent a person starts with, as they are added, on the provider
 * they were set up on: Ruby, who briefs them every morning at `brief`, a time
 * of day as `08:00`. It starts with that as what it is for, with the job that
 * does it, and with a first message that says so and how to change it. With
 * no `brief`, Ruby has no job and is there for whatever the person asks.
 * Under the first message it suggests the two apps a brief reads, each as a
 * card that connects the app, after which Ruby says what it now sees there.
 */
export function addFirstAgent(store: Store, person: Person, brief: string | null = "08:00", now = Date.now()): Agent {
  const provider = store.accounts(person.id)[0].provider;
  const learns = "When they tell you more of what they want from you, write it into this file.";
  const connect = `Connect your calendar or your Gmail below, or say "connect my calendar" and I'll set it up.`;
  let agent: Agent;
  if (brief) {
    const schedule: Schedule = { type: "daily", time: brief };
    agent = store.createAgent(person, "Ruby", "cog", provider, `You brief ${person.name} every morning on what their day holds and what needs them, by a job you start with, and you help with whatever else they ask. ${learns}`);
    const what = `Brief ${person.name} on their day. Read today's calendar, the mail that has come since your last brief and needs an answer from them, and what is due in Notion, from whichever of those you have tools for. Lead with the one or two things that most need them today, then the rest in a few short lines. When something in it is work you could do for them, offer it with \`suggest\`. When you have tools for none of them, tell ${person.name} once that saying "connect my calendar" or "connect my Gmail" gives you their day to brief them on, note in your memory that you told them, and stay silent on later runs until you have one.`;
    store.addJob(agent.id, { title: "Morning brief", what, schedule, enabled: true }, nextRun(schedule, now));
    store.addMessage(
      agent.id,
      "agent",
      `Hi, I'm Ruby. Every morning at ${timeWords(brief)} I'll send you a short brief: what's on today, and what needs you.\n\nFor that I need to see your day. ${connect}\n\nWant another time, or no brief at all? Tell me. And I can help with other things too, so ask.`,
      "done",
    );
  } else {
    agent = store.createAgent(person, "Ruby", "cog", provider, `You help ${person.name} with whatever they ask. ${learns}`);
    store.addMessage(agent.id, "agent", `Hi, I'm Ruby. Ask me for anything. When you want something done every day or every week, tell me and I'll do it by myself.\n\nI can do more once I see your day. ${connect}`, "done");
  }
  const sees: [Connection, string][] = [
    ["calendar", `Google Calendar is connected now. Read today's and tomorrow's events and tell ${person.name} what is on, in a few short lines.`],
    ["gmail", `Gmail is connected now. Read the mail of the last few days that needs an answer from ${person.name} and tell them what there is, in a few short lines.`],
  ];
  for (const [connection, detail] of sees) suggest(store, agent.id, suggestion(`Connect ${CONNECTIONS[connection].name}`, detail, CONNECTIONS[connection].allows, connection));
  return agent;
}

/** A time of day as it is said in a sentence: `08:00` is "8", and `07:30` is "7:30". */
export function timeWords(time: string): string {
  return time.replace(/^0/, "").replace(/:00$/, "");
}

/** A job's schedule, when it next runs and how its last run went, as the agent reads them. */
function jobWords(job: Job): string {
  const next = !job.enabled ? "paused" : job.next_at === null ? "not scheduled" : `next at ${clock(job.next_at)}`;
  const last =
    job.last_run_status === "never" || job.last_run_at === null
      ? JOB_RUN.never.toLowerCase()
      : `last run at ${clock(job.last_run_at)}, ${JOB_RUN[job.last_run_status].toLowerCase()}${job.last_run_error ? `: ${job.last_run_error}` : ""}`;
  return `${scheduleWords(job.schedule)}, ${next}, ${last}`;
}

/** What the agent is asked on a run of one of its jobs: one its schedule started, or one run now, beside its schedule. */
function jobPrompt(job: Job, person: Person, now: boolean): string {
  return `This is a run of one of your jobs, "${job.title}" (${scheduleWords(job.schedule)}), started ${now ? "now, beside its schedule" : "by Sidebots' clock"}. ${person.name} hasn't sent anything. What you saved for it:

${job.what}

Do it now. This run is a session of its own. It remembers no earlier run and nothing from the chat, so keep what the next run needs in your memory, such as what you have already told ${person.name}.

Your reply is sent to ${person.name} as a message and notifies them. If this run found nothing worth telling them, reply with only the word ${SILENT}.`;
}

/** What the agent is asked on the run of work it suggested, once the person has started it. */
function workPrompt(work: Message, person: Person): string {
  const { what, detail, why } = work.question!;
  return `${person.name} started a piece of work you suggested: "${what}".${why ? ` You offered it because: ${why}` : ""} What you wrote for it:

${detail}

Do it now. This run is a session of its own, beside your chat with ${person.name}. It remembers nothing from the chat, so keep what you will need later in your memory.

Your reply is sent to ${person.name} as the answer to the suggestion and notifies them. Say what you did and what, if anything, is left for them.`;
}

/** Work an agent offers to do, as the card that suggests it: what it is, what the agent will do, why it offers it now, and the app it connects when it connects one. */
function suggestion(what: string, detail: string, why: string, connection?: Connection): Question {
  return { kind: "work", ...(connection ? { connection } : {}), title: "Suggestion", what, facts: [], detail, ...(why ? { why } : {}) };
}

/** Puts a suggestion in an agent's chat, where it waits for the person to start it. `jobId` is the run that offered it, when one of the agent's own did. */
function suggest(store: Store, agentId: string, question: Question, jobId?: string): void {
  store.addMessage(agentId, "agent", asking(question), "done", { ask: "waiting", question, interim: true, jobId });
}

/** Whether a job's run chose to send nothing. */
const silent = (reply: string) => reply.trim() === "" || new RegExp(`^\\W*${SILENT}\\W*$`, "i").test(reply);

/**
 * A message as the agent reads it: the message it answers, the files sent
 * with it, and what the session hasn't seen. For a new session that is the
 * chat so far, and for one going it is the latest of what the agent's own
 * runs have sent, which says so when there was more.
 * A message from another of the person's agents, `from`, says so first: that
 * agent asks something, or answers what this agent asked it, which is
 * `quoted`.
 */
function promptFor(message: Message, person: Person, unseen: { recent: Message[]; quoted?: Message; fromRuns: Message[] }, from?: Agent): string {
  if (from) return fromAgent(message, person, unseen, from);
  const { recent, quoted, fromRuns } = unseen;
  const quote = quoted ? `Replying to ${quoted.sender === "person" ? "their own earlier message" : "your message"}: "${quoted.body.slice(0, QUOTE_CHARS)}"\n\n` : "";
  const files = message.attachments.length ? `\n\nSent with this message: ${message.attachments.join(", ")}` : "";
  const sent = `${quote}${message.body}${files}`.trim();
  const lines = (messages: Message[]) => messages.map((earlier) => `${earlier.sender === "person" ? person.name : "You"}: ${earlier.body.slice(0, RECENT_MESSAGE_CHARS)}`).join("\n\n");
  if (recent.length) return `This is a fresh session in a chat that was already going. The latest messages in it:\n\n${lines(recent)}\n\n${person.name}'s new message:\n\n${sent}`;
  if (fromRuns.length) {
    const these =
      fromRuns.length > RECENT_MESSAGES
        ? `messages this session hasn't seen. These are the latest ${RECENT_MESSAGES}, and \`search_history\` finds earlier ones by a word or phrase in them`
        : "these messages, which this session hasn't seen";
    return `Your jobs and the work ${person.name} started run in sessions of their own. They sent ${person.name} ${these}:\n\n${lines(fromRuns.slice(-RECENT_MESSAGES))}\n\n${person.name}'s new message:\n\n${sent}`;
  }
  return sent;
}

/** A message from another of the person's agents as the agent reads it, with the chat so far when its session is new. */
function fromAgent(message: Message, person: Person, { recent, quoted }: { recent: Message[]; quoted?: Message }, from: Agent): string {
  const lines = recent.map((earlier) => `${earlier.sender === "person" ? person.name : "You"}: ${earlier.body.slice(0, RECENT_MESSAGE_CHARS)}`).join("\n\n");
  const chat = lines ? `This is a fresh session in a chat that was already going. The latest messages between you and ${person.name}:\n\n${lines}\n\n` : "";
  if (quoted) return `${chat}${from.name} answered what you asked it ("${quoted.body.slice(0, QUOTE_CHARS)}"):\n\n${message.body}`;
  return `${chat}${from.name}, another of ${person.name}'s agents, sent you the message below. ${person.name} didn't write it. Your reply goes back to ${from.name} and not to ${person.name}, so say what ${from.name} needs.\n\n${message.body}`;
}

/** The two lines of turns an agent has: its chat's, and beside them what it runs by itself. */
const LANES = ["chat", "own"] as const;
type Lane = (typeof LANES)[number];
const laneKey = (lane: Lane, agentId: string) => `${lane} ${agentId}`;

/**
 * Runs each agent's work one turn at a time in each of its lanes. Its chat's
 * lane has the messages it was sent, in the order they came, and a message
 * the person sends during a turn goes into that turn instead of waiting for
 * the next. Beside it, the agent's own lane has what it runs by itself, each
 * in a session of its own: the suggestions the person started, and then any
 * job whose time has come. So the chat stays free while that work runs.
 *
 * A turn runs on what the agent answers with as the turn starts, which the
 * agent keeps as `ran_on`. When the person has picked something else since
 * the agent's last turn, the chat says so first. A session doesn't cross to
 * another provider, so an agent moved to one is handed over as for a fresh
 * start: it saves what is worth keeping to its memory in the session it had,
 * and starts a new one on the new provider
 * with the latest of the chat.
 *
 * An agent can ask another of the person's agents something. What it asks
 * waits in the other's queue as a message, and the other's reply comes back
 * the same way, so each agent's turn ends before the other's begins and
 * neither holds a turn open while it waits.
 */
export function createQueue(store: Store, drivers: Drivers, connections: Connections, now: () => number = Date.now) {
  // The lanes that are running, and what stops the turn each is on, both by `laneKey`.
  const busy = new Map<string, Promise<void>>();
  const stops = new Map<string, AbortController>();
  // The lanes kicked while they ran, by `laneKey`. Each looks once more as it ends, for what came as its loop was ending.
  const kicked = new Set<string>();
  // What each agent's own lane is on: the job, or the work the person started, by its id.
  const own = new Map<string, string>();
  // The jobs to run now, beside their schedules, by agent, in the order they were asked for.
  const runsNow = new Map<string, string[]>();
  /** The next of the agent's jobs to run now that it still has. */
  const nextRunNow = (agentId: string): Job | undefined => {
    const ids = runsNow.get(agentId) ?? [];
    for (let id = ids.shift(); id !== undefined; id = ids.shift()) {
      const job = store.job(agentId, id);
      if (job) return job;
    }
    runsNow.delete(agentId);
    return undefined;
  };

  /**
   * Saves one of the agent's jobs: a new one, or, with `jobId`, that job with
   * what `changes` changes. A new job, one whose schedule changed and one
   * turned back on run next at the schedule's next time from now, and one
   * turned back on whose one time has passed can't be. Answers with the job,
   * or with what is wrong, in words.
   */
  function saveJob(agentId: string, changes: Partial<JobFields>, jobId?: string): Job | string {
    const before = jobId === undefined ? undefined : store.job(agentId, jobId);
    if (jobId !== undefined && !before) return "No such job.";
    const schedule = changes.schedule ?? before?.schedule;
    const fields = { title: (changes.title ?? before?.title ?? "").trim(), what: (changes.what ?? before?.what ?? "").trim(), enabled: changes.enabled ?? before?.enabled ?? true };
    if (!fields.title) return "Give the job a name.";
    if (!fields.what) return "Say what the agent does on each run.";
    if (!schedule) return "Give the job a schedule.";
    const time = now();
    const rescheduled = !before || JSON.stringify(schedule) !== JSON.stringify(before.schedule);
    const problem = rescheduled ? scheduleProblem(schedule, time) : null;
    if (problem) return problem;
    const resumed = fields.enabled && before?.enabled === false;
    const nextAt = !before || rescheduled || resumed ? nextRun(schedule, time) : before.next_at;
    if (resumed && nextAt === null) return "That time has passed. Pick a time still to come.";
    const saved = before ? store.updateJob(agentId, before.id, { ...fields, schedule }, nextAt) : store.addJob(agentId, { ...fields, schedule }, nextAt);
    return saved ?? "No such job.";
  }

  /** Runs one of the agent's jobs now, beside its schedule. Answers with what is wrong, in words, or null once the run is on its way. */
  function runJobNow(agentId: string, jobId: string): string | null {
    if (!store.job(agentId, jobId)) return "No such job.";
    const waiting = runsNow.get(agentId) ?? [];
    if (own.get(agentId) === jobId || waiting.includes(jobId)) return "It is running already.";
    runsNow.set(agentId, [...waiting, jobId]);
    void kick(agentId);
    return null;
  }
  // The agents being deleted, whose queues end with the turn they are running.
  const removed = new Set<string>();
  // For an agent running a turn the person can talk to, what to call when they send another message.
  const arrivals = new Map<string, () => void>();
  // The asks that wait for the person, by the message that asks: whose agent's it is and which of its lanes raised it, the connection it asks for when it asks for one, what to call with the person's answer, and what closes it unanswered, with what the agent is told.
  const asks = new Map<string, { agentId: string; lane: Lane; connection?: Connection; answer: (allow: boolean) => void; close: (words: string) => void }>();
  // When each person's provider was last asked where the limits of their plan stand.
  const limitsAsked = new Map<string, number>();
  /** Closes the asks one of an agent's lanes has waiting, unanswered. */
  const stopWaiting = (agentId: string, lane: Lane, words: string) => {
    for (const ask of [...asks.values()]) if (ask.agentId === agentId && ask.lane === lane) ask.close(words);
  };

  async function drain(agentId: string, lane: Lane): Promise<void> {
    while (!removed.has(agentId)) {
      const agent = store.agent(agentId);
      const person = agent && store.person(agent.person_id);
      if (!agent || !person) return;
      const stop = new AbortController();
      stops.set(laneKey(lane, agentId), stop);
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
      const ranOn = agent.ran_on ?? selectionOf(agent);
      const message = lane === "chat" ? store.nextQueued(agentId) : undefined;
      const work = lane === "own" ? store.nextWork(agentId) : undefined;
      // A job asked to run now goes before one whose time has come.
      const jobNow = lane === "own" && !work ? nextRunNow(agentId) : undefined;
      const job = jobNow ?? (lane === "own" && !work ? store.dueJob(agentId, now()) : undefined);
      // What the agent runs by itself, as its messages name it.
      const jobId = (work ?? job)?.id;
      if (jobId) own.set(agentId, jobId);
      // The files the agent has asked to send, which its next message takes.
      const files: Upload[] = [];
      // What the agent has offered to do, which goes to the person once its reply has, in the place of the suggestions they haven't answered.
      const offers: Question[] = [];
      const suggestAll = () => {
        if (offers.length === 0) return;
        store.closeSuggestions(agent.id);
        for (const question of offers.splice(0)) suggest(store, agent.id, question, jobId);
      };
      const others = () => store.agentsFor(person.id).filter((each) => each.id !== agent.id);
      // Runs a turn on what the agent answers with, or on `on` when its session is still on something else.
      const turn = async (text: string, rest: Pick<Turn, "followUps" | "seen" | "replied" | "sendUpdate"> & { id?: string; kind: TurnKind }, on: Selection = agent) => {
        const { driver, account, apiKey } = signedIn(on.provider);
        if (!account) throw new Error(`${person.name} hasn't set up ${PROVIDERS[on.provider].name} on this computer.`);
        const ask = (question: Question, withdrawn: AbortSignal) =>
          new Promise<Answer>((resolve) => {
            // An ask raised while working on what another agent asked shows in that agent's chat too, where the person may be. One raised by work the person started answers its suggestion.
            const message = store.addMessage(agent.id, "agent", asking(question), "done", { ask: "waiting", question, jobId, replyTo: work?.id, peerId: lane === "chat" ? store.askedOf(agent.id)[0]?.agent_id : undefined });
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
              lane,
              connection: question.connection,
              answer: (allow) => settle(allow ? "allowed" : "refused", `${person.name} said no to this. Don't do it, or the same thing another way. Finish the rest and say in your reply what you left out.`),
              close: (words) => settle("unanswered", words),
            });
          });
        // What the agent runs by itself is a session of its own, which nothing comes back to. Any other turn carries on the chat's session.
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
          // The chat marks where its own session was compacted, which is why the reply that follows took longer.
          compacted: () => void (rest.kind === "reply" && store.addMessage(agent.id, "sidebots", COMPACTED, "done")),
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
            const schedule = toSchedule(request);
            const saved = typeof schedule === "string" ? schedule : saveJob(agent.id, { title: request.title, what: request.what, schedule, enabled: request.enabled }, request.id);
            if (typeof saved === "string") return `${saved} It is now ${clock(now())}.`;
            return `Saved job ${saved.id}, "${saved.title}": ${jobWords(saved)}. It is now ${clock(now())}.`;
          },
          listJobs: () => {
            const jobs = store.jobs(agent.id).map((each) => `${each.id}, "${each.title}": ${jobWords(each)}. ${each.what}`);
            return `${jobs.join("\n\n") || "You have no jobs."}\n\nIt is now ${clock(now())}.`;
          },
          cancelJob: (id) => (store.removeJob(agent.id, id) ? "Removed." : "You have no job with that id."),
          runJobNow: (id) => runJobNow(agent.id, id) ?? "It runs now, in a session of its own, and what it replies goes to the person.",
          suggest: ({ title, why, what }) => {
            if (!title.trim() || !what.trim()) return "A suggestion needs a title and what you will do.";
            if (offers.length >= SUGGESTIONS) return `${SUGGESTIONS} is the most to suggest at once. Keep the ones that matter most.`;
            offers.push(suggestion(title.trim(), what.trim(), why.trim()));
            return `Offered. It goes to ${person.name} as a card under your reply. Don't do it now: it runs in a session of its own once they start it.`;
          },
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
            // Each file is read only when it fits in the room left, so a call that can't fit stops at the file that takes it too far, with that file unread.
            const added: Upload[] = [];
            let room = MESSAGE_BYTES - files.reduce((total, file) => total + file.bytes.byteLength, 0);
            for (const path of paths) {
              const file = store.fileToSend(agent.id, path, room);
              if (!file) return `There is no file at ${path}. Nothing was added, so give the paths again.`;
              if (file === "too big") return "A message carries up to 95 MB of files. Nothing was added, so send fewer or smaller ones.";
              room -= file.bytes.byteLength;
              added.push(file);
            }
            files.push(...added);
            return "Added. They go with the next message you send.";
          },
        })
          // An ask the turn leaves behind, as when it fails or is stopped, waits for nobody.
          .finally(() => stopWaiting(agent.id, lane, "The turn ended."));
        store.addUsage(agent.id, rest.kind, result, sessionId !== null);
        return result;
      };
      // Why a turn failed, as the chat says it. An error can quote what the turn ran with, and the person's API key never goes with it.
      const reason = (error: unknown) => {
        const words = driver.failure(error instanceof Error ? error.message : String(error));
        return apiKey ? words.replaceAll(apiKey, "your API key") : words;
      };

      // A fresh start is no turn of the agent's own, so what the person picked waits for the turn after it. What the agent runs by itself is no turn of its chat's session, and runs on what the agent answers with now.
      const startsTurn = message !== undefined && message.sender !== "sidebots";
      if (startsTurn && !sameSelection(ranOn, agent)) {
        const handsOver = ranOn.provider !== agent.provider && agent.session_id !== null;
        const switched = { from: ranOn, to: selectionOf(agent) };
        const notice = store.addMessage(agent.id, "sidebots", switchedWords(switched), handsOver ? "running" : "done", { switched });
        if (handsOver) {
          // The session goes even when the agent couldn't save first, as for a fresh start.
          await turn(remember(person), { kind: "memory", seen: () => undefined, replied: () => undefined }, ranOn).catch(() => undefined);
          store.setSession(agent.id, null);
          store.setStatus(notice.id, "done");
        }
        store.setRanOn(agent.id, agent);
        // Stopped while it handed over, the turn it was for doesn't run.
        if (stop.signal.aborted) stopped();
        continue;
      }

      if (startsTurn && agent.ran_on === null) store.setRanOn(agent.id, agent);

      if (work || job) {
        if (work) store.setStatus(work.id, "running");
        if (job) store.jobStarted(job.id, now());
        // Why the job's run failed, when it did.
        let failed: string | null = null;
        try {
          const replies: string[] = [];
          await turn(work ? workPrompt(work, person) : jobPrompt(job!, person, jobNow !== undefined), { kind: "job", seen: () => undefined, replied: (reply) => replies.push(reply) });
          const reply = replies.at(-1) ?? "";
          // A run stopped as its reply landed sends nothing, and work the person stopped is over already.
          if (!stop.signal.aborted) {
            if (work ? reply.trim() : !silent(reply)) store.addMessage(agent.id, "agent", reply, "done", { jobId, replyTo: work?.id, files });
            suggestAll();
            if (work) store.setStatus(work.id, "done");
          }
          if (stop.signal.aborted) failed = "Stopped.";
        } catch (error) {
          if (removed.has(agentId)) return;
          failed = stop.signal.aborted ? "Stopped." : reason(error);
          // A job that keeps failing says so once, not on every run.
          const latest = store.agentWithLatest(agent.id)?.latest;
          if (!stop.signal.aborted && (work || latest?.sender !== "sidebots" || latest.status !== "failed")) {
            store.addMessage(agent.id, "sidebots", work ? `Sidebots couldn't finish "${work.question!.what}". ${reason(error)}` : `Sidebots couldn't run a job. ${reason(error)}`, "failed");
            if (work) store.setStatus(work.id, "failed");
          }
        }
        // The next run counts from the end of this one, and a job that ran its one time has none. A run beside the schedule leaves the next run as it was, as does a change to the job made while it ran, which worked out its next run itself.
        const current = job && store.job(agent.id, job.id);
        if (current) store.jobEnded(current.id, failed, jobNow || current.next_at !== job!.next_at ? current.next_at : nextRun(current.schedule, now()));
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
          if (arrived.length) stopWaiting(agent.id, lane, `${person.name} sent a message instead of answering. Leave this undone and read their message.`);
          return arrived.map((each) => {
            sent.add(each.id);
            return { id: each.id, text: promptFor(each, person, { recent: [], quoted: quotedBy(each), fromRuns: [] }) };
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
      const recent = agent.session_id ? [] : store.messagesBefore(agent.id, message.id, RECENT_MESSAGES);
      // What the agent's own runs sent that this session hasn't been told of, one more than the turn is shown, which is how it knows there was more. A new session reads the chat so far in its place, and another agent's message comes without it.
      const fromRuns = from || recent.length ? [] : store.sentByRuns(agent.id, RECENT_MESSAGES + 1);
      // The newest message the turn's prompt shows of the chat, which the session has been told of everything up to.
      const shown = (recent.length ? recent : fromRuns).at(-1);
      // A large session that has sat too long is compacted first, in a turn of its own that answers nobody. The reply follows even when that turn fails.
      const last = agent.session_id ? store.sessionUsed(agent.id, agent.session_id) : undefined;
      const compact = last?.held != null ? driver.compactFirst?.({ held: last.held, idleMs: now() - last.at, onKey: apiKey !== undefined }) : null;
      if (compact) {
        await turn(compact, { kind: "reply", seen: () => undefined, replied: () => undefined }).catch(() => undefined);
        // Stopped while it compacted, the turn it was for doesn't run, and what another agent sent gets none.
        if (stop.signal.aborted) {
          stopped(sent);
          if (from) store.setStatus(message.id, "failed");
          continue;
        }
      }
      try {
        const result = await turn(
          promptFor(message, person, { recent, quoted: quotedBy(message), fromRuns }, from),
          {
            kind: "reply",
            id: message.id,
            // Another agent's message is a turn of its own, as a job's run is: the person isn't waiting on it, and a message of theirs gets its own turn.
            ...(from ? {} : { followUps, sendUpdate }),
            seen: (ids) => {
              store.markSeen(ids);
              // The session has now read what its own runs had sent, as far as its prompt showed the chat.
              if (shown && ids.includes(message.id)) store.toldOfRuns(agent.id, shown.id);
            },
            replied: (reply, ids) => {
              // What another agent asked and has called off gets no answer, though the turn was too far along to end without one.
              if (store.message(agent.id, message.id)?.status === "failed") return;
              store.markSeen(ids);
              deliver(reply);
              suggestAll();
              // What another agent asked is done with once its answer goes, which `deliver` sees to.
              for (const id of ids) if (!asksMe(store.message(agent.id, id))) store.setStatus(id, "done");
            },
          },
        );
        store.setSession(agent.id, result.sessionId);
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

  /** Starts one of an agent's lanes if it isn't running. */
  function run(agentId: string, lane: Lane): Promise<void> {
    const key = laneKey(lane, agentId);
    const running = busy.get(key);
    if (running) {
      kicked.add(key);
      return running;
    }
    const done = drain(agentId, lane).finally(() => {
      busy.delete(key);
      stops.delete(key);
      if (lane === "own") own.delete(agentId);
      if (kicked.delete(key)) return run(agentId, lane);
    });
    busy.set(key, done);
    return done;
  }

  /** Starts each of the agent's lanes that isn't running. If its chat is on a turn the person can talk to, a new message of theirs goes into that turn. */
  function kick(agentId: string): Promise<void> {
    if (busy.has(laneKey("chat", agentId))) arrivals.get(agentId)?.();
    return Promise.all(LANES.map((lane) => run(agentId, lane))).then(() => undefined);
  }

  return {
    kick,
    saveJob,
    runJobNow,

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
     * Stops the turn the agent's chat is on: its work on the person's
     * messages, or a fresh start. The messages of theirs that the agent
     * hasn't read, sent into the turn or waiting for it to end, are left to
     * send again. The chat says "Stopped" once the turn has ended. The agent
     * keeps its session, so its next turn carries on from there. An agent
     * that waits to hear from another has no turn of its own to stop, and
     * stopping it stops that other agent's work for it.
     */
    stop(agentId: string, stopping = new Set<string>()): void {
      if (stopping.has(agentId)) return;
      stopping.add(agentId);
      const stop = stops.get(laneKey("chat", agentId));
      // The stop carries the messages that were unread as it was asked for, so one sent after it gets its turn.
      if (stop && !stop.signal.aborted) stop.abort(store.waitingFromPerson(agentId).map((unread) => unread.id));
      // What the agent asked other agents is called off with it. An agent at work on it is stopped, and one that hasn't read it never does.
      for (const asked of store.asked(agentId)) {
        this.stop(asked.peer_id!, stopping);
        if (asked.status === "queued" || !busy.has(laneKey("chat", asked.peer_id!))) store.setStatus(asked.id, "failed");
      }
    },

    /**
     * Gives an ask the person's answer, and the agent goes on with it. False
     * when the agent has no such ask waiting, and for a yes to an ask for a
     * connection, which only making the connection says. A yes to a
     * suggestion starts its work, beside the chat. A no to one they started
     * calls the work off: it leaves the line when it waits for its run, and
     * its run stops when it is on it.
     */
    answer(agentId: string, messageId: string, allow: boolean): boolean {
      const ask = asks.get(messageId);
      if (ask) {
        if (ask.agentId !== agentId || (allow && ask.connection)) return false;
        ask.answer(allow);
        return true;
      }
      const suggestion = store.message(agentId, messageId);
      if (!suggestion || suggestion.agent_id !== agentId || !isSuggestion(suggestion)) return false;
      // A suggestion that connects an app is started by making the connection.
      if (allow && suggestion.question?.connection) return false;
      if (suggestion.ask === "waiting") {
        store.answerAsk(messageId, allow ? "allowed" : "refused");
        if (allow) void kick(agentId);
        return true;
      }
      if (allow || suggestion.ask !== "allowed" || (suggestion.status !== "queued" && suggestion.status !== "running")) return false;
      // The work is over from here, whether it waited for its run or its run now ends.
      store.setStatus(messageId, "failed");
      this.stopRun(agentId, messageId);
      return true;
    },

    /** Stops what the agent runs by itself, when it is on the job or the work with this id. False when it isn't. */
    stopRun(agentId: string, id: string): boolean {
      if (own.get(agentId) !== id) return false;
      stops.get(laneKey("own", agentId))?.abort(new Error("Stopped."));
      return true;
    },

    /** Has the agents that wait for the person to make a connection go on, once they have made it, and starts the suggestions that waited for it. */
    connected(personId: string, connection: Connection): void {
      for (const ask of [...asks.values()]) if (ask.connection === connection && store.agent(ask.agentId)?.person_id === personId) ask.answer(true);
      for (const agent of store.agentsFor(personId)) {
        for (const suggestion of store.waitingSuggestions(agent.id)) if (suggestion.question?.connection === connection) store.answerAsk(suggestion.id, "allowed");
        void kick(agent.id);
      }
    },

    /** Stops whatever the agent is running, waits for it to end, and removes the sessions each provider it ran on keeps for it, as the agent is deleted. */
    async remove(agent: Agent): Promise<void> {
      removed.add(agent.id);
      for (const lane of LANES) stops.get(laneKey(lane, agent.id))?.abort();
      await Promise.all(LANES.map((lane) => busy.get(laneKey(lane, agent.id))?.catch(() => undefined)));
      try {
        for (const { provider, config_dir } of store.accounts(agent.person_id)) await drivers[provider].forget(store.agentHome(agent.id), config_dir);
      } finally {
        removed.delete(agent.id);
      }
    },

    /**
     * Asks each provider the person's agents sign in to with the login in
     * their config folder where the limits of that login's plan stand, and
     * keeps what it says, which the store tells the person's devices. A
     * provider asked in the last minute isn't asked again. One that fails or
     * doesn't answer in time leaves what it last said.
     */
    askLimits(personId: string): void {
      for (const { provider, config_dir } of store.accounts(personId)) {
        if (store.apiKey(personId, provider) !== undefined) continue;
        const key = `${personId} ${provider}`;
        const last = limitsAsked.get(key);
        if (last !== undefined && now() - last < LIMITS_FRESH_MS) continue;
        limitsAsked.set(key, now());
        const giveUp = AbortSignal.timeout(LIMITS_WAIT_MS);
        const late = new Promise<never>((_, reject) => giveUp.addEventListener("abort", () => reject(giveUp.reason)));
        void Promise.race([drivers[provider].limits(config_dir, giveUp), late])
          .then((limits) => store.setLimits(personId, provider, limits))
          .catch(() => undefined);
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
