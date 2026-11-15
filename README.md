# Simon

Simon is an iPhone messaging app for your own Claude agents. Each chat is an agent. You send it a message, it does the work on a machine you own, and the finished reply arrives like a text from a person, with a notification.

You run Simon yourself. There is no hosted service: a small server runs on your machine, drives Claude Code there, and keeps every message in a folder on that machine. You build your own copy of the app and point it at your server.

The full design is in [docs/specs/2026-11-15-simon.md](docs/specs/2026-11-15-simon.md).

## Read this before you run it

- **Agents act without asking.** They run in Claude Code's auto mode, where Claude Code's own safety check decides what is safe to run. Nobody is asked to approve anything. An action the check can't decide on is skipped.
- **Agents can reach everything the server's user account can.** Every agent runs as the account that started the server, and can read and change that account's files, run commands as it, and use each person's Claude Code skills and connections.
- **Share a server only with people you would trust with that machine.** Each person sees only their own agents in the app, but all agents run as the same account.
- **Never expose the server's port any other way than `tailscale serve`.** The server has no passwords. It trusts the `Tailscale-User-Login` header that `tailscale serve` adds to each request, so anything that can reach the port directly can claim to be anyone.

## What you need

- A machine that stays on, with [Node](https://nodejs.org) 24 or later, [pnpm](https://pnpm.io) and [Claude Code](https://claude.com/claude-code). It has been run on a Mac.
- [Tailscale](https://tailscale.com) on that machine and on each phone, in the same tailnet.
- A Claude subscription for each person.
- An iPhone, and a Mac with Xcode to build the app. There is no Android build today.
- A paid Apple Developer account. The app uses push notifications, which a free account can't sign.

## Set up the server

```sh
cd server
pnpm install
```

Add each person once, with their Tailscale login, their name, and a Claude Code config folder of their own:

```sh
pnpm add-person alex@example.com Alex ~/.claude
```

Each person signs in to Claude Code in their own folder themselves:

```sh
CLAUDE_CONFIG_DIR=~/.claude claude
```

A second person needs a folder of their own, such as `~/.claude-robin`.

Start the server, then publish it to your tailnet:

```sh
pnpm start
tailscale serve --bg --https=443 http://127.0.0.1:4317
```

The server listens on `127.0.0.1:4317` only. The app's server address is the machine's Tailscale name, such as `macbook.your-tailnet.ts.net`. If something else on the machine already uses port 443, publish Simon on another one, such as `--https=8443`, and add it to the address: `macbook.your-tailnet.ts.net:8443`.

Two settings change where things live: `PORT` for the port, and `SIMON_HOME` for the data folder, which is `~/.simon` unless you set it. That folder holds the database, each agent's home folder with its instructions, memory and attachments, the pets and the push key. If you set `SIMON_HOME` for the server, set it for `add-person` and `push-key` too.

To keep the server running on a Mac, use a launchd agent with `RunAtLoad` and `KeepAlive` set, `server/` as its working directory, and the full path to `node` running `src/main.ts`. Keep the code outside `~/Downloads`, `~/Documents` and `~/Desktop`, which macOS doesn't let a background service read.

### Notifications

Create a push key (an APNs auth key) in your Apple Developer account, then save it and restart the server:

```sh
pnpm push-key ~/Downloads/AuthKey_XXXXXXXXXX.p8 <apple-team-id>
```

Until then notifications are off and everything else works.

### New pets

Agents can draw new pets with the skill in `skills/hatch-pet`. Copy that folder into the `skills` folder of each person's Claude Code config folder. The skill saves pets in `~/.simon/pets`, so it needs the data folder left where it is.

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

The app asks for the server's address the first time it opens. For other people's phones, open `mobile/ios/Simon.xcworkspace` in Xcode, archive the app and upload it to TestFlight.

## Who pays for the model

Each person's agents run on that person's own Claude subscription, through their own Claude Code sign-in. Simon never reads, stores or passes on a sign-in. Anthropic's terms decide what a subscription may be used for, so read them before you set Simon up for anyone but yourself.

## Working on Simon

```sh
(cd server && pnpm test && pnpm typecheck)
(cd mobile && pnpm typecheck)
```

The server's tests run through its HTTP routes with the model swapped for a fake, so they need no Claude sign-in. The app imports the server's wire types from `server/src/contract.ts`.

## Licence

[MIT](LICENSE). The pets, the app icon and the notification sound were made for Simon and are under the same licence.
