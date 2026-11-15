---
name: simon-serve
description: "Serve this Simon checkout, whether main or any worktree or branch: run its server for the phone over Tailscale, and put its app on the user's iPhone. Use when the user asks to start, run or spin up a server or the app, to serve this branch, or to test or try the work on their phone."
---

# Serve Simon

Serve the checkout this thread works in, whether it is main or another worktree or branch. Several threads often run in parallel, so start nothing until the user asks in this thread.

Only one Simon server runs at a time. The phone reaches port 4317 through `tailscale serve`, and every checkout's server keeps its data in `~/.simon`. Two servers on that data would both run the agents' turns. So serving this checkout replaces whichever server is running, and its agents are the user's real agents.

## The server

1. Note what is being served: `git rev-parse --show-toplevel`, `git status --short --branch` and `git log -1 --oneline`.
2. In a fresh worktree, `server/` or `mobile/` has no `node_modules`. Run `pnpm install --frozen-lockfile` in each folder that lacks it.
3. If this checkout changes the database, ask before starting. A change to `TABLE_CHANGES` or `SCHEMA` in `server/src/store.ts` against main (`git diff main -- server/src/store.ts`) migrates `~/.simon/simon.sqlite` as soon as the server starts. Main can't undo it, and serving main again afterwards can break.
4. Find the running server with `lsof -tiTCP:4317 -sTCP:LISTEN`, and its checkout with `lsof -a -p <pid> -d cwd -Fn`, which prints `<checkout>/server`. Stop it with `kill <pid>`, whether it is another checkout's or this one's. Node doesn't reload changed code, so this one restarts too. A turn cut off by the stop is queued again when the next server starts.
5. Start this checkout's server detached, so it outlives the session's limit on background jobs:

   ```sh
   cd server && nohup node src/main.ts >> ~/.simon/server.log 2>&1 < /dev/null &
   ```

   It is up once `lsof -tiTCP:4317 -sTCP:LISTEN` returns a process and the log's last line is `Simon is listening on http://127.0.0.1:4317`.
6. Run `tailscale serve status`. Port 8443 must proxy to `http://127.0.0.1:4317`. When nothing serves 8443, publish it with `tailscale serve --bg --https=8443 http://127.0.0.1:4317`. The phone's server address is `https://<tailnet name>:8443`, where the name is `Self.DNSName` from `tailscale status --json` without the trailing dot.

## The phone app

Install this checkout's app when the user wants to try the app or the phone. Install it also when this checkout's `mobile/` differs from main: `git diff --quiet main -- mobile` fails, or `git status --porcelain mobile` lists anything.

7. A worktree without `mobile/.env.local` takes the main checkout's copy, which is the first path in `git worktree list`. Copy it with `umask 077` and `cp -n`. It holds the app's bundle identifier and Apple team. Without it the build gets `com.example.simon`, a different app from the one on the phone.
8. Find the phone with `xcrun devicectl list devices`: the row whose Reality is `physical` and whose State is `available`. When it isn't listed or isn't available, ask the user to unlock it and connect it to the Mac by cable, then stop.
9. From `mobile/`, build and install a Release build in the background, and keep the task ID:

   ```sh
   CI=1 npx expo run:ios --device <phone identifier> --configuration Release --no-bundler
   ```

   It is done at `Build Succeeded` and `Complete 100%`, after a few minutes. Build Release, never Debug. The app has no dev client, so a Debug build loads its code from Metro on the Mac when it opens. When the phone can't reach the Mac's network, it fails with "No script URL provided". A Release build carries its code, so it needs no Metro and works anywhere the phone has Tailscale.

   - `RequestDenied` at launch means the phone was locked. The app is installed, so ask the user to open it.
   - A signing error means Xcode isn't signed in with an Apple ID on the team in `mobile/.env.local`.
   - The app keeps the server address it was given at first launch. A fresh install asks for it, and the answer is the address from step 6.

## Handing over

Report the checkout path, branch and commit being served. Name the server that was stopped and its checkout, give the phone's server address, and say whether the phone now has this checkout's app.

After a later change, serve again. A server change needs steps 4 and 5. An app change needs step 9.

The server keeps running for the household's agents after the user finishes testing. When they are done with a branch, serve main again by running this procedure from the main checkout. Leave the server off only when the user asks.
