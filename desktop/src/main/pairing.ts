// The desktop app's own key to the server. The app is a device like any
// phone: it pairs with a code the server's `pair` command makes, and sends the
// key it gets with every request. The key is kept in a file only this account
// can read, under the server it is for, so a copy of the app that talks to a
// server on another port keeps a key of its own.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Behind, behind, readPairingLink } from "../../../client/api.ts";
import { CONTRACT_HEADER, CONTRACT_VERSION, type Paired } from "../../../server/src/contract.ts";
import { NOT_RUNNING, UPDATE } from "../bridge.ts";

/** What the server keeps of a key, which is how the app names a key it held before. */
const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

/** A failure to pair because the server speaks another version of the contract than this app, in the window's own words for the side to update. */
export class Mismatch extends Error {
  behind: Behind;
  constructor(side: Behind) {
    super(UPDATE[side]);
    this.behind = side;
  }
}

/** Fails with a `Mismatch` when the server speaks another version of the contract than this app. Every answer of the server's carries its version. */
function sameContract(answer: Response): void {
  const side = behind(answer);
  if (side) throw new Mismatch(side);
}

export type Pairing = ReturnType<typeof createPairing>;

/**
 * `file` is where the keys are kept, `port` is the server's, `name` is what
 * the server lists this device as, `command` runs one of the server's
 * commands, and `fetch` reaches the server.
 */
export function createPairing({ file, port, name, command, fetch }: { file: string; port: number; name: () => Promise<string>; command: (args: string[]) => Promise<string>; fetch: (url: string, init: RequestInit) => Promise<Response> }) {
  const server = `127.0.0.1:${port}`;
  /** Calls the server. It fails in words for the person when nothing answers. */
  const call = (path: string, init: RequestInit) =>
    fetch(`http://${server}${path}`, init).catch(() => {
      throw new Error(NOT_RUNNING);
    });
  /** The keys in the file, by server. A file that is missing or can't be read as keys holds none, so the app pairs again. */
  const kept = (): Record<string, string> => {
    try {
      const keys: unknown = JSON.parse(readFileSync(file, "utf8"));
      return keys && typeof keys === "object" && !Array.isArray(keys) ? (keys as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  let key: string | undefined = kept()[server];

  /** Keeps the key for this server beside the keys for any others. The file is swapped in whole, and only this account can read it. */
  const keep = (paired: string) => {
    key = paired;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.new`, JSON.stringify({ ...kept(), [server]: paired }), { mode: 0o600 });
    renameSync(`${file}.new`, file);
  };

  /** Whether the server knows the key the app holds. It fails when the server can't be reached or speaks another version of the contract. */
  const known = async (): Promise<boolean> => {
    if (!key) return false;
    const answer = await call("/status", { headers: { Authorization: `Bearer ${key}` } });
    sameContract(answer);
    return answer.status !== 401;
  };

  return {
    /** The key the app holds for the server, which the server may have forgotten. */
    key: () => key,
    known,

    /**
     * Makes sure the app holds a key the server knows, as `person`. With none,
     * or one the server refuses, it pairs: it has the server make a code for
     * this computer's own address, and uses the code up. The hash of a key it
     * held before goes with it, so the server puts this pairing in that one's
     * place.
     */
    async ensure(person: string): Promise<void> {
      if (await known()) return;
      const { link } = JSON.parse(await command(["pair", person, "--host", server, "--json"])) as { link: string };
      const answer = await call("/pair", {
        method: "POST",
        headers: { Authorization: `Pairing ${readPairingLink(link)?.code}`, "Content-Type": "application/json", [CONTRACT_HEADER]: String(CONTRACT_VERSION) },
        body: JSON.stringify({ name: await name(), kind: "desktop", replaces: key && hashOf(key) }),
      });
      sameContract(answer);
      const paired = (await answer.json()) as Partial<Paired> & { error?: string };
      if (!answer.ok || !paired.key) throw new Error(paired.error ?? `The server answered ${answer.status}.`);
      keep(paired.key);
    },
  };
}
