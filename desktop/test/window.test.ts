import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

// What the window asks of Electron, recorded: what its contents listen for, how they answer a new window, and what was opened in the browser.
const electron = vi.hoisted(() => ({
  heard: new Map<string, (event: never) => void>(),
  newWindow: undefined as (() => { action: string }) | undefined,
  opened: [] as string[],
  mainFrame: {},
}));

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = {
      mainFrame: electron.mainFrame,
      on: (name: string, listener: (event: never) => void) => electron.heard.set(name, listener),
      setWindowOpenHandler: (handler: () => { action: string }) => void (electron.newWindow = handler),
    };
    once(): void {}
    on(): void {}
  },
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined },
  screen: {},
  session: {},
  shell: { openExternal: async (url: string) => void electron.opened.push(url) },
}));

const { createWindow } = await import("../src/main/window.ts");

const LINK = "sidebots-page://open/a-token?to=";
const PAGE = "sidebots-page://page/agent-1/attachments/Flats.html?scheme=dark";
const page = {};

createWindow({
  preload: "preload.cjs",
  userData: mkdtempSync(join(tmpdir(), "sidebots-window-test-")),
  quitting: () => false,
  // A page's token is the handlers' to know. Here one page was served, with `a-token`.
  pageLink: (address) => (address.startsWith(LINK) ? decodeURIComponent(address.slice(LINK.length)) : undefined),
});

/** What becomes of a frame's move to `url`: whether the app let it happen, and what it opened in the browser instead. */
function move(url: string, { isMainFrame = false, initiator = page as object | null | undefined } = {}): { allowed: boolean; opened: string[] } {
  electron.opened = [];
  let allowed = true;
  electron.heard.get("will-frame-navigate")!({ url, isMainFrame, initiator, preventDefault: () => void (allowed = false) } as never);
  return { allowed, opened: electron.opened };
}

test("nothing opens another window", () => {
  expect(electron.newWindow!()).toEqual({ action: "deny" });
});

test("only the window's own document loads a page into a frame, and only a page", () => {
  expect(move(PAGE, { initiator: electron.mainFrame })).toEqual({ allowed: true, opened: [] });
  for (const url of ["https://example.com/", "sidebots-desktop://app/", "sidebots-desktop://app/api/events", "file:///etc/hosts", "about:blank", "data:text/html,hi"]) {
    expect(move(url, { initiator: electron.mainFrame })).toEqual({ allowed: false, opened: [] });
  }
});

test("a page moves its own frame nowhere, not to a web page, another page, or itself again", () => {
  for (const initiator of [page, {}, null, undefined]) {
    for (const url of ["https://example.com/", PAGE, PAGE.replace("Flats", "Other"), "sidebots-desktop://app/api/events", "sidebots://pair?code=1", "file:///etc/hosts", "about:blank", "data:text/html,hi", "blob:null/1"]) {
      expect(move(url, { initiator })).toEqual({ allowed: false, opened: [] });
    }
  }
});

test("the link a page asks for with its token opens in the browser when it is a web page's, and the frame stays", () => {
  expect(move(`${LINK}https%3A%2F%2Fexample.com%2Fa%3Fb%3D1`)).toEqual({ allowed: false, opened: ["https://example.com/a?b=1"] });
  expect(move(`${LINK}http%3A%2F%2Fexample.com%2F`)).toEqual({ allowed: false, opened: ["http://example.com/"] });
  for (const link of ["file:///etc/hosts", "javascript:alert(1)", "sidebots://pair?code=1", "sidebots-desktop://app/api/agents", "mailto:someone@example.com", "/relative", ""]) {
    expect(move(`${LINK}${encodeURIComponent(link)}`)).toEqual({ allowed: false, opened: [] });
  }
  // An address with a token the app doesn't know asks for nothing.
  expect(move("sidebots-page://open/another-token?to=https%3A%2F%2Fexample.com%2F")).toEqual({ allowed: false, opened: [] });
});

test("the window stays at its own origin, and a web address it would be moved to opens in the browser instead", () => {
  expect(move("sidebots-desktop://app/chat/agent-1", { isMainFrame: true, initiator: electron.mainFrame })).toEqual({ allowed: true, opened: [] });
  expect(move("https://example.com/away", { isMainFrame: true, initiator: electron.mainFrame })).toEqual({ allowed: false, opened: ["https://example.com/away"] });
  for (const url of ["file:///etc/hosts", PAGE, `${LINK}https%3A%2F%2Fexample.com%2F`, "sidebots-desktop://app.evil.example/"]) {
    expect(move(url, { isMainFrame: true, initiator: electron.mainFrame })).toEqual({ allowed: false, opened: [] });
  }
});
