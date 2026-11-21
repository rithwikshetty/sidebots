import { cn } from "../lib/cn.ts";
import { useWorkingLine } from "../lib/lines.ts";

// How far apart the dots of a row light.
const STEP_MS = 180;

/**
 * A row of `count` dots, in the colour of the text around them, that say
 * something is under way. While `running` they light in turn, and otherwise
 * they rest at their full colour. `size` is a dot's width in pixels.
 */
export function FlowDots({ count, running = true, size, className }: { count: number; running?: boolean; size: number; className?: string }) {
  return (
    <span aria-hidden className={cn("flex items-center justify-between", className)}>
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={cn("shrink-0 rounded-full bg-current", running && "animate-flow")}
          style={{ width: size, height: size, animationDelay: running ? `${index * STEP_MS}ms` : undefined }}
        />
      ))}
    </span>
  );
}

/** Under the chat while the agent works: three dots that light in turn, and a playful line that changes every few seconds. */
export function WorkingLine() {
  const line = useWorkingLine();
  return (
    <div role="status" data-testid="working-line" className="mt-2.5 flex animate-fade-in items-center gap-2 pl-1 text-ink2">
      <FlowDots count={3} size={4} className="gap-1" />
      <span key={line} className="animate-fade-in text-message italic">
        {line}
      </span>
    </div>
  );
}
