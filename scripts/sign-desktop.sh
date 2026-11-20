#!/usr/bin/env bash
# Sign DuoSub Desktop.app with a stable identity. Never ad-hoc.
set -euo pipefail
APP="${1:?path to DuoSub Desktop.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/desktop/src-tauri/entitlements.plist"
[ -d "$APP" ] || { echo "not an app bundle: $APP" >&2; exit 1; }

IDENTITY="${DUOSUB_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(bash "$ROOT/scripts/ensure-signing-identity.sh")"
fi
case "$IDENTITY" in
  ""|-|ad-hoc|adhoc)
    echo "Refusing ad-hoc sign. Developer ID is required for a one-click DMG." >&2
    exit 1
    ;;
esac

RUNTIME=()
TIMESTAMP=(--timestamp=none)
if [[ "$IDENTITY" == Developer\ ID\ Application:* ]]; then
  RUNTIME=(--options runtime)
  TIMESTAMP=(--timestamp)
fi

shopt -s nullglob
for lib in "$APP/Contents/MacOS"/*.dylib "$APP/Contents/Frameworks"/*.dylib "$APP/Contents/Frameworks"/*.framework; do
  codesign --force --sign "$IDENTITY" ${RUNTIME+"${RUNTIME[@]}"} ${TIMESTAMP+"${TIMESTAMP[@]}"} "$lib"
done
codesign --force --deep --sign "$IDENTITY" ${RUNTIME+"${RUNTIME[@]}"} ${TIMESTAMP+"${TIMESTAMP[@]}"} \
  --entitlements "$ENTITLEMENTS" --identifier com.duosub.desktop "$APP"

codesign --verify --strict --verbose=2 "$APP"
SIG="$(codesign -dv "$APP" 2>&1 || true)"
echo "$SIG" | grep -q "Signature=adhoc" && { echo "ad-hoc signature detected" >&2; exit 1; }
echo "Signed $APP"
echo "$SIG" | grep -E "Identifier|Authority|Signature|TeamIdentifier" || true
