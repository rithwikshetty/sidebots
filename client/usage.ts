import type { TurnKind, Usage, Used } from "../server/src/contract.ts";

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

/** A count of tokens in thousands, millions or billions, as 950, 12K or 4.2M. */
export function tokens(count: number): string {
  const [size, letter] = count >= 1e9 ? [1e9, "B"] : count >= 1e6 ? [1e6, "M"] : count >= 1e3 ? [1e3, "K"] : [1, ""];
  const value = count / size;
  return `${size > 1 && value < 10 ? value.toFixed(1) : Math.round(value)}${letter}`;
}

/** What the app measures use by, as it names each: what turns cost, or the tokens they used. */
export const MEASURES = { cost: "Cost", tokens: "Tokens" };
export type Measure = keyof typeof MEASURES;

/** How much was used, by a measure, in words. */
export function amount(measure: Measure, used: Record<Measure, number>): string {
  return measure === "cost" ? dollars(used.cost) : tokens(used.tokens);
}

/** What several turns, agents or days used between them. */
export function sum(used: Record<Measure, number>[]): Record<Measure, number> {
  return { cost: used.reduce((all, each) => all + each.cost, 0), tokens: used.reduce((all, each) => all + each.tokens, 0) };
}

/** The midnight on this device that starts a day of `Usage`. */
export function dayTime(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
}

/** What a cost is, for a person on a plan and for one on an API key. */
export const COST_NOTE = "Estimates at API prices, by the provider's own count. An API key is billed for them. On a plan they are no bill, and measure where its limits go. Use past a plan's limits is charged only where usage credits are turned on.";
/** What counts as a token. */
export const TOKENS_NOTE = "Everything the models read and wrote for your agents, by the provider's own count. What they read again from their cache counts too, and costs a fraction of the rest.";
