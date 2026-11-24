import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useRef, useSyncExternalStore } from "react";
import { Button } from "./Button.tsx";
import { BACKDROP, CARD, VIEWPORT, WIDTH } from "./Dialog.tsx";

/** What a confirm dialog asks: its question, what it means, the word on the button that goes ahead, and whether going ahead can't be undone. */
export type Asked = { title: string; message: string; action: string; destructive?: boolean };

type Open = Asked & { answer: (yes: boolean) => void };

let asking: Open | null = null;
const listeners = new Set<() => void>();

function show(next: Open | null): void {
  asking = next;
  listeners.forEach((listener) => listener());
}

/** Calls `listener` when a confirm dialog opens or closes. Returns a function that stops it. */
export function onConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a confirm dialog is open over the window. */
export function confirming(): boolean {
  return asking !== null;
}

/**
 * Asks the person before going ahead, in a dialog over the window, and
 * resolves to whether they said yes. Cancel, Esc and a click outside are no.
 * A question asked while another is open answers that one no.
 */
export function confirm(asked: Asked): Promise<boolean> {
  asking?.answer(false);
  return new Promise((resolve) => {
    const open: Open = {
      ...asked,
      answer(yes) {
        if (asking === open) show(null);
        resolve(yes);
      },
    };
    show(open);
  });
}

/** Where `confirm` asks. The window's root holds it once. */
export function ConfirmDialog() {
  const open = useSyncExternalStore(onConfirm, () => asking);
  // The words stay while the dialog fades out.
  const shown = useRef<Asked | null>(null);
  if (open) shown.current = open;
  const words = shown.current;
  return (
    <AlertDialog.Root open={open !== null} onOpenChange={(next) => !next && open?.answer(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop data-floating className={BACKDROP} />
        <AlertDialog.Viewport className={VIEWPORT}>
          <AlertDialog.Popup data-floating data-testid="confirm" className={`${CARD} ${WIDTH.question} gap-1.5 p-5`}>
            <AlertDialog.Title className="wrap-break-word text-base font-semibold">{words?.title}</AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-ink2">{words?.message}</AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Close render={<Button>Cancel</Button>} />
              <Button variant={words?.destructive ? "danger" : "primary"} onClick={() => open?.answer(true)}>
                {words?.action}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
