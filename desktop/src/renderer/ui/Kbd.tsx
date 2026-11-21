import { cn } from "../lib/cn.ts";

/** The keys of a shortcut, each in a small key cap, as `shortcut()` gives them. `inverted` sits on a tooltip's dark ground. */
export function Kbd({ keys, inverted = false, className }: { keys: string[]; inverted?: boolean; className?: string }) {
  return (
    <kbd className={cn("inline-flex items-center gap-0.5 font-sans", className)} aria-label={keys.join("+")}>
      {keys.map((key) => (
        <span
          key={key}
          aria-hidden
          className={cn(
            "inline-grid h-[18px] min-w-[18px] place-items-center rounded-xs px-1 text-2xs font-medium",
            inverted ? "bg-on-tooltip/15 text-on-tooltip/80" : "bg-field text-ink2 shadow-control",
          )}
        >
          {key}
        </span>
      ))}
    </kbd>
  );
}
