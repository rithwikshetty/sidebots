// The desktop window in a plain browser, against the scripted server, for
// building screens without packaging and opening Electron.
//
//   node e2e/preview/serve.ts --port <vite port> [--seed | --nobody]
//
// It starts the scripted server (e2e/server.ts) on a free port and a home of
// its own, pairs a device for itself through the server's own `pair`
// command, and serves src/renderer with Vite, on vite.renderer.config.ts:
//
// - `/api/...` goes to the server with the device's key, as the main process
//   passes it on. Answers stream, so the event stream works.
// - `window.desktop` is preview/desktop.ts, which answers as the main process
//   would and records the rest on `window.__desktopCalls`.
// - A page an agent sent, `sidebots-page://page/<agent>/<file>`, is at
//   `/__page/<agent>/<file>` here: desktop.ts points the frame there, and the
//   main process's own handler (src/main/protocol.ts) answers it, dressed in
//   the chat's colours, with its policy and its height message aimed at this
//   origin in place of the app's. A link the person clicks in it moves the
//   frame to `/__open/<token>?to=<link>` here, in place of
//   `sidebots-page://open/...`: the handler reads the link as the main
//   process does, the frame stays where it was, and desktop.ts records the
//   link as opened.
// - `/__test/...` are the scripted server's test controls, so they can be
//   used from the browser's console.
//
// The server stops, and the home is deleted, when the script is stopped.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createServer, type Plugin } from "vite";
import { CONTRACT_HEADER, CONTRACT_VERSION } from "../../../server/src/contract.ts";
import { isWeb } from "../../src/main/links.ts";
import { APP_ORIGIN, OPEN_ORIGIN, createHandlers } from "../../src/main/protocol.ts";
import { DESKTOP, freePort, pairDevice, serverCommand, startServer, type Started } from "../server.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "5199" }, seed: { type: "boolean" }, nobody: { type: "boolean" } } });
const vitePort = Number(values.port);
const origin = `http://localhost:${vitePort}`;

const home = mkdtempSync(join(tmpdir(), "sidebots-preview-"));
// The scripted server ends with this process, and the home goes with them, however the preview is stopped.
let started: Started | undefined;
process.on("exit", () => {
  started?.process.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
const port = await freePort();
const server = (started = await startServer({ home, port, world: values.seed ? "seeded" : values.nobody ? "nobody" : "empty" }));
const status = () => serverCommand(home, port, ["status", "--json"]).then((printed) => JSON.parse(printed) as { address: string | null; people: { name: string }[] });
const person = (await status()).people[0]?.name;
const key = person ? await pairDevice({ home, port, person, name: "Browser preview", kind: "desktop" }) : undefined;
const pages = createHandlers({ port, key: () => key, fetch: (url, init) => fetch(url, init), files: "", trouble: () => undefined });
const { version } = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as { version: string };

/** Answers with JSON. */
function answer(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

/** A request's body, read as JSON. */
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

/** What desktop.ts asks of the server's commands, answered as src/main/bridge.ts answers it. */
async function preview(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  try {
    if (path === "phones") {
      const devices = JSON.parse(await serverCommand(home, port, ["devices", "--json"])) as { id: string; name: string; kind: string; paired_at: number }[];
      return answer(response, devices.filter((device) => device.kind === "phone").map(({ id, name, paired_at }) => ({ id, name, pairedAt: paired_at })));
    }
    if (path === "pair-phone") {
      const now = await status();
      if (!now.address) return answer(response, { error: "This computer is still getting ready for phones. It needs an internet connection." }, 409);
      const { link, expires_at } = JSON.parse(await serverCommand(home, port, ["pair", now.people[0]?.name ?? "", "--json"])) as { link: string; expires_at: number };
      return answer(response, { link, expiresAt: expires_at });
    }
    if (path === "remove-phone") {
      await serverCommand(home, port, ["remove-device", String((await body(request)).id)]);
      return answer(response, {});
    }
    answer(response, { error: `The preview has nothing at ${path}.` }, 404);
  } catch (failure) {
    answer(response, { error: (failure as Error).message }, 500);
  }
}

/** An agent's page, as the main process serves it, aimed at this origin. */
async function page(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const served = await pages.page(new Request(`sidebots-page://page/${request.url!.slice("/__page/".length)}`));
  const headers = Object.fromEntries(served.headers);
  if (headers["content-security-policy"]) headers["content-security-policy"] = headers["content-security-policy"].replace(`frame-ancestors ${APP_ORIGIN}`, `frame-ancestors ${origin}`);
  response.writeHead(served.status, headers);
  response.end((await served.text()).replace(JSON.stringify(APP_ORIGIN), JSON.stringify(origin)).replace(JSON.stringify(`${OPEN_ORIGIN}/`), JSON.stringify(`${origin}/__open/`)));
}

// The windows that hear of each link a page asks to have opened, as event streams.
const opening = new Set<ServerResponse>();

/** A link a page asks to have opened, read as the main process reads it. The frame is answered with nothing, so it stays where it was. */
function open(request: IncomingMessage, response: ServerResponse): void {
  const link = pages.pageLink(`${OPEN_ORIGIN}/${request.url!.slice("/__open/".length)}`);
  if (link && isWeb(link)) for (const window of opening) window.write(`data: ${JSON.stringify(link)}\n\n`);
  response.writeHead(204).end();
}

const plugin: Plugin = {
  name: "sidebots-preview",
  configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url?.startsWith("/__preview/")) return void preview(request, response, request.url.slice("/__preview/".length).split("?")[0]);
      if (request.url?.startsWith("/__page/")) return void page(request, response);
      if (request.url?.startsWith("/__open/")) return open(request, response);
      if (request.url === "/__opened") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        opening.add(response);
        return void request.once("close", () => opening.delete(response));
      }
      next();
    });
  },
  transformIndexHtml: () => [
    { tag: "script", children: `window.__preview=${JSON.stringify({ person: person ?? "", machine: "Test Mac", version })}`, injectTo: "head-prepend" },
    { tag: "script", attrs: { type: "module", src: `/@fs${join(DESKTOP, "e2e", "preview", "desktop.ts")}` }, injectTo: "head" },
  ],
};

const vite = await createServer({
  configFile: join(DESKTOP, "vite.renderer.config.ts"),
  root: join(DESKTOP, "src", "renderer"),
  plugins: [plugin],
  // A cache of its own, so a preview never changes the one `pnpm dev` uses, and two previews on different ports never share one.
  cacheDir: join(DESKTOP, "node_modules", `.vite-preview-${vitePort}`),
  server: {
    port: vitePort,
    strictPort: true,
    hmr: { protocol: "ws", host: "localhost", port: vitePort, clientPort: vitePort },
    fs: { allow: [join(DESKTOP, "..")] },
    proxy: {
      "/api": {
        target: server.url,
        rewrite: (path) => path.replace(/^\/api/, ""),
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), [CONTRACT_HEADER]: String(CONTRACT_VERSION) },
      },
      "/__test": { target: server.url },
    },
  },
});
await vite.listen();


console.log(`The desktop window is at ${origin}/, against the scripted server at ${server.url} (${values.seed ? "seeded" : values.nobody ? "nobody set up" : "Tester, no agents"}).

  ${origin}/?platform=win32          laid out as on Windows
  ${origin}/?phase=failed            in a connection other than ready: starting, setup or failed
  __desktop.emit("menu", "settings")   in the console: what the main process would send
  window.__desktopCalls                in the console: what the window asked of the computer

Type commands to an agent: /help lists them (/long, /slow 10, /ask command, /page, /images 3, /files, ...).
Test controls: curl -X POST ${origin}/__test/hold -H 'Content-Type: application/json' -d '{"agent":"Atlas"}'

A screenshot of any state:
  node e2e/preview/shot.ts --url ${origin}/ --out shot.png [--width 1280 --height 800 --dark] [--click <selector>] [--type "<selector>=<text>"] [--press Enter] [--wait <ms>]

Stop with Ctrl-C.`);
