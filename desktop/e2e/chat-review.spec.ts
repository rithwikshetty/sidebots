// Screenshots of the chat for a person to look over: each kind of message,
// each state of an ask, each kind of attachment and the composer's states,
// in light and dark. They are not a test of anything, so they run only when
// asked for:
//
//   CHAT_REVIEW=<folder> pnpm e2e e2e/chat-review.spec.ts --workers 2
//
// The pictures go to that folder.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, type TestServer } from "./fixtures.ts";
import { agentId, field, messagesOf, mine, openChat, payload, png, said, scrollChatTo, sendFromApp, until } from "./chat-helpers.ts";

test.skip(!process.env.CHAT_REVIEW, "CHAT_REVIEW names the folder the pictures go to.");
const REVIEW = process.env.CHAT_REVIEW!;
test.use({ world: "seeded" });

/** Scrolls the open chat back with the wheel until `words` are in the middle of the screen. */
async function scrollTo(page: Page, words: string) {
  const target = page.locator("[data-message-id]").filter({ hasText: words }).first();
  await scrollChatTo(page, target);
  await target.evaluate((row) => row.scrollIntoView({ block: "center" }));
}

const waitingAsk = (server: TestServer, id: string) =>
  until(
    () => messagesOf(server, id),
    (messages) => messages.some((message) => message.ask === "waiting"),
  ).then((messages) => messages.findLast((message) => message.ask === "waiting")!);

for (const scheme of ["light", "dark"] as const) {
  test(`the chat in ${scheme}`, async ({ page, server, setColorScheme, setWindowSize, finishSignIn }) => {
    test.setTimeout(240_000);
    mkdirSync(REVIEW, { recursive: true });
    await setColorScheme(scheme);
    const shot = async (name: string) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(REVIEW, `${name}-${scheme}.png`) });
    };

    // Messages in history, newest first, as scrolling back through the chat comes to them.
    await openChat(page, server, "Atlas");
    await shot("message-text");
    await scrollTo(page, "Here are six. Albert St");
    await shot("attachment-tall-page-history");
    await scrollTo(page, "Fresh start");
    await shot("message-notices-and-asks");
    await scrollTo(page, "Actually, what was FlowFix's price again?");
    await shot("message-reply-and-exchange");
    await scrollTo(page, "Here are three from the trip");
    await shot("attachment-pictures-history");
    await scrollTo(page, "Sidebots couldn't finish this. Your Claude usage limit");
    await shot("message-failed");
    await openChat(page, server, "Ledger");
    await shot("message-table");
    await openChat(page, server, "Patch");
    await shot("message-send-again");

    // Markdown, the working line and the receipt, live in Pip's chat.
    const pip = await openChat(page, server, "Pip");
    await shot("chat-empty");
    await server.control("pause", { ms: 6_000 });
    await sendFromApp(page, "Is it going to rain tomorrow?");
    await expect(mine(page).getByTestId("receipt")).toHaveText("Delivered");
    await shot("message-delivered");
    await expect(page.getByTestId("working-line")).toBeVisible();
    await shot("message-working");
    await server.control("pause", { ms: 150 });
    await expect(said(page, "Dry and bright")).toBeVisible({ timeout: 15_000 });
    await sendFromApp(page, "/long");
    await expect(said(page, "Moving the budget")).toBeVisible();
    await said(page, "Moving the budget").evaluate((row) => row.scrollIntoView({ block: "start" }));
    await shot("message-markdown-top");
    await said(page, "Moving the budget").getByTestId("code-block").first().evaluate((block) => block.scrollIntoView({ block: "start" }));
    await shot("message-markdown-code");

    // Asks, in each state.
    await sendFromApp(page, "/ask command");
    let ask = await waitingAsk(server, pip);
    await expect(page.locator(`[data-message-id="${ask.id}"]`).getByTestId("ask-answers")).toBeVisible();
    await shot("ask-waiting");
    await page.locator(`[data-message-id="${ask.id}"]`).getByTestId("ask-detail").click();
    await shot("ask-detail-open");
    await page.locator(`[data-message-id="${ask.id}"]`).getByRole("button", { name: "Allow", exact: true }).click();
    await expect(said(page, "You said yes")).toBeVisible();
    await shot("ask-allowed");
    await sendFromApp(page, "/ask tool");
    ask = await waitingAsk(server, pip);
    await expect(page.locator(`[data-message-id="${ask.id}"]`).getByTestId("ask-answers")).toBeVisible();
    await shot("ask-tool-waiting");
    await page.locator(`[data-message-id="${ask.id}"]`).getByRole("button", { name: "Don't allow" }).click();
    await expect(said(page, "You said no")).toBeVisible();
    await shot("ask-refused");
    await sendFromApp(page, "/ask page");
    ask = await waitingAsk(server, pip);
    await page.getByTestId("stop").click();
    await expect(page.locator(`[data-message-id="${ask.id}"]`).getByTestId("ask-outcome")).toHaveText("Not answered");
    await shot("ask-unanswered");
    await sendFromApp(page, "/connect calendar");
    ask = await waitingAsk(server, pip);
    await expect(page.locator(`[data-message-id="${ask.id}"]`).getByTestId("ask-answers")).toBeVisible();
    await shot("ask-connection-waiting");
    await page.locator(`[data-message-id="${ask.id}"]`).getByRole("button", { name: "Connect" }).click();
    await expect.poll(async () => {
      try {
        await finishSignIn();
        return true;
      } catch {
        return false;
      }
    }).toBe(true);
    await expect(page.locator(`[data-message-id="${ask.id}"]`).getByTestId("ask-outcome")).toHaveText("Connected");
    await shot("ask-connected");
    const ledger = await agentId(server, "Ledger");
    await sendFromApp(page, "/agent-ask Ledger");
    ask = await waitingAsk(server, ledger);
    await expect(page.locator(`[data-message-id="${ask.id}"]`).getByTestId("ask-card")).toContainText("Ledger asks");
    await shot("ask-from-another-agent");
    await page.locator(`[data-message-id="${ask.id}"]`).getByRole("button", { name: "Allow", exact: true }).click();
    await expect(said(page, /^Heard back from Ledger/)).toBeVisible({ timeout: 20_000 });
    await shot("exchange-answered");

    // Attachments from the agent.
    for (const [command, words, name] of [
      ["/image", "Here's the view", "attachment-picture"],
      ["/images 5", "Here are 5 pictures", "attachment-pictures"],
      ["/page", "Here's a plan for the Lisbon weekend", "attachment-page"],
      ["/page tall", "Here are six flats", "attachment-page-tall"],
      ["/files", "Here's the plumber's invoice", "attachment-files"],
      ["/mixed", "Groceries are up", "attachment-mixed"],
    ] as const) {
      await sendFromApp(page, command);
      const row = said(page, words).last();
      await expect(row).toBeVisible();
      await page.waitForTimeout(800);
      await row.evaluate((element) => element.scrollIntoView({ block: "end" }));
      await shot(name);
    }

    // The person's own files, and the composer's states.
    await page.getByTestId("file-input").setInputFiles([payload("tap.png", png(160, 120, (x, y) => [x, y * 2, 150]), "image/png"), payload("Quote from Hughes.pdf", Buffer.alloc(40_000, 1), "application/pdf")]);
    await shot("composer-tray");
    await sendFromApp(page, "Here's the tap and the quote");
    await expect(said(page, /./).last()).toBeVisible();
    await shot("attachment-mine");
    await field(page).fill("A longer message\nover a few lines\nso the field grows\nto hold them all");
    await shot("composer-lines");
    await field(page).fill("");
    await page.getByTestId("model").click();
    await expect(page.getByTestId("model-picker")).toBeVisible();
    await shot("composer-model");
    await page.keyboard.press("Escape");
    await said(page, "Groceries are up").last().getByTestId("bubble").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reply" }).click();
    await shot("composer-replying");
    await page.keyboard.press("Escape");
    await sendFromApp(page, "/slow 30");
    await expect(page.getByTestId("stop")).toBeVisible();
    await shot("composer-stop");
    await page.getByTestId("stop").click();
    await server.control("outage", { ms: 60_000 });
    await expect(page.getByTestId("offline-line")).toBeVisible();
    await shot("composer-offline");
    await server.control("outage", { ms: 0 });
    await expect(page.getByTestId("offline-line")).toHaveCount(0, { timeout: 30_000 });
    const chat = page.getByTestId("chat");
    await chat.dispatchEvent("dragenter", { dataTransfer: await page.evaluateHandle(() => {
      const carried = new DataTransfer();
      carried.items.add(new File(["x"], "plan.pdf", { type: "application/pdf" }));
      return carried;
    }) });
    await expect(page.getByTestId("drop-overlay")).toBeVisible();
    await shot("composer-drop");
    await chat.dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });

    await setWindowSize(760, 520);
    await openChat(page, server, "Atlas");
    await shot("small-atlas");
    await openChat(page, server, "Pip");
    await shot("small-pip");
    await setWindowSize(1800, 1100);
    await shot("wide-pip");
  });
}
