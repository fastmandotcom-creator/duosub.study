#!/usr/bin/env bash
# Build the signed/notarized DuoSub Desktop DMG. Refuses ad-hoc signing: Gatekeeper blocking the
# first launch is exactly the "not big tech" failure this script exists to prevent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 1/3 tests + frontend build"
npm test
npm run build

echo "==> 2/3 Tauri bundle"
(cd desktop && npm run tauri build)

APP="$(find desktop/src-tauri/target/release/bundle/macos -maxdepth 1 -name 'DuoSub Desktop.app' -print -quit)"
[ -n "$APP" ] || { echo "Tauri did not produce an .app bundle" >&2; exit 1; }

echo "==> 3/3 sign + notarize $APP"
bash scripts/sign-desktop.sh "$APP"
if [ -n "${DUOSUB_NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$ROOT/desktop/src-tauri/target/release/bundle/dmg/DuoSub Desktop_"*.dmg \
    --keychain-profile "$DUOSUB_NOTARY_PROFILE" --wait
  DMG="$(find desktop/src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit)"
  xcrun stapler staple "$DMG"
else
  echo "DUOSUB_NOTARY_PROFILE is unset — skipped notarization (dev build only)." >&2
fi
