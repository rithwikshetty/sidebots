import { Dialog as Base } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./Button.tsx";

/** What dims the window behind a dialog, and how a dialog's card rises into place and back. Shared with the confirm dialog. A card keeps a top bar's height clear above and below it, so it never sits under the system's own buttons. */
export const BACKDROP = "fixed inset-0 z-40 bg-scrim transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0";
export const CARD =
  "fixed top-1/2 left-1/2 z-40 flex max-h-[calc(100vh-104px)] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-raised text-ink shadow-dialog outline-none transition-[opacity,scale] duration-200 ease-out data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0";

/**
 * A card over the window that holds the person's attention until they close
 * it, with Esc, a click outside, or a button inside. Focus stays inside it
 * while it is open and goes back where it was once it closes. `initialFocus`
 * is what takes focus as it opens, when that isn't its first control. The
 * card's look and size are `className`'s, and `label` names it when it has
 * no `DialogHeader`.
 */
export function Dialog({
  open,
  onOpenChange,
  initialFocus,
  label,
  className,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFocus?: RefObject<HTMLElement | null>;
  label?: string;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <Base.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Base.Portal>
        <Base.Backdrop data-floating className={BACKDROP} />
        <Base.Popup data-floating data-testid={testId} aria-label={label} initialFocus={initialFocus} className={cn(CARD, "w-[440px]", className)}>
          {children}
        </Base.Popup>
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
