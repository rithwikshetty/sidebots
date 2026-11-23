import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** Resolves to whether `done` came to hold within five seconds. */
async function within5s(done: () => boolean): Promise<boolean> {
  for (let waited = 0; !done() && waited < 5_000; waited += 50) await wait(50);
  return done();
}

/** Listens on a port of the system's choosing, on this machine only. */
async function listen(): Promise<{ port: number; listener: Server }> {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  return { port: (listener.address() as { port: number }).port, listener };
}

/**
 * Starts the server on `port`, in a home whose machine has a tunnel, with a
 * `cloudflared` that runs until it is stopped and a relay nothing answers at.
 * `tunnelRuns` says whether that `cloudflared` runs, and `exit` resolves to the
 * code and signal the server ended with, or nothing when it still runs.
 */
function startServer(t: TestContext, port: number, args: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "sidebots-main-test-"));
  const store = openStore(home);
  store.setMachine({ privateKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(), id: "abc", address: "abc.sidebots.app", tunnelToken: "token" });
  store.close();
  const cloudflared = join(home, "cloudflared");
  writeFileSync(cloudflared, "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o755 });
  const child = spawn(process.execPath, [MAIN, ...args], {
    env: { ...process.env, SIDEBOTS_HOME: home, PORT: String(port), SIDEBOTS_RELAY: "http://127.0.0.1:1", SIDEBOTS_CLOUDFLARED: cloudflared },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let printed = "";
  child.stdout.on("data", (chunk) => (printed += chunk));
  child.stderr.on("data", (chunk) => (printed += chunk));
  let ended: [number | null, NodeJS.Signals | null] | undefined;
  child.once("exit", (code, signal) => (ended = [code, signal]));
  const exit = async () => ((await within5s(() => ended !== undefined)) ? ended : undefined);
  // The shell that runs it has its path in its command line.
  const tunnelRuns = () => succeeds("/usr/bin/pgrep", ["-f", cloudflared]);
  t.after(() => {
    child.kill("SIGKILL");
    succeeds("/usr/bin/pkill", ["-KILL", "-f", cloudflared]);
  });
  return { child, tunnelRuns, exit, printed: () => printed };
}

/** Whether a program ran and ended well, which `pgrep` and `pkill` do when a process matched. */
function succeeds(program: string, args: string[]): boolean {
  try {
    execFileSync(program, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("a server that stops with an error stops its cloudflared", async (t) => {
  // The port is taken, as it is while another Sidebots server runs on the machine.
  const { port, listener } = await listen();
  t.after(() => listener.close());
  const server = startServer(t, port);
  assert.deepEqual(await server.exit(), [1, null], server.printed());
  assert.ok(await within5s(() => !server.tunnelRuns()), "cloudflared still runs after its server stopped");
});

test("a server started with its parent stops, and stops its cloudflared, when its input ends", async (t) => {
  const { port, listener } = await listen();
  await new Promise((resolve) => listener.close(resolve));
  const server = startServer(t, port, ["--with-parent"]);
  assert.ok(await within5s(() => server.printed().includes("Sidebots is listening")), server.printed());
  assert.ok(server.tunnelRuns(), server.printed());
  // The pipe closes, as it does when the Mac app ends however it ends.
  server.child.stdin.end();
  assert.deepEqual(await server.exit(), [0, null], server.printed());
  assert.ok(await within5s(() => !server.tunnelRuns()), "cloudflared still runs after its server stopped");
});
