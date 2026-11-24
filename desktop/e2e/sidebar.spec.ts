// The sidebar: each way an agent's row can stand, the order of the rows, the
// hidden agents, the open chat's mark, what the row's menus do, the same
// changes made on another device, search, and the new agent dialog. The rows'
// words and rules are the phone's (mobile/src/components/AgentList.tsx,
// mobile/src/app/new-agent.tsx, client/confirmations.ts, and the rule in
// server/src/store.ts's addMessage that brings a hidden agent back).

import { PAGE, RUN, type Avatar, type Found } from "../../server/src/contract.ts";
import { LINES } from "../../client/lines.ts";
import { TOP_BAR } from "../src/bridge.ts";
import { jumpOffered, said, scrollChatTo, wholeChat } from "./chat-helpers.ts";
import { expect, test, type TestServer } from "./fixtures.ts";
import { agentNamed, agentsOf, avatarRowOffset, avatarShown, changeOnPhone, chooseMenu, faintIn, listedIds, onDatabase, rowOf, settled } from "./shell.ts";
import type { Page } from "@playwright/test";

/** What the server finds for a search, as a phone asks for it. */
async function found(server: TestServer, text: string): Promise<Found[]> {
  return (await server.api(`/search?text=${encodeURIComponent(text)}`)).json() as Promise<Found[]>;
}

/** Opens a row's own menu from the button that shows as the pointer rests on it. */
async function moreFor(page: Page, agentId: string, name: string) {
  await rowOf(page, agentId).hover();
  await page.getByRole("button", { name: `More for ${name}` }).click();
}

/** The colour behind an element, as the page draws it. */
const backgroundOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.fillStyle = getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  });

test.describe("each row as its agent stands", () => {
  test.use({ world: "seeded" });

  test("replies the person hasn't read show their count", async ({ page, server }) => {
    const ledger = await agentNamed(server, "Ledger");
    await expect(rowOf(page, ledger.id).getByLabel("2 unread")).toHaveText("2");
  });

  test("a flood of unread replies is counted as 99+", async ({ page, server }) => {
    const pip = await agentNamed(server, "Pip");
    await expect(rowOf(page, pip.id)).toContainText("Say hello");
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(Array.from({ length: 10 }, (_, index) => server.control("deliver", { agent: "Pip", text: `Note ${batch * 10 + index + 1}` })));
    }
    await expect(rowOf(page, pip.id).getByLabel("100 unread")).toHaveText("99+", { timeout: 15_000 });
  });

  test("a muted agent shows the crossed bell, and its count in grey", async ({ page, server }) => {
    const [scout, ledger] = await Promise.all([agentNamed(server, "Scout"), agentNamed(server, "Ledger")]);
    await expect(rowOf(page, scout.id).getByRole("img", { name: "Muted" })).toBeVisible();
    await expect(rowOf(page, ledger.id).getByRole("img", { name: "Muted" })).toHaveCount(0);
    const grey = await backgroundOf(page, `[data-testid="agent-${scout.id}"] [aria-label="2 unread"]`);
    const blue = await backgroundOf(page, `[data-testid="agent-${ledger.id}"] [aria-label="2 unread"]`);
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThan(12);
    expect(Math.max(...blue) - Math.min(...blue)).toBeGreaterThan(60);
  });

  test("a working agent shows a playful line in italics that changes", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await server.control("hold", { agent: "Atlas" });
    const line = rowOf(page, atlas.id).locator("span.italic");
    await expect(line).toBeVisible();
    const first = await line.innerText();
    expect(LINES).toContain(first);
    await expect.poll(() => line.innerText(), { timeout: 8_000 }).not.toBe(first);
    expect(LINES).toContain(await line.innerText());
    await expect.poll(() => avatarShown(rowOf(page, atlas.id).locator("span[aria-hidden]").first())).toEqual({ y: avatarRowOffset("working"), opacity: 1 });
    await server.control("release", { agent: "Atlas" });
    await expect(line).toHaveCount(0, { timeout: 10_000 });
  });

  test("an agent that asked another and hasn't heard back says who it waits on", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    // Ledger is busy, so what Atlas asks it waits in Ledger's queue.
    await server.control("hold", { agent: "Ledger" });
    await server.say(atlas.id, "/agent Ledger can we afford a new sofa this month?");
    await expect(rowOf(page, atlas.id)).toContainText("Waiting on Ledger", { timeout: 15_000 });
    await server.control("release", { agent: "Ledger" });
    await expect(rowOf(page, atlas.id)).toContainText("Heard back from Ledger", { timeout: 20_000 });
    await expect(rowOf(page, atlas.id)).not.toContainText("Waiting on Ledger");
  });

  test("an agent whose last turn failed says what went wrong and acts it out", async ({ page, server }) => {
    const patch = await agentNamed(server, "Patch");
    await expect(rowOf(page, patch.id)).toContainText("Sidebots couldn't finish this. Codex on your computer is signed out. Sign in to it there.");
    await expect.poll(() => avatarShown(rowOf(page, patch.id).locator("span[aria-hidden]").first())).toEqual({ y: avatarRowOffset("failed"), opacity: 1 });
  });

  test("a brand new agent says Say hello, at the time it was made", async ({ page, server }) => {
    const pip = await agentNamed(server, "Pip");
    await expect(rowOf(page, pip.id)).toContainText("Say hello");
    await expect(rowOf(page, pip.id).getByText(/^\d{1,2}:\d{2}(\s?[AP]M)?$/i)).toBeVisible();
  });

  test("a long name with emoji is cut short without breaking its row", async ({ page, server }) => {
    const [home, atlas] = await Promise.all([agentNamed(server, "🏡 Home renovation & garden project coordinator 🌱"), agentNamed(server, "Atlas")]);
    const row = rowOf(page, home.id);
    const name = row.getByText(home.name, { exact: true });
    await expect(name).toBeVisible();
    expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const [long, short, sidebar] = await Promise.all([row.boundingBox(), rowOf(page, atlas.id).boundingBox(), page.getByTestId("sidebar").boundingBox()]);
    expect(long!.height).toBe(short!.height);
    expect(long!.x + long!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width);
    // The time keeps its place at the end of the name's line.
    const time = row.getByText("Yesterday", { exact: true });
    const [timeBox, nameBox] = await Promise.all([time.boundingBox(), name.boundingBox()]);
    expect(timeBox!.x).toBeGreaterThanOrEqual(nameBox!.x + nameBox!.width);
    expect(timeBox!.x + timeBox!.width).toBeLessThanOrEqual(long!.x + long!.width);
  });

  test("times read as the time today, Yesterday, then the day of the week", async ({ page, server }) => {
    const [ledger, home, archive] = await Promise.all([agentNamed(server, "Ledger"), agentNamed(server, "🏡 Home renovation & garden project coordinator 🌱"), agentNamed(server, "Archive")]);
    await expect(rowOf(page, ledger.id).getByText(/^\d{1,2}:\d{2}(\s?[AP]M)?$/i)).toBeVisible();
    await expect(rowOf(page, home.id).getByText("Yesterday", { exact: true })).toBeVisible();
    await page.getByTestId("hidden-agents").click();
    const weekday = await page.evaluate((time) => new Date(time).toLocaleDateString(undefined, { weekday: "long" }), archive.latest!.created_at);
    await expect(rowOf(page, archive.id).getByText(weekday, { exact: true })).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`every row reads clearly in ${scheme}`, async ({ page, server, setColorScheme }) => {
      const atlas = await agentNamed(server, "Atlas");
      await rowOf(page, atlas.id).click();
      await page.getByTestId("hidden-agents").click();
      // The pointer leaves the sidebar, so each row shows as it rests, and the colours have settled.
      await page.mouse.move(900, 400);
      await setColorScheme(scheme);
      await expect.poll(() => faintIn(page.getByTestId("sidebar"))).toEqual([]);
    });
  }
});

test.describe("the order of the rows", () => {
  test.use({ world: "seeded" });

  test("the agents are listed newest activity first", async ({ page, server }) => {
    const agents = (await agentsOf(server)).filter((agent) => !agent.hidden);
    const newest = [...agents].sort((a, b) => (b.latest?.created_at ?? b.created_at) - (a.latest?.created_at ?? a.created_at)).map((agent) => agent.id);
    await expect.poll(() => listedIds(page)).toEqual(newest);
  });

  test("a reply arriving moves its agent to the top", async ({ page, server }) => {
    const home = await agentNamed(server, "🏡 Home renovation & garden project coordinator 🌱");
    expect((await settled(page, server))[0]).not.toBe(home.id);
    await server.control("deliver", { agent: home.id, text: "The worktop quotes are in." });
    await expect.poll(async () => (await listedIds(page))[0]).toBe(home.id);
    await expect(rowOf(page, home.id)).toContainText("The worktop quotes are in.");
  });
});

test.describe("hidden agents", () => {
  test.use({ world: "seeded" });

  test("the hidden agents wait under a line at the end, which opens and closes", async ({ page, server }) => {
    const archive = await agentNamed(server, "Archive");
    const line = page.getByTestId("hidden-agents");
    await expect(line).toHaveText("Hidden · 1");
    await expect(line).toHaveAttribute("aria-expanded", "false");
    await expect(rowOf(page, archive.id)).toHaveCount(0);
    await line.click();
    await expect(line).toHaveAttribute("aria-expanded", "true");
    await expect(rowOf(page, archive.id)).toBeVisible();
    expect((await listedIds(page)).at(-1)).toBe(archive.id);
    await line.click();
    await expect(rowOf(page, archive.id)).toHaveCount(0);
  });

  test("a hidden agent comes back to the list when it has something to say", async ({ page, server }) => {
    const archive = await agentNamed(server, "Archive");
    await settled(page, server);
    await server.control("deliver", { agent: "Archive", text: "The boiler engineer is booked for Tuesday." });
    await expect(rowOf(page, archive.id)).toBeVisible();
    await expect(page.getByTestId("hidden-agents")).toHaveCount(0);
    expect((await listedIds(page))[0]).toBe(archive.id);
    expect((await agentNamed(server, "Archive")).hidden).toBe(false);
  });

  test("a muted agent that is hidden stays hidden when it has something to say", async ({ page, server }) => {
    const scout = await agentNamed(server, "Scout");
    await rowOf(page, scout.id).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Hide" }).click();
    await expect(page.getByTestId("hidden-agents")).toHaveText("Hidden · 2");
    await expect.poll(async () => (await agentNamed(server, "Scout")).hidden).toBe(true);
    await server.control("deliver", { agent: "Scout", text: "Fares went up to £131." });
    await expect.poll(async () => (await agentNamed(server, "Scout")).latest?.body).toBe("Fares went up to £131.");
    await expect(page.getByTestId("hidden-agents")).toHaveText("Hidden · 2");
    await expect(rowOf(page, scout.id)).toHaveCount(0);
  });
});

test.describe("the open chat and what a row's menus do", () => {
  test.use({ world: "seeded" });

  test("the open chat's row is marked, and only that one", async ({ page, server }) => {
    const [atlas, ledger] = await Promise.all([agentNamed(server, "Atlas"), agentNamed(server, "Ledger")]);
    await rowOf(page, atlas.id).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Atlas");
    await expect(rowOf(page, atlas.id)).toHaveAttribute("aria-current", "true");
    await expect(page.locator("[data-row][aria-current]")).toHaveCount(1);
    await rowOf(page, ledger.id).click();
    await expect(rowOf(page, ledger.id)).toHaveAttribute("aria-current", "true");
    await expect(rowOf(page, atlas.id)).not.toHaveAttribute("aria-current", /.*/);
  });

  test("Mute and Unmute from the right-click menu", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await rowOf(page, atlas.id).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mute" }).click();
    await expect(rowOf(page, atlas.id).getByRole("img", { name: "Muted" })).toBeVisible();
    await expect.poll(async () => (await agentNamed(server, "Atlas")).muted).toBe(true);
    await rowOf(page, atlas.id).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unmute" }).click();
    await expect(rowOf(page, atlas.id).getByRole("img", { name: "Muted" })).toHaveCount(0);
    await expect.poll(async () => (await agentNamed(server, "Atlas")).muted).toBe(false);
  });

  test("Hide from the row's more button takes it under the line, and Unhide brings it back", async ({ page, server }) => {
    const planner = await agentNamed(server, "Planner");
    await moreFor(page, planner.id, "Planner");
    await page.getByRole("menuitem", { name: "Hide" }).click();
    await expect(page.getByTestId("hidden-agents")).toHaveText("Hidden · 2");
    await expect(rowOf(page, planner.id)).toHaveCount(0);
    await expect.poll(async () => (await agentNamed(server, "Planner")).hidden).toBe(true);
    await page.getByTestId("hidden-agents").click();
    await moreFor(page, planner.id, "Planner");
    await page.getByRole("menuitem", { name: "Unhide" }).click();
    await expect(page.getByTestId("hidden-agents")).toHaveText("Hidden · 1");
    await expect.poll(async () => (await agentNamed(server, "Planner")).hidden).toBe(false);
  });

  test("Delete asks first, in the phone's words, and Cancel keeps the agent", async ({ page, server }) => {
    const tidy = await agentNamed(server, "Tidy");
    await moreFor(page, tidy.id, "Tidy");
    await page.getByRole("menuitem", { name: "Delete agent…" }).click();
    const asked = page.getByRole("alertdialog");
    await expect(asked.getByRole("heading", { name: "Delete Tidy?" })).toBeVisible();
    await expect(asked).toContainText("Its chat, its memory, its jobs and its files are removed for good.");
    await asked.getByRole("button", { name: "Cancel" }).click();
    await expect(asked).toHaveCount(0);
    await expect(rowOf(page, tidy.id)).toBeVisible();
    expect((await agentsOf(server)).some((agent) => agent.id === tidy.id)).toBe(true);
  });

  test("Esc answers the delete question no", async ({ page, server }) => {
    const tidy = await agentNamed(server, "Tidy");
    await rowOf(page, tidy.id).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete agent…" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(rowOf(page, tidy.id)).toBeVisible();
  });

  test("Delete, once confirmed, removes the agent and its row", async ({ page, server }) => {
    const tidy = await agentNamed(server, "Tidy");
    await rowOf(page, tidy.id).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete agent…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(rowOf(page, tidy.id)).toHaveCount(0);
    await expect.poll(async () => (await agentsOf(server)).some((agent) => agent.id === tidy.id)).toBe(false);
  });

  test("deleting the agent whose chat is open closes its chat", async ({ page, server }) => {
    const tidy = await agentNamed(server, "Tidy");
    await rowOf(page, tidy.id).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Tidy");
    await moreFor(page, tidy.id, "Tidy");
    await page.getByRole("menuitem", { name: "Delete agent…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Choose an agent to chat with.")).toBeVisible();
    await expect(page.getByTestId("chat")).toHaveCount(0);
  });
});

test.describe("changes made on another device", () => {
  test.use({ world: "seeded" });

  test("a mute made on the phone shows here at once", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await changeOnPhone(server, atlas.id, { muted: true });
    await expect(rowOf(page, atlas.id).getByRole("img", { name: "Muted" })).toBeVisible({ timeout: 5_000 });
  });

  test("a hide made on the phone shows here at once", async ({ page, server }) => {
    const ledger = await agentNamed(server, "Ledger");
    await changeOnPhone(server, ledger.id, { hidden: true });
    await expect(page.getByTestId("hidden-agents")).toHaveText("Hidden · 2", { timeout: 5_000 });
    await expect(rowOf(page, ledger.id)).toHaveCount(0);
  });

  test("an agent added on the phone appears at once, at the top", async ({ page, server }) => {
    await settled(page, server);
    const added = (await (await server.api("/agents", { method: "POST", body: JSON.stringify({ name: "Juniper", avatarId: "cog" }) })).json()) as { id: string };
    await expect(rowOf(page, added.id)).toContainText("Juniper");
    await expect(rowOf(page, added.id)).toContainText("Say hello");
    expect((await listedIds(page))[0]).toBe(added.id);
  });

  test("an agent deleted on the phone while its chat is open here goes, and its chat closes", async ({ page, server }) => {
    const pip = await agentNamed(server, "Pip");
    await rowOf(page, pip.id).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Pip");
    await server.api(`/agents/${pip.id}`, { method: "DELETE" });
    await expect(rowOf(page, pip.id)).toHaveCount(0);
    await expect(page.getByText("Choose an agent to chat with.")).toBeVisible();
  });
});

test.describe("search", () => {
  test.use({ world: "seeded" });

  test("the search button opens search with the field ready to type in", async ({ page }) => {
    await page.getByTestId("search-button").click();
    await expect(page.getByTestId("search")).toBeFocused();
    await expect(page.getByTestId("search-button")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("agent-list")).toHaveCount(0);
  });

  test("the menu's Search opens search, and brings back a collapsed sidebar", async ({ page, electronApp }) => {
    await page.getByTestId("toggle-sidebar").first().click();
    await chooseMenu(electronApp, "Search");
    await expect(page.getByTestId("search")).toBeFocused();
    await expect(page.getByTestId("sidebar")).toBeInViewport();
  });

  test("agents are found by name, first", async ({ page, server }) => {
    const ledger = await agentNamed(server, "Ledger");
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("ledg");
    await expect(page.getByRole("option").first()).toHaveAttribute("data-testid", `result-${ledger.id}`);
    await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  });

  test("a message of the person's is found with You: and the words before the match", async ({ page, server }) => {
    const [message] = await found(server, "errands for this week");
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("errands for this week");
    await expect(page.getByTestId(`found-${message.id}`)).toContainText("You: …you keep track of the errands for this week?");
    await expect(page.getByTestId(`found-${message.id}`)).toContainText("Atlas");
  });

  test("an agent's message is found starting a little before the words that matched", async ({ page, server }) => {
    const [message] = await found(server, "landed on the next day");
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("landed on the next day");
    const result = page.getByTestId(`found-${message.id}`);
    await expect(result).toContainText("Patch");
    await expect(result).toContainText("…so anything after 11pm landed on the next day.");
    await expect(result).not.toContainText("You:");
  });

  test("a search that finds nothing says No results", async ({ page }) => {
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("zebra crossing quartz");
    await expect(page.getByText("No results")).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(0);
  });

  test("the arrow keys move through the results, and Enter opens the one chosen at its message", async ({ page, server }) => {
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("Ledger");
    const options = page.getByRole("option");
    await expect.poll(() => options.count()).toBeGreaterThan(2);
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(options.last()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const chosen = (await options.nth(1).getAttribute("data-testid"))!.slice("found-".length);
    const [message] = (await found(server, "Ledger")).filter((each) => each.id === chosen);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("chat-name")).toHaveText(message.agent);
    await expect(page.locator(`[data-message-id="${chosen}"]`)).toBeInViewport({ timeout: 10_000 });
  });

  test("a click on a found message opens its chat at that message, even one not loaded yet", async ({ page, server }) => {
    // The first thing the person said to Atlas, a week back and many pages before what the chat loads first.
    const [message] = await found(server, "keep track of the errands");
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("keep track of the errands");
    await page.getByTestId(`found-${message.id}`).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Atlas");
    const row = page.locator(`[data-message-id="${message.id}"]`);
    await expect(row).toBeInViewport({ timeout: 15_000 });
    await expect(row).toHaveClass(/animate-flash/);
  });

  test("a found message further back than one answer holds opens with one request for the run from it, and the chat pages down across the rest to the newest", async ({ page, server }) => {
    test.setTimeout(120_000);
    const atlas = await agentNamed(server, "Atlas");
    // Atlas's chat is made longer than its newest page and a run together, so its first message is out of one run's reach.
    const more = Math.max(0, PAGE + RUN + 20 - (await wholeChat(server, atlas.id)).length);
    for (let index = 0; index < more; index++) await server.control("deliver", { agent: atlas.id, text: `Reminder ${index}.` });
    const newest = `Reminder ${more - 1}.`;
    const [message] = await found(server, "keep track of the errands");
    const fetched: string[] = [];
    page.on("request", (request) => void (request.url().includes(`/agents/${atlas.id}/messages`) && fetched.push(new URL(request.url()).search)));

    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("keep track of the errands");
    await page.getByTestId(`found-${message.id}`).click();
    const row = page.locator(`[data-message-id="${message.id}"]`);
    await expect(row).toBeInViewport({ timeout: 15_000 });
    await expect(row).toHaveClass(/animate-flash/);
    const runs = (searches: string[]) => searches.filter((search) => search.includes("through="));
    // The newest page, the run from the message, and the page before it, which the chat's first message has nothing in. The run doesn't reach the newest page, so the chat draws the stretch with Jump to latest, and the hole after it is off screen.
    expect(runs(fetched), fetched.join(" ")).toHaveLength(1);
    expect(fetched.length, fetched.join(" ")).toBeLessThanOrEqual(3);
    expect(await jumpOffered(page)).toBe(true);
    await expect(page.getByTestId("hole")).toHaveCount(0);

    // Jump to latest goes back to the newest messages and lets the stretch go, with nothing fetched.
    const opened = fetched.length;
    await page.getByTestId("jump-to-latest").click();
    await expect(said(page, newest)).toBeInViewport();
    await expect(row).toHaveCount(0);
    expect(fetched.slice(opened), fetched.join(" ")).toEqual([]);

    // Opened there again from the search still open, scrolling down reaches the newest message across the hole: the run from the message, then one more.
    await page.getByTestId(`found-${message.id}`).click();
    await expect(row).toBeInViewport({ timeout: 15_000 });
    await scrollChatTo(page, said(page, newest), "on");
    expect(runs(fetched.slice(opened)), fetched.join(" ")).toHaveLength(2);
    expect(fetched.slice(opened), fetched.join(" ")).toHaveLength(2);
    await expect.poll(() => jumpOffered(page)).toBe(false);
  });

  test("a found message between two agents opens the chat at their exchange's line, which flashes", async ({ page, server }) => {
    // What Atlas asked Ledger shows in Atlas's chat as the one line for that exchange, not as a bubble of its own.
    const words = "check what's left in Home for November";
    const [asked] = await found(server, words);
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill(words);
    await page.getByTestId(`found-${asked.id}`).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Atlas");
    const row = page.locator(`[data-message-id="${asked.id}"]`);
    await expect(row).toBeInViewport({ timeout: 15_000 });
    await expect(row).toHaveClass(/animate-flash/);
    await expect(row.getByTestId(`exchange-${asked.id}`)).toHaveAccessibleName("Atlas asked Ledger. Answered");
    // Only that line flashes, not the person's message before it.
    await expect(page.locator(".animate-flash")).toHaveCount(1);
  });

  test("Esc closes search and the agents come back", async ({ page }) => {
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("Atl");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("search")).toHaveCount(0);
    await expect(page.getByTestId("agent-list")).toBeVisible();
    await expect(page.getByTestId("search-button")).toHaveAttribute("aria-pressed", "false");
  });

  test("a hidden agent is found, by its name and by what was said to it", async ({ page, server }) => {
    const archive = await agentNamed(server, "Archive");
    const [said] = await found(server, "Worcester Greenstar");
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("Archive");
    await expect(page.getByTestId(`result-${archive.id}`)).toBeVisible();
    await page.getByTestId("search").fill("Worcester Greenstar");
    await expect(page.getByTestId(`found-${said.id}`)).toContainText("Archive");
    await page.getByTestId(`found-${said.id}`).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Archive");
  });

  test("out of reach, search still finds agents by name", async ({ page, server }) => {
    const scout = await agentNamed(server, "Scout");
    await server.control("outage", {});
    await expect(page.getByTestId("reach")).toHaveText("Out of reach");
    await page.getByTestId("search-button").click();
    await page.getByTestId("search").fill("Scout");
    await expect(page.getByTestId(`result-${scout.id}`)).toBeVisible();
  });
});

test.describe("a new agent", () => {
  test("the + button opens New agent with the name ready to type", async ({ page }) => {
    await page.getByTestId("new-agent-button").click();
    const dialog = page.getByTestId("new-agent");
    await expect(dialog.getByRole("heading", { name: "New agent" })).toBeVisible();
    await expect(page.getByTestId("agent-name")).toBeFocused();
    await expect(dialog.getByText("Tell it what it's for in the chat.")).toBeVisible();
    await expect(page.getByTestId("create-agent")).toBeDisabled();
  });

  test("the empty state's New agent button opens it", async ({ page }) => {
    await page.getByTestId("no-chat").getByRole("button", { name: "New agent" }).click();
    await expect(page.getByTestId("agent-name")).toBeFocused();
  });

  test("the menu's New Agent opens it", async ({ page, electronApp }) => {
    await expect(page.getByText("No agents yet")).toBeVisible();
    await chooseMenu(electronApp, "New Agent");
    await expect(page.getByTestId("agent-name")).toBeFocused();
  });

  test("the name holds at most 24 characters", async ({ page }) => {
    await page.getByTestId("new-agent-button").click();
    await page.getByTestId("agent-name").pressSequentially("Abcdefghijklmnopqrstuvwxyz0123");
    await expect(page.getByTestId("agent-name")).toHaveValue("Abcdefghijklmnopqrstuvwx");
  });

  test("Create agent waits for a name, and spaces aren't one", async ({ page }) => {
    await page.getByTestId("new-agent-button").click();
    await page.getByTestId("agent-name").fill("   ");
    await expect(page.getByTestId("create-agent")).toBeDisabled();
    await page.getByTestId("agent-name").fill("Nova");
    await expect(page.getByTestId("create-agent")).toBeEnabled();
  });

  test("the name suggests an avatar until the person picks one", async ({ page, server }) => {
    const avatars = (await (await server.api("/avatars")).json()) as Avatar[];
    // The phone's rule: a sum of the name's letters picks the avatar, so a name always suggests the same one.
    const suggested = (name: string) => {
      let sum = 0;
      for (const letter of name) sum = (sum * 31 + letter.charCodeAt(0)) >>> 0;
      return avatars[sum % avatars.length];
    };
    const names = ["Nova", "Nova Two", "Juniper", "Basil", "Quill"];
    const [one, two] = names.filter((name, index) => names.findIndex((other) => suggested(other).id === suggested(name).id) === index);
    await page.getByTestId("new-agent-button").click();
    const field = page.getByTestId("agent-name");
    const avatarGroup = page.getByRole("radiogroup", { name: "Avatar" });
    await field.fill(one);
    await expect(avatarGroup.getByRole("radio", { name: suggested(one).displayName })).toHaveAttribute("aria-checked", "true");
    await field.fill(two);
    await expect(avatarGroup.getByRole("radio", { name: suggested(two).displayName })).toHaveAttribute("aria-checked", "true");
    const picked = avatars.find((avatar) => avatar.id !== suggested(two).id && avatar.id !== suggested(one).id)!;
    await avatarGroup.getByRole("radio", { name: picked.displayName }).click();
    await field.fill(one);
    await expect(avatarGroup.getByRole("radio", { name: picked.displayName })).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("create-agent").click();
    await expect(page.getByTestId("chat-name")).toHaveText(one);
    expect((await agentNamed(server, one)).avatar_id).toBe(picked.id);
  });

  test("with two providers set up, each choice makes an agent on that provider", async ({ page, server }) => {
    await page.getByTestId("new-agent-button").click();
    const providers = page.getByRole("radiogroup", { name: "Provider" });
    await expect(providers.getByRole("radio", { name: "Claude Code" })).toHaveAttribute("aria-checked", "true");
    await expect(providers.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("agent-name").fill("Cleo");
    await page.getByTestId("create-agent").click();
    await expect(page.getByTestId("chat-name")).toHaveText("Cleo");
    await page.getByTestId("new-agent-button").click();
    await page.getByTestId("agent-name").fill("Cody");
    await page.getByRole("radiogroup", { name: "Provider" }).getByRole("radio", { name: "Codex" }).click();
    await page.getByTestId("create-agent").click();
    await expect(page.getByTestId("chat-name")).toHaveText("Cody");
    expect((await agentNamed(server, "Cleo")).provider).toBe("claude");
    expect((await agentNamed(server, "Cody")).provider).toBe("codex");
  });

  test("New agent fits the smallest window under the top bar, with nothing to scroll", async ({ page, setWindowSize }) => {
    await setWindowSize(760, 520);
    await page.getByTestId("new-agent-button").click();
    await expect(page.getByRole("radiogroup", { name: "Provider" })).toBeVisible();
    const box = (await page.getByTestId("new-agent").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(TOP_BAR);
    expect(box.y + box.height).toBeLessThanOrEqual(520);
    const body = page.getByRole("radiogroup", { name: "Avatar" }).locator("xpath=..");
    expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
  });

  test("with one provider set up, there is no choice of provider", async ({ page, server }) => {
    onDatabase(server.home, "delete from accounts where provider = 'codex'");
    await page.getByTestId("new-agent-button").click();
    await expect(page.getByTestId("agent-name")).toBeFocused();
    await expect(page.getByRole("radiogroup", { name: "Avatar" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Provider" })).toHaveCount(0);
    await page.getByTestId("agent-name").fill("Solo");
    await page.getByTestId("create-agent").click();
    await expect(page.getByTestId("chat-name")).toHaveText("Solo");
    expect((await agentNamed(server, "Solo")).provider).toBe("claude");
  });

  test("when the server refuses, the dialog says why and stays open", async ({ page, server }) => {
    await page.getByTestId("new-agent-button").click();
    await page.getByTestId("agent-name").fill("Cody");
    await page.getByRole("radiogroup", { name: "Provider" }).getByRole("radio", { name: "Codex" }).click();
    // Codex is taken away on the computer after the dialog listed it.
    onDatabase(server.home, "delete from accounts where provider = 'codex'");
    await page.getByTestId("create-agent").click();
    await expect(page.getByTestId("new-agent").getByRole("alert")).toHaveText("Codex isn't set up on your computer.");
    await expect(page.getByTestId("create-agent")).toBeEnabled();
    expect(await agentsOf(server)).toEqual([]);
  });

  test("out of reach, the dialog says Sidebots isn't running", async ({ page, server }) => {
    await page.getByTestId("new-agent-button").click();
    await page.getByTestId("agent-name").fill("Nova");
    await server.control("outage", {});
    await page.getByTestId("create-agent").click();
    await expect(page.getByTestId("new-agent").getByRole("alert")).toHaveText("Sidebots isn't running on this computer.");
    await server.control("outage", { ms: 0 });
  });

  test("a double click on Create agent makes one agent", async ({ page, server }) => {
    await page.getByTestId("new-agent-button").click();
    await page.getByTestId("agent-name").fill("Nova");
    await page.getByTestId("create-agent").dblclick();
    await expect(page.getByTestId("chat-name")).toHaveText("Nova");
    await expect.poll(async () => (await agentsOf(server)).length).toBe(1);
    await expect(page.getByTestId("agent-list").locator("[data-row]")).toHaveCount(1);
  });

  test("Enter in the name makes the agent", async ({ page, server }) => {
    await page.getByTestId("new-agent-button").click();
    await page.getByTestId("agent-name").fill("Nova");
    await page.getByTestId("agent-name").press("Enter");
    await expect(page.getByTestId("chat-name")).toHaveText("Nova");
    expect((await agentsOf(server)).map((agent) => agent.name)).toEqual(["Nova"]);
  });

  test("Esc, Cancel and the close button each close it without making an agent", async ({ page, server }) => {
    for (const close of [() => page.keyboard.press("Escape"), () => page.getByTestId("new-agent").getByRole("button", { name: "Cancel" }).click(), () => page.getByTestId("new-agent").getByRole("button", { name: "Close" }).click()]) {
      await page.getByTestId("new-agent-button").click();
      await page.getByTestId("agent-name").fill("Nova");
      await close();
      await expect(page.getByTestId("new-agent")).toHaveCount(0);
    }
    expect(await agentsOf(server)).toEqual([]);
    await expect(page.getByText("No agents yet")).toBeVisible();
  });

  test("it starts afresh each time it opens", async ({ page }) => {
    await page.getByTestId("new-agent-button").click();
    await page.getByTestId("agent-name").fill("Nova");
    await page.keyboard.press("Escape");
    await page.getByTestId("new-agent-button").click();
    await expect(page.getByTestId("agent-name")).toHaveValue("");
  });

  test("the new agent's chat opens with its hint line, and its row is marked", async ({ page, server }) => {
    await page.getByTestId("new-agent-button").click();
    await page.getByTestId("agent-name").fill("  Nova  ");
    await page.getByTestId("create-agent").click();
    await expect(page.getByTestId("new-agent")).toHaveCount(0);
    await expect(page.getByTestId("chat-name")).toHaveText("Nova");
    await expect(page.getByTestId("new-agent-hint")).toHaveText("Nova is new. Tell it what it's for.");
    const nova = await agentNamed(server, "Nova");
    await expect(rowOf(page, nova.id)).toHaveAttribute("aria-current", "true");
    await expect(rowOf(page, nova.id)).toContainText("Say hello");
  });
});
