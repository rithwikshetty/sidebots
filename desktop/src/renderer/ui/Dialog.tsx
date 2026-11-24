import { Dialog as Base } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./Button.tsx";

/** What dims the window behind a dialog, and how a dialog's card rises into place and back. Shared with the confirm dialog. */
export const BACKDROP = "fixed inset-0 z-40 bg-scrim transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0";
export const CARD =
  "row-start-2 flex max-h-full max-w-full flex-col rounded-xl bg-raised text-ink shadow-dialog outline-none transition-[opacity,scale] duration-200 ease-out data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0";
/** A card sits in the middle of the window. In a window too small for it, it shrinks to fit, with a top bar's height clear above it, so it never sits under the system's own buttons, and a margin at the window's other edges. */
export const VIEWPORT = "fixed inset-0 z-40 grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(52px,1fr)_minmax(0,auto)_minmax(24px,1fr)] justify-items-center px-6";
/** How wide a card is, by what it holds: a question and its two buttons, a short form, or a list of sections with the open one beside it. */
export const WIDTH = { question: "w-[320px]", form: "w-[400px]", sections: "w-[880px]" };

/**
 * A card over the window that holds the person's attention until they close
 * it, with Esc, a click outside, or a button inside. Focus stays inside it
 * while it is open and goes back where it was once it closes. `initialFocus`
 * is what takes focus as it opens, when that isn't its first control. `width`
 * is how wide the card is, by what it holds, `className` is the rest of its
 * look, and `label` names it when it has no `DialogHeader`.
 */
export function Dialog({
  open,
  onOpenChange,
  initialFocus,
  label,
  width = "form",
  className,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFocus?: RefObject<HTMLElement | null>;
  label?: string;
  width?: keyof typeof WIDTH;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <Base.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Base.Portal>
        <Base.Backdrop data-floating className={BACKDROP} />
        <Base.Viewport className={VIEWPORT}>
          <Base.Popup data-floating data-testid={testId} aria-label={label} initialFocus={initialFocus} className={cn(CARD, WIDTH[width], className)}>
            {children}
          </Base.Popup>
        </Base.Viewport>
      </Base.Portal>
    </Base.Root>
  );
}

/** A dialog's title, with the button that closes it at the right. */
export function DialogHeader({ title, className }: { title: string; className?: string }) {
  return (
    <header className={cn("flex h-13 shrink-0 items-center justify-between gap-3 pr-3 pl-5", className)}>
      <Base.Title className="truncate text-base font-semibold">{title}</Base.Title>
      <Base.Close render={<IconButton icon={X} label="Close" />} />
    </header>
  );
}

/** The buttons at the foot of a dialog, at its right, the one that goes ahead last. */
export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <footer className={cn("flex shrink-0 items-center justify-end gap-2 px-5 pt-2 pb-5", className)}>{children}</footer>;
}

/** A button that closes the dialog it is in. */
export const DialogClose = Base.Close;
