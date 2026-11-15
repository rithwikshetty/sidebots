// Starts the Julius server, or adds a person with `add-person`.

import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { openStore } from "./store.ts";
import { claudeTurn, createQueue } from "./runner.ts";
import { createApi } from "./api.ts";

const home = process.env.JULIUS_HOME ?? join(homedir(), ".julius");
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

const queue = createQueue(store, claudeTurn);
for (const agentId of store.requeueInterrupted()) void queue.kick(agentId);

const port = Number(process.env.PORT ?? 4317);
// Local only. `tailscale serve` publishes it to our own devices.
serve({ fetch: createApi(store, queue).fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`Julius is listening on http://127.0.0.1:${port}, with data in ${home}`);
});
