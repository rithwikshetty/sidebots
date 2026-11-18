import type { TurnKind, Usage, Used } from "@server/contract";

/** What the app calls each kind of turn, in the order it lists them. */
export const KINDS: Record<TurnKind, string> = { reply: "Replies", job: "Jobs", memory: "Fresh starts" };

/** What one agent used, a kind of turn at a time, in the order of `KINDS`. */
export function usedBy(usage: Usage, agentId: string): Used[] {
  return (Object.keys(KINDS) as TurnKind[]).flatMap((kind) => usage.used.filter((each) => each.agent_id === agentId && each.kind === kind));
}

/** A cost in US dollars, to the cent. */
export function dollars(cost: number): string {
  return cost > 0 && cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

/** What a cost is, for a person on a plan and for one on an API key. */
export const COST_NOTE = "Estimates at API prices, by the provider's own count. An API key is billed for them. On a plan they are no bill, and measure where its limits go. Use past a plan's limits is charged only where usage credits are turned on.";
