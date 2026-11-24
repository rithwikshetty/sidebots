// A real Sidebots server whose agents are scripted, for the desktop app's
// tests, its screenshots and its browser preview.
//
//   node e2e/server.ts --home <dir> --port <n> [--seed | --nobody] [--pause <ms>]
//
// It is the server in server/src, assembled as server/src/main.ts assembles
// it, with no relay and no tunnel, but the turns of Claude Code and Codex are
// a script, and nothing needs either program installed. `--seed` fills a new
// home with Tester's world (scripted/seed.ts). Without it the home has Tester
// set up and no agents, and with `--nobody` nobody is set up at all. The
// server's own commands work against the same home and port, as the desktop
// app's main process runs them:
//
//   cd server && SIDEBOTS_HOME=<dir> PORT=<n> node src/main.ts status --json
//
// It prints one line once it is listening, which starts "Scripted Sidebots is
// listening on". Started on a home it filled before, it carries on with it.
// `startServer` below starts it with `--with-parent`, and it then ends when
// the process that started it ends, however that ends.
//
// What an agent does, it reads from the person's message:
//
//   any plain text            a short friendly reply, after a pause (--pause, 600ms), read first
//   /help                     lists these commands
//   /long                     a long markdown reply: headings, lists, a table, code in three languages, a link, a quote
//   /slow <seconds>           works that long, with an update halfway, so working and Stop can be seen
//   /fail [limit|signed-out|key|overloaded]
//                             the turn fails as the provider would, worded by the provider's own driver
//   /ask command|file|page|tool
//                             asks the person before acting, then says what they chose
//   /ask twice                two asks in a row
//   /connect gmail|calendar|notion
//                             asks for a connection; signing in finishes with no Google or Notion
//   /page, /page tall         an .html page coloured with the chat's CSS variables; the tall one is over 480px
//   /page hostile             a page that tries to get out of its frame (scripted/files.ts says how)
//   /image, /images <n>       PNG pictures made in code, wide, tall and square
//   /files                    a PDF, a CSV, a text file and a zip
//   /mixed                    text with a picture, a page and a file
//   /agent <name> <question>  asks another of the person's agents, and passes on its answer
//   /agent-ask <name>         the other agent asks the person before it acts for this one
//   /job                      saves a job that runs every morning
//   /update                   two updates while it works, then the reply
//   /silent                   ends the turn with an empty reply, as a provider does when the model says nothing
//   /echo-files               lists the names and sizes of the files sent with the message
//
// The test controls answer under /__test/ on the same port, with JSON in and
// out. `agent` is an agent's id or name.
//
//   GET  /__test/state                         the person, the agents, and how the controls stand
//   POST /__test/pause        { ms }           how long a plain reply takes from now on
//   POST /__test/hold         { agent, message? }
//                                              sends a message as the person, and the agent works on it until released
//   POST /__test/release      { agent }        lets a held agent go on with its message
//   POST /__test/ask          { agent, kind?, job?, message? }
//                                              the agent asks the person, on a message of theirs or on a job's run
//   POST /__test/deliver      { agent, text?, files?: ["image" | "page" | "csv"] }
//                                              a message from the agent by itself, as a job's run sends one
//   POST /__test/run-job      { agent }        runs the agent's first job now
//   POST /__test/agents       { name, avatar?, provider? }
//                                              adds an agent, as another device does
//   POST /__test/outage       { ms? }          every API answer is 503 for that long (0 ends it), and event streams end
//   POST /__test/drop-events  { ms? }          ends the open event streams, and refuses new ones for that long
//   POST /__test/hold-requests { match: string | null }
//                                              holds the API requests whose path and query match `match`, a
//                                              regular expression, until null lets them all go on; `state`
//                                              counts them as `held`
//   POST /__test/contract     { version: "older" | "newer" | number | null }
//                                              answers with another contract version, or its own again with null
//   POST /__test/address      { address: string | null }
//                                              the address phones reach the computer at, or none

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CONTRACT_HEADER, CONTRACT_VERSION } from "../../server/src/contract.ts";

export const DESKTOP = join(import.meta.dirname, "..");
export const SERVER = join(DESKTOP, "..", "server");
const READY = "Scripted Sidebots is listening on";

export type World = "seeded" | "empty" | "nobody";
export type Started = {
  home: string;
  port: number;
  /** The server's address, as `http://127.0.0.1:<port>`. */
  url: string;
  process: ChildProcess;
  /** Everything the server has printed. */
  output: () => string;
  /** Stops the server, and resolves once it has exited. */
  stop: () => Promise<void>;
};

/** The environment a child program gets: this one's, without the hooks a test runner puts into Node. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

// Each of Playwright's parallel workers takes its ports from a range of its own, so two tests that run at once never pick the same one before either listens on it. A process that isn't a worker, as the preview, takes them from the range after the workers'.
const PORTS = 400;
const range = 4400 + PORTS * Number(process.env.TEST_PARALLEL_INDEX ?? 12);

// The ports the Fetch standard keeps every fetch from, as Node's and the server's own `status` command's: a server on one is never found.
const BLOCKED = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/** A port above 4400 that nothing on 127.0.0.1 listens on and a fetch may reach, from this process's own range. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = range + Math.floor(Math.random() * PORTS);
    if (BLOCKED.has(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer()
        .once("error", () => resolve(false))
        .listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
}

/** Starts the scripted server in a process of its own, and resolves once it is listening. */
export function startServer({ home, port, world = "empty", pause }: { home: string; port: number; world?: World; pause?: number }): Promise<Started> {
  const args = [join(DESKTOP, "e2e", "server.ts"), "--home", home, "--port", String(port)];
  if (world === "seeded") args.push("--seed");
  if (world === "nobody") args.push("--nobody");
  if (pause !== undefined) args.push("--pause", String(pause));
  // The server's input is a pipe from this process, which closes when this process ends however it ends, and the server ends with it.
  args.push("--with-parent");
  const child = spawn(process.execPath, args, { cwd: DESKTOP, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let printed = "";
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const late = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(late);
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void stop();
      reject(new Error(`The scripted server didn't start within 30 seconds. It printed:\n${printed}`));
    }, 30_000);
    const hear = (chunk: Buffer) => {
      printed += chunk.toString();
      if (printed.includes(READY)) {
        clearTimeout(timer);
        resolve({ home, port, url: `http://127.0.0.1:${port}`, process: child, output: () => printed, stop });
      }
    };
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The scripted server ended with ${code} before it was listening. It printed:\n${printed}`));
    });
  });
}

/** Runs one of the server's own commands against a home and a port, as the desktop app does, and resolves to what it printed. */
export function serverCommand(home: string, port: number, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["src/main.ts", ...args], { cwd: SERVER, env: childEnv({ SIDEBOTS_HOME: home, PORT: String(port) }) }, (failure, printed, errors) => {
      if (failure) reject(new Error(errors.trim() || failure.message));
      else resolve(printed);
    });
  });
}

/** Pairs a device as the person through the server's own `pair` command, and resolves to its key. */
export async function pairDevice({ home, port, person = "Tester", name, kind }: { home: string; port: number; person?: string; name: string; kind: "phone" | "desktop" }): Promise<string> {
  const { link } = JSON.parse(await serverCommand(home, port, ["pair", person, "--host", `127.0.0.1:${port}`, "--json"])) as { link: string };
  const code = new URL(link.replace(/^sidebots:/, "https:")).searchParams.get("code");
  const answer = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: "POST",
    headers: { Authorization: `Pairing ${code}`, "Content-Type": "application/json", [CONTRACT_HEADER]: String(CONTRACT_VERSION) },
    body: JSON.stringify({ name, kind }),
  });
  const paired = (await answer.json()) as { key?: string; error?: string };
  if (!paired.key) throw new Error(paired.error ?? `The server answered ${answer.status}.`);
  return paired.key;
}

/**
 * Calls the API as a phone of the person's, which pairs through the server's
 * own `pair` command the first time it is used. A string body is sent as JSON.
 */
export function phone({ home, port, name = "Tester's iPad" }: { home: string; port: number; name?: string }): (path: string, init?: RequestInit) => Promise<Response> {
  let key: Promise<string> | undefined;
  return async (path, init = {}) => {
    key ??= pairDevice({ home, port, name, kind: "phone" });
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await key}`);
    if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
  };
}

/** Uses one of the test controls on the server at `port`, with a JSON body when there is one, and resolves to its answer. It fails with what the control said. */
export async function control<T = unknown>(port: number, path: string, body?: unknown): Promise<T> {
  const answer = await fetch(`http://127.0.0.1:${port}/__test/${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const said = await answer.json();
  if (!answer.ok) throw new Error(`The control ${path} answered ${answer.status}: ${JSON.stringify(said)}`);
  return said as T;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { home: { type: "string" }, port: { type: "string" }, seed: { type: "boolean" }, nobody: { type: "boolean" }, pause: { type: "string" }, "with-parent": { type: "boolean" } } });
  if (!values.home || !values.port) {
    console.error("usage: node e2e/server.ts --home <dir> --port <n> [--seed | --nobody] [--pause <ms>]");
    process.exit(1);
  }
  if (values["with-parent"]) {
    process.stdin.on("end", () => process.exit(0));
    process.stdin.resume();
  }
  const { run } = await import("./scripted/world.ts");
  await run({ home: values.home, port: Number(values.port), world: values.seed ? "seeded" : values.nobody ? "nobody" : "empty", pause: Number(values.pause ?? 600) });
}
