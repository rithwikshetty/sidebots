import { Popover } from "@base-ui/react/popover";
import { Tabs } from "@base-ui/react/tabs";
import { Check, Gauge, Zap } from "lucide-react";
import { useState, type KeyboardEvent, type RefObject } from "react";
import { PROVIDERS, runsFast, type AgentWithLatest, type Logo, type Offered, type Provider } from "@server/contract.ts";
import { cn } from "../lib/cn.ts";
import { loadUsage, useUsage, type AgentChanges } from "../lib/store.ts";
import { BrandLogo } from "../ui/BrandLogo.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";

const SPEEDS = {
  standard: (
    <>
      <Gauge aria-hidden className="size-3.5 shrink-0" />
      Standard
    </>
  ),
  fast: (
    <>
      <Zap aria-hidden className="size-3.5 shrink-0" />
      Fast
    </>
  ),
};

/**
 * What the agent answers with, in the message field: a button with its
 * provider's logo, whose tooltip names its model, its effort, and "Fast"
 * when it answers in fast mode. It opens a panel above it. At the panel's start is a rail of
 * the providers, by logo, with a mark beside the one whose models are listed
 * next to it. A provider the person hasn't set up is faded, and says where to
 * set it up in place of its models. Beside the models are the efforts the
 * agent's own provider has, and across the foot is its speed, which only a
 * model with a fast mode can change, and which says while it is fast that
 * fast uses more of the plan. A check marks what is in effect. A
 * choice takes effect from the agent's next turn and leaves the panel open
 * for another, and a model of another provider moves the agent there, with
 * its effort when that provider has it. Up and Down move through a list.
 * Closed, the panel leaves the person at `returnTo`, where they write.
 */
export function ModelPicker({ agent, onSet, returnTo }: { agent: AgentWithLatest; onSet: (changes: AgentChanges) => void; returnTo: RefObject<HTMLElement | null> }) {
  const own: Offered = PROVIDERS[agent.provider];
  const fast = runsFast(agent);
  // The providers the person has set up, which the computer lists once the panel has opened. Until it has, every provider counts.
  const usage = useUsage();
  const setUp = (provider: Provider) => usage === null || usage.accounts.some((account) => account.provider === provider);
  // The provider whose models the panel lists, which starts as the agent's own each time it opens.
  const [listed, setListed] = useState(agent.provider);
  const label = [own.models[agent.model], `${own.efforts[agent.effort]} effort`, ...(fast ? ["Fast"] : [])].join(" · ");

  const pick = (provider: Provider, model: AgentChanges["model"]) =>
    onSet(provider === agent.provider ? { model } : { provider, model, effort: Object.hasOwn(PROVIDERS[provider].efforts, agent.effort) ? agent.effort : PROVIDERS[provider].effort });

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) return;
        setListed(agent.provider);
        loadUsage().catch(() => {});
      }}
    >
      <Tooltip label={label} side="top">
        <Popover.Trigger
          aria-label={`Model: ${label}`}
          className="grid size-8 shrink-0 place-items-center rounded-md transition-colors duration-150 hover:bg-hover data-[popup-open]:bg-press"
          data-testid="model"
        >
          <BrandLogo logo={own.logo} size={18} />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="z-50 outline-none">
          <Popover.Popup
            data-floating
            aria-label="Model"
            finalFocus={returnTo}
            className="w-[33rem] max-w-[calc(100vw-2rem)] origin-(--transform-origin) overflow-hidden rounded-xl bg-raised text-ink shadow-menu outline-none transition-[opacity,scale] duration-150 ease-out data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
            data-testid="model-picker"
          >
            <div className="flex max-h-[19rem]">
              <Tabs.Root orientation="vertical" value={listed} onValueChange={(provider) => setListed(provider as Provider)} className="flex min-w-0 flex-1">
                <Tabs.List aria-label="Providers" className="relative flex w-12 shrink-0 flex-col gap-1 bg-field/60 p-1.5">
                  {(Object.keys(PROVIDERS) as Provider[]).map((provider) => (
                    <Tabs.Tab
                      key={provider}
                      value={provider}
                      aria-label={PROVIDERS[provider].name}
                      title={PROVIDERS[provider].name}
                      className={cn("grid aspect-square w-full place-items-center rounded-md text-ink outline-none transition-colors hover:bg-hover focus-visible:bg-hover", !setUp(provider) && "opacity-45")}
                      data-testid={`provider-${provider}`}
                    >
                      <BrandLogo logo={PROVIDERS[provider].logo} size={20} />
                    </Tabs.Tab>
                  ))}
                  <Tabs.Indicator className="absolute top-[calc(var(--active-tab-top)+8px)] right-0.5 h-5 w-[3px] rounded-full bg-tint transition-[top] duration-200 ease-out" />
                </Tabs.List>
                {(Object.keys(PROVIDERS) as Provider[]).map((provider) => {
                  const { name, models }: Offered = PROVIDERS[provider];
                  return (
                    <Tabs.Panel key={provider} value={provider} className="flex min-w-0 flex-1 flex-col border-l border-line outline-none">
                      <Heading title={name} />
                      {setUp(provider) ? (
                        <Options label={`${name} models`} options={models} value={provider === agent.provider ? agent.model : undefined} onPick={(model) => pick(provider, model)} logo={PROVIDERS[provider].logo} />
                      ) : (
                        <p className="px-4 pt-3 text-sm text-ink2" data-testid="not-set-up">
                          {name} isn't set up on this computer. Set it up from Sidebots in the menu bar.
                        </p>
                      )}
                    </Tabs.Panel>
                  );
                })}
              </Tabs.Root>
              <div className="flex w-48 shrink-0 flex-col border-l border-line bg-field/40">
                <Heading title="Effort" detail={own.models[agent.model]} />
                <Options label="Effort" options={own.efforts} value={agent.effort} onPick={(effort) => onSet({ effort })} />
              </div>
            </div>
            <div className="flex h-12 items-center gap-3 border-t border-line bg-field/40 px-3" title={own.fast.includes(agent.model) ? undefined : `${own.models[agent.model]} has no fast mode`}>
              <Segmented label="Speed" options={SPEEDS} value={fast ? "fast" : "standard"} onChange={(speed) => onSet({ fast: speed === "fast" })} disabled={!own.fast.includes(agent.model)} plain className="h-7 w-48 shrink-0" />
              {fast ? <p className="ml-auto min-w-0 truncate text-xs text-ink2">Fast uses more of your plan</p> : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** What heads a column of the panel: its title over a line, with a `detail` at the line's end, as the model an effort is for. */
function Heading({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="mx-4 flex h-11 shrink-0 items-center gap-2 border-b border-line text-sm">
      <span className="truncate font-semibold">{title}</span>
      {detail ? <span className="ml-auto truncate text-xs text-ink2">{detail}</span> : null}
    </div>
  );
}

/** A column of choices where one may be in effect, which wears a check. Up and Down move between them, and Enter or a click picks one. Models wear their maker's `logo`. */
function Options<Id extends string>({ label, options, value, onPick, logo }: { label: string; options: Partial<Record<Id, string>>; value: Id | undefined; onPick: (id: Id) => void; logo?: Logo }) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    rows[(at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={move} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
      {(Object.keys(options) as Id[]).map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={id === value}
          onClick={() => id !== value && onPick(id)}
          className="flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none select-none hover:bg-hover focus-visible:bg-hover active:bg-press"
        >
          {logo ? <BrandLogo logo={logo} size={16} /> : null}
          <span className="min-w-0 flex-1 truncate">{options[id]}</span>
          {id === value ? <Check aria-hidden className="size-3.5 shrink-0 text-ink2" strokeWidth={2.5} /> : null}
        </button>
      ))}
    </div>
  );
}
