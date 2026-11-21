import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_HEADER, CONTRACT_VERSION } from "../../server/src/contract.ts";
import { behind, call, readPairingLink, type Caller } from "../api.ts";

const answer = (body: unknown, status = 200, version: number | null = CONTRACT_VERSION) =>
  new Response(JSON.stringify(body), { status, headers: version === null ? {} : { [CONTRACT_HEADER]: String(version) } });

const WORDS = { unreachable: "Offline.", notRunning: "Not running.", update: { computer: "Update the computer", app: "Update the app" } };

/** A caller whose fetch is the test's, with what it was last asked. */
function caller(fetch: () => Promise<Response> | Response) {
  const asked: { url: string; init: Parameters<Caller["fetch"]>[1] }[] = [];
  const made: Caller = { ...WORDS, fetch: async (url, init) => (asked.push({ url, init }), fetch()) };
  return { caller: made, asked };
}

test("a call says which version of the contract the app speaks, and sends JSON as JSON and a form as it is", async () => {
  const { caller: made, asked } = caller(() => answer({ id: "mochi" }));
  assert.deepEqual(await call(made, "https://computer/agents", { method: "POST", headers: { Authorization: "Bearer key" }, body: { name: "Mochi" } }), { id: "mochi" });
  const form = new FormData();
  await call(made, "https://computer/agents/mochi/messages", { method: "POST", body: form });
  await call(made, "https://computer/agents");
  assert.deepEqual(
    asked.map(({ url, init }) => [url, init.method, init.headers, init.body]),
    [
      ["https://computer/agents", "POST", { Authorization: "Bearer key", [CONTRACT_HEADER]: String(CONTRACT_VERSION), "Content-Type": "application/json" }, '{"name":"Mochi"}'],
      ["https://computer/agents/mochi/messages", "POST", { [CONTRACT_HEADER]: String(CONTRACT_VERSION) }, form],
      ["https://computer/agents", "GET", { [CONTRACT_HEADER]: String(CONTRACT_VERSION), "Content-Type": "application/json" }, undefined],
    ],
  );
});

test("a call that never reached Sidebots fails with status 0 and the app's own words for why", async () => {
  const failing = (fetch: () => Promise<Response> | Response) => assert.rejects(call(caller(fetch).caller, "https://computer/agents"), (failure: { message: string; status: number }) => (failed.push([failure.message, failure.status]), true));
  const failed: [string, number][] = [];
  await failing(() => Promise.reject(new Error("no network")));
  await failing(() => answer("Bad gateway", 502, null));
  await failing(() => answer([], 200, CONTRACT_VERSION - 1));
  await failing(() => answer([], 200, CONTRACT_VERSION + 1));
  await failing(() => answer([], 200, null));
  assert.deepEqual(failed, [
    ["Offline.", 0],
    ["Not running.", 0],
    ["Update the computer.", 0],
    ["Update the app.", 0],
    ["Update the computer.", 0],
  ]);
});

test("a call the server refuses fails with the server's status and its reason, when it gave one", async () => {
  await assert.rejects(call(caller(() => answer({ error: "That agent is gone." }, 404)).caller, "https://computer/agents/gone"), { message: "That agent is gone.", status: 404 });
  await assert.rejects(call(caller(() => new Response("oops", { status: 500, headers: { [CONTRACT_HEADER]: String(CONTRACT_VERSION) } })).caller, "https://computer/agents"), { message: "The server answered 500.", status: 500 });
});

test("an answer in Sidebots' place says nothing about which side is behind", () => {
  assert.equal(behind(answer([], 200)), null);
  assert.equal(behind(answer([], 401, CONTRACT_VERSION - 1)), "computer");
  assert.equal(behind(answer([], 200, CONTRACT_VERSION + 1)), "app");
  assert.equal(behind(answer("", 530, null)), null);
});

test("a pairing link gives its host and code, and anything else gives nothing", () => {
  assert.deepEqual(readPairingLink(" sidebots://pair?host=mac.example.com&code=abc123\n"), { host: "mac.example.com", code: "abc123" });
  assert.deepEqual(readPairingLink("sidebots://pair/?code=abc123&host=demo.invalid"), { host: "demo.invalid", code: "abc123" });
  assert.equal(readPairingLink("sidebots://pair?host=mac.example.com"), null);
  assert.equal(readPairingLink("https://sidebots.app/pair?host=mac.example.com&code=abc123"), null);
});
