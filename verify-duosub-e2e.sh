#!/usr/bin/env bash
# verify-duosub-e2e.sh — end-to-end verification of the installed bridge, runnable by anyone (and CI-local here):
# session start → play a known speech sample into SYSTEM audio → assert a `final` transcript segment.
#
# Contract: the bridge must FAIL LOUD (non-2xx) when system capture is denied, and must produce a
# final segment when it is granted. Exit 0 = green, non-zero = red with the reason on stderr.
set -euo pipefail

BASE="${DUOSUB_BASE:-http://127.0.0.1:4499}"
SAMPLE_TEXT="${DUOSUB_SAMPLE_TEXT:-the quick brown fox jumps over the lazy dog}"
TIMEOUT_S="${DUOSUB_E2E_TIMEOUT:-90}"

fail() { echo "E2E FAIL: $*" >&2; exit 1; }
say()  { echo "E2E: $*"; }

# --- 1. The bridge must be reachable -----------------------------------------
health="$(curl -fsS "$BASE/health" || true)"
[ -n "$health" ] || fail "bridge not reachable at $BASE (run install.sh first)"
say "health: $health"
grant="$(echo "$health" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("system_audio","?"))')"

# --- 2. Denied permission MUST fail loud (the whole point of the 503 contract) -
if [ "$grant" != "granted" ]; then
  code="$(curl -sS -o /tmp/duosub-e2e-err.json -w '%{http_code}' -X POST "$BASE/sessions/start" \
      -H 'Content-Type: application/json' -d '{"language":"auto","sources":["system"]}')"
  body="$(cat /tmp/duosub-e2e-err.json)"
  if [ "$code" = "503" ] && echo "$body" | grep -q "Screen Recording"; then
    say "permission denied → session start correctly refused (HTTP 503 with remediation)."
    say "grant it in System Settings → Privacy & Security → Screen & System Audio Recording, then re-run."
    exit 2   # distinct code: "blocked by OS permission", NOT a bug
  fi
  fail "expected HTTP 503 + remediation when capture is denied, got HTTP $code: $body"
fi

# --- 3. Granted: synthesize speech into SYSTEM audio and expect a final segment
say "permission granted → starting session and playing speech into system audio…"
start_body="$(curl -fsS -X POST "$BASE/sessions/start" -H 'Content-Type: application/json' \
    -d '{"language":"en","sources":["system"]}')" \
  || fail "session start failed while permission is granted"
# The event ring replays earlier sessions; only accept segments from THIS session.
session_id="$(echo "$start_body" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("sessionId",""))')"
[ -n "$session_id" ] || fail "session start returned no sessionId: $start_body"

[ -x /usr/bin/say ] && { ( /usr/bin/say -v Samantha -o /tmp/duosub-e2e.aiff "$SAMPLE_TEXT" && /usr/bin/afplay /tmp/duosub-e2e.aiff &>/dev/null & ); true; } \
  || fail "this verifier needs macOS /usr/bin/say (extend it for your platform)"

deadline=$(( $(date +%s) + TIMEOUT_S ))
seen=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  ev="$(curl -fsS --max-time 5 "$BASE/events?since=0" 2>/dev/null | SESSION_ID="$session_id" python3 -c '
import os, sys, json
sid = os.environ["SESSION_ID"]
try:
    events = json.load(sys.stdin).get("events", [])
except Exception:
    sys.exit(0)
for e in events:
    if e.get("session_id") == sid and e.get("kind") == "segment" and e.get("final") is True and e.get("text"):
        print(json.dumps(e))
        break
' || true)"
  if [ -n "$ev" ]; then
    txt="$(echo "$ev" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("text",""))' 2>/dev/null || true)"
    say "final segment: ${txt:0:120}"
    seen=1; break
  fi
  sleep 3
done

curl -fsS -X POST "$BASE/sessions/stop" >/dev/null 2>&1 || true
[ "$seen" = "1" ] || fail "no final segment within ${TIMEOUT_S}s while speech played into system audio"
say "GREEN: system audio → transcription works end to end."
