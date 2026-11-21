// The system's notifications and the number on the app's icon. A reply, an
// ask or a failure notifies as it arrives, by the rule the server notifies
// phones by, unless the person is looking at its chat; a click opens the chat
// at it. The icon counts what is unread in the chats the person isn't looking
// at.

import { useEffect } from "react";
import { notifies, type AgentWithLatest, type Message } from "@server/contract.ts";
import { preview } from "@client/messages.ts";
import { onAgents, useAgents } from "./store.ts";
import { closeNewAgent, closeSettings, looking, openChat, useLooking, useOpenChat } from "./view.ts";

// A notification shows a few lines of the message.
const BODY_CHARS = 300;

// The latest message of each agent the window has heard of, by id. Null until the computer first says how the agents stand, which is the chats as they were when the window opened.
let heard: Set<string> | null = null;

/**
 * Notifies of each agent's newest message as the computer tells of it, once.
 * A message is new when the window hasn't heard of it as the agent's latest
 * before, and it notifies while it is unread, so one the person read on
 * another device while the stream was down stays quiet as the window catches
 * up. Nothing notifies for a muted agent. It keeps the app's icon at the
 * count of unread messages of the agents that aren't muted, leaving out the
 * chat the person is looking at, and opens the chat a clicked notification
 * names.
 */
export function useNotifications(): void {
  useEffect(
    () =>
      onAgents((agents) => {
        const first = heard === null;
        heard ??= new Set();
        for (const agent of agents) {
          const latest = agent.latest;
          if (!latest || heard.has(latest.id)) continue;
          heard.add(latest.id);
          if (!first && agent.unread > 0 && !agent.muted && notifies(latest) && !looking(agent.id)) notify(agent, latest);
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

function notify(agent: AgentWithLatest, message: Message): void {
  window.desktop.notify({ title: agent.name, body: preview(message).slice(0, BODY_CHARS), agentId: agent.id, messageId: message.id });
}
