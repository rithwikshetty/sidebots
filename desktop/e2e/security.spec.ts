// What the app must never allow. A page an agent sends is untrusted: it is
// drawn in a sandboxed frame from a scheme of its own, and reaches neither
// the window, the API nor the network beyond images. The window holds no
// secret and no Node, asks the main process only for what `window.desktop`
// lists, and opens nothing outside itself but web pages the person chose.
// The design is docs/specs/2026-11-21-desktop-app.md; the rules are in
// src/main/protocol.ts, bridge.ts, links.ts and window.ts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Frame, Page } from "@playwright/test";
import { PAGE_POLICY } from "../src/main/protocol.ts";
import { expect, test } from "./fixtures.ts";
import { addAgent, agentNamed, chat, openChat, pageFrame, until } from "./panel-support.ts";

/** Sends a message from the composer of the open chat, as the person types it, with any files. */
async function sendFromComposer(page: Page, words: string, files: { name: string; mimeType: string; buffer: Buffer }[] = []): Promise<void> {
  if (files.length) await page.getByTestId("file-input").setInputFiles(files);
  await page.getByTestId("message-field").fill(words);
  await page.getByTestId("message-field").press("Enter");
}

/** Opens a chat whose agent has sent the page `asked` asks for, and resolves to the page's frame in the chat once it has loaded. */
async function chatWithPage(page: Page, server: import("./fixtures.ts").TestServer, asked = "/page"): Promise<Frame> {
  const agent = await addAgent(page, server, "Atlas");
  await openChat(page, agent.id);
  await sendFromComposer(page, asked);
  await expect(page.getByTestId("message-page")).toBeVisible({ timeout: 15_000 });
  return pageFrame(page);
}

/** Opens a chat whose agent has sent the page that tries to get out of its frame (scripted/files.ts), and resolves to its frame once it has loaded, marked so a document loaded in its place is told apart. */
async function hostilePage(page: Page, server: import("./fixtures.ts").TestServer): Promise<Frame> {
  const frame = await chatWithPage(page, server, "/page hostile");
  await frame.evaluate(() => void ((window as { mark?: number }).mark = 1));
  return frame;
}

/**
 * Checks that the window is where it was, ready and the only one, and that no
 * frame in it is at a web address. The page's frame holds the document it
 * was marked in, unless `refused`: a page that moves its own frame to a web
 * address is refused by the window's policy before anything loads, which
 * leaves the browser's empty page for a refused load in its place, as if the
 * page had emptied itself.
 */
async function stillInPlace(page: Page, frame: Frame, app: ElectronApplication, refused = false): Promise<void> {
  expect(page.url()).toBe("sidebots-desktop://app/");
  await expect(page.locator('[data-phase="ready"]')).toBeVisible();
  expect(app.windows()).toHaveLength(1);
  const elsewhere = page.frames().map((each) => each.url()).filter((url) => !url.startsWith("sidebots-desktop://app/") && !url.startsWith("sidebots-page://page/"));
  expect(elsewhere).toEqual(refused ? ["chrome-error://chromewebdata/"] : []);
  if (!refused) expect(await frame.evaluate(() => (window as { mark?: number }).mark)).toBe(1);
}

/**
 * An https server of the test's own on 127.0.0.1, with a certificate made for
 * it, that answers every request by sending it on to the address `to` gives
 * for its path. `asked` is the paths it has been asked for.
 */
async function redirectingServer(to: (path: string) => string): Promise<{ url: string; asked: string[]; close: () => Promise<void> }> {
  const folder = mkdtempSync(join(tmpdir(), "sidebots-e2e-https-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(folder, "key.pem"), "-out", join(folder, "cert.pem")], { stdio: "ignore" });
    const made = { key: readFileSync(join(folder, "key.pem")), cert: readFileSync(join(folder, "cert.pem")) };
    const state = { url: "", asked: [] as string[], close: async () => undefined as void };
    const listener = createHttpsServer(made, (request, response) => {
      state.asked.push(request.url ?? "");
      response.writeHead(302, { Location: to(request.url ?? "") }).end();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    state.url = `https://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    state.close = () => new Promise((resolve) => listener.close(() => resolve()));
    return state;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// How long a call of the test's into a page counts as a click of the person's in it, as Chromium keeps a click's activation.
const CLICK_LIFESPAN_MS = 5_500;

/** What the main process opened in the browser so far. */
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as { e2e?: { opened: string[] } }).e2e!.opened);

/** Fetches an address from the main process, through the app's own scheme handlers, as a frame's request reaches them. */
const fetchInMain = (app: ElectronApplication, url: string) =>
  app.evaluate(async ({ net }, address) => {
    const answer = await net.fetch(address);
    return { status: answer.status, text: await answer.text(), headers: Object.fromEntries(answer.headers) };
  }, url);

test.describe("inside an agent's page", () => {
  test("the page can't call the app's API, the server's port, or any site, and sends nothing out", async ({ page, server }) => {
    // A listener of the test's own on this computer, which counts anything the page manages to send it.
    const heard: string[] = [];
    const listener = createServer((request, response) => {
      heard.push(`${request.method} ${request.url}`);
      response.end("heard");
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    try {
      const frame = await chatWithPage(page, server);
      const results = await frame.evaluate(
        async ([port, outside]) => {
          const attempt = (url: string, init?: RequestInit) => fetch(url, init).then((answer) => `answered ${answer.status}`, (failure: Error) => `failed: ${failure.name}`);
          navigator.sendBeacon(`${outside}/beacon`, "x");
          new Image().src = `${outside}/image`;
          const socket = (() => {
            try {
              new WebSocket(`${outside.replace("http", "ws")}/socket`);
              return "made";
            } catch (failure) {
              return (failure as Error).name;
            }
          })();
          const form = document.createElement("form");
          form.action = `${outside}/form`;
          form.method = "post";
          document.body.append(form);
          form.submit();
          return {
            api: await attempt("sidebots-desktop://app/api/agents"),
            relative: await attempt("/api/agents"),
            port: await attempt(`http://127.0.0.1:${port}/agents`),
            listener: await attempt(`${outside}/fetch`, { mode: "no-cors" }),
            outside: await attempt("https://example.com/"),
            socket,
          };
        },
        [server.port, at] as const,
      );
      expect(results).toMatchObject({ api: "failed: TypeError", relative: "failed: TypeError", port: "failed: TypeError", listener: "failed: TypeError", outside: "failed: TypeError" });
      await page.waitForTimeout(1_000);
      expect(heard).toEqual([]);
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });

  test("the page can't read the window, its address, the storage or the cookies", async ({ page, server }) => {
    const frame = await chatWithPage(page, server);
    const results = await frame.evaluate(() => {
      const attempt = (read: () => unknown) => {
        try {
          return `read ${String(read())}`;
        } catch (failure) {
          return (failure as Error).name;
        }
      };
      return {
        parent: attempt(() => parent.document.title),
        top: attempt(() => top!.location.href),
        storage: attempt(() => localStorage.length),
        session: attempt(() => sessionStorage.length),
        cookie: attempt(() => document.cookie),
        desktop: attempt(() => (parent as unknown as { desktop: unknown }).desktop),
        origin: origin,
      };
    });
    expect(results).toEqual({ parent: "SecurityError", top: "SecurityError", storage: "SecurityError", session: "SecurityError", cookie: "SecurityError", desktop: "SecurityError", origin: "null" });
  });

  test("a page loads in the chat, and loads again when the system turns dark and when the panel's Reload is pressed", async ({ page, server, setColorScheme }) => {
    // The test starts in light, whichever the computer is set to.
    await setColorScheme("light");
    const frame = await chatWithPage(page, server);
    /** The page's frame in `holder` once a document of its own has loaded there, with the page's words and the scheme it was given. */
    const loaded = async (holder: ReturnType<Page["getByTestId"]>) => {
      const now = await holder.locator("iframe").elementHandle().then((handle) => handle?.contentFrame());
      return now
        ? now.evaluate(() => ({ fresh: (window as { mark?: number }).mark === undefined, words: document.body?.textContent?.includes("Three days") ?? false, scheme: getComputedStyle(document.documentElement).colorScheme })).catch(() => null)
        : null;
    };
    const message = page.getByTestId("message-page");
    await expect.poll(() => loaded(message)).toEqual({ fresh: true, words: true, scheme: "light" });
    await frame.evaluate(() => void ((window as { mark?: number }).mark = 1));
    await setColorScheme("dark");
    await expect.poll(() => loaded(message)).toEqual({ fresh: true, words: true, scheme: "dark" });

    await page.getByTestId("open-page").click();
    const panel = page.getByTestId("panel").getByTestId("page");
    await expect.poll(() => loaded(panel)).toEqual({ fresh: true, words: true, scheme: "dark" });
    const inPanel = await panel.locator("iframe").elementHandle().then((handle) => handle!.contentFrame());
    await inPanel!.evaluate(() => void ((window as { mark?: number }).mark = 1));
    await page.getByTestId("page-reload").click();
    await expect.poll(() => loaded(panel)).toEqual({ fresh: true, words: true, scheme: "dark" });
  });

  test("a click on a web link in the page opens it in the browser once, and the frame stays", async ({ page, server, electronApp }) => {
    const frame = await chatWithPage(page, server);
    const at = frame.url();
    await frame.evaluate(() => void ((window as { mark?: number }).mark = 1));
    await frame.getByRole("link", { name: "Parques de Sintra" }).click();
    await expect.poll(() => opened(electronApp)).toEqual(["https://www.parquesdesintra.pt/en/"]);
    await page.waitForTimeout(500);
    expect(await opened(electronApp)).toEqual(["https://www.parquesdesintra.pt/en/"]);
    expect(frame.url()).toBe(at);
    expect(await frame.evaluate(() => (window as { mark?: number }).mark)).toBe(1);
  });

  test("a click on a link that aims at a new window or at the window itself opens the link once, in the browser", async ({ page, server, electronApp }) => {
    const frame = await hostilePage(page, server);
    await frame.getByRole("link", { name: "Open in a new window" }).click();
    await frame.getByRole("link", { name: "Open over the window" }).click();
    await expect.poll(() => opened(electronApp)).toEqual(["https://example.com/new-window", "https://example.com/over-the-window"]);
    await stillInPlace(page, frame, electronApp);
  });

  for (const [what, tried, refused] of [
    ["moving itself to a site", "move", true],
    ["moving the window to a site", "window", false],
    ["clicking its own link", "click", true],
    ["clicking its links that aim at a new window and at the window", "targets", false],
    ["refreshing to a site", "refresh", true],
    ["opening windows", "open", false],
    ["sending a form", "submit", false],
  ] as const) {
    test(`a page ${what} opens nothing and reaches nothing`, async ({ page, server, electronApp }) => {
      const frame = await hostilePage(page, server);
      await frame.evaluate((name) => (window as unknown as { tries: Record<string, () => void> }).tries[name](), tried);
      await page.waitForTimeout(1_000);
      expect(await opened(electronApp)).toEqual([]);
      await stillInPlace(page, frame, electronApp, refused);
    });
  }

  test("a page that tries everything straight after the person clicks elsewhere in the window opens nothing and reaches nothing", async ({ page, server, electronApp }) => {
    const frame = await hostilePage(page, server);
    // The page waits a moment, then tries each thing at once, from a timer of its own.
    await frame.evaluate(() => {
      const { tries } = window as unknown as { tries: Record<string, () => void> };
      setTimeout(() => ["click", "targets", "open", "refresh", "submit", "window", "move"].forEach((name) => tries[name]()), 600);
    });
    await page.getByTestId("message-field").click();
    await page.waitForTimeout(1_600);
    expect(await opened(electronApp)).toEqual([]);
    await stillInPlace(page, frame, electronApp, true);
  });

  test("the page can't learn the token that asks the app to open a link", async ({ page, server, electronApp }) => {
    const frame = await hostilePage(page, server);
    const found = await frame.evaluate(async () => ({
      scripts: [...document.scripts].map((script) => script.textContent ?? "").filter((text) => /sidebots-page:|[0-9a-f]{32}/.test(text)),
      document: /sidebots-page:\/\/open|[0-9a-f]{32}/.test(document.documentElement.outerHTML),
      fetched: await fetch(location.href).then(
        () => "answered",
        () => "failed",
      ),
    }));
    expect(found).toEqual({ scripts: [], document: false, fetched: "failed" });
    // A real click asks the app to open the link, and the page's own listeners on its navigations hear nothing of it.
    await frame.getByRole("link", { name: "Open the guide" }).click();
    await expect.poll(() => opened(electronApp)).toEqual(["https://example.com/guide"]);
    expect(await frame.evaluate(() => (window as unknown as { heard: string[] }).heard)).toEqual([]);
  });

  test("a link to a place in the page itself scrolls the page within its frame", async ({ page, server, electronApp }) => {
    const frame = await hostilePage(page, server);
    const timeline = page.getByTestId("timeline");
    const before = await timeline.evaluate((element) => element.scrollTop);
    expect(await frame.evaluate(() => scrollY)).toBe(0);
    await frame.getByRole("link", { name: "Jump to the notes" }).click();
    await expect.poll(() => frame.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect(await frame.evaluate(() => location.hash)).toBe("#notes");
    expect(await timeline.evaluate((element) => element.scrollTop)).toBe(before);
    expect(await opened(electronApp)).toEqual([]);
  });

  test("a page that focuses its own link again and again can't take the keyboard from the composer", async ({ page, server }) => {
    const frame = await hostilePage(page, server);
    const field = page.getByTestId("message-field");
    await frame.evaluate(() => (window as unknown as { tries: Record<string, () => void> }).tries.focus());
    // The test's own call into the page counts as a click of the person's in it for a few seconds, so the page is left until that has passed.
    await page.waitForTimeout(CLICK_LIFESPAN_MS);
    await field.click();
    await page.keyboard.type("still mine", { delay: 30 });
    await expect(field).toHaveValue("still mine");
    expect(await frame.evaluate(() => document.activeElement?.id ?? "")).not.toBe("web");
  });

  test("a click on a file, javascript or custom-scheme link in the page opens nothing and runs nothing", async ({ page, server, electronApp }) => {
    const frame = await chatWithPage(page, server);
    const at = frame.url();
    // The page carries links of every other kind, as a page an agent writes could.
    await frame.evaluate(() => {
      const links = [
        ["file", "file:///etc/hosts"],
        ["script", "javascript:window.ran=1"],
        ["custom", "sidebots://pair?host=evil.example&code=x"],
        ["app", "sidebots-desktop://app/api/agents"],
        ["mail", "mailto:someone@example.com"],
        ["blank file", "file:///Applications/Calculator.app"],
      ];
      for (const [name, href] of links) {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = name;
        if (name === "blank file") link.target = "_blank";
        link.style.cssText = "display:block;font-size:20px;padding:4px";
        document.body.prepend(link);
      }
    });
    for (const name of ["file", "script", "custom", "app", "mail", "blank file"]) await frame.getByRole("link", { name, exact: true }).click();
    await page.waitForTimeout(500);
    expect(await opened(electronApp)).toEqual([]);
    expect(await frame.evaluate(() => (window as { ran?: number }).ran)).toBeUndefined();
    expect(frame.url()).toBe(at);
    expect(electronApp.windows()).toHaveLength(1);
  });

  test("the page is served with its content security policy and nosniff", async ({ page, server }) => {
    const answers: Promise<Record<string, string>>[] = [];
    page.on("response", (response) => void (response.url().startsWith("sidebots-page://") && answers.push(response.allHeaders())));
    await chatWithPage(page, server);
    await expect.poll(() => answers.length).toBeGreaterThan(0);
    const headers = await answers[0];
    expect(headers["content-security-policy"]).toBe(PAGE_POLICY);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  test("the page scheme refuses an attachment that isn't a page, and a path out of the attachments", async ({ page, server, electronApp }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/mixed");
    const sent = await until(
      () => chat(server, agent.id),
      (messages) => messages.some((message) => message.attachments.length === 3),
    ).then((messages) => messages.find((message) => message.attachments.length === 3)!.attachments);
    const pageFile = sent.find((path) => path.endsWith(".html"))!;
    const theme = "scheme=light&bg=%23ffffff&ink=%23000000&ink2=%23666666&line=%23dddddd&field=%23eeeeee&tint=%231f5fd6&link=%231f5fd6";
    const at = (path: string, query = theme) => `sidebots-page://page/${agent.id}/${path}?${query}`;
    // The page itself is served, so what follows is refused for what it asks, not because nothing is served.
    expect((await fetchInMain(electronApp, at(pageFile))).status).toBe(200);
    for (const path of sent.filter((each) => !each.endsWith(".html"))) {
      expect(await fetchInMain(electronApp, at(path))).toMatchObject({ status: 404, text: "Only a page an agent sent is here." });
    }
    expect((await fetchInMain(electronApp, at("..%2F..%2Fsidebots.sqlite%23.html"))).status).toBe(404);
    expect((await fetchInMain(electronApp, at(`attachments/..%2F${PAGE_POLICY.length}.html`))).status).toBe(404);
    expect((await fetchInMain(electronApp, at("../../desktop/pairing.json%3F.html"))).status).toBe(404);
    expect((await fetchInMain(electronApp, at(pageFile, ""))).status).toBe(400);
    expect((await fetchInMain(electronApp, at(pageFile, theme.replace("%23ffffff", "red;}body{display:none")))).status).toBe(400);
  });
});

test.describe("in the window itself", () => {
  test("the window has no Node: no require, no process, no module and no Buffer", async ({ page }) => {
    const found = await page.evaluate(() => ({
      require: typeof (window as { require?: unknown }).require,
      process: typeof (window as { process?: unknown }).process,
      module: typeof (window as { module?: unknown }).module,
      buffer: typeof (window as { Buffer?: unknown }).Buffer,
      global: typeof (window as { global?: unknown }).global,
      electron: typeof (window as { electron?: unknown }).electron,
      ipc: typeof (window as { ipcRenderer?: unknown }).ipcRenderer,
    }));
    expect(found).toEqual({ require: "undefined", process: "undefined", module: "undefined", buffer: "undefined", global: "undefined", electron: "undefined", ipc: "undefined" });
  });

  test("window.desktop offers only what bridge.ts lists", async ({ page }) => {
    const bridge = readFileSync(join(import.meta.dirname, "..", "src", "bridge.ts"), "utf8");
    const declared = /export type Desktop = \{([\s\S]*?)\n\};/.exec(bridge)![1];
    const listed = [...declared.matchAll(/^\s{2}(\w+)[(:]/gm)].map(([, name]) => name).sort();
    expect(listed).toContain("openExternal");
    const offered = await page.evaluate(() => Object.keys(window.desktop).sort());
    expect(offered).toEqual(listed);
    // What it offers can't be changed by the window's own scripts.
    const changed = await page.evaluate(() => {
      try {
        (window.desktop as unknown as Record<string, unknown>).openExternal = () => "replaced";
      } catch {
        // A frozen object refuses the change, which is as good.
      }
      return typeof (window.desktop.openExternal as unknown as () => unknown)() === "string";
    });
    expect(changed).toBe(false);
  });

  test("window.desktop.openExternal refuses anything but http and https", async ({ page, mainCalls }) => {
    const refused = [
      "file:///etc/hosts",
      "javascript:alert(1)",
      "sidebots://pair?host=evil.example&code=x",
      "sidebots-desktop://app/",
      "mailto:someone@example.com",
      "ftp://example.com/",
      "data:text/html,<script>alert(1)</script>",
      "/Applications/Calculator.app",
      "not a url",
      "",
    ];
    for (const url of refused) await page.evaluate((address) => window.desktop.openExternal(address), url);
    await page.evaluate(() => (window.desktop.openExternal as (url: unknown) => Promise<void>)(["https://example.com/array"]));
    await page.evaluate(() => window.desktop.openExternal("https://example.com/ok"));
    await page.evaluate(() => window.desktop.openExternal("http://example.com/also-ok"));
    expect((await mainCalls()).opened).toEqual(["https://example.com/ok", "http://example.com/also-ok"]);
  });

  test("window.open makes no window, and a file address opens nothing", async ({ page, electronApp, mainCalls }) => {
    const handed = await page.evaluate(() => [window.open("https://example.com/popup"), window.open("file:///etc/hosts"), window.open("about:blank")].map((each) => each === null));
    expect(handed).toEqual([true, true, true]);
    await page.waitForTimeout(500);
    expect(electronApp.windows()).toHaveLength(1);
    expect((await mainCalls()).opened.filter((url) => !url.startsWith("https://example.com/"))).toEqual([]);
  });

  test("the window can't be moved to another site or a file", async ({ page }) => {
    for (const address of ["https://example.com/away", "file:///etc/hosts", "sidebots-page://page/x/attachments/y.html"]) {
      await page.evaluate((to) => void (location.href = to), address);
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => [location.href, document.querySelector("[data-phase]")?.getAttribute("data-phase")])).toEqual(["sidebots-desktop://app/", "ready"]);
    }
  });

  test("the API can't be called from a frame of another origin, or from the window straight to the server, and the window's own calls go through beside them", async ({ page, server }) => {
    const frame = await chatWithPage(page, server);
    // The answers the API gave, by the frame that asked, which each asks for under a name of its own.
    const answers = new Map<string, Promise<{ status: number; text: string }>>();
    page.on("response", (response) => {
      const from = /\/api\/agents\?from=(\w+)$/.exec(response.url())?.[1];
      if (from) answers.set(from, response.text().then((text) => ({ status: response.status(), text }), () => ({ status: response.status(), text: "" })));
    });
    await page.evaluate(() => {
      const sandboxed = document.createElement("iframe");
      sandboxed.name = "sandboxed";
      sandboxed.sandbox.add("allow-scripts");
      sandboxed.srcdoc = "<p>written</p>";
      const data = document.createElement("iframe");
      data.name = "data";
      data.src = "data:text/html,<p>data</p>";
      document.body.append(sandboxed, data);
    });
    await expect.poll(() => page.frame({ name: "sandboxed" }) !== null).toBe(true);
    const sandboxed = page.frame({ name: "sandboxed" })!;
    await sandboxed.waitForLoadState();
    const ask = (from: string) => fetch(`sidebots-desktop://app/api/agents?from=${from}`).then((response) => `answered ${response.status}`, (failure: Error) => `failed: ${failure.name}`);
    const tried = { page: await frame.evaluate(ask, "page"), sandboxed: await sandboxed.evaluate(ask, "sandboxed") };
    expect(tried).toEqual({ page: "failed: TypeError", sandboxed: "failed: TypeError" });
    // The window's policy lets no data: document into a frame at all.
    const data = page.frame({ name: "data" });
    expect(data === null || !data.url().startsWith("data:") || (await data.evaluate(() => document.body?.textContent ?? "").catch(() => "")) !== "data").toBe(true);

    // The window's own call, made while it holds those frames, is answered.
    expect(await page.evaluate(ask, "window")).toBe("answered 200");
    await expect.poll(() => [...answers.keys()].sort()).toContain("window");
    for (const [from, answer] of answers) {
      if (from === "window") expect((await answer).status).toBe(200);
      else expect(await answer).toEqual({ status: 403, text: "Only the Sidebots window may call the server." });
    }
    const straight = await page.evaluate((port) => fetch(`http://127.0.0.1:${port}/agents`).then((response) => `answered ${response.status}`, () => "failed"), server.port);
    expect(straight).toBe("failed");
  });

  test("a frame an agent's page makes inside itself can't call the API either", async ({ page, server }) => {
    const frame = await chatWithPage(page, server);
    await frame.evaluate(() => {
      const inner = document.createElement("iframe");
      inner.name = "inner";
      document.body.append(inner);
    });
    await expect.poll(() => page.frame({ name: "inner" }) !== null).toBe(true);
    const inner = page.frame({ name: "inner" })!;
    await inner.waitForLoadState();
    const answer = await inner.evaluate(() => fetch("sidebots-desktop://app/api/agents").then((response) => `answered ${response.status}`, () => "failed"));
    expect(answer).toBe("failed");
  });

  test("the device key is nowhere the window can read: not its storage, its page, or any answer it gets", async ({ page, server }) => {
    const keys = JSON.parse(readFileSync(join(server.home, "desktop", "pairing.json"), "utf8")) as Record<string, string>;
    const key = keys[`127.0.0.1:${server.port}`];
    expect(key).toBeTruthy();
    const bodies: Promise<string>[] = [];
    page.on("response", (response) => void (!response.url().endsWith("/api/events") && bodies.push(response.text().catch(() => ""))));
    await page.reload();
    await page.locator('[data-phase="ready"]').waitFor();
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await page.getByTestId("settings-button").click();
    await page.getByTestId("settings-connections").click();
    await page.getByTestId("settings-phones").click();
    await expect(page.getByTestId("pair-phone")).toBeVisible();
    const seen = await page.evaluate(async (id) => {
      const read = await Promise.all(["/api/agents", "/api/avatars", "/api/usage", "/api/connections", `/api/agents/${id}/messages`, `/api/agents/${id}/about`].map((path) => fetch(path).then((response) => response.text())));
      const stored = Object.keys(localStorage).map((name) => `${name}=${localStorage.getItem(name)}`);
      const session = Object.keys(sessionStorage).map((name) => `${name}=${sessionStorage.getItem(name)}`);
      return [...read, ...stored, ...session, document.cookie, document.documentElement.outerHTML, JSON.stringify(Object.keys(window.desktop))];
    }, agent.id);
    const answered = await Promise.all(bodies);
    expect(answered.length).toBeGreaterThan(5);
    for (const text of [...seen, ...answered]) expect(text.includes(key)).toBe(false);
  });

  test("markdown from an agent can't run a script, load a frame, or follow a javascript link", async ({ page, server, electronApp }) => {
    const agent = await addAgent(page, server, "Atlas");
    const text = [
      "Here you go <script>window.pwned = 'script'</script>",
      "<img src=x onerror=\"window.pwned = 'image'\">",
      '<iframe src="https://example.com/framed"></iframe>',
      "[Tap here](javascript:window.pwned='link')",
      "![A picture](javascript:window.pwned='picture')",
      '<a href="javascript:window.pwned=\'raw link\'">raw link</a>',
    ].join("\n\n");
    await server.control("deliver", { agent: agent.id, text });
    await openChat(page, agent.id);
    const drawn = page.getByTestId("message-theirs").getByTestId("markdown");
    await expect(drawn).toContainText("<script>window.pwned = 'script'</script>");
    await expect(drawn).toContainText("<iframe");
    expect(await drawn.locator("script, iframe, img, object, embed").count()).toBe(0);
    // A link that isn't to a web page shows as its words alone, which a click does nothing with.
    expect(await drawn.locator("a").count()).toBe(0);
    await drawn.getByText("Tap here").click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as { pwned?: string }).pwned)).toBeUndefined();
    expect(await opened(electronApp)).toEqual([]);
    expect(page.frames()).toHaveLength(1);
  });

  test("a markdown picture or link at the app's own addresses loads nothing and opens nothing, and the chat keeps hearing from the computer", async ({ page, server, electronApp }) => {
    const agent = await addAgent(page, server, "Atlas");
    const asked: string[] = [];
    page.on("request", (request) => void (request.url().startsWith("sidebots-desktop://app/api/") && asked.push(request.url())));
    await openChat(page, agent.id);
    await server.control("deliver", { agent: agent.id, text: "![The stream](/api/events)\n\n![The agents](sidebots-desktop://app/api/agents)\n\n[Run it](javascript:window.pwned=1) and [the app](sidebots-desktop://app/api/agents)" });
    const drawn = page.getByTestId("message-theirs").getByTestId("markdown");
    await expect(drawn).toContainText("The stream");
    expect(await drawn.locator("img, a").count()).toBe(0);
    await drawn.getByText("Run it").click();
    await drawn.getByText("the app").click();
    await page.waitForTimeout(300);
    expect(asked.filter((url) => /\/api\/(events|agents)$/.test(url))).toEqual([]);
    expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();
    expect(await opened(electronApp)).toEqual([]);
    // The event stream still flows: a message the agent sends next arrives in the open chat by itself.
    await server.control("deliver", { agent: agent.id, text: "Still here." });
    await expect(page.getByTestId("message-theirs").filter({ hasText: "Still here." })).toBeVisible();
  });

  test("a markdown picture whose server sends it on to the app's API doesn't reach the API, however the address is spelled, and the chat keeps hearing from the computer", async ({ page, server, electronApp }) => {
    // Each of these a browser reads as the window's own origin.
    const spelled = ["sidebots-desktop://app/api/events", "Sidebots-Desktop://APP/api/events", "sidebots-desktop:/app/api/events", "sidebots-desktop:\\\\app\\api\\events", "sidebots-desktop://someone@app/api/events"];
    const redirect = await redirectingServer((path) => spelled[Number(path.slice("/chart-".length, -".png".length))]);
    try {
      // The app takes the test's own certificate for 127.0.0.1, as it takes a site's that a real authority signed.
      await electronApp.evaluate(({ session }) => session.defaultSession.setCertificateVerifyProc((_request, verified) => verified(0)));
      const agent = await addAgent(page, server, "Atlas");
      await openChat(page, agent.id);
      const reached: { url: string; status: number }[] = [];
      page.on("requestfinished", (request) => void (request.url().startsWith("sidebots-desktop://app/api/events") && request.redirectedFrom() && request.response().then((response) => reached.push({ url: request.url(), status: response?.status() ?? 0 }))));
      page.on("requestfailed", (request) => void (request.url().startsWith("sidebots-desktop://app/api/events") && request.redirectedFrom() && reached.push({ url: request.url(), status: 0 })));
      await server.control("deliver", { agent: agent.id, text: spelled.map((_, index) => `![A chart](${redirect.url}/chart-${index}.png)`).join("\n\n") });
      await expect(page.getByTestId("message-theirs").getByTestId("markdown").locator("img")).toHaveCount(spelled.length);
      await expect.poll(() => [...new Set(redirect.asked)].sort()).toEqual(spelled.map((_, index) => `/chart-${index}.png`));
      await page.waitForTimeout(500);
      expect(reached.filter(({ status }) => status === 200)).toEqual([]);
      await server.control("deliver", { agent: agent.id, text: "Still here." });
      await expect(page.getByTestId("message-theirs").filter({ hasText: "Still here." })).toBeVisible({ timeout: 3_000 });
      expect(await opened(electronApp)).toEqual([]);
    } finally {
      await redirect.close();
    }
  });

  test("a file name with HTML or path parts in it shows as text, the agent's echo of it too", async ({ page, server }) => {
    const agent = await addAgent(page, server, "Atlas");
    const names = ["<img src=x onerror=alert(1)>.txt", "../../<b>bold</b>/../../etc/passwd.txt"];
    await server.say(agent.id, "/echo-files", names.map((name) => new File(["hello"], name, { type: "text/plain" })));
    const reply = await until(() => chat(server, agent.id), (messages) => messages.some((message) => message.body.startsWith("You sent me")));
    const stored = reply.find((message) => message.sender === "person")!.attachments;
    expect(stored).toHaveLength(2);
    for (const path of stored) expect(path).toMatch(/^attachments\/[0-9a-f]{8}-[\w.-]+$/);
    await openChat(page, agent.id);
    const cards = page.getByTestId("message-file");
    await expect(cards).toHaveCount(2);
    for (const path of stored) await expect(cards.filter({ hasText: path.replace(/^attachments\/[0-9a-f]{8}-/, "") })).toHaveCount(1);
    await expect(page.getByTestId("message-theirs").last()).toContainText("You sent me 2 files");
    expect(await page.locator('[data-testid="timeline"] img[onerror], [data-testid="timeline"] img[src="x"], [data-testid="timeline"] b').count()).toBe(0);
  });

  test("a file that is a program is never opened by a click, only shown in its folder", async ({ page, server, mainCalls }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    const programs = ["run.command", "Tool.app.zip", "setup.sh", "Install.pkg", "macro.docm"];
    await sendFromComposer(
      page,
      "",
      programs.map((name) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from("#!/bin/sh\necho hi\n") })),
    );
    const cards = page.getByTestId("message-file");
    await expect(cards).toHaveCount(programs.length);
    for (const name of programs) {
      await cards.filter({ hasText: name }).click();
      await expect.poll(async () => (await mainCalls()).shown.some((path) => path.endsWith(`-${name}`) || path.endsWith(`/${name}`))).toBe(true);
    }
    const calls = await mainCalls();
    expect(calls.files).toEqual([]);
    expect(calls.opened).toEqual([]);
    expect(calls.shown).toHaveLength(programs.length);
  });

  test("a document a click opens goes to the computer's own app, not to its folder", async ({ page, server, mainCalls }) => {
    const agent = await addAgent(page, server, "Atlas");
    await openChat(page, agent.id);
    await sendFromComposer(page, "/files");
    const cards = page.getByTestId("message-theirs").getByTestId("message-file");
    await expect(cards).toHaveCount(4, { timeout: 15_000 });
    await cards.filter({ hasText: ".pdf" }).click();
    await expect.poll(async () => (await mainCalls()).files).toEqual([expect.stringMatching(/\.pdf$/)]);
    // The zip could hold a program, so it is shown in its folder.
    await cards.filter({ hasText: ".zip" }).click();
    await expect.poll(async () => (await mainCalls()).shown).toEqual([expect.stringMatching(/\.zip$/)]);
    void (await agentNamed(server, "Atlas"));
  });
});
