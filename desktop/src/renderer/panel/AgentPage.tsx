import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { PROVIDERS, USAGE_DAYS, plainText, scheduleWords, type AgentWithLatest, type Job, type Message, type Offered } from "@server/contract.ts";
import { WORK } from "@client/suggestions.ts";
import { listTime, nextTime } from "@client/time.ts";
import { COST_NOTE, KINDS, dollars, usedBy } from "@client/usage.ts";
import { changeOrSay, confirmDelete, problem } from "../lib/alerts.ts";
import { cn } from "../lib/cn.ts";
import { answerAsk, loadAbout, loadUsage, removeJob, useAbout, useAgent, useChatColor, useUsage, type AgentChanges } from "../lib/store.ts";
import { openChat, openPanel, type AgentTab } from "../lib/view.ts";
import { AvatarPicker } from "../ui/AvatarPicker.tsx";
import { Avatar } from "../ui/Avatar.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { confirm } from "../ui/Confirm.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Switch } from "../ui/Switch.tsx";
import { ColorPicker } from "./ColorPicker.tsx";
import { LoadingRow, Row, RowButton, RowText, Section, SectionTitle } from "./Section.tsx";

const TABS: Record<AgentTab, string> = { settings: "Settings", work: "Jobs & memory" };

// The tab each agent's page was last on, and how far down it was, while the app runs, so going to a note and back keeps them.
const tabs = new Map<string, AgentTab>();
const scrolls = new Map<string, number>();

// Whether the agent's name at the top of its page has scrolled under the panel's top bar, which then shows it.
let nameHidden = false;
const listeners = new Set<() => void>();

function setNameHidden(hidden: boolean): void {
  if (hidden === nameHidden) return;
  nameHidden = hidden;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The agent's name in the panel's top bar, which shows once the name at the top of its page has scrolled under the bar. */
export function AgentTitle({ agentId }: { agentId: string }) {
  const agent = useAgent(agentId);
  const hidden = useSyncExternalStore(subscribe, () => nameHidden);
  return (
    <span aria-hidden={!hidden || undefined} className={cn("block truncate transition-opacity duration-150 ease-out", hidden ? "opacity-100" : "opacity-0")}>
      {agent?.name}
    </span>
  );
}

/** Tells the top bar whether `element`, the agent's name, has scrolled under it. The bar is 52 pixels tall. */
function useNameUnderBar(element: { current: HTMLElement | null }): void {
  useEffect(() => {
    const name = element.current;
    if (!name) return;
    const observer = new IntersectionObserver(([entry]) => setNameHidden(!entry.isIntersecting), { rootMargin: "-52px 0px 0px 0px" });
    observer.observe(name);
    return () => {
      observer.disconnect();
      setNameHidden(false);
    };
  }, [element]);
}

/** Scrolls the panel to where the agent's page was when it was last left, and keeps where it is as it is left. */
function useKeptScroll(page: { current: HTMLElement | null }, agentId: string): void {
  useLayoutEffect(() => {
    const scroller = page.current?.parentElement;
    if (!scroller) return;
    scroller.scrollTop = scrolls.get(agentId) ?? 0;
    return () => void scrolls.set(agentId, scroller.scrollTop);
  }, [page, agentId]);
}

/** Whether what the page fetches is on its way, came, or couldn't come, with the reason. */
type Loading = { state: "loading" } | { state: "loaded" } | { state: "failed"; reason: string };

/**
 * Fetches what `load` fetches as the page opens, and again each time `key`
 * changes, and says how that went. What the store already has shows
 * meanwhile, so only a page with nothing yet waits.
 */
function useLoading(load: () => Promise<void>, key: string): Loading {
  const [loading, setLoading] = useState<Loading>({ state: "loading" });
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let current = true;
    setLoading({ state: "loading" });
    latest.current().then(
      () => current && setLoading({ state: "loaded" }),
      (failure) => current && setLoading({ state: "failed", reason: failure instanceof Error ? failure.message : "Something went wrong." }),
    );
    return () => {
      current = false;
    };
  }, [key]);
  return loading;
}

/**
 * An agent's page, in the panel. It opens on the agent's avatar, large, with
 * its name and the model it answers with. Edit turns the name into a field
 * and brings up the avatars and the colours of its chat to choose from, and
 * Save keeps what changed. Below are two tabs. Settings holds what the agent
 * used in the last days, Mute and Hide, and Delete. Jobs & memory holds what
 * the agent works on and from: the work the person started from its
 * suggestions, each of which opens the chat at its suggestion and can be
 * stopped here until it ends, its jobs, which can be removed here, the instructions
 * it follows and what it remembers, each of which opens to read in full. The
 * agent writes its jobs, instructions and memories itself, as it is told
 * things in its chat. Every change but the edit's takes effect at once. The
 * page opens on the tab it was last on, or on `tab` when it is opened for
 * one.
 */
export function AgentPage({ agentId, tab }: { agentId: string; tab?: AgentTab }) {
  const agent = useAgent(agentId);
  return agent ? <AgentAbout key={`${agent.id} ${tab}`} agent={agent} opensOn={tab} /> : null;
}

function AgentAbout({ agent, opensOn }: { agent: AgentWithLatest; opensOn?: AgentTab }) {
  const [tab, setTab] = useState<AgentTab>(() => opensOn ?? tabs.get(agent.id) ?? "settings");
  const [editing, setEditing] = useState(false);
  // A turn is what changes what the agent used, its jobs and what it remembers, so a page left open fetches them again as one starts or ends and as the agent's latest message changes.
  const turn = `${agent.id} ${agent.latest?.id} ${agent.working}`;
  const usage = useLoading(loadUsage, turn);
  const about = useLoading(() => loadAbout(agent.id), turn);
  const change = (changes: AgentChanges) => changeOrSay(agent.id, changes);
  const pick = (next: AgentTab) => {
    tabs.set(agent.id, next);
    setTab(next);
  };

  // Once the edit is left, focus goes back to Edit, where it was.
  const [edited, setEdited] = useState(false);
  const done = () => {
    setEditing(false);
    setEdited(true);
  };
  if (editing) return <EditAgent agent={agent} onDone={done} change={change} />;
  return <Shown agent={agent} tab={tab} pick={pick} edit={() => setEditing(true)} edited={edited} change={change} usage={usage} about={about} />;
}

/** The page as it reads, out of the edit. */
function Shown({
  agent,
  tab,
  pick,
  edit,
  edited,
  change,
  usage,
  about,
}: {
  agent: AgentWithLatest;
  tab: AgentTab;
  pick: (tab: AgentTab) => void;
  edit: () => void;
  edited: boolean;
  change: (changes: AgentChanges) => void;
  usage: Loading;
  about: Loading;
}) {
  const name = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLDivElement>(null);
  useNameUnderBar(name);
  useKeptScroll(page, agent.id);
  return (
    <div ref={page} className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-5 pt-2 pb-8" data-testid="agent-page">
      <Hero avatarId={agent.avatar_id}>
        <h3 ref={name} className="max-w-full truncate text-xl font-semibold" data-selectable data-testid="agent-page-name">
          {agent.name}
        </h3>
        <p className="text-sm text-ink2" data-testid="agent-page-caption">
          {caption(agent)}
        </p>
        <Button size="sm" className="mt-2" onClick={edit} autoFocus={edited} data-testid="edit-agent">
          Edit
        </Button>
      </Hero>
      <Segmented plain label="Agent" options={TABS} value={tab} onChange={pick} />
      {tab === "settings" ? <SettingsTab agent={agent} change={change} usage={usage} /> : <WorkTab agent={agent} loading={about} />}
    </div>
  );
}

/** The top of the page: the agent's avatar, large, in a wash of its chat's colour, over its name and what goes with it. */
function Hero({ avatarId, color, children }: { avatarId: string; color?: string | null; children: ReactNode }) {
  const first = useRef(avatarId);
  return (
    <div className="flex flex-col items-center gap-1 pt-3 text-center" style={color ? ({ "--chat": color } as CSSProperties) : undefined}>
      <div className="mb-3 grid size-30 place-items-center rounded-full bg-chat-wash transition-colors duration-200 ease-out">
        {/* A newly picked avatar pops in where the last one was. */}
        <Avatar key={avatarId} avatarId={avatarId} state="resting" size={80} className={avatarId === first.current ? undefined : "animate-pop-in"} />
      </div>
      {children}
    </div>
  );
}

/** The line under the agent's name: its model and effort, and whether it is muted or hidden. */
function caption(agent: AgentWithLatest): string {
  const { models, efforts }: Offered = PROVIDERS[agent.provider];
  return [`${models[agent.model]} · ${efforts[agent.effort]} effort`, agent.muted ? "Muted" : null, agent.hidden ? "Hidden" : null].filter(Boolean).join(" · ");
}

/**
 * The agent's name as a field, with the avatars and the colours of its chat to
 * choose from. Save sends only what changed, and Cancel, or Esc, leaves it as
 * it was. Enter in the name saves.
 */
function EditAgent({ agent, onDone, change }: { agent: AgentWithLatest; onDone: () => void; change: (changes: AgentChanges) => void }) {
  const [name, setName] = useState(agent.name);
  const [avatarId, setAvatarId] = useState(agent.avatar_id);
  const [color, setColor] = useState(agent.color ?? null);
  // The colour of the avatar being picked, which the chat takes when no colour of its own is picked.
  const avatarColor = useChatColor({ avatar_id: avatarId, color: null });
  const trimmed = name.trim();

  const save = () => {
    if (!trimmed) return;
    const changes: AgentChanges = {};
    if (trimmed !== agent.name) changes.name = trimmed;
    if (avatarId !== agent.avatar_id) changes.avatarId = avatarId;
    if (color !== (agent.color ?? null)) changes.color = color;
    if (Object.keys(changes).length) change(changes);
    onDone();
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // Esc leaves the edit, and the panel stays open.
    event.preventDefault();
    onDone();
  };

  return (
    <form
      className="flex min-h-full flex-col"
      onKeyDown={keys}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      data-testid="edit-agent-form"
    >
      <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-6 px-5 pt-2 pb-6">
        <Hero avatarId={avatarId} color={color ?? avatarColor}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name"
            aria-label="Name"
            maxLength={24}
            spellCheck={false}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            data-testid="agent-page-name-field"
            className="h-11 w-full rounded-lg bg-field px-3 text-center text-xl font-semibold text-ink outline-none transition-shadow duration-150 placeholder:font-medium placeholder:text-ink3 focus:shadow-[0_0_0_1px_var(--tint-ink),0_0_0_3.5px_color-mix(in_srgb,var(--tint-ink)_22%,transparent)]"
          />
        </Hero>
        <div className="flex flex-col gap-2">
          <SectionTitle>Avatar</SectionTitle>
          <AvatarPicker value={avatarId} onChange={setAvatarId} />
        </div>
        <div className="flex flex-col gap-2">
          <SectionTitle>Chat colour</SectionTitle>
          <ColorPicker value={color} avatarColor={avatarColor} onChange={setColor} />
        </div>
      </div>
      {/* Cancel and Save stay at the panel's foot while the choices scroll. */}
      <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-line bg-canvas px-5 py-3">
        <Button onClick={onDone} data-testid="cancel-edit">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!trimmed} data-testid="save-agent">
          Save
        </Button>
      </footer>
    </form>
  );
}

function SettingsTab({ agent, change, usage }: { agent: AgentWithLatest; change: (changes: AgentChanges) => void; usage: Loading }) {
  return (
    <>
      <UsedSection agentId={agent.id} loading={usage} />

      <Section>
        <Toggle title="Mute" note="No notifications from it" value={agent.muted} onChange={(muted) => change({ muted })} />
        <Toggle title="Hide" note="Off the list until it next has something to say" value={agent.hidden} onChange={(hidden) => change({ hidden })} />
      </Section>

      <Section>
        <RowButton onClick={() => void confirmDelete(agent)} className="text-sm font-medium text-danger" data-testid="delete-agent">
          Delete agent
        </RowButton>
      </Section>
    </>
  );
}

/** What the agent used in the last days, a kind of turn to a row: how many it ran and what they cost. */
function UsedSection({ agentId, loading }: { agentId: string; loading: Loading }) {
  const usage = useUsage();
  const title = `Usage, last ${USAGE_DAYS} days`;
  if (!usage) {
    return (
      <Section title={title} note={loading.state === "failed" ? loading.reason : undefined} testId="agent-usage">
        {loading.state === "loading" ? <LoadingRow /> : null}
      </Section>
    );
  }
  const used = usedBy(usage, agentId);
  return (
    <Section title={title} note={used.length ? COST_NOTE : "It hasn't run a turn."} testId="agent-usage">
      {used.map((each) => (
        <Row key={each.kind}>
          <RowText title={KINDS[each.kind]} note={each.turns === 1 ? "1 turn" : `${each.turns} turns`} />
          <span className="text-sm text-ink2 tabular-nums">{dollars(each.cost)}</span>
        </Row>
      ))}
    </Section>
  );
}

/** A setting that is on or off, as a row whose words name it. A click anywhere on the row flips it. */
function Toggle({ title, note, value, onChange }: { title: string; note: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center gap-3 px-3 py-2.5">
      <RowText title={title} note={note} />
      <Switch label={title} checked={value} onChange={onChange} />
    </label>
  );
}

function WorkTab({ agent, loading }: { agent: AgentWithLatest; loading: Loading }) {
  const about = useAbout(agent.id);
  // Until the computer has said, each group holds one row's place, or says why it couldn't.
  const waiting = about ? null : loading.state === "loading" ? <LoadingRow /> : null;
  const failed = !about && loading.state === "failed" ? loading.reason : undefined;
  const forget = async (job: Job) => {
    const yes = await confirm({ title: "Remove this job?", message: scheduleWords(job.schedule), action: "Remove", destructive: true });
    if (yes) await removeJob(agent.id, job.id).catch((failure) => problem("Couldn't remove it", failure));
  };
  return (
    <>
      <Section title="Work" note={failed ?? (about && !about.work.length ? "None. What you start from its suggestions shows here." : undefined)} testId="agent-work">
        {waiting}
        {about?.work.map((work) => <WorkRow key={work.id} work={work} />)}
      </Section>

      <Section title="Jobs" note={failed ?? (about && !about.jobs.length ? "None. Ask it to remind you of something, or to keep an eye on something." : undefined)} testId="agent-jobs">
        {waiting}
        {about?.jobs.map((job) => (
          <Row key={job.id} className="items-start" data-testid="job">
            <RowText title={scheduleWords(job.schedule)} note={<JobNote job={job} />} />
            <IconButton icon={Trash2} label="Remove job" className="-mr-1 hover:text-danger" onClick={() => void forget(job)} />
          </Row>
        ))}
      </Section>

      <Section title="Instructions" note={failed} testId="agent-instructions">
        {about ? (
          <RowButton onClick={() => openPanel({ kind: "note", agentId: agent.id, note: { kind: "instructions" } })} data-testid="open-instructions">
            <RowText note={instructionsPreview(about.instructions) || "Nothing yet."} lines={4} />
            <ChevronRight aria-hidden className="size-4 shrink-0 text-ink3" strokeWidth={2} />
          </RowButton>
        ) : (
          waiting
        )}
      </Section>

      <Section title="Memory" note={failed ?? (about && !about.memories.length ? "Nothing yet. It saves what it learns as you talk." : undefined)} testId="agent-memory">
        {waiting}
        {about?.memories.map((memory) => (
          <RowButton key={memory.name} onClick={() => openPanel({ kind: "note", agentId: agent.id, note: { kind: "memory", name: memory.name } })} data-testid="memory">
            <RowText title={memory.description || memory.name} lines={2} />
            <ChevronRight aria-hidden className="size-4 shrink-0 text-ink3" strokeWidth={2} />
          </RowButton>
        ))}
      </Section>
    </>
  );
}

/** Instructions as plain words, as the phone shows their start: each line of the markdown on a line of its own, so a heading reads apart from what follows it. */
function instructionsPreview(instructions: string): string {
  return instructions.split("\n").map(plainText).filter(Boolean).join("\n");
}

/**
 * Work the person started from one of the agent's suggestions: what it is,
 * where it stands and when the agent offered it. A click opens the chat at
 * the suggestion, and Stop ends it while it waits its turn or runs.
 */
function WorkRow({ work }: { work: Message }) {
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    setStopping(true);
    answerAsk(work, false)
      .catch((failure) => problem("Couldn't stop it", failure))
      .finally(() => setStopping(false));
  };
  return (
    <div className="flex items-center" data-testid="work">
      <RowButton onClick={() => openChat(work.agent_id, work.id)} className="min-w-0 flex-1">
        <RowText title={work.question?.what} note={`${WORK[work.status]} · ${listTime(work.created_at)}`} lines={2} />
      </RowButton>
      {work.status === "queued" || work.status === "running" ? (
        <Button size="sm" busy={stopping} onClick={stop} className="mr-3 shrink-0" data-testid="stop-work">
          Stop
        </Button>
      ) : null}
    </div>
  );
}

/** When a job next runs, and what it does. */
function JobNote({ job }: { job: Job }) {
  return (
    <>
      <span className="block">Next {nextTime(job.next_at)}</span>
      <span className="mt-0.5 line-clamp-3 block">{job.what}</span>
    </>
  );
}
