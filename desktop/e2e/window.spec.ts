// The window's frame: the sidebar collapsing, coming back and being resized,
// and keeping its width and state across a restart; the panel beside the chat
// or over it as a sheet; the smallest window; the shortcuts that open the
// first nine agents; the window's own place across a restart; closing it,
// which only hides it; and full screen, which gives back the room kept for
// the traffic lights. The sizes are src/renderer/lib/view.ts's and
// src/main/window.ts's, from the design (docs/specs/2026-11-21-desktop-app.md).
//
// The screenshots for review are taken only when SHELL_SHOTS names the folder they go to:
//
//   SHELL_SHOTS=<folder> pnpm e2e e2e/window.spec.ts --workers 2 -g screenshots

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { agentNamed, chooseMenu, clickNotification, keepNotifications, launchAgain, rowOf, settled, windowState } from "./shell.ts";

/** Where a locator is drawn, which must be on screen. */
async function box(locator: Locator) {
  const drawn = await locator.boundingBox();
  if (!drawn) throw new Error(`${locator} isn't drawn.`);
  return drawn;
}

/** The left edge of the chat's column, which is where the sidebar ends. */
const chatStart = async (page: Page) => Math.round((await box(page.getByTestId("chat-column"))).x);

/** Drags the sidebar's edge by `by` pixels, as the person does with the pointer. */
async function dragEdge(page: Page, by: number) {
  const edge = await box(page.getByRole("separator", { name: "Sidebar width" }));
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by / 2, y, { steps: 4 });
  await page.mouse.move(x + by, y, { steps: 4 });
  await page.mouse.up();
}

type Box = { x: number; y: number; width: number; height: number };

/** Whether `inner` lies wholly inside `outer`, to the pixel. */
function inside(inner: Box, outer: Box) {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
}

/** Whether the element at the middle of a locator is the locator's own, so nothing lies over it. */
const onTop = (locator: Locator) =>
  locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const top = document.elementFromPoint(x + width / 2, y + height / 2);
    return top !== null && (element === top || element.contains(top));
  });

test.describe("the sidebar's width and whether it shows", () => {
  test.use({ world: "seeded" });

  test("the sidebar's button collapses it, and the chat's brings it back", async ({ page }) => {
    await expect.poll(() => chatStart(page)).toBe(280);
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect.poll(() => chatStart(page)).toBe(0);
    await expect(page.getByTestId("sidebar").locator("xpath=..")).toHaveAttribute("inert", "");
    // The button that brings it back sits in the chat's top bar, clear of the traffic lights.
    const show = page.getByTestId("chat-column").getByRole("button", { name: "Show sidebar" });
    expect((await box(show)).x).toBeGreaterThanOrEqual(80);
    await show.click();
    await expect.poll(() => chatStart(page)).toBe(280);
    await expect(page.getByTestId("sidebar").locator("xpath=..")).not.toHaveAttribute("inert", /.*/);
  });

  test("the menu's Toggle Sidebar collapses it and brings it back", async ({ page, electronApp }) => {
    await chooseMenu(electronApp, "Toggle Sidebar");
    await expect.poll(() => chatStart(page)).toBe(0);
    await chooseMenu(electronApp, "Toggle Sidebar");
    await expect.poll(() => chatStart(page)).toBe(280);
  });

  test("dragging the edge makes the sidebar wider or narrower, within its limits", async ({ page }) => {
    const edge = page.getByRole("separator", { name: "Sidebar width" });
    await dragEdge(page, 60);
    await expect(edge).toHaveAttribute("aria-valuenow", "340");
    await expect.poll(() => chatStart(page)).toBe(340);
    await dragEdge(page, 400);
    await expect(edge).toHaveAttribute("aria-valuenow", "420");
    await dragEdge(page, -600);
    await expect(edge).toHaveAttribute("aria-valuenow", "220");
    await expect.poll(() => chatStart(page)).toBe(220);
  });

  test("a double-click on the edge puts the width back", async ({ page }) => {
    await dragEdge(page, 80);
    await expect.poll(() => chatStart(page)).toBe(360);
    await page.getByRole("separator", { name: "Sidebar width" }).dblclick();
    await expect.poll(() => chatStart(page)).toBe(280);
  });

  test("the arrow keys move the edge once it has focus", async ({ page }) => {
    const edge = page.getByRole("separator", { name: "Sidebar width" });
    await edge.focus();
    await page.keyboard.press("ArrowRight");
    await expect(edge).toHaveAttribute("aria-valuenow", "296");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(edge).toHaveAttribute("aria-valuenow", "264");
  });

  test("a drag that loses the pointer ends where it had got to, and gives the cursor back", async ({ page, restartApp }) => {
    const edge = page.getByRole("separator", { name: "Sidebar width" });
    const at = await box(edge);
    const [x, y] = [at.x + at.width / 2, at.y + at.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y, { steps: 4 });
    await expect(edge).toHaveAttribute("aria-valuenow", "310");
    // The pointer is taken from the edge with the button still down, as when the system swallows the release.
    await edge.evaluate((handle) => handle.releasePointerCapture(1));
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.mouse.up();
    await expect(edge).toHaveAttribute("aria-valuenow", "310");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).cursor)).not.toBe("col-resize");
    // The pointer passing over the edge afterwards doesn't move it.
    await page.mouse.move(x + 30, y);
    await page.mouse.move(x + 33, y);
    await expect(edge).toHaveAttribute("aria-valuenow", "310");
    const again = await restartApp();
    await expect.poll(() => chatStart(again.page)).toBe(310);
  });

  test("the sidebar's width and its collapse are kept across a restart", async ({ page, restartApp }) => {
    await dragEdge(page, 60);
    await expect.poll(() => chatStart(page)).toBe(340);
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect.poll(() => chatStart(page)).toBe(0);
    const again = await restartApp();
    await expect.poll(() => chatStart(again.page)).toBe(0);
    await again.page.getByTestId("chat-column").getByRole("button", { name: "Show sidebar" }).click();
    await expect.poll(() => chatStart(again.page)).toBe(340);
  });
});

test.describe("the panel", () => {
  test.use({ world: "seeded" });

  test("in a wide window the panel opens beside the chat", async ({ page, server, setWindowSize }) => {
    await setWindowSize(1400, 860);
    await rowOf(page, (await agentNamed(server, "Atlas")).id).click();
    await page.getByTestId("chat-agent").click();
    const panel = page.getByTestId("panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("position", "relative");
    const [chat, beside] = await Promise.all([box(page.getByTestId("chat-column")), box(panel)]);
    expect(chat.x + chat.width).toBeLessThanOrEqual(beside.x + 0.5);
    expect(chat.width).toBeGreaterThanOrEqual(380);
    await expect(page.locator(".bg-scrim")).toHaveCount(0);
    expect(await onTop(page.getByTestId("message-field"))).toBe(true);
  });

  test("in a narrow window the panel lies over the chat as a sheet, which a click beside it closes", async ({ page, server, setWindowSize }) => {
    await setWindowSize(900, 700);
    await rowOf(page, (await agentNamed(server, "Atlas")).id).click();
    await page.getByTestId("chat-agent").click();
    const panel = page.getByTestId("panel");
    await expect(panel).toHaveCSS("position", "fixed");
    // The sheet slides in from the right, and then rests against the window's right edge.
    await expect.poll(async () => Math.round((await box(panel)).x + (await box(panel)).width)).toBe(900);
    const [sheet, sidebar] = await Promise.all([box(panel), box(page.getByTestId("sidebar"))]);
    expect(sheet.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
    await page.mouse.click(sidebar.width + 40, 400);
    await expect(panel).toHaveCount(0);
  });

  test("at 760 by 520, the sidebar, a chat and the panel all fit and nothing is cut off", async ({ page, server, setWindowSize }) => {
    await setWindowSize(760, 520);
    const window = { x: 0, y: 0, width: 760, height: 520 };
    await rowOf(page, (await agentNamed(server, "Atlas")).id).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Atlas");
    const [sidebar, chat] = await Promise.all([box(page.getByTestId("sidebar")), box(page.getByTestId("chat-column"))]);
    expect(inside(sidebar, window)).toBe(true);
    expect(inside(chat, window)).toBe(true);
    expect(chat.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width - 0.5);
    expect(chat.width).toBeGreaterThanOrEqual(380);
    // The chat's own parts each show whole inside its column, with nothing over them.
    for (const part of [page.getByTestId("chat-name"), page.getByTestId("chat-menu"), page.getByTestId("message-field"), page.getByTestId("model"), page.getByTestId("send"), page.getByTestId("add-files")]) {
      expect(inside(await box(part), chat), String(part)).toBe(true);
      expect(await onTop(part), String(part)).toBe(true);
    }
    const [name, menu] = await Promise.all([box(page.getByTestId("chat-name")), box(page.getByTestId("chat-menu"))]);
    expect(name.x + name.width).toBeLessThanOrEqual(menu.x);
    // The sidebar's own parts show whole too.
    for (const part of [page.getByTestId("search-button"), page.getByTestId("new-agent-button"), page.getByTestId("settings-button"), page.getByTestId("reach")]) {
      expect(inside(await box(part), sidebar), String(part)).toBe(true);
      expect(await onTop(part), String(part)).toBe(true);
    }
    await page.getByTestId("chat-agent").click();
    await expect.poll(async () => Math.round((await box(page.getByTestId("panel"))).x + (await box(page.getByTestId("panel"))).width)).toBe(760);
    const panel = await box(page.getByTestId("panel"));
    expect(inside(panel, window)).toBe(true);
    expect(panel.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width - 0.5);
    for (const part of [page.getByTestId("panel-title"), page.getByTestId("close-panel")]) {
      expect(inside(await box(part), panel), String(part)).toBe(true);
      expect(await onTop(part), String(part)).toBe(true);
    }
    expect(await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight])).toEqual([760, 520]);
  });
});

test.describe("the shortcuts and the chat's side", () => {
  test.use({ world: "seeded" });

  test("with no chat open, the window asks for an agent", async ({ page }) => {
    await expect(page.getByTestId("no-chat")).toContainText("Choose an agent to chat with.");
  });

  test("⌘1 to ⌘9 open the first nine agents of the sidebar", async ({ page, server }) => {
    // Two more agents make ten rows, so ⌘9 has one to open and the tenth has none.
    await server.control("agents", { name: "Juniper" });
    await server.control("agents", { name: "Basil" });
    await expect(page.getByTestId("agent-list").locator("[data-row]")).toHaveCount(10);
    const ids = await settled(page, server);
    const names = new Map(((await (await server.api("/agents")).json()) as { id: string; name: string }[]).map((agent) => [agent.id, agent.name]));
    for (let digit = 1; digit <= 9; digit++) {
      await page.keyboard.press(`Meta+${digit}`);
      await expect(page.getByTestId("chat-name")).toHaveText(names.get(ids[digit - 1])!);
      await expect(rowOf(page, ids[digit - 1])).toHaveAttribute("aria-current", "true");
    }
  });

  test("a digit past the agents there are opens nothing, and a hidden agent isn't counted", async ({ page, server }) => {
    const [first] = await settled(page, server);
    await page.keyboard.press("Meta+1");
    await expect(rowOf(page, first)).toHaveAttribute("aria-current", "true");
    // The seed lists eight agents and hides a ninth.
    await expect(page.getByTestId("agent-list").locator("[data-row]")).toHaveCount(8);
    expect((await agentNamed(server, "Archive")).hidden).toBe(true);
    await page.keyboard.press("Meta+9");
    await expect(rowOf(page, first)).toHaveAttribute("aria-current", "true");
  });
});

test.describe("the window itself", () => {
  // The places are well inside the screen, clear of the strip Stage Manager keeps at its left, where the system would move a window.
  test("after a move and then a resize, the window opens at the size and in the place it had", async ({ electronApp, server, restartApp }) => {
    const file = join(server.home, "desktop", "window.json");
    const kept = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
    // The person moves the window, and a moment later makes it smaller.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setPosition(400, 300));
    await expect.poll(kept).toMatchObject({ x: 400, y: 300 });
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    const place = { x: 400, y: 300, width: 1000, height: 700 };
    await expect.poll(kept).toMatchObject(place);
    const again = await restartApp();
    expect((await windowState(again.electronApp)).bounds).toEqual(place);
  });

  test("after a drag of its top left corner, the window opens at the size and in the place it had", async ({ electronApp, restartApp }) => {
    // A drag of the corner moves the window's top left and changes its size at once.
    const place = { x: 400, y: 300, width: 1000, height: 700 };
    await electronApp.evaluate(({ BrowserWindow }, place) => BrowserWindow.getAllWindows()[0].setBounds(place), place);
    expect((await windowState(electronApp)).bounds).toEqual(place);
    // The window keeps its place half a second after the person lets go.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const again = await restartApp();
    expect((await windowState(again.electronApp)).bounds).toEqual(place);
  });

  test("closing the window hides it, the app goes on, and a notification's click shows it at the message", async ({ page, electronApp, server, mainCalls }) => {
    const planner = (await (await server.api("/agents", { method: "POST", body: JSON.stringify({ name: "Planner", avatarId: "cog" }) })).json()) as { id: string; name: string };
    await expect(rowOf(page, planner.id)).toBeVisible();
    await keepNotifications(electronApp);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(async () => (await windowState(electronApp)).visible).toBe(false);
    expect((await windowState(electronApp)).count).toBe(1);
    const sent = (await server.control("deliver", { agent: "Planner", text: "The parcel is at the door." })) as { id: string };
    await expect.poll(async () => (await mainCalls()).notices).toContainEqual({ title: "Planner", body: "The parcel is at the door." });
    await clickNotification(electronApp);
    await expect.poll(async () => (await windowState(electronApp)).visible).toBe(true);
    await expect(page.getByTestId("chat-name")).toHaveText(planner.name);
    await expect(page.locator(`[data-message-id="${sent.id}"]`)).toBeInViewport();
  });

  test("after the window is closed, opening the app again shows it", async ({ page, electronApp, server }) => {
    await expect(page.getByText("No agents yet")).toBeVisible();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(async () => (await windowState(electronApp)).visible).toBe(false);
    expect(await launchAgain({ home: server.home, port: server.port })).toBe(0);
    await expect.poll(async () => (await windowState(electronApp)).visible).toBe(true);
    expect((await windowState(electronApp)).count).toBe(1);
  });

  // What macOS tells the window as it enters and leaves full screen is sent here by hand: a window that really fills the screen takes it from whoever is at the computer.
  test("told it is in full screen, the top bar gives back the room, and takes it again when told it has left", async ({ page, electronApp }) => {
    const bar = page.getByTestId("sidebar").locator("header[data-drag]");
    await expect(bar).toHaveCSS("padding-inline-start", "80px");
    await electronApp.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0].emit("enter-full-screen"));
    await expect(bar).toHaveCSS("padding-inline-start", "12px");
    await electronApp.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0].emit("leave-full-screen"));
    await expect(bar).toHaveCSS("padding-inline-start", "80px");
  });

  test("with the sidebar collapsed, the chat's top bar keeps clear of the traffic lights", async ({ page }) => {
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.getByTestId("no-chat").locator("header[data-drag]")).toHaveCSS("padding-inline-start", "80px");
  });
});

test.describe("screenshots for review", () => {
  test.skip(!process.env.SHELL_SHOTS, "SHELL_SHOTS names the folder the pictures go to.");
  const out = process.env.SHELL_SHOTS!;

  /** Takes the window as it is now, in light and then dark. */
  async function shoot(page: Page, setColorScheme: (scheme: "light" | "dark") => Promise<void>, name: string) {
    mkdirSync(out, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      await setColorScheme(scheme);
      // Lets the colours' transitions finish before the picture.
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(out, `${name}-${scheme}.png`) });
    }
  }

  test.describe("with no server", () => {
    test.use({ serverStarted: false, ready: false });
    test("screenshots: not running", async ({ page, setColorScheme }) => {
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await shoot(page, setColorScheme, "start-not-running");
    });
  });

  test.describe("with nobody set up", () => {
    test.use({ world: "nobody", ready: false });
    test("screenshots: setup", async ({ page, setColorScheme }) => {
      await expect(page.getByRole("button", { name: "Set up" })).toBeVisible();
      await shoot(page, setColorScheme, "start-setup");
    });
  });

  test.describe("with no agents", () => {
    test("screenshots: empty, and the new agent dialog", async ({ page, setColorScheme }) => {
      await expect(page.getByText("No agents yet")).toBeVisible();
      await shoot(page, setColorScheme, "sidebar-empty");
      await page.getByTestId("new-agent-button").click();
      await page.getByTestId("agent-name").fill("Nova");
      await shoot(page, setColorScheme, "new-agent");
    });
  });

  test.describe("against the seeded world", () => {
    test.use({ world: "seeded" });

    test("screenshots: the rows", async ({ page, server, setColorScheme }) => {
      await page.mouse.move(900, 300);
      await shoot(page, setColorScheme, "sidebar-seeded");
      await rowOf(page, (await agentNamed(server, "Atlas")).id).click();
      await page.getByTestId("hidden-agents").click();
      await server.control("hold", { agent: "Planner" });
      await page.mouse.move(900, 300);
      await shoot(page, setColorScheme, "sidebar-open-chat-hidden-working");
      await page.getByTestId("search-button").click();
      await page.getByTestId("search").fill("Ledger");
      await expect(page.getByRole("option").nth(2)).toBeVisible();
      await shoot(page, setColorScheme, "sidebar-search");
      await page.getByTestId("search").fill("zebra crossing quartz");
      await expect(page.getByText("No results")).toBeVisible();
      await shoot(page, setColorScheme, "sidebar-search-none");
      await page.keyboard.press("Escape");
      await rowOf(page, (await agentNamed(server, "Tidy")).id).click({ button: "right" });
      await shoot(page, setColorScheme, "sidebar-row-menu");
      await page.keyboard.press("Escape");
      await server.control("release", { agent: "Planner" });
    });

    test("screenshots: out of reach, and the other version", async ({ page, server, setColorScheme }) => {
      await server.control("outage", {});
      await expect(page.getByTestId("reach")).toHaveText("Out of reach");
      await shoot(page, setColorScheme, "sidebar-out-of-reach");
      await server.control("outage", { ms: 0 });
      await expect(page.getByTestId("reach")).toHaveText("Connected", { timeout: 20_000 });
      await server.control("contract", { version: "older" });
      await server.control("drop-events", { ms: 0 });
      await expect(page.getByRole("heading", { name: "Update Sidebots on this computer" })).toBeVisible({ timeout: 10_000 });
      await shoot(page, setColorScheme, "sidebar-older-server");
      // The main process meets the other version too, and its screen takes the agents' place.
      await expect(page.locator('[data-phase="failed"]').getByRole("heading", { name: "Update Sidebots on this computer" })).toBeVisible({ timeout: 20_000 });
      await shoot(page, setColorScheme, "start-older-server");
      await server.control("contract", { version: null });
    });

    test("screenshots: collapsed, and the smallest window with the panel", async ({ page, server, setColorScheme, setWindowSize }) => {
      await rowOf(page, (await agentNamed(server, "Atlas")).id).click();
      await page.getByRole("button", { name: "Hide sidebar" }).click();
      await shoot(page, setColorScheme, "sidebar-collapsed");
      await page.getByTestId("chat-column").getByRole("button", { name: "Show sidebar" }).click();
      await setWindowSize(760, 520);
      await page.mouse.move(600, 300);
      await shoot(page, setColorScheme, "smallest-chat");
      await page.getByTestId("chat-agent").click();
      await shoot(page, setColorScheme, "smallest-panel");
    });
  });
});
