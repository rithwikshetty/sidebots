import { BellOff, Ellipsis, Sparkles } from "lucide-react";
import { avatarStateOf, type AgentWithLatest } from "@server/contract.ts";
import { problem } from "../lib/alerts.ts";
import { cn } from "../lib/cn.ts";
import { freshStart, useOnline } from "../lib/store.ts";
import { openPanel } from "../lib/view.ts";
import { agentActions } from "../shell/SidebarRow.tsx";
import { TopBar } from "../shell/TopBar.tsx";
import { Avatar } from "../ui/Avatar.tsx";
import { IconButton } from "../ui/Button.tsx";
import { Menu } from "../ui/Menu.tsx";

/**
 * The top of a chat: the agent's avatar acting out how it is, and its name,
 * which open the agent in the panel, and a menu of what can be done to it:
 * a fresh start, mute, hide and delete. It lies over the messages, which
 * show a line under it once they have scrolled under it.
 */
export function ChatBar({ agent, scrolled }: { agent: AgentWithLatest; scrolled: boolean }) {
  const online = useOnline();
  const state = avatarStateOf(agent);
  return (
    <TopBar className={cn("absolute inset-x-0 top-0 z-10 border-b border-transparent bg-canvas transition-colors duration-150", scrolled && "border-line")}>
      <button
        type="button"
        onClick={() => openPanel({ kind: "agent", agentId: agent.id })}
        aria-label={`About ${agent.name}`}
        className="-ml-1 flex h-9 min-w-0 items-center gap-2 rounded-md pr-2 pl-1 transition-colors hover:bg-hover active:bg-press"
        data-testid="chat-agent"
      >
        <Avatar avatarId={agent.avatar_id} state={online ? (state === "replied" ? "resting" : state) : "resting"} size={32} dimmed={!online} />
        <h1 className="truncate text-sm font-semibold" data-testid="chat-name">
          {agent.name}
        </h1>
        {agent.muted ? <BellOff role="img" aria-label="Muted" className="size-3 shrink-0 text-ink3" strokeWidth={2.25} /> : null}
      </button>
      <div className="flex-1" />
      <Menu
        align="end"
        trigger={<IconButton icon={Ellipsis} label="Chat menu" data-testid="chat-menu" />}
        entries={[
          {
            label: "Fresh start",
            note: "Clears what the agent has in mind. Your chat and its memory stay.",
            icon: Sparkles,
            onSelect: () => void freshStart(agent.id).catch((failure) => problem("Couldn't start fresh", failure)),
          },
          "separator",
          ...agentActions(agent),
        ]}
      />
    </TopBar>
  );
}
