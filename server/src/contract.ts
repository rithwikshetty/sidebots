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
 * the models it answers with and how hard it can think before it answers,
 * each by the id its driver knows it by and the name the app shows, and what
 * a new agent starts on. A more capable model and more effort are slower and use
 * more of the person's plan or API credit. `instructions` is the file in the
 * agent's folder that the program reads the agent's instructions from.
 */
export const PROVIDERS = {
  claude: {
    name: "Claude Code",
    models: { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" },
    efforts: { low: "Low", medium: "Medium", high: "High" },
    model: "opus",
    effort: "medium",
    instructions: "CLAUDE.md",
  },
  codex: {
    name: "Codex",
    models: { astra: "Astra", sol: "Sol", terra: "Terra", luna: "Luna" },
    efforts: { low: "Low", medium: "Medium", high: "High" },
    model: "sol",
    effort: "medium",
    instructions: "AGENTS.md",
  },
} as const;
export type Provider = keyof typeof PROVIDERS;
/** A model of any provider. Each name always means the newest model of its kind. */
export type Model = { [P in Provider]: keyof (typeof PROVIDERS)[P]["models"] }[Provider];
export type Effort = { [P in Provider]: keyof (typeof PROVIDERS)[P]["efforts"] }[Provider];
/** What a provider offers, read for an agent whichever provider it runs on: its name, and the names the app shows for its models and efforts. */
export type Offered = { name: string; models: Partial<Record<Model, string>>; efforts: Partial<Record<Effort, string>> };

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
    allows: "Your agents can read your calendar, and add, change and remove its events.",
    logo: { color: "#4285F4", path: "M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z" },
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
 * had its ask closed comes with its agent as the home screen shows it. A new
 * agent comes the same way, with no message. A deleted agent comes as its id.
 */
export type StreamEvent = { message: Message | null; agent: AgentWithLatest } | { deleted: string };
/**
 * What a phone gets when it pairs: the key it sends with every request from
 * then on, the key its notifications are encrypted with, in base64, and the
 * name of the machine it paired with.
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
