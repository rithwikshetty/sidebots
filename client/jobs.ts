// A job as its form holds it, in the phone app and the desktop app alike.

import { WEEK, type Job, type JobFields, type Schedule } from "../server/src/contract.ts";
import { nextTime } from "./time.ts";

/**
 * A job's form: its title, what the agent does on each run, which way of
 * saying when is picked, what is set for each way, and whether it runs. Each
 * way keeps what was set for it while another is picked. `minutes` is as the
 * person typed it.
 */
export type JobDraft = { title: string; what: string; kind: Schedule["type"]; time: string; weekdays: number[]; at: number; minutes: string; enabled: boolean };

/** A new job's form, or one's as it is now. A new one runs every day at nine, and Once starts on the next hour but one. */
export function jobDraft(job: Job | null, now = Date.now()): JobDraft {
  const hour = new Date(now);
  hour.setHours(hour.getHours() + 1, 0, 0, 0);
  const draft: JobDraft = { title: job?.title ?? "", what: job?.what ?? "", kind: job?.schedule.type ?? "daily", time: "09:00", weekdays: WEEK, at: hour.getTime(), minutes: "60", enabled: job?.enabled ?? true };
  const schedule = job?.schedule;
  if (schedule?.type === "daily") return { ...draft, time: schedule.time, weekdays: schedule.weekdays ?? WEEK };
  if (schedule?.type === "once") return { ...draft, at: schedule.at };
  if (schedule?.type === "every") return { ...draft, minutes: String(schedule.minutes) };
  return draft;
}

/** The schedule a form sets. A job that runs on all seven days names none, and its days are in their order by number, as the computer keeps them. */
export function draftSchedule(draft: JobDraft): Schedule {
  if (draft.kind === "every") return { type: "every", minutes: Number(draft.minutes) };
  if (draft.kind === "once") return { type: "once", at: draft.at };
  return draft.weekdays.length === 7 ? { type: "daily", time: draft.time } : { type: "daily", time: draft.time, weekdays: [...draft.weekdays].sort((a, b) => a - b) };
}

/** A form's days with `day` picked, or not. The last day picked stays, as a job runs on one day at least. */
export function toggleDay(draft: JobDraft, day: number): number[] {
  if (!draft.weekdays.includes(day)) return [...draft.weekdays, day];
  return draft.weekdays.length > 1 ? draft.weekdays.filter((each) => each !== day) : draft.weekdays;
}

/**
 * What to save of a job's form, for a new job or a change to `job`. A
 * schedule the job still has is left out, so its next run stays as it was,
 * however the job's days were set out when it was saved. The computer says
 * what is wrong with what is saved.
 */
export function jobChanges(draft: JobDraft, job: Job | null): Partial<JobFields> {
  const { title, what, enabled } = draft;
  const schedule = draftSchedule(draft);
  return job && JSON.stringify(schedule) === JSON.stringify(draftSchedule(jobDraft(job))) ? { title, what, enabled } : { title, what, schedule, enabled };
}

/** Where a job's next run stands, as its row says: paused, nothing to come, or when. */
export function nextWords(job: Job, now = Date.now()): string {
  if (!job.enabled) return "Paused";
  return job.next_at === null ? "Not scheduled" : `Next ${nextTime(job.next_at, now)}`;
}
