// Starts the Sidebots server. `add-person` adds a person, `api-key` has a person's agents run on an
// Anthropic API key, `pair` makes the code a phone pairs with, `devices` lists the paired phones,
// `remove-device` unpairs one, and `status` says whether the server is running and how each person's
// agents sign in to Claude. With `--json`, `pair`, `devices` and `status` print what the Mac app reads.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import qrcode from "qrcode-terminal";
import { openStore, type Person } from "./store.ts";
import { CONTRACT_HEADER } from "./contract.ts";
import { claudeTurn, createQueue } from "./runner.ts";
import { createApi } from "./api.ts";
import { startPush } from "./push.ts";
import { relay } from "./relay.ts";
import { startTunnel } from "./tunnel.ts";

const home = process.env.SIDEBOTS_HOME ?? join(homedir(), ".sidebots");
const port = Number(process.env.PORT ?? 4317);
const store = openStore(home);
const { values: options, positionals } = parseArgs({
  args: process.argv.slice(3),
  options: { host: { type: "string" }, remove: { type: "boolean" }, json: { type: "boolean" } },
  allowPositionals: true,
});

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
  const [name, configDir] = positionals;
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
  const [name, path] = positionals;
  // The key comes in a file, so it is never typed into a command the shell remembers.
  const key = path && readFileSync(path, "utf8").trim();
  if (!name || (!key && !options.remove)) {
    console.error("usage: node src/main.ts api-key <person> <file-holding-the-key>, or api-key <person> --remove");
    process.exit(1);
  }
  const person = personNamed(name);
  store.setApiKey(person.id, options.remove ? null : key);
  console.log(options.remove ? `${person.name}'s agents now run on the Claude login in ${person.claude_config_dir}.` : `${person.name}'s agents now run on that API key.`);
  process.exit(0);
}

if (process.argv[2] === "pair") {
  // The address the phone reaches this server at, without `https://`. It is the machine's own address unless `--host` names another.
  const host = (options.host ?? store.machine()?.address)?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!positionals[0] || !host) {
    console.error("usage: node src/main.ts pair <person> --host <address-the-phone-reaches>. `--host` can be left out once the relay has given this machine an address.");
    process.exit(1);
  }
  const person = personNamed(positionals[0]);
  const { code, expiresAt } = store.addPairing(person.id);
  const link = `sidebots://pair?host=${encodeURIComponent(host)}&code=${code}`;
  if (options.json) {
    console.log(JSON.stringify({ link, expires_at: expiresAt }));
    process.exit(0);
  }
  qrcode.generate(link, { small: true });
  console.log(link);
  console.log(`Scan the code in Sidebots on ${person.name}'s phone, or enter the link there. It pairs one phone, within ten minutes.`);
  process.exit(0);
}

if (process.argv[2] === "devices") {
  const devices = store.devices().map((device) => ({ ...device, person: store.person(device.person_id)!.name }));
  if (options.json) console.log(JSON.stringify(devices));
  else if (devices.length === 0) console.log("No phones are paired with this server.");
  else for (const device of devices) console.log(`${device.id}  ${device.name}, ${device.person}'s, paired ${new Date(device.paired_at).toLocaleString()}`);
  process.exit(0);
}

if (process.argv[2] === "remove-device") {
  if (!positionals[0]) {
    console.error("usage: node src/main.ts remove-device <device-id>, with the id `devices` shows");
    process.exit(1);
  }
  const device = store.removeDevice(positionals[0]);
  if (!device) {
    console.error(`No phone paired with this server has the id ${positionals[0]}.`);
    process.exit(1);
  }
  console.log(`Removed ${device.name}. It needs a new code to pair again.`);
  process.exit(0);
}

if (process.argv[2] === "status") {
  // Sidebots names its contract version on every answer, refusals included. The address refuses a request with no `Authorization` header before it reaches the server.
  const answers = (origin: string) =>
    fetch(`${origin}/agents`, { headers: { Authorization: "Bearer status" }, signal: AbortSignal.timeout(5000) }).then(
      (response) => response.headers.has(CONTRACT_HEADER),
      () => false,
    );
  const address = store.machine()?.address ?? null;
  const status = {
    running: await answers(`http://127.0.0.1:${port}`),
    address,
    // Whether a phone reaches the server at its address. Null until it has one.
    reachable: address ? await answers(`https://${address}`) : null,
    people: store.people().map((person) => ({
      name: person.name,
      config_dir: person.claude_config_dir,
      sign_in: store.apiKey(person.id) ? "api-key" : "claude",
    })),
  };
  if (options.json) {
    console.log(JSON.stringify(status));
    process.exit(0);
  }
  console.log(status.running ? `Sidebots is running on port ${port}.` : `Sidebots isn't running on port ${port}.`);
  if (address) console.log(status.reachable ? `Phones reach it at ${address}.` : `Phones can't reach it at ${address}.`);
  for (const person of status.people) {
    console.log(person.sign_in === "api-key" ? `${person.name}'s agents run on an API key.` : `${person.name}'s agents run on the Claude login in ${person.config_dir}.`);
  }
  process.exit(0);
}

store.installStarterAvatars(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "avatars"));
const queue = createQueue(store, claudeTurn);
for (const agentId of store.requeueInterrupted()) void queue.kick(agentId);
queue.startClock();

// The relay gives the machine its address and tunnel, and passes notifications to Apple. `off` uses neither, for a server reached some other way.
const relayOrigin = process.env.SIDEBOTS_RELAY ?? "https://relay.sidebots.app";
if (relayOrigin !== "off") {
  const toRelay = relay(store, relayOrigin, port);
  startPush(store, toRelay.notify);
  const stopTunnel = startTunnel(store, toRelay.register, process.env.SIDEBOTS_CLOUDFLARED ?? "cloudflared");
  // `cloudflared` runs apart from the server, so it would outlive a server that is stopped. The server stops it first.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      stopTunnel();
      process.exit(0);
    });
  }
} else console.log("The tunnel and notifications are off, as SIDEBOTS_RELAY is off.");

// The machine's name as its owner knows it. macOS keeps one apart from the network's name for the machine.
const machine = process.platform === "darwin" ? execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim() : hostname();
// Local only. The tunnel, or `tailscale serve`, brings the phone's requests here.
serve({ fetch: createApi(store, queue, machine).fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`Sidebots is listening on http://127.0.0.1:${port}, with data in ${home}`);
});
