import { test } from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../../server/src/contract.ts";
import { jobChanges, jobDraft, nextWords, toggleDay } from "../jobs.ts";

const NOW = new Date(2026, 10, 16, 9, 30).getTime(); // A Monday.
const brief: Job = {
  id: "brief",
  agent_id: "ruby",
  title: "Morning brief",
  what: "Brief Alex on their day.",
  schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] },
  enabled: true,
  next_at: new Date(2026, 10, 17, 8, 0).getTime(),
  created_at: 0,
  last_run_at: null,
  last_run_status: "never",
  last_run_error: null,
  run_count: 0,
};

test("a new job's form runs every day at nine, and Once starts on the next hour but one", () => {
  const draft = jobDraft(null, NOW);
  assert.deepEqual([draft.kind, draft.time, draft.weekdays.length, draft.minutes, draft.enabled], ["daily", "09:00", 7, "60", true]);
  assert.equal(draft.at, new Date(2026, 10, 16, 10, 0).getTime());
});

test("a new job's form saves all of it, and seven days is every day, which names none", () => {
  const draft = { ...jobDraft(null, NOW), title: "Plants", what: "Water them." };
  assert.deepEqual(jobChanges(draft, null), { title: "Plants", what: "Water them.", schedule: { type: "daily", time: "09:00" }, enabled: true });
});

test("a job's row says it is paused, has nothing to come, or when it next runs", () => {
  assert.equal(nextWords({ ...brief, enabled: false }, NOW), "Paused");
  assert.equal(nextWords({ ...brief, next_at: null }, NOW), "Not scheduled");
  assert.match(nextWords(brief, NOW), /^Next Tomorrow /);
});

test("a job's form saves its schedule only when it changed, so its next run stays, and keeps its days in their order by number", () => {
  const draft = jobDraft(brief, NOW);
  assert.deepEqual(jobChanges({ ...draft, title: "Brief" }, brief), { title: "Brief", what: brief.what, enabled: true });
  const withSunday = { ...draft, weekdays: toggleDay(draft, 0) };
  const weekend = { ...withSunday, weekdays: toggleDay(withSunday, 6) };
  assert.deepEqual(jobChanges(weekend, brief), { title: brief.title, what: brief.what, schedule: { type: "daily", time: "08:00" }, enabled: true });
  // A job saved with its days in another order, or with all seven named, still has the same schedule.
  assert.deepEqual(jobChanges({ ...jobDraft({ ...brief, schedule: { type: "daily", time: "08:00", weekdays: [5, 1] } }, NOW), title: "Brief" }, { ...brief, schedule: { type: "daily", time: "08:00", weekdays: [5, 1] } }), { title: "Brief", what: brief.what, enabled: true });
  const everyDay = { ...brief, schedule: { type: "daily" as const, time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } };
  assert.deepEqual(jobChanges(jobDraft(everyDay, NOW), everyDay), { title: brief.title, what: brief.what, enabled: true });
  const sundayFirst = { ...draft, weekdays: [0, 1] };
  assert.deepEqual((jobChanges(sundayFirst, brief) as { schedule: unknown }).schedule, { type: "daily", time: "08:00", weekdays: [0, 1] });
});

test("the last day picked stays picked", () => {
  const draft = { ...jobDraft(null, NOW), weekdays: [3] };
  assert.deepEqual(toggleDay(draft, 3), [3]);
  assert.deepEqual(toggleDay(draft, 5), [3, 5]);
});
