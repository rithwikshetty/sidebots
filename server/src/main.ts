// Starts the Sidebots server, which with `--with-parent` ends when the program that started it does. `add-person` adds a person with the agent they start with, `add-account` sets a person up on another
// provider, `api-key` has a person's agents on a provider run on an API key, `pair` makes the code a
// device pairs with, `devices` lists the paired devices, `remove-device` unpairs one, and `status` says
// whether the server is running and how each person's agents sign in to their providers. `counts`
// turns on or off what the server tells the relay of how much it is used.
// `providers` says which providers' programs are on this computer, `install` runs a provider's own
// installer, `sign-in` runs a provider's own sign-in in a config folder, and `signed-in` says whether
// that folder is signed in, and whether with an API key. With `--json`, `pair`, `devices`, `status`, `providers` and `signed-in`
// print what the Mac app and the desktop app read.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import qrcode from "qrcode-terminal";
import { openStore, type Person } from "./store.ts";
import { CONTRACT_HEADER, PROVIDERS, avatarStateOf, type Provider } from "./contract.ts";
import { createConnections } from "./connections.ts";
import { addFirstAgent, createQueue } from "./runner.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { PROGRAMS, configDir, install, installed, login, signIn } from "./programs.ts";
import { createApi } from "./api.ts";
import { startPush } from "./push.ts";
import { relay } from "./relay.ts";
import { startTunnel } from "./tunnel.ts";

const home = process.env.SIDEBOTS_HOME ?? join(homedir(), ".sidebots");
const port = Number(process.env.PORT ?? 4317);
const store = openStore(home);
const { values: options, positionals } = parseArgs({
  args: process.argv.slice(3),
  options: { host: { type: "string" }, days: { type: "string" }, remove: { type: "boolean" }, json: { type: "boolean" } },
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

/** The provider a command names. The command ends when Sidebots has no provider by that id. */
function providerNamed(id: string | undefined): Provider {
  if (!id || !Object.hasOwn(PROVIDERS, id)) {
    console.error(`Sidebots runs agents on ${Object.keys(PROVIDERS).join(", ")}. Name one of them.`);
    process.exit(1);
  }
  return id as Provider;
}

if (process.argv[2] === "add-person") {
  const [name, providerId, configDir] = positionals;
  if (!name || !configDir) {
    console.error("usage: node src/main.ts add-person <name> <provider> <config-dir>");
    process.exit(1);
  }
  const provider = providerNamed(providerId);
  if (store.personByName(name)) {
    console.error(`Somebody on this server is already called ${name}.`);
    process.exit(1);
  }
  const person = store.addPerson({ name, provider, configDir });
  const first = addFirstAgent(store, person);
  console.log(`Added ${person.name}, whose agents run on ${PROVIDERS[provider].name}. They start with ${first.name}, who briefs them every morning at 8.`);
  process.exit(0);
}

if (process.argv[2] === "add-account") {
  const [name, providerId, configDir] = positionals;
  if (!name || !configDir) {
    console.error("usage: node src/main.ts add-account <person> <provider> <config-dir>");
    process.exit(1);
  }
  const person = personNamed(name);
  const provider = providerNamed(providerId);
  const account = store.account(person.id, provider);
  if (account) {
    console.error(`${person.name} has already set up ${PROVIDERS[provider].name}, in ${account.config_dir}.`);
    process.exit(1);
  }
  store.addAccount(person.id, provider, configDir);
  console.log(`${person.name} can now add agents that run on ${PROVIDERS[provider].name}.`);
  process.exit(0);
}

if (process.argv[2] === "api-key") {
  const [name, providerId, path] = positionals;
  // The key comes in a file, so it is never typed into a command the shell remembers.
  const key = path && readFileSync(path, "utf8").trim();
  if (!name || (!key && !options.remove)) {
    console.error("usage: node src/main.ts api-key <person> <provider> <file-holding-the-key>, or api-key <person> <provider> --remove");
    process.exit(1);
  }
  const person = personNamed(name);
  const provider = providerNamed(providerId);
  const account = store.account(person.id, provider);
  if (!account) {
    console.error(`${person.name} hasn't set up ${PROVIDERS[provider].name}.`);
    process.exit(1);
  }
  store.setApiKey(person.id, provider, options.remove ? null : key);
  const on = PROVIDERS[provider].name;
  console.log(options.remove ? `${person.name}'s agents on ${on} now run on the login in ${account.config_dir}.` : `${person.name}'s agents on ${on} now run on that API key.`);
  process.exit(0);
}

if (process.argv[2] === "pair") {
  // The address the phone reaches this server at, without `https://`. It is the machine's own address unless `--host` names another.
  const host = (options.host ?? store.machine()?.address)?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  // How many days the code works for, for a phone that pairs later than ten minutes from now, as App Review's does.
  const days = options.days === undefined ? undefined : Number(options.days);
  const life = days === undefined ? undefined : days * 24 * 60 * 60_000;
  if (!positionals[0] || !host || (life !== undefined && !(life > 0 && Number.isFinite(life)))) {
    console.error(
      "usage: node src/main.ts pair <person> --host <address-the-phone-reaches> --days <how-many-days-the-code-works>. `--host` can be left out once the relay has given this machine an address. Without `--days`, the code works for ten minutes.",
    );
    process.exit(1);
  }
  const person = personNamed(positionals[0]);
  const { code, expiresAt } = store.addPairing(person.id, life);
  const link = `sidebots://pair?host=${encodeURIComponent(host)}&code=${code}`;
  if (options.json) {
    console.log(JSON.stringify({ link, expires_at: expiresAt }));
    process.exit(0);
  }
  qrcode.generate(link, { small: true });
  console.log(link);
  console.log(`Scan the code in Sidebots on ${person.name}'s phone, or enter the link there. It pairs one phone, within ${days === undefined ? "ten minutes" : days === 1 ? "a day" : `${days} days`}.`);
  process.exit(0);
}

if (process.argv[2] === "devices") {
  const devices = store.devices().map((device) => ({ ...device, person: store.person(device.person_id)!.name }));
  if (options.json) console.log(JSON.stringify(devices));
  else if (devices.length === 0) console.log("No devices are paired with this server.");
  else for (const device of devices) console.log(`${device.id}  ${device.name}, ${device.person}'s ${device.kind}, paired ${new Date(device.paired_at).toLocaleString()}`);
  process.exit(0);
}

if (process.argv[2] === "remove-device") {
  if (!positionals[0]) {
    console.error("usage: node src/main.ts remove-device <device-id>, with the id `devices` shows");
    process.exit(1);
  }
  const device = store.removeDevice(positionals[0]);
  if (!device) {
    console.error(`No device paired with this server has the id ${positionals[0]}.`);
    process.exit(1);
  }
  console.log(`Removed ${device.name}. It needs a new code to pair again.`);
  process.exit(0);
}

if (process.argv[2] === "counts") {
  if (positionals[0] !== "on" && positionals[0] !== "off") {
    console.error("usage: node src/main.ts counts on, or counts off");
    process.exit(1);
  }
  store.setCounting(positionals[0] === "on");
  console.log(
    store.counting()
      ? "As it registers, this server tells the relay the version of the Mac app it runs in, how many agents and paired phones it has, and how many turns its agents ran each day, by provider and kind of turn."
      : "This server tells the relay nothing of how much it is used.",
  );
  process.exit(0);
}

if (process.argv[2] === "providers") {
  // Each provider's program on this computer: its version when it is installed, whether its driver works with that version, the oldest that it does, the installer its maker publishes, and the config folder it uses here.
  const providers = await Promise.all(
    (Object.keys(PROVIDERS) as Provider[]).map(async (provider) => {
      const found = await installed(provider);
      return {
        provider,
        name: PROVIDERS[provider].name,
        path: found?.path ?? null,
        version: found?.version ?? null,
        supported: found?.supported ?? false,
        oldest: PROGRAMS[provider].oldest,
        installer: PROGRAMS[provider].installer,
        config_dir: configDir(provider),
      };
    }),
  );
  if (options.json) console.log(JSON.stringify(providers));
  else {
    for (const { name, path, version, supported, oldest, installer } of providers) {
      if (!path) console.log(`${name} isn't installed. Its installer: ${installer}`);
      else console.log(supported ? `${name} ${version} is at ${path}.` : `${name} ${version} is at ${path}. Sidebots needs ${oldest} or later.`);
    }
  }
  process.exit(0);
}

if (process.argv[2] === "install") {
  process.exit(await install(providerNamed(positionals[0])));
}

if (process.argv[2] === "sign-in" || process.argv[2] === "signed-in") {
  const [providerId, folder] = positionals;
  if (!folder) {
    console.error(`usage: node src/main.ts ${process.argv[2]} <provider> <config-dir>`);
    process.exit(1);
  }
  const provider = providerNamed(providerId);
  try {
    if (process.argv[2] === "sign-in") {
      // The sign-in ends with this command when the command is told to stop.
      const stop = new AbortController();
      process.once("SIGTERM", () => stop.abort());
      process.exit(await signIn(provider, folder, stop.signal));
    }
    const signedIn = await login(provider, folder);
    if (options.json) console.log(JSON.stringify(signedIn));
    else console.log(signedIn.logged_in ? `Signed in${signedIn.email ? ` as ${signedIn.email}` : ""}${signedIn.api_key ? " with an API key" : ""}.` : "Signed out.");
    process.exit(0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

if (process.argv[2] === "status") {
  // Sidebots names its contract version on every answer, refusals included. The address refuses a request with no `Authorization` header before it reaches the server.
  const answers = (origin: string) =>
    fetch(`${origin}/status`, { headers: { Authorization: "Bearer status" }, signal: AbortSignal.timeout(5000) }).then(
      (response) => response.headers.has(CONTRACT_HEADER),
      () => false,
    );
  const address = store.machine()?.address ?? null;
  const status = {
    running: await answers(`http://127.0.0.1:${port}`),
    address,
    // Whether any agent has a turn queued or running, in its chat or beside it, which an update waits for before it restarts the server.
    working: store.people().some((person) => store.agentsFor(person.id).some((agent) => avatarStateOf(agent) === "working")),
    // Whether the server tells the relay how much it is used.
    counting: store.counting(),
    // How each person's agents sign in to each provider: with the login in their config folder for it, or an API key.
    people: store.people().map((person) => ({
      name: person.name,
      accounts: store.accounts(person.id).map((account) => ({
        provider: account.provider,
        name: PROVIDERS[account.provider].name,
        config_dir: account.config_dir,
        sign_in: store.apiKey(person.id, account.provider) ? "api-key" : "login",
      })),
    })),
  };
  if (options.json) {
    console.log(JSON.stringify(status));
    process.exit(0);
  }
  console.log(status.running ? `Sidebots is running on port ${port}.` : `Sidebots isn't running on port ${port}.`);
  // Whether a phone reaches the server at its address, which leads to its port, so only a server that runs is asked there.
  if (address) console.log(status.running && (await answers(`https://${address}`)) ? `Phones reach it at ${address}.` : `Phones can't reach it at ${address}.`);
  console.log(`Its usage counts are ${status.counting ? "on" : "off"}.`);
  for (const person of status.people) {
    for (const account of person.accounts) {
      const on = `${person.name}'s agents on ${account.name} run on`;
      console.log(account.sign_in === "api-key" ? `${on} an API key.` : `${on} the login in ${account.config_dir}.`);
    }
  }
  process.exit(0);
}

store.installStarterAvatars(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "avatars"));
// The client id a person's sign-in names. To a Google app it is the one Google gave the Sidebots app on the App Store, or the one a build of your own names. To Notion it is the address of the file on Sidebots' site that says what Sidebots is.
const connections = createConnections(store, {
  google: process.env.SIDEBOTS_GOOGLE_CLIENT ?? "161867342001-s22m1k5cbkf1vg7s9qhsb66cqhs12ehh.apps.googleusercontent.com",
  notion: "https://sidebots.app/oauth-client.json",
});
const queue = createQueue(store, { claude, codex }, connections);
for (const agentId of store.requeueInterrupted()) void queue.kick(agentId);
queue.startClock();

// The server's input is a pipe from the program that started it, which closes when that program ends however it ends, and the server ends with it.
if (process.argv[2] === "--with-parent") {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

// The relay gives the machine its address and tunnel, and passes notifications to Apple. `off` uses neither, for a server reached some other way.
const relayOrigin = process.env.SIDEBOTS_RELAY ?? "https://relay.sidebots.app";
if (relayOrigin !== "off") {
  const toRelay = relay(store, relayOrigin, port, process.env.SIDEBOTS_VERSION);
  startPush(store, toRelay.notify);
  const stopTunnel = startTunnel(store, toRelay.register, process.env.SIDEBOTS_CLOUDFLARED ?? "cloudflared");
  // `cloudflared` runs apart from the server, so it would outlive it. The server stops it as it exits, whatever ends it: a signal, an error, or its parent ending.
  process.once("exit", stopTunnel);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));
} else console.log("The tunnel and notifications are off, as SIDEBOTS_RELAY is off.");

// The machine's name as its owner knows it. macOS keeps one apart from the network's name for the machine.
const machine = process.platform === "darwin" ? execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim() : hostname();
// Local only. The tunnel, or `tailscale serve`, brings the phone's requests here.
serve({ fetch: createApi(store, queue, connections, machine, relayOrigin !== "off").fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`Sidebots is listening on http://127.0.0.1:${port}, with data in ${home}`);
});
