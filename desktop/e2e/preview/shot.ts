// A screenshot of the browser preview, or any page, from the command line,
// with Playwright's Chromium (once: `npx playwright install chromium`).
//
//   node e2e/preview/shot.ts --url <url> --out <png> [--width 1280] [--height 800] [--dark] [--scale 2]
//                            [--click <selector>] [--type "<selector>=<text>"] [--press <key>]
//                            [--wait-for <selector>] [--wait <ms>]
//
// The steps, `--click`, `--type`, `--press`, `--wait-for` and `--wait`, run
// in the order given and can be given more than once, so a state is reached
// as a person would reach it:
//
//   node e2e/preview/shot.ts --url http://localhost:5199/ --out atlas.png \
//     --click "text=Atlas" --type "textarea=/images 3" --press Enter --wait 2000
//
// A selector is Playwright's: CSS, or `text=...`, or `role=button[name="Send"]`.
// In `--type`, the text is what follows the last `=`.
// It waits for the window's `data-phase` to show before the steps, when the
// page has one, and half a second after the last.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values, tokens } = parseArgs({
  options: {
    url: { type: "string" },
    out: { type: "string" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "800" },
    dark: { type: "boolean" },
    scale: { type: "string", default: "1" },
    click: { type: "string", multiple: true },
    type: { type: "string", multiple: true },
    press: { type: "string", multiple: true },
    "wait-for": { type: "string", multiple: true },
    wait: { type: "string", multiple: true },
  },
  tokens: true,
});
if (!values.url || !values.out) {
  console.error('usage: node e2e/preview/shot.ts --url <url> --out <png> [--width --height --dark --scale] [--click <selector>] [--type "<selector>=<text>"] [--press <key>] [--wait-for <selector>] [--wait <ms>]');
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: Number(values.width), height: Number(values.height) }, deviceScaleFactor: Number(values.scale), colorScheme: values.dark ? "dark" : "light" });
  const page = await context.newPage();
  page.on("console", (message) => message.type() === "error" && console.error(`[page] ${message.text()}`));
  page.on("pageerror", (failure) => console.error(`[page] ${failure.message}`));
  await page.goto(values.url);
  await page.locator("[data-phase]").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  for (const token of tokens) {
    if (token.kind !== "option" || token.value === undefined) continue;
    if (token.name === "click") await page.locator(token.value).first().click();
    if (token.name === "press") await page.keyboard.press(token.value);
    if (token.name === "wait-for") await page.locator(token.value).first().waitFor();
    if (token.name === "wait") await page.waitForTimeout(Number(token.value));
    if (token.name === "type") {
      const at = token.value.lastIndexOf("=");
      await page.locator(token.value.slice(0, at)).first().fill(token.value.slice(at + 1));
    }
  }
  await page.waitForTimeout(500);
  const out = resolve(values.out);
  await page.screenshot({ path: out });
  console.log(out);
} finally {
  await browser.close();
}
