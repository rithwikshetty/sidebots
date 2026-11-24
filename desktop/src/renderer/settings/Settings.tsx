import type { ComponentType, KeyboardEvent } from "react";
import { ArrowUpRight, Cable, ChartNoAxesColumn, Info, Smartphone, X } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { useConnection } from "../lib/store.ts";
import { closeSettings, openSettings, useSettings, type SettingsSection } from "../lib/view.ts";
import { IconButton } from "../ui/Button.tsx";
import { Dialog, DialogClose } from "../ui/Dialog.tsx";
import { Connections } from "./Connections.tsx";
import { SectionTitle } from "./Group.tsx";
import { Phones } from "./Phones.tsx";
import { Usage } from "./Usage.tsx";

const SITE = "https://sidebots.app";
const PRIVACY = "https://sidebots.app/privacy";

/** Each section of Settings, in the order the list shows them: its name, its icon, and what it shows. */
const SECTIONS: Record<SettingsSection, { name: string; icon: ComponentType<{ className?: string; strokeWidth?: number }>; Body: ComponentType }> = {
  usage: { name: "Usage", icon: ChartNoAxesColumn, Body: Usage },
  connections: { name: "Connections", icon: Cable, Body: Connections },
  phones: { name: "Phones", icon: Smartphone, Body: Phones },
  about: { name: "About", icon: Info, Body: About },
};
const IDS = Object.keys(SECTIONS) as SettingsSection[];

/** Opens the section before or after the open one with the arrow keys, and moves focus to it, as the list of a system's settings does. */
function moveSection(event: KeyboardEvent<HTMLElement>, section: SettingsSection) {
  const toward = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!toward) return;
  event.preventDefault();
  const next = IDS[(IDS.indexOf(section) + toward + IDS.length) % IDS.length];
  openSettings(next);
  event.currentTarget.querySelector<HTMLElement>(`[data-section="${next}"]`)?.focus();
}

/** Settings, in a dialog over the window: a list of its sections at the left, and the open one beside it. */
export function Settings() {
  const settings = useSettings();
  const section = settings?.section ?? "usage";
  const { Body } = SECTIONS[section];
  return (
    <Dialog open={settings !== null} onOpenChange={(open) => !open && closeSettings()} label="Settings" width="sections" className="h-[680px] flex-row overflow-hidden" testId="settings">
      <nav aria-label="Settings" onKeyDown={(event) => moveSection(event, section)} className="flex w-44 shrink-0 flex-col min-[960px]:w-[200px] gap-0.5 border-r border-line bg-sidebar p-2 pt-4">
        {IDS.map((id) => {
          const { name, icon: Icon } = SECTIONS[id];
          return (
            <button
              key={id}
              type="button"
              aria-current={id === section || undefined}
              data-section={id}
              data-testid={`settings-${id}`}
              onClick={() => openSettings(id)}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-150",
                id === section ? "bg-press font-medium text-ink" : "text-ink2 hover:bg-hover hover:text-ink",
              )}
            >
              <Icon className="size-4" strokeWidth={2} />
              {name}
            </button>
          );
        })}
      </nav>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <DialogClose render={<IconButton icon={X} label="Close" className="absolute top-3 right-3 z-10" />} />
        {/* Each section starts at its top. */}
        <div key={section} className="min-h-0 flex-1 overflow-y-auto px-8 pb-8" data-testid={`settings-body-${section}`}>
          <Body />
        </div>
      </div>
    </Dialog>
  );
}

/** The app and the computer it runs on, with the app's site and its privacy policy. */
function About() {
  const connection = useConnection();
  return (
    <>
      <SectionTitle>About</SectionTitle>
      <dl className="divide-y divide-line rounded-lg bg-canvas text-sm shadow-control">
        <Fact label="App">Sidebots</Fact>
        <Fact label="Version">{window.desktop.version}</Fact>
        <Fact label="Computer">{connection.phase === "ready" ? connection.machine : "Your computer"}</Fact>
      </dl>
      <div className="mt-4 flex flex-col divide-y divide-line rounded-lg bg-canvas shadow-control">
        <Link href={SITE}>sidebots.app</Link>
        <Link href={PRIVACY}>Privacy</Link>
      </div>
    </>
  );
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex h-10 items-center justify-between gap-4 px-3.5">
      <dt className="text-ink2">{label}</dt>
      <dd data-selectable className="truncate font-medium">
        {children}
      </dd>
    </div>
  );
}

/** A web address that opens in the system browser. */
function Link({ href, children }: { href: string; children: string }) {
  return (
    <button
      type="button"
      onClick={() => void window.desktop.openExternal(href)}
      className="flex h-10 items-center justify-between px-3.5 text-left text-sm text-tint-ink transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-hover active:bg-press"
    >
      {children}
      <ArrowUpRight aria-hidden className="size-4 text-ink3" strokeWidth={2} />
    </button>
  );
}
