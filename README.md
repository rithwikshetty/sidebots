# Sidebots

Sidebots is an iPhone messaging app for your own Claude agents. Each chat is an agent. You send it a message, it does the work on a machine you own, and the finished reply arrives like a text from a person, with a notification.

You run Sidebots yourself. There is no hosted service: a small server runs on your machine, drives Claude Code there, and keeps every message in a folder on that machine. You build your own copy of the app and pair it with your server.

The full design is in [docs/specs/2026-11-15-sidebots.md](docs/specs/2026-11-15-sidebots.md).

## Read this before you run it

- **Agents act without asking.** They run in Claude Code's auto mode, where Claude Code's own safety check decides what is safe to run. Nobody is asked to approve anything. An action the check can't decide on is skipped.
- **Agents can reach everything the server's user account can.** Every agent runs as the account that started the server, and can read and change that account's files, run commands as it, and use each person's Claude Code skills and connections.
- **Share a server only with people you would trust with that machine.** Each person sees only their own agents in the app, but all agents run as the same account.
- **A pairing code lets a phone in.** The server has no passwords. It answers only phones that have paired with it, and a phone pairs by scanning a code you make for one person. Whoever scans the code reaches that person's agents, so show it only to them.

## What you need

- A machine that stays on, with [Node](https://nodejs.org) 24 or later, [pnpm](https://pnpm.io) and [Claude Code](https://claude.com/claude-code). It has been run on a Mac.
- [Tailscale](https://tailscale.com) on that machine and on each phone, in the same tailnet.
- For each person, a Claude subscription or an Anthropic API key.
- An iPhone, and a Mac with Xcode to build the app. There is no Android build today.
- A paid Apple Developer account. The app uses push notifications, which a free account can't sign.

## Set up the server

```sh
cd server
pnpm install
```

Add each person once, with a name and a Claude Code config folder of their own:

```sh
pnpm add-person Alex ~/.claude
```

Claude Code keeps the person's sessions in that folder and loads their own rules, skills and connections from it. A second person needs a folder of their own, such as `~/.claude-robin`.

Each person's agents then sign in to Claude in one of two ways. [Who pays for the model](#who-pays-for-the-model) says which to use.

With a Claude subscription, the person signs in to Claude Code in their own folder themselves:

```sh
CLAUDE_CONFIG_DIR=~/.claude claude
```

With an Anthropic API key, the agents sign in with the key and nobody signs in to Claude Code. Put the key in a file, with nothing else in it, and save it for the person:

```sh
pnpm api-key Robin ~/robin-key.txt
```

Sidebots copies the key into `~/.sidebots/api-keys.json`, which only your account can read, so delete your file afterwards. The person's agents run on the key from their next turn, even if their folder is also signed in to a subscription. Saving another key replaces it. Sidebots never puts the key in a log, a reply or a failure notice, but an agent's own commands can read the key it runs on, as they can any of your account's files.

Start the server, then publish it to your tailnet:

```sh
pnpm start
tailscale serve --bg --https=443 http://127.0.0.1:4317
```

The server listens on `127.0.0.1:4317` only. Phones reach it at the machine's Tailscale name, such as `macbook.your-tailnet.ts.net`. If something else on the machine already uses port 443, publish Sidebots on another one, such as `--https=8443`, and add it to the address: `macbook.your-tailnet.ts.net:8443`.

Two settings change where things live: `PORT` for the port, and `SIDEBOTS_HOME` for the data folder, which is `~/.sidebots` unless you set it. That folder holds the database, each agent's home folder with its instructions, memory and attachments, the avatars, the API keys and the key that proves the server to the relay. If you set `SIDEBOTS_HOME` for the server, set it for `add-person`, `api-key` and `pair` too.

To keep the server running on a Mac, use a launchd agent with `RunAtLoad` and `KeepAlive` set, `server/` as its working directory, and the full path to `node` running `src/main.ts`. Keep the code outside `~/Downloads`, `~/Documents` and `~/Desktop`, which macOS doesn't let a background service read.

### Notifications

Only the Apple Developer account that builds the app can notify it, so the server sends its notifications through a relay that holds that account's push key. The server registers with the relay the first time it sends one, with a key it makes and keeps in `machine.json`, and signs every request with it. The relay keeps the server's public key and nothing about people, agents or messages.

The server uses the relay at `https://relay.sidebots.app`, which notifies the Sidebots app on the App Store. Your own build has its own identifier, so it needs your own relay: deploy the one in `relay/` to your Cloudflare account, as [relay/README.md](relay/README.md) explains, and start the server with `SIDEBOTS_RELAY` set to its address. `SIDEBOTS_RELAY=off` turns notifications off, and everything else works.

### New avatars

Agents can draw new avatars with the skill in `skills/make-avatar`. Copy that folder into the `skills` folder of each person's Claude Code config folder. The skill saves avatars in `~/.sidebots/avatars`, so it needs the data folder left where it is.

## Build the app

```sh
cd mobile
pnpm install
cp .env.example .env.local
```

Fill in `.env.local` with a bundle identifier of your own and your Apple team ID. Then build a Release build onto a phone connected to the Mac:

```sh
npx expo run:ios --device --configuration Release
```

For other people's phones, open `mobile/ios/Sidebots.xcworkspace` in Xcode, archive the app and upload it to TestFlight.

### Pair each phone

Until its phone has paired with a server, the app opens on a welcome screen whose button opens a camera. On the server, make a pairing code for the person, with the address their phone reaches the server at:

```sh
cd server
pnpm pair Alex --host macbook.your-tailnet.ts.net
```

It prints a QR code, and the same code as a link. The person scans the code in the app, or taps the link button above the camera and pastes the link. The app and the server must speak the same version of their contract, `CONTRACT_VERSION` in `server/src/contract.ts`. When they don't, the app says which one to update. A code pairs one phone, once, within ten minutes. The phone gets a key of its own, which it keeps in the Keychain and sends with every request, and the server keeps only a hash of it. It also gets the key its notifications are encrypted with, so neither the relay nor Apple can read them.

## Who pays for the model

Each person pays for their own agents, in one of two ways:

- **A Claude subscription.** The agents run through the person's own Claude Code sign-in and use that subscription's limits. Sidebots never reads, stores or passes on a sign-in.
- **An Anthropic API key.** Anthropic bills the key's account for what the agents use. The key is from the [Claude Console](https://platform.claude.com), and Sidebots keeps it in `~/.sidebots` on your machine.

Anthropic's terms decide which you may use. A subscription is for the subscriber's own use. For a product built on the Agent SDK, as Sidebots is, Anthropic [asks for API keys](https://code.claude.com/docs/en/agent-sdk/overview) and doesn't allow Claude sign-ins to be offered to its users without its approval. So read the terms before you set Sidebots up for anyone but yourself, and when in doubt give each person an API key.

## Working on Sidebots

```sh
(cd server && pnpm test && pnpm typecheck)
(cd relay && pnpm test && pnpm typecheck)
(cd mobile && pnpm typecheck)
```

The server's tests run through its HTTP routes with the model swapped for a fake, so they need no Claude sign-in or API key. The relay's tests run the server's relay module against the relay's own request handler, with Cloudflare's database and Apple's push service faked. The app imports the server's wire types from `server/src/contract.ts`.

## Licence

[MIT](LICENSE). The avatars, the app icon and the notification sound were made for Sidebots and are under the same licence.
