// What the window may ask of the main process, over IPC: the main process's
// side of `window.desktop`. Every request is answered only for the window's
// own top frame, so a page inside the window can ask for nothing.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, Notification, app, dialog, ipcMain, powerMonitor, shell } from "electron";
import { CHANNELS, type Connection, type MenuAction, type Notice, type OpenChat, type Phone, type PhonePairing, type Startup } from "../bridge.ts";
import type { Watch } from "./connection.ts";
import type { Host, Status } from "./host.ts";
import { isDocument, isSecureWeb, isWeb } from "./links.ts";
import { attachmentAddress, attachmentName } from "./protocol.ts";
import { show } from "./window.ts";

// How long the person has to come back from a sign-in in the browser.
const SIGN_IN_MS = 10 * 60_000;
// How long the computer goes unused before its person counts as away from it, in seconds, and how often the main process looks, in milliseconds.
const AWAY_AFTER_SECONDS = 2 * 60;
const LOOK_MS = 1_000;

/** A device as the server's `devices --json` command lists it. */
type Device = { id: string; name: string; kind: "phone" | "desktop"; paired_at: number };

/** The sign-in the person is in the browser for: the address it ends on, the `state` its page was opened with, and what hears where it ended. */
let signingIn: { redirect: string; state: string; done: (address: string | null) => void } | undefined;

/** Hands the sign-in that waits the address the browser came back on, when it is that sign-in's own: its redirect, with its `state`. Returns whether it was. */
export function signInReturned(address: string): boolean {
  if (!signingIn || address.split(/[?#]/, 1)[0] !== signingIn.redirect || URL.parse(address)?.searchParams.get("state") !== signingIn.state) return false;
  signingIn.done(address);
  return true;
}

/** Tells the window something on a channel. */
export function tell(window: BrowserWindow, channel: string, value: boolean | Connection | OpenChat | MenuAction): void {
  if (!window.isDestroyed()) window.webContents.send(channel, value);
}

/**
 * Answers the window. `key` is the app's key to the server, `fetch` reaches
 * the server, and `userData` is the app's own folder, where a file the person
 * opens is put first.
 */
export function answerWindow({ window, host, watch, key, fetch, userData }: {
  window: BrowserWindow;
  host: Host;
  watch: Watch;
  key: () => string | undefined;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  userData: string;
}): void {
  const fromWindow = (event: IpcMainEvent | IpcMainInvokeEvent) => !window.isDestroyed() && event.senderFrame === window.webContents.mainFrame;
  /** Answers a request on a channel, which fails for anything but the window's own top frame. */
  const answer = (channel: string, respond: (...values: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...values) => {
      if (!fromWindow(event)) throw new Error("Only the Sidebots window may ask that.");
      return respond(...values);
    });
  /** Hears what the window sends on a channel without waiting for an answer. */
  const hear = (channel: string, heard: (value: unknown) => void) => ipcMain.on(channel, (event, value) => void (fromWindow(event) && heard(value)));

  ipcMain.on(CHANNELS.readStartup, (event) => {
    event.returnValue = fromWindow(event) ? ({ version: app.getVersion(), fullScreen: window.isFullScreen() } satisfies Startup) : null;
  });
  window.on("enter-full-screen", () => tell(window, CHANNELS.changeFullScreen, true));
  window.on("leave-full-screen", () => tell(window, CHANNELS.changeFullScreen, false));

  // The person is at the computer while its screen is unlocked and they have used it lately. A chat they left open in front isn't one they are looking at, so the window hears when they leave and when they come back.
  let present = true;
  const looks = setInterval(() => {
    const state = powerMonitor.getSystemIdleState(AWAY_AFTER_SECONDS);
    const now = state !== "idle" && state !== "locked";
    if (now !== present) tell(window, CHANNELS.changePresent, (present = now));
  }, LOOK_MS);
  window.on("closed", () => clearInterval(looks));

  answer(CHANNELS.readConnection, () => watch.connection());
  answer(CHANNELS.retryConnection, () => watch.retry());
  answer(CHANNELS.openSetup, async () => {
    if (!(await host.openSetup())) throw new Error("Set Sidebots up from its menu bar app on this computer.");
  });

  answer(CHANNELS.listPhones, async (): Promise<Phone[]> => {
    const devices = JSON.parse(await host.command(["devices", "--json"])) as Device[];
    return devices.filter((device) => device.kind === "phone").map(({ id, name, paired_at }) => ({ id, name, pairedAt: paired_at }));
  });
  answer(CHANNELS.pairPhone, async (): Promise<PhonePairing> => {
    const status = JSON.parse(await host.command(["status", "--json"])) as Status;
    // A computer gets the address phones reach it at from the relay, once it is online. The server can't make a link before then.
    if (!status.address) throw new Error("This computer is still getting ready for phones. It needs an internet connection.");
    const { link, expires_at } = JSON.parse(await host.command(["pair", status.people[0]?.name ?? "", "--json"])) as { link: string; expires_at: number };
    return { link, expiresAt: expires_at };
  });
  answer(CHANNELS.removePhone, async (id) => void (await host.command(["remove-device", String(id)])));

  answer(CHANNELS.signIn, (url, redirect) => {
    if (typeof url !== "string" || typeof redirect !== "string" || !redirect || !isSecureWeb(url)) return null;
    const state = new URL(url).searchParams.get("state");
    if (!state) return null;
    signingIn?.done(null);
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => signingIn?.done(null), SIGN_IN_MS);
      signingIn = {
        redirect,
        state,
        done(address) {
          clearTimeout(timer);
          signingIn = undefined;
          resolve(address);
        },
      };
      void shell.openExternal(url);
    });
  });
  answer(CHANNELS.openExternal, async (url) => {
    if (typeof url === "string" && isWeb(url)) await shell.openExternal(url);
  });

  /** Reads a file an agent sent from the server: its own name, the folder of the agent's and the attachment's that is its alone, and what it holds. */
  const attachment = async (agentId: unknown, path: unknown): Promise<{ name: string; folder: string; bytes: Uint8Array }> => {
    const address = typeof agentId === "string" && typeof path === "string" ? attachmentAddress(host.port, agentId, path) : undefined;
    const read = address ? await fetch(address, { headers: { Authorization: `Bearer ${key()}` } }).catch(() => undefined) : undefined;
    if (!read?.ok) throw new Error("Sidebots couldn't read that file.");
    return { name: attachmentName(path as string)!, folder: join(agentId as string, basename(path as string)), bytes: new Uint8Array(await read.arrayBuffer()) };
  };
  // Files the person opens are put here for the system's apps to read. They go when the app next starts.
  const opened = join(userData, "opened");
  rmSync(opened, { recursive: true, force: true });
  // A document opens in the system's own app for it. Any other file an agent sent could run something, so it is shown in its folder, and the person decides.
  answer(CHANNELS.openFile, async (agentId, path) => {
    const { name, folder, bytes } = await attachment(agentId, path);
    const file = join(opened, folder, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    if (!isDocument(name)) return shell.showItemInFolder(file);
    const failed = await shell.openPath(file);
    if (failed) throw new Error(`This computer has no app that opens ${name}.`);
  });
  answer(CHANNELS.saveFile, async (agentId, path) => {
    const { name, bytes } = await attachment(agentId, path);
    const { filePath } = await dialog.showSaveDialog(window, { defaultPath: join(app.getPath("downloads"), name) });
    if (!filePath) return false;
    writeFileSync(filePath, bytes);
    return true;
  });

  // A notification is kept until it goes, since one nothing holds can't be clicked, with the agent it is about.
  const shown = new Map<Notification, string>();
  hear(CHANNELS.showNotice, (value) => {
    const { title, body, agentId, messageId } = value as Notice;
    if (!Notification.isSupported() || typeof title !== "string" || typeof body !== "string") return;
    const notification = new Notification({ title, body });
    shown.set(notification, agentId);
    notification.on("close", () => shown.delete(notification));
    notification.on("click", () => {
      shown.delete(notification);
      show(window);
      tell(window, CHANNELS.openChat, { agentId, messageId });
    });
    notification.show();
  });
  hear(CHANNELS.clearNotices, (unread) => {
    const keep = new Set(unread as string[]);
    for (const [notification, about] of shown) {
      if (keep.has(about)) continue;
      shown.delete(notification);
      notification.close();
    }
  });
  hear(CHANNELS.setBadge, (count) => void app.setBadgeCount(Number(count) || 0));
}
