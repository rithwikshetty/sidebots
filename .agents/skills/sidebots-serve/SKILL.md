---
name: sidebots-serve
description: "Serve this Sidebots checkout, whether main or any worktree or branch: run its server for the phone over Tailscale, and put its app on the user's iPhone. Use when the user asks to start, run or spin up a server or the app, to serve this branch, or to test or try the work on their phone."
---

# Serve Sidebots

Serve the checkout this thread works in, whether it is main or another worktree or branch. Several threads often run in parallel, so start nothing until the user asks in this thread.

Only one Sidebots server runs at a time. The phone reaches port 4317 through `tailscale serve`, and every checkout's server keeps its data in `~/.sidebots`. Two servers on that data would both run the agents' turns. So serving this checkout replaces whichever server is running, and its agents are the user's real agents.

## The server

1. Note what is being served: `git rev-parse --show-toplevel`, `git status --short --branch` and `git log -1 --oneline`.
2. In a fresh worktree, `server/` or `mobile/` has no `node_modules`. Run `pnpm install --frozen-lockfile` in each folder that lacks it.
3. If this checkout adds to `TABLE_CHANGES` in `server/src/store.ts` against main (`git diff main -- server/src/store.ts`), ask before starting. The server makes those changes to `~/.sidebots/sidebots.sqlite` when it starts, and main's server can't undo them.
4. Find the running server with `lsof -tiTCP:4317 -sTCP:LISTEN`, and its checkout with `lsof -a -p <pid> -d cwd -Fn`, which prints `<checkout>/server`. Stop it with `kill <pid>`, whether it is another checkout's or this one's. Node doesn't reload changed code, so this one restarts too. A turn cut off by the stop is queued again when the next server starts.
5. Start this checkout's server detached, so it outlives the session's limit on background jobs:

   ```sh
   cd server && nohup node src/main.ts >> ~/.sidebots/server.log 2>&1 < /dev/null &
   ```

   It is up once `lsof -tiTCP:4317 -sTCP:LISTEN` returns a process and the log's last line is `Sidebots is listening on http://127.0.0.1:4317`.
6. Run `tailscale serve status`. Port 8443 must proxy to `http://127.0.0.1:4317`. When nothing serves 8443, publish it with `tailscale serve --bg --https=8443 http://127.0.0.1:4317`. The phone reaches the server at `<tailnet name>:8443`, where the name is `Self.DNSName` from `tailscale status --json` without the trailing dot.

## The phone app

Install this checkout's app when the user wants to try the app or the phone. Install it also when this checkout's `mobile/` differs from main: `git diff --quiet main -- mobile` fails, or `git status --porcelain mobile` lists anything.

7. A worktree without `mobile/.env.local` takes the main checkout's copy, which is the first path in `git worktree list`. Copy it with `umask 077` and `cp -n`. It holds the app's bundle identifier and Apple team. Without it the build gets `com.example.sidebots.dev`, a different app from the Sidebots Dev on the phone.
8. Find the phone with `xcrun devicectl list devices`: the row whose Reality is `physical` and whose State is `available`. When it isn't listed or isn't available, ask the user to unlock it and connect it to the Mac by cable, then stop.
9. From `mobile/`, build and install the development app as a Release build in the background, and keep the task ID. `APP_VARIANT=development` makes it "Sidebots Dev", an app of its own with a "DEV" tag on its icon, beside the published Sidebots from TestFlight or the App Store. Prebuild first, because the native project keeps whichever app it was last made for:

   ```sh
   APP_VARIANT=development LANG=en_US.UTF-8 npx expo prebuild --platform ios
   APP_VARIANT=development CI=1 npx expo run:ios --device <phone identifier> --configuration Release --no-bundler
   ```

   It is done at `Build Succeeded` and `Complete 100%`, after a few minutes. Build Release, never Debug. The app has no dev client, so a Debug build loads its code from Metro on the Mac when it opens. When the phone can't reach the Mac's network, it fails with "No script URL provided". A Release build carries its code, so it needs no Metro and works anywhere the phone has Tailscale.

   - `RequestDenied` at launch means the phone was locked. The app is installed, so ask the user to open it.
   - A signing error means Xcode isn't signed in with an Apple ID on the team in `mobile/.env.local`.
   - "does not support the Push Notifications capability" means Apple doesn't know Sidebots Dev's identifier yet. Build it once from `mobile/ios` with `xcodebuild -workspace SidebotsDev.xcworkspace -scheme SidebotsDev -configuration Release -destination id=<phone identifier> -allowProvisioningUpdates build`, which registers it with notifications, then run the install again.
   - Sidebots Dev pairs apart from the published app. Once it has paired, it stays paired when it is installed over itself. One that hasn't opens on a camera. The user can't see your terminal, so give them the command that prints its pairing code, to run in `server/`: `pnpm pair <their name> --host <address from step 6>`. The names are in the `people` table.

## Handing over

Report the checkout path, branch and commit being served. Name the server that was stopped and its checkout, say whether the phone now has this checkout's app, and give the pairing command when the phone has to pair.

After a later change, serve again. A server change needs steps 4 and 5. An app change needs step 9.

The server keeps running for the household's agents after the user finishes testing. When they are done with a branch, serve main again by running this procedure from the main checkout. Leave the server off only when the user asks.
