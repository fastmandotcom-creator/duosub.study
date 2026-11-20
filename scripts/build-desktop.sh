#!/usr/bin/env bash
# Cross-platform build entry point. Signing/notarization only applies to the macOS artifact;
# Windows (MSI/NSIS) and Linux (DEB/AppImage) are built with Tauri's native bundlers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 1/2 tests + frontend build"
npm test
npm run build

case "$(uname -s)" in
  Darwin)
    echo "==> 2/2 Tauri bundle (macOS)"
    (cd desktop && npm run tauri build)

    APP="$(find desktop/src-tauri/target/release/bundle/macos -maxdepth 1 -name 'DuoSub Desktop.app' -print -quit)"
    [ -n "$APP" ] || { echo "Tauri did not produce an .app bundle" >&2; exit 1; }

    echo "==> sign + notarize $APP"
    bash scripts/sign-desktop.sh "$APP"
    if [ -n "${DUOSUB_NOTARY_PROFILE:-}" ]; then
      DMG="$(find desktop/src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit)"
      xcrun notarytool submit "$DMG" --keychain-profile "$DUOSUB_NOTARY_PROFILE" --wait
      xcrun stapler staple "$DMG"
    else
      echo "DUOSUB_NOTARY_PROFILE is unset — skipped notarization (dev build only)." >&2
    fi
    ;;
  Linux)
    echo "==> 2/2 Tauri bundle (Linux: deb + AppImage)"
    (cd desktop && npm run tauri build)
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
