# Sidebots

Sidebots is a messaging app for your agents. Each chat is an agent. You send it a message, it does the work on a machine you own, and the finished reply arrives like a text from a person, with a notification, and with any files or pages the agent made for you. While it works, its avatar waits on your Lock Screen and in the Dynamic Island. Your agents can ask each other things, and what they said is there to read in both their chats.

You run Sidebots yourself. There is no hosted service: a small server runs on your machine, drives the program each agent runs on, and keeps every message in a folder on that machine. Sidebots calls those programs providers, and it has two, Claude Code and Codex. It carries neither: your agents run on the ones you installed, signed in as you are there. You pick one as you make an agent. [Providers](#providers) says how another is added. You build your own copy of the app and pair it with your server.

The full design is in [docs/specs/2026-11-15-sidebots.md](docs/specs/2026-11-15-sidebots.md).

## Read this before you run it

- **Agents act on their own.** Each runs under its provider's own safety check, which decides what is safe to run, and nobody is asked about those actions. On Claude Code that is auto mode. An action it can't decide on, the agent asks its person about on their phone. It leaves the action undone when they say no, or don't answer within half an hour. On Codex it is the sandbox, which lets an agent write in its own folder and read the rest of the machine, and Codex's reviewer, a model that allows or refuses whatever needs more, such as the network. An agent it refuses says so in its reply.
- **Agents can reach everything the server's user account can.** Every agent runs as the account that started the server, and can read and change that account's files, run commands as it, and use the skills and connections each person has in their providers.
- **Share a server only with people you would trust with that machine.** Each person sees only their own agents in the app, but all agents run as the same account.
- **A pairing code lets a phone in.** The server has no passwords. It answers only phones that have paired with it, and a phone pairs by scanning a code you make for one person. Whoever scans the code reaches that person's agents, so show it only to them.

## Sidebots for Mac

Sidebots for Mac is the server as a menu bar app. It runs on a Mac with Apple silicon and macOS 14 or later, and carries everything the server needs but the providers: Node, the server itself, the starter avatars and `cloudflared`. Your agents run on the Claude Code or the Codex already on the Mac.

1. Open `Sidebots.dmg`, drag Sidebots to Applications, and open it from there.
2. Choose the provider your agents start on, Claude Code or Codex, and how they sign in to it: with the provider on this Mac when it is already signed in, with "Sign in to Claude" or "Sign in to ChatGPT", which opens that sign-in in your browser, or with an API key. If the provider isn't on the Mac yet, the window offers to run its maker's own installer, or waits while you install it yourself.
3. Open Sidebots on your phone and scan the QR code the Mac app shows.

The Mac app adds you as the one person on the server, named as the Mac knows you, with `~/.claude` as your Claude Code config folder or `~/.codex` as your Codex one, and opens at login from then on. A click on its menu bar icon opens a panel, like the system's own menu bar panels. It says whether phones can reach the Mac and lists the paired phones, each with when it paired and a button to remove it. It also has "Pair a phone…", how your agents sign in to each provider with a button to change it, a warning when a provider's program is missing or too old, a way to set up the provider you haven't yet, an "Open at login" switch and Quit. The QR code holds the address the relay gave the Mac, so the window waits until the Mac has one. The server's output goes to `~/Library/Logs/Sidebots/server.log`.

The Mac app uses the same data folder and port as a server you start yourself, so run one or the other.

## What you need to run the server yourself

- A machine that stays on, with [Node](https://nodejs.org) 24 or later and [pnpm](https://pnpm.io). It has been run on a Mac.
- The provider your agents run on, or both: [Claude Code](https://claude.com/claude-code) 2.1.325 or later, and [Codex](https://developers.openai.com/codex) 0.170.0 or later. The server finds them the way your terminal does, and `pnpm providers` says what it found.
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), which gives the machine its address. On a Mac, `brew install cloudflared`.
- For each person, a Claude subscription or an Anthropic API key for Claude Code, or a ChatGPT plan or an OpenAI API key for Codex.
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

Claude Code keeps the person's sessions in that folder and loads their own rules, skills and connections from it. A second person needs a folder of their own, such as `~/.claude-robin`. For a person whose agents run on Codex, the provider is `codex` and the folder is Codex's, such as `~/.codex`.

A person can use both. Set them up on the other with a folder for it, and they pick the provider as they make each agent:

```sh
pnpm add-account Alex codex ~/.codex
```

Each person's agents then sign in to each provider in one of two ways. [Who pays for the model](#who-pays-for-the-model) says which to use.

With a subscription, the person signs in to the provider themselves. Someone whose folder is the provider's own, `~/.claude` or `~/.codex`, is signed in already if they use the provider on that machine, and otherwise signs in as usual, with `claude` or `codex login`. Someone with another folder signs in to it:

```sh
CLAUDE_CONFIG_DIR=~/.claude-robin claude
CODEX_HOME=~/.codex-robin codex login
```

With an API key, Anthropic's for Claude Code or OpenAI's for Codex, the agents sign in with the key and nobody signs in to the provider. Put the key in a file, with nothing else in it, and save it for the person and the provider:

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

The relay gives the machine its address and tunnel, and passes its notifications to Apple, along with the end of each Live Activity, which tells the phone's Lock Screen that an agent has replied or failed. Only the Apple Developer account that builds the app can notify it, so the relay holds that account's push key. The server registers with the relay when it starts, and again each day, with a key it makes and keeps in `machine.json`, and signs every request with it. The relay keeps the server's public key, its tunnel and its address, and nothing about people, agents or messages. A relay that hears nothing from a machine for 60 days removes it with its address, so after a longer break the machine gets a new address and each phone pairs again.

The server uses the relay at `https://relay.sidebots.app`, which notifies the Sidebots app on the App Store. Your own build has its own identifier, so it needs your own relay: deploy the one in `relay/` to your Cloudflare account, as [relay/README.md](relay/README.md) explains, and start the server with `SIDEBOTS_RELAY` set to its address. `SIDEBOTS_RELAY=off` turns off the relay, the tunnel, notifications and Live Activities. The server then needs another way for phones to reach it, such as `tailscale serve --bg --https=443 http://127.0.0.1:4317`, and `pair` needs that address in `--host`.

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

`APP_VARIANT=development` makes Sidebots Dev: an app of its own, with `.dev` after the bundle identifier and a "DEV" tag on its icon, so it sits beside the published Sidebots on the same phone and pairs on its own. Without it, the build is the published app. For TestFlight, `mobile/testflight.sh` makes that build, archives it and uploads it to App Store Connect, signed by the Apple account Xcode is signed in with. Its build number is the count of commits. It then waits until Apple has processed the build and says whether TestFlight offers it, which it asks App Store Connect with the API key `.env.local` names.

### Pair each phone

Until its phone has paired with a server, the app opens on a welcome screen whose button opens a camera. On the server, make a pairing code for the person:

```sh
cd server
pnpm pair Alex
```

The code carries the machine's address. To have the phone reach the server at another address, such as its Tailscale name, add it as `--host macbook.your-tailnet.ts.net`.

It prints a QR code, and the same code as a link. The person scans the code in the app, or taps the link button above the camera and pastes the link. The app and the server must speak the same version of their contract, `CONTRACT_VERSION` in `server/src/contract.ts`. When they don't, the app says which one to update. A code pairs one phone, once, within ten minutes. The phone gets a key of its own, which it keeps in the Keychain and sends with every request, and the server keeps only a hash of it. It also gets the key its notifications are encrypted with, so neither the relay nor Apple can read them.

`pnpm devices` lists the paired phones with their ids, and `pnpm remove-device <id>` unpairs one at once. `pnpm status` says whether the server is running, whether phones reach it, and how each person's agents sign in. `pnpm providers` says which providers' programs the server finds, and their versions. With `--json`, `status`, `devices`, `pair`, `providers` and `signed-in` print JSON, which is what the Mac app reads.

## Who pays for the model

Each person pays for their own agents, in one of two ways:

- **A subscription.** The agents run through the person's own sign-in to Claude Code or Codex and use the limits of their Claude or ChatGPT subscription. Sidebots never reads, stores or passes on a sign-in.
- **An API key.** Anthropic or OpenAI bills the key's account for what the agents use. The key is from the [Claude Console](https://platform.claude.com) or the [OpenAI Platform](https://platform.openai.com/api-keys), and Sidebots keeps it in `~/.sidebots` on your machine.

Usage, in the app's side menu, shows where either one goes: what is left of a subscription's limits and when they reset, as the provider says when Usage is opened, and what the agents used in the last seven days, by cost or by tokens: a bar for each day, then each agent, with its jobs apart from its replies. A cost there is an estimate at API prices: Claude Code's own, and for Codex, its count of tokens at OpenAI's prices. On an API key it is about what the key is billed. On a subscription it is no bill, and only measures where the limits go. Anthropic charges a subscription for use past its limits only where usage credits are turned on.

Anthropic's terms decide which you may use. A subscription is for the subscriber's own use. For a product built on the Agent SDK, as Sidebots is, Anthropic [asks for API keys](https://code.claude.com/docs/en/agent-sdk/overview) and doesn't allow Claude sign-ins to be offered to its users without its approval. OpenAI's terms decide the same for a ChatGPT sign-in. So read the terms before you set Sidebots up for anyone but yourself, and when in doubt give each person an API key.

## Providers

A provider is a program that runs agents: Claude Code or Codex. Each agent runs on one, and each person signs in to each provider their agents use with a config folder of their own. Sidebots carries no provider's program. The server looks for each on the PATH of your shell, then in the folders their installers use, and runs the one it finds when that is no older than its driver works with. Adding a provider takes three things:

- An entry in `PROVIDERS` in `server/src/contract.ts`, with the name the apps show, its models and levels of effort, and the file its agents read their instructions from. The phone shows an agent's models from there.
- An entry in `PROGRAMS` in `server/src/programs.ts`, with the command a terminal runs it by, the oldest version its driver works with, its maker's installer, its config folder, and its commands to sign in and to say whether it is signed in.
- A driver, the module that runs a turn on the program: `server/src/claude.ts` is Claude Code's and `server/src/codex.ts` is Codex's. It hands the program the agent's tools from `toolsFor` in `server/src/runner.ts`, says what the session has cost, says where the limits of the person's plan stand as a turn runs and when it is asked, ends a turn the person stops with its session kept, puts the program's failures in words for the person, and removes the program's sessions when an agent is deleted. `server/src/main.ts` passes each driver to the queue.

The Mac app sets a person up on either, which takes a few lines in `mac/Sources/Provider.swift`: the app's words for the provider, and how its sign-in reads.

The Codex driver speaks a protocol parts of which Codex calls experimental, and a person's Codex updates when they update it. When a newer Codex breaks a turn, fix the driver against it, and raise `oldest` when the fix leaves older ones behind.

## The website

`site/` is the page at [sidebots.app](https://sidebots.app), with the privacy policy the App Store asks for and the Mac app's update feed. It is static files in `site/public`, served by Cloudflare. Publish it with `npx wrangler deploy` from `site/`, with Wrangler signed in to the account that holds the domain.

## Build the Mac app

On a Mac with Apple silicon, Xcode, pnpm and [uv](https://docs.astral.sh/uv/):

```sh
mac/build.sh
```

The script downloads Node and `cloudflared` at the versions it names and checks them against the checksums it names. It builds the menu bar app in `mac/` with Sparkle, adds the server with its production dependencies and the starter avatars, with neither Claude Code nor Codex, and signs every program inside with `SIDEBOTS_IDENTITY`. That is a code signing identity in your keychain, `Apple Development` unless you set it, or `-` to sign for your own Mac only. It makes `mac/build/Sidebots.app` and `mac/build/Sidebots.zip`.

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

To try a build beside the Sidebots you already run, start it from a terminal with a data folder and port of its own. The app passes `SIDEBOTS_HOME`, `PORT` and `SIDEBOTS_RELAY` on to the server, and sets a new person up with the Claude Code config folder in `CLAUDE_CONFIG_DIR`, or the Codex one in `CODEX_HOME`, when it is set:

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

The server's tests run through its HTTP routes with the providers' turns swapped for a fake, and run the Codex driver against a stand-in for Codex, so they need no provider installed, no sign-in and no API key. The relay's tests run the server's relay module against the relay's own request handler, with Cloudflare's database and API and Apple's push service faked. The app imports the server's wire types from `server/src/contract.ts`.

## Licence

[MIT](LICENSE). The avatars, the app icon and the notification sound were made for Sidebots and are under the same licence.
