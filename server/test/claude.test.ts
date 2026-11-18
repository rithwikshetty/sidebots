import { test } from "node:test";
import assert from "node:assert/strict";
import { limitsIn } from "../src/claude.ts";

/** What Claude Code says of a plan's limits as a turn runs, with the limits it lists as the SDK's types leave them out. */
const said = (info: object) => limitsIn(info as Parameters<typeof limitsIn>[0], 5);

test("a plan's limits are the ones Claude Code lists and the one it names, and the one that refuses a turn is all used", () => {
  const resetsAt = 1795111200;
  const listed = { seven_day: { utilization: 0.33, resetsAt, status: "allowed" }, seven_day_overage_included: { utilization: 0.54, resetsAt, status: "allowed" } };
  assert.deepEqual(said({ status: "allowed", rateLimitType: "seven_day", resetsAt, unifiedWindows: listed }), [
    { name: "Weekly limit", used: 0.33, resets_at: resetsAt * 1000, at: 5 },
    { name: "Fable limit", used: 0.54, resets_at: resetsAt * 1000, at: 5 },
  ]);
  // A limit it names and doesn't list, as the turn is refused.
  assert.deepEqual(said({ status: "rejected", rateLimitType: "seven_day_sonnet", resetsAt: resetsAt + 60, unifiedWindows: { seven_day: listed.seven_day } }), [
    { name: "Sonnet limit", used: 1, resets_at: (resetsAt + 60) * 1000, at: 5 },
    { name: "Weekly limit", used: 0.33, resets_at: resetsAt * 1000, at: 5 },
  ]);
  // Credit bought beyond the plan is none of its limits.
  assert.deepEqual(said({ status: "allowed", rateLimitType: "overage" }), []);
});
