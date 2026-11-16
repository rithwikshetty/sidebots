# Sidebots for everyone

16 November 2026

## Summary

Sidebots works today for a household with a developer in it. Someone has to build the phone app in Xcode, start the server from a terminal, set up Tailscale on every device and create a push key. Nobody else can use it.

This change lets anyone use Sidebots with two installs and one scan. They get the phone app from the App Store and the Mac app from `sidebots.app`. The Mac app runs the agents on their own Mac, with their own Claude Code. It shows a QR code, the phone scans it, and the two are connected from anywhere. No terminal, no Tailscale and no account.

The agents, the messages and the Claude sign-in stay on the person's Mac, as they do today. What is new on our side is one small service, the relay, which gives each Mac an address the phone can reach and passes notifications to Apple.

## Decisions

- **One phone app for everyone, on the App Store.** It is published under one Apple Developer account, with the identifier `app.sidebots`. Every copy of the app can pair with any Sidebots server.
- **The Mac app is the server.** A menu bar app holds the server, Node and everything else the server needs. It starts with the Mac and restarts the server if it stops. It is a download from `sidebots.app`, signed and notarised with a Developer ID. It is not on the Mac App Store, whose sandbox would stop agents reaching the person's files.
- **Pairing is how a phone proves who it is.** The server makes a one-time code for a person, the phone scans it and gets a device key, and the server refuses every request without a known key. Sidebots has no accounts, no passwords and no sign-in screen. Pairing replaces the Tailscale login the server trusts today, which is only safe while nothing outside the tailnet can reach the server.
- **Each Mac gets its own address under `sidebots.app`, through a Cloudflare Tunnel.** A tunnel is a connection the Mac opens outward to Cloudflare, so the Mac is reachable without changing the home router and without Tailscale. T3 Code reaches machines the same way. The server listens on the local machine only, as today.
- **The relay does two jobs: it gives a machine its tunnel, and it passes notifications to Apple.** Only the holder of the app's push key can notify the app, so the key lives in the relay and nowhere else. The relay is a Cloudflare Worker at `relay.sidebots.app`. It is not on the path between phone and Mac: chat traffic goes from the phone through the tunnel to the Mac.
- **The relay never sees a message.** The server encrypts each notification with a key that only the paired phone holds, and the phone decrypts it as it arrives. The relay and Apple pass along bytes they can't read. The relay stores a machine's public key, its tunnel and its address, and nothing about people, agents or messages.
- **The tunnel's traffic is protected in transit, not end to end.** Cloudflare carries it encrypted to each end and ends the encryption at its edge, as it does for any site behind it. Whoever owns the `sidebots.app` zone could put code on that path. Nothing in this design does, and the relay's code is open, but a person who wants no third party at all runs their own relay on their own domain.
- **A machine proves itself to the relay with a key of its own.** The server makes a signing key pair on first start and registers the public half. Every later request to the relay is signed with it. There are no accounts to keep, so the relay limits abuse by machine: a cap of 1000 notifications per machine per day, and removal of machines that stay away for 60 days. When registering makes a tunnel, the relay also limits new machines per network address.
- **A tunnel address is useless for anything but Sidebots.** A rule on the zone refuses any request to a machine's address that carries no `Authorization` header. The phone always sends one and a web browser following a link never does, so nobody can host a web page under `sidebots.app` by claiming a tunnel.
- **The server owns pairing, the relay connection and the tunnel. The Mac app is a shell around it.** The Mac app starts the server, shows its state and runs the server's own commands, as a person at a terminal does today. A server started from a checkout, with no Mac app, does everything the Mac app's server does.
- **One way to notify.** The server always sends notifications through a relay. The push key, the `push-key` command and the direct connection to Apple leave the server. Someone who builds their own copy of the app runs their own relay with their own key.
- **The Mac app sets up one person, on that Mac's own Claude Code.** It uses the Claude Code config folder the person already has, `~/.claude`, so their rules, skills and connections apply to their agents. If Claude Code isn't signed in there, the Mac app runs Claude Code's own sign-in. A person can give an Anthropic API key instead. More people on one Mac stay possible through the server's commands.
- **The published app offers the Claude login.** Anthropic's Agent SDK documentation asks products built on it to use API keys unless Anthropic has approved offering Claude logins. Rithwik has decided to ship with the login, as other tools built on the SDK do, with the API key beside it. The person signs in to Claude Code on their own Mac through Anthropic's own sign-in, and Sidebots never reads, stores or passes on a login.
- **A phone pairs with one Mac.** Pairing with another replaces the first.
- **The app and the server say which version of the contract they speak.** They ship separately now, the app through the App Store and the server inside the Mac app, so each tells the person which one to update when they don't match.
- **Earlier data is not carried over.** Sidebots is still in development, so the database starts from its schema with no list of table changes.

## Behavior

**Setting up the Mac.** The person downloads Sidebots from `sidebots.app` and opens it. A window asks one thing: how the agents should sign in to Claude. If Claude Code is already signed in on the Mac, that is the first choice and needs one click. Otherwise the person picks "Sign in to Claude", which opens Anthropic's sign-in in their browser, or pastes an API key. The window then shows a QR code. Sidebots stays in the menu bar and starts whenever the Mac does.

**Pairing a phone.** The person opens the phone app, which opens on a welcome screen that says what Sidebots is and how to pair. Its button opens the camera, laid out as the chat's camera, with one line of instruction, and the phone asks for the camera then. The person points it at the QR code. The app says "Paired with Rithwik's MacBook Pro" and opens on the agents. A QR code works once and for ten minutes. A link button above the camera takes the same code as text.

**The menu.** The menu bar icon shows whether Sidebots is running and reachable. Its menu has the paired phones, each with a Remove command, "Pair a phone…", how Claude is signed in with a way to change it, "Open at login", and Quit.

**Removing a phone.** Remove takes effect at once. The phone's next request is refused, and the app goes back to the welcome screen with a line saying the Mac removed it. Its saved chats are cleared.

**When the Mac can't be reached.** As today: the app shows the saved chats with every avatar greyed out, and what the person types waits on the phone. A Mac that is asleep or off can't be reached, and its agents and jobs pause until it wakes.

**Notifications.** As today for the person: the agent's name over what it said, with the Sidebots sound and the count on the app's icon. If the phone can't decrypt one, it shows "New message" under the name Sidebots.

**When the versions don't match.** If the Mac app is older than the phone app needs, the phone says "Update Sidebots on your Mac" in place of the agents. If the phone app is older, it says "Update Sidebots from the App Store". Pairing across versions fails with the same words. The Mac app updates itself: it checks `sidebots.app` daily and installs a new version when no agent is working.

**Files the agents can reach.** Agents run as the person, inside the Sidebots app. The first time an agent reaches into Documents, Downloads or Desktop, macOS asks whether Sidebots may, as it does for any app.

## Design

### The pieces

```
phone app  ──https──▶  <machine>.sidebots.app  ──tunnel──▶  server on the Mac  ──▶  Claude Code
                                                                │
                                                                └─ signed, encrypted notice ─▶  relay  ──▶  Apple  ──▶  phone
```

The repository gains two folders beside `server/` and `mobile/`: `relay/`, the Cloudflare Worker, and `mac/`, the menu bar app.

### Pairing

`node src/main.ts pair <person>` makes a pairing code and prints it as a QR code and as a link. The Mac app runs the same command and draws the QR code in its window. The code is 32 random bytes. The store keeps only its hash, with the person it is for and when it expires, ten minutes later.

The QR code holds one link:

```
sidebots://pair?host=<machine>.sidebots.app&code=<code>
```

The phone sends `POST /pair` to that host with `Authorization: Pairing <code>` and its own name. The server checks the code, deletes it, and answers with:

- a device key, 32 random bytes, which the phone sends on every later request as `Authorization: Bearer <key>`
- a notification key, 32 random bytes, which encrypts this phone's notifications
- the machine's name, for the app to show

The store keeps the device key's hash, never the key. The phone keeps both keys in the Keychain, in an access group its notification extension shares.

The api's first step, which today matches the `Tailscale-User-Login` header to a person, matches the device key to a device and its person. A request with no known key gets 401. A code is too long to guess, so wrong codes need no limit.

`host` in a development setup is whatever address reaches the server, such as a Tailscale name, given to the command as `pair <person> --host <address>`.

### Database

`people` loses `tailscale_login`. `devices` changes from a list of push tokens to the list of paired phones, and `pairings` is new.

```sql
create table people (
  id                text primary key,
  name              text not null unique,
  claude_config_dir text not null
);

create table devices (
  id               text primary key,
  person_id        text not null references people(id),
  name             text not null,     -- "Rithwik's iPhone", as the phone gave it
  key_hash         text not null unique,
  notification_key text not null,     -- encrypts this phone's notifications
  push_token       text,              -- the phone's Apple device token, once it allows notifications
  environment      text check (environment in ('sandbox', 'production')),
  paired_at        integer not null
);

create table pairings (
  code_hash  text primary key,
  person_id  text not null references people(id),
  expires_at integer not null
);
```

`devices.topic` goes: the relay knows which app it serves. `add-person` takes a name and a config folder, and `api-key` and `pair` name the person by name.

### The machine's identity

The first time it needs the relay, the server makes an Ed25519 key pair and registers with it. `~/.sidebots/machine.json` holds the private key, the machine's id and address, and the tunnel's token, readable only by the server's user account. It takes the place of `push.json`.

### Server modules

- **store** also owns devices, pairings and `machine.json`.
- **api** works out which device is asking, and owns `POST /pair`.
- **relay** is new. It is the only module that talks to the relay: it registers the machine, signs each request and sends a notice.
- **tunnel** is new. It keeps `cloudflared` running with the machine's tunnel token and restarts it if it stops. It finds `cloudflared` at the path in `SIDEBOTS_CLOUDFLARED`, or on the `PATH`.
- **push** decides when to notify, as today, encrypts the notice for each of the person's phones, and hands it to **relay**. Its connection to Apple moves to the relay.

`SIDEBOTS_RELAY` names the relay, and is `https://relay.sidebots.app` unless set. With `SIDEBOTS_RELAY=off` the server registers nowhere, runs no tunnel and sends no notifications, which is how the tests and a quick local run work.

### The relay

A Cloudflare Worker with a D1 database, in `relay/`, deployed with Wrangler to the account that holds the `sidebots.app` zone.

| Route | Purpose |
| --- | --- |
| `POST /machines` | Register a machine by its public key. Makes a tunnel that forwards to `http://127.0.0.1:4317`, gives it the address `<id>.sidebots.app`, and answers with the id, the address and the tunnel's token |
| `DELETE /machines/:id` | Remove a machine, its tunnel and its address |
| `POST /notifications` | Pass one encrypted notice to Apple for one device token, and answer `sent`, `gone` or `failed` |

Every request but the first is signed: `Authorization: Signature <machine id>:<time>:<signature>`, where the signature covers the method, the path, the time and the body's hash, and the time must be within five minutes. `POST /machines` signs with the key it registers.

```sql
create table machines (
  id         text primary key,   -- 16 random letters and digits, the label in its address
  public_key text not null unique,
  tunnel_id  text not null,
  created_at integer not null,
  seen_at    integer not null    -- its last signed request
);
```

A machine's id is random and one label deep, so Cloudflare's certificate for `*.sidebots.app` covers every machine. A daily scheduled run removes machines not seen for 60 days, with their tunnels.

The Worker's secrets are the push key with its key id and team id, and a Cloudflare API token that can edit tunnels on the account and DNS records on the zone. `APNS_TOPIC`, `ZONE` and the limits are plain settings, so another person's relay is the same code with their own values.

A custom rule on the zone blocks any request whose host is a machine's address and which has no `Authorization` header.

### Notifications

The notice the server builds is today's: title, body, badge, agent id and message id. The server encrypts it as JSON with AES-256-GCM under the phone's notification key and sends the relay the device token, the environment, the ciphertext and the message id.

The relay sends Apple an alert with the title "Sidebots", the body "New message", `mutable-content` set, the message id as the collapse id and the ciphertext beside them. It keeps nothing.

On the phone, a notification service extension, the small program iOS runs when a notification arrives, reads the notification key from the Keychain, decrypts the notice and sets the title, body, badge, sound and thread. If it can't, the alert shows as the relay sent it. The extension is a new native target, added by a config plugin in `mobile/`.

When the relay answers `gone`, the server clears that device's push token, as it forgets the phone today.

### Phone app

An unpaired app opens on a welcome screen, whose button opens the pairing screen. The pairing screen is the chat's camera with `expo-camera`'s scanner turned on, and a link button that asks for the code as its link. The app handles the `sidebots://pair` link, so a link opened anywhere on the phone pairs it.

`lib/api` keeps the host in the app's store and the two keys in the Keychain, and puts the device key on every request: calls, the event stream, uploads, and the image loads for avatars and attachments, which pass it to `expo-image` as a header. A 401 clears the pairing and the saved chats and shows the pairing screen.

### Contract version

`contract.ts` gains `CONTRACT_VERSION`, a whole number raised when a change means an older app or server can't work with a newer one. The server sends it on every response as `Sidebots-Contract`, refusals included, and the app compares it with its own. A server that sends none counts as older. The app uses nothing a server on another version says.

### Uploads

Cloudflare accepts request bodies up to 100 MB on this plan. The api's limit for one message, 200 MB today, becomes 95 MB, and the app says so when ten photos come to more.

### Mac app

A Swift app in `mac/`, drawn with SwiftUI's `MenuBarExtra`, with the identifier `app.sidebots.mac`. Its bundle carries:

- Node, for Apple silicon
- the `server/` folder with its production dependencies, which include the Claude Code program the Agent SDK ships
- `cloudflared`

It starts the server as a child process with `SIDEBOTS_CLOUDFLARED` pointing into the bundle, restarts it if it exits, and registers itself to open at login with `SMAppService`. It reads the server's state from the server's own commands: `status` (new: whether it is running, the machine's address, how Claude is signed in), `devices` (new: the paired phones), `pair`, `add-person` and `api-key`. For "Sign in to Claude" it runs the bundled Claude Code's sign-in with `CLAUDE_CONFIG_DIR` set to the person's folder.

It updates itself with Sparkle, from an update feed at `sidebots.app`, and waits for running turns to end before it restarts the server.

A build script signs every program in the bundle with the Developer ID, notarises the app and makes the disk image.

### The site

`sidebots.app` is a static page served by Cloudflare: what Sidebots is, the warning that agents act without asking, the Mac download, the App Store link, the privacy policy the App Store asks for, and the update feed.

## Testing

The server's tests run through its HTTP routes as today, with `SIDEBOTS_RELAY=off` and a fake in place of the relay module where notices are checked. New cases: a request without a key is refused; a code pairs once and expires; a removed device is refused; one person's device never sees another's agents; a notice decrypts with the device's key and with no other.

The relay's tests run through its `fetch` handler with Cloudflare's API and Apple's push service faked at the boundary: a signed request is accepted and an unsigned or stale one is not; the limits hold; a stale machine is removed. A request replayed within the five minutes repeats the same notice, which Apple shows once, as it carries the message id as its collapse id.

One manual check per slice, on a real phone: pair by scanning, reach the Mac on mobile data with Tailscale off, and get a notification that reads correctly on the Lock Screen.

## Rollout

- The server's schema is replaced, not migrated. A development home is deleted and made again.
- The relay and the zone rule go live before any server depends on them.
- The phone app reaches TestFlight once pairing, the relay and the tunnel work, and the App Store once the Mac app can be downloaded. App Review gets a pairing link to a machine kept running for it, made with a longer life than ten minutes by `pair --days <n>`.
- The README is rewritten in two parts as the slices land: using Sidebots, and building it yourself.

## Out of scope

- Accounts, and finding your Mac from a new phone without scanning
- A phone paired with several Macs
- End-to-end encryption of chat traffic between phone and Mac
- Intel Macs, Windows and Linux for the Mac app. The server still runs wherever Node and Claude Code do
- Keeping a Mac awake, or waking it, for an agent
- An Android app
- A second person set up from the Mac app's window

## Open questions

- **Where does "pair with a different Mac" live in the phone app?** A person who replaces their Mac can't be removed by the old one. Rithwik decides where the command goes.
- **Does Sidebots ask Anthropic for approval to offer the Claude login?** It ships either way. Rithwik decides whether to ask.

## Work breakdown

Each slice ends with something that works on its own.

1. **Pairing.** The `pair` command, devices and pairings in the store, the device key on every route, and the pairing screen in the app. The phone pairs by scanning a QR code in the terminal and works over today's Tailscale address. The Tailscale login check goes.
2. **Notifications through the relay.** The relay Worker with machine registration and `POST /notifications`, deployed at `relay.sidebots.app`. The server's machine identity and relay module. The push key leaves the server. A notification arrives on the phone through the relay.
3. **Encrypted notifications.** The notification key, encryption in push, and the notification service extension. The relay's logs show no readable notice.
4. **Tunnels.** The relay makes tunnels and addresses, the zone rule, the server's tunnel module, and the upload limit. The phone reaches the Mac on mobile data with Tailscale off.
5. **Contract version.** The header, and the two "update" screens.
6. **Mac app.** The menu bar app, the bundle, first run with the Claude sign-in or an API key, the QR window, open at login, and the signed, notarised download.
7. **Updates and the site.** Sparkle, the update feed and the page at `sidebots.app`.
8. **TestFlight, then the App Store.** The App Store record, the review machine, the privacy policy and the listing.
