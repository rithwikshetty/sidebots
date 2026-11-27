// The Playwright fixtures every test in e2e is written on. Each test gets a
// home and a port of its own, the scripted server (server.ts) running in a
// process of its own, and, when it asks for `page` or `electronApp`, the
// packaged app opened against that server. All of it is stopped and deleted
// once the test ends, whether it passed or not.
//
//   import { expect, test } from "./fixtures.ts";
//
//   test.use({ world: "seeded" });
//   test("the seeded agents are listed", async ({ page }) => {
//     await expect(page.getByText("Atlas")).toBeVisible();
//   });
//
// Options, set with `test.use`: `world` is "seeded", "empty" (Tester, no
// agents; the default) or "nobody"; `serverStarted: false` leaves the server
// unstarted, for a test of the app with no server; `ready: false` hands over
// `page` without waiting for `data-phase="ready"`; `pause` is how long a
// plain reply takes, in milliseconds; `welcome` opens the app as the menu bar
// app does when setup ends for someone new.
//
// The packaged app's build folder is shared, so take the lock around a run
// that opens the app, as playwright.config.ts says. Tests that use only
// `server` open no app and need no lock.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, type ElectronApplication, type Page } from "@playwright/test";
import { closeApp, finishSignIn, firstPage, launchApp, mainCalls, setColorScheme, setWindowSize, type MainCalls } from "./launch.ts";
import { control, freePort, phone, serverCommand, startServer, type Started, type World } from "./server.ts";

export { expect } from "@playwright/test";

/** The scripted server a test runs against, and what the test can do with it. */
export type TestServer = {
  home: string;
  port: number;
  url: string;
  /** Calls the API as a phone of Tester's, paired through the server's own `pair` command the first time. */
  api(path: string, init?: RequestInit): Promise<Response>;
  /** Sends a message to an agent as that phone, with any files, and resolves to the message. */
  say(agentId: string, body: string, files?: File[]): Promise<{ id: string; status: string; attachments: string[] }>;
  /** Uses one of the test controls, `/__test/<path>`, with a JSON body, and resolves to its answer. */
  control<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Runs one of the server's own commands against the test's home and port, and resolves to what it printed. */
  cli(...args: string[]): Promise<string>;
  /** Stops the server. */
  stop(): Promise<void>;
  /** Stops the server if it runs, and starts it again on the same home and port. */
  restart(): Promise<void>;
  /** Everything the server has printed since it last started. */
  output(): string;
};

type Options = { world: World; serverStarted: boolean; ready: boolean; pause: number; welcome: boolean };
type Fixtures = {
  home: string;
  server: TestServer;
  /** The packaged app, opened against the test's server. */
  electronApp: ElectronApplication;
  /** The app's window. */
  page: Page;
  setColorScheme(scheme: "dark" | "light"): Promise<void>;
  setWindowSize(width: number, height: number): Promise<void>;
  /** Closes the app and opens it again on the same home, and resolves to the new app and its window, which the helpers act on from then. */
  restartApp(): Promise<{ electronApp: ElectronApplication; page: Page }>;
  /** What the main process was asked to do outside the window: links, files, saves, notifications and the badge. */
  mainCalls(): Promise<MainCalls>;
  /** Finishes the sign-in the app last opened, as if the person signed in. */
  finishSignIn(): Promise<void>;
};

/** The app as it is now in a test, which `restartApp` replaces. */
type Current = { app?: ElectronApplication; page?: Page };

export const test = base.extend<Fixtures & Options & { current: Current }>({
  world: ["empty", { option: true }],
  serverStarted: [true, { option: true }],
  ready: [true, { option: true }],
  pause: [150, { option: true }],
  welcome: [false, { option: true }],

  home: async ({}, use) => {
    const home = mkdtempSync(join(tmpdir(), "sidebots-e2e-"));
    await use(home);
    rmSync(home, { recursive: true, force: true });
  },

  server: async ({ home, world, serverStarted, pause }, use, testInfo) => {
    const port = await freePort();
    let started: Started | undefined;
    const start = async () => void (started = await startServer({ home, port, world, pause }));
    const api = phone({ home, port });
    const server: TestServer = {
      home,
      port,
      url: `http://127.0.0.1:${port}`,
      api,
      async say(agentId, body, files = []) {
        const form = new FormData();
        form.append("body", body);
        for (const file of files) form.append("files", file);
        const answer = await api(`/agents/${agentId}/messages`, { method: "POST", body: form });
        if (!answer.ok) throw new Error(`Sending a message answered ${answer.status}: ${await answer.text()}`);
        return answer.json();
      },
      control: (path, body) => control(port, path, body),
      cli: (...args) => serverCommand(home, port, args),
      stop: async () => {
        await started?.stop();
        started = undefined;
      },
      async restart() {
        await server.stop();
        await start();
      },
      output: () => started?.output() ?? "",
    };
    if (serverStarted) await start();
    await use(server);
    // What the server printed goes with a failed test's report, which is where a server that ended early says why.
    if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach("server output", { body: `${server.output()}\nexit: ${started?.process.exitCode ?? started?.process.signalCode ?? "running"}`, contentType: "text/plain" });
    await server.stop();
  },

  current: async ({}, use) => {
    const current: Current = {};
    await use(current);
    if (current.app) await closeApp(current.app);
  },

  electronApp: async ({ server, current, welcome }, use) => {
    current.app = await launchApp({ home: server.home, port: server.port, welcome });
    await use(current.app);
  },

  page: async ({ electronApp, ready, current }, use) => {
    current.page = await firstPage(electronApp, ready);
    await use(current.page);
  },

  setColorScheme: async ({ current }, use) => {
    await use((scheme) => setColorScheme(current.app!, current.page!, scheme));
  },

  setWindowSize: async ({ current }, use) => {
    await use((width, height) => setWindowSize(current.app!, current.page!, width, height));
  },

  restartApp: async ({ server, ready, current }, use) => {
    await use(async () => {
      if (current.app) await closeApp(current.app);
      current.app = await launchApp({ home: server.home, port: server.port });
      current.page = await firstPage(current.app, ready);
      return { electronApp: current.app, page: current.page };
    });
  },

  mainCalls: async ({ current }, use) => {
    await use(() => mainCalls(current.app!));
  },

  finishSignIn: async ({ current }, use) => {
    await use(() => finishSignIn(current.app!));
  },
});
