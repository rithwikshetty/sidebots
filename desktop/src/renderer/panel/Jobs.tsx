import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { Ellipsis, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { JOB_RUN, WEEK, WEEKDAYS, plainText, scheduleWords, type Job, type JobRun, type Schedule } from "@server/contract.ts";
import { jobChanges, jobDraft, nextWords, toggleDay, type JobDraft } from "@client/jobs.ts";
import { confirmDeleteJob, problem } from "../lib/alerts.ts";
import { cn } from "../lib/cn.ts";
import { loadAbout, runJob, saveJob } from "../lib/store.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Dialog, DialogClose, DialogFooter, DialogHeader } from "../ui/Dialog.tsx";
import { Input, Textarea } from "../ui/Input.tsx";
import { Menu } from "../ui/Menu.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Switch } from "../ui/Switch.tsx";
import { Row, Section } from "./Section.tsx";

// How often an agent's page asks again while one of its jobs runs, so the run's end shows.
const RUNNING_POLL_MS = 3_000;

/**
 * An agent's jobs, each with its title, the start of what it does, its
 * schedule, when it next runs and how its last run went. Its switch pauses
 * it and runs it again, and its menu edits it, runs it now or deletes it.
 * New job makes one. While a job runs, the page asks again every few
 * seconds, so the run's end shows.
 */
export function JobsSection({ agentId, jobs, note, children }: { agentId: string; jobs: Job[] | undefined; note?: string; children?: ReactNode }) {
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const name = useRef<HTMLInputElement>(null);
  const running = jobs?.some((job) => job.last_run_status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void loadAbout(agentId).catch(() => {}), RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [agentId, running]);
  return (
    <>
      <Section
        title="Jobs"
        action={
          <Button size="sm" variant="ghost" onClick={() => setEditing("new")} data-testid="new-job">
            <Plus aria-hidden className="size-3.5" strokeWidth={2.25} />
            New job
          </Button>
        }
        note={note ?? (jobs && !jobs.length ? "None. Make one here, or ask the agent to remind you of something or keep an eye on something." : undefined)}
        testId="agent-jobs"
      >
        {children}
        {jobs?.map((job) => <JobRow key={job.id} job={job} onEdit={() => setEditing(job)} />)}
      </Section>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} initialFocus={name} testId="job-editor">
        {editing !== null ? <JobEditor key={editing === "new" ? "new" : editing.id} agentId={agentId} job={editing === "new" ? null : editing} name={name} onDone={() => setEditing(null)} /> : null}
      </Dialog>
    </>
  );
}

const RUN_TONE: Record<Exclude<JobRun, "never">, string> = {
  running: "bg-tint/12 text-tint-ink",
  succeeded: "bg-ok/14 text-ok",
  failed: "bg-danger/12 text-danger",
};

/** How a job's last run went, as a small coloured label. */
function RunBadge({ status }: { status: Exclude<JobRun, "never"> }) {
  return <span className={cn("rounded-full px-1.5 text-2xs leading-[18px] font-medium", RUN_TONE[status])}>{JOB_RUN[status]}</span>;
}

function JobRow({ job, onEdit }: { job: Job; onEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<unknown>, failed: string) => {
    setBusy(true);
    await action().catch((failure) => problem(failed, failure));
    setBusy(false);
  };
  return (
    <Row className="items-start" data-testid="job">
      <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5 transition-opacity duration-150", !job.enabled && "opacity-60")}>
        <span className="truncate text-sm font-medium text-ink" data-testid="job-title">
          {job.title}
        </span>
        <span className="line-clamp-2 text-xs text-ink2">{plainText(job.what)}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink2" data-testid="job-when">
          <span>
            {scheduleWords(job.schedule)} · {nextWords(job)}
          </span>
          {job.last_run_status !== "never" ? <RunBadge status={job.last_run_status} /> : null}
        </span>
        {job.last_run_status === "failed" && job.last_run_error ? <span className="line-clamp-2 text-xs text-danger">{job.last_run_error}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-px">
        <Switch checked={job.enabled} label={`Run ${job.title}`} onChange={(enabled) => void saveJob(job.agent_id, { enabled }, job.id).catch((failure) => problem(enabled ? "Couldn't turn it on" : "Couldn't pause it", failure))} />
        <Menu
          align="end"
          trigger={<IconButton icon={Ellipsis} size="sm" label={`Actions for ${job.title}`} disabled={busy} className="-mr-1" />}
          entries={[
            { label: "Edit", icon: Pencil, onSelect: onEdit },
            { label: "Run now", icon: Play, onSelect: () => void act(() => runJob(job.agent_id, job.id), "Couldn't run it") },
            "separator",
            { label: "Delete", icon: Trash2, danger: true, onSelect: () => void confirmDeleteJob(job) },
          ]}
        />
      </div>
    </Row>
  );
}

const KINDS: Record<Schedule["type"], string> = { daily: "At a time", once: "Once", every: "Every interval" };

const two = (value: number) => String(value).padStart(2, "0");
/** A time as a date and time field holds it, by this computer's clock. */
const localValue = (time: number) => {
  const at = new Date(time);
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
};

/**
 * A job's form: its name, what the agent does on each run, when it runs, and
 * whether it runs. Saving a job sends what changed of it, and a schedule it
 * still had the same is left as it was, so its next run stays.
 */
function JobEditor({ agentId, job, name, onDone }: { agentId: string; job: Job | null; name: RefObject<HTMLInputElement | null>; onDone: () => void }) {
  const [draft, setDraft] = useState(() => jobDraft(job));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const change = (patch: Partial<JobDraft>) => setDraft((current) => ({ ...current, ...patch }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await saveJob(agentId, jobChanges(draft, job), job?.id);
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save it.");
      setSaving(false);
    }
  }

  const label = "text-xs font-semibold text-ink2";
  return (
    <form onSubmit={save} className="flex min-h-0 flex-col">
      <DialogHeader title={job ? "Edit job" : "New job"} />
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pt-1 pb-3">
        <p className="text-xs text-pretty text-ink2">The agent runs it by itself, in a session of its own, and what it finds comes to its chat.</p>
        <label className="flex flex-col gap-1.5">
          <span className={label}>Name</span>
          <Input ref={name} value={draft.title} onChange={(event) => change({ title: event.target.value })} placeholder="e.g. Morning brief" data-testid="job-title-field" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={label}>Instructions</span>
          <Textarea value={draft.what} onChange={(event) => change({ what: event.target.value })} placeholder="What should the agent do each time this runs?" rows={5} data-testid="job-what-field" />
        </label>
        <div className="flex flex-col gap-2">
          <span className={label}>Schedule</span>
          <Segmented label="Schedule" options={KINDS} value={draft.kind} onChange={(kind) => change({ kind })} />
          {draft.kind === "daily" ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink2">
              <span>Run at</span>
              <Input type="time" value={draft.time} onChange={(event) => change({ time: event.target.value })} aria-label="Time of day" className="w-28" data-testid="job-time-field" />
              <span>on</span>
              <div role="group" aria-label="Days to run" className="flex gap-1">
                {WEEK.map((day) => {
                  const on = draft.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() => change({ weekdays: toggleDay(draft, day) })}
                      className={cn(
                        "h-7 w-9 rounded-sm text-xs font-medium transition-colors duration-150",
                        on ? "bg-tint text-on-tint" : "bg-field text-ink2 hover:text-ink",
                      )}
                    >
                      {WEEKDAYS[day]}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : draft.kind === "once" ? (
            <div className="flex items-center gap-2 text-sm text-ink2">
              <span>Run on</span>
              <Input type="datetime-local" value={localValue(draft.at)} onChange={(event) => event.target.value && change({ at: new Date(event.target.value).getTime() })} aria-label="Date and time" className="w-56" data-testid="job-at-field" />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-ink2">
              <span>Run every</span>
              <Input type="number" min={1} step={1} value={draft.minutes} onChange={(event) => change({ minutes: event.target.value })} aria-label="Minutes" className="w-24" data-testid="job-minutes-field" />
              <span>{draft.minutes === "1" ? "minute" : "minutes"}</span>
            </div>
          )}
        </div>
        <label className="flex items-center justify-between gap-4">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm text-ink">Enabled</span>
            <span className="text-xs text-ink2">A paused job stays saved but doesn't run.</span>
          </span>
          <Switch checked={draft.enabled} onChange={(enabled) => change({ enabled })} label="Enabled" />
        </label>
        {error ? (
          <p role="alert" className="text-xs text-danger" data-testid="job-error">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <DialogClose render={<Button disabled={saving} />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" busy={saving} data-testid="save-job">
          {job ? "Save job" : "Create job"}
        </Button>
      </DialogFooter>
    </form>
  );
}
