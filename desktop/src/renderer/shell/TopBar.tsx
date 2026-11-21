import { createContext, useContext, type ReactNode } from "react";
import { TOP_BAR } from "../../bridge.ts";
import { cn } from "../lib/cn.ts";

/**
 * What a column's top bar keeps clear, in pixels at its start and its end,
 * for the system's own buttons over the window or for the column's padding,
 * and what it shows first, as the button that brings a collapsed sidebar
 * back. The frame gives each column its own.
 */
export type Column = { start: number; end: number; lead?: ReactNode };

const ColumnContext = createContext<Column>({ start: 12, end: 12 });

export const ColumnProvider = ColumnContext.Provider;

/**
 * The bar 52 pixels tall across the top of a column, which moves the window
 * when dragged. Buttons and fields in it still take the pointer. It keeps
 * clear of the system's own buttons, so what is put in it, left to right,
 * starts and ends where the column allows.
 */
export function TopBar({ children, className }: { children?: ReactNode; className?: string }) {
  const { start, end, lead } = useContext(ColumnContext);
  return (
    <header data-drag className={cn("flex shrink-0 items-center gap-2", className)} style={{ height: TOP_BAR, paddingInlineStart: start, paddingInlineEnd: end }}>
      {lead}
      {children}
    </header>
  );
}
