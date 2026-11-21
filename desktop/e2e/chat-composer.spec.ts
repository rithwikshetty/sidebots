// The chat's composer, driven as a person drives it: typing and sending,
// what comes back, Stop, the chat's menu, and the keyboard. Each test starts
// from Tester with no agents and adds the agents it talks to, so nothing else
// in the chat moves while it looks.

import { LINES } from "../../client/lines.ts";
import { expect, test } from "./fixtures.ts";
import { addAgent, agentOf, field, idle, messagesOf, mine, notices, openChat, payload, said, sendFromApp, serverPid, theirs, toast, until } from "./chat-helpers.ts";

/** Adds an agent called `name` and opens its chat. */
async function chatWith(page: Parameters<typeof openChat>[0], server: Parameters<typeof openChat>[1], name = "Echo") {
  await addAgent(page, server, name);
  return openChat(page, server, name);
}

/** The time a receipt shows for a message read at `time`, as this window writes a time today. */
const clock = (page: Parameters<typeof openChat>[0], time: number) => page.evaluate((at) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }), time);

test.describe("sending and replies", () => {
  test("Enter sends the message and the agent's reply arrives", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "Hi there");
    await expect(mine(page).filter({ hasText: "Hi there" })).toBeVisible();
    await expect(said(page, "Hi Tester! What can I help with today?")).toBeVisible();
    await expect(field(page)).toHaveValue("");
    const sent = await messagesOf(server, id);
    expect(sent.map(({ sender, body }) => [sender, body])).toEqual([
      ["person", "Hi there"],
      ["agent", "Hi Tester! What can I help with today?"],
    ]);
  });

  // The server must get the line break the person typed, a single newline, as the phone sends it.
  test("Shift+Enter starts a new line instead of sending", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await field(page).pressSequentially("line one");
    await field(page).press("Shift+Enter");
    await field(page).pressSequentially("line two");
    await expect(field(page)).toHaveValue("line one\nline two");
    expect(await messagesOf(server, id)).toEqual([]);
    await field(page).press("Enter");
    const bubble = mine(page).getByTestId("bubble");
    await expect(bubble).toHaveText("line one\nline two", { useInnerText: true });
    await until(() => messagesOf(server, id), (messages) => messages[0]?.body === "line one\nline two");
  });

  test("whitespace alone sends nothing", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await field(page).fill("   \n\t  ");
    await expect(page.getByTestId("send")).toBeDisabled();
    await field(page).press("Enter");
    await page.getByTestId("send").click({ force: true });
    await expect(page.getByTestId("message-sending")).toHaveCount(0);
    await expect(mine(page)).toHaveCount(0);
    expect(await messagesOf(server, id)).toEqual([]);
  });

  test("the message shows at once, and its receipt goes from Delivered to Read with the time it was read", async ({ page, server }) => {
    // A slow agent leaves time to see the message before the agent has read it.
    await server.control("pause", { ms: 6_000 });
    const id = await chatWith(page, server);
    await sendFromApp(page, "Are you there?");
    await expect(page.getByTestId("message-sending").or(mine(page)).filter({ hasText: "Are you there?" })).toBeVisible({ timeout: 1_000 });
    const receipt = mine(page).getByTestId("receipt");
    await expect(receipt).toHaveText("Delivered");
    const seen = await until(() => messagesOf(server, id), (messages) => messages[0]?.seen_at !== null);
    await expect(receipt).toHaveText(`Read ${await clock(page, seen[0].seen_at!)}`);
  });

  test("the receipt shows only under the person's newest message", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "Hi");
    await expect(said(page, "Hi Tester!")).toBeVisible();
    await sendFromApp(page, "Thanks");
    await expect(said(page, "Any time.")).toBeVisible();
    await expect(page.getByTestId("receipt")).toHaveCount(1);
    await expect(mine(page).last().getByTestId("receipt")).toHaveText(/^Read /);
    await expect(mine(page).first().getByTestId("receipt")).toHaveCount(0);
  });

  test("the working line shows while the agent works, changes as it goes, and goes when it replies", async ({ page, server }) => {
    await server.control("pause", { ms: 8_000 });
    await chatWith(page, server);
    await sendFromApp(page, "Is it going to rain tomorrow?");
    const working = page.getByTestId("working-line");
    await expect(working).toBeVisible();
    const first = (await working.innerText()).trim();
    expect(LINES).toContain(first);
    await expect.poll(async () => (await working.innerText()).trim(), { timeout: 6_000 }).not.toBe(first);
    expect(LINES).toContain((await working.innerText()).trim());
    await expect(said(page, "Dry and bright tomorrow")).toBeVisible({ timeout: 15_000 });
    await expect(working).toHaveCount(0);
  });

  test("/update shows each update as it comes, then the reply", async ({ page, server }) => {
    await server.control("pause", { ms: 1_200 });
    const id = await chatWith(page, server);
    await sendFromApp(page, "/update");
    const first = said(page, "Found 23 flights for the weekend. Checking which ones have bags included.");
    const second = said(page, "Down to four. Now comparing the hotels near each airport.");
    const reply = said(page, /^The best pair is the 07:05 out/);
    await expect(first).toBeVisible();
    // The agent is still at work after an update, so the working line stays under it.
    await expect(page.getByTestId("working-line")).toBeVisible();
    await expect(reply).toHaveCount(0);
    await expect(second).toBeVisible();
    await expect(reply).toBeVisible();
    await expect(page.getByTestId("working-line")).toHaveCount(0);
    const words = await theirs(page).allInnerTexts();
    expect(words.map((each) => each.slice(0, 12))).toEqual(["Found 23 fli", "Down to four", "The best pai"]);
    await idle(server, id);
  });

  test("/silent ends the turn with no reply and nothing in its place", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/silent");
    await expect(mine(page).getByTestId("receipt")).toHaveText(/^Read /);
    await idle(server, id);
    await expect(page.getByTestId("working-line")).toHaveCount(0);
    await expect(notices(page)).toHaveCount(0);
    // The server keeps the empty reply, the chat draws no row for it, and the sidebar reads the turn as done.
    expect((await messagesOf(server, id)).map(({ sender, body }) => [sender, body])).toEqual([
      ["person", "/silent"],
      ["agent", ""],
    ]);
    await expect(theirs(page)).toHaveCount(0);
    await expect(page.getByTestId(`agent-${id}`)).toContainText("Done");
    // Nothing is there for the keyboard to land on either: the arrow keys reach the person's message first.
    await page.getByTestId("timeline").focus();
    await page.keyboard.press("ArrowUp");
    await expect(mine(page)).toBeFocused();
  });

  test("a very long message is sent whole and wraps inside its bubble", async ({ page, server }) => {
    const id = await chatWith(page, server);
    const long = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
    await sendFromApp(page, long);
    const bubble = mine(page).getByTestId("bubble");
    await expect(bubble).toBeVisible();
    await until(() => messagesOf(server, id), (messages) => messages[0]?.body === long);
    await expect(bubble).toHaveText(long);
    const [bubbleWidth, column] = await bubble.evaluate((element) => [element.getBoundingClientRect().width, element.closest("[data-message-row]")!.getBoundingClientRect().width]);
    expect(bubbleWidth).toBeLessThanOrEqual(column * 0.85 + 1);
    expect(await page.getByTestId("timeline").evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  });

  test("emoji and right-to-left text are sent and shown as typed", async ({ page, server }) => {
    const id = await chatWith(page, server);
    const words = "👋🏽 שלום עולם, مرحبا بالعالم 👨‍👩‍👧‍👦 🇬🇧";
    await sendFromApp(page, words);
    await expect(mine(page).getByTestId("bubble")).toHaveText(words);
    await until(() => messagesOf(server, id), (messages) => messages[0]?.body === words);
  });

  test("a long unbroken string wraps instead of widening the chat", async ({ page, server, setWindowSize }) => {
    await setWindowSize(760, 520);
    await chatWith(page, server);
    const unbroken = `https://example.com/${"a1b2c3d4".repeat(60)}`;
    await sendFromApp(page, unbroken);
    const bubble = mine(page).getByTestId("bubble");
    await expect(bubble).toHaveText(unbroken);
    const [right, columnRight] = await bubble.evaluate((element) => [element.getBoundingClientRect().right, element.closest("[data-message-row]")!.getBoundingClientRect().right]);
    expect(right).toBeLessThanOrEqual(columnRight + 1);
    expect(await page.getByTestId("timeline").evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  });

  test("markdown typed by the person is shown as plain text, as they typed it", async ({ page, server }) => {
    await chatWith(page, server);
    const typed = "# Not a heading\n**not bold** _not italic_ `not code`\n- not a list\n[not a link](https://example.com)";
    await sendFromApp(page, typed);
    const bubble = mine(page).getByTestId("bubble");
    await expect(bubble).toHaveText(typed, { useInnerText: true });
    await expect(bubble.locator("h1, strong, em, code, li, a")).toHaveCount(0);
  });

  test("two messages sent quickly keep their order", async ({ page, server }) => {
    await server.control("pause", { ms: 2_000 });
    const id = await chatWith(page, server);
    await field(page).fill("first");
    await field(page).press("Enter");
    await field(page).fill("second");
    await field(page).press("Enter");
    const sent = await until(() => messagesOf(server, id), (messages) => messages.filter((message) => message.sender === "person").length === 2);
    expect(sent.filter((message) => message.sender === "person").map((message) => message.body)).toEqual(["first", "second"]);
    await expect(mine(page)).toHaveCount(2);
    expect(await mine(page).getByTestId("bubble").allInnerTexts()).toEqual(["first", "second"]);
  });

  test("a message that can't be sent comes back with its files and its reply, and says Not sent", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "Hi");
    const answer = said(page, "Hi Tester! What can I help with today?");
    await expect(answer).toBeVisible();
    await answer.hover();
    await page.getByTestId("reply-button").click();
    await field(page).fill("Did you get my note?");
    await page.getByTestId("file-input").setInputFiles([payload("note.txt", Buffer.from("Buy milk\n"), "text/plain")]);
    await expect(page.getByTestId("tray-item")).toHaveCount(1);

    // The server stops answering while the message is on its way, and then ends, as a crash does.
    const pid = serverPid(server.port);
    process.kill(pid, "SIGSTOP");
    try {
      await field(page).press("Enter");
      await expect(page.getByTestId("message-sending")).toBeVisible();
    } finally {
      process.kill(pid, "SIGKILL");
    }
    await expect(toast(page, "Not sent")).toBeVisible();
    await expect(toast(page, "Not sent")).toContainText("Sidebots isn't running on this computer.");
    await expect(page.getByTestId("message-sending")).toHaveCount(0);
    await expect(field(page)).toHaveValue("Did you get my note?");
    await expect(page.getByTestId("tray-item")).toHaveCount(1);
    await expect(page.getByTestId("replying")).toContainText("Replying to Echo");

    // Once the server is back, the same message goes as it was put together.
    await server.restart();
    await expect(page.getByTestId("send")).toBeEnabled({ timeout: 30_000 });
    await field(page).press("Enter");
    const sent = await until(() => messagesOf(server, id), (messages) => messages.some((message) => message.body === "Did you get my note?"));
    const again = sent.find((message) => message.body === "Did you get my note?")!;
    expect(again.reply_to).toBe(sent.find((message) => message.sender === "agent")!.id);
    expect(again.attachments).toHaveLength(1);
  });

  test("a message that fails after the person left its chat and came back is in the field again, ahead of what they typed since, and typing adds to it", async ({ page, server }) => {
    const bravo = await addAgent(page, server, "Bravo");
    const echo = await chatWith(page, server);
    await field(page).fill("Did you get my note?");
    await page.getByTestId("file-input").setInputFiles([payload("note.txt", Buffer.from("Buy milk\n"), "text/plain")]);
    await expect(page.getByTestId("tray-item")).toHaveCount(1);

    // The server stops answering while the message is on its way. The person looks at another chat, comes back, and starts another message.
    const pid = serverPid(server.port);
    process.kill(pid, "SIGSTOP");
    try {
      await field(page).press("Enter");
      await expect(page.getByTestId("message-sending")).toBeVisible();
      await page.getByTestId(`agent-${bravo}`).click();
      await expect(page.getByTestId("chat-name")).toHaveText("Bravo");
      await page.getByTestId(`agent-${echo}`).click();
      await expect(page.getByTestId("chat-name")).toHaveText("Echo");
      await expect(field(page)).toHaveValue("");
      await field(page).fill("And another thing.");
    } finally {
      process.kill(pid, "SIGKILL");
    }
    await expect(toast(page, "Not sent")).toBeVisible();
    await expect(field(page)).toHaveValue("Did you get my note?\nAnd another thing.");
    await expect(page.getByTestId("tray-item")).toHaveCount(1);
    await expect(page.getByTestId("tray-item")).toContainText("note.txt");

    // What they type next joins what came back, here and after another look at the other chat.
    await field(page).press("End");
    await field(page).pressSequentially(" Thanks.");
    await expect(field(page)).toHaveValue("Did you get my note?\nAnd another thing. Thanks.");
    await page.getByTestId(`agent-${bravo}`).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Bravo");
    await page.getByTestId(`agent-${echo}`).click();
    await expect(field(page)).toHaveValue("Did you get my note?\nAnd another thing. Thanks.");
    await expect(page.getByTestId("tray-item")).toHaveCount(1);
  });

  test("a message sent from another device shows in the open chat", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "Hi");
    await expect(said(page, "Hi Tester!")).toBeVisible();
    await server.say(id, "Sent from my phone");
    await expect(mine(page).filter({ hasText: "Sent from my phone" })).toBeVisible();
    await expect(page.getByTestId("receipt")).toHaveCount(1);
    await expect(mine(page).last().getByTestId("receipt")).toBeVisible();
  });

  test("a message sent from another device shows in an open chat that was empty", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await expect(page.getByTestId("new-agent-hint")).toHaveText("Echo is new. Tell it what it's for.");
    await server.say(id, "Sent from my phone");
    await expect(mine(page).filter({ hasText: "Sent from my phone" })).toBeVisible();
    // The agent's answer follows it into the chat.
    await expect(theirs(page)).toHaveCount(1);
    await expect(page.getByTestId("new-agent-hint")).toHaveCount(0);
  });

  test("a draft, its files and the reply being written stay with each chat when switching chats and back", async ({ page, server }) => {
    await addAgent(page, server, "Bravo");
    await chatWith(page, server, "Echo");
    await sendFromApp(page, "Hi");
    const answer = said(page, "Hi Tester!");
    await expect(answer).toBeVisible();
    await answer.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reply" }).click();
    await field(page).fill("draft for Echo");
    await page.getByTestId("file-input").setInputFiles([payload("list.txt", Buffer.from("eggs\n"), "text/plain")]);

    await openChat(page, server, "Bravo");
    await expect(field(page)).toHaveValue("");
    await expect(page.getByTestId("tray-item")).toHaveCount(0);
    await expect(page.getByTestId("replying")).toHaveCount(0);
    await field(page).fill("draft for Bravo");

    await openChat(page, server, "Echo");
    await expect(field(page)).toHaveValue("draft for Echo");
    await expect(page.getByTestId("tray-item")).toHaveCount(1);
    await expect(page.getByTestId("tray-item")).toContainText("list.txt");
    await expect(page.getByTestId("replying")).toContainText("Hi Tester!");

    await openChat(page, server, "Bravo");
    await expect(field(page)).toHaveValue("draft for Bravo");
  });
});

test.describe("keyboard and focus", () => {
  test("the message field has focus when a chat opens, and again after switching chats", async ({ page, server }) => {
    await addAgent(page, server, "Bravo");
    await chatWith(page, server, "Echo");
    await expect(field(page)).toBeFocused();
    await openChat(page, server, "Bravo");
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveAttribute("placeholder", "Message Bravo");
  });

  test("the message field keeps focus after sending", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "Hi");
    await expect(mine(page)).toHaveCount(1);
    await expect(field(page)).toBeFocused();
    await page.getByTestId("send").focus();
    await field(page).fill("Thanks");
    await page.getByTestId("send").click();
    await expect(mine(page)).toHaveCount(2);
    await expect(field(page)).toBeFocused();
  });

  test("typing with nothing focused goes to the message field", async ({ page, server }) => {
    await chatWith(page, server);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(field(page)).not.toBeFocused();
    await page.keyboard.type("hello");
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue("hello");
  });

  test("Reply from the hover button quotes the message, and the sent reply carries it", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "Hi");
    const answer = said(page, "Hi Tester! What can I help with today?");
    await expect(answer).toBeVisible();
    await answer.hover();
    await page.getByTestId("reply-button").click();
    const replying = page.getByTestId("replying");
    await expect(replying).toContainText("Replying to Echo");
    await expect(replying).toContainText("Hi Tester! What can I help with today?");
    await expect(field(page)).toBeFocused();
    await sendFromApp(page, "Booking a table");
    await expect(replying).toHaveCount(0);
    const reply = mine(page).filter({ hasText: "Booking a table" });
    await expect(reply.getByTestId("quote")).toHaveText("Hi Tester! What can I help with today?");
    const sent = await until(() => messagesOf(server, id), (messages) => messages.some((message) => message.body === "Booking a table"));
    expect(sent.find((message) => message.body === "Booking a table")!.reply_to).toBe(sent[1].id);
  });

  test("Reply from the context menu, on the person's own message, says Replying to yourself", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "Remind me about the dentist");
    await expect(said(page, "Okay, I'll remind you.")).toBeVisible();
    await mine(page).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reply" }).click();
    await expect(page.getByTestId("replying")).toContainText("Replying to yourself");
    await expect(page.getByTestId("replying")).toContainText("Remind me about the dentist");
    await expect(field(page)).toBeFocused();
  });

  test("Reply from the keyboard: the arrow keys reach a message and Shift+F10 opens its menu", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "Hi");
    await expect(said(page, "Hi Tester!")).toBeVisible();
    await page.getByTestId("timeline").focus();
    await page.keyboard.press("ArrowUp");
    await expect(theirs(page)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(mine(page)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(theirs(page)).toBeFocused();
    await page.keyboard.press("Shift+F10");
    const reply = page.getByRole("menuitem", { name: "Reply" });
    await expect(reply).toBeVisible();
    // The arrow keys move through the menu to Reply, and Enter chooses it.
    await expect(async () => {
      if ((await reply.getAttribute("data-highlighted")) === null) await page.keyboard.press("ArrowDown");
      await expect(reply).toHaveAttribute("data-highlighted", "", { timeout: 300 });
    }).toPass({ timeout: 5_000 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("replying")).toContainText("Hi Tester!");
    await expect(field(page)).toBeFocused();
  });

  test("Esc lets go of the message being replied to", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "Hi");
    const answer = said(page, "Hi Tester!");
    await expect(answer).toBeVisible();
    await answer.hover();
    await page.getByTestId("reply-button").click();
    await field(page).fill("still typing");
    await expect(page.getByTestId("replying")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("replying")).toHaveCount(0);
    await expect(field(page)).toHaveValue("still typing");
    await expect(field(page)).toBeFocused();
  });

  test("Tab moves through the composer in order: Cancel reply, the files, +, the field, Send", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "Hi");
    const answer = said(page, "Hi Tester!");
    await expect(answer).toBeVisible();
    await answer.hover();
    await page.getByTestId("reply-button").click();
    await page.getByTestId("file-input").setInputFiles([payload("a.txt", Buffer.from("a"), "text/plain")]);
    await field(page).fill("with a file");
    await page.getByTestId("cancel-reply").focus();
    const order: (string | null)[] = [];
    for (let step = 0; step < 4; step++) {
      await page.keyboard.press("Tab");
      order.push(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.getAttribute("aria-label") ?? null));
    }
    expect(order).toEqual(["remove-file", "add-files", "message-field", "send"]);
    await page.keyboard.press("Shift+Tab");
    await expect(field(page)).toBeFocused();
  });
});

test.describe("Stop, fresh start and the chat's menu", () => {
  test("Stop ends the agent's turn, and the chat says Stopped", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/slow 30");
    await expect(page.getByTestId("working-line")).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop" });
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect(notices(page).filter({ hasText: /^Stopped$/ })).toBeVisible();
    await expect(page.getByTestId("working-line")).toHaveCount(0);
    await expect(page.getByTestId("send")).toBeDisabled();
    await idle(server, id);
    expect((await messagesOf(server, id)).some((message) => /^Done\. That took/.test(message.body))).toBe(false);
  });

  test("the send button is Stop only while the agent works, Sidebots is in reach, and there is nothing to send", async ({ page, server }) => {
    await chatWith(page, server);
    // Idle, with nothing to send: a Send that can't be pressed.
    await expect(page.getByTestId("send")).toBeDisabled();
    await expect(page.getByTestId("stop")).toHaveCount(0);

    await sendFromApp(page, "/slow 30");
    await expect(page.getByTestId("working-line")).toBeVisible();
    await expect(page.getByTestId("stop")).toHaveAccessibleName("Stop");

    // Something to send makes it Send again, and taking it away makes it Stop.
    await field(page).fill("one more thing");
    await expect(page.getByTestId("send")).toHaveAccessibleName("Send message");
    await expect(page.getByTestId("send")).toBeEnabled();
    await field(page).fill("");
    await expect(page.getByTestId("stop")).toBeVisible();

    // Out of reach, nothing can be sent or stopped.
    await server.control("outage", { ms: 60_000 });
    await expect(page.getByTestId("offline-line")).toHaveText("Can't reach Sidebots on this computer.");
    await expect(page.getByTestId("stop")).toHaveCount(0);
    await expect(page.getByTestId("send")).toBeDisabled();
    await server.control("outage", { ms: 0 });
    await expect(page.getByTestId("offline-line")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("stop")).toBeVisible();
    await page.getByTestId("stop").click();
    await expect(notices(page).filter({ hasText: /^Stopped$/ })).toBeVisible();
  });

  test("while the agent waits on another agent's answer, the send button is Stop", async ({ page, server }) => {
    const bravo = await addAgent(page, server, "Bravo");
    const echo = await chatWith(page, server, "Echo");
    // Bravo is busy, so what Echo asks it waits.
    await server.control("hold", { agent: bravo, message: "Sort the receipts" });
    await sendFromApp(page, "/agent Bravo what's left in the budget?");
    await expect(said(page, "I've asked Bravo. I'll tell you what they say.")).toBeVisible();
    await until(() => agentOf(server, echo), (agent) => agent.waiting_on === bravo && !agent.working);
    await expect(page.getByTestId("working-line")).toHaveCount(0);
    await expect(page.getByTestId("stop")).toHaveAccessibleName("Stop");
    await server.control("release", { agent: bravo });
    await expect(said(page, /^Heard back from Bravo:/)).toBeVisible({ timeout: 20_000 });
    await idle(server, echo);
    await expect(page.getByTestId("send")).toBeDisabled();
  });

  test("Fresh start from the chat's menu shows its notice", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "Hi");
    await expect(said(page, "Hi Tester!")).toBeVisible();
    await page.getByTestId("chat-menu").click();
    await expect(page.getByRole("menuitem", { name: /^Fresh start/ })).toContainText("Clears what the agent has in mind. Your chat and its memory stay.");
    await page.getByRole("menuitem", { name: /^Fresh start/ }).click();
    await expect(notices(page).filter({ hasText: /^Fresh start$/ })).toBeVisible();
    await until(() => messagesOf(server, id), (messages) => messages.some((message) => message.sender === "sidebots" && message.body === "Fresh start"));
  });

  test("Mute and Unmute from the chat's menu", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await page.getByTestId("chat-menu").click();
    await page.getByRole("menuitem", { name: "Mute" }).click();
    await expect(page.getByTestId("chat-agent").getByRole("img", { name: "Muted" })).toBeVisible();
    await until(() => agentOf(server, id), (agent) => agent.muted);
    await page.getByTestId("chat-menu").click();
    await page.getByRole("menuitem", { name: "Unmute" }).click();
    await expect(page.getByTestId("chat-agent").getByRole("img", { name: "Muted" })).toHaveCount(0);
    await until(() => agentOf(server, id), (agent) => !agent.muted);
  });

  test("Hide from the chat's menu hides the agent, and the menu then offers Unhide", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await page.getByTestId("chat-menu").click();
    await page.getByRole("menuitem", { name: "Hide" }).click();
    await until(() => agentOf(server, id), (agent) => agent.hidden);
    await page.getByTestId("chat-menu").click();
    await expect(page.getByRole("menuitem", { name: "Unhide" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("deleting the open chat's agent asks first, and Delete closes the chat", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await page.getByTestId("chat-menu").click();
    await page.getByRole("menuitem", { name: "Delete agent…" }).click();
    const confirm = page.getByTestId("confirm");
    await expect(confirm).toContainText("Delete Echo?");
    await expect(confirm).toContainText("Its chat, its memory, its jobs and its files are removed for good.");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("chat-name")).toHaveText("Echo");
    expect((await agentOf(server, id))?.id).toBe(id);

    await page.getByTestId("chat-menu").click();
    await page.getByRole("menuitem", { name: "Delete agent…" }).click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("chat")).toHaveCount(0);
    await expect(page.getByTestId("no-chat")).toBeVisible();
    await expect(page.getByTestId(`agent-${id}`)).toHaveCount(0);
    await until(() => agentOf(server, id), (agent) => agent === undefined);
  });
});
