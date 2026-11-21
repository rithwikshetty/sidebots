import { ContextMenu as BaseContext } from "@base-ui/react/context-menu";
import { Menu as Base } from "@base-ui/react/menu";
import type { ComponentType, KeyboardEvent, ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Kbd } from "./Kbd.tsx";

/** One thing a menu does: its words, its icon, and what it does once chosen, with a `note` under its words when it needs saying what it does. A `danger` one can't be undone. A line between groups is `"separator"`. */
export type MenuEntry = { label: string; note?: string; icon?: ComponentType<{ className?: string; strokeWidth?: number }>; onSelect: () => void; danger?: boolean; shortcut?: string[] } | "separator";

const POPUP =
  "min-w-44 origin-(--transform-origin) rounded-lg bg-raised p-1 text-ink shadow-menu outline-none transition-[opacity,scale] duration-150 ease-out data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0";
const ITEM =
  "flex h-7 items-center gap-2 rounded-sm px-2 text-sm outline-none select-none data-highlighted:bg-tint data-highlighted:text-on-tint [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink2 data-highlighted:[&_svg]:text-on-tint";

/** The entries of a menu, which a context menu draws with the same parts. */
function Entries({ entries }: { entries: MenuEntry[] }) {
  return entries.map((entry, index) =>
    entry === "separator" ? (
      <Base.Separator key={`separator-${index}`} className="mx-2 my-1 h-px bg-line" />
    ) : (
      <Base.Item
        key={entry.label}
        // What was chosen happens once the menu has let focus go, so focus it moves, as Reply moves it to the message field, stays there.
        onClick={() => requestAnimationFrame(entry.onSelect)}
        className={cn(ITEM, entry.note && "group/entry h-auto max-w-72 items-start py-1.5 [&_svg]:mt-px", entry.danger && "text-danger [&_svg]:text-danger data-highlighted:bg-danger")}
      >
        {entry.icon ? <entry.icon strokeWidth={2} /> : null}
        {entry.note ? (
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span>{entry.label}</span>
            <span className="text-xs text-ink2 group-data-highlighted/entry:text-on-tint/80">{entry.note}</span>
          </span>
        ) : (
          <span className="flex-1 truncate">{entry.label}</span>
        )}
        {entry.shortcut ? <Kbd keys={entry.shortcut} className="ml-4" /> : null}
      </Base.Item>
    ),
  );
}

/** A menu that opens from `trigger`, a button, below it. Arrow keys move through it, Enter chooses, and Esc closes it. */
export function Menu({ trigger, entries, align = "start" }: { trigger: ReactElement; entries: MenuEntry[]; align?: "start" | "center" | "end" }) {
  return (
    <Base.Root>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner align={align} sideOffset={4} className="z-50 outline-none">
          <Base.Popup data-floating className={POPUP}>
            <Entries entries={entries} />
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

/** Opens a context menu from the keyboard, with the menu key or Shift+F10, at the element that has focus, as a right-click on it would. The innermost menu around the element is the one that opens. */
function openFromKeyboard(event: KeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey))) return;
  event.preventDefault();
  const at = event.target as HTMLElement;
  const box = at.getBoundingClientRect();
  at.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + Math.min(16, box.width / 2), clientY: box.top + Math.min(box.height, 24) }));
}

/** A menu that opens where the person right-clicks inside `children`, or, on the element that has focus inside it, from the keyboard's menu key or Shift+F10. */
export function ContextMenu({ entries, children, className }: { entries: MenuEntry[]; children: ReactNode; className?: string }) {
  return (
    <BaseContext.Root>
      <BaseContext.Trigger className={className} onKeyDown={openFromKeyboard}>
        {children}
      </BaseContext.Trigger>
      <BaseContext.Portal>
        <BaseContext.Positioner className="z-50 outline-none">
          <BaseContext.Popup data-floating className={POPUP}>
            <Entries entries={entries} />
          </BaseContext.Popup>
        </BaseContext.Positioner>
      </BaseContext.Portal>
    </BaseContext.Root>
  );
}
