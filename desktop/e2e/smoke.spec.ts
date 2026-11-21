// Opens the packaged app with no server on its port, and looks for its window.

import { expect, test } from "./fixtures.ts";

// The test's own home and port, with nothing listening there, and a copy of the app inside no menu bar app that could start a server.
test.use({ serverStarted: false, ready: false });

test("the packaged app opens its window and says where it stands with the server", async ({ page }) => {
  await expect(page.locator("[data-phase]")).toBeVisible();
  expect(await page.evaluate(() => window.desktop.platform)).toBe(process.platform);
  await expect(page.getByText("Sidebots isn't running on this computer.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
