import { Toast } from "@base-ui/react/toast";
import { CircleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

const manager = Toast.createToastManager();

/**
 * Shows a short message at the bottom right of the window, as when a message
 * wasn't sent. A `problem` stays a little longer, with the danger colour's
 * mark, and is read out at once to a screen reader.
 */
export function showToast({ title, description, problem = false }: { title: string; description?: string; problem?: boolean }): void {
  manager.add({ title, description, type: problem ? "problem" : undefined, priority: problem ? "high" : "low", timeout: problem ? 7000 : 4000 });
}

/** Where the window's toasts show. Everything that raises one sits inside it. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={manager} limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport data-floating className="fixed right-4 bottom-4 z-50 w-[340px] outline-none">
          <Toasts />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function Toasts() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      data-testid="toast"
      className="absolute right-0 bottom-0 w-full origin-bottom rounded-lg bg-raised text-ink shadow-menu select-none [--gap:8px] [--offset:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--gap)*-1)] [transform:translateY(calc(var(--toast-index)*-6px))_scale(calc(1-var(--toast-index)*0.04))] [transition:transform_200ms_var(--ease-out),opacity_200ms_var(--ease-out)] data-ending-style:opacity-0 data-expanded:[transform:translateY(var(--offset))] data-limited:opacity-0 data-starting-style:[transform:translateY(12px)] data-starting-style:opacity-0 [&[data-ending-style]:not([data-swipe-direction])]:[transform:translateY(12px)]"
    >
      <Toast.Content className="flex items-start gap-2.5 py-2.5 pr-2.5 pl-3 transition-opacity duration-200 data-behind:opacity-0 data-expanded:opacity-100">
        {toast.type === "problem" ? <CircleAlert aria-hidden className="mt-px size-4 shrink-0 text-danger" strokeWidth={2.25} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Toast.Title className="text-sm font-semibold" />
          <Toast.Description className="text-sm text-ink2" />
        </div>
        <Toast.Close aria-label="Dismiss" className="-my-0.5 grid size-6 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-hover hover:text-ink active:bg-press">
          <X className="size-3.5" strokeWidth={2.25} />
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}
