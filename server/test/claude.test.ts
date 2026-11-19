import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { limitsAnswered, limitsIn, question } from "../src/claude.ts";

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

test("asked where a plan's limits stand, Claude Code lists each with a hundredth of it as one, and a model's own under the model's name", () => {
  const resets_at = "2026-11-25T21:00:00.570191+00:00";
  const answered = (rate_limits: object | null) => limitsAnswered({ rate_limits } as Parameters<typeof limitsAnswered>[0], 5);
  assert.deepEqual(answered({ five_hour: null, seven_day: { utilization: 1, resets_at }, seven_day_opus: { utilization: null, resets_at: null }, model_scoped: [{ display_name: "Fable", utilization: 54, resets_at }] }), [
    { name: "Weekly limit", used: 0.01, resets_at: Date.parse(resets_at), at: 5 },
    { name: "Fable limit", used: 0.54, resets_at: Date.parse(resets_at), at: 5 },
  ]);
  // A login with no plan.
  assert.deepEqual(answered(null), []);
});

test("an ask leads with plain words, lists the facts that matter, and keeps the thing itself as its detail", () => {
  // A command leads with the agent's own account of it. Without one, it leads with the command's first line.
  assert.deepEqual(question("Bash", { command: "curl -X POST https://shop.example/book", description: "Book the Friday repair slot" }, undefined, "\u001b[31mIt sends data.\u001b[0m"), {
    kind: "command",
    title: "Run a command",
    what: "Book the Friday repair slot",
    facts: [],
    detail: "curl -X POST https://shop.example/book",
    why: "It sends data.",
  });
  assert.equal(question("Bash", { command: "make clean\nmake" }, undefined, undefined).what, "make clean");
  // A page leads with its site, and says what the agent is looking for there.
  assert.deepEqual(question("WebFetch", { url: "https://shop.example/repairs?ref=1", prompt: "The price of a brake cable" }, undefined, undefined), {
    kind: "page",
    title: "Open a page",
    what: "shop.example",
    facts: [["Looking for", "The price of a brake cable"]],
    detail: "https://shop.example/repairs?ref=1",
  });
  // A file leads with its name, with its folder and the size of the change as facts.
  const file = `${homedir()}/Documents/Rides/plan.md`;
  assert.deepEqual(question("Edit", { file_path: file, old_string: "a\nb", new_string: "c" }, undefined, undefined), {
    kind: "file",
    title: "Change a file",
    what: "plan.md",
    facts: [
      ["In", "~/Documents/Rides"],
      ["Changes", "2 lines"],
    ],
    detail: `${file}\n\n- a\n- b\n+ c`,
  });
  assert.deepEqual(question("Write", { file_path: file, content: "one line" }, undefined, undefined).facts, [
    ["In", "~/Documents/Rides"],
    ["Size", "1 line"],
  ]);
  // A connection's tool leads with its name in words. What it was given in a few words is its facts, and the rest stays in its detail.
  const mail = { to: "bookings@shop.example", subject: "Brake cable", body: "Hello,\n\nPlease confirm.", urgent: false, labels: ["a"] };
  assert.deepEqual(question("mcp__gmail__send_email", mail, "gmail", undefined), {
    kind: "tool",
    title: "Use gmail",
    what: "Send email",
    facts: [
      ["To", "bookings@shop.example"],
      ["Subject", "Brake cable"],
      ["Urgent", "false"],
    ],
    detail: JSON.stringify(mail, null, 2),
  });
});
