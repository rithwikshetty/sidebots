#!/bin/bash
# Builds the published Sidebots for iPhone, uploads it to App Store Connect, and waits until Apple has
# processed it and TestFlight offers it.
#
#   mobile/testflight.sh          Makes the native project, archives it, uploads the archive and waits.
#   mobile/testflight.sh upload   Uploads the archive the last run made and waits, for when Apple's servers failed the upload.
#
# The build number is the count of commits, as in mac/build.sh, so a later commit always uploads a
# higher one. Xcode signs and uploads with the Apple account signed in to it, on the team in .env.local.
# The wait asks App Store Connect with the API key .env.local names.
set -euo pipefail
# CocoaPods needs a UTF-8 locale.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
# The published app, not Sidebots Dev.
unset APP_VARIANT

mobile=$(cd "$(dirname "$0")" && pwd)
cd "$mobile"
build=ios/build
archive=$build/Sidebots.xcarchive

# One value from .env.local.
setting() { sed -n "s/^$1=//p" .env.local; }

# Runs xcodebuild with its output in a log, and shows the log's errors when it fails.
xcode() {
  local log=$build/$1.log
  shift
  xcodebuild "$@" >"$log" 2>&1 || {
    grep -E "error:|\*\* .* FAILED \*\*" "$log" | tail -20 >&2
    echo "The full log is $mobile/$log" >&2
    exit 1
  }
}

if [ "${1:-}" != upload ]; then
  export SIDEBOTS_BUILD_NUMBER
  SIDEBOTS_BUILD_NUMBER=$(git rev-list --count HEAD)
  echo "Making the native project for build $SIDEBOTS_BUILD_NUMBER"
  pnpm install --frozen-lockfile --reporter=silent
  CI=1 npx expo prebuild --platform ios --clean --no-install
  (cd ios && pod install --silent)
  mkdir -p "$build"

  echo "Archiving"
  xcode archive -workspace ios/Sidebots.xcworkspace -scheme Sidebots -configuration Release \
    -destination generic/platform=iOS -archivePath "$archive" -allowProvisioningUpdates archive
fi

echo "Uploading to App Store Connect"
cat >"$build/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$(setting SIDEBOTS_APPLE_TEAM_ID)</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF
rm -rf "$build/export"
xcode upload -exportArchive -archivePath "$archive" -exportOptionsPlist "$build/ExportOptions.plist" \
  -exportPath "$build/export" -allowProvisioningUpdates
info=$archive/Products/Applications/Sidebots.app/Info.plist
echo "Uploaded Sidebots $(plutil -extract CFBundleShortVersionString raw "$info"), build $(plutil -extract CFBundleVersion raw "$info")"

node testflight-build.mjs "$(plutil -extract CFBundleIdentifier raw "$info")" "$(plutil -extract CFBundleVersion raw "$info")" \
  "$(setting SIDEBOTS_ASC_KEY_ID)" "$(setting SIDEBOTS_ASC_ISSUER_ID)"
