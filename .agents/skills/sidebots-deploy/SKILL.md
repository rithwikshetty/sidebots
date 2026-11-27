---
name: sidebots-deploy
description: "Release Sidebots from main to everywhere it runs: the relay, the Mac download and its update feed, the site, and the phone app on TestFlight. Use when the user asks to deploy, release, ship or publish Sidebots, or to update the app everywhere."
---

# Deploy Sidebots

A deploy releases `main` to four places, in this order:

1. **The relay**, at `relay.sidebots.app`. Servers and phones depend on it, so it goes first.
2. **The Mac app**, as a disk image on a GitHub release. It carries the server and the desktop app.
3. **The site**, at `sidebots.app`, with the update feed that tells installed Mac apps about the release.
4. **The phone app**, on TestFlight. It goes after the Mac app, because a newer phone app on an older server asks for routes the server doesn't have.

Every step runs each time. The user asking for a deploy is the approval for all four. Run it without them, and stop only when a step fails in a way the notes below don't cover.

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

Then count the machines that hold an address:

```sh
(cd relay && npx wrangler d1 execute sidebots-relay --remote --command "select count(*) as machines from machines where tunnel_id is not null")
```

Each takes one DNS record of the zone and one tunnel of the account. `relay/README.md` says how many of each Cloudflare allows, and issue #157 what each limit costs to lift.

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

Then `curl -s https://sidebots.app/appcast.xml` must name the new version. From here installed Mac apps update themselves, each once none of its agents is in the middle of a turn. This Mac's own server is one of them: it runs inside the Sidebots in `/Applications`, so the release reaches it through the feed, and nothing in the checkout restarts it. "Check for updates…" in the menu bar app fetches it at once.

## 4. The phone app

```sh
mobile/testflight.sh
```

It archives the published app, uploads it, and then asks App Store Connect about the build until Apple has processed it. It takes several minutes, so run it in the background with its output in a log.

The step is done only at its last line, `TestFlight has build <number>: <state> for internal testers, <state> for external testers`. `Uploaded Sidebots <version>, build <number>` comes before it and proves nothing: Apple can refuse a build it has taken. Report both states as the script gives them. `IN_BETA_TESTING` means the TestFlight app offers the build to those testers. `READY_FOR_BETA_TESTING` means Apple has processed it and hasn't handed it to them yet, which takes a few minutes more for internal testers: run `node testflight-build.mjs` from `mobile/` again, with the four values its first lines name, until it says `IN_BETA_TESTING`.

- `Error Downloading App Information` is Apple's servers failing. Run `mobile/testflight.sh upload`, which sends the same archive again and waits.
- `The train version '<version>' is closed for new build submissions` means the App Store approved that version of the phone app, and TestFlight takes only a higher one. Set the next patch as `version` in `mobile/app.config.ts`, merge it the way the Mac app's version merges, and run `mobile/testflight.sh` again on the merged commit.
- A signing or provisioning error means Xcode isn't signed in with an Apple ID on the team in `mobile/.env.local`, which only the user can fix.
- `Apple refused build <number>` means the upload arrived and Apple turned it down. The reason is in Apple's email to the account holder, so ask the user for it.
- A wait that fails to read its key or is refused by App Store Connect means `SIDEBOTS_ASC_KEY_ID` or `SIDEBOTS_ASC_ISSUER_ID` in `mobile/.env.local` is missing or wrong. The build is uploaded by then, so fix the setting and run `node testflight-build.mjs` from `mobile/` with the four values its first lines name.

## The App Store, when the user mentions it

A deploy stops at TestFlight. Send the phone app to the App Store only when the user mentions the App Store, after step 4, with the build TestFlight just took. Their mentioning it is the approval to submit.

App Store Connect's API does it, with the key and the signed token `mobile/testflight-build.mjs` uses. In order:

1. Find the app with `GET /v1/apps?filter[bundleId]=<bundle id>` and read its versions with `GET /v1/apps/<app>/appStoreVersions`. Apple reviews one submission at a time, so when a version is `WAITING_FOR_REVIEW` or `IN_REVIEW`, tell the user and leave it as it is.
2. Make the version with `POST /v1/appStoreVersions`: platform `IOS`, the `version` in `mobile/app.config.ts`, release type `AFTER_APPROVAL`, the app, and the build, whose id `GET /v1/builds?filter[app]=<app>&filter[version]=<build number>` gives. It takes the description, the screenshots and the review contact and notes from the version before it.
3. Write "What's New" with `PATCH /v1/appStoreVersionLocalizations/<id>` on the one under `/v1/appStoreVersions/<version>/appStoreVersionLocalizations`. It says what the phone app gained since the build that is live, in plain words. A build number is a count of commits, so `git rev-list --reverse HEAD | sed -n <live build>p` is the live build's commit, and `git log <commit>..HEAD --format=%s -- mobile` what merged since.
4. Read the review notes at `/v1/appStoreVersions/<version>/appStoreReviewDetail` against the app's screens as they are. Apple's reviewer follows them through the demo computer in `mobile/src/lib/demo.ts`. When a step in them has moved, write them again with `PATCH /v1/appStoreReviewDetails/<id>`, sending only `notes`.
5. Submit: `POST /v1/reviewSubmissions` for the app on `IOS`, `POST /v1/reviewSubmissionItems` with that submission and the version, then `PATCH /v1/reviewSubmissions/<id>` with `submitted: true`.

It is submitted once the version reads `WAITING_FOR_REVIEW`. Report that state and that the version goes live by itself when Apple approves it. After that, TestFlight takes only a higher version, as the note in step 4 on a closed train says.

## Handing over

Report the version and the link to its GitHub release, the phone app's build number with the two states TestFlight gave it, how many machines the relay holds, and what the last release didn't have, in plain words. With 150 machines or more, start the report with this: the zone must be on Cloudflare's Pro plan before the count reaches 190, or new computers stop getting an address. With 800 or more, start it with this: the account runs out of tunnels at 1,000, and issue #157 has the decision to make. Say what is left for the user: update Sidebots from TestFlight. Name any step that failed and what it needs.

Say a place is updated only when its own check in the step above passed: the download's length, the live feed's version, and the script's `TestFlight has build` line.
