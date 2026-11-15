// Starts the Simon server. `add-person` adds a person, `api-key` has a person's agents run on an
// Anthropic API key, and `push-key` sets the key for notifications.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { openStore } from "./store.ts";
import { claudeTurn, createQueue } from "./runner.ts";
import { createApi } from "./api.ts";
import { apns, startPush } from "./push.ts";

const home = process.env.SIMON_HOME ?? join(homedir(), ".simon");
const store = openStore(home);

if (process.argv[2] === "add-person") {
  const [login, name, configDir] = process.argv.slice(3);
  if (!login || !name || !configDir) {
    console.error("usage: node src/main.ts add-person <tailscale-login> <name> <claude-config-dir>");
    process.exit(1);
  }
  const person = store.addPerson({ login, name, configDir });
  console.log(`Added ${person.name} (${person.tailscale_login}).`);
  process.exit(0);
}

if (process.argv[2] === "api-key") {
  const [login, path] = process.argv.slice(3);
  // The key comes in a file, so it is never typed into a command the shell remembers.
  const key = path && readFileSync(path, "utf8").trim();
  if (!login || !key) {
    console.error("usage: node src/main.ts api-key <tailscale-login> <file-holding-the-key>");
    process.exit(1);
  }
  const person = store.personByLogin(login);
  if (!person) {
    console.error(`Nobody on this server has the Tailscale login ${login}. Add them first with \`pnpm add-person\`.`);
    process.exit(1);
  }
  store.setApiKey(person.id, key);
  console.log(`${person.name}'s agents now run on that API key.`);
  process.exit(0);
}

if (process.argv[2] === "push-key") {
  const [path, teamId] = process.argv.slice(3);
  // Apple names the file it downloads after the key's ID.
  const keyId = path && /^AuthKey_(\w+)\.p8$/.exec(basename(path))?.[1];
  if (!keyId || !teamId) {
    console.error("usage: node src/main.ts push-key <AuthKey_XXXXXXXXXX.p8> <apple-team-id>");
    process.exit(1);
  }
  store.setPushKey({ keyId, teamId, key: readFileSync(path, "utf8") });
  console.log(`Saved push key ${keyId}. Restart the server to use it.`);
  process.exit(0);
}

store.installStarterAvatars(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "avatars"));
const queue = createQueue(store, claudeTurn);
for (const agentId of store.requeueInterrupted()) void queue.kick(agentId);
queue.startClock();

const pushKey = store.pushKey();
if (pushKey) startPush(store, apns(pushKey));
else console.log("Notifications are off. Turn them on with `pnpm push-key <AuthKey_XXXXXXXXXX.p8> <apple-team-id>`.");

const port = Number(process.env.PORT ?? 4317);
// Local only. `tailscale serve` publishes it to our own devices.
serve({ fetch: createApi(store, queue).fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`Simon is listening on http://127.0.0.1:${port}, with data in ${home}`);
});
