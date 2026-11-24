import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../lib/cn.ts";

// How far an arrow key moves the edge, in pixels.
const STEP = 16;

/**
 * The edge of a column that sets its width when dragged, on the column's
 * `side`. A double-click puts the width back to `initial`, and the arrow keys
 * move it once it has focus. `onResize` hears each width as it changes, with
 * `done` once the drag ends, as the person lets go or the pointer is taken
 * from the edge.
 */
export function Resizer({
  side,
  width,
  least,
  most,
  initial,
  label,
  onResize,
  className,
}: {
  side: "left" | "right";
  width: number;
  least: number;
  most: number;
  initial: number;
  label: string;
  onResize: (width: number, done: boolean) => void;
  className?: string;
}) {
  const clamp = (value: number) => Math.round(Math.min(Math.max(value, least), Math.max(most, least)));

  // A drag, from the press on the edge: where the pointer was, the width the column had, and the width the drag has reached.
  const drag = useRef<{ from: number; width: number; reached: number } | null>(null);

  function press(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { from: event.clientX, width, reached: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  // The width the drag reaches with the pointer where `event` has it, while the edge has the pointer, kept as the width the drag ends on.
  function reach(event: PointerEvent<HTMLDivElement>): number | undefined {
    const going = drag.current;
    if (!going || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    return (going.reached = clamp(going.width + (side === "right" ? event.clientX - going.from : going.from - event.clientX)));
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const reached = reach(event);
    if (reached !== undefined) onResize(reached, false);
  }

  // The edge loses the pointer when the button is let go, or when the system takes it with the button still down.
  function end() {
    const ended = drag.current;
    if (!ended) return;
    drag.current = null;
    delete document.documentElement.dataset.resizing;
    onResize(ended.reached, true);
  }

  function key(event: KeyboardEvent<HTMLDivElement>) {
    const toward = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!toward) return;
    event.preventDefault();
    onResize(clamp(width + toward * STEP * (side === "right" ? 1 : -1)), true);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={least}
      aria-valuemax={most}
      tabIndex={0}
      onPointerDown={press}
      onGotPointerCapture={() => (document.documentElement.dataset.resizing = "")}
      onPointerMove={move}
      onPointerUp={reach}
      onLostPointerCapture={end}
      onDoubleClick={() => onResize(clamp(initial), true)}
      onKeyDown={key}
      className={cn(
        "group absolute inset-y-0 z-20 w-2 cursor-col-resize outline-none",
        side === "right" ? "-right-1" : "-left-1",
        className,
      )}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-line-strong group-focus-visible:bg-tint-ink group-active:bg-tint-ink" />
    </div>
  );
}
