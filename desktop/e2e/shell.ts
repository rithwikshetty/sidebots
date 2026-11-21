// Helpers for the tests of the window's frame, its start screens and its
// sidebar (startup.spec.ts, sidebar.spec.ts and window.spec.ts): reading the
// agents as a phone does, choosing from the app's menu, watching the window
// from the main process, a second launch, and the contrast of what the window
// draws.

import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { avatarFrame, type AgentWithLatest, type AvatarState } from "../../server/src/contract.ts";
import { CHANNELS } from "../src/bridge.ts";
import type { TestServer } from "./fixtures.ts";
import { PROGRAM } from "./launch.ts";
import { SERVER, childEnv } from "./server.ts";

/** The agents as the server lists them to a phone. */
export async function agentsOf(server: TestServer): Promise<AgentWithLatest[]> {
  return (await server.api("/agents")).json() as Promise<AgentWithLatest[]>;
}

/** The agent called `name`, as the server lists it to a phone. */
export async function agentNamed(server: TestServer, name: string): Promise<AgentWithLatest> {
  const agent = (await agentsOf(server)).find((each) => each.name === name);
  if (!agent) throw new Error(`The server has no agent called ${name}.`);
  return agent;
}

/** Changes an agent as a phone does. */
export async function changeOnPhone(server: TestServer, agentId: string, changes: Record<string, unknown>): Promise<void> {
  const answer = await server.api(`/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(changes) });
  if (!answer.ok) throw new Error(`Changing the agent answered ${answer.status}: ${await answer.text()}`);
}

/** The sidebar's row for an agent. */
export const rowOf = (page: Page, agentId: string): Locator => page.getByTestId(`agent-${agentId}`);

/** The rows the sidebar lists, top to bottom, as the agents' ids. */
export async function listedIds(page: Page): Promise<string[]> {
  return page.getByTestId("agent-list").locator("[data-row]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")!.slice("agent-".length)));
}

/** Waits until the sidebar lists the shown agents in the order the server gives them, newest activity first, so nothing still arriving moves a row. */
export async function settled(page: Page, server: TestServer): Promise<string[]> {
  const order = async () => (await agentsOf(server)).filter((agent) => !agent.hidden).map((agent) => agent.id);
  await expect.poll(async () => JSON.stringify(await listedIds(page)) === JSON.stringify(await order())).toBe(true);
  return listedIds(page);
}

/** Chooses an item of the app's menu by its words, as the person does from the menu bar, so the main process hands it to the window. */
export async function chooseMenu(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, label) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === label) return item;
        const inner = item.submenu ? find(item.submenu.items) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    if (!item) throw new Error(`The app's menu has no item called ${label}.`);
    (item.click as () => void)();
  }, label);
}

/** How the app's one window stands, as the main process sees it. */
export function windowState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    const [window] = all;
    return { count: all.length, visible: window.isVisible(), bounds: window.getBounds(), fullScreen: window.isFullScreen() };
  });
}

/** Has the main process record each time the window asks it to send the person to setup, in place of opening the menu bar app, which a test copy sits inside none of. */
export async function recordSetup(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => {
    const kept = globalThis as { e2eSetup?: number };
    kept.e2eSetup = 0;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => void (kept.e2eSetup = (kept.e2eSetup ?? 0) + 1));
  }, CHANNELS.openSetup);
}

/** How many times the window asked the main process to send the person to setup, since `recordSetup`. */
export function setupsAsked(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as { e2eSetup?: number }).e2eSetup ?? 0);
}

/** Keeps each notification the app shows, so a test can click one as the person would. The fixtures already keep them from showing. */
export async function keepNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const kept = globalThis as { e2eShown?: Electron.Notification[] };
    kept.e2eShown = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function (this: Electron.Notification) {
      kept.e2eShown!.push(this);
      return show.call(this);
    };
  });
}

/** Clicks the notification the app showed last, as the person does. */
export async function clickNotification(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const shown = (globalThis as { e2eShown?: Electron.Notification[] }).e2eShown ?? [];
    if (!shown.length) throw new Error("The app hasn't shown a notification.");
    shown.at(-1)!.emit("click");
  });
}

/** Opens the packaged app a second time with the same home and port, as the person does from the Dock or Finder, and resolves to its exit code once it has ended. */
export function launchAgain({ home, port }: { home: string; port: number }): Promise<number | null> {
  const env = childEnv({ SIDEBOTS_HOME: home, PORT: String(port), SIDEBOTS_RELAY: "off", SIDEBOTS_NODE: process.execPath, SIDEBOTS_SERVER: SERVER });
  const second = spawn(PROGRAM, [], { env, stdio: "ignore" });
  return new Promise((resolve, reject) => {
    const late = setTimeout(() => {
      second.kill("SIGKILL");
      reject(new Error("The second copy of the app was still running after 20 seconds."));
    }, 20_000);
    second.once("exit", (code) => {
      clearTimeout(late);
      resolve(code);
    });
  });
}

/** Runs one statement on the server's own database, as when a test takes away what a person set up on their computer. */
export function onDatabase(home: string, statement: string, ...values: (string | number)[]): void {
  const db = new DatabaseSync(join(home, "sidebots.sqlite"), { timeout: 5000 });
  try {
    db.prepare(statement).run(...values);
  } finally {
    db.close();
  }
}

/** The vertical offset into the spritesheet that a 32 pixel avatar shows for `state`, which is the row of the sheet its animation plays from. */
export function avatarRowOffset(state: AvatarState, size = 32): number {
  const frame = avatarFrame(state, 0);
  return Math.round(-frame.y * (size / frame.width) * 100) / 100;
}

/** The vertical offset into the spritesheet that an avatar element shows now, and how faded it is. */
export async function avatarShown(avatar: Locator): Promise<{ y: number; opacity: number }> {
  return avatar.evaluate((element) => {
    const style = (element as HTMLElement).style;
    return { y: Math.round(Number.parseFloat(style.backgroundPosition.split(" ")[1]) * 100) / 100, opacity: Number(getComputedStyle(element).opacity) };
  });
}

/** Text or an icon the window draws whose contrast with what is behind it is below what it needs. */
export type Faint = { what: string; ratio: number; color: string; background: string };

/**
 * Every piece of text inside `root` that shows, and every icon that names
 * itself or sits in a button that does, whose contrast with what is behind it
 * is below WCAG's: 4.5 to 1 for text, 3 to 1 for icons. Anything drawn fully
 * transparent, as a row's buttons are until the pointer rests on it, is
 * passed over. The colours are read by drawing them, so any CSS colour reads.
 */
export async function faintIn(root: Locator, { text = 4.5, icons = 3 } = {}): Promise<Faint[]> {
  return root.evaluate(
    (top, { text, icons }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const rgba = (color: string): [number, number, number, number] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "#000";
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const over = (front: number[], back: number[]) => [0, 1, 2].map((index) => front[index] * front[3] + back[index] * (1 - front[3]));
      const luminance = (rgb: number[]) => {
        const [r, g, b] = rgb.map((value) => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      /** What is behind an element: its own background and those of the elements around it, laid over each other. */
      const behind = (element: Element): number[] => {
        const layers: number[][] = [];
        for (let at: Element | null = element; at; at = at.parentElement) {
          const color = rgba(getComputedStyle(at).backgroundColor);
          if (color[3] > 0) layers.push(color);
          if (color[3] >= 1) break;
        }
        let result = [255, 255, 255];
        for (const layer of layers.reverse()) result = over(layer, result);
        return result;
      };
      /** How much of an element shows, with the opacity of everything around it. */
      const shows = (element: Element) => {
        let opacity = 1;
        for (let at: Element | null = element; at; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity);
        return opacity;
      };
      const drawn = (element: Element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility === "visible";
      };
      const faint: { what: string; ratio: number; color: string; background: string }[] = [];
      const check = (element: Element, what: string, color: string, least: number) => {
        const opacity = shows(element);
        if (opacity === 0 || !drawn(element)) return;
        const front = rgba(color);
        front[3] *= opacity;
        const back = behind(element);
        const mixed = over(front, back);
        const [light, dark] = [luminance(mixed), luminance(back)].sort((a, b) => b - a);
        const ratio = Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
        if (ratio < least) faint.push({ what, ratio, color, background: `rgb(${back.map(Math.round).join(", ")})` });
      };
      for (const element of [top, ...top.querySelectorAll("*")]) {
        if (element instanceof SVGElement) {
          if (element.tagName.toLowerCase() !== "svg") continue;
          const named = element.getAttribute("aria-label") ?? element.closest("button[aria-label]")?.getAttribute("aria-label");
          if (named) check(element, `icon: ${named}`, getComputedStyle(element).color, icons);
          continue;
        }
        const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join("").trim();
        if (own) check(element, own, getComputedStyle(element).color, text);
      }
      return faint;
    },
    { text, icons },
  );
}
