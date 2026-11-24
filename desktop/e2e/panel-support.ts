// What the specs of the panel, Settings, notifications and the app's limits
// share: reading the scripted server as a phone does, finding things in the
// window, and the few things a test does to the main process that the
// fixtures don't, such as clicking a notification.

import type { ElectronApplication, Frame, Locator, Page } from "@playwright/test";
import type { About, AgentWithLatest, Message, Usage } from "../../server/src/contract.ts";
import { expect, type TestServer } from "./fixtures.ts";

/** Reads `read` until `done` holds, and resolves to what it read last. */
export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Gave up waiting. Last read: ${JSON.stringify(value, null, 2).slice(0, 2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const json = async <T>(server: TestServer, path: string, init?: RequestInit): Promise<T> => (await server.api(path, init)).json() as Promise<T>;
export const agents = (server: TestServer) => json<AgentWithLatest[]>(server, "/agents");
export const chat = (server: TestServer, agentId: string) => json<Message[]>(server, `/agents/${agentId}/messages`);
export const about = (server: TestServer, agentId: string) => json<About>(server, `/agents/${agentId}/about`);
export const usage = (server: TestServer) => json<Usage>(server, "/usage");

/** The agent of that name, as the server has it now. */
export async function agentNamed(server: TestServer, name: string): Promise<AgentWithLatest> {
  const found = (await agents(server)).find((agent) => agent.name === name);
  if (!found) throw new Error(`There is no agent called ${name}.`);
  return found;
}

/** Adds an agent as another device does, and resolves to it once the window lists it. */
export async function addAgent(page: Page, server: TestServer, name: string, provider: "claude" | "codex" = "claude", avatar = "cog"): Promise<AgentWithLatest> {
  const made = await server.control<AgentWithLatest>("agents", { name, provider, avatar });
  await expect(page.getByTestId(`agent-${made.id}`)).toBeVisible();
  return made;
}

/** Opens an agent's chat from its row in the sidebar, as a person does. */
export async function openChat(page: Page, agentId: string): Promise<void> {
  const row = page.getByTestId(`agent-${agentId}`);
  if (!(await row.isVisible())) await page.getByTestId("hidden-agents").click();
  await row.click();
  await expect(page.getByTestId("chat")).toBeVisible();
}

/** Opens an agent's page in the panel from the top of its chat. */
export async function openAgentPage(page: Page, agentId: string): Promise<void> {
  await openChat(page, agentId);
  await page.getByTestId("chat-agent").click();
  await expect(page.getByTestId("agent-page")).toBeVisible();
}

/** The panel's width on screen, in pixels. */
export const panelWidth = (page: Page) => page.getByTestId("panel").evaluate((panel) => Math.round(panel.getBoundingClientRect().width));

/** Drags the panel's edge by `by` pixels, toward the left when it is negative, as a person drags it. */
export async function dragPanelEdge(page: Page, by: number): Promise<void> {
  const edge = page.getByRole("separator", { name: "Panel width" });
  const box = (await edge.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by / 2, y, { steps: 4 });
  await page.mouse.move(x + by, y, { steps: 4 });
  await page.mouse.up();
}

/** Sets the panel to `width` by dragging its edge, and waits for it to be that wide. */
export async function setPanelTo(page: Page, width: number): Promise<void> {
  // A drag that ends short, as one the pointer slips off, is made again from where it ended.
  await expect
    .poll(async () => {
      const now = await panelWidth(page);
      if (now !== width) await dragPanelEdge(page, now - width);
      return panelWidth(page);
    })
    .toBe(width);
}

/** The first frame of an agent's page that has loaded, once it has. `path` narrows it to one page's file. */
export async function pageFrame(page: Page, path = ""): Promise<Frame> {
  let frame: Frame | undefined;
  await expect.poll(() => (frame = page.frames().find((each) => each.url().startsWith("sidebots-page://page/") && each.url().includes(path))) !== undefined).toBe(true);
  await frame!.waitForLoadState("load");
  await expect.poll(() => frame!.evaluate(() => document.readyState)).toBe("complete");
  return frame!;
}

/** What the main process was asked to open, show or save, and the notices it showed. */
export type Calls = { opened: string[]; files: string[]; shown: string[]; saved: string[]; notices: { title: string; body: string }[]; badge: number[] };

/**
 * Keeps each notification the main process shows, so a test can click it as
 * the person would. The fixtures record what a notification says and keep
 * it from showing; this keeps the notification itself too.
 */
export async function keepNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const kept: unknown[] = [];
    (globalThis as { e2eNotifications?: unknown[] }).e2eNotifications = kept;
    const show = Notification.prototype.show;
    Notification.prototype.show = function (this: InstanceType<typeof Notification>) {
      kept.push(this);
      show.call(this);
    };
  });
}

/** Clicks the notification shown `index`th, counting from 0, as the person clicks it in the system's list. */
export async function clickNotification(app: ElectronApplication, index: number): Promise<void> {
  await app.evaluate((_electron, at) => {
    const kept = (globalThis as { e2eNotifications?: { emit(event: string): void }[] }).e2eNotifications ?? [];
    if (!kept[at]) throw new Error(`No notification ${at} was kept.`);
    kept[at].emit("click");
  }, index);
}

/**
 * Has the window read its focus as the system gives it, which is none, as a
 * test's window never comes to the front: the window reads as one the person
 * isn't using. Playwright otherwise has every page it drives read as focused.
 */
export async function leaveWindow(page: Page, app: ElectronApplication): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  // The content keeps the focus Playwright gave it until it is told the focus has gone.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blurWebView());
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
}

/** Gives the window back the focus the test reads it with. */
export async function comeBack(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
}

/** Runs an item of the app menu by its label, as the person chooses it there. */
export async function chooseMenuItem(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, wanted) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === wanted) return item;
        const inner = item.submenu ? find(item.submenu.items) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    if (!item) throw new Error(`The menu has no item called ${wanted}.`);
    item.click();
  }, label);
}

/** A PNG of `width` by `height` in two colours, as a File a phone sends. */
export async function pngFile(name: string, width: number, height: number): Promise<File> {
  const { png } = await import("./scripted/files.ts");
  const bytes = png(width, height, (x, y) => ((Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? [30, 90, 200] : [240, 200, 60]));
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "image/png" });
}

/**
 * When a job next runs, in the words `nextTime` in client/time.ts gives it,
 * worked out in the window, whose language and region are the system's and
 * not the test runner's.
 */
export function nextTimeInWindow(page: Page, time: number): Promise<string> {
  return page.evaluate((at) => {
    const startOfDay = (value: number) => new Date(value).setHours(0, 0, 0, 0);
    const days = Math.round((startOfDay(at) - startOfDay(Date.now())) / 86_400_000);
    const date = new Date(at);
    const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (days <= 0) return `Today ${clock}`;
    if (days === 1) return `Tomorrow ${clock}`;
    if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${clock}`;
    return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock}`;
  }, time);
}

/** A PNG as the file picker hands one to the window. */
export async function pngUpload(name: string, width: number, height: number): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const file = await pngFile(name, width, height);
  return { name, mimeType: "image/png", buffer: Buffer.from(await file.arrayBuffer()) };
}

/** Every message of a chat, oldest first, paging back through it as a phone does. */
export async function allMessages(server: TestServer, agentId: string): Promise<Message[]> {
  let all = await chat(server, agentId);
  for (;;) {
    if (!all.length) return all;
    const older = await json<Message[]>(server, `/agents/${agentId}/messages?before=${all[0].id}`);
    if (!older.length) return all;
    all = [...older, ...all];
  }
}

/**
 * Scrolls the open chat with the wheel, as a person does, until `target` is
 * drawn, and brings it on screen: back towards the chat's beginning, fetching
 * older messages on the way, or `on` towards its end. The chat draws only the
 * rows near the screen, so it goes a little under a screen at a time.
 */
export async function scrollChatTo(page: Page, target: Locator, towards: "back" | "on" = "back"): Promise<void> {
  await page.getByTestId("timeline").hover();
  await expect(async () => {
    if ((await target.count()) === 0) await page.mouse.wheel(0, towards === "back" ? -500 : 500);
    await target.scrollIntoViewIfNeeded({ timeout: 250 });
  }).toPass({ intervals: [0], timeout: 60_000 });
}

/** The colour a CSS colour value draws as, as `rgb(r, g, b)`, read in the window. */
export function drawnColor(page: Page | Frame, value: string): Promise<string> {
  return page.evaluate((color) => {
    const probe = document.createElement("div");
    probe.style.color = color;
    document.body.append(probe);
    const drawn = getComputedStyle(probe).color;
    probe.remove();
    return drawn;
  }, value);
}
