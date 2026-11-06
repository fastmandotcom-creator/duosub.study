#!/usr/bin/env bash
# One stable code-signing identity for DuoSub Bridge.
# Ad-hoc signing is forbidden: every rebuild gets a new cdhash and macOS drops
# the Screen Recording grant. This certificate is created once and reused.
set -euo pipefail

CN="DuoSub Bridge Signing"
DIR="${DUOSUB_SIGNING_DIR:-$HOME/.duosub/signing}"
KEYCHAIN="${DUOSUB_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

if security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}'
  exit 0
fi
if security find-identity -v -p codesigning | grep -q "$CN"; then
  echo "$CN"
  exit 0
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
CFG="$DIR/codesign.cnf"
KEY="$DIR/key.pem"
CERT="$DIR/cert.pem"
P12="$DIR/identity.p12"
PASS_FILE="$DIR/password"

if [ ! -f "$P12" ]; then
  if [ ! -f "$PASS_FILE" ]; then
    umask 077
    openssl rand -base64 24 > "$PASS_FILE"
  fi
  PASS="$(cat "$PASS_FILE")"
  cat > "$CFG" <<CFG
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = codesign
[ dn ]
CN = $CN
O = DuoSub
[ codesign ]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CFG
  openssl req -x509 -new -nodes -keyout "$KEY" -out "$CERT" -days 3650 -config "$CFG" >/dev/null 2>&1
  # macOS `security import` rejects OpenSSL 3's default PKCS12 MAC. Use the legacy suite.
  openssl pkcs12 -export -legacy -out "$P12" -inkey "$KEY" -in "$CERT" -passout "pass:$PASS" >/dev/null
  chmod 600 "$KEY" "$P12" "$PASS_FILE"
fi

PASS="$(cat "$PASS_FILE")"
security import "$P12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security add-trusted-cert -r trustRoot -k "$KEYCHAIN" "$CERT" >/dev/null
# Allow codesign to use the key without a GUI prompt on this machine.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASS" "$KEYCHAIN" >/dev/null 2>&1 || true

if ! security find-identity -v -p codesigning | grep -q "$CN"; then
  echo "Imported $CN but codesign cannot see it. Unlock the login keychain and re-run." >&2
  exit 1
fi
echo "$CN"
