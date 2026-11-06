#!/usr/bin/env bash
# Sign DuoSub Bridge.app with a stable identity. Never ad-hoc.
# Usage: scripts/sign-bridge.sh "/Applications/DuoSub Bridge.app"
set -euo pipefail

APP="${1:?path to DuoSub Bridge.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/scripts/bridge.entitlements.plist"
[ -d "$APP" ] || { echo "not an app bundle: $APP" >&2; exit 1; }

IDENTITY="${DUOSUB_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(bash "$ROOT/scripts/ensure-signing-identity.sh")"
fi
case "$IDENTITY" in
  ""|-|ad-hoc|adhoc)
    echo "Refusing ad-hoc sign. A stable certificate is required so Screen Recording survives updates." >&2
    exit 1
    ;;
esac

TIMESTAMP=(--timestamp=none)
RUNTIME=()
# Hardened runtime blocks the system Swift dylibs this binary loads via DYLD_FALLBACK.
# Developer ID + notarization turns it on. The stable local identity does not, so updates
# keep the same certificate requirement without killing launch.
if [[ "$IDENTITY" == Developer\ ID\ Application:* ]]; then
  TIMESTAMP=(--timestamp)
  RUNTIME=(--options runtime)
fi

sign_one() {
  codesign --force --sign "$IDENTITY" ${RUNTIME+"${RUNTIME[@]}"} ${TIMESTAMP+"${TIMESTAMP[@]}"} "$@"
}

shopt -s nullglob
for lib in "$APP/Contents/MacOS"/*.dylib "$APP/Contents/Frameworks"/*.dylib; do
  sign_one "$lib"
done
sign_one --identifier study.duosub.bridge --entitlements "$ENTITLEMENTS" \
  "$APP/Contents/MacOS/duosub-bridge"
sign_one --identifier study.duosub.bridge --entitlements "$ENTITLEMENTS" "$APP"

codesign --verify --strict --verbose=2 "$APP"
SIG="$(codesign -dv "$APP" 2>&1 || true)"
if echo "$SIG" | grep -q "Signature=adhoc"; then
  echo "Sign produced an ad-hoc signature. Refusing to install." >&2
  exit 1
fi
echo "Signed $APP"
echo "$SIG" | grep -E "Identifier|Authority|Signature|TeamIdentifier" || true
codesign -d -r- "$APP" 2>&1 | head -3
