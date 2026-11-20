#!/usr/bin/env bash
# Sign Linux release artifacts: origin-sign the .deb with debsigs and detached-sign each AppImage
# with GPG. Refuses to run without an imported key — unsigned packages are not releasable.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/desktop/src-tauri/target/release/bundle"

: "${LINUX_GPG_PRIVATE_KEY:?LINUX_GPG_PRIVATE_KEY is required (base64-armoured private key)}"
: "${LINUX_GPG_FINGERPRINT:?LINUX_GPG_FINGERPRINT is required}"

export GNUPGHOME="$(mktemp -d)"
trap 'rm -rf "$GNUPGHOME"' EXIT
chmod 700 "$GNUPGHOME"
printf '%s' "$LINUX_GPG_PRIVATE_KEY" | base64 --decode | gpg --batch --import >/dev/null 2>&1

shopt -s nullglob
count=0
for deb in "$BUNDLE"/deb/*.deb; do
  debsigs --sign=origin --default-key="$LINUX_GPG_FINGERPRINT" "$deb"
  echo "Signed $deb"
  count=$((count + 1))
done
for appimage in "$BUNDLE"/appimage/*.AppImage; do
  gpg --batch --yes --armor --detach-sign \
    --local-user "$LINUX_GPG_FINGERPRINT" \
    --output "$appimage.sig" "$appimage"
  echo "Signed $appimage"
  count=$((count + 1))
done
if [ "$count" -eq 0 ]; then
  echo "No Linux artifacts found under $BUNDLE — did Tauri bundle?" >&2
  exit 1
fi
