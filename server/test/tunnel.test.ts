import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { openStore, type Machine } from "../src/store.ts";
import { startTunnel } from "../src/tunnel.ts";

const DAY_MS = 24 * 60 * 60_000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** `cloudflared` as the tunnel starts it: each run it was started for, with the token it got, and a way to make it stop. */
function fakeCloudflared() {
  const runs: { command: string; args: string[]; token?: string; stop(): void }[] = [];
  const launch = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const child = Object.assign(new EventEmitter(), { kill: () => child.emit("exit", null, "SIGTERM") });
    runs.push({ command, args, token: options.env.TUNNEL_TOKEN, stop: () => child.emit("exit", 1, null) });
    return child;
  }) as unknown as typeof spawn;
  return { runs, launch };
}

/** A relay that answers each registration with the next of `tokens`. */
function fakeRegister(tokens: string[]) {
  let count = 0;
  return async (): Promise<Required<Machine>> => {
    const tunnelToken = tokens[Math.min(count++, tokens.length - 1)];
    return { privateKey: "key", id: "abc", address: "abc.sidebots.app", tunnelToken };
  };
}

test("the server registers, runs cloudflared with the tunnel's token, and starts it again when it stops", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-tunnel-test-")));
  const { runs, launch } = fakeCloudflared();
  const stop = startTunnel(store, fakeRegister(["token-1"]), "/opt/cloudflared", launch);
  await settle();

  assert.deepEqual(
    runs.map(({ command, args, token }) => ({ command, args, token })),
    [{ command: "/opt/cloudflared", args: ["tunnel", "--no-autoupdate", "--loglevel", "warn", "run"], token: "token-1" }],
  );
  runs[0].stop();
  mock.timers.tick(10_000);
  assert.deepEqual(runs.map((run) => run.token), ["token-1", "token-1"]);

  stop();
  mock.timers.tick(DAY_MS);
  assert.equal(runs.length, 2);
});

test("cloudflared starts on the token the machine kept, and moves to a new one the relay gives", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-tunnel-test-")));
  store.setMachine({ privateKey: "key", id: "abc", address: "abc.sidebots.app", tunnelToken: "kept" });
  const { runs, launch } = fakeCloudflared();
  const stop = startTunnel(store, fakeRegister(["kept", "new"]), "cloudflared", launch);

  assert.deepEqual(runs.map((run) => run.token), ["kept"]);
  await settle();
  assert.equal(runs.length, 1);

  // The next day's registration brings a new tunnel.
  mock.timers.tick(DAY_MS);
  await settle();
  mock.timers.tick(10_000);
  assert.deepEqual(runs.map((run) => run.token), ["kept", "new"]);
  stop();
});
