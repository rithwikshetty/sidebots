# How mac/build.sh signs code, which it sources with $mac set to this folder and
# $identity to a code signing identity in the keychain, or "-" to sign for this Mac only.

timestamp=--timestamp
[ "$identity" = "-" ] && timestamp=--timestamp=none
sign() { codesign --force --options runtime "$timestamp" --sign "$identity" "$@"; }

# Signs the desktop app at $1 from the inside out: the programs inside Electron's
# frameworks and every native module, then the frameworks, the four helper apps
# and the app. The app and its helpers compile JavaScript as they run, and the
# plugin helper also runs code that isn't signed with this identity.
sign_desktop() {
  local desktop=$1
  local frameworks=$desktop/Contents/Frameworks
  local electron="$frameworks/Electron Framework.framework/Versions/A"
  sign "$electron"/Libraries/*.dylib "$electron"/Helpers/* "$frameworks/Squirrel.framework/Versions/A/Resources/ShipIt"
  find "$desktop" -type f -name '*.node' -print0 |
    while IFS= read -r -d '' file; do sign "$file"; done
  sign "$frameworks"/*.framework
  sign --entitlements "$mac/desktop.entitlements" "$frameworks/Sidebots Helper.app" "$frameworks/Sidebots Helper (Renderer).app" "$frameworks/Sidebots Helper (GPU).app"
  sign --entitlements "$mac/desktop-plugin.entitlements" "$frameworks/Sidebots Helper (Plugin).app"
  sign --entitlements "$mac/desktop.entitlements" "$desktop"
}
