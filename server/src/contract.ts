// The shapes the server sends over HTTP. The mobile app imports these types,
// so this file imports nothing.

export type Sender = "person" | "agent" | "simon";
export type Status = "queued" | "running" | "done" | "failed";

export type Message = {
  id: string;
  agent_id: string;
  sender: Sender;
  body: string;
  /** Files sent with the message, as paths inside the agent's home folder. */
  attachments: string[];
  /**
   * For a message from a person, the state of the turn it started. For a fresh
   * start, the state of replacing the session. A failure notice is `failed`.
   */
  status: Status;
  created_at: number;
};

/** `read_at` is the time up to which the person has read the chat. */
export type Agent = { id: string; person_id: string; name: string; pet_id: string; session_id: string | null; read_at: number; created_at: number };
/**
 * An agent as the home screen shows it. `working` is true while it has a turn
 * queued or running. `unread` counts the replies and failure notices the
 * person hasn't read.
 */
export type AgentWithLatest = Agent & { latest: Message | null; working: boolean; unread: number };
/** A message found by a search, with the name of the agent whose chat it is in. */
export type Found = { id: string; agent_id: string; agent: string; sender: Sender; body: string; created_at: number };
/** What the event stream sends when a message is added or changes status. */
export type MessageEvent = { message: Message; agent: AgentWithLatest };
/** A phone that takes notifications: its Apple device token, the app identifier Apple delivers to, and which of Apple's push services issued the token. */
export type Device = { token: string; topic: string; environment: "sandbox" | "production" };
export type Pet = { id: string; displayName: string; description: string; spritesheetPath: string };

/**
 * A pet's spritesheet. One row per state, in this order, with how many
 * frames the row has and how long the app shows each one. The pet's 16 by 16
 * drawing sits in `art` inside every cell, with one drawing pixel of room
 * above it for a hop.
 */
export const PET_STATES = {
  resting: { frames: 6, frameMs: 450 },
  working: { frames: 6, frameMs: 150 },
  replied: { frames: 6, frameMs: 300 },
  failed: { frames: 8, frameMs: 300 },
} as const;
export type PetState = keyof typeof PET_STATES;
export const PET_SHEET = { columns: 8, cellWidth: 192, cellHeight: 208, art: { left: 24, top: 48, size: 144, pixel: 9 } } as const;
