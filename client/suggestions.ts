import { isSuggestion, type AgentWithLatest, type Message, type Status } from "../server/src/contract.ts";

/** A suggestion at the top of its stack: its place among those the agent offered together, and how many still wait under it. */
export type Stacked = { at: number; of: number; under: number };

/**
 * How a chat draws the suggestions in its messages. Those an agent offered
 * together, one after another, are a stack: the first of them that still
 * waits shows, with its place among them, and the rest that wait are `under`
 * it, out of sight until it is answered. One the person started stays in the
 * chat as its own card, which says where its work stands. One they said not
 * now to, and one the agent's next suggestions took the place of, are gone.
 */
export function stacksIn(messages: Message[]): { top: Map<string, Stacked>; hidden: Set<string> } {
  const top = new Map<string, Stacked>();
  const hidden = new Set<string>();
  for (let start = 0; start < messages.length; start++) {
    if (!isSuggestion(messages[start])) continue;
    let end = start;
    while (end + 1 < messages.length && isSuggestion(messages[end + 1])) end++;
    const offered = messages.slice(start, end + 1);
    const waiting = offered.filter((each) => each.ask === "waiting");
    for (const each of offered) if (each.ask !== "allowed" && each !== waiting[0]) hidden.add(each.id);
    if (waiting[0]) top.set(waiting[0].id, { at: offered.indexOf(waiting[0]) + 1, of: offered.length, under: waiting.length - 1 });
    start = end;
  }
  return { top, hidden };
}

/** Where the work of a suggestion the person started stands, in the words its card and the agent's page say it with. */
export const WORK: Record<Status, string> = { queued: "Waiting its turn", running: "Working", done: "Done", failed: "Didn't finish" };

/** What an agent does beside its chat, as the strip over the message field says it: the work, its name, where it stands in words, whether its dots light in turn, and how many more wait behind it. */
export type Beside = { work: Message; title: string; state: string; running: boolean; more: number };

/**
 * What an agent does beside its chat: the work its run is on, or that is
 * next. `messages` are the chat's, where an ask the work raised waits on the
 * person. Nothing when the agent has no such work.
 */
export function workBeside(agent: Pick<AgentWithLatest, "work">, messages: Message[]): Beside | undefined {
  const [work, ...rest] = agent.work;
  if (!work) return undefined;
  const needsPerson = messages.some((message) => message.ask === "waiting" && message.reply_to === work.id);
  const running = work.status === "running" && !needsPerson;
  return { work, title: work.question?.what ?? "", state: needsPerson ? "Waiting for you" : WORK[work.status], running, more: rest.length };
}
