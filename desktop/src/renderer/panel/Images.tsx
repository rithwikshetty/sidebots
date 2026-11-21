import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ChevronLeft, ChevronRight, Download, SquareArrowOutUpRight } from "lucide-react";
import { fileName } from "@client/files.ts";
import { attachmentUrl, openFile, saveFile } from "../chat/files.ts";
import { cn } from "../lib/cn.ts";
import { openPanel } from "../lib/view.ts";
import { IconButton } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Spinner } from "../ui/Spinner.tsx";

type ImagesView = { kind: "images"; agentId: string; paths: string[]; index: number };

/** Shows the picture before or after the one shown, when there is one. */
function step(view: ImagesView, by: -1 | 1): void {
  const index = view.index + by;
  if (index >= 0 && index < view.paths.length) openPanel({ ...view, index });
}

/** The picture's name in the panel's top bar, with where it is among the message's pictures when there are several. */
export function ImagesTitle({ view }: { view: ImagesView }) {
  const path = view.paths[view.index];
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate">{path ? fileName(path) : null}</span>
      {view.paths.length > 1 ? (
        <span className="shrink-0 font-normal text-ink2 tabular-nums" data-testid="image-count">
          {view.index + 1} of {view.paths.length}
        </span>
      ) : null}
    </span>
  );
}

/** What can be done with the picture shown, in the panel's top bar: open it in the computer's own app, or save it. */
export function ImagesActions({ view }: { view: ImagesView }) {
  const path = view.paths[view.index];
  if (!path) return null;
  return (
    <>
      <IconButton icon={SquareArrowOutUpRight} label="Open" onClick={() => openFile(view.agentId, path)} data-testid="image-open" />
      <IconButton icon={Download} label="Save as…" onClick={() => saveFile(view.agentId, path)} data-testid="image-save" />
    </>
  );
}

/**
 * The pictures from one message, one at a time, fitted to the panel on a
 * quiet ground. With several, the buttons at its sides and the arrow keys go
 * to the one before and the one after. A click on a picture shown smaller
 * than it is shows it at its own size, scrolled to where it was clicked, and
 * a click again fits it back.
 */
export function Images({ view }: { view: ImagesView }) {
  const path = view.paths[view.index];
  const several = view.paths.length > 1;
  const latest = useRef(view);
  latest.current = view;

  useEffect(() => {
    if (!several) return;
    const press = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      const by = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (!by) return;
      event.preventDefault();
      step(latest.current, by);
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, [several]);

  return (
    <div className="relative h-full bg-sidebar" data-testid="images">
      {path ? <Picture key={path} agentId={view.agentId} path={path} /> : null}
      {several ? (
        <>
          <Side side="start" label="Previous picture" disabled={view.index === 0} onClick={() => step(view, -1)} />
          <Side side="end" label="Next picture" disabled={view.index === view.paths.length - 1} onClick={() => step(view, 1)} />
        </>
      ) : null}
    </div>
  );
}

/** Whether a key went to somewhere the person types, where the arrow keys move through their words. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** A round button at one side of the picture, over it. */
function Side({ side, label, disabled, onClick }: { side: "start" | "end"; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <IconButton
      icon={side === "start" ? ChevronLeft : ChevronRight}
      label={label}
      shortcut={[side === "start" ? "←" : "→"]}
      disabled={disabled}
      onClick={onClick}
      tooltipSide={side === "start" ? "right" : "left"}
      className={cn(
        "absolute top-1/2 z-10 size-8 -translate-y-1/2 rounded-full bg-raised/90 text-ink shadow-menu backdrop-blur-md hover:bg-raised active:bg-raised disabled:opacity-0",
        side === "start" ? "left-3" : "right-3",
      )}
      data-testid={side === "start" ? "image-previous" : "image-next"}
    />
  );
}

/** Where a click on a fitted picture was, as a share of its width and height, and of the panel's from its edge, so the picture at its own size keeps that spot under the pointer. */
type Spot = { x: number; y: number; left: number; top: number };

/** One picture: fitted while it loads and once it has, and at its own size after a click when it is bigger than the room. */
function Picture({ agentId, path }: { agentId: string; path: string }) {
  const [state, setState] = useState<"loading" | "shown" | "failed">("loading");
  const [actual, setActual] = useState(false);
  const [zoomable, setZoomable] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const spot = useRef<Spot | null>(null);

  // Whether the fitted picture is drawn smaller than it is, which it may become as the panel is dragged narrower.
  useEffect(() => {
    const drawn = image.current;
    if (!drawn || state !== "shown") return;
    const measure = () => setZoomable(drawn.naturalWidth > drawn.clientWidth + 1 || drawn.naturalHeight > drawn.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(() => !actual && measure());
    observer.observe(stage.current!);
    return () => observer.disconnect();
  }, [state, actual]);

  useLayoutEffect(() => {
    const at = spot.current;
    const room = stage.current;
    const drawn = image.current;
    if (!actual || !at || !room || !drawn) return;
    room.scrollLeft = at.x * drawn.naturalWidth + drawn.offsetLeft - at.left;
    room.scrollTop = at.y * drawn.naturalHeight + drawn.offsetTop - at.top;
  }, [actual]);

  const toggle = (event: MouseEvent<HTMLImageElement>) => {
    if (!actual && !zoomable) return;
    if (!actual) {
      const box = event.currentTarget.getBoundingClientRect();
      const room = stage.current!.getBoundingClientRect();
      spot.current = { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height, left: event.clientX - room.left, top: event.clientY - room.top };
    }
    setActual(!actual);
  };

  const name = fileName(path);
  return (
    <div ref={stage} className={cn("flex size-full", actual ? "overflow-auto" : "items-center justify-center overflow-hidden p-4")}>
      {state === "failed" ? (
        <EmptyState title="Can't show this picture" note="Open it in the computer's own app instead." />
      ) : (
        <img
          ref={image}
          src={attachmentUrl(agentId, path)}
          alt={name}
          draggable={false}
          onLoad={() => setState("shown")}
          onError={() => setState("failed")}
          onClick={toggle}
          data-testid="image"
          data-actual={actual || undefined}
          className={cn(
            "shrink-0 transition-opacity duration-150",
            state === "shown" ? "opacity-100" : "opacity-0",
            actual ? "m-auto max-w-none cursor-zoom-out" : "max-h-full max-w-full object-contain shadow-control",
            !actual && zoomable && "cursor-zoom-in",
          )}
        />
      )}
      {state === "loading" ? (
        <div className="absolute inset-0 grid place-items-center text-ink3">
          <Spinner label={`Loading ${name}`} />
        </div>
      ) : null}
    </div>
  );
}
