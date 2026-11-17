#!/bin/bash
# Builds Sidebots for Mac in mac/build: the menu bar app with Sparkle, Node, the
# server and its production dependencies, the starter avatars and cloudflared inside it.
#
#   mac/build.sh           Signs with SIDEBOTS_IDENTITY, for use on this Mac, and makes build/Sidebots.zip.
#   mac/build.sh release   Has Xcode sign it with the Developer ID of that identity's team and send it to
#                          Apple to notarise, then makes build/Sidebots.dmg from the notarised app, signs it
#                          with the update key in the keychain, and writes site/public/appcast.xml for it.
#
# SIDEBOTS_IDENTITY is a code signing identity in the keychain, "Apple Development" unless set, or "-"
# to sign for this Mac only. A release needs Xcode signed in to an account in the identity's team that
# may use the team's Developer ID, as the Account Holder or an Admin can.
set -euo pipefail

NODE_VERSION=24.22.3
NODE_SHA256=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd
CLOUDFLARED_VERSION=2026.11.0
CLOUDFLARED_SHA256=8c2f90277ef06a6080bb40b964d33f09f1188102f8798f2e344174b6cf41accf
# How long Apple may take to notarise a release, in seconds.
NOTARY_WAIT=7200

mac=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$mac")
build=$mac/build
app=$build/Sidebots.app
resources=$app/Contents/Resources
identity=${SIDEBOTS_IDENTITY:-Apple Development}

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

echo "Building the app"
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
# A flat node_modules, with no links, which installs Claude Code for this Mac's processor only.
(cd "$resources/server" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted --reporter=silent)
rm -rf "$resources/server/node_modules/.bin"

echo "Signing with $identity"
# Every program in the bundle, then the app around them. Node and Claude Code
# compile JavaScript as they run, which the runtime entitlements allow.
timestamp=--timestamp
[ "$identity" = "-" ] && timestamp=--timestamp=none
sign() { codesign --force --options runtime "$timestamp" --sign "$identity" "$@"; }
claude=$resources/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
sign --entitlements "$mac/runtime.entitlements" "$resources/bin/node" "$claude"
find "$resources" -type f ! -path "$resources/bin/node" ! -path "$claude" -print0 |
  while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q Mach-O; then sign "$file"; fi
  done
# Sparkle's helpers from the inside out, as Sparkle's documentation sets out. The downloader keeps its entitlements.
sparkle=$app/Contents/Frameworks/Sparkle.framework/Versions/B
sign "$sparkle/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$sparkle/XPCServices/Downloader.xpc"
sign "$sparkle/Autoupdate" "$sparkle/Updater.app"
sign "$app/Contents/Frameworks/Sparkle.framework"
sign "$app"
codesign --verify --strict --deep "$app"

if [ "${1:-}" != release ]; then
  rm -f "$build/Sidebots.zip"
  ditto -c -k --keepParent "$app" "$build/Sidebots.zip"
  echo "Built $app and $build/Sidebots.zip"
  exit 0
fi

# Xcode signs an archive with the team's Developer ID, kept in Apple's cloud,
# and uploads it to be notarised. The archive is made by hand around the app.
team=$(security find-certificate -c "$identity" -p | openssl x509 -noout -subject -nameopt multiline | awk '/organizationalUnitName/ { print $3 }')
archive=$build/Sidebots.xcarchive
rm -rf "$archive" "$build/export" "$build/notarized"
mkdir -p "$archive/Products/Applications"
ditto "$app" "$archive/Products/Applications/Sidebots.app"
info=$app/Contents/Info.plist
plist() { plutil -insert "$2" "-$3" ${4+"$4"} "$1"; }
plutil -create xml1 "$archive/Info.plist"
plist "$archive/Info.plist" ArchiveVersion integer 2
plist "$archive/Info.plist" Name string Sidebots
plist "$archive/Info.plist" SchemeName string Sidebots
plist "$archive/Info.plist" CreationDate date "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
plist "$archive/Info.plist" ApplicationProperties dictionary
plist "$archive/Info.plist" ApplicationProperties.ApplicationPath string Applications/Sidebots.app
plist "$archive/Info.plist" ApplicationProperties.CFBundleIdentifier string "$(plutil -extract CFBundleIdentifier raw "$info")"
plist "$archive/Info.plist" ApplicationProperties.CFBundleShortVersionString string "$(plutil -extract CFBundleShortVersionString raw "$info")"
plist "$archive/Info.plist" ApplicationProperties.CFBundleVersion string "$(plutil -extract CFBundleVersion raw "$info")"
plist "$archive/Info.plist" ApplicationProperties.SigningIdentity string "$identity"
plist "$archive/Info.plist" ApplicationProperties.Team string "$team"
plist "$archive/Info.plist" ApplicationProperties.Architectures array
plutil -insert ApplicationProperties.Architectures -string arm64 -append "$archive/Info.plist"
options=$build/export-options.plist
plutil -create xml1 "$options"
plist "$options" method string developer-id
plist "$options" signingStyle string automatic
plist "$options" teamID string "$team"
plist "$options" destination string upload

echo "Signing with the Developer ID of team $team and sending to Apple to notarise"
xcodebuild -exportArchive -archivePath "$archive" -exportPath "$build/export" -exportOptionsPlist "$options" -allowProvisioningUpdates

echo "Waiting for Apple to notarise it"
deadline=$((SECONDS + NOTARY_WAIT))
until xcodebuild -exportNotarizedApp -archivePath "$archive" -exportPath "$build/notarized" >"$build/notarized.log" 2>&1; do
  if ! grep -q "is processing" "$build/notarized.log" || [ $SECONDS -ge $deadline ]; then
    cat "$build/notarized.log"
    exit 1
  fi
  sleep 30
done
xcrun stapler validate "$build/notarized/Sidebots.app"
spctl --assess --type execute "$build/notarized/Sidebots.app"

echo "Making the disk image"
rm -rf "$build/dmg" "$build/Sidebots.dmg"
mkdir -p "$build/dmg"
ditto "$build/notarized/Sidebots.app" "$build/dmg/Sidebots.app"
ln -s /Applications "$build/dmg/Applications"
hdiutil create -volname Sidebots -srcfolder "$build/dmg" -format UDZO -quiet "$build/Sidebots.dmg"
rm -rf "$build/dmg"
echo "Built $build/Sidebots.dmg"

# The update feed names the disk image on the GitHub release for this version,
# with its length and its signature by the update key, which Sparkle checks
# against the public key in Info.plist before it installs.
version=$(plutil -extract CFBundleShortVersionString raw "$info")
signature=$("$mac/.build/artifacts/sparkle/Sparkle/bin/sign_update" "$build/Sidebots.dmg")
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
