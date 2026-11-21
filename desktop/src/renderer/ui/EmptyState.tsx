import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/** A few words in the middle of a space with nothing to show yet: what is missing, and what to do about it, with a picture above and a button below when there are. */
export function EmptyState({ title, note, art, children, className }: { title: string; note?: string; art?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1.5 px-8 text-center", className)}>
      {art ? <div className="mb-3">{art}</div> : null}
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {note ? <p className="max-w-[300px] text-sm text-pretty text-ink2">{note}</p> : null}
      {children ? <div className="mt-4 flex gap-2">{children}</div> : null}
    </div>
  );
}
