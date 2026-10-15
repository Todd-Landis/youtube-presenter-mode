#!/usr/bin/env bash
# Builds a small Mac app that contains the extension and installs it in
# ~/Applications, so the extension stays in Safari across restarts.
#
# Needs full Xcode (not just the Command Line Tools). For Safari to trust the
# build without "Allow unsigned extensions", add an Apple ID in Xcode ▸
# Settings ▸ Accounts first (a free account works): the app is then signed
# with your Apple Development certificate. Without one, it falls back to
# ad-hoc signing and still needs the unsigned-extensions toggle.
#
# Optional overrides: TEAM_ID, BUNDLE_ID.
set -euo pipefail
cd "$(dirname "$0")/.."

# Use Xcode.app even if xcode-select still points at the Command Line Tools.
if ! xcodebuild -version >/dev/null 2>&1 && [ -d /Applications/Xcode.app ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Full Xcode is required. Install it from the App Store and open it once." >&2
  exit 1
fi

APP_NAME="YouTube Presenter Mode"
OUT="xcode"

# The team ID is the OU field of the Apple Development certificate.
if [ -z "${TEAM_ID:-}" ]; then
  TEAM_ID=$(security find-certificate -c "Apple Development" -p 2>/dev/null |
    openssl x509 -noout -subject 2>/dev/null |
    sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1 || true)
fi
BUNDLE_ID="${BUNDLE_ID:-local.$(id -un).youtube-presenter-mode}"

# The generated project references extension/ in place, so every build
# picks up the current files.
if [ ! -d "$OUT" ]; then
  xcrun safari-web-extension-converter extension \
    --project-location "$OUT" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$BUNDLE_ID" \
    --macos-only --swift --no-open --no-prompt
  # The converter derives the app's ID from the app name, which can differ in
  # case from the extension's prefix; Xcode then refuses to embed it.
  sed -i '' -E "/\.Extension\"?;/! s/(PRODUCT_BUNDLE_IDENTIFIER = )\"?[^\";]+\"?;/\1\"$BUNDLE_ID\";/" \
    "$(find "$OUT" -maxdepth 3 -name '*.xcodeproj' | head -1)/project.pbxproj"
fi

PROJECT=$(find "$OUT" -maxdepth 3 -name '*.xcodeproj' | head -1)

# Or the team picked in Xcode's Signing & Capabilities editor.
if [ -z "$TEAM_ID" ]; then
  TEAM_ID=$(sed -n 's/.*DEVELOPMENT_TEAM = \([A-Z0-9]\{10\}\);.*/\1/p' "$PROJECT/project.pbxproj" | head -1)
fi

if [ -n "$TEAM_ID" ]; then
  echo "Signing with team $TEAM_ID"
  SIGN_ARGS=(-allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development")
else
  echo "No Apple Development certificate found; using ad-hoc signing"
  SIGN_ARGS=(CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO)
fi

xcodebuild -project "$PROJECT" -scheme "$APP_NAME" -configuration Release \
  -derivedDataPath "$OUT/build" "${SIGN_ARGS[@]}" build

BUILT=$(find "$OUT/build/Build/Products/Release" -maxdepth 1 -name '*.app' | head -1)
DEST="$HOME/Applications/$(basename "$BUILT")"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$BUILT" "$DEST"
codesign -dvv "$DEST" 2>&1 | grep -E '^(Authority|TeamIdentifier|Signature)=' | head -2 || true

# Launching the app once registers the extension with Safari.
open "$DEST"
echo
echo "Installed: $DEST"
echo "Now enable it in Safari ▸ Settings ▸ Extensions (and remove any temporary copy)."
