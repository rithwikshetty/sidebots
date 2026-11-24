// An agent asking the person before it acts: the card for each kind of ask,
// Allow and Don't allow and what follows, asks answered elsewhere or left,
// asks for a connection, an ask another agent raises in an exchange, and how
// asks that ended long ago read in Atlas's history.

import type { Page } from "@playwright/test";
import type { Message } from "../../server/src/contract.ts";
import { expect, test, type TestServer } from "./fixtures.ts";
import { addAgent, agentId, field, idle, json, messagesOf, notices, openChat, said, scrollChatTo, sendFromApp, theirs, toast, until, wholeChat } from "./chat-helpers.ts";

/** Waits for the agent's ask to wait for the person, and resolves to it as the server has it. */
const waitingAsk = (server: TestServer, agentId: string) =>
  until(
    () => messagesOf(server, agentId),
    (messages) => messages.some((message) => message.ask === "waiting"),
  ).then((messages) => messages.findLast((message) => message.ask === "waiting")!);

/** The bubble of the agent's message that holds an ask, by the ask's id. */
const askRow = (page: Page, ask: Message) => page.locator(`[data-message-id="${ask.id}"]`);

// What each kind of ask keeps behind its button, as the phone words it.
const DETAIL = { command: "the command", page: "the address", file: "the file", tool: "everything it was given" } as const;
// What the agent says once it was let do each thing.
const DONE = { command: "cleared out 14 invoices older than a year", file: "saved the notes to Documents/Taxes", page: "checked the council's page: bins go out on the 27th instead of the 25th", tool: "emailed Hughes & Son about the tap" } as const;

/** Adds an agent and opens its chat. */
async function chatWith(page: Page, server: TestServer, name = "Echo", provider: "claude" | "codex" = "claude") {
  await addAgent(page, server, name, provider);
  return openChat(page, server, name);
}

test.describe("asks, one kind at a time", () => {
  for (const [kind, provider] of [
    ["command", "claude"],
    ["command", "codex"],
    ["file", "claude"],
    ["file", "codex"],
    ["page", "claude"],
    ["tool", "claude"],
  ] as const) {
    test(`a ${kind} ask from ${provider === "claude" ? "Claude Code" : "Codex"} shows what it asks, and its detail opens and closes`, async ({ page, server }) => {
      const id = await chatWith(page, server, "Echo", provider);
      await sendFromApp(page, `/ask ${kind}`);
      const ask = await waitingAsk(server, id);
      const question = ask.question!;
      const card = askRow(page, ask).getByTestId("ask-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText(question.title);
      await expect(card.locator("p").first()).toHaveText(question.what);
      const facts = card.locator("p").filter({ has: page.locator("span.text-ink2") });
      await expect(facts).toHaveText(question.facts.map(([label, value]) => `${label}${value}`));
      if (question.why) await expect(card).toContainText(question.why);
      const detail = card.getByTestId("ask-detail");
      await expect(detail).toHaveText(`Show ${DETAIL[kind]}`);
      await expect(detail).toHaveAttribute("aria-expanded", "false");
      await expect(card.getByTestId("code-block")).toHaveCount(0);
      await detail.click();
      await expect(detail).toHaveText(`Hide ${DETAIL[kind]}`);
      await expect(detail).toHaveAttribute("aria-expanded", "true");
      await expect(card.getByTestId("code-block").locator("pre")).toHaveText(question.detail.replace(/\n$/, ""), { useInnerText: true });
      await detail.click();
      await expect(card.getByTestId("code-block")).toHaveCount(0);
      const answers = askRow(page, ask).getByTestId("ask-answers");
      await expect(answers.getByRole("button")).toHaveText(["Don't allow", "Allow"]);
    });
  }

  for (const kind of ["command", "file", "page", "tool"] as const) {
    test(`Allow on a ${kind} ask says Allowed, and the agent goes on`, async ({ page, server }) => {
      const id = await chatWith(page, server);
      await sendFromApp(page, `/ask ${kind}`);
      const ask = await waitingAsk(server, id);
      await askRow(page, ask).getByRole("button", { name: "Allow", exact: true }).click();
      await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText("Allowed");
      await expect(askRow(page, ask).getByTestId("ask-answers")).toHaveCount(0);
      await expect(said(page, `You said yes, so I ${DONE[kind]}.`)).toBeVisible();
      expect((await messagesOf(server, id)).find((message) => message.id === ask.id)!.ask).toBe("allowed");
    });

    test(`Don't allow on a ${kind} ask says Not allowed, and the agent leaves it`, async ({ page, server }) => {
      const id = await chatWith(page, server);
      await sendFromApp(page, `/ask ${kind}`);
      const ask = await waitingAsk(server, id);
      await askRow(page, ask).getByRole("button", { name: "Don't allow" }).click();
      await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText("Not allowed");
      await expect(said(page, "You said no, so I left it alone.")).toBeVisible();
      expect((await messagesOf(server, id)).find((message) => message.id === ask.id)!.ask).toBe("refused");
    });
  }
});

test.describe("asks as they happen", () => {
  test("/ask twice: the second ask comes once the first is answered", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/ask twice");
    const first = await waitingAsk(server, id);
    await expect(page.getByTestId("ask-card")).toHaveCount(1);
    await askRow(page, first).getByRole("button", { name: "Allow", exact: true }).click();
    await expect(askRow(page, first).getByTestId("ask-outcome")).toHaveText("Allowed");
    const second = await until(() => waitingAsk(server, id), (ask) => ask.id !== first.id);
    await expect(askRow(page, second).getByTestId("ask-card")).toContainText(second.question!.what);
    await askRow(page, second).getByRole("button", { name: "Don't allow" }).click();
    await expect(askRow(page, second).getByTestId("ask-outcome")).toHaveText("Not allowed");
    await expect(said(page, "You said yes, so I cleared out 14 invoices older than a year. Then: you said no, so I left it alone.")).toBeVisible();
  });

  test("an ask answered on another device closes here", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/ask tool");
    const ask = await waitingAsk(server, id);
    await expect(askRow(page, ask).getByTestId("ask-answers")).toBeVisible();
    expect((await server.api(`/agents/${id}/asks/${ask.id}`, { method: "POST", body: JSON.stringify({ allow: true }) })).ok).toBe(true);
    await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText("Allowed");
    await expect(askRow(page, ask).getByTestId("ask-answers")).toHaveCount(0);
    await expect(said(page, "You said yes, so I emailed Hughes & Son about the tap.")).toBeVisible();
  });

  test("while an ask waits, the working line steps aside and the send button is Stop", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/ask command");
    const ask = await waitingAsk(server, id);
    await expect(askRow(page, ask).getByTestId("ask-answers")).toBeVisible();
    await expect(page.getByTestId("working-line")).toHaveCount(0);
    await expect(page.getByTestId("stop")).toHaveAccessibleName("Stop");
    await expect(field(page)).toBeEnabled();
  });

  test("Stop while an ask waits closes it as Not answered", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/ask command");
    const ask = await waitingAsk(server, id);
    await expect(askRow(page, ask).getByTestId("ask-answers")).toBeVisible();
    await page.getByTestId("stop").click();
    await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText("Not answered");
    await expect(askRow(page, ask).getByTestId("ask-answers")).toHaveCount(0);
    await idle(server, id);
    expect((await messagesOf(server, id)).find((message) => message.id === ask.id)!.ask).toBe("unanswered");
    await expect(page.getByTestId("send")).toBeDisabled();
  });

  test("a message sent while an ask waits closes the ask as Not answered, and the agent reads the message", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/ask command");
    const ask = await waitingAsk(server, id);
    await expect(askRow(page, ask).getByTestId("ask-answers")).toBeVisible();
    await sendFromApp(page, "Actually, leave the invoices for now");
    await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText("Not answered");
    await expect(said(page, "You sent another message, so I left that and read yours.")).toBeVisible();
    await idle(server, id);
  });

  test("answering an ask the agent no longer waits for says Couldn't answer", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/ask file");
    const ask = await waitingAsk(server, id);
    await expect(askRow(page, ask).getByTestId("ask-answers")).toBeVisible();
    // The window stops hearing from the server, and meanwhile the ask is answered on another device.
    await server.control("drop-events", { ms: 60_000 });
    await expect(page.getByTestId("offline-line")).toBeVisible();
    expect((await server.api(`/agents/${id}/asks/${ask.id}`, { method: "POST", body: JSON.stringify({ allow: false }) })).ok).toBe(true);
    await expect(askRow(page, ask).getByTestId("ask-answers")).toBeVisible();
    await askRow(page, ask).getByRole("button", { name: "Allow", exact: true }).click();
    await expect(toast(page, "Couldn't answer")).toBeVisible();
    await expect(toast(page, "Couldn't answer")).toContainText("The agent is no longer waiting for an answer to that.");
    await expect(askRow(page, ask).getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
  });
});

test.describe("asks for a connection", () => {
  test("/connect gmail: Connect takes the person through the sign-in, and the ask says Connected", async ({ page, server, mainCalls, finishSignIn }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/connect gmail");
    const ask = await waitingAsk(server, id);
    const card = askRow(page, ask).getByTestId("ask-card");
    await expect(card).toContainText("Connect Gmail");
    await expect(card.locator("p").first()).toHaveText(ask.question!.what);
    await expect(card.getByTestId("ask-detail")).toHaveCount(0);
    await expect(askRow(page, ask).getByTestId("ask-answers").getByRole("button")).toHaveText(["Not now", "Connect"]);
    await askRow(page, ask).getByRole("button", { name: "Connect" }).click();
    await expect.poll(async () => (await mainCalls()).opened.some((url) => url.startsWith("https://accounts.google.com/"))).toBe(true);
    await finishSignIn();
    await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText("Connected");
    await expect(said(page, "Gmail is connected. Ask me again and I'll take a look.")).toBeVisible();
    const connections = await json<{ connection: string; account: string | null }[]>(server, "/connections");
    expect(connections.find((each) => each.connection === "gmail")!.account).toBe("tester@example.com");
  });

  test("/connect gmail: Not now leaves it unconnected", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/connect gmail");
    const ask = await waitingAsk(server, id);
    await askRow(page, ask).getByRole("button", { name: "Not now" }).click();
    await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText("Not connected");
    await expect(said(page, "Okay, I won't connect Gmail for now.")).toBeVisible();
    const connections = await json<{ connection: string; account: string | null }[]>(server, "/connections");
    expect(connections.find((each) => each.connection === "gmail")!.account).toBeNull();
  });
});

test.describe("an ask in an exchange between agents", () => {
  test("an ask another agent raises while working for this one shows who asks, and answering it lets the exchange finish", async ({ page, server }) => {
    const bravo = await addAgent(page, server, "Bravo");
    const echo = await chatWith(page, server, "Echo");
    await sendFromApp(page, "/agent-ask Bravo");
    await expect(said(page, "I've asked Bravo. I'll tell you what they say.")).toBeVisible();
    const ask = await waitingAsk(server, bravo);
    expect(ask.peer_id).toBe(echo);
    const row = askRow(page, ask);
    await expect(row.getByTestId("ask-card")).toContainText("Bravo asks");
    await expect(page.getByRole("button", { name: "Echo asked Bravo. Needs your OK" })).toBeVisible();
    await row.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(row.getByTestId("ask-outcome")).toHaveText("Allowed");
    await expect(said(page, "Heard back from Bravo: Done: I cleared out 14 invoices older than a year.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Echo asked Bravo. Answered" })).toBeVisible();
    // In Bravo's own chat the same ask is Bravo's, so it names nobody.
    await openChat(page, server, "Bravo");
    await expect(askRow(page, ask).getByTestId("ask-card")).not.toContainText("Bravo asks");
    await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText("Allowed");
  });
});

test.describe("asks in history", () => {
  test.use({ world: "seeded" });

  test("asks that ended long ago say how they ended", async ({ page, server }) => {
    const id = await agentId(server, "Atlas");
    const all = await wholeChat(server, id);
    await openChat(page, server, "Atlas");
    const asks = all.filter((message) => message.question);
    const expected = asks.map((message) => (message.question!.connection ? { allowed: "Connected", refused: "Not connected", unanswered: "Not connected" } : { allowed: "Allowed", refused: "Not allowed", unanswered: "Not answered" })[message.ask as "allowed"]);
    expect(expected).toEqual(["Allowed", "Not allowed", "Not answered", "Connected"]);
    // Newest first, as scrolling back through the chat comes to them.
    for (const [at, ask] of [...asks.entries()].reverse()) {
      await scrollChatTo(page, askRow(page, ask));
      await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText(expected[at]);
      await expect(askRow(page, ask).getByTestId("ask-answers")).toHaveCount(0);
    }
  });

  test("Tidy's ask waits in its chat with Allow and Don't allow", async ({ page, server }) => {
    const id = await openChat(page, server, "Tidy");
    const ask = await waitingAsk(server, id);
    await expect(askRow(page, ask).getByTestId("ask-card")).toContainText(ask.question!.what);
    await askRow(page, ask).getByRole("button", { name: "Allow", exact: true }).click();
    await expect(askRow(page, ask).getByTestId("ask-outcome")).toHaveText("Allowed");
    await expect(said(page, "You said yes, so I cleared out 14 invoices older than a year.")).toBeVisible();
    await expect(theirs(page).last()).toBeInViewport();
    await expect(notices(page)).toHaveCount(0);
  });
});
