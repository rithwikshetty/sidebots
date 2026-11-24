// The packaged app against the scripted server, through the fixtures: it
// pairs itself, gets ready and lists the seeded agents, and the fixtures'
// helpers act on it.

import { expect, test } from "./fixtures.ts";

test.describe("against the seeded world", () => {
  test.use({ world: "seeded" });

  test("the app pairs itself, gets ready and lists the seeded agents", async ({ page, server }) => {
    for (const name of ["Atlas", "Ledger", "Scout", "Patch", "Tidy", "Planner", "Pip", "🏡 Home renovation & garden project coordinator 🌱"]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    const devices = JSON.parse(await server.cli("devices", "--json")) as { kind: string }[];
    expect(devices.filter((device) => device.kind === "desktop")).toHaveLength(1);
  });

  test("the helpers set the colours and the size, and open the app again", async ({ page, setColorScheme, setWindowSize, restartApp }) => {
    await setColorScheme("dark");
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
    await setColorScheme("light");
    await setWindowSize(760, 520);
    expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([760, 520]);
    const again = await restartApp();
    await expect(again.page.getByText("Atlas", { exact: true })).toBeVisible();
  });

  test("the computer's own pointer, coming over the window, doesn't end a drag the test is making", async ({ page, electronApp }) => {
    /** Puts the window where the computer's pointer, wherever it rests, lies at `x`, `y` of what the window shows. */
    const underPointer = (x: number, y: number) =>
      electronApp.evaluate(({ screen, BrowserWindow }, [atX, atY]) => {
        const window = BrowserWindow.getAllWindows()[0];
        const pointer = screen.getCursorScreenPoint();
        const [content, frame] = [window.getContentBounds(), window.getBounds()];
        window.setPosition(pointer.x - atX - (content.x - frame.x), pointer.y - atY - (content.y - frame.y));
      }, [x, y] as const);
    // The pointer starts outside the window, and the main process counts each move it hears of with no button down.
    await underPointer(-200, -200);
    await electronApp.evaluate(({ BrowserWindow }) => {
      const heard = globalThis as { strays?: number };
      heard.strays = 0;
      BrowserWindow.getAllWindows()[0].webContents.on("before-mouse-event", (_event, mouse) => {
        if (mouse.type === "mouseMove" && (mouse.button as string) === "none") heard.strays! += 1;
      });
    });
    const strays = () => electronApp.evaluate(() => (globalThis as { strays?: number }).strays!);

    const edge = page.getByRole("separator", { name: "Sidebar width" });
    const at = (await edge.boundingBox())!;
    const [x, y] = [at.x + at.width / 2, at.y + at.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y, { steps: 4 });
    await expect(edge).toHaveAttribute("aria-valuenow", "310");
    const before = await strays();
    // The window comes to lie under the pointer, which tells the window of itself though the window ignores it.
    await underPointer(40, 300);
    const told = await expect.poll(strays, { timeout: 3_000 }).toBeGreaterThan(before).then(() => true, () => false);
    test.skip(!told, "The computer's pointer didn't tell the window of itself, as when its screen is off.");
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.mouse.up();
    await expect(edge).toHaveAttribute("aria-valuenow", "340");
    expect(await page.evaluate(() => "resizing" in document.documentElement.dataset)).toBe(false);
  });

  test("a sign-in the app starts is recorded, not opened, and finishSignIn brings it back", async ({ page, server, mainCalls, finishSignIn }) => {
    const { url, redirect } = (await (await server.api("/connections/calendar/sign-in", { method: "POST" })).json()) as { url: string; redirect: string };
    const returned = page.evaluate(([url, redirect]) => window.desktop.signIn(url, redirect), [url, redirect] as const);
    await expect.poll(async () => (await mainCalls()).opened).toEqual([url]);
    await finishSignIn();
    const address = await returned;
    expect(address).toMatch(new RegExp(`^${redirect.replace(/[.]/g, "\\.")}\\?state=`));
    const made = await server.api("/connections/calendar", { method: "PUT", body: JSON.stringify({ url: address }) });
    expect(((await made.json()) as { account: string }).account).toBe("tester@example.com");
  });

  test("a server on another version of the contract says which side to update", async ({ page, server }) => {
    await server.control("contract", { version: "older" });
    await expect(page.getByRole("heading", { name: "Update Sidebots on this computer" })).toBeVisible({ timeout: 20_000 });
    await server.control("contract", { version: null });
  });
});
