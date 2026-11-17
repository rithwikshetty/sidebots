import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../src/store.ts";

test("a database made before the table changes gets them and keeps what it holds", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  // The tables the changes touch, as the first published version made them, with an agent, a phone that allows notifications, and an API key as that version saved one.
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
    insert into people values ('me', 'Rithwik', '/tmp/claude');
    insert into agents (id, person_id, name, avatar_id, created_at) values ('scout', 'me', 'Scout', 'mochi', 1);
    insert into devices values ('phone', 'me', 'phone', 'hash', 'key', '${"a".repeat(64)}', 'production', 1);
  `);
  old.close();
  writeFileSync(join(home, "api-keys.json"), JSON.stringify({ me: "sk-ant-key" }));

  const store = openStore(home);
  assert.deepEqual(store.agentsFor("me").map((agent) => [agent.name, agent.provider, agent.color]), [["Scout", "claude", null]]);
  assert.deepEqual(store.people().map((person) => ({ ...person })), [{ id: "me", name: "Rithwik" }]);
  assert.deepEqual(store.accounts("me").map((account) => ({ ...account })), [{ person_id: "me", provider: "claude", config_dir: "/tmp/claude" }]);
  assert.equal(store.apiKey("me", "claude"), "sk-ant-key");
  assert.deepEqual(store.pushTargetsFor("me"), [{ token: "a".repeat(64), environment: "production", notificationKey: "key" }]);
  store.setPushToken("phone", { token: "b".repeat(64), environment: "sandbox", app: "app.sidebots.dev" });
  assert.deepEqual(store.pushTargetsFor("me"), [{ token: "b".repeat(64), environment: "sandbox", app: "app.sidebots.dev", notificationKey: "key" }]);

  // Opened again, it has every change already.
  const again = openStore(home);
  assert.deepEqual(again.pushTargetsFor("me"), store.pushTargetsFor("me"));
  assert.deepEqual(again.accounts("me"), store.accounts("me"));
});
