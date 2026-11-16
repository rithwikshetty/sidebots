// The shapes the server sends over HTTP, and how they read in words. The
// mobile app imports this file, so it imports nothing.

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
 * The models an agent can run on, by the names Claude Code gives them and the
 * names the app shows. Each name always means the newest model of its kind.
 */
export const MODELS = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" } as const;
export type Model = keyof typeof MODELS;
/** The model a new agent starts on. */
export const DEFAULT_MODEL: Model = "opus";
/**
 * How hard an agent thinks before it answers, by Claude Code's names for the
 * levels and the names the app shows. More effort is slower and uses more of
 * the person's Claude subscription or API credit.
 */
export const EFFORTS = { low: "Low", medium: "Medium", high: "High" } as const;
export type Effort = keyof typeof EFFORTS;
/** The effort a new agent starts on. */
export const DEFAULT_EFFORT: Effort = "medium";

/**
 * `read_at` is the time up to which the person has read the chat. A `muted`
 * agent sends no notifications. A `hidden` one is kept off the home screen
 * until it next has something to say.
 */
export type Agent = {
  id: string;
  person_id: string;
  name: string;
  avatar_id: string;
  model: Model;
  effort: Effort;
  muted: boolean;
  hidden: boolean;
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

/** What the event stream sends when a message is added or changes status. */
export type MessageEvent = { message: Message; agent: AgentWithLatest };
/**
 * What a phone gets when it pairs: the key it sends with every request from
 * then on, the key its notifications are encrypted with, in base64, and the
 * name of the machine it paired with.
 */
export type Paired = { key: string; notificationKey: string; machine: string };
/** Where Apple delivers a phone's notifications: its Apple device token, and which of Apple's push services issued it. */
export type PushToken = { token: string; environment: "sandbox" | "production" };
export type Avatar = { id: string; displayName: string; description: string; spritesheetPath: string };

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
