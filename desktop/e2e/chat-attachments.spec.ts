// Files in the chat: adding them to a message with the + button, by dropping
// them on the chat and by pasting, the limits on what a message carries, and
// the pictures, pages and files an agent sends, with what a click on each does.

import { closeSync, openSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, type TestServer } from "./fixtures.ts";
import { addAgent, box, field, messagesOf, mine, openChat, payload, png, said, sendFromApp, toast, until } from "./chat-helpers.ts";

/** Adds an agent and opens its chat. */
async function chatWith(page: Page, server: TestServer, name = "Echo") {
  await addAgent(page, server, name);
  return openChat(page, server, name);
}

/** A small picture, as a person picks one. */
const picture = (name = "tap.png", width = 64, height = 48) => payload(name, png(width, height, (x, y) => [x * 4, y * 5, 120]), "image/png");

/** A file a message carries, as the server says it: its own name and its size in bytes. */
async function sent(server: TestServer, agentId: string, path: string) {
  const answer = await server.api(`/agents/${agentId}/${path}`, { method: "HEAD" });
  return { name: path.split("/").pop()!.replace(/^[0-9a-f]{8}-/, ""), size: Number(answer.headers.get("Content-Length")) };
}

/** A size as the chat writes it under a file's name. */
const sizeWords = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

/** The agent's newest message that carries files, as the server has it. */
const withFiles = (server: TestServer, agentId: string) =>
  until(
    () => messagesOf(server, agentId),
    (messages) => messages.some((message) => message.sender === "agent" && message.attachments.length > 0),
  ).then((messages) => messages.findLast((message) => message.sender === "agent" && message.attachments.length > 0)!);

/** Makes files in the window, for the events that carry them, as the system's own drag or paste would. */
const transfer = (page: Page, files: { name: string; type: string; bytes: number[] }[]) =>
  page.evaluateHandle((files) => {
    const carried = new DataTransfer();
    for (const { name, type, bytes } of files) carried.items.add(new File([new Uint8Array(bytes)], name, { type }));
    return carried;
  }, files);

const tray = (page: Page) => page.getByTestId("tray-item");

test.describe("adding files to a message", () => {
  test("the + button opens the file picker, and the picked files sit in the tray as a thumbnail and a card", async ({ page, server }) => {
    await chatWith(page, server);
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("add-files").click();
    await (await chooser).setFiles([picture(), payload("Quote.pdf", Buffer.alloc(3 * 1024, 7), "application/pdf")]);
    await expect(tray(page)).toHaveCount(2);
    const thumbnail = tray(page).nth(0).getByRole("img", { name: "tap.png" });
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(64);
    await expect(tray(page).nth(1)).toContainText("Quote.pdf");
    await expect(tray(page).nth(1)).toContainText("PDF · 3 KB");
    await expect(field(page)).toBeFocused();
  });

  test("a file in the tray can be removed", async ({ page, server }) => {
    await chatWith(page, server);
    await page.getByTestId("file-input").setInputFiles([picture("one.png"), payload("two.txt", Buffer.from("two"), "text/plain"), payload("three.csv", Buffer.from("a,b\n"), "text/csv")]);
    await expect(tray(page)).toHaveCount(3);
    await page.getByRole("button", { name: "Remove two.txt" }).click();
    await expect(tray(page)).toHaveCount(2);
    await expect(tray(page).filter({ hasText: "two.txt" })).toHaveCount(0);
    await expect(tray(page).nth(1)).toContainText("three.csv");
    await page.getByRole("button", { name: "Remove one.png" }).click();
    await page.getByRole("button", { name: "Remove three.csv" }).click();
    await expect(page.getByTestId("tray")).toHaveCount(0);
  });

  test("files dragged over the chat show where to drop them, and dropped they join the message", async ({ page, server }) => {
    await chatWith(page, server);
    const chat = page.getByTestId("chat");
    const files = await transfer(page, [
      { name: "Kitchen plan.pdf", type: "application/pdf", bytes: [37, 80, 68, 70] },
      { name: "photo.png", type: "image/png", bytes: [...png(20, 20, () => [200, 40, 40])] },
    ]);
    const overlay = page.getByTestId("drop-overlay");
    await chat.dispatchEvent("dragenter", { dataTransfer: files });
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Drop to add to your message");
    await expect(overlay).toContainText("Up to 10 files, 95 MB in all");
    // Passing over a part of the chat and out of it again doesn't end the drag; leaving the chat does.
    await page.getByTestId("timeline").dispatchEvent("dragenter", { dataTransfer: files });
    await chat.dispatchEvent("dragleave", { dataTransfer: files });
    await expect(overlay).toBeVisible();
    await page.getByTestId("timeline").dispatchEvent("dragleave", { dataTransfer: files });
    await expect(overlay).toHaveCount(0);
    await expect(tray(page)).toHaveCount(0);

    await chat.dispatchEvent("dragenter", { dataTransfer: files });
    await chat.dispatchEvent("dragover", { dataTransfer: files });
    await expect(overlay).toBeVisible();
    await chat.dispatchEvent("drop", { dataTransfer: files });
    await expect(overlay).toHaveCount(0);
    await expect(tray(page)).toHaveCount(2);
    await expect(tray(page).nth(0)).toContainText("Kitchen plan.pdf");
    await expect(tray(page).nth(1).getByRole("img", { name: "photo.png" })).toBeVisible();
  });

  test("dragging text, not files, over the chat shows nothing", async ({ page, server }) => {
    await chatWith(page, server);
    const words = await page.evaluateHandle(() => {
      const carried = new DataTransfer();
      carried.setData("text/plain", "just words");
      return carried;
    });
    await page.getByTestId("chat").dispatchEvent("dragenter", { dataTransfer: words });
    await expect(page.getByTestId("drop-overlay")).toHaveCount(0);
  });

  test("a picture pasted into the message field joins the message", async ({ page, server }) => {
    await chatWith(page, server);
    await field(page).fill("Look at this");
    const bytes = [...png(30, 20, () => [10, 160, 90])];
    await field(page).evaluate((element, bytes) => {
      const carried = new DataTransfer();
      carried.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: carried, bubbles: true, cancelable: true }));
    }, bytes);
    await expect(tray(page)).toHaveCount(1);
    await expect(tray(page).getByRole("img", { name: "image.png" })).toBeVisible();
    await expect(field(page)).toHaveValue("Look at this");
  });

  test("ten files are allowed, and an eleventh is refused with the phone's words", async ({ page, server }) => {
    await chatWith(page, server);
    const files = Array.from({ length: 11 }, (_, index) => payload(`note ${index + 1}.txt`, Buffer.from(`note ${index + 1}`), "text/plain"));
    await page.getByTestId("file-input").setInputFiles(files);
    await expect(tray(page)).toHaveCount(10);
    await expect(toast(page, "Can't add that")).toContainText("A message can carry up to 10 files.");
    await expect(tray(page).filter({ hasText: "note 11.txt" })).toHaveCount(0);
    await expect(page.getByTestId("add-files")).toBeDisabled();
    // Taking one away makes room again.
    await page.getByRole("button", { name: "Remove note 1.txt" }).click();
    await expect(page.getByTestId("add-files")).toBeEnabled();
  });

  test("more than 95 MB is refused with the phone's words, and nothing of it is added", async ({ page, server }) => {
    await chatWith(page, server);
    // Sparse files on disk, so the test writes almost nothing.
    const sparse = (name: string, megabytes: number) => {
      const path = join(server.home, name);
      closeSync(openSync(path, "w"));
      truncateSync(path, megabytes * 1024 * 1024);
      return path;
    };
    await page.getByTestId("file-input").setInputFiles([sparse("video.mov", 96)]);
    await expect(toast(page, "Can't add that")).toContainText("A message can carry up to 95 MB of photos and files.");
    await expect(page.getByTestId("tray")).toHaveCount(0);
    // Two files that fit apart and not together: the first stays, the second is refused.
    await page.getByTestId("file-input").setInputFiles([sparse("first.mov", 60)]);
    await expect(tray(page)).toHaveCount(1);
    await page.getByTestId("file-input").setInputFiles([sparse("second.mov", 40)]);
    await expect(toast(page, "Can't add that").last()).toContainText("A message can carry up to 95 MB of photos and files.");
    await expect(tray(page)).toHaveCount(1);
    await expect(tray(page)).toContainText("first.mov");
  });
});

test.describe("sending files", () => {
  test("/echo-files: the agent receives exactly the files that were sent", async ({ page, server }) => {
    const id = await chatWith(page, server);
    const files = [picture("tap.png", 120, 90), payload("notes.txt", Buffer.from("Ring the plumber before 5\n"), "text/plain"), payload("budget.csv", Buffer.from("Category,Spent\nGroceries,241.60\n"), "text/csv")];
    await page.getByTestId("file-input").setInputFiles(files);
    await sendFromApp(page, "/echo-files");
    const reply = said(page, /^You sent me 3 files/);
    await expect(reply).toBeVisible();
    await expect(reply.locator("li")).toHaveText(files.map((file) => `${file.name}, ${file.buffer.length.toLocaleString("en")} bytes`));
    const message = (await messagesOf(server, id)).find((each) => each.sender === "person")!;
    const received = await Promise.all(message.attachments.map((path) => sent(server, id, path)));
    expect(received).toEqual(files.map((file) => ({ name: file.name, size: file.buffer.length })));
  });

  test("the person's sent files show above their message: the picture, and a card for each other file", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await page.getByTestId("file-input").setInputFiles([picture("tap.png", 120, 90), payload("notes.txt", Buffer.from("Ring the plumber\n"), "text/plain"), payload("plan.html", Buffer.from("<p>my page</p>"), "text/html")]);
    await sendFromApp(page, "Here you go");
    const message = mine(page).filter({ hasText: "Here you go" });
    await expect(message.getByTestId("message-photos").locator("img")).toHaveCount(1);
    // An HTML file from the person is a file, as it is to the agent, not a page drawn in the chat.
    await expect(message.getByTestId("message-page")).toHaveCount(0);
    await expect(message.getByTestId("message-file")).toHaveCount(2);
    await expect(message.getByTestId("message-file").nth(0)).toHaveAccessibleName("notes.txt, Text · 17 B");
    await expect(message.getByTestId("message-file").nth(1)).toHaveAccessibleName("plan.html, HTML · 14 B");
    await expect(said(page, /./)).toHaveCount(1);
    expect((await messagesOf(server, id))[0].attachments).toHaveLength(3);
  });

  test("a message can go with only files", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await page.getByTestId("file-input").setInputFiles([picture("one.png"), picture("two.png")]);
    await expect(page.getByTestId("send")).toBeEnabled();
    await field(page).press("Enter");
    await expect(said(page, "Thanks, I've got the 2 files.")).toBeVisible();
    await expect(mine(page).getByTestId("bubble")).toHaveCount(0);
    await expect(mine(page).getByTestId("message-photos").locator("img")).toHaveCount(2);
    expect((await messagesOf(server, id))[0].body).toBe("");
  });
});

test.describe("pictures, pages and files from the agent", () => {
  test("a single picture shows in its own shape, fitted to its box", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "/image");
    const photos = said(page, "Here's the view from the ferry last night.").getByTestId("message-photos");
    const button = photos.getByRole("button");
    await expect(button).toHaveCount(1);
    await expect.poll(() => button.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(1200);
    // The sunset is 3:2, which is wider than 4:3, so it is shown at 4:3 across the box's width.
    await expect.poll(async () => {
      const { width, height } = await box(button);
      return [Math.round(width), Math.round(height)];
    }).toEqual([228, 171]);
  });

  test("several pictures show as rows of square tiles, three to a row", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "/images 7");
    const tiles = said(page, "Here are 7 pictures from the trip.").getByTestId("message-photos").getByRole("button");
    await expect(tiles).toHaveCount(7);
    const boxes = await Promise.all(Array.from({ length: 7 }, (_, index) => box(tiles.nth(index))));
    for (const each of boxes) expect([Math.round(each.width), Math.round(each.height)]).toEqual([104, 104]);
    const rows = [...new Set(boxes.map((each) => Math.round(each.top)))];
    expect(rows).toHaveLength(3);
    expect(rows.map((top) => boxes.filter((each) => Math.round(each.top) === top).length)).toEqual([3, 3, 1]);
  });

  test("clicking a picture opens the panel at that picture", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/images 3");
    const tiles = said(page, "Here are 3 pictures from the trip.").getByTestId("message-photos").getByRole("button");
    await expect(tiles).toHaveCount(3);
    const message = await withFiles(server, id);
    const second = (await sent(server, id, message.attachments[1])).name;
    await tiles.nth(1).click();
    await expect(page.getByTestId("panel")).toBeVisible();
    await expect(page.getByTestId("images")).toBeVisible();
    await expect(page.getByTestId("image-count")).toHaveText("2 of 3");
    await expect(page.getByTestId("panel-title")).toContainText(second);
  });

  test("a page first drawn while Sidebots is out of reach holds its place, and draws once Sidebots is back", async ({ page, server }) => {
    const bravo = await addAgent(page, server, "Bravo");
    const echo = await chatWith(page, server);
    // The page comes into Echo's chat while the person looks at another, so the window has never asked about its file. Then Sidebots goes out of reach.
    await page.getByTestId(`agent-${bravo}`).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Bravo");
    await server.control("deliver", { agent: echo, text: "Here's the plan.", files: ["page"] });
    await expect(page.getByTestId(`agent-${echo}`)).toContainText("Here's the plan.");
    await server.control("outage", { ms: 60_000 });
    await expect(page.getByTestId("offline-line")).toBeVisible();

    await page.getByTestId(`agent-${echo}`).click();
    const message = said(page, "Here's the plan.");
    const card = message.getByTestId("message-page");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("page-waiting")).toBeVisible();
    await expect(card.getByRole("status", { name: "Loading Lisbon weekend" })).toBeVisible();
    await expect(message.getByTestId("message-file")).toHaveCount(0);
    // It is still a page a moment later, once the server's refusal has long been heard.
    await page.waitForTimeout(500);
    await expect(card.getByTestId("page-waiting")).toBeVisible();
    await expect(message.getByTestId("message-file")).toHaveCount(0);

    await server.control("outage", { ms: 0 });
    await expect(page.getByTestId("offline-line")).toHaveCount(0, { timeout: 30_000 });
    await expect(card.getByTestId("page-frame")).toBeVisible();
    await expect(card.frameLocator("iframe").getByRole("heading", { name: "Three days" })).toBeVisible();
    await expect(card.getByTestId("page-waiting")).toHaveCount(0);
    await expect(message.getByTestId("message-file")).toHaveCount(0);
  });

  test("a page drawn again while Sidebots is out of reach loads by itself once Sidebots is back", async ({ page, server }) => {
    const bravo = await addAgent(page, server, "Bravo");
    const echo = await chatWith(page, server);
    await sendFromApp(page, "/page");
    const card = said(page, "Here's a plan for the Lisbon weekend.").getByTestId("message-page");
    const heading = card.frameLocator("iframe").getByRole("heading", { name: "Three days" });
    await expect(heading).toBeVisible();
    await server.control("outage", { ms: 60_000 });
    await expect(page.getByTestId("offline-line")).toBeVisible();

    // The person looks at another chat and comes back, so the page is drawn afresh while Sidebots can't give it.
    await page.getByTestId(`agent-${bravo}`).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Bravo");
    await page.getByTestId(`agent-${echo}`).click();
    await expect(page.getByTestId("chat-name")).toHaveText("Echo");
    await expect(card.getByTestId("page-waiting")).toBeVisible();

    // Once Sidebots is back the page loads without the person doing anything.
    await server.control("outage", { ms: 0 });
    await expect(page.getByTestId("offline-line")).toHaveCount(0, { timeout: 30_000 });
    await expect(heading).toBeVisible();
    await expect(card.getByTestId("page-waiting")).toHaveCount(0);
  });

  test("a page that has loaded stays as the person left it while Sidebots is out of reach and after", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "/page");
    const card = said(page, "Here's a plan for the Lisbon weekend.").getByTestId("message-page");
    const frame = card.locator("iframe");
    const body = card.frameLocator("iframe").locator("body");
    const heading = card.frameLocator("iframe").getByRole("heading", { name: "Three days" });
    await expect(heading).toBeVisible();
    // A mark on the frame goes if the frame is drawn again, and a mark in the page goes if the page loads again.
    await frame.evaluate((element) => (element.dataset.kept = "yes"));
    await body.evaluate((element) => (element.dataset.kept = "yes"));

    await server.control("outage", { ms: 60_000 });
    await expect(page.getByTestId("offline-line")).toBeVisible();
    await expect(heading).toBeVisible();
    await expect(card.getByTestId("page-waiting")).toHaveCount(0);

    await server.control("outage", { ms: 0 });
    await expect(page.getByTestId("offline-line")).toHaveCount(0, { timeout: 30_000 });
    await expect(frame).toHaveAttribute("data-kept", "yes");
    await expect(body).toHaveAttribute("data-kept", "yes");
    await expect(heading).toBeVisible();
  });

  test("a page draws inline in its frame, in the window's colours, light and dark", async ({ page, server, setColorScheme }) => {
    await chatWith(page, server);
    await sendFromApp(page, "/page");
    const card = said(page, "Here's a plan for the Lisbon weekend.").getByTestId("message-page");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Lisbon weekend");
    const frame = card.getByTestId("page-frame");
    // A short page takes the room it needs, between 60 and 480 pixels, once it has said how tall it is.
    await expect.poll(async () => Math.round((await box(frame)).height)).not.toBe(160);
    const height = (await box(frame)).height;
    expect(height).toBeGreaterThanOrEqual(60);
    expect(height).toBeLessThanOrEqual(480);
    for (const scheme of ["light", "dark"] as const) {
      await setColorScheme(scheme);
      await expect.poll(() => pageColours(page)).toEqual(await windowColours(page));
    }
  });

  test("a tall page is cut at 480 pixels with Show all, which opens it in the panel, as its button does", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "/page tall");
    const card = said(page, "Here are six flats in Brunswick.").getByTestId("message-page");
    const frame = card.getByTestId("page-frame");
    await expect.poll(async () => Math.round((await box(frame)).height)).toBe(480);
    const all = card.getByRole("button", { name: "Show all of Flats in Brunswick" });
    await expect(all).toHaveText("Show all");
    await all.click();
    await expect(page.getByTestId("panel")).toBeVisible();
    await expect(page.getByTestId("panel-title")).toHaveText("Flats in Brunswick");
    await expect(page.getByTestId("page")).toBeVisible();
    await page.getByTestId("close-panel").click();
    await expect(page.getByTestId("panel")).toHaveCount(0);
    await card.getByRole("button", { name: "Open Flats in Brunswick in the panel" }).click();
    await expect(page.getByTestId("panel-title")).toHaveText("Flats in Brunswick");
  });

  test("a link in a page opens in the system browser when clicked, and never by the page's own script", async ({ page, server, mainCalls }) => {
    await chatWith(page, server);
    await sendFromApp(page, "/page");
    const card = said(page, "Here's a plan for the Lisbon weekend.").getByTestId("message-page");
    await expect(card).toBeVisible();
    const inside = card.frameLocator("iframe");
    const link = inside.getByRole("link", { name: "Parques de Sintra" });
    await expect(link).toBeVisible();
    // The page's own script opens a site on a timer, long after anything the person did, so nothing the person did lets it.
    // A browser counts what a person did as theirs for five seconds, so the timer is longer than that, and the wait is what is under test.
    const frame = page.frames().find((each) => each.url().startsWith("sidebots-page://"))!;
    await frame.evaluate(() => void setTimeout(() => window.open("https://example.org/popup", "_blank"), 6_000));
    await page.waitForTimeout(7_500);
    expect((await mainCalls()).opened).toEqual([]);
    await link.click();
    await expect.poll(async () => (await mainCalls()).opened).toEqual(["https://www.parquesdesintra.pt/en/"]);
    await expect(page.getByTestId("chat-name")).toHaveText("Echo");
  });

  test("files show as cards with their kind and size", async ({ page, server }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/files");
    const cards = said(page, "Here's the plumber's invoice").getByTestId("message-file");
    await expect(cards).toHaveCount(4);
    const message = await withFiles(server, id);
    const files = await Promise.all(message.attachments.map((path) => sent(server, id, path)));
    const kinds = ["PDF", "Spreadsheet", "Text", "ZIP"];
    for (const [index, file] of files.entries()) await expect(cards.nth(index)).toHaveAccessibleName(`${file.name}, ${kinds[index]} · ${sizeWords(file.size)}`);
  });

  test("a click opens a document in its app, and shows any other file in its folder", async ({ page, server, mainCalls }) => {
    await chatWith(page, server);
    await sendFromApp(page, "/files");
    const cards = said(page, "Here's the plumber's invoice").getByTestId("message-file");
    await expect(cards).toHaveCount(4);
    await cards.filter({ hasText: "invoice.pdf" }).click();
    await expect.poll(async () => (await mainCalls()).files.map((path) => path.split("/").pop())).toEqual(["Hughes-and-Son-invoice.pdf"]);
    await cards.filter({ hasText: ".zip" }).click();
    await expect.poll(async () => (await mainCalls()).shown.map((path) => path.split("/").pop())).toEqual(["Lisbon-tickets.zip"]);
    expect((await mainCalls()).files).toHaveLength(1);
    const opened = (await mainCalls()).files[0];
    expect(readFileSync(opened).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("Save as… from a file's context menu saves a copy where the person chooses", async ({ page, server, mainCalls }) => {
    const id = await chatWith(page, server);
    await sendFromApp(page, "/files");
    const card = said(page, "Here's the plumber's invoice").getByTestId("message-file").filter({ hasText: ".csv" });
    await expect(card).toBeVisible();
    await card.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Save as…" }).click();
    await expect.poll(async () => (await mainCalls()).saved).toEqual(["November-budget.csv"]);
    const message = await withFiles(server, id);
    const csv = await sent(server, id, message.attachments.find((path) => path.endsWith(".csv"))!);
    await expect.poll(() => statSync(join(server.home, "saved", "November-budget.csv"), { throwIfNoEntry: false })?.size).toBe(csv.size);
    expect((await mainCalls()).files).toEqual([]);
  });

  test("/mixed shows the picture, then the page, then the file, then the words, as the phone does", async ({ page, server }) => {
    await chatWith(page, server);
    await sendFromApp(page, "/mixed");
    const message = said(page, "Groceries are up £30 on October.");
    await expect(message.getByTestId("message-page")).toBeVisible();
    const order = await message.evaluate((row) => [...row.querySelectorAll('[data-testid="message-photos"], [data-testid="message-page"], [data-testid="message-file"], [data-testid="bubble"]')].map((part) => part.getAttribute("data-testid")));
    expect(order).toEqual(["message-photos", "message-page", "message-file", "bubble"]);
  });
});

/** The window's own page colours, as solid red, green and blue. */
function windowColours(page: Page) {
  return page.evaluate(() => {
    const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgb = (color: string) => {
      paint.fillStyle = "#000";
      paint.fillRect(0, 0, 1, 1);
      paint.fillStyle = color;
      paint.fillRect(0, 0, 1, 1);
      return [...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(",");
    };
    const root = getComputedStyle(document.documentElement);
    return { bg: rgb(root.getPropertyValue("--canvas").trim()), ink: rgb(root.getPropertyValue("--ink").trim()) };
  });
}

/** The colours the page in the chat is drawn in: its background and its text. */
async function pageColours(page: Page) {
  const frame = page.frames().find((each) => each.url().startsWith("sidebots-page://") && each.url().includes("Lisbon"));
  if (!frame) return null;
  return frame
    .evaluate(() => {
      const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const rgb = (color: string) => {
        paint.fillStyle = "#000";
        paint.fillRect(0, 0, 1, 1);
        paint.fillStyle = color;
        paint.fillRect(0, 0, 1, 1);
        return [...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(",");
      };
      const body = getComputedStyle(document.body);
      const html = getComputedStyle(document.documentElement);
      const bg = body.backgroundColor !== "rgba(0, 0, 0, 0)" ? body.backgroundColor : html.backgroundColor;
      return { bg: rgb(bg), ink: rgb(body.color) };
    })
    .catch(() => null);
}

