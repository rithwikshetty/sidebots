#!/bin/bash
# Builds Sidebots for Mac in mac/build: the menu bar app with Sparkle, Node, the
# server and its production dependencies, the starter avatars and cloudflared inside it,
# and in Contents/Helpers the desktop app from desktop/, which shows the chats in a window.
# It carries neither Claude Code nor Codex. The server runs the ones the person installed.
#
#   mac/build.sh           Signs with SIDEBOTS_IDENTITY, for use on this Mac, and makes build/Sidebots.zip.
#   mac/build.sh release   Signs it with the Developer ID, makes build/Sidebots.dmg, signs that, has Apple
#                          notarise it and staples the ticket to it, as Apple's "Packaging Mac software for
#                          distribution" sets out. Then signs it with the update key in the keychain and writes
#                          site/public/appcast.xml for it.
#
# SIDEBOTS_IDENTITY is a code signing identity in the keychain: "Apple Development" unless set, or "-"
# to sign for this Mac only, and for a release "Developer ID Application" unless set. A release sends
# the disk image to Apple with the notarytool credentials saved in the keychain under
# SIDEBOTS_NOTARY_PROFILE, "sidebots" unless set.
set -euo pipefail

NODE_VERSION=24.22.3
NODE_SHA256=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd
CLOUDFLARED_VERSION=2026.11.0
CLOUDFLARED_SHA256=8c2f90277ef06a6080bb40b964d33f09f1188102f8798f2e344174b6cf41accf
# dmgbuild, which lays out the disk image's window.
DMGBUILD_VERSION=1.6.7

mac=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$mac")
build=$mac/build
app=$build/Sidebots.app
resources=$app/Contents/Resources
identity=${SIDEBOTS_IDENTITY:-Apple Development}
[ "${1:-}" = release ] && identity=${SIDEBOTS_IDENTITY:-Developer ID Application}

# Downloads a file once, and stops the build when it isn't the file expected.
download() {
  local file
  file=$build/downloads/$(basename "$1")
  mkdir -p "$build/downloads"
  if [ ! -f "$file" ] || ! echo "$2  $file" | shasum -a 256 -c --status; then
    curl -fsSL -o "$file.part" "$1"
    echo "$2  $file.part" | shasum -a 256 -c --quiet >&2
    mv "$file.part" "$file"
  fi
  echo "$file"
}

echo "Building the menu bar app"
swift build -c release --arch arm64 --package-path "$mac"
products=$(swift build -c release --arch arm64 --package-path "$mac" --show-bin-path)
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks" "$resources/bin" "$resources/server"
cp "$products/Sidebots" "$app/Contents/MacOS/"
ditto "$products/Sparkle.framework" "$app/Contents/Frameworks/Sparkle.framework"
cp "$mac/Info.plist" "$app/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$(git -C "$root" rev-list --count HEAD)" "$app/Contents/Info.plist"
cp "$mac/AppIcon.icns" "$resources/"

echo "Adding Node $NODE_VERSION and cloudflared $CLOUDFLARED_VERSION"
node=$(download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz" "$NODE_SHA256")
tar -xzf "$node" -C "$resources/bin" --strip-components 2 "node-v$NODE_VERSION-darwin-arm64/bin/node"
cloudflared=$(download "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-darwin-arm64.tgz" "$CLOUDFLARED_SHA256")
tar -xzf "$cloudflared" -C "$resources/bin"

echo "Adding the server"
cp "$root/server/package.json" "$root/server/pnpm-lock.yaml" "$resources/server/"
cp -R "$root/server/src" "$resources/server/src"
cp -R "$root/avatars" "$resources/avatars"
# A flat node_modules, with no links.
(cd "$resources/server" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted --reporter=silent)
rm -rf "$resources/server/node_modules/.bin"

echo "Adding the desktop app"
pnpm --dir "$root/desktop" install --frozen-lockfile --reporter=silent
SIDEBOTS_VERSION=$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist") \
  SIDEBOTS_BUILD=$(plutil -extract CFBundleVersion raw "$app/Contents/Info.plist") \
  pnpm --dir "$root/desktop" package
ditto "$root/desktop/out/Sidebots-darwin-arm64/Sidebots.app" "$app/Contents/Helpers/Sidebots.app"

echo "Signing with $identity"
# Every program in the bundle, then the app around them. Node compiles
# JavaScript as it runs, which the runtime entitlements allow.
source "$mac/sign.sh"
sign --entitlements "$mac/runtime.entitlements" "$resources/bin/node"
find "$resources" -type f ! -path "$resources/bin/node" -print0 |
  while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q Mach-O; then sign "$file"; fi
  done
# Sparkle's helpers from the inside out, as Sparkle's documentation sets out. The downloader keeps its entitlements.
sparkle=$app/Contents/Frameworks/Sparkle.framework/Versions/B
sign "$sparkle/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$sparkle/XPCServices/Downloader.xpc"
sign "$sparkle/Autoupdate" "$sparkle/Updater.app"
sign "$app/Contents/Frameworks/Sparkle.framework"
sign_desktop "$app/Contents/Helpers/Sidebots.app"
sign "$app"
codesign --verify --strict --deep "$app"

if [ "${1:-}" != release ]; then
  rm -f "$build/Sidebots.zip"
  ditto -c -k --keepParent "$app" "$build/Sidebots.zip"
  echo "Built $app and $build/Sidebots.zip"
  exit 0
fi

echo "Making the disk image"
info=$app/Contents/Info.plist
dmg=$build/Sidebots.dmg
rm -f "$dmg"
uvx --from "dmgbuild==$DMGBUILD_VERSION" dmgbuild -s "$mac/dmg/settings.py" -D app="$app" -D background="$mac/dmg/background.tiff" Sidebots "$dmg"
codesign --force --sign "$identity" --timestamp -i "$(plutil -extract CFBundleIdentifier raw "$info").dmg" "$dmg"

echo "Sending the disk image to Apple to notarise"
xcrun notarytool submit "$dmg" --keychain-profile "${SIDEBOTS_NOTARY_PROFILE:-sidebots}" --wait --timeout 2h
xcrun stapler staple "$dmg"
spctl --assess --type open --context context:primary-signature "$dmg"
echo "Built $dmg"

# The update feed names the disk image on the GitHub release for this version,
# with its length and its signature by the update key, which Sparkle checks
# against the public key in Info.plist before it installs.
version=$(plutil -extract CFBundleShortVersionString raw "$info")
signature=$("$mac/.build/artifacts/sparkle/Sparkle/bin/sign_update" "$dmg")
cat >"$root/site/public/appcast.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Sidebots</title>
    <item>
      <title>Sidebots $version</title>
      <pubDate>$(LC_ALL=C date -u "+%a, %d %b %Y %H:%M:%S +0000")</pubDate>
      <sparkle:version>$(plutil -extract CFBundleVersion raw "$info")</sparkle:version>
      <sparkle:shortVersionString>$version</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$(plutil -extract LSMinimumSystemVersion raw "$info")</sparkle:minimumSystemVersion>
      <enclosure url="https://github.com/rithwikshetty/sidebots/releases/download/v$version/Sidebots.dmg" type="application/octet-stream" $signature/>
    </item>
  </channel>
</rss>
EOF
echo "Wrote $root/site/public/appcast.xml for Sidebots $version"
