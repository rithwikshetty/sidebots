// The tunnel gives this machine its address under sidebots.app. `cloudflared`
// holds a connection open from the machine to Cloudflare, which brings the
// phone's requests along it to the server. The relay makes the tunnel and hands
// over the token `cloudflared` runs it with.

import { spawn, type ChildProcess } from "node:child_process";
import type { Machine, Store } from "./store.ts";

// How long `cloudflared` waits to start again after it stops.
const RESTART_MS = 10_000;
// The machine registers again once a day, which keeps the relay from removing it as quiet and brings a new tunnel if the relay made one.
const REGISTER_MS = 24 * 60 * 60_000;
// How long a registration that failed waits to try again.
const RETRY_MS = 60_000;

/**
 * Registers the machine with the relay, now and once a day, and keeps
 * `cloudflared` at `command` running with the tunnel's token, starting it again
 * when it stops. It starts with the token the machine kept, so the phone reaches
 * the machine even while the relay can't be reached. `launch` is how it starts
 * a program. Returns a function that stops it.
 */
export function startTunnel(store: Store, register: () => Promise<Required<Machine>>, command: string, launch: typeof spawn = spawn): () => void {
  let token = store.machine()?.tunnelToken;
  let running: ChildProcess | null = null;
  let restart: NodeJS.Timeout | undefined;
  let next: NodeJS.Timeout | undefined;
  let stopped = false;

  const run = () => {
    restart = undefined;
    if (stopped || !token) return;
    // The token goes in the environment, where other accounts on the machine can't read it as they can a command's arguments.
    const child = launch(command, ["tunnel", "--no-autoupdate", "--loglevel", "warn", "run"], { env: { ...process.env, TUNNEL_TOKEN: token }, stdio: "inherit" });
    running = child;
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      running = null;
      if (stopped) return;
      console.error(`${why} It starts again in ${RESTART_MS / 1000} seconds.`);
      restart = setTimeout(run, RESTART_MS);
    };
    child.once("error", (failure) => end(`Can't start cloudflared at ${command}: ${failure.message}. Install it with \`brew install cloudflared\`, or set SIDEBOTS_CLOUDFLARED to where it is.`));
    child.once("exit", (code, signal) => end(`cloudflared stopped, with ${signal ?? `code ${code}`}.`));
  };

  const keepRegistered = async () => {
    let wait = REGISTER_MS;
    try {
      const machine = await register();
      console.log(`Phones reach this machine at ${machine.address}.`);
      if (machine.tunnelToken !== token) {
        token = machine.tunnelToken;
        // A running `cloudflared` stops, and starts again with the new token.
        if (running) running.kill();
        else if (!restart) run();
      }
    } catch (failure) {
      console.error(`Can't register with the relay: ${(failure as Error).message}`);
      wait = RETRY_MS;
    }
    if (!stopped) next = setTimeout(keepRegistered, wait);
  };

  run();
  void keepRegistered();
  return () => {
    stopped = true;
    clearTimeout(restart);
    clearTimeout(next);
    running?.kill();
  };
}
