import type { Message } from "../server/src/contract.ts";

/** Where an exchange between two agents stands, in the words its line says it with. */
export type Standing = "Answered" | "No answer" | "Needs your OK" | "Waiting";

/**
 * The newest thing asked in an exchange, and where it stands, which is where
 * the exchange does. `messages` are those of a chat the exchange is in. It
 * needs the person's OK while the agent that was asked is at work on it and
 * waits on their answer to an ask of its own.
 */
export function standingOf(exchange: Message[], messages: Message[]): { asked: Message; state: Standing } {
  const asked = exchange.findLast((message) => !message.reply_to) ?? exchange[0];
  if (exchange.some((message) => message.reply_to === asked.id)) return { asked, state: "Answered" };
  if (asked.status === "failed") return { asked, state: "No answer" };
  const needsPerson = asked.status === "running" && messages.some((message) => message.ask === "waiting" && message.agent_id === asked.peer_id && message.peer_id === asked.agent_id);
  return { asked, state: needsPerson ? "Needs your OK" : "Waiting" };
}
