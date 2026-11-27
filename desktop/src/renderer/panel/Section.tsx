import { Children, type ComponentProps, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Spinner } from "../ui/Spinner.tsx";

/**
 * A group of rows on a card, under its title, with a line of help below. A
 * group with no rows shows only its title and help. An `action`, as a button
 * that adds a row, sits at the title's end.
 */
export function Section({ title, note, action, children, testId }: { title?: string; note?: string; action?: ReactNode; children?: ReactNode; testId?: string }) {
  const rows = Children.toArray(children).length > 0;
  return (
    <section aria-label={title} data-testid={testId} className="flex flex-col gap-2">
      {title && action ? (
        <div className="-my-1 flex items-center justify-between gap-2">
          <SectionTitle>{title}</SectionTitle>
          {action}
        </div>
      ) : title ? (
        <SectionTitle>{title}</SectionTitle>
      ) : null}
      {rows ? <div className="flex flex-col divide-y divide-line overflow-hidden rounded-lg bg-raised shadow-control">{children}</div> : null}
      {note ? <p className="px-1 text-xs text-pretty text-ink2">{note}</p> : null}
    </section>
  );
}

/** The small title over a group, or over anything set out as one. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="px-1 text-xs font-semibold text-ink2">{children}</h3>;
}

/** What every row of a card shares: its height and its padding. */
const ROW = "flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left";

/** A row of a card that shows something, with what acts on it at its end. */
export function Row({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn(ROW, className)} {...props} />;
}

/** A row of a card that does something when clicked, as one that opens a note. */
export function RowButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(ROW, "transition-colors duration-150 ease-out hover:bg-hover focus-visible:-outline-offset-2 active:bg-press disabled:pointer-events-none disabled:opacity-45", className)}
      {...props}
    />
  );
}

/** A row's words: its title, and a note under it. */
export function RowText({ title, note, lines }: { title?: ReactNode; note?: ReactNode; lines?: 2 | 3 | 4 }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      {title ? <span className={cn("text-sm text-ink", lines === 2 && "line-clamp-2")}>{title}</span> : null}
      {note ? <span className={cn("text-xs whitespace-pre-line text-ink2", lines === 3 && "line-clamp-3", lines === 4 && "line-clamp-4")}>{note}</span> : null}
    </span>
  );
}

/** A row that holds a card's place while what goes in it is on its way, as tall as one row, so nothing moves once it comes. */
export function LoadingRow() {
  return (
    <Row className="justify-center text-ink3">
      <Spinner size={14} />
    </Row>
  );
}
