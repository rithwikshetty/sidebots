// Settings, in a dialog over the window: Usage, with the plan's limits and
// what the agents used; Connections, the apps the agents can use as the
// person; Phones, the phones paired with the computer and the code that
// pairs another; and About. The phone's versions are mobile/src/app/usage.tsx
// and connections.tsx, whose words these sections use, and the Mac's panel
// and mac/Sources/PairView.swift for Phones.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { CONNECTIONS, CONTRACT_HEADER, CONTRACT_VERSION, PROVIDERS, type Connected } from "../../server/src/contract.ts";
import { COST_NOTE, KINDS, TOKENS_NOTE, amount, dollars, sum, tokens, usedBy } from "../../client/usage.ts";
import { expect, test } from "./fixtures.ts";
import type { TestServer } from "./fixtures.ts";
import { DESKTOP } from "./server.ts";
import { addAgent, agentNamed, chat, chooseMenuItem, json, openChat, until, usage } from "./panel-support.ts";

type Device = { id: string; name: string; kind: "phone" | "desktop"; paired_at: number };
const devices = async (server: TestServer) => JSON.parse(await server.cli("devices", "--json")) as Device[];

/** Opens Settings from the gear at the foot of the sidebar, at a section when one is named. */
async function openSettings(page: Page, section?: "usage" | "connections" | "phones" | "about"): Promise<void> {
  await page.getByTestId("settings-button").click();
  await expect(page.getByTestId("settings")).toBeVisible();
  if (section) await page.getByTestId(`settings-${section}`).click();
  if (section) await expect(page.getByTestId(`settings-body-${section}`)).toBeVisible();
}

/** Comes back from the sign-in the app opened, as a person who declined it in the browser. */
async function declineSignIn(app: ElectronApplication): Promise<void> {
  const opened = await app.evaluate(() => (globalThis as { e2e?: { opened: string[] } }).e2e!.opened);
  const signIn = [...opened].reverse().map((url) => new URL(url)).find((url) => url.searchParams.has("redirect_uri"))!;
  const back = `${signIn.searchParams.get("redirect_uri")}?state=${signIn.searchParams.get("state")}&error=access_denied`;
  await app.evaluate(({ app: electronApp }, address) => void electronApp.emit("open-url", { preventDefault: () => undefined }, address), back);
}

/** Uses a pairing link as a phone does: the code in it pairs one device through the server's `/pair`. */
async function pairWith(server: TestServer, link: string, name: string): Promise<Response> {
  const code = new URL(link.replace(/^sidebots:/, "https:")).searchParams.get("code");
  return fetch(`${server.url}/pair`, {
    method: "POST",
    headers: { Authorization: `Pairing ${code}`, "Content-Type": "application/json", [CONTRACT_HEADER]: String(CONTRACT_VERSION) },
    body: JSON.stringify({ name, kind: "phone" }),
  });
}

/** When a phone paired, in the words the Phones section uses, worked out in the window, whose language and region are the system's. */
const pairedWords = (page: Page, time: number) =>
  page.evaluate((at) => `Paired ${new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}`, time);

// Phones runs the server's own commands, which write to the test's home. The home is deleted once a test ends, so each test waits first for any command the app still runs.
test.afterEach(async ({ electronApp }) => {
  const pid = electronApp.process().pid;
  const running = () => {
    try {
      return execFileSync("/usr/bin/pgrep", ["-P", String(pid), "-f", "src/main.ts"], { encoding: "utf8" }).trim() !== "";
    } catch {
      return false;
    }
  };
  await expect.poll(running, { timeout: 15_000 }).toBe(false);
});

test.describe("opening Settings", () => {
  test("the gear opens Settings at Usage, and Esc and Close each close it", async ({ page }) => {
    await openSettings(page);
    await expect(page.getByTestId("settings-usage")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("settings-body-usage")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings")).toBeHidden();
    await openSettings(page);
    await page.getByTestId("settings").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("settings")).toBeHidden();
  });

  test("Settings… in the app menu opens Settings, and closes the new agent dialog first", async ({ page, electronApp }) => {
    await page.getByTestId("new-agent-button").click();
    await expect(page.getByTestId("agent-name")).toBeVisible();
    await chooseMenuItem(electronApp, "Settings…");
    await expect(page.getByTestId("settings")).toBeVisible();
    await expect(page.getByTestId("agent-name")).toBeHidden();
  });

  test("each section opens with a click, and the arrow keys move between them, round from the last to the first", async ({ page }) => {
    await openSettings(page);
    for (const section of ["connections", "phones", "about", "usage"] as const) {
      await page.getByTestId(`settings-${section}`).click();
      await expect(page.getByTestId(`settings-${section}`)).toHaveAttribute("aria-current", "true");
      await expect(page.getByTestId(`settings-body-${section}`)).toBeVisible();
    }
    await page.getByTestId("settings-usage").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("settings-connections")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("settings-connections")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("settings-about")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("settings-usage")).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("settings-about")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("settings-body-about")).toBeVisible();
  });

  test("Settings fits the smallest window", async ({ page, setWindowSize }) => {
    await setWindowSize(760, 520);
    await openSettings(page, "phones");
    const box = (await page.getByTestId("settings").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(760);
    expect(box.y + box.height).toBeLessThanOrEqual(520);
    await expect(page.getByTestId("pair-phone")).toBeVisible();
  });
});

test.describe("Usage", () => {
  test.use({ world: "seeded" });

  test("a plan's limits each say how much is left and when it resets, a nearly used one in few words and one over as None left", async ({ page }) => {
    await openSettings(page, "usage");
    const plan = page.getByTestId("usage-claude");
    await expect(plan.getByRole("heading", { name: `${PROVIDERS.claude.name} plan` })).toBeVisible();
    const limits = plan.getByTestId("limit");
    await expect(limits).toHaveCount(4);
    const expected = [
      ["5-hour limit", "62% left", 62],
      ["Weekly limit", "7% left", 7],
      ["Opus limit", "None left", 0],
      ["Fable limit", "88% left", 88],
    ] as const;
    for (const [index, [name, left, value]] of expected.entries()) {
      const row = limits.nth(index);
      await expect(row).toContainText(name);
      await expect(row).toContainText(left);
      await expect(row).toContainText(/Resets \S/);
      await expect(row.getByRole("progressbar", { name: `${name}, left` })).toHaveAttribute("aria-valuenow", String(value));
    }
    await expect(limits.nth(2).getByText("None left")).toHaveClass(/text-danger/);
    await expect(plan).toContainText(new RegExp(`As ${PROVIDERS.claude.name} said, .+\\. It counts what you use outside Sidebots too\\.`));
  });

  test("an account on an API key says it has no plan to run out", async ({ page }) => {
    await openSettings(page, "usage");
    const codex = page.getByTestId("usage-codex");
    await expect(codex.getByRole("heading", { name: PROVIDERS.codex.name, exact: true })).toBeVisible();
    await expect(codex).toContainText("Your agents run on an API key, which has no plan to run out. The key's account is billed for what they use.");
    await expect(codex.getByTestId("limit")).toHaveCount(0);
  });

  test("the last days show their cost, and Tokens shows the tokens they used", async ({ page, server }) => {
    const used = await usage(server);
    await openSettings(page, "usage");
    const days = page.getByTestId("usage-days");
    await expect(days.getByRole("heading", { name: "Last 7 days" })).toBeVisible();
    await expect(page.getByTestId("usage-amount")).toHaveText(amount("cost", sum(used.days)));
    await expect(days).toContainText(COST_NOTE);
    await expect(days.getByRole("group", { name: "Days" }).getByRole("button")).toHaveCount(7);
    await days.getByRole("radio", { name: "Tokens" }).click();
    await expect(page.getByTestId("usage-amount")).toHaveText(tokens(sum(used.days).tokens));
    await expect(days).toContainText(TOKENS_NOTE);
    await days.getByRole("radio", { name: "Cost" }).click();
    await expect(page.getByTestId("usage-amount")).toHaveText(dollars(sum(used.days).cost));
  });

  test("a day picked in the bars stays shown once the pointer leaves, and a click on it again lets it go", async ({ page, server }) => {
    const { days } = await usage(server);
    const today = days.at(-1)!;
    await openSettings(page, "usage");
    const bar = page.getByTestId(`day-${today.day}`);
    await bar.click();
    await expect(bar).toHaveAttribute("aria-pressed", "true");
    // The pointer goes off the bars, to the section's heading.
    await page.getByTestId("settings-body-usage").getByRole("heading", { name: "Usage" }).hover();
    await expect(page.getByTestId("usage-amount")).toHaveText(dollars(today.cost));
    await expect(page.getByTestId("usage-total")).toContainText("Today");
    await bar.click();
    await expect(bar).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("settings-body-usage").getByRole("heading", { name: "Usage" }).hover();
    await expect(page.getByTestId("usage-amount")).toHaveText(dollars(sum(days).cost));
    await expect(page.getByTestId("usage-total")).toContainText("7 days");
  });

  test("the agents that ran are listed, the one that used most first, each with how its use splits", async ({ page, server }) => {
    const used = await usage(server);
    const all = (await json<{ id: string; name: string }[]>(server, "/agents")).map((agent) => ({ agent, used: usedBy(used, agent.id) })).filter((row) => row.used.length);
    const sorted = all.map((row) => ({ ...row, total: sum(row.used) })).sort((a, b) => b.total.cost - a.total.cost);
    await openSettings(page, "usage");
    const rows = page.locator('[data-testid^="usage-agent-"]');
    await expect(rows).toHaveCount(sorted.length);
    for (const [index, { agent, used: split, total }] of sorted.entries()) {
      const row = rows.nth(index);
      await expect(row).toHaveAttribute("data-testid", `usage-agent-${agent.id}`);
      await expect(row).toContainText(agent.name);
      await expect(row).toContainText(dollars(total.cost));
      await expect(row).toContainText(split.map((each) => `${KINDS[each.kind]} ${dollars(each.cost)}`).join(" · "));
    }
    // Atlas made a fresh start as well as replies, so its line names both.
    const atlas = await agentNamed(server, "Atlas");
    await expect(page.getByTestId(`usage-agent-${atlas.id}`)).toContainText(/Replies \$\d+\.\d\d · Fresh starts \$0\.04/);
  });
});

test.describe("Usage with nothing used", () => {
  test("says no agent has run a turn, with no measure to pick", async ({ page }) => {
    await openSettings(page, "usage");
    const days = page.getByTestId("usage-days");
    await expect(days).toContainText("No agent has run a turn.");
    await expect(days.getByRole("radiogroup", { name: "Measure" })).toHaveCount(0);
    await expect(page.locator('[data-testid^="usage-agent-"]')).toHaveCount(0);
    await expect(page.getByTestId("usage-codex")).toContainText("Your agents run on an API key");
  });
});

test.describe("Connections", () => {
  test.use({ world: "seeded" });

  test("lists each app with its logo, what connecting it allows or the account it is connected as", async ({ page }) => {
    await openSettings(page, "connections");
    const body = page.getByTestId("settings-body-connections");
    await expect(body).toContainText("An app you connect is there for all your agents. You sign in on the app's own page, and what it gives Sidebots stays on your computer.");
    for (const id of Object.keys(CONNECTIONS) as (keyof typeof CONNECTIONS)[]) {
      const row = page.getByTestId(`connection-${id}`);
      await expect(row).toContainText(CONNECTIONS[id].name);
      await expect(row.locator("svg path")).toHaveAttribute("d", CONNECTIONS[id].logo.path);
    }
    await expect(page.getByTestId("connection-gmail")).toContainText("Connected as tester@example.com");
    await expect(page.getByTestId("connection-gmail").getByRole("button", { name: "Remove Gmail" })).toBeVisible();
    await expect(page.getByTestId("connection-calendar")).toContainText(CONNECTIONS.calendar.allows);
    await expect(page.getByTestId("connection-calendar").getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  });

  test("Connect waits for the sign-in in the browser, and finishing it connects the app", async ({ page, server, mainCalls, finishSignIn }) => {
    await openSettings(page, "connections");
    const row = page.getByTestId("connection-calendar");
    await row.getByRole("button", { name: "Connect Google Calendar" }).click();
    await expect(row.getByRole("status")).toHaveText("Finish signing in in your browser…");
    await expect(row.getByRole("button", { name: "Cancel signing in to Google Calendar" })).toBeVisible();
    await expect.poll(async () => (await mainCalls()).opened).toEqual([expect.stringMatching(/^https:\/\/accounts\.google\.com\//)]);
    await finishSignIn();
    await expect(row).toContainText("Connected as tester@example.com");
    await expect(row.getByRole("button", { name: "Remove Google Calendar" })).toBeVisible();
    const listed = await json<Connected[]>(server, "/connections");
    expect(listed.find((each) => each.connection === "calendar")?.account).toBe("tester@example.com");
  });

  test("Cancel stops waiting for the sign-in", async ({ page }) => {
    await openSettings(page, "connections");
    const row = page.getByTestId("connection-notion");
    await row.getByRole("button", { name: "Connect Notion" }).click();
    await row.getByRole("button", { name: "Cancel signing in to Notion" }).click();
    await expect(row.getByRole("status")).toHaveCount(0);
    await expect(row).toContainText(CONNECTIONS.notion.allows);
    await expect(row.getByRole("button", { name: "Connect Notion" })).toBeVisible();
  });

  test("a sign-in the person still finishes after Cancel connects the app all the same", async ({ page, mainCalls, finishSignIn }) => {
    await openSettings(page, "connections");
    const row = page.getByTestId("connection-calendar");
    await row.getByRole("button", { name: "Connect Google Calendar" }).click();
    await row.getByRole("button", { name: "Cancel signing in to Google Calendar" }).click();
    await expect.poll(async () => (await mainCalls()).opened.length).toBe(1);
    await finishSignIn();
    await expect(row).toContainText("Connected as tester@example.com");
  });

  test("a sign-in that fails says Couldn't connect, with the reason, and the app stays unconnected", async ({ page, server, electronApp, mainCalls }) => {
    await openSettings(page, "connections");
    const row = page.getByTestId("connection-calendar");
    await row.getByRole("button", { name: "Connect Google Calendar" }).click();
    await expect.poll(async () => (await mainCalls()).opened.length).toBe(1);
    await declineSignIn(electronApp);
    const toast = page.getByTestId("toast");
    await expect(toast).toContainText("Couldn't connect");
    await expect(toast).toContainText("Google didn't sign you in.");
    await expect(row.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
    const listed = await json<Connected[]>(server, "/connections");
    expect(listed.find((each) => each.connection === "calendar")?.account).toBeNull();
  });

  test("Remove asks first, then the app is no longer connected on the server", async ({ page, server }) => {
    await openSettings(page, "connections");
    const row = page.getByTestId("connection-gmail");
    await row.getByRole("button", { name: "Remove Gmail" }).click();
    const confirm = page.getByTestId("confirm");
    await expect(confirm).toContainText("Remove Gmail?");
    await expect(confirm).toContainText("None of your agents can use it until you connect it again.");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(row).toContainText("Connected as tester@example.com");
    await row.getByRole("button", { name: "Remove Gmail" }).click();
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(row.getByRole("button", { name: "Connect Gmail" })).toBeVisible();
    await expect(row).toContainText(CONNECTIONS.gmail.allows);
    await until(() => json<Connected[]>(server, "/connections"), (listed) => listed.find((each) => each.connection === "gmail")?.account === null);
  });
});

test.describe("an agent that waits on a connection", () => {
  test("goes on once the app is connected from Settings", async ({ page, server, mainCalls, finishSignIn }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await page.getByTestId("message-field").fill("/connect calendar");
    await page.getByTestId("message-field").press("Enter");
    await expect(page.getByTestId("ask-card")).toContainText("Connect Google Calendar", { timeout: 15_000 });
    await openSettings(page, "connections");
    await page.getByTestId("connection-calendar").getByRole("button", { name: "Connect Google Calendar" }).click();
    await expect.poll(async () => (await mainCalls()).opened.length).toBe(1);
    await finishSignIn();
    await expect(page.getByTestId("connection-calendar")).toContainText("Connected as tester@example.com");
    await until(() => chat(server, agent.id), (messages) => messages.some((message) => message.body === "Google Calendar is connected. Ask me again and I'll take a look."));
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ask-outcome")).toHaveText("Connected");
    await expect(page.getByTestId("timeline")).toContainText("Google Calendar is connected. Ask me again and I'll take a look.");
  });
});

test.describe("Phones", () => {
  test.use({ world: "seeded" });

  test("lists the paired phone with when it paired, and never the desktop itself", async ({ page, server }) => {
    const listed = await devices(server);
    const iphone = listed.find((device) => device.name === "Tester's iPhone")!;
    const desktop = listed.find((device) => device.kind === "desktop")!;
    expect(desktop).toBeDefined();
    await openSettings(page, "phones");
    const phones = page.getByTestId("phones");
    await expect(phones.locator('[data-testid^="phone-"]')).toHaveCount(listed.filter((device) => device.kind === "phone").length);
    const row = page.getByTestId(`phone-${iphone.id}`);
    await expect(row).toContainText("Tester's iPhone");
    await expect(row).toContainText(await pairedWords(page, iphone.paired_at));
    await expect(page.getByTestId(`phone-${desktop.id}`)).toHaveCount(0);
    await expect(phones).not.toContainText(desktop.name);
  });

  test("Remove asks first, then the phone leaves the list and the server", async ({ page, server }) => {
    const iphone = (await devices(server)).find((device) => device.name === "Tester's iPhone")!;
    await openSettings(page, "phones");
    await page.getByRole("button", { name: "Remove Tester's iPhone" }).click();
    const confirm = page.getByTestId("confirm");
    await expect(confirm).toContainText("Remove Tester's iPhone?");
    await expect(confirm).toContainText("It will need a new code to pair again.");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId(`phone-${iphone.id}`)).toBeVisible();
    await page.getByRole("button", { name: "Remove Tester's iPhone" }).click();
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId(`phone-${iphone.id}`)).toHaveCount(0);
    await expect(page.getByTestId("phones")).toContainText("No phones yet");
    expect((await devices(server)).some((device) => device.id === iphone.id)).toBe(false);
  });

  test("Pair a phone shows a QR code and the link it holds, for this computer's address", async ({ page, server }) => {
    await openSettings(page, "phones");
    await page.getByTestId("pair-phone").click();
    const pairing = page.getByTestId("pairing");
    await expect(pairing.getByTestId("pairing-code")).toBeVisible();
    await expect(pairing.getByRole("img", { name: "QR code that pairs a phone" })).toBeVisible();
    await expect(pairing).toContainText("Open Sidebots on your phone and point its camera at this code.");
    await expect(pairing.getByTestId("pairing-link")).toHaveText(new RegExp(`^sidebots://pair\\?host=127\\.0\\.0\\.1%3A${server.port}&code=\\S+$`));
    await pairing.getByRole("button", { name: "Cancel" }).click();
    await expect(pairing).toBeHidden();
    await expect(page.getByTestId("pair-phone")).toBeVisible();
  });

  test("a phone that pairs with the link shows as paired, and joins the list", async ({ page, server }) => {
    await openSettings(page, "phones");
    await page.getByTestId("pair-phone").click();
    const link = (await page.getByTestId("pairing-link").textContent())!;
    const answer = await pairWith(server, link, "Sam's iPhone");
    expect(answer.ok).toBe(true);
    const paired = page.getByTestId("paired");
    await expect(paired).toContainText("Paired with Sam's iPhone", { timeout: 10_000 });
    await expect(paired).toContainText("Your agents are on your phone now.");
    const sam = (await devices(server)).find((device) => device.name === "Sam's iPhone")!;
    await expect(page.getByTestId(`phone-${sam.id}`)).toContainText("Sam's iPhone");
    await paired.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("pair-phone")).toBeVisible();
  });

  test("Pair another phone makes a fresh code", async ({ page, server }) => {
    await openSettings(page, "phones");
    await page.getByTestId("pair-phone").click();
    const first = (await page.getByTestId("pairing-link").textContent())!;
    await pairWith(server, first, "Sam's iPhone");
    await page.getByRole("button", { name: "Pair another phone" }).click({ timeout: 10_000 });
    await expect(page.getByTestId("pairing-link")).toHaveText(/^sidebots:\/\/pair/);
    await expect(page.getByTestId("pairing-link")).not.toHaveText(first);
  });

  test("Copy puts the link on the clipboard and says Copied", async ({ page, electronApp }) => {
    await openSettings(page, "phones");
    await page.getByTestId("pair-phone").click();
    const link = (await page.getByTestId("pairing-link").textContent())!;
    await page.getByTestId("pairing").getByRole("button", { name: "Copy" }).click();
    await expect(page.getByTestId("pairing").getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(link);
    // It goes back to Copy after a moment.
    await expect(page.getByTestId("pairing").getByRole("button", { name: "Copy" })).toBeVisible({ timeout: 5_000 });
  });

  test("a code that runs out is replaced by a new one", async ({ page }) => {
    await openSettings(page, "phones");
    await page.getByTestId("pair-phone").click();
    const first = (await page.getByTestId("pairing-link").textContent())!;
    // A code works for ten minutes. The window's clock is moved on eleven, as if the code were left open that long.
    await page.evaluate(() => {
      const real = Date.now;
      Date.now = () => real() + 11 * 60_000;
    });
    await expect(page.getByTestId("pairing-link")).not.toHaveText(first, { timeout: 10_000 });
    await expect(page.getByTestId("pairing-link")).toHaveText(/^sidebots:\/\/pair\?host=/);
  });

  test("Get it from the App Store opens the site in the browser", async ({ page, mainCalls }) => {
    await openSettings(page, "phones");
    await page.getByTestId("pair-phone").click();
    await page.getByRole("button", { name: "Get it from the App Store." }).click();
    await expect.poll(async () => (await mainCalls()).opened).toEqual(["https://sidebots.app"]);
  });

  test("a computer with no address for phones yet says so, and shows no code", async ({ page, server }) => {
    await server.control("address", { address: null });
    await openSettings(page, "phones");
    await page.getByTestId("pair-phone").click();
    const pairing = page.getByTestId("pairing");
    await expect(pairing.getByRole("alert")).toHaveText("This computer is still getting ready for phones. It needs an internet connection.");
    await expect(pairing.getByTestId("pairing-code")).toHaveCount(0);
    await expect(pairing.getByTestId("pairing-link")).toHaveCount(0);
    // Once the computer has an address, the code comes by itself.
    await server.control("address", { address: `127.0.0.1:${server.port}` });
    await expect(pairing.getByTestId("pairing-code")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("About", () => {
  test("shows the app's version and the computer's name, and its links open in the browser", async ({ page, mainCalls }) => {
    const version = (JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as { version: string }).version;
    const computer = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
    await openSettings(page, "about");
    const body = page.getByTestId("settings-body-about");
    await expect(body.getByRole("definition")).toHaveText(["Sidebots", version, computer]);
    await body.getByRole("button", { name: "sidebots.app" }).click();
    await body.getByRole("button", { name: "Privacy" }).click();
    await expect.poll(async () => (await mainCalls()).opened).toEqual(["https://sidebots.app", "https://sidebots.app/privacy"]);
  });
});
