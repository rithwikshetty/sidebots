import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { CONTRACT_HEADER, CONTRACT_VERSION } from "../../server/src/contract.ts";
import { UPDATE } from "../src/bridge.ts";
import { createPairing } from "../src/main/pairing.ts";

/**
 * A server that pairs as Sidebots does: its `pair` command makes a code, a
 * code pairs once, and only a key it gave is let in. `version` is the
 * contract version it says it speaks.
 */
function fakeServer(port: number, version = CONTRACT_VERSION) {
  const codes = new Set<string>();
  const keys = new Set<string>();
  const pairings: { name: string; kind: string; replaces?: string }[] = [];
  const commands: string[][] = [];
  const headers = { [CONTRACT_HEADER]: String(version) };
  return {
    keys,
    pairings,
    commands,
    command: async (args: string[]) => {
      commands.push(args);
      const code = `code-${commands.length}`;
      codes.add(code);
      return JSON.stringify({ link: `sidebots://pair?host=${encodeURIComponent(args[3])}&code=${code}`, expires_at: 0 });
    },
    fetch: async (url: string, init: RequestInit) => {
      const { host, pathname } = new URL(url);
      if (host !== `127.0.0.1:${port}`) throw new Error("net::ERR_CONNECTION_REFUSED");
      const sent = new Headers(init.headers);
      if (pathname === "/pair") {
        if (sent.get(CONTRACT_HEADER) !== String(version)) return Response.json({ error: "Update the older one." }, { status: 409, headers });
        const code = sent.get("Authorization")?.replace("Pairing ", "") ?? "";
        if (!codes.delete(code)) return Response.json({ error: "That code has been used or has run out." }, { status: 401, headers });
        const body = JSON.parse(String(init.body)) as { name: string; kind: string; replaces?: string };
        pairings.push(body);
        const key = `key-${port}-${pairings.length}`;
        keys.add(key);
        return Response.json({ key, notificationKey: "n", machine: "Test computer" }, { status: 201, headers });
      }
      if (pathname !== "/status") return Response.json({ error: "No such route." }, { status: 404, headers });
      const known = keys.has(sent.get("Authorization")?.replace("Bearer ", "") ?? "");
      return new Response(null, { status: known ? 204 : 401, headers });
    },
  };
}

const newFile = () => join(mkdtempSync(join(tmpdir(), "sidebots-desktop-test-")), "desktop", "pairing.json");
const name = async () => "Alex's Mac";

test("the app pairs itself as a desktop the first time, and keeps the key in a file only its account can read", async () => {
  const server = fakeServer(4317);
  const file = newFile();
  const pairing = createPairing({ file, port: 4317, name, command: server.command, fetch: server.fetch });
  expect(pairing.key()).toBeUndefined();

  await pairing.ensure("Alex");
  expect(server.commands).toEqual([["pair", "Alex", "--host", "127.0.0.1:4317", "--json"]]);
  expect(server.pairings).toEqual([{ name: "Alex's Mac", kind: "desktop" }]);
  expect(pairing.key()).toBe("key-4317-1");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "127.0.0.1:4317": "key-4317-1" });
  expect(statSync(file).mode & 0o777).toBe(0o600);

  // A key the server knows is kept: the app pairs once, and an app started again reads the key it kept.
  await pairing.ensure("Alex");
  const again = createPairing({ file, port: 4317, name, command: server.command, fetch: server.fetch });
  expect(again.key()).toBe("key-4317-1");
  await again.ensure("Alex");
  expect(server.commands.length).toBe(1);
});

test("a key the server answers 401 to is replaced by pairing again, naming the key it takes the place of", async () => {
  const server = fakeServer(4317);
  const file = newFile();
  const pairing = createPairing({ file, port: 4317, name, command: server.command, fetch: server.fetch });
  await pairing.ensure("Alex");
  expect(await pairing.known()).toBe(true);

  // The device is removed on the computer.
  server.keys.clear();
  expect(await pairing.known()).toBe(false);
  await pairing.ensure("Alex");
  expect(pairing.key()).toBe("key-4317-2");
  expect(server.pairings[1]).toEqual({ name: "Alex's Mac", kind: "desktop", replaces: createHash("sha256").update("key-4317-1").digest("hex") });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "127.0.0.1:4317": "key-4317-2" });
  expect(await pairing.known()).toBe(true);
});

test("each server has a key of its own, so a copy of the app on another port overwrites nothing", async () => {
  const file = newFile();
  const [real, tried] = [fakeServer(4317), fakeServer(4391)];
  await createPairing({ file, port: 4317, name, command: real.command, fetch: real.fetch }).ensure("Alex");
  const other = createPairing({ file, port: 4391, name, command: tried.command, fetch: tried.fetch });
  expect(other.key()).toBeUndefined();
  await other.ensure("Alex");
  expect(tried.commands).toEqual([["pair", "Alex", "--host", "127.0.0.1:4391", "--json"]]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "127.0.0.1:4317": "key-4317-1", "127.0.0.1:4391": "key-4391-1" });
  expect(createPairing({ file, port: 4317, name, command: real.command, fetch: real.fetch }).key()).toBe("key-4317-1");
});

test("a server that can't be reached, or speaks another version of the contract, fails in words for the person and keeps the key", async () => {
  const file = newFile();
  const server = fakeServer(4317);
  await createPairing({ file, port: 4317, name, command: server.command, fetch: server.fetch }).ensure("Alex");

  const stopped = createPairing({ file, port: 4317, name, command: server.command, fetch: async () => Promise.reject(new Error("net::ERR_CONNECTION_REFUSED")) });
  await expect(stopped.ensure("Alex")).rejects.toThrow("Sidebots isn't running on this computer.");

  // The words for the side to update are the window's own, so the person reads one thing whichever meets the other version first.
  const newer = fakeServer(4317, CONTRACT_VERSION + 1);
  await expect(createPairing({ file, port: 4317, name, command: newer.command, fetch: newer.fetch }).ensure("Alex")).rejects.toMatchObject({ message: UPDATE.app, behind: "app" });
  const older = fakeServer(4317, CONTRACT_VERSION - 1);
  await expect(createPairing({ file, port: 4317, name, command: older.command, fetch: older.fetch }).ensure("Alex")).rejects.toMatchObject({ message: UPDATE.computer, behind: "computer" });
  expect([UPDATE.app, UPDATE.computer]).toEqual(["Update this app", "Update Sidebots on this computer"]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "127.0.0.1:4317": "key-4317-1" });
});

test("a key file that can't be read as keys holds none, so the app pairs again and writes the file whole", async () => {
  const server = fakeServer(4317);
  const file = newFile();
  mkdirSync(dirname(file), { recursive: true });
  // A file cut short, one that holds something other than keys, and an empty one.
  for (const [count, contents] of ['{"127.0.0.1:4317":"key-43', "null", ""].entries()) {
    writeFileSync(file, contents);
    const pairing = createPairing({ file, port: 4317, name, command: server.command, fetch: server.fetch });
    expect(pairing.key()).toBeUndefined();
    await pairing.ensure("Alex");
    expect(pairing.key()).toBe(`key-4317-${count + 1}`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "127.0.0.1:4317": `key-4317-${count + 1}` });
  }
});
