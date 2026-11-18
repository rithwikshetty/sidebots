// The shapes the server sends over HTTP, and how they read in words. The
// mobile app imports this file, so it imports nothing.

/**
 * The version of this contract. It goes up when a change means an older app
 * or server can't work with a newer one. The server sends it on every
 * response in the `Sidebots-Contract` header, and the app compares it with
 * its own. The app sends its own in the same header, and the server refuses
 * to pair an app on another version.
 */
export const CONTRACT_VERSION = 2;
export const CONTRACT_HEADER = "Sidebots-Contract";

export type Sender = "person" | "agent" | "sidebots";
export type Status = "queued" | "running" | "done" | "failed";

export type Message = {
  id: string;
  agent_id: string;
  sender: Sender;
  body: string;
  /** Files sent with the message, as paths inside the agent's home folder. */
  attachments: string[];
  /**
   * For a message from a person: `queued` until the agent reads it, `running`
   * once it has, then `done` when it has answered, or `failed`. For a fresh
   * start, the state of replacing the session. A failure notice is `failed`.
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
 * the models it answers with and how hard it can think before it answers, by
 * the program's own names for them and the names the app shows, and what a
 * new agent starts on. A more capable model and more effort are slower and use
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
} as const;
export type Provider = keyof typeof PROVIDERS;
/** The provider a new agent runs on. */
export const DEFAULT_PROVIDER: Provider = "claude";
/** A model of any provider. Each name always means the newest model of its kind. */
export type Model = { [P in Provider]: keyof (typeof PROVIDERS)[P]["models"] }[Provider];
export type Effort = { [P in Provider]: keyof (typeof PROVIDERS)[P]["efforts"] }[Provider];

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
 * queued or running. `unread` counts the replies and failure notices the
 * person hasn't read.
 */
export type AgentWithLatest = Agent & { latest: Message | null; working: boolean; unread: number };
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

/**
 * What the event stream sends. A message that was added or changed status
 * comes with its agent as the home screen shows it. A new agent comes the same
 * way, with no message. A deleted agent comes as its id.
 */
export type StreamEvent = { message: Message | null; agent: AgentWithLatest } | { deleted: string };
/**
 * What a phone gets when it pairs: the key it sends with every request from
 * then on, the key its notifications are encrypted with, in base64, and the
 * name of the machine it paired with.
 */
export type Paired = { key: string; notificationKey: string; machine: string };
/**
 * Where Apple delivers a phone's notifications: its Apple device token, which
 * of Apple's push services issued it, and the bundle identifier of the app it
 * is for, which a development build has apart from the published app. A phone
 * that doesn't name its app is the published app.
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
 * frames the row has and how long the app shows each one. The avatar's 16 by 16
 * drawing sits in `art` inside every cell, with one drawing pixel of room
 * above it for a hop.
 */
export const AVATAR_STATES = {
  resting: { frames: 6, frameMs: 450 },
  working: { frames: 6, frameMs: 150 },
  replied: { frames: 6, frameMs: 300 },
  failed: { frames: 8, frameMs: 300 },
} as const;
export type AvatarState = keyof typeof AVATAR_STATES;
export const AVATAR_SHEET = { columns: 8, cellWidth: 192, cellHeight: 208, art: { left: 24, top: 48, size: 144, pixel: 9 } } as const;
