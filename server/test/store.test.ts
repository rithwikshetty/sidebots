import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../src/store.ts";

test("a database made before a table change gets the change and keeps what it holds", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  // The people and devices tables as the first published version made them, with a phone that allows notifications.
  const old = new DatabaseSync(join(home, "sidebots.sqlite"));
  old.exec(`
    create table people (id text primary key, name text not null unique, claude_config_dir text not null);
    create table devices (
      id text primary key, person_id text not null references people(id), name text not null, key_hash text not null unique,
      notification_key text not null, push_token text, environment text check (environment in ('sandbox', 'production')), paired_at integer not null
    );
    insert into people values ('me', 'Rithwik', '/tmp/claude');
    insert into devices values ('phone', 'me', 'iPhone', 'hash', 'key', '${"a".repeat(64)}', 'production', 1);
  `);
  old.close();

  const store = openStore(home);
  assert.deepEqual(store.pushTargetsFor("me"), [{ token: "a".repeat(64), environment: "production", notificationKey: "key" }]);
  store.setPushToken("phone", { token: "b".repeat(64), environment: "sandbox", app: "app.sidebots.dev" });
  assert.deepEqual(store.pushTargetsFor("me"), [{ token: "b".repeat(64), environment: "sandbox", app: "app.sidebots.dev", notificationKey: "key" }]);

  // Opened again, it has every change already.
  assert.deepEqual(openStore(home).pushTargetsFor("me"), store.pushTargetsFor("me"));
});
