// `window.desktop` in a plain browser, for the browser preview (serve.ts),
// which loads this before the window's own scripts. It answers as the main
// process would: the connection is ready with the computer's and the
// person's names, the phones are the server's own, and what would happen
// outside the window is recorded on `window.__desktopCalls` and logged. From
// the console, `__desktop.emit(...)` sends what the main process sends:
//
//   __desktop.emit("menu", "settings")
//   __desktop.emit("openChat", { agentId, messageId })
//   __desktop.emit("connection", { phase: "failed", message: "Sidebots isn't running on this computer." })
//   __desktop.emit("fullScreen", true)
//
// The address can start the window elsewhere: `?platform=win32` lays it out
// as on Windows, and `?phase=starting|setup|failed` (with `&message=...`, or
// `&behind=computer|app` for another version of the contract, for failed)
// opens it in that connection.

import { UPDATE, type Connection, type Desktop, type MenuAction, type OpenChat, type Phone, type PhonePairing } from "../../src/bridge.ts";

type Preview = { person: string; machine: string; version: string };
type Call = { name: string; args: unknown[]; at: number };
type Listeners = { connection: Set<(connection: Connection) => void>; fullScreen: Set<(fullScreen: boolean) => void>; menu: Set<(action: MenuAction) => void>; openChat: Set<(chat: OpenChat) => void> };

declare global {
  interface Window {
    __preview: Preview;
    __desktopCalls: Call[];
    __desktop: { calls: Call[]; emit<K extends keyof Listeners>(kind: K, value: Parameters<Listeners[K] extends Set<infer L> ? (L extends (value: infer V) => void ? (value: V) => void : never) : never>[0]): void };
  }
}

const { person, machine, version } = window.__preview;
const query = new URLSearchParams(location.search);
const calls: Call[] = [];
const record = (name: string, ...args: unknown[]) => {
  calls.push({ name, args, at: Date.now() });
  console.info(`[desktop] ${name}`, ...args);
};

const listeners: Listeners = { connection: new Set(), fullScreen: new Set(), menu: new Set(), openChat: new Set() };
const listen = <T>(set: Set<(value: T) => void>, listener: (value: T) => void) => {
  set.add(listener);
  return () => void set.delete(listener);
};

const ready: Connection = { phase: "ready", machine, person };
const asked = query.get("phase");
const behind = query.get("behind");
let connection: Connection =
  asked === "starting" || asked === "setup"
    ? { phase: asked }
    : asked === "failed"
      ? behind === "computer" || behind === "app"
        ? { phase: "failed", message: UPDATE[behind], behind }
        : { phase: "failed", message: query.get("message") ?? "Sidebots isn't running on this computer." }
      : ready;
let fullScreen = false;

/** Asks the preview's server for something the main process would get from the server's commands. */
async function ask<T>(path: string, body?: unknown): Promise<T> {
  const answer = await fetch(`/__preview/${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const said = (await answer.json()) as T & { error?: string };
  if (!answer.ok) throw new Error(said.error ?? `The preview answered ${answer.status}.`);
  return said;
}

const desktop: Desktop = {
  platform: query.get("platform") ?? "darwin",
  version,
  welcome: false,
  fullScreen: () => fullScreen,
  onFullScreen: (listener) => listen(listeners.fullScreen, listener),
  present: () => true,
  onPresent: () => () => undefined,
  connection: async () => connection,
  onConnection: (listener) => listen(listeners.connection, listener),
  retry: async () => {
    record("retry");
    connection = ready;
    listeners.connection.forEach((listener) => listener(connection));
  },
  openSetup: async () => record("openSetup"),
  phones: () => ask<Phone[]>("phones"),
  pairPhone: () => ask<PhonePairing>("pair-phone", {}),
  removePhone: async (id) => void (await ask("remove-phone", { id })),
  // The scripted server takes any code, so the sign-in comes back at once as if the person signed in.
  signIn: async (url, redirect) => {
    record("signIn", url, redirect);
    const state = new URL(url).searchParams.get("state");
    await new Promise((resolve) => setTimeout(resolve, 400));
    return `${redirect}?state=${state}&code=preview`;
  },
  openExternal: async (url) => record("openExternal", url),
  openFile: async (agentId, path) => record("openFile", agentId, path),
  saveFile: async (agentId, path) => {
    record("saveFile", agentId, path);
    return true;
  },
  notify: (notice) => record("notify", notice),
  clearNotices: (unread) => record("clearNotices", unread),
  onOpenChat: (listener) => listen(listeners.openChat, listener),
  setBadge: (count) => record("setBadge", count),
  onMenu: (listener) => listen(listeners.menu, listener),
};

window.desktop = desktop;
window.__desktopCalls = calls;
window.__desktop = {
  calls,
  emit(kind, value) {
    if (kind === "connection") connection = value as Connection;
    if (kind === "fullScreen") fullScreen = value as boolean;
    (listeners[kind] as Set<(value: unknown) => void>).forEach((listener) => listener(value));
  },
};

// A link the person clicks in an agent's page is opened by the preview's server, as by the main process, and told here.
new EventSource("/__opened").onmessage = (event) => record("openExternal", JSON.parse(event.data as string));

// A page an agent sent is at sidebots-page://page/..., which a browser can't load. The preview serves the same paths under /__page/.
const PAGE = "sidebots-page://page/";
const toPreview = (src: string) => (src.startsWith(PAGE) ? `/__page/${src.slice(PAGE.length)}` : src);
const source = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src")!;
Object.defineProperty(HTMLIFrameElement.prototype, "src", {
  ...source,
  set(this: HTMLIFrameElement, value: string) {
    source.set!.call(this, toPreview(String(value)));
  },
});
const setAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
  setAttribute.call(this, name, this instanceof HTMLIFrameElement && name.toLowerCase() === "src" ? toPreview(String(value)) : value);
};
