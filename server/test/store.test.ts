import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { openStore } from "../src/store.ts";

test("a database made before the table changes gets them and keeps what it holds", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  // The tables the changes touch, as the first published version made them, with an agent, a message, a phone that allows notifications, and an API key as that version saved one.
  const old = new DatabaseSync(join(home, "sidebots.sqlite"));
  old.exec(`
    create table people (id text primary key, name text not null unique, claude_config_dir text not null);
    create table devices (
      id text primary key, person_id text not null references people(id), name text not null, key_hash text not null unique,
      notification_key text not null, push_token text, environment text check (environment in ('sandbox', 'production')), paired_at integer not null
    );
    create table agents (
      id text primary key, person_id text not null references people(id), name text not null, avatar_id text not null,
      model text not null default 'opus', effort text not null default 'medium', muted integer not null default 0,
      hidden integer not null default 0, session_id text, read_at integer not null default 0, created_at integer not null
    );
    create table messages (
      id text primary key, agent_id text not null references agents(id), sender text not null check (sender in ('person', 'agent', 'sidebots')),
      body text not null, attachments text not null default '[]', status text not null check (status in ('queued', 'running', 'done', 'failed')),
      seen_at integer, reply_to text, job_id text, interim integer not null default 0, created_at integer not null
    );
    insert into people values ('me', 'Rithwik', '/tmp/claude');
    insert into agents (id, person_id, name, avatar_id, created_at) values ('maya', 'me', 'Maya', 'mochi', 1);
    insert into messages (id, agent_id, sender, body, status, created_at) values ('hello', 'maya', 'agent', 'Hello.', 'done', 2);
    insert into devices values ('phone', 'me', 'phone', 'hash', 'key', '${"a".repeat(64)}', 'production', 1);
  `);
  old.close();
  writeFileSync(join(home, "api-keys.json"), JSON.stringify({ me: "sk-ant-key" }));

  const store = openStore(home);
  assert.deepEqual(store.agentsFor("me").map((agent) => [agent.name, agent.provider, agent.color]), [["Maya", "claude", null]]);
  assert.deepEqual(store.messages("maya").map((message) => [message.body, message.ask]), [["Hello.", null]]);
  assert.deepEqual(store.people().map((person) => ({ ...person })), [{ id: "me", name: "Rithwik" }]);
  assert.deepEqual(store.accounts("me").map((account) => ({ ...account })), [{ person_id: "me", provider: "claude", config_dir: "/tmp/claude" }]);
  assert.equal(store.apiKey("me", "claude"), "sk-ant-key");
  assert.deepEqual(store.pushTargetsFor("me"), [{ token: "a".repeat(64), environment: "production", notificationKey: "key" }]);
  assert.deepEqual(store.devices().map((device) => [device.id, device.kind]), [["phone", "phone"]]);
  store.setPushToken("phone", { token: "b".repeat(64), environment: "sandbox", app: "app.sidebots.dev" });
  assert.deepEqual(store.pushTargetsFor("me"), [{ token: "b".repeat(64), environment: "sandbox", app: "app.sidebots.dev", notificationKey: "key" }]);

  // Opened again, it has every change already.
  const again = openStore(home);
  assert.deepEqual(again.pushTargetsFor("me"), store.pushTargetsFor("me"));
  assert.deepEqual(again.accounts("me"), store.accounts("me"));
});

test("the count of paired phones the relay hears leaves the desktop app out", () => {
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-store-test-")));
  const person = store.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" });
  store.pair(store.addPairing(person.id).code, "Alex's Mac", "desktop");
  assert.equal(store.counts().phones, 0);
  store.pair(store.addPairing(person.id).code, "iPhone", "phone");
  store.pair(store.addPairing(person.id).code, "iPad", "phone");
  assert.equal(store.counts().phones, 2);
  assert.equal(store.devices().length, 3);
});

test("a database a newer Sidebots has changed keeps its count of changes when an older one opens it", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  openStore(home).close();
  const database = () => new DatabaseSync(join(home, "sidebots.sqlite"));
  const count = () => {
    const db = database();
    const { user_version } = db.prepare("pragma user_version").get() as { user_version: number };
    db.close();
    return user_version;
  };
  // A newer Sidebots made one change more than this one knows.
  const newer = count() + 1;
  const db = database();
  db.exec(`pragma user_version = ${newer}`);
  db.close();
  openStore(home).close();
  assert.equal(count(), newer);
});

test("several that open a new database at once all open it", async () => {
  // The Mac app starts the server and runs its `status` command at the same moment, on a database neither has made yet. One of them fails only some of the times, so this makes several databases.
  for (let round = 0; round < 6; round++) {
    const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
    const opens = `import { openStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)}; openStore(${JSON.stringify(home)}).close();`;
    const ends = Array.from({ length: 8 }, async () => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", opens], { stdio: ["ignore", "ignore", "pipe"] });
      let failure = "";
      child.stderr.on("data", (chunk) => (failure += chunk));
      const [code] = await once(child, "exit");
      return code === 0 ? "" : failure;
    });
    assert.deepEqual(await Promise.all(ends), Array(8).fill(""));
  }
});

test("two that open an older database at once make its changes once", async () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  openStore(home).close();
  // The database as it was before its last change, in the hands of one that has begun to make the change.
  const first = new DatabaseSync(join(home, "sidebots.sqlite"));
  first.exec("alter table devices drop column kind; pragma user_version = 11; begin immediate");
  // Another process opens the database meanwhile, as the Mac app's `status` command does beside the server.
  const opens = `import { openStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)}; console.log("opening"); openStore(${JSON.stringify(home)}).close();`;
  const second = spawn(process.execPath, ["--input-type=module", "--eval", opens], { stdio: ["ignore", "pipe", "pipe"] });
  let failure = "";
  second.stderr.on("data", (chunk) => (failure += chunk));
  const ended = once(second, "exit");
  await once(second.stdout, "data");
  // It has had the time to see how the database stands before the first is done.
  await wait(500);
  first.exec("alter table devices add column kind text not null default 'phone' check (kind in ('phone', 'desktop')); pragma user_version = 12; commit");
  first.close();
  assert.deepEqual(await ended, [0, null], failure);
});

test("a database that counted turns without their tokens keeps the turns, and counts tokens from the next turn of a session", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  const fresh = openStore(home);
  const person = fresh.addPerson({ name: "Rithwik", provider: "claude", configDir: "/tmp/claude" });
  const agent = fresh.createAgent(person, "Maya", "mochi", "claude");
  fresh.close();
  // The database as it was before the usage table counted tokens, with a turn of a session that cost $2.
  const old = new DatabaseSync(join(home, "sidebots.sqlite"));
  old.exec(`
    alter table usage drop column tokens;
    alter table usage drop column session_tokens;
    alter table devices drop column kind;
    insert into usage values ('${agent.id}', 'reply', 2, 'chat', 2, ${Date.now()});
    pragma user_version = 8;
  `);
  old.close();

  const store = openStore(home);
  // Nobody can tell how many of the session's 900,000 tokens the next turn used, so it counts from the one after.
  store.addUsage(agent.id, "reply", { sessionId: "chat", cost: 3, tokens: 900_000 }, true);
  store.addUsage(agent.id, "reply", { sessionId: "chat", cost: 3.5, tokens: 950_000 }, true);
  assert.deepEqual(store.usage(person.id, []).used.map((used) => ({ ...used })), [{ agent_id: agent.id, kind: "reply", turns: 3, cost: 3.5, tokens: 50_000 }]);
});

test("a Codex session from before the connections' tools, or before those tools changed, gets a fresh start, since a Codex chat keeps the tools it started with", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  const fresh = openStore(home);
  const person = fresh.addPerson({ name: "Rithwik", provider: "claude", configDir: "/tmp/claude" });
  fresh.addAccount(person.id, "codex", "/tmp/codex");
  const [maya, theo, ruby] = [fresh.createAgent(person, "Maya", "mochi", "codex"), fresh.createAgent(person, "Theo", "mochi", "codex"), fresh.createAgent(person, "Ruby", "mochi", "claude")];
  // Maya and Ruby are in the middle of a session. Theo has yet to start one.
  fresh.setSession(maya.id, "thread-1");
  fresh.setSession(ruby.id, "session-1");
  fresh.close();
  // The database as it was before the fresh starts: without them, and without the change made after them.
  const old = new DatabaseSync(join(home, "sidebots.sqlite"));
  old.exec("alter table devices drop column kind; pragma user_version = 10");
  old.close();

  const store = openStore(home);
  assert.deepEqual([maya, theo, ruby].map((agent) => store.nextQueued(agent.id)?.body), ["Fresh start", undefined, undefined]);
  assert.deepEqual(store.requeueInterrupted(), [maya.id]);
  // One fresh start is enough for the tools and for their change, and a database that has had the changes doesn't get them again.
  store.close();
  const again = openStore(home);
  assert.equal(again.messages(maya.id).length, 1);
  again.close();

  // The database as it was once the session had its fresh start and went on, before the tools changed.
  const later = new DatabaseSync(join(home, "sidebots.sqlite"));
  later.exec("update messages set status = 'done'; pragma user_version = 12");
  later.close();
  assert.equal(openStore(home).messages(maya.id).length, 2);
});
