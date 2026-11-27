import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// What the main process asks of Electron, recorded: the window's requests by channel, and what was opened, shown or saved.
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...values: unknown[]) => unknown>(),
  opened: [] as string[],
  shown: [] as string[],
  saveTo: undefined as string | undefined,
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...values: unknown[]) => unknown) => electron.handlers.set(channel, handler), on: () => undefined },
  shell: {
    openPath: async (path: string) => {
      electron.opened.push(path);
      return "";
    },
    showItemInFolder: (path: string) => void electron.shown.push(path),
    openExternal: async () => undefined,
  },
  dialog: { showSaveDialog: async () => ({ canceled: !electron.saveTo, filePath: electron.saveTo }) },
  app: { getPath: () => tmpdir(), getVersion: () => "1.0.0", setBadgeCount: () => true },
  Notification: { isSupported: () => false },
  powerMonitor: { getSystemIdleState: () => "active" },
  BrowserWindow: class {},
  nativeTheme: {},
  screen: {},
  session: {},
}));

const { answerWindow, signInReturned } = await import("../src/main/bridge.ts");
const { CHANNELS } = await import("../src/bridge.ts");

const mainFrame = {};
let userData: string;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "sidebots-bridge-test-"));
  electron.handlers.clear();
  electron.opened = [];
  electron.shown = [];
  electron.saveTo = undefined;
  const window = { isDestroyed: () => false, on: () => undefined, webContents: { mainFrame } };
  answerWindow({
    window: window as never,
    host: { port: 4391 } as never,
    watch: {} as never,
    key: () => "the-key",
    fetch: async (url) => new Response(`bytes of ${url.split("/").pop()}`),
    userData,
    welcome: false,
  });
});

afterEach(() => rmSync(userData, { recursive: true, force: true }));

/** Asks what the window asks on a channel, as the window's own top frame. */
const ask = (channel: string, ...values: unknown[]) => electron.handlers.get(channel)!({ senderFrame: mainFrame }, ...values);

test("a document an agent sent opens in the system's own app, under its own name in a folder of its own", async () => {
  await ask(CHANNELS.openFile, "agent-1", "attachments/1a2b3c4d-Report.pdf");
  const file = join(userData, "opened", "agent-1", "1a2b3c4d-Report.pdf", "Report.pdf");
  expect(electron.opened).toEqual([file]);
  expect(electron.shown).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("bytes of 1a2b3c4d-Report.pdf");
});

test("any other file is shown in its folder and never opened, so a click runs nothing", async () => {
  for (const name of ["1a2b3c4d-install.command", "1a2b3c4d-Tool.app", "1a2b3c4d-run.sh", "1a2b3c4d-archive.zip", "1a2b3c4d-noextension"]) {
    await ask(CHANNELS.openFile, "agent-1", `attachments/${name}`);
  }
  expect(electron.opened).toEqual([]);
  expect(electron.shown.map((path) => path.split("/").pop())).toEqual(["install.command", "Tool.app", "run.sh", "archive.zip", "noextension"]);
});

test("a path that isn't an attachment's is refused, and nothing is written", async () => {
  for (const [agentId, path] of [["agent-1", "attachments/../../escape.pdf"], ["../x", "attachments/1a2b3c4d-a.pdf"], ["agent-1", "/etc/passwd"], [1, 2]]) {
    await expect(ask(CHANNELS.openFile, agentId, path)).rejects.toThrow("Sidebots couldn't read that file.");
  }
  expect(electron.opened).toEqual([]);
  expect(electron.shown).toEqual([]);
  expect(existsSync(join(userData, "opened"))).toBe(false);
});

test("Save as writes only where the save dialog said, and nothing when it was cancelled", async () => {
  expect(await ask(CHANNELS.saveFile, "agent-1", "attachments/1a2b3c4d-Report.pdf")).toBe(false);
  electron.saveTo = join(userData, "Chosen name.pdf");
  expect(await ask(CHANNELS.saveFile, "agent-1", "attachments/1a2b3c4d-Report.pdf")).toBe(true);
  expect(readFileSync(electron.saveTo, "utf8")).toBe("bytes of 1a2b3c4d-Report.pdf");
  expect(existsSync(join(userData, "opened"))).toBe(false);
});

test("a sign-in ends only on its own address: its redirect, with the state its page was opened with", async () => {
  const redirect = "app.sidebots:/oauth2redirect";
  const page = (state: string) => `https://mcp.notion.com/authorize?client_id=1&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
  let ended: unknown = "waiting";
  const first = (ask(CHANNELS.signIn, page("first"), redirect) as Promise<string | null>).then((address) => (ended = address));
  // An address of another sign-in, of another app's, or with the redirect only at its start, ends nothing.
  for (const address of [
    `${redirect}?state=second&code=1`,
    `${redirect}?code=1`,
    `${redirect}`,
    `${redirect}/more?state=first&code=1`,
    `${redirect}.evil?state=first&code=1`,
    `com.googleusercontent.apps.1:/oauth2redirect?state=first&code=1`,
    `${redirect}?state=first%20&code=1`,
    "not an address",
  ]) {
    expect(signInReturned(address)).toBe(false);
  }
  await Promise.resolve();
  expect(ended).toBe("waiting");
  expect(signInReturned(`${redirect}?code=1&state=first`)).toBe(true);
  expect(await first).toBe(`${redirect}?code=1&state=first`);
  // Nothing waits once it has ended.
  expect(signInReturned(`${redirect}?code=1&state=first`)).toBe(false);

  // A newer sign-in ends the one before it with nothing, and the older one's address no longer ends anything.
  const older = ask(CHANNELS.signIn, page("older"), redirect);
  const newer = ask(CHANNELS.signIn, page("newer"), redirect);
  expect(await older).toBeNull();
  expect(signInReturned(`${redirect}?state=older&code=1`)).toBe(false);
  expect(signInReturned(`${redirect}?state=newer&error=access_denied`)).toBe(true);
  expect(await newer).toBe(`${redirect}?state=newer&error=access_denied`);

  // A sign-in page with no state, or not over https, isn't opened.
  expect(await ask(CHANNELS.signIn, "https://mcp.notion.com/authorize?client_id=1", redirect)).toBeNull();
  expect(await ask(CHANNELS.signIn, page("plain").replace("https:", "http:"), redirect)).toBeNull();
});
