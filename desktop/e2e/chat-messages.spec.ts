// The chat's messages, in the seeded world: every kind Atlas's week holds,
// the markdown an agent writes, how the chat scrolls and pages back, what
// counts as read, and how the bubbles look in light and dark, narrow and wide.

import type { Page } from "@playwright/test";
import { PAGE, oneLine } from "../../server/src/contract.ts";
import { expect, test } from "./fixtures.ts";
import { agentId, agentOf, box, expectAtEnd, field, fromEnd, jumpOffered, messagesOf, mine, notices, openChat, said, scrollChatTo, sendFromApp, theirs, timeline, until, wholeChat } from "./chat-helpers.ts";

test.use({ world: "seeded" });

/** The first thing said in Atlas's chat, a week ago. */
const ATLAS_FIRST = "Morning! Can you keep track of the errands for this week?";

/** How a day marker names a day `offset` days from today, as this window writes a date. */
const dayWords = (page: Page, offset: number) =>
  page.evaluate((offset) => {
    const day = new Date();
    day.setDate(day.getDate() + offset);
    return day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  }, offset);

test.describe("every kind of message in history", () => {
  test("day markers name each day of the week the chat covers", async ({ page, server }) => {
    const id = await openChat(page, server, "Atlas");
    // Back to the chat's first message, so the window has the whole week, and on through it to the end. The chat draws only the rows near the screen, so each marker is read as it passes. A marker is told from the next by the message it stands over, so a day marked twice is two.
    await scrollChatTo(page, mine(page).filter({ hasText: ATLAS_FIRST }));
    const days = new Map<string, string>();
    for (;;) {
      const drawn = await page.getByTestId("day").evaluateAll((markers) => markers.map((marker) => ({ over: (marker as HTMLElement).dataset.day!.slice("day:".length), words: (marker as HTMLElement).innerText })));
      for (const { over, words } of drawn) days.set(over, words);
      if ((await fromEnd(page)) <= 2) break;
      await page.mouse.wheel(0, 500);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    // In the order of the messages they stand over.
    const order = (await wholeChat(server, id)).map((message) => message.id);
    const marked = [...days].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([, words]) => words);
    expect(marked).toEqual([...(await Promise.all([-6, -5, -4, -3, -2].map((offset) => dayWords(page, offset)))), "Yesterday", "Today"]);
  });

  test("Sidebots' notices are drawn as notes, not bubbles", async ({ page, server }) => {
    await openChat(page, server, "Atlas");
    // Newest first, as scrolling back through the chat comes to them.
    for (const words of ["Fresh start", "Stopped", "Sidebots couldn't finish this. Your Claude usage limit is reached. It resets at 4pm (Europe/London)."]) {
      const note = notices(page).filter({ hasText: words });
      await scrollChatTo(page, note);
      await expect(note).toBeVisible();
      await expect(note).toHaveText(words);
      expect(await note.evaluate((element) => element.closest('[data-testid="bubble"]') === null && getComputedStyle(element).textAlign === "center")).toBe(true);
    }
  });

  test("a failed message shows Send again, and sending it again gets the agent's answer", async ({ page, server }) => {
    const id = await openChat(page, server, "Patch");
    const failed = mine(page).filter({ hasText: "Run the test suite again and deploy to staging" });
    await expect(failed).toHaveAttribute("data-status", "failed");
    await expect(notices(page).filter({ hasText: "Sidebots couldn't finish this. Codex on your computer is signed out. Sign in to it there." })).toBeVisible();
    await expect(failed.getByTestId("send-again")).toHaveText("Send again");
    await expect(failed.getByTestId("receipt")).toHaveCount(0);
    await failed.getByTestId("send-again").click();
    await expect(said(page, "Found it: the date was read as UTC").last()).toBeVisible();
    await expect(failed.getByTestId("send-again")).toHaveCount(0);
    await expect(failed.getByTestId("receipt")).toHaveText(/^Read /);
    const messages = await messagesOf(server, id);
    expect(messages.find((message) => message.body === "Run the test suite again and deploy to staging")!.status).toBe("done");
  });

  test("a reply quotes the message it answers", async ({ page, server }) => {
    const id = await agentId(server, "Atlas");
    const all = await wholeChat(server, id);
    const plumbers = all.find((message) => message.body.startsWith("Three nearby with good reviews"))!;
    await openChat(page, server, "Atlas");
    // Back to the message it answers, so the window has it, and on to the reply.
    await scrollChatTo(page, said(page, "Three nearby with good reviews"));
    const reply = mine(page).filter({ hasText: "Actually, what was FlowFix's price again?" });
    await scrollChatTo(page, reply, "on");
    await expect(reply.getByTestId("quote")).toHaveText(oneLine(plumbers));
    await expect(reply.getByTestId("quote")).toHaveAccessibleName(`In reply to: ${oneLine(plumbers)}`);
  });

  test("a reply to a message the window hasn't loaded quotes An earlier message", async ({ page, server }) => {
    const id = await openChat(page, server, "Atlas");
    const first = (await wholeChat(server, id))[0];
    // The phone replies to the chat's very first message, which is pages back from what the window has.
    const form = new FormData();
    form.append("body", "Going back to the start: is the list still right?");
    form.append("replyTo", first.id);
    expect((await server.api(`/agents/${id}/messages`, { method: "POST", body: form })).ok).toBe(true);
    const reply = mine(page).filter({ hasText: "Going back to the start" });
    await expect(reply.getByTestId("quote")).toHaveText("An earlier message");
  });

  test("an exchange with another agent shows as one line in each state, and opens in the panel", async ({ page, server }) => {
    await openChat(page, server, "Atlas");
    const answered = page.getByRole("button", { name: "Atlas asked Ledger. Answered" });
    const unanswered = page.getByRole("button", { name: "Atlas asked Scout. No answer" });
    // The exchange with Scout is the later of the two, so scrolling back comes to it first.
    await scrollChatTo(page, unanswered);
    await expect(unanswered).toHaveAttribute("data-state", "No answer");
    await scrollChatTo(page, answered);
    await expect(answered).toHaveAttribute("data-state", "Answered");
    await expect(answered).toContainText("Atlas asked Ledger · Answered");
    // What the two said to each other is the line, not bubbles in the chat.
    await expect(theirs(page).filter({ hasText: "Can you check what's left in Home for November?" })).toHaveCount(0);
    await answered.click();
    await expect(page.getByTestId("panel")).toBeVisible();
    await expect(page.getByTestId("exchange")).toContainText("Can you check what's left in Home for November?");
    await expect(page.getByTestId("exchange")).toContainText("There's £410 left in Home for November");
    await expect(page.getByTestId("exchange-message")).toHaveCount(2);
  });

  test("an exchange waiting for its answer says Waiting in both chats, then Answered", async ({ page, server }) => {
    const ledger = await agentId(server, "Ledger");
    await openChat(page, server, "Atlas");
    await server.control("hold", { agent: ledger, message: "Tot up the takeaways" });
    await sendFromApp(page, "/agent Ledger how much is left for eating out?");
    const line = page.getByRole("button", { name: /^Atlas asked Ledger\./ }).last();
    await expect(line).toHaveAttribute("data-state", "Waiting");
    await openChat(page, server, "Ledger");
    await expect(page.getByRole("button", { name: "Atlas asked Ledger. Waiting" })).toBeVisible();
    await openChat(page, server, "Atlas");
    await server.control("release", { agent: ledger });
    await expect(page.getByRole("button", { name: /^Atlas asked Ledger\./ }).last()).toHaveAttribute("data-state", "Answered", { timeout: 20_000 });
    await expect(said(page, /^Heard back from Ledger:/)).toBeVisible();
  });
});

test.describe("an agent's markdown", () => {
  test("/long draws headings, lists, a table, inline code, a quote and struck text", async ({ page, server }) => {
    await openChat(page, server, "Pip");
    await sendFromApp(page, "/long");
    const reply = said(page, "Moving the budget off the spreadsheet").getByTestId("markdown");
    await expect(reply).toBeVisible();
    await expect(reply.locator("h2")).toHaveText("Moving the budget off the spreadsheet");
    await expect(reply.locator("h3")).toHaveText(["What it does", "Where things stand", "The parts"]);
    await expect(reply.locator("strong").first()).toHaveText("monthly budget");
    await expect(reply.locator("em").first()).toHaveText("by itself");
    await expect(reply.locator("ol > li")).toHaveCount(3);
    await expect(reply.locator("ol > li ul > li")).toHaveText(["groceries, home, transport", "anything it can't place goes to Other for you to check"]);
    await expect(reply.locator("th")).toHaveText(["Category", "Budget", "Spent", "Left"]);
    await expect(reply.locator("tbody tr")).toHaveCount(3);
    expect(await reply.locator("tbody tr").first().locator("td").nth(1).evaluate((cell) => getComputedStyle(cell).textAlign)).toBe("right");
    await expect(reply.locator(":not(pre) > code")).toHaveText(["~/Downloads", "budget.json"]);
    await expect(reply.locator("blockquote")).toHaveText("Eating out is the one to watch: it went over by £12 last month too.");
    await expect(reply.locator("del")).toHaveText("wait until January");
  });

  test("fenced code names its language, and its copy button puts the code on the clipboard", async ({ page, server, electronApp }) => {
    await openChat(page, server, "Pip");
    await sendFromApp(page, "/long");
    const blocks = said(page, "Moving the budget").getByTestId("code-block");
    await expect(blocks).toHaveCount(3);
    await expect(blocks.getByTestId("code-language")).toHaveText(["ts", "python", "bash"]);
    await expect(blocks.nth(2).locator("pre")).toHaveText("0 7 * * * cd ~/budget && node update.ts >> update.log 2>&1");
    const copy = blocks.nth(1).getByTestId("copy-code");
    await expect(copy).toHaveAccessibleName("Copy code");
    await copy.click();
    await expect(copy).toHaveAccessibleName("Copied");
    const python = 'import csv\n\nwith open("statement.csv") as f:\n    rows = [row for row in csv.DictReader(f) if float(row["Amount"]) < 0]\nprint(f"{len(rows)} payments this month")';
    await expect.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(python);
    await expect(copy).toHaveAccessibleName("Copy code", { timeout: 4_000 });
  });

  test("a link in a reply opens in the system browser and never navigates the window", async ({ page, server, electronApp, mainCalls }) => {
    await openChat(page, server, "Pip");
    await sendFromApp(page, "/long");
    const link = said(page, "Moving the budget").getByRole("link", { name: "on their help page" });
    await expect(link).toHaveAttribute("href", "https://www.example.com/help/exports");
    const address = page.url();
    await link.click();
    await expect.poll(async () => (await mainCalls()).opened).toEqual(["https://www.example.com/help/exports"]);
    await link.click({ modifiers: ["Meta"] });
    await link.click({ button: "middle" });
    await expect.poll(async () => (await mainCalls()).opened.length).toBeGreaterThanOrEqual(2);
    expect(new Set((await mainCalls()).opened)).toEqual(new Set(["https://www.example.com/help/exports"]));
    expect(page.url()).toBe(address);
    expect(electronApp.windows()).toHaveLength(1);
    await expect(page.getByTestId("chat-name")).toHaveText("Pip");
  });

  test("a wide table and a long line of code scroll sideways inside the bubble without widening the chat", async ({ page, server, setWindowSize }) => {
    await setWindowSize(760, 520);
    const id = await openChat(page, server, "Atlas");
    await expectAtEnd(page);
    await expect(theirs(page).last()).toBeVisible();
    const columns = Array.from({ length: 9 }, (_, index) => `Column number ${index + 1}`);
    const table = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, `| ${columns.map((_, index) => `value ${index}`).join(" | ")} |`].join("\n");
    const code = "```ts\nconst everything = [" + Array.from({ length: 40 }, (_, index) => `"item-${index}"`).join(", ") + "];\n```";
    await server.control("deliver", { agent: id, text: `Here is the wide one:\n\n${table}\n\n${code}` });
    const reply = said(page, "Here is the wide one");
    await expect(reply.locator("table")).toBeVisible();
    const bubble = await box(reply.getByTestId("bubble"));
    for (const scroller of [reply.locator("table").locator(".."), reply.getByTestId("code-block").locator("pre")]) {
      const [scrollWidth, clientWidth, overflow] = await scroller.evaluate((element) => [element.scrollWidth, element.clientWidth, getComputedStyle(element).overflowX]);
      expect(overflow).toBe("auto");
      expect(scrollWidth).toBeGreaterThan(clientWidth);
      const own = await box(scroller);
      expect(own.right).toBeLessThanOrEqual(bubble.right + 1);
      await scroller.evaluate((element) => (element.scrollLeft = 120));
      expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(120);
    }
    expect(await timeline(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    const row = await box(reply);
    expect(bubble.right).toBeLessThanOrEqual(row.right + 1);
  });
});

test.describe("scrolling", () => {
  test("the chat opens at its newest message", async ({ page, server }) => {
    await openChat(page, server, "Atlas");
    await expect(theirs(page).last()).toBeVisible();
    await expectAtEnd(page);
    await expect(theirs(page).last()).toBeInViewport();
  });

  test("at the end, the chat stays there as replies, pictures and pages arrive", async ({ page, server }) => {
    const id = await openChat(page, server, "Atlas");
    await expectAtEnd(page);
    await server.control("deliver", { agent: id, text: "A short one." });
    await expect(said(page, "A short one.")).toBeInViewport();
    await expectAtEnd(page);
    await server.control("deliver", { agent: id, text: "Here's the view.", files: ["image"] });
    const picture = said(page, "Here's the view.").getByTestId("message-photos").locator("img");
    await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expectAtEnd(page);
    await server.control("deliver", { agent: id, text: "And the plan.", files: ["page"] });
    await expect(said(page, "And the plan.").getByTestId("message-page")).toBeVisible();
    await expect.poll(() => said(page, "And the plan.").getByTestId("page-frame").evaluate((frame) => frame.getBoundingClientRect().height)).not.toBe(160);
    await expectAtEnd(page);
    await sendFromApp(page, "Thanks!");
    await expect(said(page, "Any time.").last()).toBeInViewport();
    await expectAtEnd(page);
  });

  test("scrolled up, a new message offers Jump to latest and leaves the view where it was", async ({ page, server }) => {
    const id = await openChat(page, server, "Atlas");
    await expectAtEnd(page);
    await timeline(page).hover();
    await page.mouse.wheel(0, -1_500);
    await expect.poll(() => fromEnd(page)).toBeGreaterThan(1_000);
    // The row under the middle of the chat, and where it sits, once the scroll has settled.
    const settled = async () => {
      let last = -1;
      await expect.poll(async () => {
        const top = await timeline(page).evaluate((element) => element.scrollTop);
        const still = top === last;
        last = top;
        return still;
      }).toBe(true);
    };
    await settled();
    const anchor = await timeline(page).evaluate((element) => {
      const { left, width, top, height } = element.getBoundingClientRect();
      const row = document.elementFromPoint(left + width / 2, top + height / 2)?.closest<HTMLElement>("[data-message-id]");
      return row ? { id: row.dataset.messageId!, top: row.getBoundingClientRect().top } : null;
    });
    expect(anchor).not.toBeNull();
    expect(await jumpOffered(page)).toBe(false);
    await server.control("deliver", { agent: id, text: "Something new at the end." });
    await expect(said(page, "Something new at the end.")).toHaveCount(1);
    await expect.poll(() => jumpOffered(page)).toBe(true);
    const now = await page.locator(`[data-message-id="${anchor!.id}"]`).evaluate((row) => row.getBoundingClientRect().top);
    expect(Math.abs(now - anchor!.top)).toBeLessThanOrEqual(2);
    await expect(said(page, "Something new at the end.")).not.toBeInViewport();
    await page.getByTestId("jump-to-latest").click();
    await expectAtEnd(page);
    await expect(said(page, "Something new at the end.")).toBeInViewport();
    await expect.poll(() => jumpOffered(page)).toBe(false);
  });

  test("scrolling to the top loads older pages until the first message, keeping the place, and never loads a page twice", async ({ page, server }) => {
    test.setTimeout(90_000);
    const id = await agentId(server, "Atlas");
    const total = (await wholeChat(server, id)).length;
    // The pages before the newest, which the chat opens with.
    const older = Math.ceil((total - PAGE) / PAGE);
    // Each page the window asks for before the oldest message waits until the test lets it go, so the place on screen can be measured before and after.
    await page.evaluate(() => {
      const held = window as unknown as { pages: string[]; waiting: (() => void)[] };
      held.pages = [];
      held.waiting = [];
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.includes("before=")) return real(input, init);
        held.pages.push(new URL(url, location.href).searchParams.get("before")!);
        return new Promise<Response>((resolve) => held.waiting.push(() => resolve(real(input, init))));
      };
    });
    const asked = () => page.evaluate(() => (window as unknown as { pages: string[] }).pages);
    const release = () => page.evaluate(() => (window as unknown as { waiting: (() => void)[] }).waiting.splice(0).forEach((go) => go()));
    const rows = page.locator("[data-message-id]");

    await openChat(page, server, "Atlas");
    await expectAtEnd(page);
    let pages = 0;
    while (pages < older) {
      await timeline(page).hover();
      await page.mouse.wheel(0, -50_000);
      await expect.poll(async () => (await asked()).length).toBe(pages + 1);
      pages += 1;
      await expect.poll(() => timeline(page).evaluate((element) => element.scrollTop)).toBe(0);
      // The oldest row the window has, and where it sits, before the page above it comes.
      const anchor = await rows.first().evaluate((row) => ({ id: row.getAttribute("data-message-id")!, top: row.getBoundingClientRect().top }));
      await release();
      // The page has come once there is something above the row to scroll to.
      await expect.poll(() => timeline(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const top = await page.locator(`[data-message-id="${anchor.id}"]`).evaluate((row) => row.getBoundingClientRect().top);
      expect(Math.abs(top - anchor.top), `the place on screen after page ${pages}`).toBeLessThanOrEqual(3);
    }
    // At the beginning, the window may ask once more and hear there is nothing before, and then asks no more.
    await timeline(page).hover();
    await page.mouse.wheel(0, -50_000);
    await release();
    await expect(mine(page).filter({ hasText: ATLAS_FIRST })).toHaveCount(1);
    await page.mouse.wheel(0, -50_000);
    await release();
    const all = await asked();
    expect(new Set(all).size, `pages asked for: ${all.join(", ")}`).toBe(all.length);
    expect(all.length).toBeLessThanOrEqual(pages + 1);
    const shown = await rows.evaluateAll((each) => each.map((row) => row.getAttribute("data-message-id")));
    expect(new Set(shown).size).toBe(shown.length);
    expect(total).toBeGreaterThan(100);
  });

  test("leaving a chat and coming back opens it at its newest message", async ({ page, server }) => {
    await openChat(page, server, "Atlas");
    await expectAtEnd(page);
    await timeline(page).hover();
    await page.mouse.wheel(0, -2_000);
    await expect.poll(() => fromEnd(page)).toBeGreaterThan(1_000);
    await openChat(page, server, "Ledger");
    await expectAtEnd(page);
    await openChat(page, server, "Atlas");
    await expectAtEnd(page);
    await expect(theirs(page).last()).toBeInViewport();
  });
});

test.describe("read state and unread", () => {
  test("opening a chat with unread replies clears its count here and on the server", async ({ page, server }) => {
    const id = await agentId(server, "Ledger");
    expect((await agentOf(server, id)).unread).toBe(2);
    const row = page.getByTestId(`agent-${id}`);
    await expect(row.getByLabel("2 unread")).toBeVisible();
    await openChat(page, server, "Ledger");
    await expect(row.getByLabel(/unread/)).toHaveCount(0);
    await until(() => agentOf(server, id), (agent) => agent.unread === 0);
  });

  test("a reply arriving in the open chat does not count as unread", async ({ page, server }) => {
    const id = await openChat(page, server, "Pip");
    await sendFromApp(page, "Thanks!");
    await expect(said(page, "Any time.")).toBeVisible();
    await server.control("deliver", { agent: id, text: "By the way, the bins go out tonight." });
    await expect(said(page, "the bins go out tonight")).toBeVisible();
    await until(() => agentOf(server, id), (agent) => agent.unread === 0 && agent.latest?.body === "By the way, the bins go out tonight.");
    await expect(page.getByTestId(`agent-${id}`).getByLabel(/unread/)).toHaveCount(0);
  });

  test("a reply arriving in another chat counts as unread there", async ({ page, server }) => {
    const atlas = await agentId(server, "Atlas");
    await openChat(page, server, "Pip");
    await server.control("deliver", { agent: atlas, text: "The boiler engineer is running late." });
    await expect(page.getByTestId(`agent-${atlas}`).getByLabel("1 unread")).toBeVisible();
    expect((await agentOf(server, atlas)).unread).toBe(1);
  });
});

test.describe("messages arriving while the chat is open", () => {
  test("a message the agent sends by itself shows in an open chat that was empty", async ({ page, server }) => {
    const id = await openChat(page, server, "Pip");
    await expect(page.getByTestId("new-agent-hint")).toHaveText("Pip is new. Tell it what it's for.");
    await server.control("deliver", { agent: id, text: "Hello! I'm Pip. What should I look after for you?" });
    await expect(said(page, "Hello! I'm Pip.")).toBeVisible();
    await expect(page.getByTestId("new-agent-hint")).toHaveCount(0);
  });

  test("a message that arrives while the chat's first page is loading still shows", async ({ page, server }) => {
    const id = await agentId(server, "Atlas");
    // The chat's first page is answered by the server at once, and reaches the chat only once the test lets it.
    await page.evaluate((id) => {
      const held = window as unknown as { answered: boolean; waiting: (() => void)[] };
      held.answered = false;
      held.waiting = [];
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.endsWith(`/agents/${id}/messages`)) return real(input, init);
        const answer = real(input, init).then((response) => ((held.answered = true), response));
        return new Promise<Response>((resolve) => held.waiting.push(() => resolve(answer)));
      };
    }, id);
    await page.getByTestId(`agent-${id}`).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { answered: boolean }).answered)).toBe(true);
    await server.control("deliver", { agent: id, text: "The boiler engineer is on his way." });
    // The window has heard of the message: the sidebar shows it as Atlas's latest.
    await expect(page.getByTestId(`agent-${id}`)).toContainText("The boiler engineer is on his way.");
    await page.evaluate(() => (window as unknown as { waiting: (() => void)[] }).waiting.splice(0).forEach((go) => go()));
    await expect(theirs(page).nth(5)).toBeVisible();
    await expect(said(page, "The boiler engineer is on his way.")).toBeVisible();
  });
});

/** The seeded chats, by name, each in its agent's colour. */
const SEEDED = ["Atlas", "Ledger", "Scout", "Archive", "Patch", "Tidy", "Planner", "🏡 Home renovation & garden project coordinator 🌱", "Pip"];

/** The contrast of each kind of bubble's text on its bubble in the open chat, worked out from the colours as drawn. */
function contrasts(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true })!;
    /** A colour as red, green and blue, drawn over `under`, whatever syntax the style sheet wrote it in. */
    const rgb = (color: string, under: string) => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = under;
      paint.fillRect(0, 0, 1, 1);
      paint.fillStyle = color;
      paint.fillRect(0, 0, 1, 1);
      const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    };
    const luminance = (color: string) => {
      const [r, g, b] = color.match(/\d+/g)!.map(Number).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light + 0.05) / (dark + 0.05);
    };
    const canvasColor = getComputedStyle(document.querySelector('[data-testid="timeline"]')!).backgroundColor;
    const page = rgb(getComputedStyle(document.body).backgroundColor, "#fff");
    const ground = rgb(canvasColor, page);
    const of = (kind: string) => {
      const bubble = document.querySelector<HTMLElement>(`[data-testid="${kind}"] [data-testid="bubble"]`);
      const text = bubble?.querySelector<HTMLElement>("p");
      if (!bubble || !text) return null;
      const behind = rgb(getComputedStyle(bubble).backgroundColor, ground);
      return { ratio: ratio(rgb(getComputedStyle(text).color, behind), behind), bubble: behind, text: rgb(getComputedStyle(text).color, behind) };
    };
    return { mine: of("message-mine"), theirs: of("message-theirs") };
  });
}

test.describe("appearance", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const [width, height] of [
      [760, 520],
      [1800, 1100],
    ] as const) {
      test(`in ${scheme} at ${width}x${height}, bubbles keep to their column, the composer is whole and nothing scrolls sideways`, async ({ page, server, setColorScheme, setWindowSize }) => {
        await setColorScheme(scheme);
        await setWindowSize(width, height);
        for (const name of ["Atlas", "Ledger", "🏡 Home renovation & garden project coordinator 🌱", "Patch"]) {
          await openChat(page, server, name);
          await expect(page.getByTestId("bubble").first()).toBeVisible();
          const wide = await page.locator("[data-message-row]").evaluateAll((rows) =>
            rows.flatMap((row) => {
              const style = getComputedStyle(row);
              const room = row.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
              const bubble = row.querySelector('[data-testid="bubble"]');
              const width = bubble?.getBoundingClientRect().width ?? 0;
              return width > room * 0.85 + 1 ? [`${row.textContent?.slice(0, 40)}: ${width} of ${room}`] : [];
            }),
          );
          expect(wide, `${name}: bubbles wider than 85% of their column`).toEqual([]);
          const composer = await box(page.getByTestId("composer"));
          const window = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          expect(composer.top).toBeGreaterThanOrEqual(0);
          expect(composer.bottom).toBeLessThanOrEqual(window.height);
          expect(composer.right).toBeLessThanOrEqual(window.width);
          await expect(field(page)).toBeInViewport({ ratio: 1 });
          await expect(page.getByTestId("send")).toBeInViewport({ ratio: 1 });
          expect(await timeline(page).evaluate((element) => element.scrollWidth - element.clientWidth), `${name}: the chat scrolls sideways`).toBe(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        }
      });
    }

    test(`in ${scheme}, the text in both kinds of bubble has a contrast of at least 4.5:1 in every seeded chat`, async ({ page, server, setColorScheme }) => {
      test.setTimeout(90_000);
      await setColorScheme(scheme);
      // Archive is hidden, and its chat opens from the hidden agents under the list.
      const archive = await agentId(server, "Archive");
      await page.getByTestId("hidden-agents").click();
      await expect(page.getByTestId(`agent-${archive}`)).toBeVisible();
      const low: string[] = [];
      for (const name of SEEDED) {
        await openChat(page, server, name);
        if (name === "Pip") {
          await sendFromApp(page, "Hi Pip");
          await expect(said(page, "Hi Tester!")).toBeVisible();
        }
        await expect(mine(page).first()).toBeVisible();
        await expect(theirs(page).first()).toBeVisible();
        const measured = await contrasts(page);
        for (const kind of ["mine", "theirs"] as const) {
          const each = measured[kind];
          if (!each) low.push(`${name} ${kind}: no bubble with text`);
          else if (each.ratio < 4.5) low.push(`${name} ${kind}: ${each.ratio.toFixed(2)} (${each.text} on ${each.bubble})`);
        }
      }
      expect(low).toEqual([]);
    });
  }
});

