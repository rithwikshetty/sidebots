// Opens the packaged desktop app against a server of the test's own, and
// does to it what tests and screenshots do: wait for it to be ready, set its
// colours and size, finish a sign-in, and close it. The app is the one
// `E2E=1 pnpm package` makes, which Playwright can drive and which keeps out
// of the way of whoever is at the computer (unseen.ts). The fixtures and
// shots.ts both use this file.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { DESKTOP, SERVER, childEnv } from "./server.ts";

export const PROGRAM = join(DESKTOP, "out", "Sidebots-darwin-arm64", "Sidebots.app", "Contents", "MacOS", "Sidebots");

/** What the main process was asked to do outside the window, which the tests keep from happening: links and sign-ins it opened, files it opened, showed in their folder or saved, notifications it showed and took away, and the Dock's badge. */
export type MainCalls = { opened: string[]; files: string[]; shown: string[]; saved: string[]; notices: { title: string; body: string }[]; cleared: { title: string; body: string }[]; badge: number[] };

/**
 * Opens the app with its data in `home` and its server on `port`. The app
 * opens nothing outside itself: a link or a sign-in is recorded and not
 * opened, a file is recorded and neither opened nor shown in its folder, a
 * save goes into the home's `saved` folder, and a notification is recorded
 * and not shown. The person reads as at the computer, whether or not anyone
 * is using the one the tests run on.
 */
export async function launchApp({ home, port, welcome = false }: { home: string; port: number; welcome?: boolean }): Promise<ElectronApplication> {
  if (!existsSync(PROGRAM)) throw new Error(`There is no packaged app at ${PROGRAM}. Build it with \`E2E=1 pnpm package\` in desktop/.`);
  const saveTo = join(home, "saved");
  mkdirSync(saveTo, { recursive: true });
  const app = await electron.launch({
    executablePath: PROGRAM,
    env: childEnv({ SIDEBOTS_HOME: home, PORT: String(port), SIDEBOTS_RELAY: "off", SIDEBOTS_NODE: process.execPath, SIDEBOTS_SERVER: SERVER, ...(welcome ? { SIDEBOTS_WELCOME: "1" } : {}) }) as Record<string, string>,
  });
  await app.evaluate(({ app: electronApp, dialog, shell, powerMonitor, Notification }, saveTo) => {
    const calls: MainCalls = { opened: [], files: [], shown: [], saved: [], notices: [], cleared: [], badge: [] };
    powerMonitor.getSystemIdleState = () => "active";
    (globalThis as { e2e?: MainCalls }).e2e = calls;
    shell.openExternal = async (url: string) => void calls.opened.push(url);
    shell.openPath = async (path: string) => {
      calls.files.push(path);
      return "";
    };
    shell.showItemInFolder = (path: string) => void calls.shown.push(path);
    dialog.showSaveDialog = (async (...given: unknown[]) => {
      const options = given.at(-1) as { defaultPath?: string };
      const name = (options.defaultPath ?? "file").split("/").pop()!;
      calls.saved.push(name);
      return { canceled: false, filePath: `${saveTo}/${name}` };
    }) as typeof dialog.showSaveDialog;
    Notification.prototype.show = function (this: { title: string; body: string }) {
      calls.notices.push({ title: this.title, body: this.body });
    };
    Notification.prototype.close = function (this: { title: string; body: string }) {
      calls.cleared.push({ title: this.title, body: this.body });
    };
    const setBadgeCount = electronApp.setBadgeCount.bind(electronApp);
    electronApp.setBadgeCount = (count?: number) => {
      calls.badge.push(count ?? 0);
      return setBadgeCount(count);
    };
  }, saveTo);
  return app;
}

/** What the main process was asked to do outside the window so far. */
export function mainCalls(app: ElectronApplication): Promise<MainCalls> {
  return app.evaluate(() => (globalThis as { e2e?: MainCalls }).e2e!);
}

/**
 * The app's window, once it reports `data-phase="ready"`, unless `ready` is
 * false. Playwright has every page it drives read as light, so the window is
 * let follow the app's own light or dark, as it does outside a test.
 */
export async function firstPage(app: ElectronApplication, ready = true): Promise<Page> {
  const page = await app.firstWindow();
  await page.emulateMedia({ colorScheme: null });
  if (ready) await page.locator('[data-phase="ready"]').waitFor({ timeout: 30_000 });
  return page;
}

/** Sets the app to light or dark, as the system would, and waits for the window to see it. */
export async function setColorScheme(app: ElectronApplication, page: Page, scheme: "dark" | "light"): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => void (nativeTheme.themeSource = source), scheme);
  await page.waitForFunction((dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark, scheme === "dark");
}

/** Sizes the window's content to `width` by `height`, and waits for the window to see it. The window is no smaller than 760 by 520. */
export async function setWindowSize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height] as const);
  await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [Math.max(760, width), Math.max(520, height)] as const);
}

/**
 * Finishes the sign-in the app last opened in the browser, as if the person
 * signed in: the app is handed back the address the sign-in ends on. The
 * scripted server takes any code.
 */
export async function finishSignIn(app: ElectronApplication): Promise<void> {
  const { opened } = await mainCalls(app);
  const signIn = [...opened].reverse().map((url) => new URL(url)).find((url) => url.searchParams.has("redirect_uri"));
  if (!signIn) throw new Error("The app hasn't opened a sign-in.");
  const back = `${signIn.searchParams.get("redirect_uri")}?state=${signIn.searchParams.get("state")}&code=e2e`;
  await app.evaluate(({ app: electronApp }, address) => void electronApp.emit("open-url", { preventDefault: () => undefined }, address), back);
}

// How long a command of the server's that the app started has to end once the app has closed.
const COMMANDS_MS = 5_000;

/** Whether any process is left in a process group. */
function groupRuns(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes the app, and ends its process when it doesn't close by itself in
 * time. The app runs in a process group of its own, with the server's
 * commands it started, which outlive it and still write into its home: they
 * are let end, and ended when they don't, so nothing of the app's is left
 * once it resolves.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const program = app.process();
  const group = program.pid!;
  const closed = app.close().then(
    () => true,
    () => false,
  );
  const inTime = await Promise.race([closed, new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000))]);
  if (!inTime || program.exitCode === null) program.kill("SIGKILL");
  const end = Date.now() + COMMANDS_MS;
  while (groupRuns(group) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  if (groupRuns(group)) process.kill(-group, "SIGKILL");
}
