// The app's one window: where it opens, how its frame looks on each system,
// and what the pages inside it may do.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, type Rectangle, nativeTheme, screen, session, shell } from "electron";
import { TOP_BAR } from "../bridge.ts";
import { isAt, isWeb } from "./links.ts";
import { APP_ORIGIN, PAGE_ORIGIN } from "./protocol.ts";

const SIZE = { width: 1100, height: 780 };
const SMALLEST = { width: 760, height: 520 };
// What shows behind the window's first paint, so it never flashes the other mode's colour.
const BACKGROUND = { light: "#FFFFFF", dark: "#000000" };
// How long the window rests after a move or a resize before its place is saved.
const SAVE_MS = 500;
// A window whose process dies is loaded again, this many times a minute at most.
const RELOADS = 3;
const RELOADS_MS = 60_000;

/** Where the window was and whether it filled the screen's work area, as the app keeps it between runs. */
type Place = Rectangle & { maximized: boolean };

const background = () => (nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light);
const buttons = () => ({ color: "#00000000", symbolColor: nativeTheme.shouldUseDarkColors ? "#FFFFFF" : "#000000", height: TOP_BAR });

/** The place the window had, when a display that is still connected holds all of it. */
function savedPlace(file: string): Place | undefined {
  try {
    const place = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Place) : undefined;
    const held = place && screen.getAllDisplays().some(({ bounds }) => place.x >= bounds.x && place.y >= bounds.y && place.x + place.width <= bounds.x + bounds.width && place.y + place.height <= bounds.y + bounds.height);
    return held ? place : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Makes the window, hidden until its first paint is ready. `preload` is the
 * script that gives the window `window.desktop`, `userData` is where the
 * window's place is kept, and `quitting` says whether the app is quitting,
 * which is when a Mac's window closes and doesn't only hide. `pageLink`
 * reads the link an agent's page asks the app to open from the address its
 * frame was moved to, when the address is such a one.
 */
export function createWindow({ preload, userData, quitting, pageLink }: {
  preload: string;
  userData: string;
  quitting: () => boolean;
  pageLink: (address: string) => string | undefined;
}): BrowserWindow {
  const file = join(userData, "window.json");
  const place = savedPlace(file);
  const mac = process.platform === "darwin";
  const window = new BrowserWindow({
    ...SIZE,
    ...(place ? { x: place.x, y: place.y, width: place.width, height: place.height } : {}),
    minWidth: SMALLEST.width,
    minHeight: SMALLEST.height,
    show: false,
    backgroundColor: background(),
    ...(mac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 19 } } : { titleBarStyle: "hidden" as const, titleBarOverlay: buttons() }),
    // A frame that holds an agent's page is kept from taking the keyboard by itself, which only this feature of Chromium's lets the window ask for.
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, enableBlinkFeatures: "BlockingFocusWithoutUserActivation" },
  });
  if (place?.maximized) window.maximize();
  window.once("ready-to-show", () => window.show());

  // The window's place is the one it goes back to from filling the screen.
  let saving: ReturnType<typeof setTimeout> | undefined;
  const save = () => writeFileSync(file, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() } satisfies Place));
  const moved = () => {
    clearTimeout(saving);
    saving = setTimeout(save, SAVE_MS);
  };
  window.on("resize", moved);
  window.on("move", moved);

  const themed = () => {
    window.setBackgroundColor(background());
    if (!mac) window.setTitleBarOverlay(buttons());
  };
  nativeTheme.on("updated", themed);

  window.on("close", (event) => {
    clearTimeout(saving);
    save();
    if (!mac || quitting()) return;
    // On a Mac the app stays open without its window, so replies still notify. A window that fills the screen leaves that first, or it would leave an empty screen behind.
    event.preventDefault();
    if (window.isFullScreen()) {
      window.once("leave-full-screen", () => window.hide());
      window.setFullScreen(false);
    } else window.hide();
  });
  window.on("closed", () => nativeTheme.off("updated", themed));

  const contents = window.webContents;
  // Nothing opens another window.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The window stays at its own origin. A frame inside it holds an agent's page, and only the window's own document moves it, to a page: nothing a page does moves its frame. A web address the window would be moved to opens in the system browser instead, and so does the link a page asks for as the person clicks it.
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame ? isAt(APP_ORIGIN, event.url) : event.initiator === contents.mainFrame && isAt(PAGE_ORIGIN, event.url)) return;
    event.preventDefault();
    const link = event.isMainFrame ? event.url : pageLink(event.url);
    if (link && isWeb(link)) void shell.openExternal(link);
  });

  let reloads: number[] = [];
  contents.on("render-process-gone", (_event, { reason }) => {
    reloads = reloads.filter((at) => Date.now() - at < RELOADS_MS);
    if (reason === "clean-exit" || reloads.length >= RELOADS || window.isDestroyed()) return;
    reloads.push(Date.now());
    contents.reload();
  });

  return window;
}

/** Lets the window's own pages write to the clipboard, and refuses everything else a page can ask a person for. */
export function refusePermissions(): void {
  const allowed = (permission: string, origin: string, mainFrame: boolean) => permission === "clipboard-sanitized-write" && mainFrame && isAt(APP_ORIGIN, origin.replace(/\/$/, ""));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, answer, details) => answer(allowed(permission, details.requestingUrl, details.isMainFrame)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) => allowed(permission, origin, details.isMainFrame));
}

/** Brings the window to the front. */
export function show(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
