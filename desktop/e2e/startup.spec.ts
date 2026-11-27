// How the window starts and where it stands with the server on this
// computer: no server, nobody set up, ready on a seeded and an empty world,
// the app pairing itself and pairing again, the server going away and coming
// back, a server on another version of the contract, a restart that shows the
// saved copy first, and a second launch. The words are the main process's
// (src/main/connection.ts, src/main/pairing.ts) and the phone's
// (mobile/src/components/AgentList.tsx).

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";
import { agentNamed, agentsOf, avatarRowOffset, avatarShown, faintIn, launchAgain, recordSetup, rowOf, setupsAsked, windowState } from "./shell.ts";

/** What the person calls this computer, which the sidebar's foot names. */
const computerName = () => execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"]).toString().trim();

type Device = { id: string; name: string; kind: "phone" | "desktop"; paired_at: number };

test.describe("with no server running", () => {
  test.use({ serverStarted: false, ready: false });

  test("the window says Sidebots isn't running, and Retry looks again", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Sidebots isn't running on this computer." })).toBeVisible();
    const retry = page.getByRole("button", { name: "Retry" });
    await retry.click();
    // The look runs the server's own status command, which still finds nothing, so the same words come back with Retry ready again.
    await expect(page.getByRole("heading", { name: "Sidebots isn't running on this computer." })).toBeVisible();
    await expect(retry).toBeEnabled();
    await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "failed");
  });

  test("the window becomes ready by itself once the server comes up", async ({ page, server }) => {
    await expect(page.getByRole("heading", { name: "Sidebots isn't running on this computer." })).toBeVisible();
    await server.restart();
    // Nobody presses anything: the main process keeps looking and the window follows it.
    await expect(page.locator('[data-phase="ready"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No agents yet")).toBeVisible();
  });

  test("Retry reaches a server that has come up since", async ({ page, server }) => {
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await server.restart();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator('[data-phase="ready"]')).toBeVisible({ timeout: 10_000 });
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the screen for no server reads clearly in ${scheme}`, async ({ page, setColorScheme }) => {
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await setColorScheme(scheme);
      expect(await faintIn(page.locator("[data-phase]"))).toEqual([]);
    });
  }
});

test.describe("with nobody set up", () => {
  test.use({ world: "nobody", ready: false });

  test("the setup screen says what to do", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Set up Sidebots" })).toBeVisible();
    await expect(page.getByText("Sign in to Claude Code or Codex on this computer, and your agents will be here.")).toBeVisible();
    await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "setup");
  });

  test("Set up asks the main process to send the person to setup", async ({ page, electronApp }) => {
    await expect(page.getByRole("button", { name: "Set up" })).toBeVisible();
    await recordSetup(electronApp);
    await page.getByRole("button", { name: "Set up" }).click();
    await expect.poll(() => setupsAsked(electronApp)).toBe(1);
    await expect(page.getByRole("button", { name: "Set up" })).toBeEnabled();
  });

  test("when this copy can't open setup, the window says where to set Sidebots up", async ({ page }) => {
    // A copy inside no menu bar app can't open setup, and the main process words why (src/main/bridge.ts). The person should be told rather than see the button do nothing.
    await page.getByRole("button", { name: "Set up" }).click();
    await expect(page.getByText("Set Sidebots up from its menu bar app on this computer.")).toBeVisible({ timeout: 5_000 });
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the setup screen reads clearly in ${scheme}`, async ({ page, setColorScheme }) => {
      await expect(page.getByRole("button", { name: "Set up" })).toBeVisible();
      await setColorScheme(scheme);
      expect(await faintIn(page.locator("[data-phase]"))).toEqual([]);
    });
  }
});

test.describe("opened as setup ends for someone new", () => {
  test.use({ world: "nobody", ready: false, welcome: true });

  test("the window shows the apps to connect and the code for a phone, and then the first agent's chat", async ({ page, server, mainCalls, finishSignIn }) => {
    await expect(page.getByRole("heading", { name: "Set up Sidebots" })).toBeVisible();
    // The menu bar app adds the person, with the brief at the time they chose.
    await server.cli("add-person", "Sam", "claude", join(server.home, "claude"), "--brief", "07:00");

    const apps = page.getByTestId("welcome-apps");
    await expect(page.getByRole("heading", { name: "Show Ruby your day" })).toBeVisible({ timeout: 15_000 });
    await expect(apps.getByTestId("connection-calendar")).toBeVisible();
    await expect(apps.getByTestId("connection-gmail")).toBeVisible();
    await expect(apps.getByTestId("connection-notion")).toHaveCount(0);
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    await expect(page.getByTestId("welcome-next")).toHaveText("Not now");

    await apps.getByRole("button", { name: "Connect Google Calendar" }).click();
    await expect.poll(async () => (await mainCalls()).opened).toEqual([expect.stringMatching(/^https:\/\/accounts\.google\.com\//)]);
    await finishSignIn();
    await expect(apps.getByTestId("connection-calendar")).toContainText("Connected as tester@example.com");
    await expect(page.getByTestId("welcome-next")).toHaveText("Continue");
    await page.getByTestId("welcome-next").click();

    await expect(page.getByRole("heading", { name: "Take Ruby with you" })).toBeVisible();
    await expect(page.getByTestId("welcome-phone").getByTestId("pairing")).toBeVisible();
    await page.getByTestId("welcome-phone").getByRole("button", { name: "Not now" }).click();

    await expect(page.getByTestId("chat-name")).toHaveText("Ruby");
    await expect(page.getByTestId("timeline")).toContainText("Every morning at 7 I'll send you a short brief");
    await expect(page.getByTestId("sidebar")).toBeVisible();
  });
});

test.describe("a ready start", () => {
  test.describe("against the seeded world", () => {
    test.use({ world: "seeded" });

    test("the window opens on the chat it last showed", async ({ page, server, restartApp }) => {
      const atlas = await agentNamed(server, "Atlas");
      await rowOf(page, atlas.id).click();
      await expect(page.getByTestId("chat-name")).toHaveText("Atlas");
      const again = await restartApp();
      await expect(again.page.getByTestId("chat-name")).toHaveText("Atlas");
    });

    test("the agents are listed, and the foot names the computer and says it is connected", async ({ page, server }) => {
      for (const agent of (await agentsOf(server)).filter((each) => !each.hidden)) await expect(rowOf(page, agent.id)).toBeVisible();
      await expect(page.getByTestId("machine")).toHaveText(computerName());
      await expect(page.getByTestId("reach")).toHaveText("Connected");
      await expect(page.getByText("Choose an agent to chat with.")).toBeVisible();
    });
  });

  test.describe("against an empty world", () => {
    test("the window points at the first agent, with no search to use", async ({ page }) => {
      await expect(page.getByText("No agents yet")).toBeVisible();
      await expect(page.getByText("Click + to make one, then tell it what it's for.")).toBeVisible();
      await expect(page.getByTestId("no-chat").getByRole("button", { name: "New agent" })).toBeVisible();
      await expect(page.getByTestId("new-agent-button")).toBeVisible();
      await expect(page.getByTestId("search-button")).toHaveCount(0);
      await expect(page.getByTestId("reach")).toHaveText("Connected");
    });
  });
});

test.describe("pairing", () => {
  test("the app pairs itself as this computer's desktop, and keeps its key where only this account can read it", async ({ page, server }) => {
    await expect(page.getByTestId("reach")).toHaveText("Connected");
    const devices = JSON.parse(await server.cli("devices", "--json")) as Device[];
    const desktops = devices.filter((device) => device.kind === "desktop");
    expect(desktops).toHaveLength(1);
    expect(desktops[0].name).toBe(computerName());
    const file = join(server.home, "desktop", "pairing.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const keys = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(Object.keys(keys)).toEqual([`127.0.0.1:${server.port}`]);
    // The key stays in the main process: nothing the window can read holds it.
    const key = keys[`127.0.0.1:${server.port}`];
    const seen = await page.evaluate(() => JSON.stringify({ desktop: Object.keys(window.desktop), storage: { ...localStorage }, cookie: document.cookie }));
    expect(seen).not.toContain(key);
  });

  test("after its device is removed, the app pairs again by itself and still works", async ({ page, server }) => {
    const agent = (await (await server.api("/agents", { method: "POST", body: JSON.stringify({ name: "Juniper", avatarId: "cog" }) })).json()) as { id: string };
    await expect(rowOf(page, agent.id)).toBeVisible();
    await page.evaluate(() => {
      const heard: string[] = [];
      (window as { heard?: string[] }).heard = heard;
      window.desktop.onConnection((connection) => heard.push(connection.phase));
    });
    const before = (JSON.parse(await server.cli("devices", "--json")) as Device[]).find((device) => device.kind === "desktop")!;
    await server.cli("remove-device", before.id);
    // The app notices within a look or two and pairs again, telling the window it is starting and then ready, with no one pressing anything.
    await expect.poll(() => page.evaluate(() => (window as { heard?: string[] }).heard), { timeout: 20_000 }).toEqual(["starting", "ready"]);
    const desktops = (JSON.parse(await server.cli("devices", "--json")) as Device[]).filter((device) => device.kind === "desktop");
    expect(desktops).toHaveLength(1);
    expect(desktops[0].id).not.toBe(before.id);
    await expect(page.getByTestId("reach")).toHaveText("Connected", { timeout: 15_000 });
    await rowOf(page, agent.id).click();
    await page.getByTestId("message-field").fill("hello");
    await page.getByTestId("message-field").press("Enter");
    await expect(page.getByTestId("chat").getByText("Hi Tester! What can I help with today?")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("the server going away and coming back", () => {
  test.use({ world: "seeded" });

  test("while Sidebots is out of reach, the sidebar says so and the avatars rest", async ({ page, server }) => {
    const ledger = await agentNamed(server, "Ledger");
    await expect(page.getByTestId("reach")).toHaveText("Connected");
    await server.control("outage", {});
    await expect(page.getByTestId("reach")).toHaveText("Out of reach");
    const avatar = rowOf(page, ledger.id).locator("span[aria-hidden]").first();
    // Ledger has unread replies, so its avatar would play its replied row; out of reach it rests, faded back.
    await expect.poll(() => avatarShown(avatar)).toEqual({ y: avatarRowOffset("resting"), opacity: 0.4 });
    await server.control("outage", { ms: 0 });
    await expect(page.getByTestId("reach")).toHaveText("Connected", { timeout: 20_000 });
    await expect.poll(() => avatarShown(avatar)).toEqual({ y: avatarRowOffset("replied"), opacity: 1 });
  });

  test("when the server stops, the agents stay listed and the sidebar says Sidebots is out of reach", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await server.stop();
    await expect(page.getByTestId("reach")).toHaveText("Out of reach");
    // The saved copy is there to read while the server is away, as on the phone. It should still be there after the main process has looked again.
    await page.waitForTimeout(7_000);
    await expect(rowOf(page, atlas.id)).toBeVisible();
    await expect(page.getByTestId("reach")).toHaveText("Out of reach");
  });

  test("when the server comes back after a stop, the window is ready again by itself", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await server.stop();
    await expect(page.getByTestId("reach")).not.toHaveText("Connected");
    await server.restart();
    await expect(page.locator('[data-phase="ready"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("reach")).toHaveText("Connected", { timeout: 20_000 });
    await expect(rowOf(page, atlas.id)).toBeVisible();
  });

  test("once the stream is back, what changed on another device meanwhile shows here", async ({ page, server }) => {
    const [ledger, pip] = await Promise.all([agentNamed(server, "Ledger"), agentNamed(server, "Pip")]);
    await expect(rowOf(page, ledger.id)).toBeVisible();
    await server.control("drop-events", { ms: 600_000 });
    await expect(page.getByTestId("reach")).toHaveText("Out of reach");
    // Another device renames one agent, deletes another, adds a third, and a reply arrives, all while this window hears nothing.
    await server.api(`/agents/${ledger.id}`, { method: "PATCH", body: JSON.stringify({ name: "Ledger Two" }) });
    await server.api(`/agents/${pip.id}`, { method: "DELETE" });
    const added = (await (await server.api("/agents", { method: "POST", body: JSON.stringify({ name: "Juniper", avatarId: "cog" }) })).json()) as { id: string };
    await server.control("deliver", { agent: "Planner", text: "The parcel has arrived." });
    await page.waitForTimeout(1_000);
    await expect(rowOf(page, ledger.id)).toContainText("Ledger");
    await expect(rowOf(page, pip.id)).toBeVisible();
    await server.control("drop-events", { ms: 0 });
    await expect(page.getByTestId("reach")).toHaveText("Connected", { timeout: 30_000 });
    await expect(rowOf(page, ledger.id)).toContainText("Ledger Two");
    await expect(rowOf(page, pip.id)).toHaveCount(0);
    await expect(rowOf(page, added.id)).toContainText("Say hello");
    await expect(page.getByTestId("agent-list").locator("[data-row]").first()).toContainText("The parcel has arrived.");
  });
});

test.describe("a server on another version of the contract", () => {
  test.use({ world: "seeded" });

  test("an older server says to update Sidebots on this computer in place of the agents, and the agents come back once it matches", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await server.control("contract", { version: "older" });
    await expect(page.getByRole("heading", { name: "Update Sidebots on this computer" })).toBeVisible({ timeout: 20_000 });
    await expect(rowOf(page, atlas.id)).toHaveCount(0);
    await server.control("contract", { version: null });
    await expect(page.locator('[data-phase="ready"]')).toBeVisible({ timeout: 20_000 });
    await expect(rowOf(page, atlas.id)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("reach")).toHaveText("Connected", { timeout: 20_000 });
  });

  test("a newer server says to update this app in place of the agents, and the agents come back once it matches", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await server.control("contract", { version: "newer" });
    await expect(page.getByRole("heading", { name: "Update this app" })).toBeVisible({ timeout: 20_000 });
    await expect(rowOf(page, atlas.id)).toHaveCount(0);
    await server.control("contract", { version: null });
    await expect(rowOf(page, atlas.id)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("reach")).toHaveText("Connected", { timeout: 20_000 });
  });

  test("the sidebar names the side to update in the phone's words when the event stream meets the other version first", async ({ page, server }) => {
    // The stream is asked again as soon as it drops, before the main process looks again, so the sidebar's own words show.
    await server.control("contract", { version: "older" });
    await server.control("drop-events", { ms: 0 });
    await expect(page.getByRole("heading", { name: "Update Sidebots on this computer" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("It's older than this app. Your agents show here again once it's updated.")).toBeVisible();
    await expect(page.getByTestId("reach")).toHaveText("Update Sidebots on this computer");
    await expect(page.getByTestId("new-agent-button")).toHaveCount(0);
    await server.control("contract", { version: null });
  });

  test("the sidebar says to update this app in the phone's words when the server is newer", async ({ page, server }) => {
    await server.control("contract", { version: "newer" });
    await server.control("drop-events", { ms: 0 });
    await expect(page.getByRole("heading", { name: "Update this app" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Sidebots on this computer is newer than this app. Your agents show here again once it's updated.")).toBeVisible();
    await server.control("contract", { version: null });
  });
});

test.describe("restarting the app", () => {
  test.use({ world: "seeded" });

  test("a restarted app shows its saved copy at once, then the live state", async ({ page, server, restartApp }) => {
    const ledger = await agentNamed(server, "Ledger");
    await expect(rowOf(page, ledger.id)).toBeVisible();
    // The window saves its copy a moment after it changes, which a person who quits takes far longer than.
    await expect.poll(() => page.evaluate((id) => localStorage.getItem("cache-9")?.includes(id) ?? false, ledger.id)).toBe(true);
    // The window hears nothing more, a phone renames Ledger, and the server stops answering before the app opens again.
    await server.control("drop-events", { ms: 600_000 });
    await expect(page.getByTestId("reach")).toHaveText("Out of reach");
    await server.api(`/agents/${ledger.id}`, { method: "PATCH", body: JSON.stringify({ name: "Ledger Two" }) });
    await server.control("outage", {});
    const again = await restartApp();
    await expect(rowOf(again.page, ledger.id)).toContainText("Ledger");
    await expect(rowOf(again.page, ledger.id)).not.toContainText("Ledger Two");
    await expect(again.page.getByTestId("reach")).toHaveText("Out of reach");
    await server.control("outage", { ms: 0 });
    await server.control("drop-events", { ms: 0 });
    await expect(rowOf(again.page, ledger.id)).toContainText("Ledger Two", { timeout: 30_000 });
    await expect(again.page.getByTestId("reach")).toHaveText("Connected");
  });
});

test.describe("a second launch", () => {
  test("opening the app again brings the first window forward instead of opening another", async ({ page, electronApp, server }) => {
    await expect(page.getByText("No agents yet")).toBeVisible();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await expect.poll(async () => (await windowState(electronApp)).visible).toBe(false);
    expect(await launchAgain({ home: server.home, port: server.port })).toBe(0);
    await expect.poll(async () => (await windowState(electronApp)).visible).toBe(true);
    expect((await windowState(electronApp)).count).toBe(1);
  });
});
