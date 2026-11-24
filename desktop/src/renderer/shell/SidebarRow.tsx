import type { CSSProperties, ReactNode } from "react";
import { Bell, BellOff, Ellipsis, Eye, EyeOff, Trash2 } from "lucide-react";
import { avatarStateOf, type AgentWithLatest, type Found } from "@server/contract.ts";
import { foundLine, preview } from "@client/messages.ts";
import { listTime } from "@client/time.ts";
import { changeOrSay, confirmDelete } from "../lib/alerts.ts";
import { cn } from "../lib/cn.ts";
import { useWorkingLine } from "../lib/lines.ts";
import { useAgent, useChatColor } from "../lib/store.ts";
import { useToday } from "../lib/window.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { IconButton } from "../ui/Button.tsx";
import { ContextMenu, Menu, type MenuEntry } from "../ui/Menu.tsx";


/** What every row of the sidebar shares: its height, its corners, and how it answers the pointer. */
export const ROW = "flex min-h-14 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-150 ease-out";

/**
 * An agent as a row of the sidebar, which opens its chat. A `selected` row
 * is the chat that is open, washed in the agent's colour, where what reads
 * second takes the ink that reads on the wash. A right-click on
 * it, or the button that shows as the pointer rests on it, offers what can
 * be done to it: mute, hide and delete.
 */
export function AgentRow({ agent, online, selected, onOpen }: { agent: AgentWithLatest; online: boolean; selected: boolean; onOpen: () => void }) {
  const color = useChatColor(agent);
  const entries = agentActions(agent);
  return (
    <ContextMenu entries={entries} className="group/row relative block px-2">
      <button
        type="button"
        data-row
        data-testid={`agent-${agent.id}`}
        aria-current={selected || undefined}
        onClick={onOpen}
        style={color ? ({ "--chat": color } as CSSProperties) : undefined}
        className={cn(ROW, selected ? "bg-chat-wash [--ink2:var(--ink2-wash)]" : "hover:bg-hover active:bg-press", "focus-visible:-outline-offset-2")}
      >
        <RowBody agent={agent} online={online} />
      </button>
      <div className="absolute top-2 right-3.5 opacity-0 transition-opacity duration-150 group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100 has-[[data-popup-open]]:opacity-100">
        <Menu align="end" entries={entries} trigger={<IconButton icon={Ellipsis} label={`More for ${agent.name}`} size="sm" />} />
      </div>
    </ContextMenu>
  );
}

/** What can be done to an agent from its row and its chat's menu. Mute stops its notifications. Hide takes it off the list until it next has something to say. Delete asks first. */
export function agentActions(agent: AgentWithLatest): MenuEntry[] {
  return [
    { label: agent.muted ? "Unmute" : "Mute", icon: agent.muted ? Bell : BellOff, onSelect: () => changeOrSay(agent.id, { muted: !agent.muted }) },
    { label: agent.hidden ? "Unhide" : "Hide", icon: agent.hidden ? Eye : EyeOff, onSelect: () => changeOrSay(agent.id, { hidden: !agent.hidden }) },
    "separator",
    { label: "Delete agent…", icon: Trash2, danger: true, onSelect: () => void confirmDelete(agent) },
  ];
}

/**
 * What a row shows of an agent: its avatar acting out how it is, its name,
 * whether it is muted, when its latest message came, a line of what it is up
 * to, and how many of its messages wait to be read. With `found`, the row
 * shows that message from its chat in place of the latest one, starting a
 * little before the words that matched `search`.
 */
export function RowBody({ agent, online, found, search = "" }: { agent: AgentWithLatest; online: boolean; found?: Found; search?: string }) {
  const state = found ? "resting" : avatarStateOf(agent);
  const working = online && state === "working";
  const line = useWorkingLine(working);
  // The agent it asked something and hasn't heard back from.
  const waitingOn = useAgent(agent.waiting_on ?? "");
  const unread = !found && agent.unread > 0;
  const today = useToday();
  const said = found ? foundLine(found, search) : working ? line : waitingOn && online ? `Waiting on ${waitingOn.name}` : agent.latest ? preview(agent.latest) : "Say hello";
  return (
    <>
      <Avatar avatarId={agent.avatar_id} state={online ? state : "resting"} size={32} dimmed={!online} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="truncate text-sm font-semibold text-ink">{agent.name}</span>
            {agent.muted ? <BellOff role="img" aria-label="Muted" className="size-3 shrink-0 text-ink2" strokeWidth={2.25} /> : null}
          </span>
          <Time className="transition-opacity duration-150 group-has-[:focus-visible]/row:opacity-0 group-hover/row:opacity-0 group-has-[[data-popup-open]]/row:opacity-0">
            {listTime((found ?? agent.latest)?.created_at ?? agent.created_at, today)}
          </Time>
        </span>
        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "text-ink" : "text-ink2", working && "italic")}>{said}</span>
          {unread ? (
            <span
              aria-label={`${agent.unread} unread`}
              className={cn("grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1.5 text-2xs font-semibold text-on-tint tabular-nums", agent.muted ? "bg-muted" : "bg-tint")}
            >
              {agent.unread > 99 ? "99+" : agent.unread}
            </span>
          ) : null}
        </span>
      </span>
    </>
  );
}

function Time({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("shrink-0 text-xs text-ink2 tabular-nums", className)}>{children}</span>;
}
