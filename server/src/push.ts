// Push decides when to notify the person's phones and what each notification
// says, and encrypts it for each phone, so the relay and Apple pass along
// bytes they can't read. It also ends the Live Activity a phone shows for a
// working agent, with a push that names the avatar's state and nothing else.

import { createCipheriv, randomBytes } from "node:crypto";
import { avatarStateOf, plainText } from "./contract.ts";
import type { AvatarState, PushToken } from "./contract.ts";
import type { Store } from "./store.ts";

/** A notification: the agent's name over what it said, and the number the app's icon shows, which is everything the person hasn't read. */
export type Notice = { title: string; body: string; badge: number; agentId: string; messageId: string };
/** A notice encrypted for one phone, in base64, and the message it is about, which keeps a notification from showing twice. */
export type Sealed = { sealed: string; messageId: string };
/** The end of a Live Activity: the state its agent's work left the avatar in, which the activity shows before it goes. */
export type Ended = { ended: Exclude<AvatarState, "working"> };
/** `gone` means Apple will never deliver to this token again. */
export type SendPush = (to: PushToken, push: Sealed | Ended) => Promise<"sent" | "gone" | "failed">;

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
 * Tells the person's phones when an agent replies or a turn fails, unless the
 * agent is muted. An update while it works tells nobody. When an agent has no
 * work left, the Live Activities phones show for it end. Returns a function
 * that stops it.
 */
export function startPush(store: Store, send: SendPush): () => void {
  return store.onChange((change) => {
    if (!("message" in change)) return;
    const { message } = change;
    const shown = store.agentWithLatest(message.agent_id);
    const ended = shown && avatarStateOf(shown);
    if (ended && ended !== "working") for (const to of store.endActivities(message.agent_id)) void send(to, { ended });
    const finished = (message.sender === "agent" && !message.interim) || (message.sender === "sidebots" && message.status === "failed");
    const agent = finished ? store.agent(message.agent_id) : undefined;
    if (!agent || agent.muted) return;
    // A muted agent's unread replies show on its own row, and never on the app's icon.
    const badge = store.agentsFor(agent.person_id).reduce((total, each) => total + (each.muted ? 0 : each.unread), 0);
    const notice: Notice = { title: agent.name, body: plainText(message.body).slice(0, BODY_CHARS), badge, agentId: agent.id, messageId: message.id };
    for (const { notificationKey, ...to } of store.pushTargetsFor(agent.person_id)) {
      void send(to, { sealed: seal(notice, notificationKey), messageId: message.id }).then((result) => {
        if (result === "gone") store.clearPushToken(to.token);
      });
    }
  });
}
