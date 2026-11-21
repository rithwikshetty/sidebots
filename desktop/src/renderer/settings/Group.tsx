import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Spinner } from "../ui/Spinner.tsx";

/** A section's heading, at the top of its side, which stays there as what is under it scrolls. */
export function SectionTitle({ children }: { children: string }) {
  return <h2 className="sticky top-0 z-[5] -mx-8 mb-2 bg-raised px-8 pt-6 pb-3 text-lg font-semibold">{children}</h2>;
}

/**
 * A group of rows on a card under its name, with a few words below it, as a
 * section of Settings sets out what it shows. `action` sits at the right of
 * the name. A group with no rows shows only its name and its words.
 */
export function Group({ title, note, action, children, testId }: { title?: string; note?: string; action?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} aria-label={title}>
      {title || action ? (
        <header className={cn("mb-2 flex items-center gap-3 px-0.5", action && "min-h-7")}>
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h3>
          {action}
        </header>
      ) : null}
      {children ? <div className="divide-y divide-line rounded-lg bg-canvas shadow-control">{children}</div> : null}
      {note ? <p className={cn("px-0.5 text-xs text-pretty text-ink2", children && "mt-2")}>{note}</p> : null}
    </section>
  );
}

/** The groups of a section, one under another. */
export function Groups({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-7", className)}>{children}</div>;
}

/** What a section shows while the computer hasn't answered and the app has nothing of its own to show. */
export function Loading({ label }: { label: string }) {
  return (
    <div className="grid h-40 place-items-center text-ink3">
      <Spinner size={20} label={label} />
    </div>
  );
}

/** Why a section has nothing to show, as when the computer couldn't be asked. */
export function Failure({ children }: { children: string }) {
  return (
    <p role="alert" className="animate-fade-in px-0.5 text-sm text-pretty text-ink2">
      {children}
    </p>
  );
}

/**
 * A part of a whole, from 0 to 1, as the filled length of a track: how much
 * of a limit is left, or an agent's share of what every agent used. `label`
 * says what it measures. The fill eases to its new length as the part changes.
 */
export function Bar({ part, label }: { part: number; label: string }) {
  const within = Math.min(Math.max(part, 0), 1);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(within * 100)} className="h-1.5 overflow-hidden rounded-full bg-line">
      <div className="h-full rounded-full bg-tint transition-[width] duration-300 ease-out" style={{ width: `${within * 100}%` }} />
    </div>
  );
}
