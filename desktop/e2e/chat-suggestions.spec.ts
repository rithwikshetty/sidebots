// Work an agent offers to do: the suggestions it offers together as a stack
// that shows one at a time, Start and Not now, the strip over the message
// field while started work runs, and that work on the agent's page.

import type { Page } from "@playwright/test";
import { isSuggestion, type Message } from "../../server/src/contract.ts";
import { expect, test, type TestServer } from "./fixtures.ts";
import { addAgent, messagesOf, openChat, sendFromApp, until } from "./chat-helpers.ts";
import { SUGGESTIONS } from "./scripted/script.ts";

/** The row of a message, by its id. */
const row = (page: Page, message: Message) => page.locator(`[data-message-id="${message.id}"]`);

/** Adds an agent, opens its chat and has it offer three suggestions, and resolves to them as the server has them, in the order offered. */
async function offered(page: Page, server: TestServer): Promise<Message[]> {
  await addAgent(page, server, "Echo");
  const id = await openChat(page, server, "Echo");
  await sendFromApp(page, "/suggest");
  const messages = await until(
    () => messagesOf(server, id),
    (messages) => messages.filter(isSuggestion).length === SUGGESTIONS.length,
  );
  return messages.filter(isSuggestion);
}

test("three suggestions show as a stack: Start runs the first beside the chat, the next comes up, and Not now puts one away", async ({ page, server }) => {
  const [first, second, third] = await offered(page, server);
  // Only the first shows, with its place and the edges of the two under it.
  await expect(page.getByTestId("ask-card")).toHaveCount(1);
  await expect(row(page, first).getByTestId("ask-card")).toContainText(SUGGESTIONS[0].title);
  await expect(row(page, first).getByTestId("ask-place")).toHaveText("1 of 3");
  await expect(row(page, first).getByTestId("stack-edge")).toHaveCount(2);
  await expect(row(page, first).getByTestId("ask-answers").getByRole("button")).toHaveText(["Not now", "Start"]);
  await expect(page.getByTestId("work-strip")).toHaveCount(0);

  // Started, it stays as its card and says it is working, and the next one shows in its place.
  await row(page, first).getByRole("button", { name: "Start" }).click();
  await expect(row(page, first).getByTestId("ask-outcome")).toHaveText("Working");
  await expect(row(page, first).getByTestId("ask-place")).toHaveCount(0);
  await expect(row(page, second).getByTestId("ask-place")).toHaveText("2 of 3");
  await expect(row(page, second).getByTestId("stack-edge")).toHaveCount(1);
  const strip = page.getByTestId("work-strip");
  await expect(strip).toContainText(SUGGESTIONS[0].title);
  await expect(strip).toContainText("Working");

  // Not now puts it away, and the last one shows with nothing under it.
  await row(page, second).getByRole("button", { name: "Not now" }).click();
  await expect(row(page, second)).toHaveCount(0);
  await expect(row(page, third).getByTestId("ask-place")).toHaveText("3 of 3");
  await expect(row(page, third).getByTestId("stack-edge")).toHaveCount(0);
  await expect(page.getByTestId("ask-card")).toHaveCount(2);
});

test("the strip opens the agent's page, where the work it started can be stopped", async ({ page, server }) => {
  const [first] = await offered(page, server);
  await row(page, first).getByRole("button", { name: "Start" }).click();
  // The page opens on Jobs & memory, where the work is.
  await page.getByTestId("work-strip").click();
  await expect(page.getByRole("radio", { name: "Jobs & memory" })).toBeChecked();
  const work = page.getByTestId("agent-work").getByTestId("work");
  await expect(work).toHaveCount(1);
  await expect(work).toContainText(SUGGESTIONS[0].title);
  await expect(work).toContainText("Working");
  await work.getByTestId("stop-work").click();
  await expect(work).toContainText("Didn't finish");
  await expect(work.getByTestId("stop-work")).toHaveCount(0);
  await expect(page.getByTestId("work-strip")).toHaveCount(0);
  await expect(row(page, first).getByTestId("ask-outcome")).toHaveText("Didn't finish");
});
