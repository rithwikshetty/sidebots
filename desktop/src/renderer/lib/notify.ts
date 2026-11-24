// The system's notifications and the number on the app's icon. A reply, an
// ask or a failure notifies a moment after it arrives, by the rule the server
// notifies phones by, unless the person has read it by then, here or on
// another device, or is looking at its chat; a click opens the chat at it. A
// notification goes once its chat has nothing unread. The icon counts what is
// unread in the chats the person isn't looking at.

import { useEffect } from "react";
import { NOTIFY_AFTER_MS, notifies, type AgentWithLatest, type Message } from "@server/contract.ts";
import { preview } from "@client/messages.ts";
import { onAgents, useAgents } from "./store.ts";
import { closeNewAgent, closeSettings, looking, openChat, useLooking, useOpenChat } from "./view.ts";

// A notification shows a few lines of the message.
const BODY_CHARS = 300;

// The latest message of each agent the window has heard of, by id. Null until the computer first says how the agents stand, which is the chats as they were when the window opened.
let heard: Set<string> | null = null;
// The agents as the computer last said they stand, and the ones a notification is shown for.
let standing: AgentWithLatest[] = [];
const notified = new Set<string>();

/**
 * Notifies of each agent's newest message a moment after the computer tells
 * of it, once. A message is new when the window hasn't heard of it as the
 * agent's latest before, and it notifies while it is unread, so one the
 * person read on another device, as it came or while the stream was down,
 * stays quiet. Nothing notifies for a muted agent. An agent's notifications
 * go when nothing of its is unread any more, or it is deleted. It keeps the
 * app's icon at the count of unread messages of the agents that aren't muted,
 * leaving out the chat the person is looking at, and opens the chat a clicked
 * notification names.
 */
export function useNotifications(): void {
  useEffect(
    () =>
      onAgents((agents) => {
        const first = heard === null;
        heard ??= new Set();
        standing = agents;
        for (const agentId of notified) {
          if (agents.some((agent) => agent.id === agentId && agent.unread > 0)) continue;
          notified.delete(agentId);
          window.desktop.clearNotices(agentId);
        }
        for (const agent of agents) {
          const latest = agent.latest;
          if (!latest || heard.has(latest.id)) continue;
          heard.add(latest.id);
          if (!first && notifies(latest)) setTimeout(() => notifyOf(agent.id, latest), NOTIFY_AFTER_MS);
        }
      }),
    [],
  );

  useEffect(
    () =>
      window.desktop.onOpenChat(({ agentId, messageId }) => {
        closeSettings();
        closeNewAgent();
        openChat(agentId, messageId);
      }),
    [],
  );

  // What comes into the chat the person is looking at is unread only until the chat marks it read, a moment later.
  const open = useOpenChat()?.agentId ?? "";
  const seen = useLooking(open) ? open : null;
  const unread = useAgents().reduce((total, agent) => total + (agent.muted || agent.id === seen ? 0 : agent.unread), 0);
  useEffect(() => window.desktop.setBadge(unread), [unread]);
}

/** Notifies of a message that came into an agent's chat when, as the agent stands now, the person hasn't read it and isn't looking at the chat. */
function notifyOf(agentId: string, message: Message): void {
  const agent = standing.find((each) => each.id === agentId);
  if (!agent || agent.muted || agent.unread === 0 || message.created_at <= agent.read_at || looking(agent.id)) return;
  // An ask answered meanwhile, on another device, is nothing to tell of.
  if (agent.latest?.id === message.id && !notifies(agent.latest)) return;
  notified.add(agent.id);
  window.desktop.notify({ title: agent.name, body: preview(message).slice(0, BODY_CHARS), agentId: agent.id, messageId: message.id });
}
