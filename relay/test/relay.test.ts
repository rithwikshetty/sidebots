import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handle, logRoom, removeStale, type Env } from "../src/worker.ts";
import { openStore } from "../../server/src/store.ts";
import { relay } from "../../server/src/relay.ts";
import { seal, type Notice } from "../../server/src/push.ts";

/** D1 as the relay uses it, over SQLite in memory. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    first: async () => db.prepare(sql).get(...(values as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(values as never[])) }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...(values as never[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

/** A push key of the kind Apple downloads. */
const PUSH_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PHONE = { token: "a".repeat(64), environment: "sandbox" as const };
// A phone's notification key, and a notice sealed with it, as the server's push module sends it.
const NOTIFICATION_KEY = Buffer.alloc(32, 7).toString("base64");
const NOTICE = { sealed: seal({ title: "Maya", body: "Found three flats.", badge: 2, agentId: "agent-1", messageId: "message-1" } satisfies Notice, NOTIFICATION_KEY), messageId: "message-1" };

const API_TOKEN = "cloudflare-api-token";
// The ids in Cloudflare's paths: the account's and the zone's, then a tunnel's or a record's.
const IDS = /[0-9a-f-]{32,36}/g;

/** Cloudflare's API as the relay uses it, keeping tunnels and DNS records in memory, and refusing one past `most`, as a full account or zone does. */
function fakeCloudflare() {
  const tunnels = new Map<string, { name: string; ingress?: { hostname?: string; service: string }[] }>();
  const records = new Map<string, { type: string; name: string; content: string; proxied: boolean }>();
  const most = { tunnels: 1000, records: 200 };
  const reply = (result: unknown, status = 200, total?: number) =>
    Response.json({ success: status < 300, result, result_info: { total_count: total }, errors: status < 300 ? [] : [{ message: "Cloudflare's words." }] }, { status });
  const answer = async (request: Request): Promise<Response> => {
    assert.equal(request.headers.get("Authorization"), `Bearer ${API_TOKEN}`);
    const { pathname, searchParams } = new URL(request.url);
    const route = `${request.method} ${pathname.replace("/client/v4", "").replace(IDS, ":id")}`;
    const last = [...pathname.matchAll(IDS)].at(-1)?.[0] ?? "";
    switch (route) {
      case "GET /accounts/:id/cfd_tunnel":
        return reply([...tunnels.keys()].slice(0, 1).map((id) => ({ id })), 200, tunnels.size);
      case "POST /accounts/:id/cfd_tunnel": {
        if (tunnels.size >= most.tunnels) return reply(null, 400);
        const tunnelId = randomUUID();
        tunnels.set(tunnelId, { name: ((await request.json()) as { name: string }).name });
        return reply({ id: tunnelId });
      }
      case "PUT /accounts/:id/cfd_tunnel/:id/configurations":
      case "GET /accounts/:id/cfd_tunnel/:id/token":
      case "DELETE /accounts/:id/cfd_tunnel/:id/connections":
      case "DELETE /accounts/:id/cfd_tunnel/:id": {
        const tunnel = tunnels.get(last);
        if (!tunnel) return reply(null, 404);
        if (route.startsWith("PUT")) tunnel.ingress = ((await request.json()) as { config: { ingress: [] } }).config.ingress;
        if (route.endsWith("/token")) return reply(`token-for-${last}`);
        if (route === "DELETE /accounts/:id/cfd_tunnel/:id") tunnels.delete(last);
        return reply({});
      }
      case "GET /zones/:id/dns_records/usage":
        return reply({ record_usage: records.size, record_quota: most.records });
      case "POST /zones/:id/dns_records": {
        if (records.size >= most.records) return reply(null, 400);
        const recordId = randomUUID();
        records.set(recordId, (await request.json()) as never);
        return reply({ id: recordId });
      }
      case "GET /zones/:id/dns_records":
        return reply([...records].filter(([, record]) => record.name === searchParams.get("name")).map(([recordId]) => ({ id: recordId })));
      case "DELETE /zones/:id/dns_records/:id":
        return records.delete(last) ? reply({}) : reply(null, 404);
    }
    return reply(null, 404);
  };
  return { tunnels, records, most, answer };
}

/** A relay with a fresh database and Apple and Cloudflare faked, and a Sidebots server that sends through it. */
function setup(answerFromApple: () => Response = () => new Response(null, { status: 200 })) {
  // The rate limit lets each network address register three new machines.
  const registered = new Map<string, number>();
  const NEW_MACHINES = { limit: async ({ key }: { key: string }) => ({ success: registered.set(key, (registered.get(key) ?? 0) + 1).get(key)! <= 3 }) };
  const env: Env = {
    DB: fakeD1(),
    APNS_KEY: PUSH_KEY,
    APNS_KEY_ID: "KEY1234567",
    APNS_TEAM_ID: "TEAM123456",
    APNS_TOPICS: "app.sidebots app.sidebots.dev",
    NOTICES_PER_DAY: "3",
    ZONE: "sidebots.app",
    ZONE_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_ACCOUNT_ID: "a3214a4eaf739e455f2179a537fdf54b",
    CLOUDFLARE_API_TOKEN: API_TOKEN,
    TUNNELS: "1000",
    NEW_MACHINES: NEW_MACHINES as RateLimit,
  };
  const cloudflare = fakeCloudflare();
  const toApple: Request[] = [];
  // The relay reaches Apple and Cloudflare the same way.
  const outside = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.startsWith("https://api.cloudflare.com/")) return cloudflare.answer(request);
    toApple.push(request);
    return answerFromApple();
  }) as typeof fetch;
  const toRelay: Request<unknown, unknown>[] = [];
  // The server's module calls the relay with an address and the request's parts.
  const reachRelay = (async (url: string, init?: RequestInit) => {
    const request = new Request(url, init);
    toRelay.push(request.clone());
    return handle(request, env, outside);
  }) as typeof fetch;
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-relay-test-")));
  const server = relay(store, "https://relay.example", 4319, "1.0.13", reachRelay);
  return { env, store, server, send: server.notify, cloudflare, outside, toApple, toRelay };
}

/** A request to the relay signed by a machine, as the server's relay module signs one, from the network address `from`, with `body` when it has one. */
function signed(method: string, path: string, machine: string, privateKey: KeyObject, from = "203.0.113.1", body?: string) {
  const time = String(Date.now());
  const hash = createHash("sha256").update(body ?? "").digest("hex");
  const signature = sign(null, Buffer.from(`${method} ${path}\n${time}\n${hash}`), privateKey).toString("base64url");
  return new Request(`https://relay.example${path}`, { method, headers: { Authorization: `Signature ${machine}:${time}:${signature}`, "CF-Connecting-IP": from }, body });
}

test("a notice for the development build reaches Apple under its app, and one for an app the relay doesn't serve goes nowhere", async () => {
  const { send, toApple } = setup();

  assert.equal(await send({ ...PHONE, app: "app.sidebots.dev" }, NOTICE), "sent");
  assert.equal(toApple.at(-1)!.headers.get("apns-topic"), "app.sidebots.dev");
  assert.equal(await send({ ...PHONE, app: "com.example.other" }, NOTICE), "failed");
  assert.equal(toApple.length, 1);
});

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
  // Apple and the relay see the sealed notice, and words that say nothing about it.
  assert.deepEqual(await delivery.json(), {
    aps: { alert: { title: "Sidebots", body: "New message" }, sound: "sidebots.wav", "mutable-content": 1 },
    sealed: NOTICE.sealed,
  });
  assert.doesNotMatch(await toRelay[1].text(), /Maya|three flats/);
});

test("a request that isn't signed by the machine, or was signed long ago, is refused", async () => {
  const { env, send, outside, toRelay } = setup();
  await send(PHONE, NOTICE);
  const signed = toRelay[1];
  const resend = (headers: Record<string, string>, body?: string) =>
    handle(new Request(signed.url, { method: "POST", headers: { ...Object.fromEntries(signed.headers), ...headers }, body: body ?? NOTICE_BODY }), env, outside);
  const NOTICE_BODY = JSON.stringify({ ...PHONE, ...NOTICE });

  assert.equal((await resend({})).status, 200);
  assert.equal((await resend({}, JSON.stringify({ ...PHONE, ...NOTICE, messageId: "message-2" }))).status, 401);
  assert.equal((await resend({ Authorization: "" })).status, 401);
  assert.equal((await handle(new Request(signed.url, { method: "POST", headers: Object.fromEntries(signed.headers), body: NOTICE_BODY }), env, outside, Date.now() + 6 * 60_000)).status, 401);
});

test("the end of a Live Activity reaches Apple as the avatar's state and nothing else, and leaves the Lock Screen when there is nothing to show", async () => {
  const { send, toApple, toRelay } = setup();
  const ACTIVITY = { token: "d".repeat(256), environment: "sandbox" as const, app: "app.sidebots.dev" };
  const before = Math.floor(Date.now() / 1000);

  assert.equal(await send(ACTIVITY, { ended: "replied" }), "sent");
  const [delivery] = toApple;
  assert.equal(delivery.url, `https://api.sandbox.push.apple.com/3/device/${ACTIVITY.token}`);
  assert.deepEqual(
    ["apns-topic", "apns-push-type", "apns-priority", "apns-collapse-id"].map((header) => delivery.headers.get(header)),
    ["app.sidebots.dev.push-type.liveactivity", "liveactivity", "10", null],
  );
  const { aps, ...beside } = (await delivery.json()) as { aps: { timestamp: number; "dismissal-date": number } };
  assert.deepEqual(beside, {});
  assert.ok(aps.timestamp >= before && aps.timestamp <= before + 5);
  // A reply or a failure stays on the Lock Screen for a quarter of an hour.
  assert.deepEqual(aps, { timestamp: aps.timestamp, event: "end", "content-state": { state: "replied" }, "dismissal-date": aps.timestamp + 15 * 60 });
  assert.deepEqual(JSON.parse(await toRelay.at(-1)!.text()), { ...ACTIVITY, ended: "replied" });

  assert.equal(await send(ACTIVITY, { ended: "resting" }), "sent");
  const resting = ((await toApple[1].json()) as { aps: { timestamp: number; "dismissal-date": number } }).aps;
  assert.equal(resting["dismissal-date"], resting.timestamp);

  // The relay passes on one of the avatar's states, and never words of the server's choosing.
  assert.equal(await send(ACTIVITY, { ended: "working" as "replied" }), "failed");
  assert.equal(await send(ACTIVITY, { ended: "Maya found three flats" as "replied" }), "failed");
  assert.equal(toApple.length, 2);
});

test("word that something was read reaches Apple as a push that wakes the app and says nothing", async () => {
  const { send, toApple, toRelay } = setup();

  assert.equal(await send(PHONE, { read: true }), "sent");
  const [delivery] = toApple;
  assert.equal(delivery.url, `https://api.sandbox.push.apple.com/3/device/${PHONE.token}`);
  assert.deepEqual(
    ["apns-topic", "apns-push-type", "apns-priority", "apns-collapse-id"].map((header) => delivery.headers.get(header)),
    ["app.sidebots", "background", "5", null],
  );
  assert.deepEqual(await delivery.json(), { aps: { "content-available": 1 } });
  assert.deepEqual(JSON.parse(await toRelay.at(-1)!.text()), { ...PHONE, read: true });

  assert.equal(await send(PHONE, { read: "Maya's chat" as unknown as true }), "failed");
  assert.equal(toApple.length, 1);
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

test("a machine quiet for 60 days is removed with its tunnel and address, and registers again with the key it has when it next sends", async () => {
  const { env, store, send, outside, cloudflare } = setup();
  await send(PHONE, NOTICE);
  const { privateKey, id, address } = store.machine()!;
  assert.equal(cloudflare.tunnels.size, 1);

  await removeStale(env, outside, Date.now() + 61 * 24 * 60 * 60_000);
  assert.equal(cloudflare.tunnels.size, 0);
  assert.equal(cloudflare.records.size, 0);
  assert.equal(await send(PHONE, NOTICE), "sent");
  assert.equal(store.machine()!.privateKey, privateKey);
  assert.notEqual(store.machine()!.id, id);
  assert.notEqual(store.machine()!.address, address);
});

test("registering gives a machine a tunnel to its server's port and an address, and registering again brings the same ones", async () => {
  const { store, server, cloudflare } = setup();
  const first = await server.register();
  const again = await server.register();

  assert.match(first.id, /^[a-z0-9]{16}$/);
  assert.equal(first.address, `${first.id}.sidebots.app`);
  assert.deepEqual(again, first);
  assert.deepEqual(store.machine(), first);
  const [[tunnelId, tunnel]] = cloudflare.tunnels;
  assert.equal(cloudflare.tunnels.size, 1);
  assert.equal(first.tunnelToken, `token-for-${tunnelId}`);
  assert.deepEqual(tunnel.ingress, [{ hostname: first.address, service: "http://127.0.0.1:4319" }, { service: "http_status:404" }]);
  assert.deepEqual([...cloudflare.records.values()], [{ type: "CNAME", name: first.address, content: `${tunnelId}.cfargotunnel.com`, proxied: true }]);
});

test("a server that registers with no body gets its id and a tunnel to the usual port", async () => {
  const { env, outside, cloudflare } = setup();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const response = await handle(signed("POST", "/machines", publicKey.export({ format: "jwk" }).x!, privateKey), env, outside);

  assert.equal(response.status, 201);
  assert.match(((await response.json()) as { id: string }).id, /^[a-z0-9]{16}$/);
  assert.equal([...cloudflare.tunnels.values()][0].ingress![0].service, "http://127.0.0.1:4317");
});

test("a server says how much it is used as it registers, a day's count only grows, and a server whose owner turned that off says nothing", async () => {
  const { env, store, server, outside } = setup();
  const kept = async (machineId: string) => ({ ...(await env.DB.prepare("select version, agents, phones from machines where id = ?").bind(machineId).first()) });
  const ran = async (machineId: string) =>
    (await env.DB.prepare("select day, provider, kind, turns from turns where machine_id = ? order by provider, kind").bind(machineId).all()).results.map((row) => ({ ...row }));
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const person = store.addPerson({ name: "Alex", provider: "claude", configDir: "/tmp/claude" });
  const maya = store.createAgent(person, "Maya", "mochi", "claude");
  const theo = store.createAgent(person, "Theo", "mochi", "claude");
  store.pair(store.addPairing(person.id).code, "Alex's phone", "phone");
  store.addUsage(maya.id, "reply", { sessionId: "chat", cost: 1, tokens: 1000 }, false);
  store.addUsage(maya.id, "reply", { sessionId: "chat", cost: 2, tokens: 2000 }, true);
  store.addUsage(maya.id, "job", { sessionId: "job", cost: 1, tokens: 1000 }, false);
  store.addUsage(theo.id, "reply", { sessionId: "chat", cost: 1, tokens: 1000 }, false);
  const { id } = await server.register();
  assert.deepEqual(await kept(id), { version: "1.0.13", agents: 2, phones: 1 });
  const turns = [
    { day, provider: "claude", kind: "job", turns: 1 },
    { day, provider: "claude", kind: "reply", turns: 3 },
  ];
  assert.deepEqual(await ran(id), turns);

  // A deleted agent takes its turns out of the server's count, which is two replies from here, and the relay keeps the day as it stood.
  store.deleteAgent(theo);
  await server.register();
  assert.deepEqual(await kept(id), { version: "1.0.13", agents: 1, phones: 1 });
  assert.deepEqual(await ran(id), turns);

  store.setCounting(false);
  await server.register();
  assert.deepEqual(await kept(id), { version: null, agents: null, phones: null });

  // Counts that come back on start from then, so the relay hears nothing of a turn from the time they were off.
  const codex = store.createAgent(person, "Ruby", "mochi", "codex");
  store.addUsage(codex.id, "reply", { sessionId: "chat", cost: 1, tokens: 1000 }, false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.setCounting(true);
  await server.register();
  assert.deepEqual(await kept(id), { version: "1.0.13", agents: 2, phones: 1 });
  assert.deepEqual(await ran(id), turns);

  // The relay keeps a count, or a provider or kind of turn it knows, and never words of the machine's choosing.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const said = JSON.stringify({
    version: "Maya found three flats",
    agents: -1,
    phones: "two",
    turns: [{ day, provider: "codex", kind: "reply", turns: 4 }, { day, provider: "Maya", kind: "reply", turns: 1 }, { day, provider: "codex", kind: "job", turns: 1.5 }, { day: "2020-01-01", provider: "codex", kind: "memory", turns: 1 }, null],
  });
  const other = (await (await handle(signed("POST", "/machines", publicKey.export({ format: "jwk" }).x!, privateKey, undefined, said), env, outside)).json()) as { id: string };
  assert.deepEqual(await kept(other.id), { version: null, agents: null, phones: null });
  assert.deepEqual(await ran(other.id), [{ day, provider: "codex", kind: "reply", turns: 4 }]);
});

test("a new machine is told the relay has no room when the zone or the account is full, a machine with its tunnel registers all the same, and the relay logs how full both are", async (context) => {
  const { env, server, outside, cloudflare } = setup();
  const errors = context.mock.method(console, "error", () => {});
  const logged = () => errors.mock.calls.map((call) => String(call.arguments[0]));
  const another = async (send = outside) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const response = await handle(signed("POST", "/machines", publicKey.export({ format: "jwk" }).x!, privateKey), env, send);
    return [response.status, ((await response.json()) as { error?: string }).error];
  };

  // The zone has no DNS record left, so the server's own log says why it has no address.
  cloudflare.most.records = 0;
  await assert.rejects(server.register(), { message: "The relay answered 503 to registering: The relay has no room for another machine." });
  assert.equal(cloudflare.tunnels.size, 0);
  assert.match(logged()[0], /Cloudflare answered 400 to POST \/zones\/\w+\/dns_records: Cloudflare's words\./);
  assert.equal(logged()[1], "The relay has no room for another machine. The zone holds 0 of 0 DNS records, and the account 0 of 1000 tunnels.");

  // A machine that takes the zone's last record, and whose tunnel then fails to take its route, has its record all the same.
  cloudflare.most.records = 1;
  const unrouted = ((input, init) => (String(input).endsWith("/configurations") ? Response.json({ success: false }, { status: 500 }) : outside(input, init))) as typeof fetch;
  assert.deepEqual(await another(unrouted), [502, "The relay couldn't make the machine's tunnel."]);

  // A zone with room again takes the machine as it tries again.
  cloudflare.most.records = 200;
  const { id } = await server.register();

  // Cloudflare refuses a tunnel while the zone and the account have room, which is some other failure.
  cloudflare.most.tunnels = 2;
  assert.deepEqual(await another(), [502, "The relay couldn't make the machine's tunnel."]);

  // The account has no tunnel left.
  env.TUNNELS = "2";
  assert.deepEqual(await another(), [503, "The relay has no room for another machine."]);
  assert.equal(logged().at(-1), "The relay has no room for another machine. The zone holds 2 of 200 DNS records, and the account 2 of 2 tunnels.");
  assert.equal((await server.register()).id, id);

  const log = context.mock.method(console, "log", () => {});
  await logRoom(env, outside);
  assert.deepEqual(log.mock.calls.map((call) => call.arguments[0]), ["The zone holds 2 of 200 DNS records, and the account 2 of 2 tunnels."]);
});

test("one network address registers three new machines a minute, and a machine it registered can always come back", async () => {
  const { env, outside } = setup();
  const keys = Array.from({ length: 4 }, () => generateKeyPairSync("ed25519"));
  const register = async ({ privateKey, publicKey }: (typeof keys)[number], from = "198.51.100.7") =>
    (await handle(signed("POST", "/machines", publicKey.export({ format: "jwk" }).x!, privateKey, from), env, outside)).status;

  assert.deepEqual([await register(keys[0]), await register(keys[1]), await register(keys[2]), await register(keys[3])], [201, 201, 201, 429]);
  assert.equal(await register(keys[0]), 201);
  assert.equal(await register(keys[3], "198.51.100.8"), 201);
});

test("a machine removes itself with its tunnel and address, and can't remove another", async () => {
  const { env, outside, cloudflare, server } = setup();
  const mine = await server.register();
  const myKey = createPrivateKey(mine.privateKey);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const other = (await (await handle(signed("POST", "/machines", publicKey.export({ format: "jwk" }).x!, privateKey), env, outside)).json()) as { id: string };
  const remove = async (id: string, as: string, key: KeyObject) => (await handle(signed("DELETE", `/machines/${id}`, as, key), env, outside)).status;

  assert.equal(await remove(other.id, mine.id, myKey), 403);
  assert.equal(await remove(mine.id, mine.id, privateKey), 401);
  assert.equal(await remove(mine.id, mine.id, myKey), 204);
  assert.equal(cloudflare.tunnels.size, 1);
  assert.deepEqual([...cloudflare.records.values()].map((record) => record.name), [`${other.id}.sidebots.app`]);
  assert.equal(await remove(mine.id, mine.id, myKey), 404);
});
