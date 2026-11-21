#!/usr/bin/env bash
# Simple build entry point. Signing is optional: when a stable identity is configured the artifact
# is signed/notarized; otherwise the build still succeeds and CI marks the artifact as unsigned.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 1/2 tests + frontend build"
npm test
npm run build

case "$(uname -s)" in
  Darwin)
    echo "==> 2/2 Tauri bundle (macOS: app + dmg)"
    (cd desktop && npm run tauri build)
    if [ -n "${DUOSUB_SIGN_IDENTITY:-}" ]; then
      APP="$(find desktop/src-tauri/target/release/bundle/macos -maxdepth 1 -name 'DuoSub Desktop.app' -print -quit)"
      [ -n "$APP" ] || { echo "Tauri did not produce an .app bundle" >&2; exit 1; }
      bash scripts/sign-desktop.sh "$APP"
      if [ -n "${DUOSUB_NOTARY_PROFILE:-}" ]; then
        DMG="$(find desktop/src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit)"
        xcrun notarytool submit "$DMG" --keychain-profile "$DUOSUB_NOTARY_PROFILE" --wait
        xcrun stapler staple "$DMG"
      fi
    else
      echo "NOTE: DUOSUB_SIGN_IDENTITY is unset — publishing an unsigned DMG (right-click → Open)." >&2
    fi
    ;;
  Linux)
    echo "==> 2/2 Tauri bundle (Linux: deb + AppImage)"
    (cd desktop && npm run tauri build)
    [ -z "${LINUX_GPG_PRIVATE_KEY:-}" ] || bash scripts/sign-linux.sh
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "==> 2/2 Tauri bundle (Windows: msi + nsis)"
    (cd desktop && npm run tauri build)
    ;;
  *)
    echo "unsupported host: $(uname -s)" >&2
    exit 1
    ;;
esac
