import { useEffect, type CSSProperties, type KeyboardEvent } from "react";
import { PanelLeft, X } from "lucide-react";
import { Chat } from "../chat/Chat.tsx";
import { cn } from "../lib/cn.ts";
import { useAgent, useAgents, useAvatars, useBehind, useChatColor } from "../lib/store.ts";
import {
  CHAT_LEAST,
  PANEL,
  SIDEBAR,
  closeChat,
  closePanel,
  columns,
  openLastChat,
  openNewAgent,
  openSettings,
  setPanelWidth,
  setSidebarWidth,
  toggleSidebar,
  useOpenChat,
  usePanel,
  usePanelWidth,
  useSidebar,
  type PanelView,
} from "../lib/view.ts";
import { SYSTEM_BUTTONS, mac, shortcut, useFullScreen, useWindowWidth } from "../lib/window.ts";
import { Panel, PanelActions, PanelTitle } from "../panel/Panel.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Resizer } from "./Resizer.tsx";
import { Mascot } from "./Screens.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ColumnProvider, TopBar } from "./TopBar.tsx";

// What a column's top bar keeps at its ends when nothing of the system's sits there.
const PAD = 12;

const clamp = (value: number, least: number, most: number) => Math.min(Math.max(value, least), Math.max(most, least));

/**
 * The window once the app is ready: the sidebar at the left, the open chat in
 * the middle, and the panel beside the chat while it shows something. It opens on
 * the chat it last showed. Each
 * column's top bar keeps clear of the system's own buttons: a Mac's traffic
 * lights over the leftmost column, unless the window fills the screen, and
 * Windows' buttons over the rightmost. The sidebar can be dragged wider or
 * narrower, and collapsed, when the chat's top bar brings it back. The panel
 * can be dragged wider too. The chat always keeps room to be read; where the
 * window has too little beside it for the panel, the panel lies over the chat
 * as a sheet from the right.
 */
export function Frame() {
  const width = useWindowWidth();
  const sidebar = useSidebar();
  const panel = usePanel();
  const keptPanelWidth = usePanelWidth();
  const chat = useOpenChat();
  const fullScreen = useFullScreen();
  const agents = useAgents();
  useClosesGoneChat(chat?.agentId);
  // The window opens on the chat it last showed.
  useEffect(() => {
    if (!chat) openLastChat(agents.map((agent) => agent.id));
  }, [chat, agents]);

  const lights = mac && !fullScreen ? SYSTEM_BUTTONS.mac : PAD;
  const buttons = mac ? PAD : SYSTEM_BUTTONS.windows;
  const { sidebarWidth, room, sheet } = columns(width, sidebar);
  const sidebarShown = sidebar.collapsed ? 0 : sidebarWidth;
  const panelMost = sheet ? width * PANEL.share : Math.min(width * PANEL.share, room);
  const panelWidth = clamp(keptPanelWidth, PANEL.least, panelMost);
  const beside = panel !== null && !sheet;

  const toggle = <IconButton icon={PanelLeft} label={sidebar.collapsed ? "Show sidebar" : "Hide sidebar"} shortcut={shortcut("B")} onClick={toggleSidebar} data-testid="toggle-sidebar" />;

  return (
    <div className="flex h-full">
      <div data-column className="relative h-full shrink-0 transition-[width] duration-200 ease-out" style={{ width: sidebarShown }}>
        <div className="h-full overflow-hidden">
          <div className="h-full" style={{ width: sidebarWidth }} inert={sidebar.collapsed}>
            <ColumnProvider value={{ start: lights, end: PAD, lead: toggle }}>
              <Sidebar />
            </ColumnProvider>
          </div>
        </div>
        {sidebar.collapsed ? null : (
          <Resizer side="right" label="Sidebar width" width={sidebarWidth} least={SIDEBAR.least} most={Math.min(SIDEBAR.most, width - CHAT_LEAST)} initial={SIDEBAR.initial} onResize={setSidebarWidth} />
        )}
      </div>
      <main
        data-testid="chat-column"
        style={useChatTint(chat?.agentId)}
        className={cn("relative h-full min-w-0 flex-1 bg-canvas", !sidebar.collapsed && "border-l border-line")}
      >
        <ColumnProvider value={{ start: sidebar.collapsed ? lights : PAD, end: beside ? PAD : buttons, lead: sidebar.collapsed ? toggle : undefined }}>
          {chat ? <Chat key={chat.agentId} agentId={chat.agentId} /> : <NoChat />}
        </ColumnProvider>
        {panel && sheet ? <div aria-hidden onClick={closePanel} className="absolute inset-0 z-20 animate-fade-in bg-scrim" /> : null}
      </main>
      {panel ? <PanelColumn view={panel} width={panelWidth} most={panelMost} sheet={sheet} end={buttons} /> : null}
    </div>
  );
}

/** The panel's column: its top bar, with its title, the buttons for what can be done with what it shows and one that closes it, and what it shows. Esc closes it while focus is inside it. */
function PanelColumn({ view, width, most, sheet, end }: { view: PanelView; width: number; most: number; sheet: boolean; end: number }) {
  const close = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    closePanel();
  };
  return (
    <aside
      data-testid="panel"
      data-column
      aria-label="Panel"
      onKeyDown={close}
      style={{ ...useChatTint(view.agentId), width }}
      className={cn("relative flex h-full shrink-0 flex-col border-l border-line bg-canvas", sheet && "fixed inset-y-0 right-0 z-30 animate-sheet-in shadow-sheet")}
    >
      <Resizer side="left" label="Panel width" width={width} least={PANEL.least} most={most} initial={PANEL.initial} onResize={setPanelWidth} />
      <ColumnProvider value={{ start: 16, end }}>
        <TopBar>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="panel-title">
            <PanelTitle view={view} />
          </h2>
          <PanelActions view={view} />
          <IconButton icon={X} label="Close" shortcut={["Esc"]} onClick={closePanel} data-testid="close-panel" />
        </TopBar>
      </ColumnProvider>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Panel view={view} />
      </div>
    </aside>
  );
}

/** The chat's side with no chat open: it asks for an agent once there are agents to choose from, and points at the first one when there are none, with the way to pair a phone beside it. */
function NoChat() {
  const agents = useAgents();
  const behind = useBehind();
  const loaded = useAvatars().length > 0;
  return (
    <section className="flex h-full flex-col" data-testid="no-chat">
      <TopBar />
      <div className="flex flex-1 items-center justify-center pb-13">
        {behind ? null : agents.length > 0 ? (
          <p className="text-sm text-ink2">Choose an agent to chat with.</p>
        ) : loaded ? (
          <EmptyState title="No agents yet" note="Click + to make one, then tell it what it's for." art={<Mascot state="resting" />}>
            <Button variant="primary" onClick={openNewAgent}>
              New agent
            </Button>
            <Button variant="ghost" onClick={() => openSettings("phones")}>
              Pair a phone
            </Button>
          </EmptyState>
        ) : null}
      </div>
    </section>
  );
}

/** The colour of an agent's chat, for what is inside an element to take as `chat`. */
function useChatTint(agentId: string | undefined): CSSProperties | undefined {
  const color = useChatColor(useAgent(agentId ?? ""));
  return color ? ({ "--chat": color } as CSSProperties) : undefined;
}

/** Closes the chat once its agent is gone, as when it was deleted here or on another device. */
function useClosesGoneChat(agentId: string | undefined): void {
  const agent = useAgent(agentId ?? "");
  const loaded = useAvatars().length > 0;
  useEffect(() => {
    if (agentId && loaded && !agent) closeChat();
  }, [agentId, agent, loaded]);
}
