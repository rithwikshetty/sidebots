import { useEffect, useState } from "react";
import { PROVIDERS, USAGE_DAYS, type Day, type Limit, type Usage as Used } from "@server/contract.ts";
import { ApiError } from "@client/api.ts";
import { dayLabel, listTime, nextTime } from "@client/time.ts";
import { COST_NOTE, KINDS, MEASURES, TOKENS_NOTE, amount, dayTime, sum, usedBy, type Measure } from "@client/usage.ts";
import { cn } from "../lib/cn.ts";
import { UPDATE, loadUsage, useAgents, useUsage } from "../lib/store.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Bar, Failure, Group, Groups, Loading, SectionTitle } from "./Group.tsx";

/**
 * Where the person's plan or API credit goes. First, for each provider their
 * agents sign in to with a plan, how much of each of the plan's limits is
 * left and when it resets, as the provider says when the computer asks it.
 * Then the last days, by cost or by tokens as the person picks: what each day
 * used, as bars, and the agents that ran a turn, the one that used most
 * first, each with its share of what all of them used and how that splits
 * between its replies, its jobs and its fresh starts. It shows what the app
 * last had while it asks the computer again, and a plan's limits change in
 * place when the provider answers.
 */
export function Usage() {
  const usage = useUsage();
  // What arrives after the section opened empty fades in; what the app had shows at once.
  const [had] = useState(usage !== null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    loadUsage().catch((reason) => {
      // A Sidebots on the computer that doesn't count usage answers that it has no such thing.
      if (reason instanceof ApiError && reason.status === 404) return setFailure(`${UPDATE.computer} to see what your agents use.`);
      setFailure(reason instanceof Error ? reason.message : "Something went wrong.");
    });
  }, []);
  return (
    <>
      <SectionTitle>Usage</SectionTitle>
      {usage ? (
        <Groups className={had ? undefined : "animate-fade-in"}>
          {usage.accounts.map((account) => (
            <Plan key={account.provider} account={account} />
          ))}
          <LastDays usage={usage} />
        </Groups>
      ) : failure ? (
        <Failure>{failure}</Failure>
      ) : (
        <Loading label="Loading usage" />
      )}
    </>
  );
}

/** A provider the person's agents sign in to: the limits of their plan with it, or that an API key pays instead. */
function Plan({ account }: { account: Used["accounts"][number] }) {
  const { name } = PROVIDERS[account.provider];
  if (account.apiKey) return <Group title={name} testId={`usage-${account.provider}`} note="Your agents run on an API key, which has no plan to run out. The key's account is billed for what they use." />;
  const said = Math.max(...account.limits.map((limit) => limit.at));
  return (
    <Group
      title={`${name} plan`}
      testId={`usage-${account.provider}`}
      note={account.limits.length ? `As ${name} said, ${listTime(said)}. It counts what you use outside Sidebots too.` : `${name} hasn't said how much of your plan is left.`}
    >
      {account.limits.length ? account.limits.map((limit) => <LimitRow key={limit.name} limit={limit} />) : null}
    </Group>
  );
}

/** One limit of a plan: how much of it is left, as words and as a bar, and when it resets. */
function LimitRow({ limit }: { limit: Limit }) {
  const left = limit.used === null ? null : Math.round(Math.max(1 - limit.used, 0) * 100);
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3" data-testid="limit">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{limit.name}</span>
        {left === null ? null : <span className={cn("shrink-0 text-sm tabular-nums", left ? "text-ink2" : "font-medium text-danger")}>{left ? `${left}% left` : "None left"}</span>}
      </div>
      {left === null ? null : <Bar part={left / 100} label={`${limit.name}, left`} />}
      {limit.resets_at === null ? null : <span className="text-xs text-ink2">{`Resets ${nextTime(limit.resets_at)}`}</span>}
    </div>
  );
}

/** The last days by the measure the person picks: what each day used, then the agents that ran a turn in them, the one that used most first. */
function LastDays({ usage }: { usage: Used }) {
  const [measure, setMeasure] = useState<Measure>("cost");
  const rows = useAgents()
    .map((agent) => ({ agent, used: usedBy(usage, agent.id) }))
    .filter(({ used }) => used.length)
    .map((row) => ({ ...row, total: sum(row.used) }))
    .sort((a, b) => b.total[measure] - a.total[measure]);
  const all = sum(rows.map((row) => row.total));
  const ran = usage.used.length > 0;
  return (
    <Group
      title={`Last ${USAGE_DAYS} days`}
      testId="usage-days"
      action={ran ? <Segmented label="Measure" options={MEASURES} value={measure} onChange={setMeasure} plain className="h-7 w-36" /> : undefined}
      note={ran ? (measure === "cost" ? COST_NOTE : TOKENS_NOTE) : "No agent has run a turn."}
    >
      {ran ? (
        <>
          <Days days={usage.days} measure={measure} />
          {rows.map(({ agent, used, total }) => (
            <div key={agent.id} className="flex items-center gap-3 px-3.5 py-3" data-testid={`usage-agent-${agent.id}`}>
              <Avatar avatarId={agent.avatar_id} state="resting" size={32} />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name}</span>
                  <span className="shrink-0 text-sm text-ink2 tabular-nums">{amount(measure, total)}</span>
                </div>
                <Bar part={all[measure] ? total[measure] / all[measure] : 0} label={`${agent.name}'s share`} />
                <span className="truncate text-xs text-ink2">{used.map((each) => `${KINDS[each.kind]} ${amount(measure, each)}`).join(" · ")}</span>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </Group>
  );
}

// How tall the bar of the day that used most stands, and the mark of a day that used nothing, in pixels.
const BAR_HEIGHT = 96;
const BAR_LEAST = 2;
// How much of a bar shows while another day is picked.
const FADED = 0.35;

/**
 * The last days as a row of bars, a day to a bar, the tallest the day that
 * used most. Over them is what all the days used. Resting the pointer on a
 * bar, or the keyboard's focus, shows what that day used in place of the
 * total, and the other bars fade. A click picks the day, which stays shown
 * once the pointer leaves, and a click on it again lets the day go.
 */
function Days({ days, measure }: { days: Day[]; measure: Measure }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [pointed, setPointed] = useState<string | null>(null);
  const most = Math.max(...days.map((day) => day[measure]));
  const shown = days.find((day) => day.day === (pointed ?? picked));
  return (
    <div className="px-3.5 pt-3 pb-3.5" data-testid="usage-total">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-figure font-semibold tracking-tight tabular-nums" data-testid="usage-amount">
          {amount(measure, shown ?? sum(days))}
        </span>
        <span className="shrink-0 text-sm text-ink2">{shown ? dayLabel(dayTime(shown.day)) : `${USAGE_DAYS} days`}</span>
      </div>
      <div role="group" aria-label="Days" className="mt-3 flex gap-1.5" onPointerLeave={() => setPointed(null)}>
        {days.map((day) => {
          const time = dayTime(day.day);
          const part = most ? day[measure] / most : 0;
          const isPicked = day.day === picked;
          return (
            <button
              key={day.day}
              type="button"
              aria-pressed={isPicked}
              aria-label={`${dayLabel(time)}, ${amount(measure, day)}`}
              data-testid={`day-${day.day}`}
              onClick={() => setPicked(isPicked ? null : day.day)}
              onPointerEnter={() => setPointed(day.day)}
              onFocus={() => setPointed(day.day)}
              onBlur={() => setPointed(null)}
              className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-xs"
            >
              <span className="flex w-full items-end justify-center" style={{ height: BAR_HEIGHT }}>
                <span
                  className={cn("w-full max-w-10 rounded-xs transition-[height,opacity] duration-300 ease-out", part ? "bg-tint" : "bg-line-strong")}
                  style={{ height: Math.max(part * BAR_HEIGHT, BAR_LEAST), opacity: shown && day !== shown ? FADED : 1 }}
                />
              </span>
              <span className={cn("truncate text-center text-xs transition-colors duration-150", day === shown ? "font-medium text-ink" : "text-ink2")}>
                {new Date(time).toLocaleDateString(undefined, { weekday: "short" })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
