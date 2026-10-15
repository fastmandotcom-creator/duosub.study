#!/usr/bin/env bash
# duosub.study — one-command installer for the DuoSub Bridge (on-device system-audio → live captions).
#
#   curl -fsSL https://duosub.study/install.sh | bash
#
# What it does (no prompts, no account, no token):
#   1. Downloads the prebuilt bridge for your OS/arch from GitHub Releases into ~/.duosub.
#   2. Registers it to auto-start at login (macOS LaunchAgent).
#   3. Starts it and waits until http://127.0.0.1:4499/health answers.
#
# Uninstall:  bash <(curl -fsSL https://duosub.study/install.sh) --uninstall
# Status:      bash <(curl -fsSL https://duosub.study/install.sh) --status
set -euo pipefail

REPO="fastmandotcom-creator/duosub.study"
PORT="${DUOSUB_PORT:-4499}"
HOME_DIR="$HOME/.duosub"
BIN="$HOME_DIR/duosub-bridge"
LABEL="com.duosub.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

uninstall() {
  say "Stopping and removing the DuoSub Bridge…"
  if [ -f "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
  fi
  pkill -f "$BIN" 2>/dev/null || true
  say "Uninstalled. The extension falls back to Web CC automatically."
}

status() {
  if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null; then
    echo
    say "Bridge is running at http://127.0.0.1:$PORT"
  else
    warn "Bridge is not responding. Start it with: $BIN"
  fi
}

case "${1:-}" in
  --uninstall) uninstall; exit 0 ;;
  --status)    status;    exit 0 ;;
  --help|-h)   sed -n '2,14p' "$0"; exit 0 ;;
esac

# --- 1. Platform ------------------------------------------------------------
os="$(uname -s)"; arch="$(uname -m)"
case "$arch" in
  arm64|aarch64) rust_arch="arm64" ;;
  x86_64|amd64)  rust_arch="x64" ;;
  *) die "Unsupported CPU architecture: $arch" ;;
esac
if [ "$os" != "Darwin" ]; then
  warn "The DuoSub Bridge currently supports macOS only (system-audio capture). $os is not supported yet."
  exit 1
fi
asset="duosub-bridge-macos-$rust_arch.tar.gz"

# --- 2. Download ------------------------------------------------------------
mkdir -p "$HOME_DIR"
url="https://github.com/$REPO/releases/latest/download/$asset"
say "Downloading $asset…"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! curl -fL --progress-bar "$url" -o "$tmp/$asset"; then
  die "No release build for $os/$rust_arch yet ($url).
     Build from source instead:  git clone https://github.com/$REPO && cd $REPO/bridge && cargo build --release"
fi
tar -xzf "$tmp/$asset" -C "$tmp"
# The tarball ships the binary plus its native dylibs (macOS).
found="$(find "$tmp" -type f -name 'duosub-bridge' -perm -u+x | head -1)"
[ -n "$found" ] || die "Release archive is malformed (no duosub-bridge binary)."
cp "$found" "$BIN"
chmod +x "$BIN"
for lib in "$tmp"/*.dylib; do
  [ -e "$lib" ] && cp "$lib" "$HOME_DIR/"   # sit next to the binary (@loader_path rpath)
done
say "Installed to $BIN"

# --- 3. Auto-start at login -------------------------------------------------
if [ "$os" = "Darwin" ]; then
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>DUOSUB_PORT</key><string>$PORT</string>
    <key>DYLD_FALLBACK_LIBRARY_PATH</key><string>/usr/lib/swift</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/duosub-bridge.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/duosub-bridge.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
  say "Auto-start registered (starts at login, restarts if it stops)."
fi

# --- 4. Wait until it answers -----------------------------------------------
say "Starting the bridge (first run downloads the speech model, ~250 MB)…"
for _ in $(seq 1 150); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:$PORT/health"; echo
    say "DONE. In the LiveCode extension: Settings → Live Caption (ASR) → Caption source → \"Wisp ASR (on-device)\"."
    say "No token, no account, no cloud — audio never leaves this machine."
    exit 0
  fi
  sleep 2
done
die "The bridge did not answer within 5 minutes. Check $LOG_DIR/duosub-bridge.log"
