import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/**
 * A row of choices where one is in effect, as for a new agent's provider.
 * The mark behind the choice in effect slides to a new one as it is
 * picked, and arrow keys move between them. The mark is the app's colour; a
 * `plain` row, as for tabs, has a raised light mark instead, so it reads as a
 * place to go rather than a setting. `label` names the row for a screen reader.
 * A `disabled` row shows its choice and can't be changed. A choice may
 * carry an icon beside its name.
 */
export function Segmented<Id extends string>({
  options,
  value,
  onChange,
  label,
  plain = false,
  disabled = false,
  className,
}: {
  options: Partial<Record<Id, ReactNode>>;
  value: Id;
  onChange: (value: Id) => void;
  label: string;
  plain?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const ids = Object.keys(options) as Id[];
  const at = Math.max(ids.indexOf(value), 0);
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as Id)}
      aria-label={label}
      disabled={disabled}
      className={cn("relative grid h-8 rounded-md bg-field p-0.5 data-disabled:opacity-45", className)}
      style={{ gridTemplateColumns: `repeat(${ids.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className={cn("absolute inset-y-0.5 left-0.5 rounded-sm transition-transform duration-200 ease-out", plain ? "bg-raised shadow-control" : "bg-tint")}
        style={{ width: `calc((100% - 4px) / ${ids.length})`, transform: `translateX(${at * 100}%)` }}
      />
      {ids.map((id) => (
        <Radio.Root
          key={id}
          value={id}
          className={cn(
            "relative z-10 flex min-w-0 items-center justify-center gap-1.5 rounded-sm px-2 text-sm font-medium whitespace-nowrap transition-colors duration-150",
            id !== value ? "text-ink2 not-data-disabled:hover:text-ink" : plain ? "text-ink" : "text-on-tint",
          )}
        >
          {options[id]}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
