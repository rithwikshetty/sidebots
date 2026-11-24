// The packaged app against the scripted server, through the fixtures: it
// pairs itself, gets ready and lists the seeded agents, the fixtures'
// helpers act on it, and the computer's own pointer can't end a drag a test
// is making (unseen.ts).

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

  test("a move with no button down, as the computer's own pointer makes over the window, doesn't end a drag the test is making", async ({ page }) => {
    const pointer = await page.context().newCDPSession(page);
    const edge = page.getByRole("separator", { name: "Sidebar width" });
    const at = (await edge.boundingBox())!;
    const [x, y] = [at.x + at.width / 2, at.y + at.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y, { steps: 4 });
    await expect(edge).toHaveAttribute("aria-valuenow", "310");
    // The move is answered for only once the page has taken it, which it never does, so the test doesn't wait for the answer.
    void pointer.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: 300, button: "none", buttons: 0 }).catch(() => undefined);
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.mouse.up();
    await expect(edge).toHaveAttribute("aria-valuenow", "340");
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
