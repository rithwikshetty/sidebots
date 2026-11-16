// Starts the Sidebots server. `add-person` adds a person, `api-key` has a person's agents run on an
// Anthropic API key, `pair` makes the code a phone pairs with, and `push-key` sets the key for notifications.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import qrcode from "qrcode-terminal";
import { openStore, type Person } from "./store.ts";
import { claudeTurn, createQueue } from "./runner.ts";
import { createApi } from "./api.ts";
import { apns, startPush } from "./push.ts";

const home = process.env.SIDEBOTS_HOME ?? join(homedir(), ".sidebots");
const store = openStore(home);

/** The person a command names. The command ends when nobody on this server has the name. */
function personNamed(name: string): Person {
  const person = store.personByName(name);
  if (!person) {
    console.error(`Nobody on this server is called ${name}. Add them first with \`pnpm add-person\`.`);
    process.exit(1);
  }
  return person;
}

if (process.argv[2] === "add-person") {
  const [name, configDir] = process.argv.slice(3);
  if (!name || !configDir) {
    console.error("usage: node src/main.ts add-person <name> <claude-config-dir>");
    process.exit(1);
  }
  if (store.personByName(name)) {
    console.error(`Somebody on this server is already called ${name}.`);
    process.exit(1);
  }
  console.log(`Added ${store.addPerson({ name, configDir }).name}.`);
  process.exit(0);
}

if (process.argv[2] === "api-key") {
  const [name, path] = process.argv.slice(3);
  // The key comes in a file, so it is never typed into a command the shell remembers.
  const key = path && readFileSync(path, "utf8").trim();
  if (!name || !key) {
    console.error("usage: node src/main.ts api-key <person> <file-holding-the-key>");
    process.exit(1);
  }
  const person = personNamed(name);
  store.setApiKey(person.id, key);
  console.log(`${person.name}'s agents now run on that API key.`);
  process.exit(0);
}

if (process.argv[2] === "pair") {
  const { values, positionals } = parseArgs({ args: process.argv.slice(3), options: { host: { type: "string" } }, allowPositionals: true });
  // The address the phone reaches this server at, without `https://`.
  const host = values.host?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!positionals[0] || !host) {
    console.error("usage: node src/main.ts pair <person> --host <address-the-phone-reaches>");
    process.exit(1);
  }
  const person = personNamed(positionals[0]);
  const link = `sidebots://pair?host=${encodeURIComponent(host)}&code=${store.addPairing(person.id)}`;
  qrcode.generate(link, { small: true });
  console.log(link);
  console.log(`Scan the code in Sidebots on ${person.name}'s phone, or enter the link there. It pairs one phone, within ten minutes.`);
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

// The machine's name as its owner knows it. macOS keeps one apart from the network's name for the machine.
const machine = process.platform === "darwin" ? execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim() : hostname();
const port = Number(process.env.PORT ?? 4317);
// Local only. `tailscale serve` publishes it to our own devices.
serve({ fetch: createApi(store, queue, machine).fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`Sidebots is listening on http://127.0.0.1:${port}, with data in ${home}`);
});
