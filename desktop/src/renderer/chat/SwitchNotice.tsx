import { PROVIDERS, selectionWords, type Message, type Selection } from "@server/contract.ts";
import { cn } from "../lib/cn.ts";
import { BrandLogo } from "../ui/BrandLogo.tsx";
import { FlowDots } from "./WorkingLine.tsx";

/**
 * The notice that the agent answers with something else from here on, as a
 * line across the chat: what it answered with before, faded, a row of dots,
 * and what it answers with now. Each side is the parts that changed. An
 * agent that moved to another provider shows all of both, each after its
 * provider's logo, and while it hands over to the new one the dots light in
 * turn.
 */
export function SwitchNotice({ message, className }: { message: Message & { switched: NonNullable<Message["switched"]> }; className?: string }) {
  const { from, to } = message.switched;
  return (
    <div data-message-id={message.id} data-testid="notice" data-status={message.status} role="note" aria-label={message.body} className={cn("mt-3 mb-1.5 flex items-center gap-3 text-sm", className)}>
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span aria-hidden className="flex min-w-0 items-center gap-2.5">
        <Side selection={from} other={to} className="text-ink3" />
        <FlowDots count={3} size={3} running={message.status === "running"} className="gap-1 text-ink3" />
        <Side selection={to} other={from} className="font-medium text-ink2" />
      </span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

/** One side of the change: the parts of `selection` that differ from `other`, after its provider's logo when the two are on different providers. */
function Side({ selection, other, className }: { selection: Selection; other: Selection; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {selection.provider === other.provider ? null : <BrandLogo logo={PROVIDERS[selection.provider].logo} size={14} />}
      <span className="truncate">{selectionWords(selection, other).join(" · ")}</span>
    </span>
  );
}
