#!/usr/bin/env bash
# Wraps extension/ in a macOS app so the extension stays installed across
# Safari restarts (temporary extensions don't). Needs full Xcode, not just the
# Command Line Tools. The result is ad-hoc signed: keep Safari's
# "Allow unsigned extensions" on.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Full Xcode is required. Install it from the App Store, then run:"
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

APP_NAME="YouTube Presenter Mode"
OUT="xcode"

if [ ! -d "$OUT" ]; then
  xcrun safari-web-extension-converter extension \
    --project-location "$OUT" \
    --app-name "$APP_NAME" \
    --bundle-identifier local.ytpresenter \
    --macos-only --swift --copy-resources --no-open --no-prompt
fi

PROJECT=$(find "$OUT" -name '*.xcodeproj' -maxdepth 3 | head -1)
# --copy-resources snapshots extension/; refresh it so edits are picked up.
RES=$(find "$OUT" -type d -name Resources -path '*Extension*' | head -1)
if [ -n "$RES" ]; then rsync -a --delete --exclude '.DS_Store' extension/ "$RES/"; fi

xcodebuild -project "$PROJECT" -scheme "$APP_NAME" -configuration Release \
  -derivedDataPath "$OUT/build" CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO build

APP=$(find "$OUT/build/Build/Products/Release" -maxdepth 1 -name '*.app' | head -1)
echo
echo "Built: $APP"
echo "Run it once (open \"$APP\"), then enable the extension in Safari ▸ Settings ▸ Extensions."
