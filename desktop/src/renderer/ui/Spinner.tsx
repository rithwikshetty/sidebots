import { cn } from "../lib/cn.ts";

/** A ring that turns while something is on its way, in the colour of the text around it. `label` names what is on its way for a screen reader; without one it is only for the eye. */
export function Spinner({ size = 16, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0 animate-spin", className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
