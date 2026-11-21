// The system's notifications and the number on the app's icon. A reply, an
// ask or a failure notifies, by the rule the server notifies phones by
// (`notifies` in server/src/contract.ts, and server/src/push.ts), unless the
// person is looking at its chat or the agent is muted. A click on one opens
// its chat. The icon counts the unread messages of the agents that aren't
// muted. The fixtures record each notification and each badge the main
// process is asked for, in place of showing them.

import type { Page } from "@playwright/test";
import { notifies, oneLine, type Message } from "../../server/src/contract.ts";
import { expect, test, type TestServer } from "./fixtures.ts";
import { addAgent, agents, chat, clickNotification, keepNotifications, leaveWindow, openChat, until } from "./panel-support.ts";

/** Sends a message from the composer of the open chat, as the person types it. */
async function sendFromComposer(page: Page, words: string): Promise<void> {
  await page.getByTestId("message-field").fill(words);
  await page.getByTestId("message-field").press("Enter");
}

/** Waits for a message of the agent's that `matches`, on the server, and resolves to it. */
const arrives = (server: TestServer, agentId: string, matches: (message: Message) => boolean) =>
  until(() => chat(server, agentId), (messages) => messages.some(matches)).then((messages) => messages.findLast(matches)!);

/** A reply of the agent's to the person, as opposed to an update, an ask or something said between agents. */
const isReply = (message: Message) => message.sender === "agent" && !message.interim && message.ask === null && message.peer_id === null;

test.describe("what notifies", () => {
  test("a reply in a chat that isn't open notifies with the agent's name and the message as one line", async ({ page, server, mainCalls }) => {
    const atlas = await addAgent(page, server, "Atlas");
    const ledger = await addAgent(page, server, "Ledger");
    await openChat(page, atlas.id);
    await server.control("deliver", { agent: ledger.id, text: "Your card statement is in.\n\n**£1,284** this month, `£96` of it takeaways.\n\n- Groceries\n- Rent" });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Ledger", body: "Your card statement is in. £1,284 this month, £96 of it takeaways. Groceries Rent" }]);
  });

  test("a long reply notifies with its first 300 characters", async ({ page, server, mainCalls }) => {
    const ledger = await addAgent(page, server, "Ledger");
    const text = "Long words. ".repeat(40).trim();
    await server.control("deliver", { agent: ledger.id, text });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Ledger", body: text.slice(0, 300) }]);
  });

  test("a reply with only a file notifies that an attachment came", async ({ page, server, mainCalls }) => {
    const ledger = await addAgent(page, server, "Ledger");
    await server.control("deliver", { agent: ledger.id, text: "", files: ["csv"] });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Ledger", body: "Attachment" }]);
  });

  test("an ask notifies with what it asks", async ({ page, server, mainCalls }) => {
    const ledger = await addAgent(page, server, "Ledger");
    await server.control("ask", { agent: ledger.id, kind: "command" });
    const ask = await arrives(server, ledger.id, (message) => message.ask === "waiting");
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Ledger", body: oneLine(ask) }]);
  });

  test("a turn that fails notifies with the words it failed with", async ({ page, server, mainCalls }) => {
    const ledger = await addAgent(page, server, "Ledger");
    await server.say(ledger.id, "/fail");
    const failed = await arrives(server, ledger.id, (message) => message.sender === "sidebots" && message.status === "failed");
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Ledger", body: failed.body }]);
  });

  test("a job's message notifies as a reply does", async ({ page, server, mainCalls }) => {
    const planner = await addAgent(page, server, "Planner");
    await server.say(planner.id, "/job");
    await arrives(server, planner.id, isReply);
    await expect.poll(async () => (await mainCalls()).notices.length).toBe(1);
    await server.control("run-job", { agent: planner.id });
    const sent = await arrives(server, planner.id, (message) => message.job_id !== null);
    await expect.poll(async () => (await mainCalls()).notices.at(-1)).toEqual({ title: "Planner", body: oneLine(sent) });
  });
});

test.describe("what doesn't notify", () => {
  test("a reply in the chat the person is looking at doesn't notify", async ({ page, server, mainCalls }) => {
    const atlas = await addAgent(page, server, "Atlas");
    const ledger = await addAgent(page, server, "Ledger");
    await openChat(page, atlas.id);
    await sendFromComposer(page, "hello");
    await expect(page.getByTestId("message-theirs")).toHaveCount(1);
    await server.control("deliver", { agent: atlas.id, text: "One more thing about the boiler." });
    await expect(page.getByTestId("timeline")).toContainText("One more thing about the boiler.");
    // A reply in another chat afterwards is the one notification, which proves the window had heard the first two by then.
    await server.control("deliver", { agent: ledger.id, text: "Control." });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Ledger", body: "Control." }]);
  });

  test("a message that arrives in an open chat with no messages yet shows in it, and doesn't notify", async ({ page, server, mainCalls }) => {
    const atlas = await addAgent(page, server, "Atlas");
    const ledger = await addAgent(page, server, "Ledger");
    await openChat(page, atlas.id);
    await server.control("deliver", { agent: atlas.id, text: "Morning! The boiler engineer comes at 8." });
    await server.control("deliver", { agent: ledger.id, text: "Control." });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Ledger", body: "Control." }]);
    await expect(page.getByTestId("timeline")).toContainText("Morning! The boiler engineer comes at 8.");
  });

  test("a muted agent's reply doesn't notify", async ({ page, server, mainCalls }) => {
    const ledger = await addAgent(page, server, "Ledger");
    const tidy = await addAgent(page, server, "Tidy");
    await page.getByTestId(`agent-${ledger.id}`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mute" }).click();
    await until(() => agents(server), (all) => all.find((agent) => agent.id === ledger.id)!.muted);
    await server.control("deliver", { agent: ledger.id, text: "Muted words." });
    await expect(page.getByTestId(`agent-${ledger.id}`)).toContainText("Muted words.");
    await server.control("deliver", { agent: tidy.id, text: "Control." });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Tidy", body: "Control." }]);
  });

  test("an update while the agent works doesn't notify, and its reply does", async ({ page, server, mainCalls }) => {
    const ledger = await addAgent(page, server, "Ledger");
    await server.say(ledger.id, "/update");
    const reply = await arrives(server, ledger.id, isReply);
    expect((await chat(server, ledger.id)).filter((message) => message.interim)).toHaveLength(2);
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Ledger", body: reply.body }]);
  });

  test("an answered ask doesn't notify again, and what the agent says after it does", async ({ page, server, mainCalls }) => {
    const ledger = await addAgent(page, server, "Ledger");
    await server.control("ask", { agent: ledger.id, kind: "command" });
    const ask = await arrives(server, ledger.id, (message) => message.ask === "waiting");
    await expect.poll(async () => (await mainCalls()).notices.length).toBe(1);
    await server.api(`/agents/${ledger.id}/asks/${ask.id}`, { method: "POST", body: JSON.stringify({ allow: true }) });
    const reply = await arrives(server, ledger.id, (message) => isReply(message) && message.created_at >= ask.created_at);
    await expect.poll(async () => (await mainCalls()).notices).toEqual([
      { title: "Ledger", body: oneLine(ask) },
      { title: "Ledger", body: reply.body },
    ]);
  });

  test("what one agent asks another, and its answer, don't notify", async ({ page, server, mainCalls }) => {
    const atlas = await addAgent(page, server, "Atlas");
    const ledger = await addAgent(page, server, "Ledger");
    await server.say(atlas.id, "/agent Ledger how much budget is left in Home?");
    await arrives(server, atlas.id, (message) => isReply(message) && message.body.startsWith("Heard back from Ledger"));
    await until(() => agents(server), (all) => !all.some((agent) => agent.working));
    const tidy = await addAgent(page, server, "Tidy");
    await server.control("deliver", { agent: tidy.id, text: "Control." });
    await expect.poll(async () => (await mainCalls()).notices.at(-1)).toEqual({ title: "Tidy", body: "Control." });
    const { notices } = await mainCalls();
    expect(notices.filter((notice) => notice.title === "Ledger")).toEqual([]);
    // Atlas notifies for what the server's rule says it should: its replies to the person, and not its update while it waits.
    const told = (await chat(server, atlas.id)).filter((message) => message.agent_id === atlas.id && notifies(message)).map((message) => oneLine(message));
    expect(told).toEqual([expect.stringMatching(/^Heard back from Ledger: /)]);
    expect(notices.filter((notice) => notice.title === "Atlas").map((notice) => notice.body)).toEqual(told);
    expect((await chat(server, ledger.id)).some((message) => message.agent_id === ledger.id && message.peer_id === atlas.id)).toBe(true);
  });
});

test.describe("when the person isn't looking", () => {
  test("a reply in the open chat notifies when the window isn't the one in front", async ({ page, server, mainCalls, electronApp }) => {
    const atlas = await addAgent(page, server, "Atlas");
    await openChat(page, atlas.id);
    await sendFromComposer(page, "hello");
    await expect(page.getByTestId("message-theirs")).toHaveCount(1);
    await leaveWindow(page, electronApp);
    await server.control("deliver", { agent: atlas.id, text: "While you were away." });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Atlas", body: "While you were away." }]);
  });

  test("a reply in the open chat notifies when the window is hidden", async ({ page, server, mainCalls, electronApp }) => {
    const atlas = await addAgent(page, server, "Atlas");
    await openChat(page, atlas.id);
    await sendFromComposer(page, "hello");
    await expect(page.getByTestId("message-theirs")).toHaveCount(1);
    // A hidden window has no focus; the test has the window read its focus as the system gives it, which Playwright otherwise always reads as there, and the window goes from the front as it hides.
    await leaveWindow(page, electronApp);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await server.control("deliver", { agent: atlas.id, text: "While the window was hidden." });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Atlas", body: "While the window was hidden." }]);
  });
});

test.describe("one notification for each message", () => {
  test("a reply that came while the event stream was down notifies once when it comes back", async ({ page, server, mainCalls }) => {
    const ledger = await addAgent(page, server, "Ledger");
    const tidy = await addAgent(page, server, "Tidy");
    await server.control("drop-events", { ms: 3000 });
    await server.control("deliver", { agent: ledger.id, text: "Said while the stream was down." });
    await expect(page.getByTestId(`agent-${ledger.id}`)).toContainText("Said while the stream was down.", { timeout: 20_000 });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Ledger", body: "Said while the stream was down." }]);
    // The stream drops again with nothing new, and comes back, and nothing notifies again.
    await server.control("drop-events", { ms: 500 });
    await server.control("outage", { ms: 1000 });
    await expect(page.getByTestId("reach")).toHaveText("Connected", { timeout: 20_000 });
    await server.control("deliver", { agent: tidy.id, text: "Control." });
    await expect.poll(async () => (await mainCalls()).notices).toEqual([
      { title: "Ledger", body: "Said while the stream was down." },
      { title: "Tidy", body: "Control." },
    ]);
  });

  test.describe("at startup", () => {
    test.use({ world: "seeded" });

    test("what was already unread when the app opened doesn't notify", async ({ page, server, mainCalls }) => {
      expect((await agents(server)).some((agent) => agent.unread > 0 && !agent.muted)).toBe(true);
      const pip = (await agents(server)).find((agent) => agent.name === "Pip")!;
      await expect(page.getByTestId(`agent-${pip.id}`)).toBeVisible();
      await server.control("deliver", { agent: pip.id, text: "Control." });
      await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Pip", body: "Control." }]);
    });

    test("a message that notified before the app closed doesn't notify again when it opens", async ({ page, server, mainCalls, restartApp }) => {
      const pip = (await agents(server)).find((agent) => agent.name === "Pip")!;
      await server.control("deliver", { agent: pip.id, text: "Said before the app closed." });
      await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Pip", body: "Said before the app closed." }]);
      void page;
      const again = await restartApp();
      await expect(again.page.getByTestId(`agent-${pip.id}`)).toContainText("Said before the app closed.");
      await server.control("deliver", { agent: pip.id, text: "Control." });
      await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Pip", body: "Control." }]);
    });
  });
});

test.describe("a click on a notification", () => {
  test("opens its chat", async ({ page, server, electronApp, mainCalls }) => {
    await keepNotifications(electronApp);
    const atlas = await addAgent(page, server, "Atlas");
    const ledger = await addAgent(page, server, "Ledger");
    await openChat(page, atlas.id);
    const sent = await server.control<Message>("deliver", { agent: ledger.id, text: "Click me." });
    await expect.poll(async () => (await mainCalls()).notices.length).toBe(1);
    await clickNotification(electronApp, 0);
    await expect(page.getByTestId("chat-name")).toHaveText("Ledger");
    await expect(page.locator(`[data-message-id="${sent.id}"]`)).toBeVisible();
  });

  test("closes Settings first", async ({ page, server, electronApp, mainCalls }) => {
    await keepNotifications(electronApp);
    const ledger = await addAgent(page, server, "Ledger");
    await page.getByTestId("settings-button").click();
    await expect(page.getByTestId("settings")).toBeVisible();
    await server.control("deliver", { agent: ledger.id, text: "Click me." });
    await expect.poll(async () => (await mainCalls()).notices.length).toBe(1);
    await clickNotification(electronApp, 0);
    await expect(page.getByTestId("settings")).toBeHidden();
    await expect(page.getByTestId("chat-name")).toHaveText("Ledger");
  });

  test("closes the new agent dialog first", async ({ page, server, electronApp, mainCalls }) => {
    await keepNotifications(electronApp);
    const ledger = await addAgent(page, server, "Ledger");
    await page.getByTestId("new-agent-button").click();
    await expect(page.getByTestId("agent-name")).toBeVisible();
    await server.control("deliver", { agent: ledger.id, text: "Click me." });
    await expect.poll(async () => (await mainCalls()).notices.length).toBe(1);
    await clickNotification(electronApp, 0);
    await expect(page.getByTestId("agent-name")).toBeHidden();
    await expect(page.getByTestId("chat-name")).toHaveText("Ledger");
  });

  test("shows the window when it was hidden", async ({ page, server, electronApp, mainCalls }) => {
    await keepNotifications(electronApp);
    const ledger = await addAgent(page, server, "Ledger");
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    await server.control("deliver", { agent: ledger.id, text: "Click me." });
    await expect.poll(async () => (await mainCalls()).notices.length).toBe(1);
    await clickNotification(electronApp, 0);
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await expect(page.getByTestId("chat-name")).toHaveText("Ledger");
  });
});

test.describe("a click on a notification for a turn that ended without a reply", () => {
  test.use({ world: "seeded" });

  test("opens the chat at the message the turn answered, without paging back through the chat", async ({ page, server, electronApp, mainCalls }) => {
    await keepNotifications(electronApp);
    const all = await agents(server);
    const atlas = all.find((agent) => agent.name === "Atlas")!;
    await openChat(page, all.find((agent) => agent.name === "Pip")!.id);
    // Atlas's chat is several pages long, and the reply that notifies draws no row in it.
    const older: string[] = [];
    page.on("request", (request) => void (request.url().includes("/messages?before=") && older.push(request.url())));
    const asked = await server.say(atlas.id, "/silent");
    const reply = await arrives(server, atlas.id, (message) => message.reply_to === null && message.sender === "agent" && message.body === "" && message.created_at >= Date.now() - 30_000);
    await expect.poll(async () => (await mainCalls()).notices).toEqual([{ title: "Atlas", body: "Done" }]);
    await clickNotification(electronApp, 0);
    await expect(page.getByTestId("chat-name")).toHaveText("Atlas");
    await expect(page.locator(`[data-message-id="${reply.id}"]`)).toHaveCount(0);
    const row = page.locator(`[data-message-id="${asked.id}"]`);
    await expect(row).toBeInViewport();
    await expect(row).toHaveClass(/animate-flash/);
    expect(older).toEqual([]);
    expect(await page.getByTestId("timeline").locator("[data-message-id]").count()).toBeLessThanOrEqual(50);
  });
});

test.describe("the badge on the app's icon", () => {
  test("is 0 when nothing is unread", async ({ page, server, mainCalls }) => {
    await addAgent(page, server, "Atlas");
    await expect.poll(async () => (await mainCalls()).badge.at(-1)).toBe(0);
  });

  test("never counts what comes into the chat the person is looking at, and counts it once they look away", async ({ page, server, electronApp, mainCalls }) => {
    const atlas = await addAgent(page, server, "Atlas");
    const ledger = await addAgent(page, server, "Ledger");
    await openChat(page, atlas.id);
    for (const text of ["One.", "Two.", "Three."]) {
      await server.control("deliver", { agent: atlas.id, text });
      await expect(page.getByTestId("message-theirs").filter({ hasText: text })).toBeVisible();
    }
    await expect.poll(async () => (await agents(server)).find((agent) => agent.id === atlas.id)!.unread).toBe(0);
    // A message in another chat is the first thing the icon counts, which proves it had heard the three by then.
    await server.control("deliver", { agent: ledger.id, text: "Control." });
    await expect.poll(async () => (await mainCalls()).badge.at(-1)).toBe(1);
    expect((await mainCalls()).badge.filter((count) => count !== 0)).toEqual([1]);

    // With the window behind another app, a message in the open chat is unread, and the icon counts it.
    await leaveWindow(page, electronApp);
    await server.control("deliver", { agent: atlas.id, text: "While you were away." });
    await expect.poll(async () => (await mainCalls()).badge.at(-1)).toBe(2);
  });

  test.describe("in the seeded world", () => {
    test.use({ world: "seeded" });

    /** The unread messages of the agents that aren't muted, as the server counts them. */
    const unread = async (server: TestServer) => (await agents(server)).reduce((total, agent) => total + (agent.muted ? 0 : agent.unread), 0);

    test("counts the unread messages of the agents that aren't muted", async ({ page, server, mainCalls }) => {
      const all = await agents(server);
      // Each row shows its own count first, so a badge that is off says which agent it is off by.
      for (const agent of all.filter((each) => each.unread > 0)) await expect(page.getByTestId(`agent-${agent.id}`).getByLabel(`${agent.unread} unread`)).toBeVisible();
      const expected = await unread(server);
      expect(expected).toBe(4);
      await expect.poll(async () => (await mainCalls()).badge.at(-1)).toBe(expected);
    });

    test("follows each message read, each new one, and each agent muted or unmuted", async ({ page, server, mainCalls }) => {
      const badge = async () => (await mainCalls()).badge.at(-1);
      const all = await agents(server);
      const named = (name: string) => all.find((agent) => agent.name === name)!;
      await expect.poll(badge).toBe(4);
      // Reading Ledger's two.
      await openChat(page, named("Ledger").id);
      await expect.poll(badge).toBe(2);
      await expect.poll(() => unread(server)).toBe(2);
      // A new message from Pip.
      await server.control("deliver", { agent: named("Pip").id, text: "New." });
      await expect.poll(badge).toBe(3);
      // Muting Patch, whose one is unread, takes it off; unmuting Scout puts its two on.
      await page.getByTestId(`agent-${named("Patch").id}`).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Mute" }).click();
      await expect.poll(badge).toBe(2);
      await page.getByTestId(`agent-${named("Scout").id}`).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Unmute" }).click();
      await expect.poll(badge).toBe(4);
      await expect.poll(() => unread(server)).toBe(4);
    });
  });
});
