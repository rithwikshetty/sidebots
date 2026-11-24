// What the window knows: the person's agents, their messages and the avatars,
// which the store in `client/` keeps for both apps. This is the desktop's side
// of it: the server reached through the main process at `/api`, which adds the
// app's key, the browser's storage, and the connection the main process keeps
// with the server, which starts and stops the sync.

import { useSyncExternalStore } from "react";
import { call } from "@client/api.ts";
import { createStore } from "@client/store.ts";
import { NOT_RUNNING, UPDATE, type Connection } from "../../bridge.ts";

export type { AgentChanges } from "@client/store.ts";
export type { Behind } from "@client/api.ts";
export { UPDATE } from "../../bridge.ts";

// The desktop's words for a call that never reached Sidebots.
const WORDS = {
  unreachable: "Can't reach Sidebots on this computer.",
  notRunning: NOT_RUNNING,
  update: UPDATE,
};

/** Calls the server through the main process. A `body` is sent as JSON, or as it is when it is a form. */
function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return call<T>({ ...WORDS, fetch: (url, options) => fetch(url, options) }, `/api${path}`, init);
}

// How long the window waits, after the server refused its key, before it looks whether the main process holds a good one again.
const REFUSED_MS = 5_000;

const store = createStore<File>({
  request,
  events: (signal) => fetch("/api/events", { headers: { Accept: "text/event-stream" }, signal }),
  storage: localStorage,
  // The window comes back to the front when it is shown again from hidden, as after a Mac's window was closed or the computer slept. Nothing drops a hidden window's stream, and one that ended while the computer slept has gone quiet.
  onFront(listener) {
    const shown = () => {
      if (document.visibilityState === "visible") listener(false);
    };
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  },
  attach: (form, file) => form.append("files", file, file.name),
  signIn: (url, redirect) => window.desktop.signIn(url, redirect),
  // The main process hears the refusal too and pairs again by itself. The sync starts again once it says it is ready, or, when it stayed ready all along, a little later.
  onRefused: () => setTimeout(() => void window.desktop.connection().then(follow), REFUSED_MS),
  useSyncExternalStore,
});

export const {
  useAgents,
  useAgent,
  useMessages,
  useHole,
  useAvatars,
  useChatColor,
  useAbout,
  useUsage,
  useConnections,
  useBehind,
  onAgents,
  loadMessages,
  newestPage,
  loadOlder,
  backToNewest,
  send,
  answerAsk,
  freshStart,
  resend,
  stop,
  createAgent,
  changeAgent,
  deleteAgent,
  loadAbout,
  loadUsage,
  loadConnections,
  connect,
  removeConnection,
  removeJob,
  findMessages,
  markRead,
} = store;

let connection: Connection = { phase: "starting" };
// Whether the main process has found the server out of reach, from when it says it failed until it is ready again.
let unreached = false;
const listeners = new Set<() => void>();

/** Keeps the connection as the main process says it stands, and syncs only while it is ready. */
function follow(next: Connection): void {
  if (next.phase === "ready") store.startSync();
  else store.stopSync();
  if (JSON.stringify(next) === JSON.stringify(connection)) return;
  connection = next;
  if (next.phase === "failed") unreached = true;
  if (next.phase === "ready") unreached = false;
  listeners.forEach((listener) => listener());
}

void window.desktop.connection().then(follow);
window.desktop.onConnection(follow);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where the app stands with the Sidebots server on this computer, as the main process works it out. */
export function useConnection(): Connection {
  return useSyncExternalStore(subscribe, () => connection);
}

/** Whether the app reaches Sidebots: its event stream is up, or was when last heard, and the main process hasn't found the server out of reach since it was last ready. */
export function useOnline(): boolean {
  const online = store.useOnline();
  return !useSyncExternalStore(subscribe, () => unreached) && online;
}
