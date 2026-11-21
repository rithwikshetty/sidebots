// Where the app stands with the server, which it works out from the server's
// own `status` command and keeps looking at: a moment after a look that left
// it short of ready, then less and less often, and every few seconds once it
// is ready, so it notices when the server stops or forgets the app's key.

import { NOT_RUNNING, type Connection } from "../bridge.ts";
import type { Host, Status } from "./host.ts";
import { Mismatch, type Pairing } from "./pairing.ts";

// How long between looks. While the app waits for the server the wait starts short and doubles up to the longest, so one look that missed a server that is there, as on a busy computer, is put right quickly.
const FIRST_WAIT_MS = 250;
const WAITING_MS = 2_000;
// How long between looks once the app is ready.
const READY_MS = 5_000;
// How long a server the host was asked to start has to answer.
const STARTING_MS = 30_000;


export type Watch = ReturnType<typeof watchConnection>;

/** Starts looking at the server. `changed` hears the connection each time it changes. */
export function watchConnection(host: Host, pairing: Pairing, changed: (connection: Connection) => void) {
  let connection: Connection = { phase: "starting" };
  // When the host was asked to start the server, since the server last ran. Null when it hasn't been, or when it couldn't be asked.
  let askedAt: number | null | undefined;
  let looking: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // How long after the next look that leaves the app short of ready the one after it comes.
  let wait = FIRST_WAIT_MS;

  const set = (next: Connection) => {
    if (JSON.stringify(next) === JSON.stringify(connection)) return;
    connection = next;
    changed(connection);
  };

  /** Where the app stands now. */
  async function stand(): Promise<Connection> {
    // A ready app asks the server itself, which costs less than a command. Anything but a plain yes is worked out from the start.
    if (connection.phase === "ready" && (await pairing.known().catch(() => false))) return connection;
    let status: Status;
    try {
      status = JSON.parse(await host.command(["status", "--json"])) as Status;
    } catch (failure) {
      console.error(failure);
      return { phase: "failed", message: "Sidebots couldn't read its data on this computer." };
    }
    if (!status.running) {
      if (askedAt === undefined) askedAt = (await host.startServer().catch(() => false)) ? Date.now() : null;
      if (askedAt === null) return { phase: "failed", message: NOT_RUNNING };
      return Date.now() - askedAt < STARTING_MS ? { phase: "starting" } : { phase: "failed", message: "Sidebots hasn't started. Try again, or open Sidebots from the menu bar." };
    }
    askedAt = undefined;
    const person = status.people[0];
    if (!person) return { phase: "setup" };
    try {
      // The window hears that the app is pairing again, so it loads again with the new key.
      if (connection.phase === "ready") set({ phase: "starting" });
      await pairing.ensure(person.name);
      return { phase: "ready", machine: await host.name(), person: person.name };
    } catch (failure) {
      return { phase: "failed", message: (failure as Error).message, ...(failure instanceof Mismatch ? { behind: failure.behind } : {}) };
    }
  }

  /** Looks now, unless a look is under way, and again after a while. */
  function look(): Promise<void> {
    looking ??= stand()
      .then(set)
      .finally(() => {
        looking = undefined;
        clearTimeout(timer);
        const ready = connection.phase === "ready";
        timer = setTimeout(look, ready ? READY_MS : wait);
        wait = ready ? FIRST_WAIT_MS : Math.min(wait * 2, WAITING_MS);
      });
    return looking;
  }
  void look();

  return {
    connection: () => connection,
    look,
    /** Looks again now, and asks the host once more to start a server that isn't running. */
    retry(): Promise<void> {
      askedAt = undefined;
      wait = FIRST_WAIT_MS;
      set({ phase: "starting" });
      return look();
    },
  };
}
