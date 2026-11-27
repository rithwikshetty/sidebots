import type { ComponentProps, ComponentType } from "react";
import { cn } from "../lib/cn.ts";

/** What a field for text looks like: raised, and ringed in the app's colour while it has focus. */
const FIELD = cn(
  "rounded-md bg-raised px-2.5 text-sm text-ink shadow-control outline-none transition-shadow duration-150 placeholder:text-ink3",
  "focus:shadow-[0_0_0_1px_var(--tint-ink),0_0_0_3.5px_color-mix(in_srgb,var(--tint-ink)_22%,transparent)]",
  "disabled:opacity-45 aria-invalid:shadow-[0_0_0_1px_var(--danger)]",
);

/**
 * A field for a line of text. Its border takes the app's colour while it has
 * focus. An `icon` sits at its start, as a magnifier in a search field.
 */
export function Input({ icon: Icon, className, ...props }: ComponentProps<"input"> & { icon?: ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }> }) {
  return (
    <span className={cn("relative flex h-8 items-center", className)}>
      {Icon ? <Icon aria-hidden className="pointer-events-none absolute left-2.5 size-4 text-ink3" strokeWidth={2} /> : null}
      <input
        className={cn("h-full w-full min-w-0", FIELD, Icon && "pl-8")}
        {...props}
      />
    </span>
  );
}

/** A field for text of several lines, as Input is for one, which the person can make taller. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn("min-h-24 resize-y py-2", FIELD, className)} {...props} />;
}
