// The host is the computer Sidebots runs on: the port its server listens on,
// where Node and the server's folder are, the server's commands, and how the
// server is started and the person set up. Nothing else in the desktop app
// knows any of that, so a build for another system gives this module another
// body.

import { execFile } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

export type Host = {
  /** The port the server listens on, on 127.0.0.1. */
  port: number;
  /** The computer's name as its owner knows it. */
  name(): Promise<string>;
  /** Runs one of the server's commands and resolves to what it printed. It fails with what the command said went wrong. */
  command(args: string[]): Promise<string>;
  /** Starts the server. Resolves to false when this copy of the app has no way to. */
  startServer(): Promise<boolean>;
  /** Sends the person to where Sidebots is set up. Resolves to false when this copy of the app has no way to. */
  openSetup(): Promise<boolean>;
};

/** What the server's `status --json` command says, in the parts the desktop app reads. */
export type Status = { running: boolean; address: string | null; people: { name: string }[] };

/** Where Node and the server's folder are, and the app this one sits inside when it sits inside one. */
export type Place = { node: string; server: string; outer?: string };

/**
 * Finds Node and the server's folder. `SIDEBOTS_NODE` and `SIDEBOTS_SERVER`
 * name them when they are set. An app at
 * `<Outer>.app/Contents/Helpers/Sidebots.app` uses the ones the outer app
 * carries. Any other copy is one run from the repository: it uses the `node`
 * on the PATH and the `server` folder beside the app's own, which `appPath` is.
 * `program` is the app's own executable.
 */
export function locate(env: NodeJS.ProcessEnv, program: string, appPath: string): Place {
  // The executable is at Sidebots.app/Contents/MacOS/Sidebots.
  const helpers = dirname(dirname(dirname(dirname(program))));
  const outer = dirname(dirname(helpers));
  const inside = basename(helpers) === "Helpers" && basename(dirname(helpers)) === "Contents" && outer.endsWith(".app");
  const resources = join(outer, "Contents", "Resources");
  return {
    node: env.SIDEBOTS_NODE ?? (inside ? join(resources, "bin", "node") : "node"),
    server: env.SIDEBOTS_SERVER ?? (inside ? join(resources, "server") : join(appPath, "..", "server")),
    ...(inside ? { outer } : {}),
  };
}

/** Runs a program to its end and resolves to what it printed. It fails with what the program printed as its error, or with why it ended. */
export type Run = (program: string, args: string[], options?: { cwd?: string }) => Promise<string>;

const execute: Run = (program, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(program, args, { ...options, env: process.env, maxBuffer: 16 * 1024 * 1024 }, (failure, printed, errors) => {
      if (failure) reject(new Error(errors.trim() || failure.message));
      else resolve(printed);
    });
  });

// What names the data and the server a copy of Sidebots uses, which an app the system opens isn't given unless it is handed them by name.
const PASSED_ON = ["PORT", "SIDEBOTS_HOME", "SIDEBOTS_RELAY"];

/**
 * The host on a Mac. The menu bar app holds the server, so starting the server
 * and setting the person up both mean opening that app, with what this one was
 * given of `PORT`, `SIDEBOTS_HOME` and `SIDEBOTS_RELAY`: it starts the server
 * as it opens, and shows its setup window when nobody is set up. A menu bar
 * app that runs starts its server again by itself, and opening it then would
 * bring the window forward, so the server is started only when it doesn't
 * run. A copy that sits inside no menu bar app can do neither. `run` runs the
 * programs the host needs.
 */
export function createHost(env: NodeJS.ProcessEnv, program: string, appPath: string, run: Run = execute): Host {
  const { node, server, outer } = locate(env, program, appPath);
  const openOuter = async () => {
    if (!outer) return false;
    await run("/usr/bin/open", [...PASSED_ON.flatMap((name) => (env[name] === undefined ? [] : ["--env", `${name}=${env[name]}`])), outer]);
    return true;
  };
  // The menu bar app runs when a program of this account's was started as that app's own executable. This app's executable is in a folder inside that app, so only the whole path, with nothing before it, names the menu bar app's.
  const outerRuns = (outer: string) => {
    const executable = join(outer, "Contents", "MacOS", "Sidebots").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    return run("/usr/bin/pgrep", ["-U", String(userInfo().uid), "-f", `^${executable}( |$)`]).then(
      () => true,
      () => false,
    );
  };
  return {
    port: Number(env.PORT ?? 4317),
    // macOS keeps the name its owner gave the computer apart from the network's name for it.
    name: () => (process.platform === "darwin" ? run("/usr/sbin/scutil", ["--get", "ComputerName"]).then((name) => name.trim(), hostname) : Promise.resolve(hostname())),
    // The command runs with the app's own environment, so `SIDEBOTS_HOME` and `PORT` reach it.
    command: (args) => run(node, ["src/main.ts", ...args], { cwd: server }),
    startServer: async () => (outer !== undefined && (await outerRuns(outer))) || openOuter(),
    openSetup: openOuter,
  };
}
