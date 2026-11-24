// The panel at the right of the window: an agent's page with its settings,
// jobs, instructions and memory; what two agents said to each other; the
// pictures a message carries; a page an agent sent; and the panel's own
// frame, which closes, resizes, and lies over the chat in a small window.
// The phone's versions are mobile/src/app/agent/[id].tsx, note.tsx and
// exchange.tsx, whose words the panel uses.

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Request } from "@playwright/test";
import { PROVIDERS, scheduleWords } from "../../server/src/contract.ts";
import { COST_NOTE, KINDS, dollars, usedBy } from "../../client/usage.ts";
import { expect, test } from "./fixtures.ts";
import {
  about,
  addAgent,
  agentNamed,
  agents,
  chat,
  dragPanelEdge,
  nextTimeInWindow,
  openAgentPage,
  openChat,
  pageFrame,
  panelWidth,
  pngUpload,
  scrollChatTo,
  allMessages,
  setPanelTo,
  until,
  usage,
} from "./panel-support.ts";

/** Sends a message from the composer of the open chat, as the person types it. */
async function sendFromComposer(page: import("@playwright/test").Page, words: string): Promise<void> {
  const field = page.getByTestId("message-field");
  await field.fill(words);
  await field.press("Enter");
}

test.describe("an agent's page", () => {
  test.use({ world: "seeded" });

  test("opens from the chat's top bar with the avatar, the name and a caption of the model and effort", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    const panel = page.getByTestId("panel");
    await expect(panel.getByTestId("agent-page-name")).toHaveText("Atlas");
    await expect(panel.getByTestId("agent-page-caption")).toHaveText("Claude Opus 5.5 · High effort");
    await expect(panel.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(panel.getByRole("radio", { name: "Settings" })).toBeChecked();
  });

  test("the caption says when an agent is muted, and when it is hidden", async ({ page, server }) => {
    await openAgentPage(page, (await agentNamed(server, "Scout")).id);
    await expect(page.getByTestId("agent-page-caption")).toHaveText("Claude Sonnet 5.5 · Low effort · Muted");
    await openAgentPage(page, (await agentNamed(server, "Archive")).id);
    await expect(page.getByTestId("agent-page-caption")).toHaveText("Claude Haiku 5.5 · Low effort · Hidden");
  });

  test("Edit renames the agent, sending only the name, and the chat and the sidebar take the new name at once", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    const sent: unknown[] = [];
    page.on("request", (request: Request) => {
      if (request.method() === "PATCH" && request.url().endsWith(`/api/agents/${atlas.id}`)) sent.push(request.postDataJSON());
    });
    await page.getByTestId("edit-agent").click();
    const field = page.getByTestId("agent-page-name-field");
    // The field opens focused with the name chosen, so typing replaces it.
    await expect(field).toBeFocused();
    await page.keyboard.type("Errands");
    await page.getByTestId("save-agent").click();
    await expect(page.getByTestId("agent-page-name")).toHaveText("Errands");
    await expect(page.getByTestId("chat-name")).toHaveText("Errands");
    await expect(page.getByTestId(`agent-${atlas.id}`)).toContainText("Errands");
    await expect.poll(async () => (await agentNamed(server, "Errands")).id).toBe(atlas.id);
    expect(sent).toEqual([{ name: "Errands" }]);
  });

  test("a name is 24 characters at most, and can't be saved empty", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    await page.getByTestId("edit-agent").click();
    const field = page.getByTestId("agent-page-name-field");
    await field.fill("");
    await expect(page.getByTestId("save-agent")).toBeDisabled();
    await field.fill("   ");
    await expect(page.getByTestId("save-agent")).toBeDisabled();
    // Enter in an empty name saves nothing, and the edit stays open.
    await field.press("Enter");
    await expect(field).toBeVisible();
    await field.fill("");
    await field.pressSequentially("A name far longer than twenty-four letters");
    await expect(field).toHaveValue("A name far longer than t");
    await field.press("Enter");
    await expect(page.getByTestId("agent-page-name")).toHaveText("A name far longer than t");
    await expect.poll(async () => (await agents(server)).find((agent) => agent.id === atlas.id)?.name).toBe("A name far longer than t");
  });

  test("a new avatar and chat colour are saved together, and the chat and its row take the colour at once", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    const sent: Record<string, unknown>[] = [];
    page.on("request", (request: Request) => {
      if (request.method() === "PATCH" && request.url().endsWith(`/api/agents/${atlas.id}`)) sent.push(request.postDataJSON());
    });
    await page.getByTestId("edit-agent").click();
    const avatars = page.getByRole("radiogroup", { name: "Avatar" }).getByRole("radio");
    await expect(avatars).toHaveCount(8);
    const other = page.locator('[role="radiogroup"][aria-label="Avatar"] [role="radio"]:not([data-checked])').first();
    await other.click();
    await page.getByRole("radio", { name: "Teal" }).click();
    await page.getByTestId("save-agent").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(Object.keys(sent[0]).sort()).toEqual(["avatarId", "color"]);
    expect(sent[0].color).toBe("#0B7A6A");
    const changed = await until(() => agentNamed(server, "Atlas"), (agent) => agent.color === "#0B7A6A");
    expect(changed.avatar_id).toBe(sent[0].avatarId);
    expect(changed.avatar_id).not.toBe(atlas.avatar_id);
    await expect(page.getByTestId("chat-column")).toHaveAttribute("style", /--chat:\s*#0B7A6A/i);
    await expect(page.getByTestId(`agent-${atlas.id}`)).toHaveAttribute("style", /--chat:\s*#0B7A6A/i);
  });

  test("choosing the avatar's own colour clears the colour the chat had", async ({ page, server }) => {
    const ledger = await agentNamed(server, "Ledger");
    expect(ledger.color).toBe("#B4532A");
    await openAgentPage(page, ledger.id);
    const sent: unknown[] = [];
    page.on("request", (request: Request) => {
      if (request.method() === "PATCH" && request.url().endsWith(`/api/agents/${ledger.id}`)) sent.push(request.postDataJSON());
    });
    await page.getByTestId("edit-agent").click();
    await expect(page.getByRole("radio", { name: "Amber" })).not.toBeChecked();
    await page.getByRole("radio", { name: "The avatar's colour" }).click();
    await page.getByTestId("save-agent").click();
    await expect.poll(() => sent).toEqual([{ color: null }]);
    await until(() => agentNamed(server, "Ledger"), (agent) => agent.color === null);
    await expect(page.getByTestId("chat-column")).not.toHaveAttribute("style", /#B4532A/i);
  });

  test("Cancel leaves the agent as it was, and sends nothing", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    let sent = 0;
    page.on("request", (request: Request) => void (request.method() === "PATCH" && sent++));
    await page.getByTestId("edit-agent").click();
    await page.getByTestId("agent-page-name-field").fill("Nobody");
    await page.getByRole("radio", { name: "Red" }).click();
    await page.getByTestId("cancel-edit").click();
    await expect(page.getByTestId("agent-page-name")).toHaveText("Atlas");
    // Edit opens again on the agent as it is, not on what was typed before.
    await expect(page.getByTestId("edit-agent")).toBeFocused();
    await page.getByTestId("edit-agent").click();
    await expect(page.getByTestId("agent-page-name-field")).toHaveValue("Atlas");
    expect(sent).toBe(0);
  });

  test("Esc leaves the edit as it was, and the panel stays open", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    await page.getByTestId("edit-agent").click();
    await page.getByTestId("agent-page-name-field").fill("Nobody");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-page-name")).toHaveText("Atlas");
    await expect(page.getByTestId("panel")).toBeVisible();
    expect((await agentNamed(server, "Atlas")).id).toBe(atlas.id);
  });

  test("the caption follows the model and the effort chosen in the chat", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    await expect(page.getByTestId("agent-page-caption")).toHaveText("Claude Opus 5.5 · High effort");
    await page.getByTestId("model").click();
    await page.getByRole("radio", { name: "Claude Sonnet 5.5" }).click();
    await page.getByRole("radio", { name: "Low" }).click();
    await expect(page.getByTestId("agent-page-caption")).toHaveText("Claude Sonnet 5.5 · Low effort");
  });

  test("Usage, last 7 days shows each kind of turn the agent ran, with its count and cost", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    const section = page.getByTestId("agent-usage");
    await expect(section.getByRole("heading", { name: "Usage, last 7 days" })).toBeVisible();
    const used = usedBy(await usage(server), atlas.id);
    expect(used.map((each) => each.kind)).toEqual(["reply", "memory"]);
    const rows = section.locator(":scope > div > div");
    await expect(rows).toHaveCount(used.length);
    for (const [index, each] of used.entries()) {
      await expect(rows.nth(index)).toContainText(KINDS[each.kind]);
      await expect(rows.nth(index)).toContainText(each.turns === 1 ? "1 turn" : `${each.turns} turns`);
      await expect(rows.nth(index)).toContainText(dollars(each.cost));
    }
    await expect(section).toContainText(COST_NOTE);
  });

  test("an agent that hasn't run says so under Usage", async ({ page, server }) => {
    await openAgentPage(page, (await agentNamed(server, "Pip")).id);
    await expect(page.getByTestId("agent-usage")).toContainText("It hasn't run a turn.");
  });

  test("Mute marks the agent muted on its page, its chat and its row, and on the server", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    await page.getByRole("switch", { name: "Mute" }).click();
    await expect(page.getByRole("switch", { name: "Mute" })).toBeChecked();
    await expect(page.getByTestId("agent-page-caption")).toHaveText("Claude Opus 5.5 · High effort · Muted");
    await expect(page.getByTestId("chat-agent").getByRole("img", { name: "Muted" })).toBeVisible();
    await expect(page.getByTestId(`agent-${atlas.id}`).getByRole("img", { name: "Muted" })).toBeVisible();
    await until(() => agentNamed(server, "Atlas"), (agent) => agent.muted);
    await page.getByRole("switch", { name: "Mute" }).click();
    await expect(page.getByTestId("agent-page-caption")).toHaveText("Claude Opus 5.5 · High effort");
    await until(() => agentNamed(server, "Atlas"), (agent) => !agent.muted);
  });

  test("Hide moves the agent under Hidden in the sidebar, and Unhide brings it back", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    await expect(page.getByTestId("hidden-agents")).toHaveText(/Hidden · 1/);
    await page.getByRole("switch", { name: "Hide" }).click();
    await expect(page.getByTestId("hidden-agents")).toHaveText(/Hidden · 2/);
    await expect(page.getByTestId("agent-page-caption")).toHaveText("Claude Opus 5.5 · High effort · Hidden");
    await until(() => agentNamed(server, "Atlas"), (agent) => agent.hidden);
    // The open chat stays open while its agent is hidden.
    await expect(page.getByTestId("chat-name")).toHaveText("Atlas");
    await page.getByRole("switch", { name: "Hide" }).click();
    await expect(page.getByTestId("hidden-agents")).toHaveText(/Hidden · 1/);
    await expect(page.getByTestId(`agent-${atlas.id}`)).toBeVisible();
  });

  test("Delete agent asks first, and Cancel keeps the agent", async ({ page, server }) => {
    const pip = await agentNamed(server, "Pip");
    await openAgentPage(page, pip.id);
    await page.getByTestId("delete-agent").click();
    const confirm = page.getByTestId("confirm");
    await expect(confirm).toContainText("Delete Pip?");
    await expect(confirm).toContainText("Its chat, its memory, its jobs and its files are removed for good.");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId("agent-page")).toBeVisible();
    expect((await agents(server)).some((agent) => agent.id === pip.id)).toBe(true);
  });

  test("a deleted agent is gone from the server, and its panel and chat close", async ({ page, server }) => {
    const pip = await agentNamed(server, "Pip");
    await openAgentPage(page, pip.id);
    await page.getByTestId("delete-agent").click();
    await page.getByTestId("confirm").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("panel")).toBeHidden();
    await expect(page.getByTestId("no-chat")).toBeVisible();
    await expect(page.getByTestId(`agent-${pip.id}`)).toHaveCount(0);
    await until(() => agents(server), (all) => !all.some((agent) => agent.id === pip.id));
  });

  test("a change made on another device shows on the page as it happens", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    await server.api(`/agents/${atlas.id}`, { method: "PATCH", body: JSON.stringify({ name: "Atlas Prime", muted: true, model: "haiku" }) });
    await expect(page.getByTestId("agent-page-name")).toHaveText("Atlas Prime");
    await expect(page.getByTestId("agent-page-caption")).toHaveText("Claude Haiku 5.5 · High effort · Muted");
    await expect(page.getByRole("switch", { name: "Mute" })).toBeChecked();
  });

  test("an agent deleted on another device closes its page and chat", async ({ page, server }) => {
    const pip = await agentNamed(server, "Pip");
    await openAgentPage(page, pip.id);
    await server.api(`/agents/${pip.id}`, { method: "DELETE" });
    await expect(page.getByTestId("panel")).toBeHidden();
    await expect(page.getByTestId("no-chat")).toBeVisible();
  });
});

test.describe("an agent's jobs and memory", () => {
  test.use({ world: "seeded" });

  test("lists each job with its schedule in words, when it next runs, and what it does", async ({ page, server }) => {
    const planner = await agentNamed(server, "Planner");
    await openAgentPage(page, planner.id);
    await page.getByRole("radio", { name: "Jobs & memory" }).click();
    const { jobs } = await about(server, planner.id);
    expect(jobs).toHaveLength(3);
    const rows = page.getByTestId("job");
    await expect(rows).toHaveCount(3);
    for (const [index, job] of jobs.entries()) {
      await expect(rows.nth(index)).toContainText(scheduleWords(job.schedule));
      await expect(rows.nth(index)).toContainText(`Next ${await nextTimeInWindow(page, job.next_at)}`);
      await expect(rows.nth(index)).toContainText(job.what);
    }
  });

  test("Remove job asks first, then the job is gone from the page and the server", async ({ page, server }) => {
    const planner = await agentNamed(server, "Planner");
    await openAgentPage(page, planner.id);
    await page.getByRole("radio", { name: "Jobs & memory" }).click();
    const [first] = (await about(server, planner.id)).jobs;
    const row = page.getByTestId("job").filter({ hasText: first.what });
    await row.getByRole("button", { name: "Remove job" }).click();
    const confirm = page.getByTestId("confirm");
    await expect(confirm).toContainText("Remove this job?");
    await expect(confirm).toContainText(scheduleWords(first.schedule));
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("job")).toHaveCount(3);
    await row.getByRole("button", { name: "Remove job" }).click();
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("job")).toHaveCount(2);
    await expect(row).toHaveCount(0);
    await until(() => about(server, planner.id), (now) => now.jobs.length === 2 && !now.jobs.some((job) => job.id === first.id));
  });

  test("the instructions open as a note in rich text, and back returns to the page on the same tab", async ({ page, server }) => {
    const planner = await agentNamed(server, "Planner");
    await openAgentPage(page, planner.id);
    await page.getByRole("radio", { name: "Jobs & memory" }).click();
    await expect(page.getByTestId("open-instructions")).toContainText("You are Planner, one of Tester's agents in Sidebots.");
    await page.getByTestId("open-instructions").click();
    const note = page.getByTestId("note");
    await expect(note.getByRole("heading", { name: "Instructions" })).toBeVisible();
    await expect(note.getByTestId("markdown").getByRole("heading", { name: "What you do" })).toBeVisible();
    await expect(note.getByTestId("markdown").getByRole("listitem")).toHaveCount(3);
    await expect(page.getByTestId("panel-title")).toContainText("Planner");
    await page.getByRole("button", { name: "Back to Planner" }).click();
    await expect(page.getByTestId("agent-page")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Jobs & memory" })).toBeChecked();
    await expect(page.getByTestId("job")).toHaveCount(3);
  });

  test("each memory opens as a note under its description, with its markdown drawn", async ({ page, server }) => {
    const planner = await agentNamed(server, "Planner");
    await openAgentPage(page, planner.id);
    await page.getByRole("radio", { name: "Jobs & memory" }).click();
    const memories = page.getByTestId("memory");
    await expect(memories).toHaveCount(4);
    await memories.filter({ hasText: "Birthdays, and who is who" }).click();
    const note = page.getByTestId("note");
    await expect(note.getByRole("heading", { name: "Birthdays, and who is who" })).toBeVisible();
    await expect(note.getByRole("listitem")).toHaveText(["Mum: Helen, birthday 2 March", "Dad: Rob, birthday 28 November, likes coffee and cricket", "Sister: Priya, birthday 14 December, vegetarian"]);
    await page.getByTestId("note-back").click();
    await expect(page.getByRole("radio", { name: "Jobs & memory" })).toBeChecked();
    await memories.filter({ hasText: "When Tester works" }).click();
    await expect(note).toContainText("Works 9 to 5:30, Monday to Friday.");
  });

  test("an agent with no jobs, no memory and no instructions says so in the phone's words", async ({ page, server }) => {
    const pip = await agentNamed(server, "Pip");
    rmSync(join(server.home, "agents", pip.id, PROVIDERS.codex.instructions), { force: true });
    await openAgentPage(page, pip.id);
    await page.getByRole("radio", { name: "Jobs & memory" }).click();
    await expect(page.getByTestId("agent-jobs")).toContainText("None. Ask it to remind you of something, or to keep an eye on something.");
    await expect(page.getByTestId("agent-memory")).toContainText("Nothing yet. It saves what it learns as you talk.");
    await expect(page.getByTestId("open-instructions")).toHaveText("Nothing yet.");
    await page.getByTestId("open-instructions").click();
    await expect(page.getByTestId("note")).toContainText("Nothing yet.");
  });

  test("a job saved in the chat shows on the page", async ({ page, server }) => {
    const pip = await agentNamed(server, "Pip");
    await openAgentPage(page, pip.id);
    await page.getByRole("radio", { name: "Jobs & memory" }).click();
    await expect(page.getByTestId("agent-jobs")).toContainText("None. Ask it to remind you of something, or to keep an eye on something.");
    await server.say(pip.id, "/job");
    // The page stays open, and shows the job once the turn that saved it has ended.
    await expect(page.getByTestId("job")).toHaveCount(1);
    await expect(page.getByTestId("job")).toContainText("Every day at 07:30");
    await expect(page.getByTestId("agent-jobs")).not.toContainText("None.");
    expect((await about(server, pip.id)).jobs).toHaveLength(1);
  });

  test("a page left open follows the agent's turns: what it used, and a job that ran and went", async ({ page, server }) => {
    const pip = await agentNamed(server, "Pip");
    await openAgentPage(page, pip.id);
    const used = page.getByTestId("agent-usage");
    await expect(used).toContainText("It hasn't run a turn.");
    // Nothing on the page flickers as it fetches again: from here on, no row gives its place to a loading one.
    await page.evaluate(() => {
      const seen = window as { loadingRows?: number };
      seen.loadingRows = 0;
      const shown = document.querySelector('[data-testid="agent-page"]')!;
      new MutationObserver(() => (seen.loadingRows = Math.max(seen.loadingRows!, shown.querySelectorAll(".animate-spin").length))).observe(shown, { childList: true, subtree: true });
    });
    await server.say(pip.id, "Hello");
    await expect(used).toContainText(KINDS.reply);
    await expect(used).toContainText("1 turn");
    await expect(used).not.toContainText("It hasn't run a turn.");
    await server.say(pip.id, "Hello again");
    await expect(used).toContainText("2 turns");
    expect(usedBy(await usage(server), pip.id)).toMatchObject([{ kind: "reply", turns: 2 }]);

    // A job removed on another device is gone from the open page once the agent next says something.
    await page.getByRole("radio", { name: "Jobs & memory" }).click();
    await server.say(pip.id, "/job");
    await expect(page.getByTestId("job")).toHaveCount(1);
    const [job] = (await about(server, pip.id)).jobs;
    await server.api(`/agents/${pip.id}/jobs/${job.id}`, { method: "DELETE" });
    await server.control("deliver", { agent: pip.id, text: "Done with that." });
    await expect(page.getByTestId("job")).toHaveCount(0);
    expect(await page.evaluate(() => (window as { loadingRows?: number }).loadingRows)).toBe(0);
  });
});

test.describe("what two agents said to each other", () => {
  test.describe("in the seeded history", () => {
    test.use({ world: "seeded" });

    test("an answered exchange reads as a chat of the two, with no line at its foot", async ({ page, server }) => {
      const [atlas, ledger] = [await agentNamed(server, "Atlas"), await agentNamed(server, "Ledger")];
      const asked = (await allMessages(server, atlas.id)).find((message) => message.peer_id === ledger.id && message.agent_id === atlas.id)!;
      await openChat(page, atlas.id);
      const row = page.getByTestId(`exchange-${asked.id}`);
      await scrollChatTo(page, row);
      await expect(row).toHaveAttribute("data-state", "Answered");
      await expect(row).toHaveAccessibleName("Atlas asked Ledger. Answered");
      await row.click();
      await expect(page.getByTestId("panel-title")).toHaveText("Atlas and Ledger");
      const said = page.getByTestId("exchange-message");
      await expect(said).toHaveCount(2);
      await expect(said.nth(0)).toHaveAttribute("data-side", "end");
      await expect(said.nth(0)).toContainText("Tester wants to know whether £340 for the sage tiles fits");
      await expect(said.nth(1)).toHaveAttribute("data-side", "start");
      await expect(said.nth(1)).toContainText("There's £410 left in Home for November");
      await expect(page.getByTestId("exchange-state")).toHaveCount(0);
    });

    test("an exchange that got no answer says No answer, with its dots at rest", async ({ page, server }) => {
      const [atlas, scout] = [await agentNamed(server, "Atlas"), await agentNamed(server, "Scout")];
      const asked = (await allMessages(server, atlas.id)).find((message) => message.peer_id === scout.id && message.agent_id === atlas.id)!;
      await openChat(page, atlas.id);
      const row = page.getByTestId(`exchange-${asked.id}`);
      await scrollChatTo(page, row);
      await expect(row).toHaveAttribute("data-state", "No answer");
      await row.click();
      await expect(page.getByTestId("panel-title")).toHaveText("Atlas and Scout");
      await expect(page.getByTestId("exchange-message")).toHaveCount(1);
      const state = page.getByTestId("exchange-state");
      await expect(state).toHaveText("No answer");
      await expect(state.locator(".animate-flow")).toHaveCount(0);
    });
  });

  test.describe("as it happens", () => {
    test("an exchange shows Waiting on the other agent with running dots, then its answer as it comes", async ({ page, server }) => {
      const atlas = await addAgent(page, server, "Atlas");
      await addAgent(page, server, "Ledger", "codex");
      await openChat(page, atlas.id);
      await server.control("pause", { ms: 4000 });
      await sendFromComposer(page, "/agent Ledger how much budget is left in Home?");
      const row = page.locator('[data-testid^="exchange-"][data-state]');
      await expect(row).toHaveAttribute("data-state", "Waiting", { timeout: 20_000 });
      await row.click();
      await expect(page.getByTestId("panel-title")).toHaveText("Atlas and Ledger");
      const state = page.getByTestId("exchange-state");
      await expect(state).toHaveText("Waiting on Ledger");
      await expect(state.locator(".animate-flow")).toHaveCount(3);
      await expect(page.getByTestId("panel-title").locator(".animate-flow")).toHaveCount(4);
      await expect(page.getByTestId("exchange-message").last()).toContainText("There's £410 left in Home for November", { timeout: 20_000 });
      await expect(state).toHaveCount(0);
      await expect(page.getByTestId("panel-title").locator(".animate-flow")).toHaveCount(0);
    });

    test("an exchange that needs the person's OK can be answered from inside the panel", async ({ page, server }) => {
      const atlas = await addAgent(page, server, "Atlas");
      const tidy = await addAgent(page, server, "Tidy");
      await openChat(page, atlas.id);
      await sendFromComposer(page, "/agent-ask Tidy");
      const row = page.locator('[data-testid^="exchange-"][data-state]');
      await expect(row).toHaveAttribute("data-state", "Needs your OK", { timeout: 20_000 });
      await row.click();
      const panel = page.getByTestId("panel");
      await expect(panel.getByTestId("exchange-state")).toHaveText("Needs your OK");
      const card = panel.getByTestId("ask-card");
      await expect(card).toContainText("Tidy asks");
      await panel.getByTestId("ask-answers").getByRole("button", { name: "Allow", exact: true }).click();
      await expect(panel.getByTestId("ask-outcome")).toHaveText("Allowed");
      await until(() => chat(server, tidy.id), (messages) => messages.some((message) => message.ask === "allowed"));
      await expect(panel.getByTestId("exchange-message").last()).toContainText("Done: I cleared out 14 invoices older than a year.", { timeout: 20_000 });
      await expect(panel.getByTestId("exchange-state")).toHaveCount(0);
      await expect(row).toHaveAttribute("data-state", "Answered");
    });
  });
});

test.describe("pictures", () => {
  test("several pictures go back and forth by button and by arrow key, with where each is among them", async ({ page, server }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/images 3");
    const photos = page.getByTestId("message-photos").getByRole("button");
    await expect(photos).toHaveCount(3);
    await photos.first().click();
    await expect(page.getByTestId("images")).toBeVisible();
    const count = page.getByTestId("image-count");
    await expect(count).toHaveText("1 of 3");
    await expect(page.getByTestId("panel-title")).toContainText("Sunset-from-the-ferry.png");
    await expect(page.getByTestId("image-previous")).toBeDisabled();
    await page.getByTestId("image-next").click();
    await expect(count).toHaveText("2 of 3");
    await page.keyboard.press("ArrowRight");
    await expect(count).toHaveText("3 of 3");
    await expect(page.getByTestId("image-next")).toBeDisabled();
    // At the last picture, the arrow key goes no further.
    await page.keyboard.press("ArrowRight");
    await expect(count).toHaveText("3 of 3");
    await page.keyboard.press("ArrowLeft");
    await expect(count).toHaveText("2 of 3");
    await page.getByTestId("image-previous").click();
    await expect(count).toHaveText("1 of 3");
    await expect(page.getByTestId("image")).toHaveAttribute("alt", "Sunset-from-the-ferry.png");
  });

  test("a click on a picture in the chat opens the panel at that picture", async ({ page, server }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/images 3");
    await page.getByTestId("message-photos").getByRole("button").nth(2).click();
    await expect(page.getByTestId("image-count")).toHaveText("3 of 3");
  });

  test("one picture shows with no count and no buttons to step", async ({ page, server }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/image");
    await page.getByTestId("message-photos").getByRole("button").click();
    await expect(page.getByTestId("image")).toBeVisible();
    await expect(page.getByTestId("image-count")).toHaveCount(0);
    await expect(page.getByTestId("image-next")).toHaveCount(0);
    await expect(page.getByTestId("image-previous")).toHaveCount(0);
  });

  test("a picture fits the panel, shows at its own size on a click, and fits again on another", async ({ page, server }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/image");
    await page.getByTestId("message-photos").getByRole("button").click();
    const image = page.getByTestId("image");
    await expect.poll(() => image.evaluate((drawn: HTMLImageElement) => drawn.complete && drawn.naturalWidth)).toBe(1200);
    const fitted = await image.evaluate((drawn) => drawn.getBoundingClientRect().width);
    expect(fitted).toBeLessThan(1200);
    expect(fitted).toBeLessThanOrEqual(await panelWidth(page));
    await expect(image).toHaveClass(/cursor-zoom-in/);
    await image.click();
    await expect(image).toHaveAttribute("data-actual", "true");
    await expect.poll(() => image.evaluate((drawn) => Math.round(drawn.getBoundingClientRect().width))).toBe(1200);
    await image.click();
    await expect(image).not.toHaveAttribute("data-actual", "true");
    await expect.poll(() => image.evaluate((drawn) => Math.round(drawn.getBoundingClientRect().width))).toBe(Math.round(fitted));
  });

  test("Open hands the picture to the computer's own app, and Save as… saves it", async ({ page, server, mainCalls }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/image");
    await page.getByTestId("message-photos").getByRole("button").click();
    await page.getByTestId("image-open").click();
    await expect.poll(async () => (await mainCalls()).files).toEqual([expect.stringMatching(/Sunset-from-the-ferry\.png$/)]);
    await page.getByTestId("image-save").click();
    await expect.poll(async () => (await mainCalls()).saved).toEqual(["Sunset-from-the-ferry.png"]);
    expect((await mainCalls()).opened).toEqual([]);
  });

  test("a very wide and a very tall picture each fit inside the panel", async ({ page, server }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await page.getByTestId("file-input").setInputFiles([await pngUpload("panorama.png", 4000, 160), await pngUpload("tower.png", 160, 4000)]);
    await page.getByTestId("message-field").press("Enter");
    const photos = page.getByTestId("message-photos").getByRole("button");
    await expect(photos).toHaveCount(2);
    for (const index of [0, 1]) {
      await photos.nth(index).click();
      const image = page.getByTestId("image");
      await expect.poll(() => image.evaluate((drawn: HTMLImageElement) => drawn.complete && drawn.naturalWidth > 0)).toBe(true);
      const [box, room] = await Promise.all([image.boundingBox(), page.getByTestId("images").boundingBox()]);
      expect(box!.x).toBeGreaterThanOrEqual(room!.x);
      expect(box!.y).toBeGreaterThanOrEqual(room!.y);
      expect(box!.x + box!.width).toBeLessThanOrEqual(room!.x + room!.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(room!.y + room!.height + 1);
      // Its shape is kept: it is drawn smaller, not squashed.
      expect(Math.abs(box!.width / box!.height - (index === 0 ? 25 : 1 / 25))).toBeLessThan(index === 0 ? 2 : 0.01);
      await image.click();
      await expect(image).toHaveAttribute("data-actual", "true");
      await page.getByTestId("close-panel").click();
    }
  });
});

test.describe("a page an agent sent", () => {
  test("fills the panel, and reloads as a new page", async ({ page, server }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/page tall");
    await page.getByTestId("open-page").click();
    await expect(page.getByTestId("panel-title")).toHaveText("Flats in Brunswick");
    const holder = page.getByTestId("panel").getByTestId("page");
    const frame = holder.locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const [held, drawn] = await Promise.all([holder.boundingBox(), frame.boundingBox()]);
    expect(Math.round(drawn!.height)).toBe(Math.round(held!.height));
    expect(Math.round(drawn!.width)).toBe(Math.round(held!.width));
    const inPanel = await frame.elementHandle().then((handle) => handle!.contentFrame());
    await inPanel!.waitForLoadState("load");
    // The tall page scrolls inside the panel.
    expect(await inPanel!.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
    await inPanel!.evaluate(() => void ((window as { mark?: number }).mark = 1));
    await page.getByTestId("page-reload").click();
    await expect
      .poll(async () => {
        const fresh = await holder.locator("iframe").elementHandle().then((handle) => handle?.contentFrame());
        return fresh ? fresh.evaluate(() => document.readyState === "complete" && (window as { mark?: number }).mark === undefined).catch(() => false) : false;
      })
      .toBe(true);
  });

  test("Open in browser hands the page's file to the computer", async ({ page, server, mainCalls }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/page");
    await page.getByTestId("open-page").click();
    await page.getByTestId("page-open").click();
    await expect.poll(async () => (await mainCalls()).files).toEqual([expect.stringMatching(/\.html$/)]);
  });

  test("opening another chat closes the page about the first", async ({ page, server }) => {
    const first = await addAgent(page, server, "Atlas");
    const second = await addAgent(page, server, "Ledger");
    await openChat(page, first.id);
    await sendFromComposer(page, "/page");
    await page.getByTestId("open-page").click();
    await expect(page.getByTestId("panel")).toBeVisible();
    await openChat(page, second.id);
    await expect(page.getByTestId("panel")).toBeHidden();
    await expect(page.getByTestId("chat-name")).toHaveText("Ledger");
  });

  test("the page takes the window's colours, and changes with them when the system turns dark", async ({ page, server, setColorScheme }) => {
    // The test starts in light, whichever the computer is set to.
    await setColorScheme("light");
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/page");
    await page.getByTestId("open-page").click();
    // The page's colours once it has loaded, or nothing while the frame is loading it again, which a change of colours makes it do.
    const pageColors = async () => {
      const frame = await page.getByTestId("panel").locator("iframe").elementHandle().then((handle) => handle!.contentFrame());
      await frame!.waitForLoadState("load");
      return frame!.evaluate(() => ({ scheme: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.documentElement).backgroundColor })).catch(() => null);
    };
    const canvas = () => page.getByTestId("panel").evaluate((panel) => getComputedStyle(panel).backgroundColor);
    await expect.poll(pageColors).toEqual({ scheme: "light", bg: await canvas() });
    const light = await canvas();
    await setColorScheme("dark");
    await expect.poll(canvas).not.toBe(light);
    await expect.poll(pageColors).toEqual({ scheme: "dark", bg: await canvas() });
  });
});

test.describe("the panel's frame", () => {
  test.use({ world: "seeded" });

  test("Close and Esc each close the panel", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    await page.getByTestId("close-panel").click();
    await expect(page.getByTestId("panel")).toBeHidden();
    await page.getByTestId("chat-agent").click();
    await page.getByRole("radio", { name: "Jobs & memory" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("panel")).toBeHidden();
    // The chat stays open behind it.
    await expect(page.getByTestId("chat-name")).toHaveText("Atlas");
  });

  test("the panel is dragged wider and narrower within its limits", async ({ page, server, setWindowSize }) => {
    await setWindowSize(1400, 900);
    await openAgentPage(page, (await agentNamed(server, "Atlas")).id);
    // It opens at 480, its first width.
    await expect.poll(() => panelWidth(page)).toBe(480);
    await dragPanelEdge(page, -100);
    await expect.poll(() => panelWidth(page)).toBe(580);
    // At most it leaves the sidebar its 280 and the chat its 380.
    await dragPanelEdge(page, -600);
    await expect.poll(() => panelWidth(page)).toBe(1400 - 280 - 380);
    await dragPanelEdge(page, 900);
    await expect.poll(() => panelWidth(page)).toBe(360);
    await expect(page.getByRole("separator", { name: "Panel width" })).toHaveAttribute("aria-valuenow", "360");
  });

  test("the width the panel was dragged to is kept when the app opens again", async ({ page, server, setWindowSize, restartApp }) => {
    await setWindowSize(1400, 900);
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    await setPanelTo(page, 600);
    const again = await restartApp();
    await openAgentPage(again.page, atlas.id);
    await expect.poll(() => panelWidth(again.page)).toBe(600);
  });

  test("below 980 pixels wide the panel lies over the chat as a sheet, which a click beside it closes", async ({ page, server, setWindowSize }) => {
    await setWindowSize(900, 700);
    await openAgentPage(page, (await agentNamed(server, "Atlas")).id);
    const panel = page.getByTestId("panel");
    expect(await panel.evaluate((aside) => getComputedStyle(aside).position)).toBe("fixed");
    const [box, column] = await Promise.all([panel.boundingBox(), page.getByTestId("chat-column").boundingBox()]);
    await expect.poll(async () => Math.round(await panel.evaluate((aside) => aside.getBoundingClientRect().right))).toBe(900);
    // The chat keeps its width under the sheet.
    expect(column!.x + column!.width).toBeGreaterThan(box!.x + 1);
    await page.mouse.click(box!.x - 40, 300);
    await expect(panel).toBeHidden();
  });

  test("the sheet at the smallest window is still usable", async ({ page, server, setWindowSize }) => {
    await setWindowSize(760, 520);
    await openAgentPage(page, (await agentNamed(server, "Atlas")).id);
    const box = (await page.getByTestId("panel").boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(360);
    expect(box.width).toBeLessThanOrEqual(760 * 0.6 + 1);
    await expect(page.getByTestId("delete-agent")).toBeAttached();
    await page.getByTestId("delete-agent").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("delete-agent")).toBeInViewport();
  });

  test("opening another view replaces the one the panel showed", async ({ page, server }) => {
    const atlas = await agentNamed(server, "Atlas");
    await openAgentPage(page, atlas.id);
    const photo = page.getByTestId("message-photos").last().getByRole("button").first();
    await scrollChatTo(page, photo);
    await photo.click();
    await expect(page.getByTestId("images")).toBeVisible();
    await expect(page.getByTestId("agent-page")).toHaveCount(0);
    await expect(page.getByTestId("panel")).toHaveCount(1);
  });
});

// Pictures of each view of the panel, and each section of Settings, in light and dark and at two widths of the panel, for a person to look over. They are made only when PANEL_SHOTS names the folder to write them to:
//
//   PANEL_SHOTS=<folder> pnpm e2e e2e/panel.spec.ts --grep @shots
test.describe("pictures for review @shots", () => {
  test.use({ world: "seeded" });
  test.skip(!process.env.PANEL_SHOTS, "PANEL_SHOTS names the folder the pictures go to.");
  test.setTimeout(240_000);

  test("each panel view and Settings section, in light and dark, at 360 and 600 wide", async ({ page, server, setColorScheme, setWindowSize }) => {
    const folder = process.env.PANEL_SHOTS!;
    await setWindowSize(1400, 900);
    const [atlas, ledger, planner] = [await agentNamed(server, "Atlas"), await agentNamed(server, "Ledger"), await agentNamed(server, "Planner")];
    const asked = (await allMessages(server, atlas.id)).find((message) => message.peer_id === ledger.id && message.agent_id === atlas.id)!;
    const settle = () => page.waitForTimeout(450);
    const shoot = async (name: string) => {
      await settle();
      await page.getByTestId("panel").screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
    };
    const views: [string, () => Promise<void>][] = [
      ["agent-settings", async () => openAgentPage(page, atlas.id)],
      [
        "agent-jobs-memory",
        async () => {
          await openAgentPage(page, planner.id);
          await page.getByRole("radio", { name: "Jobs & memory" }).click();
        },
      ],
      [
        "agent-edit",
        async () => {
          await openAgentPage(page, atlas.id);
          await page.getByTestId("edit-agent").click();
        },
      ],
      [
        "note-memory",
        async () => {
          await openAgentPage(page, planner.id);
          await page.getByRole("radio", { name: "Jobs & memory" }).click();
          await page.getByTestId("memory").filter({ hasText: "Birthdays" }).click();
        },
      ],
      [
        "note-instructions",
        async () => {
          await openAgentPage(page, planner.id);
          await page.getByRole("radio", { name: "Jobs & memory" }).click();
          await page.getByTestId("open-instructions").click();
        },
      ],
      [
        "exchange",
        async () => {
          await openChat(page, atlas.id);
          const row = page.getByTestId(`exchange-${asked.id}`);
          await scrollChatTo(page, row);
          await row.click();
          await expect(page.getByTestId("exchange-message")).toHaveCount(2);
        },
      ],
      [
        "images",
        async () => {
          await openChat(page, atlas.id);
          const photos = page.getByTestId("message-theirs").filter({ hasText: "Here are three from the trip" }).getByTestId("message-photos").getByRole("button");
          await scrollChatTo(page, photos.first());
          await photos.first().click();
          await expect.poll(() => page.getByTestId("image").evaluate((drawn: HTMLImageElement) => drawn.complete && drawn.naturalWidth > 0)).toBe(true);
        },
      ],
      [
        "page",
        async () => {
          await openChat(page, atlas.id);
          const open = page.getByTestId("open-page").last();
          await scrollChatTo(page, open);
          await open.click();
          await pageFrame(page, "Grocery");
        },
      ],
    ];
    for (const scheme of ["light", "dark"] as const) {
      await setColorScheme(scheme);
      for (const width of [360, 600]) {
        for (const [name, open] of views) {
          if (await page.getByTestId("panel").isVisible()) await page.getByTestId("close-panel").click();
          await open();
          if ((await panelWidth(page)) !== width) await setPanelTo(page, width);
          await shoot(`${name}-${scheme}-${width}`);
        }
      }
      if (await page.getByTestId("panel").isVisible()) await page.getByTestId("close-panel").click();
      await page.getByTestId("settings-button").click();
      for (const section of ["usage", "connections", "phones", "about"]) {
        await page.getByTestId(`settings-${section}`).click();
        if (section === "phones") await page.getByTestId("pair-phone").click();
        if (section === "phones") await expect(page.getByTestId("pairing-code")).toBeVisible();
        await settle();
        await page.getByTestId("settings").screenshot({ path: join(folder, `settings-${section}-${scheme}.png`), animations: "disabled" });
      }
      await page.keyboard.press("Escape");
    }
  });
});
