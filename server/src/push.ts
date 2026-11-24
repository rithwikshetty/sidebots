// Push decides when to notify the person's phones and what each notification
// says, and encrypts it for each phone, so the relay and Apple pass along
// bytes they can't read. It tells a phone when what it was notified of has
// been read on another device, and ends the Live Activity a phone shows for a
// working agent, with a push that names the avatar's state and nothing else.

import { createCipheriv, randomBytes } from "node:crypto";
import { NOTIFY_AFTER_MS, avatarStateOf, notifies, oneLine } from "./contract.ts";
import type { Agent, AvatarState, PushToken } from "./contract.ts";
import type { Store } from "./store.ts";

/** A notification: the agent's name over what it said, and the number the app's icon shows, which is everything the person hasn't read. */
export type Notice = { title: string; body: string; badge: number; agentId: string; messageId: string };
/** A notice encrypted for one phone, in base64, and the message it is about, which keeps a notification from showing twice. */
export type Sealed = { sealed: string; messageId: string };
/** The end of a Live Activity: the state its agent's work left the avatar in, which the activity shows before it goes. */
export type Ended = { ended: Exclude<AvatarState, "working"> };
/** The person has read, on another device, what a phone shows notifications for. It says no more than that: the phone asks the computer what is left unread. */
export type Read = { read: true };
/** `gone` means Apple will never deliver to this token again. */
export type SendPush = (to: PushToken, push: Sealed | Ended | Read) => Promise<"sent" | "gone" | "failed">;

// A notification shows a few lines, and Apple takes at most 4096 bytes, encrypted text and all.
const BODY_CHARS = 600;

/**
 * Encrypts a notice with a phone's notification key, in base64: AES-256-GCM,
 * as the 12-byte nonce, the encrypted JSON and the 16-byte tag, one after the
 * other. That is the layout Apple's CryptoKit reads as a sealed box.
 */
export function seal(notice: Notice, notificationKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(notificationKey, "base64"), nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(notice)), cipher.final()]);
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString("base64");
}

/**
 * Tells the person's phones when an agent replies or asks, or a turn fails,
 * unless the agent is muted. It waits `holdMs` first and tells them only of
 * what is still unread, so a message the person reads as it comes, in the
 * chat they are looking at on another device, reaches no phone. Once nothing
 * of an agent's is unread, or the agent is deleted, the phones that were told
 * of it are told again, and take its notifications away. An update while it
 * works tells nobody, and neither does an ask's answer or what one agent says
 * to another. When an agent has no work left, the Live Activities phones show
 * for it end. Returns a function that stops it.
 */
export function startPush(store: Store, send: SendPush, holdMs = NOTIFY_AFTER_MS): () => void {
  const held = new Set<NodeJS.Timeout>();
  // The agents whose notifications phones show.
  const told = new Set<string>();

  const notify = (agentId: string, messageId: string): void => {
    const agent = store.agent(agentId);
    const message = agent && store.message(agent.id, messageId);
    if (!agent || agent.muted || !message || !notifies(message) || message.created_at <= agent.read_at) return;
    told.add(agent.id);
    // A muted agent's unread replies show on its own row, and never on the app's icon.
    const badge = store.agentsFor(agent.person_id).reduce((total, each) => total + (each.muted ? 0 : each.unread), 0);
    const notice: Notice = { title: agent.name, body: oneLine(message).slice(0, BODY_CHARS), badge, agentId: agent.id, messageId: message.id };
    for (const { notificationKey, ...to } of store.pushTargetsFor(agent.person_id)) {
      void send(to, { sealed: seal(notice, notificationKey), messageId: message.id }).then((result) => {
        if (result === "gone") store.clearPushToken(to.token);
      });
    }
  };

  /** Has the phones that show an agent's notifications take them away. */
  const tellRead = (agent: Agent): void => {
    if (!told.delete(agent.id)) return;
    for (const { notificationKey: _, ...to } of store.pushTargetsFor(agent.person_id)) void send(to, { read: true });
  };

  const stop = store.onChange((change) => {
    if ("agent" in change && change.deleted) return tellRead(change.agent);
    const shown = "message" in change ? change.agents.find((each) => each.id === change.message.agent_id) : change.agent;
    if (shown?.unread === 0) tellRead(shown);
    if (!("message" in change)) return;
    const { message } = change;
    const ended = shown && avatarStateOf(shown);
    if (ended && ended !== "working") for (const to of store.endActivities(message.agent_id)) void send(to, { ended });
    if (!notifies(message)) return;
    const timer = setTimeout(() => {
      held.delete(timer);
      notify(message.agent_id, message.id);
    }, holdMs);
    held.add(timer);
  });

  return () => {
    stop();
    held.forEach(clearTimeout);
  };
}
