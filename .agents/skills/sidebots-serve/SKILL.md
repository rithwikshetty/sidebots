---
name: sidebots-serve
description: "Serve this Sidebots checkout, whether main or any worktree or branch: run its server, open its desktop app on the Mac, and put its app on the user's phone when the phone is connected. Use when the user asks to start, run or spin up a server or the app, to serve this branch, or to test or try the work on their phone."
---

# Serve Sidebots

Serve the checkout this thread works in, whether it is main or another worktree or branch: run its server, open its desktop app on the Mac, and, when the phone is connected, install its app there and open it. Several threads often run in parallel, so start nothing until the user asks in this thread.

The real Sidebots is the server on port 4317 with its data in `~/.sidebots`. The Sidebots app installed in `/Applications` and the published phone app both use it, and its agents are the user's real agents. Two servers on one data folder would both run the agents' turns, so a checkout is served in one of two ways:

- **As a dev copy**, beside the real Sidebots: a server on port 4318 with data of its own in `~/.sidebots-dev`, an address of its own for the phone, and its own test agents. The real server and its agents are left alone.
- **As the real server**, in place of whichever server holds port 4317, on the user's real agents.

## Which way

Check every time, since the user may be running the installed app as a pilot:

```sh
pgrep -f '/Applications/Sidebots.app/Contents/MacOS/Sidebots'
```

A process means the installed app is on. Serve as a dev copy, and leave port 4317 and `~/.sidebots` alone. No process means it is off. Serve as the real server, unless the user asks for a dev copy.

## First

1. Note what is being served: `git rev-parse --show-toplevel`, `git status --short --branch` and `git log -1 --oneline`.
2. In a fresh worktree, `server/`, `desktop/` or `mobile/` has no `node_modules`. Run `pnpm install --frozen-lockfile` in each folder that lacks it.

## As a dev copy

Every command for the dev copy, the server's and the desktop app's, runs with `SIDEBOTS_HOME=~/.sidebots-dev PORT=4318`. A command without them acts on the real Sidebots.

3. When `~/.sidebots-dev/sidebots.sqlite` doesn't exist, set the dev copy up. Make the folder with `mkdir -p -m 700 ~/.sidebots-dev`. `node src/main.ts status --json` in `server/`, without the two settings, lists each person on the real server with each account's `provider` and `config_dir`. Add each to the dev copy with the same name and the same config folder, so its agents run on the same logins: `node src/main.ts add-person <name> <provider> <config-dir>`, and `add-account` for a person's second provider. Then `node src/main.ts counts off`, so the dev copy tells the relay nothing of how much it is used.
4. Stop a dev copy that is already running: `kill $(lsof -tiTCP:4318 -sTCP:LISTEN)`. Node doesn't reload changed code, so one from this checkout restarts too.
5. Start this checkout's server detached, so it outlives the session's limit on background jobs:

   ```sh
   cd server && SIDEBOTS_HOME=~/.sidebots-dev PORT=4318 nohup node src/main.ts >> ~/.sidebots-dev/server.log 2>&1 < /dev/null &
   ```

   It is up once `lsof -tiTCP:4318 -sTCP:LISTEN` returns a process and the log says `Sidebots is listening on http://127.0.0.1:4318`.
6. Run `node src/main.ts status` in `server/`. It must say `Phones reach it at <address>`, which is the dev copy's own address and not the real server's. The server starts the tunnel itself, with `cloudflared`, so give it a few seconds after it starts.

### The dev Mac app

Sidebots Dev is the whole Mac app built from this checkout: the menu bar app with this checkout's server and window inside it. It is an app of its own beside the Sidebots in `/Applications`, with its own name, identifier and icon, and it keeps its data in `~/.sidebots-dev` and runs its server on port 4318 by itself. Serve the dev copy this way when the change is to the menu bar app in `mac/`, or when the user asks for the Mac app or its menu bar panel. It takes the place of steps 4, 5 and 7.

- Do step 3 first, since the app sets up a new person on `~/.claude` or `~/.codex` when the dev copy has nobody.
- Stop what holds the dev copy: step 4's `kill`, step 7's `pkill`, and a Sidebots Dev that is already open, with `osascript -e 'quit app id "app.sidebots.mac.dev"'`.
- Build it in the background and keep the task ID. It takes a few minutes. It packages the desktop app into `desktop/out`, which the desktop's end-to-end tests share, so take their lock around it:

  ```sh
  until mkdir /tmp/sidebots-desktop-build.lock 2>/dev/null; do sleep 5; done
  mac/build.sh dev; rmdir /tmp/sidebots-desktop-build.lock
  ```

- Open it with `open "mac/build/Sidebots Dev.app"`. It is up once `lsof -tiTCP:4318 -sTCP:LISTEN` returns its server, and "Open Sidebots" in its menu bar panel opens the window. Then do step 6.

Any later change needs the build again, since the app carries a copy of the code.

## As the real server

3. If this checkout adds to `TABLE_CHANGES` in `server/src/store.ts` against main (`git diff main -- server/src/store.ts`), ask before starting. The server makes those changes to `~/.sidebots/sidebots.sqlite` when it starts, and main's server can't undo them.
4. Find the running server with `lsof -tiTCP:4317 -sTCP:LISTEN`, and its checkout with `lsof -a -p <pid> -d cwd -Fn`, which prints `<checkout>/server`. Stop it with `kill <pid>`, whether it is another checkout's or this one's. Node doesn't reload changed code, so this one restarts too. A turn cut off by the stop is queued again when the next server starts.
5. Start this checkout's server detached, so it outlives the session's limit on background jobs:

   ```sh
   cd server && nohup node src/main.ts >> ~/.sidebots/server.log 2>&1 < /dev/null &
   ```

   It is up once `lsof -tiTCP:4317 -sTCP:LISTEN` returns a process whose checkout is this one and the log says `Sidebots is listening on http://127.0.0.1:4317`. The launchd job `app.sidebots.server` starts the main checkout's server whenever the port is free, so it can take the port first. Stop that server and start this one again.
6. Run `node src/main.ts status` in `server/`. It must say `Phones reach it at <address>`. The server starts the tunnel itself, with `cloudflared`, so give it a few seconds after it starts. A phone that has paired with this machine reaches any checkout's server at that address.

## The desktop app

7. Open this checkout's desktop app, every time. Stop one that is already running from any checkout, since it holds the app's one instance: `pkill -f 'desktop/node_modules/(\.bin/electron-forge|@electron-forge|electron/dist)'`. The window can outlive the first one, and a new app then quits on finding it, so run it again until `pgrep -f 'desktop/node_modules/electron/dist'` returns nothing. Then start it detached from `desktop/`, with the dev copy's two settings when serving as a dev copy:

   ```sh
   cd desktop && SIDEBOTS_HOME=~/.sidebots-dev PORT=4318 nohup pnpm dev >> ~/.sidebots-dev/desktop.log 2>&1 < /dev/null &
   ```

   As the real server, leave the two settings out and log to `~/.sidebots/desktop.log`. Its window is open once `pgrep -f 'desktop/node_modules/electron/dist'` returns a process. It pairs itself with the server, and `node src/main.ts devices --json` in `server/` then lists it as a `desktop`. On a dev copy it runs beside the installed app and keeps its own data inside the dev folder. A change to the window's code shows in it at once. A change to `desktop/src/main` needs this step again.

## The phone app

8. Find the phone with `xcrun devicectl list devices`: the row whose Reality is `physical` and whose State is `available`. When it isn't listed or isn't available, leave the phone out and say so when handing over: the desktop app is what the user tries the work in. The rest of this section is for a phone that is available.
9. A worktree without `mobile/.env.local` takes the main checkout's copy, which is the first path in `git worktree list`. Copy it with `umask 077` and `cp -n`. It holds the app's bundle identifier and Apple team. Without it the build gets `com.example.sidebots.dev`, a different app from the Sidebots Dev on the phone.
10. From `mobile/`, build and install the development app as a Release build in the background, and keep the task ID. `APP_VARIANT=development` makes it "Sidebots Dev", an app of its own with a "DEV" tag on its icon, beside the published Sidebots from TestFlight or the App Store. Prebuild first, because the native project keeps whichever app it was last made for:

   ```sh
   APP_VARIANT=development LANG=en_US.UTF-8 npx expo prebuild --platform ios
   APP_VARIANT=development CI=1 npx expo run:ios --device <phone identifier> --configuration Release --no-bundler
   ```

   It is done at `Build Succeeded` and `Complete 100%`, after a few minutes. Build Release, never Debug. The app has no dev client, so a Debug build loads its code from Metro on the Mac when it opens. When the phone can't reach the Mac's network, it fails with "No script URL provided". A Release build carries its code, so it needs no Metro and works anywhere the phone is online.

   - `RequestDenied` means the phone was locked. The app is installed, so ask the user to open it.
   - A signing error means Xcode isn't signed in with an Apple ID on the team in `mobile/.env.local`.
   - "does not support the Push Notifications capability" means Apple doesn't know Sidebots Dev's identifier yet. Build it once from `mobile/ios` with `xcodebuild -workspace SidebotsDev.xcworkspace -scheme SidebotsDev -configuration Release -destination id=<phone identifier> -allowProvisioningUpdates build`, which registers it with notifications, then run the install again.
11. Sidebots Dev pairs apart from the published app, with one server at a time, and stays paired when it is installed over itself. It has to be paired with the server being served, the dev copy or the real one. `node src/main.ts devices --json` in `server/` lists the devices paired with that server. When it lists a `phone`, open the app, whose identifier is `SIDEBOTS_BUNDLE_ID` in `mobile/.env.local` with `.dev` after it:

    ```sh
    xcrun devicectl device process launch --device <phone identifier> <identifier>
    ```

    When it lists no phone, pair it. `node src/main.ts pair <their name> --json` makes a pairing link that works for ten minutes. The names are in the `people` table. Open the app with the link, written with Sidebots Dev's scheme, `sidebots-dev://pair?…` in place of `sidebots://pair?…`:

    ```sh
    xcrun devicectl device process launch --device <phone identifier> --terminate-existing --payload-url '<link>' <identifier>
    ```

    The phone is paired once `devices --json` lists it. An app that is paired with the other server ignores the link and shows that server's agents: ask the user to tap Disconnect in its side menu, then open it with a new link. The user can't see your terminal, so when the link doesn't take, show them the code to scan: make the link into a picture with the `qrcode` package in `desktop/node_modules` and put it in your reply.

## Handing over

Report the checkout path, branch and commit being served, and which way: as a dev copy or as the real server. Say that the desktop app is open, and whether the phone has this checkout's app and is paired, or was left out because it wasn't connected.

For a dev copy, say that the real server was left running, and that the agents on the dev copy are test agents the user adds there. For the real server, name the server that was stopped and its checkout.

After a later change, serve again. A server change needs steps 4 and 5. A phone app change needs step 10.

A dev copy keeps running until it is stopped. When the user is done with the branch, stop its server with `kill $(lsof -tiTCP:4318 -sTCP:LISTEN)` and its desktop app with the `pkill` in step 7. Quit Sidebots Dev from its menu bar panel, or with the `osascript` line above.

The real server keeps running for the household's agents after the user finishes testing. When they are done with a branch served as the real server, serve main again by running this procedure from the main checkout. Leave the server off only when the user asks.
