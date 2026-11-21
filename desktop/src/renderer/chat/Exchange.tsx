import { ChevronRight } from "lucide-react";
import type { Message } from "@server/contract.ts";
import type { Standing } from "@client/exchanges.ts";
import { cn } from "../lib/cn.ts";
import { useAgent } from "../lib/store.ts";
import { openPanel } from "../lib/view.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { FlowDots } from "./WorkingLine.tsx";

/**
 * An exchange between two of the person's agents, as one line in both their
 * chats: the two avatars, who asked whom last, and where that stands. A click
 * opens the exchange to read in the panel. While it waits for the answer, the
 * specks of the line between the avatars light in turn, from the asker to the
 * other, and they rest while it needs the person's OK. `asked` is the newest
 * thing asked in it, and `agentId` the chat it is shown in. It flashes when
 * the chat was opened at it.
 */
export function ExchangeRow({ agentId, asked, state, flashing }: { agentId: string; asked: Message; state: Standing; flashing: boolean }) {
  const from = useAgent(asked.agent_id);
  const to = useAgent(asked.peer_id ?? "");
  if (!from || !to) return null;
  const loud = state === "Needs your OK";
  return (
    <div className={cn("mt-2.5 flex rounded-md", flashing && "animate-flash")} data-message-id={asked.id}>
      <button
        type="button"
        onClick={() => openPanel({ kind: "exchange", agentId, messageId: asked.id })}
        aria-label={`${from.name} asked ${to.name}. ${state}`}
        data-testid={`exchange-${asked.id}`}
        data-state={state}
        className="group -ml-1.5 flex max-w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-1.5 pl-1.5 text-sm text-ink2 transition-colors hover:bg-hover active:bg-press"
      >
        <Avatar avatarId={from.avatar_id} state="resting" size={20} />
        <FlowDots count={4} size={2} running={state === "Waiting"} className={cn("w-5", state === "Waiting" ? "text-ink2" : "text-ink3")} />
        <Avatar avatarId={to.avatar_id} state="resting" size={20} />
        <span className="ml-0.5 min-w-0 truncate">
          <span className="font-semibold text-ink">{from.name}</span> asked <span className="font-semibold text-ink">{to.name}</span> ·{" "}
          <span key={state} className={cn("animate-fade-in", loud && "font-semibold text-ink")}>
            {state}
          </span>
        </span>
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-ink3 transition-transform duration-150 group-hover:translate-x-0.5" strokeWidth={2.25} />
      </button>
    </div>
  );
}
