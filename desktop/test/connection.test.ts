import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Connection } from "../src/bridge.ts";
import { watchConnection } from "../src/main/connection.ts";
import type { Host } from "../src/main/host.ts";
import { Mismatch, type Pairing } from "../src/main/pairing.ts";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

/** A computer whose server runs or not, with the people set up on it, and an app whose key the server knows or not. */
function setup({ canStart = true, running = false, people = [] as string[] } = {}) {
  const computer = { running, people, known: false, starts: 0, pairs: 0, looks: 0, failure: undefined as Error | undefined };
  const host: Host = {
    port: 4391,
    name: async () => "Alex's Mac",
    command: async () => (computer.looks++, JSON.stringify({ running: computer.running, address: null, people: computer.people.map((name) => ({ name })) })),
    startServer: async () => (computer.starts++, canStart),
    openSetup: async () => canStart,
  };
  const pairing: Pairing = {
    key: () => (computer.known ? "key" : undefined),
    known: async () => {
      if (!computer.running) throw new Error("Sidebots isn't running on this computer.");
      return computer.known;
    },
    ensure: async () => {
      if (computer.failure) throw computer.failure;
      if (!(await pairing.known())) computer.pairs++;
      computer.known = true;
    },
  };
  const heard: Connection["phase"][] = [];
  const watch = watchConnection(host, pairing, (connection) => heard.push(connection.phase));
  return { computer, watch, heard };
}

test("the app asks the computer to start a server that isn't running, waits for it, then pairs and is ready", async () => {
  const { computer, watch, heard } = setup();
  await watch.look();
  expect(watch.connection()).toEqual({ phase: "starting" });
  expect(computer.starts).toBe(1);

  // Nobody is set up when the server first answers.
  computer.running = true;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(watch.connection()).toEqual({ phase: "setup" });

  computer.people = ["Alex"];
  await vi.advanceTimersByTimeAsync(2_000);
  expect(watch.connection()).toEqual({ phase: "ready", machine: "Alex's Mac", person: "Alex" });
  expect([computer.starts, computer.pairs]).toEqual([1, 1]);
  expect(heard).toEqual(["setup", "ready"]);
});

test("a ready app pairs again by itself when the server forgets its key, and tells the window as it does", async () => {
  const { computer, watch, heard } = setup({ running: true, people: ["Alex"] });
  await watch.look();
  expect(heard).toEqual(["ready"]);

  computer.known = false;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(heard).toEqual(["ready", "starting", "ready"]);
  expect(computer.pairs).toBe(2);
});

test("a server that stops is asked for once, and one that stays away is a failure the person can try again", async () => {
  const { computer, watch } = setup({ running: true, people: ["Alex"] });
  await watch.look();

  computer.running = false;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(watch.connection()).toEqual({ phase: "starting" });
  // The server has thirty seconds to answer, and the first look after them says it hasn't.
  await vi.advanceTimersByTimeAsync(28_000);
  expect(watch.connection()).toEqual({ phase: "starting" });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(watch.connection()).toEqual({ phase: "failed", message: "Sidebots hasn't started. Try again, or open Sidebots from the menu bar." });
  expect(computer.starts).toBe(1);

  await watch.retry();
  expect(watch.connection()).toEqual({ phase: "starting" });
  expect(computer.starts).toBe(2);
  computer.running = true;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(watch.connection().phase).toBe("ready");
});

test("a copy of the app that can't start the server says the server isn't running, and is ready once it is", async () => {
  const { computer, watch } = setup({ canStart: false });
  await watch.look();
  expect(watch.connection()).toEqual({ phase: "failed", message: "Sidebots isn't running on this computer." });
  Object.assign(computer, { running: true, people: ["Alex"] });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(watch.connection().phase).toBe("ready");
});

test("after a look that finds no server the app looks again a moment later, then less and less often, until it is ready", async () => {
  const { computer, watch } = setup({ canStart: false });
  await watch.look();
  expect(watch.connection()).toEqual({ phase: "failed", message: "Sidebots isn't running on this computer." });
  // The waits between looks are a quarter of a second, then twice the one before, up to two seconds.
  for (const [looks, wait] of [250, 500, 1_000, 2_000, 2_000].entries()) {
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(computer.looks).toBe(looks + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(computer.looks).toBe(looks + 2);
  }

  // Retry looks now, and the looks after it come quickly again.
  await watch.retry();
  expect(computer.looks).toBe(7);
  Object.assign(computer, { running: true, people: ["Alex"] });
  await vi.advanceTimersByTimeAsync(250);
  expect(watch.connection().phase).toBe("ready");

  // A ready app asks the server itself every five seconds, and one that then loses the server looks quickly again.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(computer.looks).toBe(8);
  computer.running = false;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(computer.looks).toBe(9);
  await vi.advanceTimersByTimeAsync(250);
  expect(computer.looks).toBe(10);
});

test("a failure to pair because the two speak different versions of the contract says which side is behind", async () => {
  const { computer, watch } = setup({ running: true, people: ["Alex"] });
  computer.failure = new Mismatch("computer");
  await watch.look();
  expect(watch.connection()).toEqual({ phase: "failed", message: "Update Sidebots on this computer", behind: "computer" });

  computer.failure = new Error("The server answered 500.");
  await vi.advanceTimersByTimeAsync(250);
  expect(watch.connection()).toEqual({ phase: "failed", message: "The server answered 500." });
});
