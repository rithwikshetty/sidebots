import { useState } from "react";
import { FolderOpen, Download, Maximize2 } from "lucide-react";
import { fileKind, fileMeta, fileName, pageTitle } from "@client/files.ts";
import { cn } from "../lib/cn.ts";
import { useOnline } from "../lib/store.ts";
import { openPanel } from "../lib/view.ts";
import { IconButton } from "../ui/Button.tsx";
import { ContextMenu } from "../ui/Menu.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { FILE_ICONS, attachmentUrl, openFile, saveFile, useSentFile } from "./files.ts";
import { PAGE_TALLEST, PageFrame, measuredHeight, pageHeight } from "./PageFrame.tsx";

// A message's one picture fits this box; several are rows of square tiles.
const PHOTO_BOX = 228;
const PHOTO_TILE = 104;

// Each picture's shape once it has loaded, so a lone picture keeps its shape when the chat draws it again.
const shapes = new Map<string, { width: number; height: number }>();

/** A lone picture's frame: its own shape, kept between 3:4 and 4:3, fitted to the box. */
function photoFrame(shape: { width: number; height: number } | undefined): { width: number; height: number } {
  const ratio = shape ? shape.height / shape.width : 1;
  const clamped = Math.min(4 / 3, Math.max(3 / 4, ratio));
  return clamped > 1 ? { width: Math.round(PHOTO_BOX / clamped), height: PHOTO_BOX } : { width: PHOTO_BOX, height: Math.round(PHOTO_BOX * clamped) };
}

/**
 * The pictures a message carries, above its bubble: one in its own shape, or
 * rows of square tiles. A click opens them in the panel at the one clicked.
 * `end` lines them up at the column's end, as the person's are.
 */
export function Photos({ agentId, paths, end }: { agentId: string; paths: string[]; end: boolean }) {
  const [, redraw] = useState(0);
  const lone = paths.length === 1 ? photoFrame(shapes.get(attachmentUrl(agentId, paths[0]))) : null;
  return (
    <div className={cn("flex flex-wrap gap-1", end && "justify-end")} style={{ maxWidth: PHOTO_TILE * 3 + 8 }} data-testid="message-photos">
      {paths.map((path, index) => {
        const url = attachmentUrl(agentId, path);
        return (
          <button
            key={path}
            type="button"
            onClick={() => openPanel({ kind: "images", agentId, paths, index })}
            aria-label={`Open ${fileName(path)}`}
            className="relative shrink-0 overflow-hidden rounded-xl bg-field transition-[filter,scale] duration-150 hover:brightness-95 active:scale-[0.98]"
            style={{ width: lone?.width ?? PHOTO_TILE, height: lone?.height ?? PHOTO_TILE }}
          >
            <img
              src={url}
              alt=""
              draggable={false}
              decoding="async"
              className="size-full object-cover"
              onLoad={({ currentTarget }) => {
                if (shapes.has(url)) return;
                shapes.set(url, { width: currentTarget.naturalWidth, height: currentTarget.naturalHeight });
                if (lone) redraw((n) => n + 1);
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A page the agent sent, as T3 Code shows one: drawn in the chat above the
 * reply, in the chat's colours, as tall as what it holds up to a limit, under
 * its title and a button that opens it in the panel, where a longer page
 * scrolls. A longer page fades out at that limit, over "Show all", which
 * opens it too. The page is drawn once the server says it has it. One that
 * hasn't loaded waits while Sidebots is out of reach, holding its place, and
 * loads when the server is back; one that has loaded stays as the person left
 * it. A page the server says the window can't have shows as its file card.
 * `onShown` hears each time the page says it has shown.
 */
export function PageCard({ agentId, path, onShown }: { agentId: string; path: string; onShown?: () => void }) {
  const title = pageTitle(fileName(path));
  const [measured, setMeasured] = useState(() => measuredHeight(agentId, path));
  const found = useSentFile(agentId, path)?.found;
  const online = useOnline();
  // Whether the frame now drawn has shown the page, which it says by telling its height. A load that failed never does.
  const [loaded, setLoaded] = useState(false);
  const drawn = found && (online || loaded);
  if (!drawn && loaded) setLoaded(false);
  const cut = measured !== undefined && measured > PAGE_TALLEST;
  const open = () => openPanel({ kind: "page", agentId, path, title });
  if (found === false) return <FileCard agentId={agentId} path={path} />;
  return (
    <div className="w-full overflow-hidden rounded-xl border border-line" data-testid="message-page">
      <div className="flex h-9 items-center gap-2 border-b border-line pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-sm text-ink2">{title}</span>
        <IconButton icon={Maximize2} label={`Open ${title} in the panel`} size="sm" onClick={open} data-testid="open-page" />
      </div>
      <div className="relative">
        {drawn ? (
          <PageFrame
            agentId={agentId}
            path={path}
            title={title}
            onHeight={(height) => {
              setMeasured(height);
              setLoaded(true);
              onShown?.();
            }}
          />
        ) : (
          <div className="grid place-items-center text-ink3" style={{ height: pageHeight(measured) }} data-testid="page-waiting">
            <Spinner label={`Loading ${title}`} />
          </div>
        )}
        {cut ? (
          <div className="absolute inset-x-0 bottom-0 flex h-20 items-end bg-linear-to-b from-transparent to-canvas px-3 pb-2">
            <button type="button" onClick={open} aria-label={`Show all of ${title}`} className="rounded-sm px-1 py-0.5 text-sm font-semibold text-tint-ink transition-colors hover:bg-hover active:bg-press">
              Show all
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One file a message carries: its kind's icon, its name, and its kind and
 * size. A click opens it in the computer's own app for it, or shows it in its
 * folder when it is a kind that could run something; a right-click offers
 * Open and Save as.
 */
export function FileCard({ agentId, path }: { agentId: string; path: string }) {
  const [busy, setBusy] = useState(false);
  const name = fileName(path);
  const Icon = FILE_ICONS[fileKind(name)];
  const meta = fileMeta(name, useSentFile(agentId, path)?.size ?? null);
  const open = () => {
    setBusy(true);
    void openFile(agentId, path).finally(() => setBusy(false));
  };
  return (
    <ContextMenu
      entries={[
        { label: "Open", icon: FolderOpen, onSelect: open },
        { label: "Save as…", icon: Download, onSelect: () => saveFile(agentId, path) },
      ]}
      className="max-w-full"
    >
      <FileTile icon={busy ? null : Icon} name={name} meta={meta} onClick={open} busy={busy} testId="message-file" />
    </ContextMenu>
  );
}

/**
 * What a file shows as, sent or about to be: its kind's icon on a small
 * tile, or a spinner while it opens, its name, and a line about it.
 */
export function FileTile({
  icon: Icon,
  name,
  meta,
  onClick,
  busy = false,
  testId,
  className,
}: {
  icon: (typeof FILE_ICONS)[keyof typeof FILE_ICONS] | null;
  name: string;
  meta: string;
  onClick?: () => void;
  busy?: boolean;
  testId?: string;
  className?: string;
}) {
  const body = (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-field text-tint-ink">{Icon ? <Icon aria-hidden className="size-[18px]" strokeWidth={1.75} /> : <Spinner className="text-ink2" />}</span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-sm font-medium text-ink">{name}</span>
        <span className="truncate text-xs text-ink2">{meta}</span>
      </span>
    </>
  );
  const look = cn("flex w-[280px] max-w-full items-center gap-2.5 rounded-xl border border-line bg-raised py-2 pr-3 pl-2", className);
  if (!onClick) return <div className={look}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={`${name}, ${meta}`}
      data-testid={testId}
      className={cn(look, "transition-[background-color,scale] duration-150 hover:bg-[color-mix(in_srgb,var(--raised),var(--ink)_4%)] active:scale-[0.99] active:bg-[color-mix(in_srgb,var(--raised),var(--ink)_8%)]")}
    >
      {body}
    </button>
  );
}

