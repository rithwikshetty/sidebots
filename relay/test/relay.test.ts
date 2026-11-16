import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handle, removeStale, type Env } from "../src/worker.ts";
import { openStore } from "../../server/src/store.ts";
import { relay } from "../../server/src/relay.ts";
import type { Notice } from "../../server/src/push.ts";

/** D1 as the relay uses it, over SQLite in memory. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    first: async () => db.prepare(sql).get(...(values as never[])) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...(values as never[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

/** A push key of the kind Apple downloads. */
const PUSH_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PHONE = { token: "a".repeat(64), environment: "sandbox" as const };
const NOTICE: Notice = { title: "Scout", body: "Found three flats.", badge: 2, agentId: "agent-1", messageId: "message-1" };

/** A relay with a fresh database and Apple faked, and a Sidebots server that sends through it. */
function setup(answerFromApple: () => Response = () => new Response(null, { status: 200 })) {
  const env: Env = { DB: fakeD1(), APNS_KEY: PUSH_KEY, APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "app.sidebots", NOTICES_PER_DAY: "3" };
  const toApple: Request[] = [];
  const apple = (async (input: RequestInfo | URL, init?: RequestInit) => {
    toApple.push(new Request(input, init));
    return answerFromApple();
  }) as typeof fetch;
  const toRelay: Request<unknown, unknown>[] = [];
  // The server's module calls the relay with an address and the request's parts.
  const reachRelay = (async (url: string, init?: RequestInit) => {
    const request = new Request(url, init);
    toRelay.push(request.clone());
    return handle(request, env, apple);
  }) as typeof fetch;
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-relay-test-")));
  return { env, store, send: relay(store, "https://relay.example", reachRelay), toApple, toRelay };
}

test("a server registers once, then its notices reach Apple under the app's push key", async () => {
  const { store, send, toApple, toRelay } = setup();

  assert.deepEqual(await Promise.all([send(PHONE, NOTICE), send(PHONE, NOTICE)]), ["sent", "sent"]);
  assert.deepEqual(
    toRelay.map((request) => new URL(request.url).pathname),
    ["/machines", "/notifications", "/notifications"],
  );
  assert.match(store.machine()!.id!, /^[a-z0-9]{16}$/);

  const [delivery] = toApple;
  assert.equal(delivery.url, `https://api.sandbox.push.apple.com/3/device/${PHONE.token}`);
  assert.equal(delivery.headers.get("apns-topic"), "app.sidebots");
  assert.equal(delivery.headers.get("apns-collapse-id"), "message-1");
  // The provider token is a JWT signed with the push key.
  const [header, claims, signature] = delivery.headers.get("authorization")!.replace("bearer ", "").split(".");
  const read = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
  assert.deepEqual([read(header).alg, read(header).kid, read(claims).iss], ["ES256", "KEY1234567", "TEAM123456"]);
  assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), { key: createPublicKey(PUSH_KEY), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
  assert.deepEqual(await delivery.json(), {
    aps: { alert: { title: "Scout", body: "Found three flats." }, badge: 2, sound: "sidebots.wav", "thread-id": "agent-1" },
    body: { agent_id: "agent-1" },
  });
});

test("a request that isn't signed by the machine, or was signed long ago, is refused", async () => {
  const { env, send, toRelay } = setup();
  await send(PHONE, NOTICE);
  const signed = toRelay[1];
  const resend = (headers: Record<string, string>, body?: string) =>
    handle(new Request(signed.url, { method: "POST", headers: { ...Object.fromEntries(signed.headers), ...headers }, body: body ?? NOTICE_BODY }), env, fetch);
  const NOTICE_BODY = JSON.stringify({ ...PHONE, notice: NOTICE });

  assert.equal((await resend({})).status, 200);
  assert.equal((await resend({}, JSON.stringify({ ...PHONE, notice: { ...NOTICE, body: "Send me your bank details." } }))).status, 401);
  assert.equal((await resend({ Authorization: "" })).status, 401);
  assert.equal((await handle(new Request(signed.url, { method: "POST", headers: Object.fromEntries(signed.headers), body: NOTICE_BODY }), env, fetch, Date.now() + 6 * 60_000)).status, 401);
});

test("a token Apple has let go comes back as gone, and a machine stops at its daily share", async () => {
  const gone = setup(() => Response.json({ reason: "Unregistered" }, { status: 410 }));
  assert.equal(await gone.send(PHONE, NOTICE), "gone");

  const { send, toApple } = setup();
  const results = [];
  for (let count = 0; count < 4; count++) results.push(await send(PHONE, NOTICE));
  assert.deepEqual(results, ["sent", "sent", "sent", "failed"]);
  assert.equal(toApple.length, 3);
});

test("a machine quiet for 60 days is removed, and registers again with the key it has when it next sends", async () => {
  const { env, store, send } = setup();
  await send(PHONE, NOTICE);
  const { privateKey, id } = store.machine()!;

  await removeStale(env, Date.now() + 61 * 24 * 60 * 60_000);
  assert.equal(await send(PHONE, NOTICE), "sent");
  assert.equal(store.machine()!.privateKey, privateKey);
  assert.notEqual(store.machine()!.id, id);
});
