import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "../lib/cn.ts";
import { useAgent, useChatColor } from "../lib/store.ts";
import { Spinner } from "../ui/Spinner.tsx";

// A page in a chat is as tall as what it holds, between these, and the third until it is measured.
export const PAGE_SHORTEST = 60;
export const PAGE_TALLEST = 480;
const PAGE_UNMEASURED = 160;

// How tall each page's content is once measured, so a page drawn again, as when a chat is opened again, takes its height at once.
const heights = new Map<string, number>();

const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
function onScheme(listener: () => void): () => void {
  darkScheme.addEventListener("change", listener);
  return () => darkScheme.removeEventListener("change", listener);
}

/** Whether the window is drawn dark, as the system is. */
function useDark(): boolean {
  return useSyncExternalStore(onScheme, () => darkScheme.matches);
}

// The window's colours a page is given, by the names the page handler takes them under. Each is a solid #RRGGBB.
const TOKENS = { bg: "--canvas", ink: "--ink", ink2: "--ink2", line: "--line-solid", field: "--field", link: "--tint-ink" } as const;

const painter = document.createElement("canvas").getContext("2d")!;

/** A colour as #rrggbb, however the style sheet wrote it, as the built one writes #000000 as #000. */
function solid(color: string): string {
  painter.fillStyle = "#000000";
  painter.fillStyle = color;
  return painter.fillStyle;
}

/** Where the frame loads a page from, with the window's colours as they are in `dark` and the chat's colour as its `tint`. */
function pageAddress(agentId: string, path: string, dark: boolean, tint: string | null): string {
  const root = getComputedStyle(document.documentElement);
  const read = (token: string) => solid(root.getPropertyValue(token).trim());
  const colors = Object.fromEntries(Object.entries(TOKENS).map(([name, token]) => [name, read(token)]));
  const query = new URLSearchParams({ scheme: dark ? "dark" : "light", ...colors, tint: tint ?? read("--tint") });
  return `sidebots-page://page/${encodeURIComponent(agentId)}/${path.split("/").map(encodeURIComponent).join("/")}?${query}`;
}

/** How tall a page is shown in a chat, from how tall its content is. */
export function pageHeight(measured: number | undefined): number {
  return measured === undefined ? PAGE_UNMEASURED : Math.min(PAGE_TALLEST, Math.max(PAGE_SHORTEST, measured));
}

/** How tall a page's content was last measured, when it has been. */
export function measuredHeight(agentId: string, path: string): number | undefined {
  return heights.get(`${agentId}/${path}`);
}

/**
 * A page an agent sent, drawn in a frame closed off from the window: it can
 * run its own scripts, and a link the person clicks in it opens in the system
 * browser, but it reaches neither the window nor the server, opens no
 * window, and takes the keyboard only when the person clicks in it. It is given the window's colours and the chat's, and loads again
 * when the system turns light or dark or the chat's colour changes. With
 * `fill` it fills what holds it and scrolls by itself. Without, it is as tall
 * as what it holds, between 60 and 480 pixels, and 160 until the page has
 * said; `onHeight` hears how tall its content is each time the page says.
 */
export function PageFrame({ agentId, path, title, fill = false, onHeight }: { agentId: string; path: string; title: string; fill?: boolean; onHeight?: (height: number) => void }) {
  const dark = useDark();
  const tint = useChatColor(useAgent(agentId));
  const src = useMemo(() => pageAddress(agentId, path, dark, tint), [agentId, path, dark, tint]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [measured, setMeasured] = useState(() => measuredHeight(agentId, path));
  const told = useRef(onHeight);
  told.current = onHeight;

  useEffect(() => setLoaded(false), [src]);

  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.sidebots !== "height") return;
      const height = Number(event.data.height);
      if (!(height > 0)) return;
      heights.set(`${agentId}/${path}`, height);
      setMeasured(height);
      told.current?.(height);
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  }, [agentId, path]);

  return (
    <div className={cn("relative", fill && "h-full")} style={fill ? undefined : { height: pageHeight(measured) }} data-testid="page-frame">
      <iframe
        ref={frame}
        src={src}
        title={title}
        sandbox="allow-scripts"
        // The page can take the keyboard only when the person clicks in it, so it never takes what they type elsewhere.
        allow="focus-without-user-activation 'none'"
        // In a chat the page is cut at its tallest, where "Show all" opens the rest, so it doesn't scroll by itself.
        scrolling={fill ? undefined : "no"}
        onLoad={() => setLoaded(true)}
        className={cn("block size-full border-0 bg-transparent transition-opacity duration-150", loaded ? "opacity-100" : "opacity-0")}
      />
      {loaded ? null : (
        <div className="absolute inset-0 grid place-items-center text-ink3">
          <Spinner label={`Loading ${title}`} />
        </div>
      )}
    </div>
  );
}
