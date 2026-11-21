import { Switch as Base } from "@base-ui/react/switch";
import { cn } from "../lib/cn.ts";

/** A switch for something that is on or off, as whether an agent is muted. `label` names it for a screen reader when no label sits beside it. */
export function Switch({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (checked: boolean) => void; label?: string; disabled?: boolean; className?: string }) {
  return (
    <Base.Root
      checked={checked}
      onCheckedChange={(next) => onChange(next)}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "relative inline-flex h-[18px] w-[30px] shrink-0 rounded-full bg-line-strong p-0.5 transition-colors duration-150 ease-out data-checked:bg-tint data-disabled:opacity-45",
        className,
      )}
    >
      <Base.Thumb className="size-[14px] rounded-full bg-on-tint shadow-control transition-transform duration-150 ease-out data-checked:translate-x-3" />
    </Base.Root>
  );
}
