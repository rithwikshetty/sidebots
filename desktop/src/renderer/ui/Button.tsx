import type { ComponentProps, ComponentType } from "react";
import { cn } from "../lib/cn.ts";
import { Spinner } from "./Spinner.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** How a button reads: the one thing to do (`primary`), one of several (`secondary`), a quiet one (`ghost`), or one that can't be undone (`danger`). */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-tint text-on-tint hover:brightness-110 active:brightness-95",
  secondary: "bg-raised text-ink shadow-control hover:bg-[color-mix(in_srgb,var(--raised),var(--ink)_4%)] active:bg-[color-mix(in_srgb,var(--raised),var(--ink)_8%)]",
  ghost: "text-ink hover:bg-hover active:bg-press",
  danger: "bg-danger text-on-tint hover:brightness-110 active:brightness-95",
};

const SIZES = { sm: "h-7 gap-1.5 rounded-sm px-2.5 text-sm", md: "h-8 gap-2 rounded-md px-3 text-sm", lg: "h-9 gap-2 rounded-md px-4 text-base" };

/** What every button shares: it presses in, fades when it can't be used, and shows the keyboard's focus ring. */
const PRESS = "relative inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-[background-color,color,filter,scale,opacity] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45";

/**
 * A button with words. A `busy` button shows a spinner in its words' place,
 * keeping its size, and can't be pressed until it is done.
 */
export function Button({
  variant = "secondary",
  size = "md",
  busy = false,
  disabled,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: keyof typeof SIZES; busy?: boolean }) {
  return (
    <button type="button" disabled={disabled || busy} aria-busy={busy || undefined} className={cn(PRESS, SIZES[size], VARIANTS[variant], className)} {...props}>
      <span className={cn("inline-flex items-center gap-[inherit]", busy && "opacity-0")}>{children}</span>
      {busy ? <Spinner className="absolute" size={size === "sm" ? 14 : 16} /> : null}
    </button>
  );
}

type Icon = ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;

/**
 * A button that is only an icon. `label` names it for a screen reader and in
 * the tooltip it shows, with `shortcut` when a shortcut does the same.
 */
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  size = "md",
  tooltipSide,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { icon: Icon; label: string; shortcut?: string[]; size?: "sm" | "md"; tooltipSide?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        type="button"
        aria-label={label}
        className={cn(
          PRESS,
          "rounded-md text-ink2 hover:bg-hover hover:text-ink active:bg-press data-[popup-open]:bg-press data-[popup-open]:text-ink",
          size === "sm" ? "size-6 rounded-sm" : "size-7",
          className,
        )}
        {...props}
      >
        <Icon aria-hidden className={size === "sm" ? "size-3.5" : "size-4"} strokeWidth={2} />
      </button>
    </Tooltip>
  );
}
