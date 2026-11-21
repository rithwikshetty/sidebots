import { Tooltip as Base } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { Kbd } from "./Kbd.tsx";

/** Lets tooltips that open one after another show without the wait. The window's root holds it. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Base.Provider delay={500} closeDelay={0}>
      {children}
    </Base.Provider>
  );
}

/**
 * A few words about the element it wraps, shown as the pointer rests on it
 * or the keyboard reaches it, with the shortcut that does the same when there
 * is one. `children` is one element that takes a ref and its props, such as a
 * button.
 */
export function Tooltip({ label, shortcut, side = "bottom", children }: { label: string; shortcut?: string[]; side?: "top" | "bottom" | "left" | "right"; children: ReactElement }) {
  return (
    <Base.Root>
      <Base.Trigger render={children} />
      <Base.Portal>
        <Base.Positioner side={side} sideOffset={6} className="z-[60]">
          <Base.Popup
            data-floating
            className="flex origin-(--transform-origin) items-center gap-2 rounded-sm bg-tooltip px-2 py-1 text-xs has-[kbd]:pr-1 font-medium text-on-tooltip shadow-menu transition-[opacity,scale] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            <span>{label}</span>
            {shortcut ? <Kbd keys={shortcut} inverted /> : null}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
