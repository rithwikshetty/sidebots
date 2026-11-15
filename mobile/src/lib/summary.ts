import type { AgentWithLatest, PetState } from "@server/contract";

/** Which animation an agent's pet plays, given the time of the newest message the person has seen in its chat. */
export function petStateOf(agent: AgentWithLatest, seen: number): PetState {
  if (agent.working) return "working";
  if (agent.latest?.sender === "simon") return "failed";
  if (agent.latest?.sender === "agent" && agent.latest.created_at > seen) return "replied";
  return "resting";
}

function greeting(hour: number): string {
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

/**
 * What the home screen says at its top: the one thing most worth knowing
 * right now, then anything else going on. Replies come first, then problems
 * the person hasn't seen, then agents still at work.
 */
export function homeLine(
  agents: AgentWithLatest[],
  seen: Record<string, number>,
  online: boolean,
  hour: number,
): { headline: string; detail: string | null } {
  if (!online) return { headline: "Can't reach Simon.", detail: "These are your saved chats." };
  if (agents.length === 0) return { headline: greeting(hour), detail: "Tap the plus to make your first agent." };

  const seenAt = (agent: AgentWithLatest) => seen[agent.id] ?? 0;
  const inState = (state: PetState) => agents.filter((agent) => petStateOf(agent, seenAt(agent)) === state);
  const replied = inState("replied");
  const failed = inState("failed").filter((agent) => (agent.latest?.created_at ?? 0) > seenAt(agent));
  const working = inState("working");

  const lines: string[] = [];
  if (replied.length) lines.push(replied.length === 1 ? `${replied[0].name} replied.` : `${replied.length} replies waiting.`);
  if (failed.length) lines.push(failed.length === 1 ? `${failed[0].name} hit a problem.` : `${failed.length} agents hit a problem.`);
  if (working.length) lines.push(working.length === 1 ? `${working[0].name} is working.` : `${working.length} agents are working.`);

  if (lines.length === 0) return { headline: greeting(hour), detail: "All quiet." };
  return { headline: lines[0], detail: lines.slice(1).join(" ") || null };
}
