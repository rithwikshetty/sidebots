// Push decides when to notify the person's phones, and what the notification says.

import { plainText } from "./contract.ts";
import type { PushToken } from "./contract.ts";
import type { Store } from "./store.ts";

/** A notification: the agent's name over what it said, and the number the app's icon shows, which is everything the person hasn't read. */
export type Notice = { title: string; body: string; badge: number; agentId: string; messageId: string };
/** `gone` means Apple will never deliver to this phone's token again. */
export type SendPush = (to: PushToken, notice: Notice) => Promise<"sent" | "gone" | "failed">;

// A notification shows a few lines, and Apple takes at most 4096 bytes.
const BODY_CHARS = 600;

/** Tells the person's phones when an agent replies or a turn fails, unless the agent is muted. An update while it works tells nobody. Returns a function that stops it. */
export function startPush(store: Store, send: SendPush): () => void {
  return store.onMessage((message) => {
    const finished = (message.sender === "agent" && !message.interim) || (message.sender === "sidebots" && message.status === "failed");
    const agent = finished ? store.agent(message.agent_id) : undefined;
    if (!agent || agent.muted) return;
    // A muted agent's unread replies show on its own row, and never on the app's icon.
    const badge = store.agentsFor(agent.person_id).reduce((total, each) => total + (each.muted ? 0 : each.unread), 0);
    const notice: Notice = { title: agent.name, body: plainText(message.body).slice(0, BODY_CHARS), badge, agentId: agent.id, messageId: message.id };
    for (const to of store.pushTokensFor(agent.person_id)) {
      void send(to, notice).then((result) => {
        if (result === "gone") store.clearPushToken(to.token);
      });
    }
  });
}
