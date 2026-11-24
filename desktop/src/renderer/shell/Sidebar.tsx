import { memo, useEffect, useState, type KeyboardEvent } from "react";
import { ChevronRight, Plus, Search, Settings } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { UPDATE, useAgents, useAvatars, useBehind, useConnection, useOnline, type Behind } from "../lib/store.ts";
import { openChat, openNewAgent, openSearch, closeSearch, openSettings, useOpenChat, useSearching } from "../lib/view.ts";
import { shortcut } from "../lib/window.ts";
import { IconButton } from "../ui/Button.tsx";
import { RetryButton } from "./Screens.tsx";
import { AgentRow } from "./SidebarRow.tsx";
import { SidebarSearch } from "./SidebarSearch.tsx";
import { TopBar } from "./TopBar.tsx";

/** What the sidebar says in place of the agents when the server on this computer or this app is behind. */
const BEHIND_NOTE: Record<Behind, string> = {
  computer: "It's older than this app. Your agents show here again once it's updated.",
  app: "Sidebots on this computer is newer than this app. Your agents show here again once it's updated.",
};

/**
 * The person's agents, in a column at the left of the window. Its top bar
 * has search and a new agent. Each row opens its agent's chat, and the open
 * chat's row is marked. Hidden agents wait under a line at the list's end,
 * which a click opens, and stay open or closed as the person left them while
 * search takes the agents' place. When the server on this computer and this
 * app speak different versions of the contract, a few words saying which to
 * update take the agents' place. At its foot are the computer and whether the
 * app reaches it, and Settings, with why and Retry above them while the main
 * process can't reach the server. It draws again only for what it follows
 * itself, so dragging a column's edge draws none of its rows.
 */
export const Sidebar = memo(function Sidebar() {
  const agents = useAgents();
  const behind = useBehind();
  const searching = useSearching();
  // The avatars come with the server's first answer, so until then the app can't tell whether there are no agents.
  const empty = useAvatars().length > 0 && agents.length === 0;
  const [scrolled, setScrolled] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  // The list starts again at its top once search closes.
  useEffect(() => setScrolled(false), [searching]);

  return (
    <nav aria-label="Agents" data-testid="sidebar" className="relative flex h-full flex-col bg-sidebar">
      {/* The agents scroll under the top bar, which shows a line under it once they have. */}
      <TopBar className={cn("absolute inset-x-0 top-0 z-10 border-b border-transparent bg-sidebar transition-colors duration-150", scrolled && "border-line")}>
        <div className="flex-1" />
        {behind || empty ? null : (
          <IconButton icon={Search} label="Search" shortcut={shortcut("K")} aria-pressed={searching} onClick={searching ? closeSearch : openSearch} data-testid="search-button" />
        )}
        {behind ? null : <IconButton icon={Plus} label="New agent" shortcut={shortcut("N")} onClick={openNewAgent} data-testid="new-agent-button" />}
      </TopBar>
      {searching && !behind ? <SidebarSearch /> : <AgentList behind={behind} onScroll={setScrolled} showHidden={showHidden} onShowHidden={setShowHidden} />}
      <Foot />
    </nav>
  );
});

/** The agents as rows, the ones the person hid under a line at the end. */
function AgentList({ behind, onScroll, showHidden, onShowHidden }: { behind: Behind | null; onScroll: (scrolled: boolean) => void; showHidden: boolean; onShowHidden: (shown: boolean) => void }) {
  const agents = useAgents();
  const online = useOnline();
  const open = useOpenChat()?.agentId;
  const shown = agents.filter((agent) => !agent.hidden);
  const hidden = agents.filter((agent) => agent.hidden);
  const row = (agent: (typeof agents)[number]) => <AgentRow key={agent.id} agent={agent} online={online} selected={agent.id === open} onOpen={() => openChat(agent.id)} />;

  if (behind) {
    return (
      <div className="flex flex-1 flex-col justify-center gap-1.5 px-6 text-center">
        <h2 className="text-base font-semibold">{UPDATE[behind]}</h2>
        <p className="text-sm text-ink2">{BEHIND_NOTE[behind]}</p>
      </div>
    );
  }

  return (
    <div onScroll={(event) => onScroll(event.currentTarget.scrollTop > 0)} onKeyDown={moveFocus} className="min-h-0 flex-1 overflow-y-auto pt-13 pb-2" data-testid="agent-list">
      {shown.map(row)}
      {hidden.length ? (
        <>
          <button
            type="button"
            aria-expanded={showHidden}
            onClick={() => onShowHidden(!showHidden)}
            className="mx-2 mt-1 flex h-8 w-[calc(100%-16px)] items-center gap-1 rounded-md px-2.5 text-sm text-ink2 transition-colors hover:bg-hover hover:text-ink active:bg-press"
            data-testid="hidden-agents"
          >
            Hidden · {hidden.length}
            <ChevronRight aria-hidden className={cn("size-3.5 transition-transform duration-200 ease-out", showHidden && "rotate-90")} strokeWidth={2.25} />
          </button>
          {showHidden ? hidden.map(row) : null}
        </>
      ) : null}
    </div>
  );
}

/** Moves focus from one row to the next or the one before with the arrow keys. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  rows[Math.min(Math.max(at + (event.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1)].focus();
}

/**
 * The computer, whether the app reaches it, and Settings. While the main
 * process can't reach the server, its words for why and Retry show above
 * them, and the list above gives up the room, so no row moves.
 */
function Foot() {
  const connection = useConnection();
  const online = useOnline();
  const behind = useBehind();
  const reached = online && !behind;
  return (
    <footer className="shrink-0 border-t border-line">
      {connection.phase === "failed" ? (
        <div className="flex animate-fade-in items-center gap-2 border-b border-line py-2 pr-2.5 pl-4" data-testid="unreached">
          <p role="status" className="min-w-0 flex-1 text-xs text-pretty text-ink2">
            {connection.message}
          </p>
          <RetryButton size="sm" />
        </div>
      ) : null}
      <div className="flex h-13 items-center gap-2 pr-2.5 pl-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium" data-testid="machine">
            {connection.phase === "ready" ? connection.machine : "Your computer"}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-ink2" data-testid="reach">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full transition-colors duration-200", reached ? "bg-ok" : "bg-ink3")} />
            <span className="truncate">{behind ? UPDATE[behind] : online ? "Connected" : "Out of reach"}</span>
          </span>
        </div>
        <IconButton icon={Settings} label="Settings" shortcut={shortcut(",")} tooltipSide="top" onClick={() => openSettings()} data-testid="settings-button" />
      </div>
    </footer>
  );
}
