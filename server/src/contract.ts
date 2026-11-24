// The shapes the server sends over HTTP, and how they read in words. The
// mobile app imports this file, so it imports nothing.

/**
 * The version of this contract. It goes up when a change means an older app
 * or server can't work with a newer one. The server sends it on every
 * response in the `Sidebots-Contract` header, and the app compares it with
 * its own. The app sends its own in the same header, and the server refuses
 * to pair an app on another version.
 */
export const CONTRACT_VERSION = 5;
export const CONTRACT_HEADER = "Sidebots-Contract";

export type Sender = "person" | "agent" | "sidebots";
export type Status = "queued" | "running" | "done" | "failed";
/**
 * Where an ask stands. An agent asks before it does something its provider's
 * safety check won't decide by itself. The ask is `waiting` until the person
 * answers, then `allowed` or `refused`. It is `unanswered` when the agent
 * stopped waiting first: the person took too long or sent a message instead,
 * or the turn ended. An ask for a connection is `allowed` once the person has
 * signed in to it.
 */
export type Ask = "waiting" | "allowed" | "refused" | "unanswered";
/**
 * What an agent asks to do, in the parts a person reads to decide. `kind` is
 * what sort of thing it is, and `title` says that in words, as "Run a
 * command". `what` is this one thing in plain words: for a command, the
 * agent's own account of what it does. `facts` are the short details that
 * matter, each a label and its value, as where a file is or who an email
 * goes to. `detail` is the thing itself, such as the command or the change,
 * which Allow lets happen in full. `why` is the provider's reason for not
 * deciding this one by itself. An agent that needs one of the person's apps
 * asks for it the same way: the `kind` is `connection`, `connection` is the
 * app, and the person says yes by signing in to it.
 */
export type Question = {
  kind: "command" | "page" | "file" | "tool" | "connection";
  title: string;
  what: string;
  facts: [label: string, value: string][];
  detail: string;
  why?: string;
  connection?: Connection;
};

/** Text as a markdown code block. The fence is longer than any run of backticks inside it, so nothing in the text can close it. */
export function fenced(text: string): string {
  const fence = "`".repeat((text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length + 1), 3));
  return `${fence}\n${text}\n${fence}`;
}

export type Message = {
  id: string;
  agent_id: string;
  sender: Sender;
  body: string;
  /** Files sent with the message, as paths inside the agent's home folder. */
  attachments: string[];
  /**
   * For a message from a person: `queued` until the agent reads it, `running`
   * once it has, then `done` when it has answered or the person stopped it.
   * `failed` when its turn failed, or was stopped before the agent read it.
   * For a fresh start, the state of replacing the session. A failure notice
   * is `failed`.
   */
  status: Status;
  /** When the agent read a message from the person, or null before it has. */
  seen_at: number | null;
  /** The earlier message this one answers, when the person replied to one. */
  reply_to: string | null;
  /** The job whose run sent it, for a message the agent sent by itself. */
  job_id: string | null;
  /** An update the agent sent while still working. It notifies nobody and doesn't count as unread; the reply that follows does. */
  interim: boolean;
  /** For a message in which the agent asks before it does something, where the ask stands. Null for every other message. */
  ask: Ask | null;
  /** What an ask asks, which the phone draws as its card. The message's `body` says the same in words. Null for every other message. */
  question: Question | null;
  /**
   * The other agent, for a message that is between two of the person's
   * agents and so shows in both their chats. On a message one agent sent
   * another, it is the agent the message is for. The message waits in that
   * agent's queue, its `status` says whether that agent has read and answered
   * it, and an answer names what it answers in `reply_to`. On an ask, it is
   * the agent whose message the asking agent was working on. Null for a
   * message between an agent and the person.
   */
  peer_id: string | null;
  created_at: number;
};

/**
 * The most one message carries in files, in bytes, whoever sends it. It is
 * under the 100 MB Cloudflare takes in one request, which is how the
 * person's files reach the server.
 */
export const MESSAGE_BYTES = 95 * 1024 * 1024;

/**
 * The programs an agent can run on, by id. Each has the name the apps show,
 * the logo of whoever makes its models, the models it answers with and how
 * hard it can think before it answers, each by the id its driver knows it by
 * and the name the app shows, and what a new agent starts on. A more capable
 * model and more effort are slower and use more of the person's plan or API
 * credit. The efforts are every level the provider has, lowest first, and a
 * model that hasn't the agent's runs at the highest it has. `instructions`
 * is the file in the agent's folder that the program reads the agent's
 * instructions from.
 */
export const PROVIDERS = {
  claude: {
    name: "Claude Code",
    logo: { color: "#D97757", path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" },
    models: { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" },
    efforts: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" },
    model: "opus",
    effort: "medium",
    instructions: "CLAUDE.md",
  },
  codex: {
    name: "Codex",
    logo: { color: null, path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" },
    models: { astra: "Astra", sol: "Sol", terra: "Terra", luna: "Luna" },
    efforts: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" },
    model: "sol",
    effort: "medium",
    instructions: "AGENTS.md",
  },
} as const;
export type Provider = keyof typeof PROVIDERS;
/** A model of any provider. Each name always means the newest model of its kind. */
export type Model = { [P in Provider]: keyof (typeof PROVIDERS)[P]["models"] }[Provider];
export type Effort = { [P in Provider]: keyof (typeof PROVIDERS)[P]["efforts"] }[Provider];
/** What a provider offers, read for an agent whichever provider it runs on: its name, its logo, and the names the app shows for its models and efforts. */
export type Offered = { name: string; logo: Logo; models: Partial<Record<Model, string>>; efforts: Partial<Record<Effort, string>> };

/**
 * A brand's mark: one shape in a box 24 by 24, as Simple Icons draws a
 * brand's, and the brand's colour. A mark with no colour of its own, as a
 * black one, takes the colour of the text around it, so it shows in light
 * and dark.
 */
export type Logo = { path: string; color: string | null };

/**
 * The apps outside Sidebots that a person's agents can use as them, by id.
 * Each has the name the apps show, its logo, and what connecting it lets the
 * agents do. A person connects one once, by signing in to it, and all their
 * agents have it, whichever provider each runs on.
 */
export const CONNECTIONS = {
  gmail: {
    name: "Gmail",
    allows: "Your agents can search, read and send your mail.",
    logo: { color: "#EA4335", path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" },
  },
  calendar: {
    name: "Google Calendar",
    allows: "Your agents can read your calendars, and add, change and remove their events.",
    logo: { color: "#4285F4", path: "M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z" },
  },
  notion: {
    name: "Notion",
    allows: "Your agents can search and read your Notion, and add to it and change it.",
    logo: { color: null, path: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" },
  },
} as const;
export type Connection = keyof typeof CONNECTIONS;
/**
 * A connection as the app lists it, with its name, its logo and what it
 * allows, so an app lists one it has never heard of. `account` is the
 * account the person signed in to it with, or null while it isn't connected.
 */
export type Connected = { connection: Connection; name: string; allows: string; logo: Logo; account: string | null };
/**
 * Where a phone signs in to a connection: the page it opens, and the address
 * that page goes to once the person has signed in. The phone hands the
 * address it came back with to the server, which makes the connection.
 */
export type SignIn = { url: string; redirect: string };

/**
 * `read_at` is the time up to which the person has read the chat. A `muted`
 * agent sends no notifications. A `hidden` one is kept off the home screen
 * until it next has something to say. `color` fills the person's messages in
 * the agent's chat, as `#RRGGBB`; null takes the colour of its avatar.
 */
export type Agent = {
  id: string;
  person_id: string;
  name: string;
  avatar_id: string;
  provider: Provider;
  model: Model;
  effort: Effort;
  muted: boolean;
  hidden: boolean;
  color: string | null;
  session_id: string | null;
  read_at: number;
  created_at: number;
};
/**
 * An agent as the home screen shows it. `working` is true while it has a turn
 * queued or running. `unread` counts the replies, the asks still waiting and
 * the failure notices the person hasn't read. `latest` and `unread` leave out what agents say to
 * each other. `waiting_on` is the agent it asked something and hasn't heard
 * back from, when there is one.
 */
export type AgentWithLatest = Agent & { latest: Message | null; working: boolean; unread: number; waiting_on: string | null };

/** Whether a message is one agent's to another, which the person can read and nobody is notified of. */
export const betweenAgents = (message: Pick<Message, "peer_id" | "ask">): boolean => message.peer_id !== null && message.ask === null;

/**
 * Whether the person is told of a message as it comes: an agent's reply or
 * an ask still waiting, or a notice that a turn failed. An update while the
 * agent works, an ask's answer and what one agent says to another tell nobody.
 */
export function notifies(message: Pick<Message, "sender" | "interim" | "ask" | "peer_id" | "status">): boolean {
  const answered = message.ask !== null && message.ask !== "waiting";
  return (message.sender === "agent" && !message.interim && !answered && !betweenAgents(message)) || (message.sender === "sidebots" && message.status === "failed");
}

/**
 * The exchanges in a chat's messages, each oldest first: what two of the
 * person's agents asked and answered each other, one thing after another.
 * An exchange ends when the person sends a message or the chat's agent gives
 * them a reply, its own or a job's, so what either agent asks next begins
 * another. An answer belongs with what it answers, whenever it comes.
 */
export function exchanges(messages: Message[]): Message[][] {
  const all: Message[][] = [];
  // The exchange still going between each two agents, and the one each thing asked is in.
  const going = new Map<string, Message[]>();
  const holding = new Map<string, Message[]>();
  for (const message of messages) {
    if (!betweenAgents(message)) {
      // An update from an agent that waits, an ask for the person's OK and a notice come in the middle of an exchange.
      if (message.sender !== "sidebots" && !message.interim && message.ask === null) going.clear();
      continue;
    }
    if (message.reply_to) {
      holding.get(message.reply_to)?.push(message);
      continue;
    }
    const pair = [message.agent_id, message.peer_id].sort().join(" ");
    let exchange = going.get(pair);
    if (!exchange) {
      exchange = [];
      going.set(pair, exchange);
      all.push(exchange);
    }
    exchange.push(message);
    holding.set(message.id, exchange);
  }
  return all;
}

/** The state an agent's avatar acts out: working while it has a turn, then failed when its last turn failed, replied while a reply waits to be read, and resting otherwise. */
export function avatarStateOf(agent: AgentWithLatest): AvatarState {
  if (agent.working) return "working";
  if (agent.latest?.sender === "sidebots" && agent.latest.status === "failed") return "failed";
  if (agent.unread > 0) return "replied";
  return "resting";
}
/** A message found by a search, with the name of the agent whose chat it is in. */
export type Found = { id: string; agent_id: string; agent: string; sender: Sender; body: string; created_at: number };
/**
 * When a job runs, by the server's clock: every so many minutes, at a time of
 * day on some weekdays (0 is Sunday) or on all of them, or once.
 */
export type Schedule = { type: "every"; minutes: number } | { type: "daily"; time: string; weekdays?: number[] } | { type: "once"; at: number };
/** Work an agent does by itself. `what` is the agent's own instructions for a run, and `next_at` is when it next runs. */
export type Job = { id: string; agent_id: string; what: string; schedule: Schedule; next_at: number; created_at: number };
/** Something an agent has learned, from its memory folder. */
export type Memory = { name: string; description: string; body: string };
/** What an agent's page shows about it: the instructions it follows, what it remembers and its jobs. */
export type About = { instructions: string; memories: Memory[]; jobs: Job[] };

/** What a turn was for: a reply to the person, a run of one of the agent's jobs, or the memory save before a fresh start. */
export type TurnKind = "reply" | "job" | "memory";
/**
 * The turns of one kind that an agent ran: how many, what they cost in US
 * dollars at its provider's prices, and the tokens they used. A turn's tokens
 * are all its model read and wrote, what it read again from its cache among
 * them.
 */
export type Used = { agent_id: string; kind: TurnKind; turns: number; cost: number; tokens: number };
/** One day of a person's turns: its date on the computer, as `2026-11-19`, with what the turns cost and the tokens they used. */
export type Day = { day: string; cost: number; tokens: number };
/**
 * One limit of a person's plan with a provider, as the provider last said it
 * stood: what the provider calls it, how much of it is used, as a fraction that
 * passes 1 when the plan lets use run over, when it resets, and when the
 * provider said so. The provider counts what the person uses outside Sidebots
 * too.
 */
export type Limit = { name: string; used: number | null; resets_at: number | null; at: number };
/** How many days of turns `Usage` counts, today among them. A day runs from midnight on the computer. */
export const USAGE_DAYS = 7;
/**
 * Where a person's plan or API credit goes: the turns their agents ran in the
 * last `USAGE_DAYS` days, added up by agent and by day, and how they sign in
 * to each provider. `days` has every one of the days, the oldest first, one
 * with no turns too. An account on an API key is billed for what its turns
 * cost, whether the person gave Sidebots the key or saved it as the login in
 * their config folder. One on a plan has the plan's limits once the provider
 * has said where they stand.
 */
export type Usage = { used: Used[]; days: Day[]; accounts: { provider: Provider; apiKey: boolean; limits: Limit[] }[] };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A schedule in words, such as "Every 5 minutes" or "Mon, Wed at 08:00". */
export function scheduleWords(schedule: Schedule): string {
  if (schedule.type === "every") return schedule.minutes === 1 ? "Every minute" : `Every ${schedule.minutes} minutes`;
  if (schedule.type === "daily") {
    const days = schedule.weekdays?.length ? [...schedule.weekdays].sort().map((day) => WEEKDAYS[day]).join(", ") : "Every day";
    return `${days} at ${schedule.time}`;
  }
  const at = new Date(schedule.at);
  const two = (value: number) => String(value).padStart(2, "0");
  return `Once, ${at.getDate()} ${at.toLocaleString("en", { month: "short" })} at ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * Markdown as one plain line, for a notification or the chat list: no marks
 * for emphasis, code or headings, and a link as its words.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(?<!\w)(\*\*|__|~~|\*|_|`)(?=\S)([\s\S]*?\S)\1(?!\w)/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** A message as one line, for a notification or a list: an ask's plain words, or its text without markdown's marks. */
export function oneLine(message: Pick<Message, "body" | "question">): string {
  return message.question ? `${message.question.title}: ${message.question.what}` : plainText(message.body);
}

/**
 * What the event stream sends. A message that was added, changed status or
 * had its ask closed comes with its agent as the home screen shows it. An
 * agent that was added or changed comes the same way, with no message. A
 * deleted agent comes as its id.
 */
export type StreamEvent = { message: Message | null; agent: AgentWithLatest } | { deleted: string };
/**
 * What a device gets when it pairs: the key it sends with every request from
 * then on, the key a phone's notifications are encrypted with, in base64, and
 * the name of the machine it paired with.
 */
export type Paired = { key: string; notificationKey: string; machine: string };
/**
 * Where Apple delivers to a phone: a token, which of Apple's push services
 * issued it, and the bundle identifier of the app it is for, which a
 * development build has apart from the published app. A phone that doesn't
 * name its app is the published app. The token is the phone's Apple device
 * token, for its notifications, or the token of one Live Activity it shows.
 */
export type PushToken = { token: string; environment: "sandbox" | "production"; app?: string };
/**
 * An avatar, as its avatar.json describes it. `color` is the colour it gives
 * the chats of agents that wear it, which takes white text at 4.5:1.
 */
export type Avatar = { id: string; displayName: string; description: string; spritesheetPath: string; color: string };

/** A colour as `#RRGGBB`. */
export const COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * `color`, made dark enough to take white text at 4.5:1, the contrast WCAG
 * asks of text, with its hue kept. A colour that already does comes back as
 * it is, in capitals.
 */
export function readableColor(color: string): string {
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const contrast = ([r, g, b]: number[]) => 1.05 / (0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) + 0.05);
  let [r, g, b] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16) / 255);
  // The colour's hue, saturation and lightness, so it can darken without changing hue.
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  const hue = max === min ? 0 : max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  while (contrast([r, g, b]) < 4.5) {
    lightness -= 0.01;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const x = chroma * (1 - Math.abs((hue % 2) - 1));
    const [r1, g1, b1] = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
    [r, g, b] = [r1, g1, b1].map((value) => Math.min(1, Math.max(0, value + lightness - chroma / 2)));
  }
  return `#${[r, g, b].map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * An avatar's spritesheet. One row per state, in this order, with how many
 * frames the row has, how long the app shows each one, and `still`, the frame
 * that stands for the state where nothing can move, as in a Live Activity.
 * The avatar's 16 by 16 drawing sits in `art` inside every cell, with one
 * drawing pixel of room above it for a hop.
 */
export const AVATAR_STATES = {
  resting: { frames: 6, frameMs: 450, still: 0 },
  working: { frames: 6, frameMs: 150, still: 2 },
  replied: { frames: 6, frameMs: 300, still: 0 },
  failed: { frames: 8, frameMs: 300, still: 0 },
} as const;
export type AvatarState = keyof typeof AVATAR_STATES;
export const AVATAR_SHEET = { columns: 8, cellWidth: 192, cellHeight: 208, art: { left: 24, top: 48, size: 144, pixel: 9 } } as const;

/** Where one frame of a state is in a spritesheet, in the sheet's pixels: the drawing, with the room above it for a hop. */
export function avatarFrame(state: AvatarState, frame: number): { x: number; y: number; width: number; height: number } {
  const { cellWidth, cellHeight, art } = AVATAR_SHEET;
  const row = Object.keys(AVATAR_STATES).indexOf(state);
  return { x: frame * cellWidth + art.left, y: row * cellHeight + art.top - art.pixel, width: art.size, height: art.size + art.pixel };
}
