// Screenshots of the packaged app for review, in light and dark, at the
// sizes each scene asks for.
//
//   node e2e/shots.ts --out <dir> [--scene <name> ...]
//
// It starts the scripted server on the seeded world, opens the packaged app
// (`E2E=1 pnpm package` builds it) and, for each scene, each size and light
// then dark, sets the window, runs the scene and saves
// `<scene>-<width>x<height>-<light|dark>.png` in the folder. `--scene` picks
// scenes by name; without it, every scene is taken.
//
// A scene is an entry in SCENES below: a name, the sizes it is seen at when
// not the usual 1280 by 800, and `run`, which gets the window to the state
// to look at. Before each run the window is loaded afresh and ready, so a
// scene starts from the app as it opens. `helpers.server` is the seeded
// server, with `api` and `control` as the fixtures have them. For example:
//
//   {
//     name: "chat-with-atlas",
//     sizes: [[1280, 800], [760, 520]],
//     run: async (page) => {
//       await page.getByText("Atlas", { exact: true }).click();
//     },
//   },
//
// The app's build folder is shared, so take the lock around a run, as
// playwright.config.ts says.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ElectronApplication, Page } from "@playwright/test";
import { closeApp, firstPage, launchApp, setColorScheme, setWindowSize } from "./launch.ts";
import { control, freePort, phone, startServer } from "./server.ts";

/** What a scene can use besides the window. */
export type Helpers = {
  app: ElectronApplication;
  scheme: "light" | "dark";
  size: [width: number, height: number];
  server: { url: string; api(path: string, init?: RequestInit): Promise<Response>; control<T = unknown>(path: string, body?: unknown): Promise<T> };
};
export type Scene = { name: string; sizes?: [width: number, height: number][]; run(page: Page, helpers: Helpers): Promise<void> };

export const SCENES: Scene[] = [
  {
    name: "opens",
    run: async () => undefined,
  },
];

const SIZES: [number, number][] = [[1280, 800]];

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" }, scene: { type: "string", multiple: true } } });
  if (!values.out) {
    console.error("usage: node e2e/shots.ts --out <dir> [--scene <name> ...]");
    process.exit(1);
  }
  const scenes = values.scene ? SCENES.filter((scene) => values.scene!.includes(scene.name)) : SCENES;
  const unknown = (values.scene ?? []).filter((name) => !SCENES.some((scene) => scene.name === name));
  if (unknown.length) {
    console.error(`No scene called ${unknown.join(", ")}. The scenes: ${SCENES.map((scene) => scene.name).join(", ")}.`);
    process.exit(1);
  }
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });

  const home = mkdtempSync(join(tmpdir(), "sidebots-shots-"));
  const port = await freePort();
  const server = await startServer({ home, port, world: "seeded" });
  let app: ElectronApplication | undefined;
  try {
    const helpers = { url: server.url, api: phone({ home, port }), control: <T>(path: string, body?: unknown) => control<T>(port, path, body) };
    app = await launchApp({ home, port });
    const page = await firstPage(app);
    for (const scene of scenes) {
      for (const size of scene.sizes ?? SIZES) {
        for (const scheme of ["light", "dark"] as const) {
          await page.reload();
          await page.locator('[data-phase="ready"]').waitFor({ timeout: 30_000 });
          await setWindowSize(app, page, ...size);
          await setColorScheme(app, page, scheme);
          await scene.run(page, { app, scheme, size, server: helpers });
          // Lets what the scene started, such as a transition or an image, finish drawing.
          await page.waitForTimeout(300);
          const file = join(out, `${scene.name}-${size[0]}x${size[1]}-${scheme}.png`);
          await page.screenshot({ path: file });
          console.log(file);
        }
      }
    }
  } finally {
    if (app) await closeApp(app);
    await server.stop();
    rmSync(home, { recursive: true, force: true });
  }
}
