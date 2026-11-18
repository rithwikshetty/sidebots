---
name: sidebots-deploy
description: "Release Sidebots from main to everywhere it runs: the relay, the Mac download and its update feed, the site, the phone app on TestFlight, and this Mac's own server. Use when the user asks to deploy, release, ship or publish Sidebots, or to update the app everywhere."
---

# Deploy Sidebots

A deploy releases `main` to five places, in this order:

1. **The relay**, at `relay.sidebots.app`. Servers and phones depend on it, so it goes first.
2. **The Mac app**, as a disk image on a GitHub release. It carries the server.
3. **The site**, at `sidebots.app`, with the update feed that tells installed Mac apps about the release.
4. **The phone app**, on TestFlight. It goes after the Mac app, because a newer phone app on an older server asks for routes the server doesn't have.
5. **This Mac's own server**, which runs from the main checkout, so no release reaches it.

Every step runs each time. The user asking for a deploy is the approval for all five. Run it without them, and stop only when a step fails in a way the notes below don't cover.

## Before starting

- Work in the main checkout, the first path in `git worktree list`, on `main`, with a clean tree, level with `origin/main` after a fetch. A deploy releases what is on `main`, and every commit there passed the pre-merge check when it merged.
- The last release is the newest tag, `git describe --tags --abbrev=0`. Read what merged since with `git log <tag>..origin/main --format=%s`. The release notes come from that list.
- The version is the next patch after `CFBundleShortVersionString` in `mac/Info.plist`, unless the user names one.
- If `relay/schema.sql` changed since the last tag, stop and work out how the live database gets that change before the worker that needs it deploys.

## 1. The relay

```sh
(cd relay && pnpm install --frozen-lockfile && npx wrangler deploy)
```

The secrets the relay holds stay as they are. Wrangler is signed in to the Cloudflare account that holds `sidebots.app`. `npx wrangler whoami` says so when a deploy is refused.

## 2. The Mac app

1. Set the new version in `mac/Info.plist` by editing the string under `CFBundleShortVersionString`. Edit the text, because `plutil` writes the whole file back with its keys sorted.
2. Commit it on a branch as `Version <version> of Sidebots for Mac`, open a PR, squash merge it and pull `main`. The build takes its build number from the count of commits, so it must run on the merged commit.
3. Build, sign and notarise, with the output in a log. Apple takes a few minutes to notarise:

   ```sh
   mac/build.sh release
   ```

   It makes `mac/build/Sidebots.dmg` and writes `site/public/appcast.xml` for it.
4. Tag the commit that was built and put the disk image on a GitHub release. The notes say what changed in plain words, for a person who uses the app:

   ```sh
   git tag v<version> && git push origin v<version>
   gh release create v<version> mac/build/Sidebots.dmg --verify-tag --title "Sidebots <version>" --notes "<notes>"
   ```

5. Check the download is whole: the `content-length` of `curl -sIL https://github.com/rithwikshetty/sidebots/releases/download/v<version>/Sidebots.dmg` equals `stat -f %z mac/build/Sidebots.dmg`. The feed carries that length and a signature over the file, and an installed app refuses an update that doesn't match.
6. Commit `site/public/appcast.xml` on a branch as `Publish Sidebots <version> in the update feed`, open a PR, squash merge it and pull `main`.

## 3. The site

```sh
(cd site && npx wrangler deploy)
```

Then `curl -s https://sidebots.app/appcast.xml` must name the new version. From here installed Mac apps update themselves, each once none of its agents is in the middle of a turn.

## 4. The phone app

```sh
mobile/testflight.sh
```

It archives the published app and uploads it, and ends with `Uploaded Sidebots <version>, build <number>`. It takes several minutes, so run it in the background with its output in a log.

- `Error Downloading App Information` is Apple's servers failing. Run `mobile/testflight.sh upload`, which sends the same archive again.
- A signing or provisioning error means Xcode isn't signed in with an Apple ID on the team in `mobile/.env.local`, which only the user can fix.

Apple processes an upload for a few minutes before TestFlight offers it.

## 5. This Mac's server

The launch agent `app.sidebots.server` keeps it running from the main checkout's `server/`, and starts it again whenever it stops. Node doesn't reload changed code, so restart it on the released code:

```sh
(cd server && pnpm install --frozen-lockfile)
launchctl kickstart -k gui/$(id -u)/app.sidebots.server
```

A turn cut off by the restart is queued again when the server starts. It is up once `lsof -tiTCP:4317 -sTCP:LISTEN` returns a new process and `node src/main.ts status` in `server/` says `Phones reach it at <address>`. The server makes the release's changes to `~/.sidebots/sidebots.sqlite` as it starts.

## Handing over

Report the version and the link to its GitHub release, the phone app's build number, and what the last release didn't have, in plain words. Say what is left for the user: update Sidebots from TestFlight once Apple has processed the build. Name any step that failed and what it needs.
