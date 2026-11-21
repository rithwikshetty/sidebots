import { useSyncExternalStore } from "react";
import { RotateCw, SquareArrowOutUpRight } from "lucide-react";
import { openFile } from "../chat/files.ts";
import { PageFrame } from "../chat/PageFrame.tsx";
import { IconButton } from "../ui/Button.tsx";

type PageView = { kind: "page"; agentId: string; path: string; title: string };

// How many times each page has been reloaded while the app runs. Each reload draws its frame afresh.
const reloads = new Map<string, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function reload(view: PageView): void {
  const key = `${view.agentId}/${view.path}`;
  reloads.set(key, (reloads.get(key) ?? 0) + 1);
  listeners.forEach((listener) => listener());
}

/** What can be done with the page, in the panel's top bar: load it again, or open its file in the computer's own app for it. */
export function PageActions({ view }: { view: PageView }) {
  return (
    <>
      <IconButton icon={RotateCw} label="Reload" onClick={() => reload(view)} data-testid="page-reload" />
      <IconButton icon={SquareArrowOutUpRight} label="Open in browser" onClick={() => openFile(view.agentId, view.path)} data-testid="page-open" />
    </>
  );
}

/** A page an agent sent, filling the panel, where it scrolls by itself. */
export function Page({ view }: { view: PageView }) {
  const reloaded = useSyncExternalStore(subscribe, () => reloads.get(`${view.agentId}/${view.path}`) ?? 0);
  return (
    <div className="h-full" data-testid="page">
      <PageFrame key={reloaded} agentId={view.agentId} path={view.path} title={view.title} fill />
    </div>
  );
}
