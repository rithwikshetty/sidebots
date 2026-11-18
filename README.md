# Sidebots

Sidebots is a messaging app for your agents. Each chat is an agent. You send it a message, it does the work on a machine you own, and the finished reply arrives like a text from a person, with a notification.

You run Sidebots yourself. There is no hosted service: a small server runs on your machine, drives the program each agent runs on, and keeps every message in a folder on that machine. Sidebots calls those programs providers, and today it has one, Claude Code. [Providers](#providers) says how another is added. You build your own copy of the app and pair it with your server.

The full design is in [docs/specs/2026-11-15-sidebots.md](docs/specs/2026-11-15-sidebots.md).

## Read this before you run it

- **Agents act on their own.** They run in Claude Code's auto mode, where Claude Code's own safety check decides what is safe to run, and nobody is asked about those actions. An action the check can't decide on, the agent asks its person about on their phone. It leaves the action undone when they say no, or don't answer within half an hour.
- **Agents can reach everything the server's user account can.** Every agent runs as the account that started the server, and can read and change that account's files, run commands as it, and use each person's Claude Code skills and connections.
- **Share a server only with people you would trust with that machine.** Each person sees only their own agents in the app, but all agents run as the same account.
- **A pairing code lets a phone in.** The server has no passwords. It answers only phones that have paired with it, and a phone pairs by scanning a code you make for one person. Whoever scans the code reaches that person's agents, so show it only to them.

## Sidebots for Mac

Sidebots for Mac is the server as a menu bar app. It runs on a Mac with Apple silicon and macOS 14 or later, and carries everything the server needs: Node, the server itself, the starter avatars, Claude Code and `cloudflared`.

1. Open `Sidebots.dmg`, drag Sidebots to Applications, and open it from there.
2. Choose how your agents sign in to Claude: with Claude Code on this Mac when it is already signed in, with "Sign in to Claude", which opens Claude's own sign-in in your browser, or with an API key.
3. Open Sidebots on your phone and scan the QR code the Mac app shows.

The Mac app adds you as the one person on the server, named as the Mac knows you, with `~/.claude` as your Claude Code config folder, and opens at login from then on. A click on its menu bar icon opens a panel, like the system's own menu bar panels. It says whether phones can reach the Mac and lists the paired phones, each with when it paired and a button to remove it. It also has "Pair a phone…", how your agents sign in with a button to change it, an "Open at login" switch and Quit. The QR code holds the address the relay gave the Mac, so the window waits until the Mac has one. The server's output goes to `~/Library/Logs/Sidebots/server.log`.

The Mac app uses the same data folder and port as a server you start yourself, so run one or the other.

## What you need to run the server yourself

- A machine that stays on, with [Node](https://nodejs.org) 24 or later, [pnpm](https://pnpm.io) and [Claude Code](https://claude.com/claude-code). It has been run on a Mac.
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), which gives the machine its address. On a Mac, `brew install cloudflared`.
- For each person, a Claude subscription or an Anthropic API key.
- A phone. The phone app builds for iPhone today, on a Mac with Xcode.
- A paid Apple Developer account. The app uses push notifications, which a free account can't sign.

## Set up the server

```sh
cd server
pnpm install
```

Add each person once, with a name, the provider their agents run on, and a config folder of their own for it:

```sh
pnpm add-person Alex claude ~/.claude
```

Claude Code keeps the person's sessions in that folder and loads their own rules, skills and connections from it. A second person needs a folder of their own, such as `~/.claude-robin`.

Each person's agents then sign in to Claude in one of two ways. [Who pays for the model](#who-pays-for-the-model) says which to use.

With a Claude subscription, the person signs in to Claude Code in their own folder themselves:

```sh
CLAUDE_CONFIG_DIR=~/.claude claude
```

With an Anthropic API key, the agents sign in with the key and nobody signs in to Claude Code. Put the key in a file, with nothing else in it, and save it for the person:

```sh
pnpm api-key Robin claude ~/robin-key.txt
```

Sidebots copies the key into `~/.sidebots/api-keys.json`, which only your account can read, so delete your file afterwards. The person's agents run on the key from their next turn, even if their folder is also signed in to a subscription. Saving another key replaces it, and `pnpm api-key Robin claude --remove` puts the person's agents back on the login in their folder. Sidebots never puts the key in a log, a reply or a failure notice, but an agent's own commands can read the key it runs on, as they can any of your account's files.

Start the server:

```sh
pnpm start
```

The server listens on `127.0.0.1:4317` only. When it starts, it registers with the relay, which gives the machine an address of its own, such as `k3v9x2m8q1w7p4ta.sidebots.app`, and a Cloudflare Tunnel to it. The server keeps `cloudflared` running with the tunnel, and phones reach the machine at that address from anywhere, with nothing to change on the router. The server prints the address as it starts. It finds `cloudflared` on the `PATH`, or at the path in `SIDEBOTS_CLOUDFLARED`.

Two settings change where things live: `PORT` for the port, and `SIDEBOTS_HOME` for the data folder, which is `~/.sidebots` unless you set it. That folder holds the database, each agent's home folder with its instructions, memory and attachments, the avatars, the API keys, and the machine's key, address and tunnel token. If you set `SIDEBOTS_HOME` or `PORT` for the server, set them for its other commands too.

To keep the server running on a Mac, use a launchd agent with `RunAtLoad` and `KeepAlive` set, `server/` as its working directory, and the full path to `node` running `src/main.ts`. Keep the code outside `~/Downloads`, `~/Documents` and `~/Desktop`, which macOS doesn't let a background service read.

### The relay

The relay gives the machine its address and tunnel, and passes its notifications to Apple. Only the Apple Developer account that builds the app can notify it, so the relay holds that account's push key. The server registers with the relay when it starts, and again each day, with a key it makes and keeps in `machine.json`, and signs every request with it. The relay keeps the server's public key, its tunnel and its address, and nothing about people, agents or messages. A relay that hears nothing from a machine for 60 days removes it with its address, so after a longer break the machine gets a new address and each phone pairs again.

The server uses the relay at `https://relay.sidebots.app`, which notifies the Sidebots app on the App Store. Your own build has its own identifier, so it needs your own relay: deploy the one in `relay/` to your Cloudflare account, as [relay/README.md](relay/README.md) explains, and start the server with `SIDEBOTS_RELAY` set to its address. `SIDEBOTS_RELAY=off` turns off the relay, the tunnel and notifications. The server then needs another way for phones to reach it, such as `tailscale serve --bg --https=443 http://127.0.0.1:4317`, and `pair` needs that address in `--host`.

### New avatars

Agents can draw new avatars with the skill in `skills/make-avatar`. Copy that folder into the `skills` folder of each person's Claude Code config folder. The skill saves avatars in `~/.sidebots/avatars`, so it needs the data folder left where it is.

## Build the app

```sh
cd mobile
pnpm install
cp .env.example .env.local
```

Fill in `.env.local` with a bundle identifier of your own and your Apple team ID. Then build the development app onto a phone connected to the Mac:

```sh
APP_VARIANT=development npx expo prebuild --platform ios
APP_VARIANT=development npx expo run:ios --device --configuration Release
```

`APP_VARIANT=development` makes Sidebots Dev: an app of its own, with `.dev` after the bundle identifier and a "DEV" tag on its icon, so it sits beside the published Sidebots on the same phone and pairs on its own. Without it, the build is the published app. For TestFlight, prebuild without it, then archive `mobile/ios/Sidebots.xcworkspace` and upload it, from Xcode or with `xcodebuild -exportArchive`.

### Pair each phone

Until its phone has paired with a server, the app opens on a welcome screen whose button opens a camera. On the server, make a pairing code for the person:

```sh
cd server
pnpm pair Alex
```

The code carries the machine's address. To have the phone reach the server at another address, such as its Tailscale name, add it as `--host macbook.your-tailnet.ts.net`.

It prints a QR code, and the same code as a link. The person scans the code in the app, or taps the link button above the camera and pastes the link. The app and the server must speak the same version of their contract, `CONTRACT_VERSION` in `server/src/contract.ts`. When they don't, the app says which one to update. A code pairs one phone, once, within ten minutes. The phone gets a key of its own, which it keeps in the Keychain and sends with every request, and the server keeps only a hash of it. It also gets the key its notifications are encrypted with, so neither the relay nor Apple can read them.

`pnpm devices` lists the paired phones with their ids, and `pnpm remove-device <id>` unpairs one at once. `pnpm status` says whether the server is running, whether phones reach it, and how each person's agents sign in. With `--json`, `status`, `devices` and `pair` print JSON, which is what the Mac app reads.

## Who pays for the model

Each person pays for their own agents, in one of two ways:

- **A Claude subscription.** The agents run through the person's own Claude Code sign-in and use that subscription's limits. Sidebots never reads, stores or passes on a sign-in.
- **An Anthropic API key.** Anthropic bills the key's account for what the agents use. The key is from the [Claude Console](https://platform.claude.com), and Sidebots keeps it in `~/.sidebots` on your machine.

Anthropic's terms decide which you may use. A subscription is for the subscriber's own use. For a product built on the Agent SDK, as Sidebots is, Anthropic [asks for API keys](https://code.claude.com/docs/en/agent-sdk/overview) and doesn't allow Claude sign-ins to be offered to its users without its approval. So read the terms before you set Sidebots up for anyone but yourself, and when in doubt give each person an API key.

## Providers

A provider is a program that runs agents, such as Claude Code. Each agent runs on one, and each person signs in to each provider their agents use with a config folder of their own. Adding a provider takes two things:

- An entry in `PROVIDERS` in `server/src/contract.ts`, with the name the apps show, its models and levels of effort, and the file its agents read their instructions from. The phone shows an agent's models from there.
- A driver, the module that runs a turn on the program: `server/src/claude.ts` is Claude Code's. It hands the program the agent's tools from `toolsFor` in `server/src/runner.ts`, puts the program's failures in words for the person, and removes the program's sessions when an agent is deleted. `server/src/main.ts` passes each driver to the queue.

The Mac app sets up Claude Code only, so a person's other providers are set up with `pnpm add-person` and `pnpm api-key` for now.

## The website

`site/` is the page at [sidebots.app](https://sidebots.app), with the privacy policy the App Store asks for and the Mac app's update feed. It is static files in `site/public`, served by Cloudflare. Publish it with `npx wrangler deploy` from `site/`, with Wrangler signed in to the account that holds the domain.

## Build the Mac app

On a Mac with Apple silicon, Xcode, pnpm and [uv](https://docs.astral.sh/uv/):

```sh
mac/build.sh
```

The script downloads Node and `cloudflared` at the versions it names and checks them against the checksums it names. It builds the menu bar app in `mac/` with Sparkle, adds the server with its production dependencies, which include the Claude Code program the Agent SDK ships, and the starter avatars, and signs every program inside with `SIDEBOTS_IDENTITY`. That is a code signing identity in your keychain, `Apple Development` unless you set it, or `-` to sign for your own Mac only. It makes `mac/build/Sidebots.app` and `mac/build/Sidebots.zip`.

```sh
mac/build.sh release
```

A release follows Apple's [Packaging Mac software for distribution](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution). It signs the app with the `Developer ID Application` certificate in your keychain and makes `mac/build/Sidebots.dmg` with [dmgbuild](https://dmgbuild.readthedocs.io), which lays out the window that opens: the app, an arrow and a link to Applications, from `mac/dmg/`. It signs the disk image, sends it to Apple to notarise with `notarytool`, waits up to two hours, and staples the ticket to it.

A release needs, once per Mac:

- The team's Developer ID Application certificate with its private key in the keychain. The Account Holder makes one in Xcode, under Settings, Accounts, Manage Certificates, or on the Certificates page of the developer site.
- `notarytool` credentials saved in the keychain as `sidebots`, or under the name in `SIDEBOTS_NOTARY_PROFILE`. With an App Store Connect API key from Users and Access, Integrations:

  ```sh
  xcrun notarytool store-credentials sidebots --key AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-ID>
  ```

The app updates itself with Sparkle from the feed at `sidebots.app/appcast.xml`, and installs an update once no agent is in the middle of a turn. A release signs the disk image with the update key in your keychain, whose public half is `SUPublicEDKey` in `mac/Info.plist`, and writes the feed for it in `site/public/appcast.xml`. Sparkle's `generate_keys -x <file>` in `mac/.build/artifacts/sparkle/Sparkle/bin` exports the key to keep it safe, and `-f <file>` imports it on another Mac. Without it, nobody's copy can be updated again.

Each release has a higher `CFBundleShortVersionString` in `mac/Info.plist`. Publish it by putting the disk image on a GitHub release tagged with that version, then publishing the site with the new feed:

```sh
gh release create v1.0.0 mac/build/Sidebots.dmg --title "Sidebots 1.0.0"
(cd site && npx wrangler deploy)
```

To try a build beside the Sidebots you already run, start it from a terminal with a data folder and port of its own. The app passes `SIDEBOTS_HOME`, `PORT` and `SIDEBOTS_RELAY` on to the server, and sets a new person up with the Claude Code config folder in `CLAUDE_CONFIG_DIR` when it is set:

```sh
SIDEBOTS_HOME=/tmp/sidebots-try PORT=4320 SIDEBOTS_RELAY=off CLAUDE_CONFIG_DIR=/tmp/claude-try \
  mac/build/Sidebots.app/Contents/MacOS/Sidebots
```

Setting up turns on "Open at login" for the copy you ran, so turn it off in the panel when you're done.

## Working on Sidebots

```sh
(cd server && pnpm test && pnpm typecheck)
(cd relay && pnpm test && pnpm typecheck)
(cd mobile && pnpm typecheck)
```

The server's tests run through its HTTP routes with Claude Code's turns swapped for a fake, so they need no Claude sign-in or API key. The relay's tests run the server's relay module against the relay's own request handler, with Cloudflare's database and API and Apple's push service faked. The app imports the server's wire types from `server/src/contract.ts`.

## Licence

[MIT](LICENSE). The avatars, the app icon and the notification sound were made for Sidebots and are under the same licence.
