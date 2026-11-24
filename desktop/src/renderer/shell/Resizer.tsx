import type { KeyboardEvent, PointerEvent } from "react";
import { cn } from "../lib/cn.ts";

// How far an arrow key moves the edge, in pixels.
const STEP = 16;

/**
 * The edge of a column that sets its width when dragged, on the column's
 * `side`. A double-click puts the width back to `initial`, and the arrow keys
 * move it once it has focus. `onResize` hears each width as it changes, with
 * `done` once the drag ends, as the person lets go or the pointer is taken
 * from it.
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

  function drag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const from = event.clientX;
    // Where the drag has got to, which is where it ends.
    let reached = width;
    handle.setPointerCapture(event.pointerId);
    document.documentElement.dataset.resizing = "";
    const move = (moved: globalThis.PointerEvent) => {
      reached = clamp(width + (side === "right" ? moved.clientX - from : from - moved.clientX));
      onResize(reached, false);
    };
    // The handle loses the pointer as the button is let go, and when the pointer is taken from it with the button still down, as when the system swallows the release.
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", move);
      handle.removeEventListener("lostpointercapture", end);
      delete document.documentElement.dataset.resizing;
      onResize(reached, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", move);
    handle.addEventListener("lostpointercapture", end);
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
      onPointerDown={drag}
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
