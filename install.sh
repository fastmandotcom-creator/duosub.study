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
APP_NAME="DuoSub Bridge.app"
PORT="${DUOSUB_PORT:-4499}"
HOME_DIR="$HOME/.duosub"
MODELS_DIR="$HOME_DIR/models"
LABEL="com.duosub.bridge"
SELF_URL="https://github.com/$REPO/releases/latest/download/install.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

uninstall() {
  say "Stopping and removing the DuoSub Bridge…"
  # Legacy labels from the pre-.app era (bare CLI binary) — never run two bridges on one port.
  for legacy in com.duosub.wisp-bridge; do
    launchctl bootout "gui/$(id -u)/$legacy" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$legacy.plist"
  done
  pkill -f "$HOME/.duosub/duosub-bridge" 2>/dev/null || true
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
  --update|"") ;;
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
asset="duosub-bridge-macos-$rust_arch.app.zip"

# --- 2. Download ------------------------------------------------------------
mkdir -p "$HOME_DIR"
url="https://github.com/$REPO/releases/latest/download/$asset"
say "Downloading ${asset}…"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! curl -fL --progress-bar "$url" -o "$tmp/$asset"; then
  die "No release build for $os/$rust_arch yet ($url).
     Build from source instead:  git clone --recurse-submodules https://github.com/$REPO && cd $REPO/bridge && cargo build --release"
fi
unzip -q "$tmp/$asset" -d "$tmp"

# The bridge ships as a real .app: macOS attributes ScreenCaptureKit (system audio) to the BUNDLE
# identity and gates it behind TCC. A bare CLI binary can never get that grant.
# Drop the pre-rename lowercase bundle if it lingers (same signing id, but one app only).
for stale in "/Applications/duosub-bridge.app" "$HOME/Applications/duosub-bridge.app"; do
  [ -d "$stale" ] && rm -rf "$stale" || true
done
APP_SRC="$tmp/$APP_NAME"
[ -d "$APP_SRC" ] || die "Release archive is malformed (no $APP_NAME)."
APP_DIR=""
for dir in "/Applications" "$HOME/Applications"; do
  if [ -d "$dir" ] && [ -w "$dir" ]; then APP_DIR="$dir"; break; fi
  [ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ] && { APP_DIR="$dir"; break; }
done
[ -n "$APP_DIR" ] || APP_DIR="$HOME/Applications" && mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/$APP_NAME"
cp -R "$APP_SRC" "$APP_DIR/$APP_NAME"
BIN="$APP_DIR/$APP_NAME/Contents/MacOS/duosub-bridge"
say "Installed to $APP_DIR/$APP_NAME"

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
  # Registering with Launch Services is what lets macOS attribute the app bundle identity for the
  # Screen Recording permission prompt (a background LaunchAgent alone cannot prompt reliably).
  open -g -a "$APP_DIR/$APP_NAME" 2>/dev/null || true
fi

# --- 4. Wait until it answers -----------------------------------------------
say "Starting the bridge (first run downloads the speech model, ~250 MB)…"
for _ in $(seq 1 150); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:$PORT/health"; echo
    if curl -fsS "http://127.0.0.1:$PORT/health" | grep -q '"system_audio":"denied"'; then
      # Nudge the bridge to fire the OS permission request: macOS opens System Settings at the
      # Screen Recording page with "DuoSub Bridge" pre-listed — the user flips ONE toggle.
      curl -sS -X POST "http://127.0.0.1:$PORT/sessions/start" -H 'Content-Type: application/json' \
        -d '{"language":"auto","sources":["system"]}' >/dev/null 2>&1 || true
      curl -sS -X POST "http://127.0.0.1:$PORT/sessions/stop" >/dev/null 2>&1 || true
      warn "ONE TOGGLE LEFT — System Settings just opened at Screen & System Audio Recording:"
      warn "  turn ON \"DuoSub Bridge\", then re-run:  bash <(curl -fsSL $SELF_URL) --status"
      warn "  (nothing else to find or type — the app is already listed on that page)"
      exit 0
    fi
    say "DONE. In the LiveCode extension: Settings → Live Caption (ASR) → Caption source → \"Wisp ASR (on-device)\"."
    say "No token, no account, no cloud — audio never leaves this machine."
    exit 0
  fi
  sleep 2
done
die "The bridge did not answer within 5 minutes. Check $LOG_DIR/duosub-bridge.log"
