# DuoSub Desktop

A macOS menubar app that shows live captions captured on this machine. The app is deliberately
small: one caption source, one start/stop button, and honest status. Cloud translation is opt-in.

```
┌──────────────────────────────────────────────┐
│ DuoSub Desktop (Tauri 2 + React/TS)          │  Start/Stop · captions · overlay
└───────────┬──────────────────────────────────┘
            │ HTTP control + SSE (caption contract)
┌───────────▼──────────────────────────────────┐
│ duosub-bridge (Rust, separate LaunchAgent)   │  capture · on-device ASR · model download
└──────────────────────────────────────────────┘
```

The bridge is a **separate product**, installed by the release `.dmg` / `install.sh`. The app talks
to it on `http://127.0.0.1:4499`. Audio is captured on-device; translation is off by default and
only sends recognised text to Gemini/OpenAI when the user supplies an API key.

## Run locally

```bash
npm install
npx tauri dev          # requires a bridge on :4499 (real or mock)
```

Open the window, press **Bắt đầu phụ đề / Start captions**, and captions stream in. Press **Stop**
when done. There is no auto-start and no auto-restart — the button is the single source of truth.

## Lifecycle rules (load-bearing)

1. **Only the user starts a session.** No launch warm-up, no self-heal, no profile switching.
2. **`/health.session.active` is the only status source.** The UI never infers "live" from a local
   flag or a replayed caption list.
3. **Loopback HTTP goes through Rust.** WKWebView intermittently rejects `fetch` to 127.0.0.1 with
   `TypeError: Load failed`; the `bridge_request` command uses reqwest instead. SSE stays in the
   webview (EventSource works).
4. **No capture survives the client.** The app calls `POST /sessions/stop` on exit (tray + Tauri
   `ExitRequested` + SIGTERM handler). As a hard backstop, the bridge stops any session whose owner
   heartbeat expires (30s TTL, checked every 15s). E2E verified: no heartbeat → session `None`.
5. **Translation is opt-in.** Default provider `none`; a persisted cloud provider without an API
   key is downgraded to `none`. Disabled translation never shows a "Lỗi" row.

## Quality gates

```bash
npm test            # unit tests incl. wire contract, caption upsert, translation policy
npm run typecheck
npm run build
(cd ../../bridge && cargo test)        # 17 tests incl. golden wire bytes + lease
(cd src-tauri && cargo check)
```

## Deliberate non-goals

- No per-app profiles (added complexity across three OSes for little value).
- No reading of macOS Live Captions via Accessibility (permission is a dead end on this machine).
- No bundled NLLB translation (too heavy for sub-second drafts).
- No auto-start / auto-restart (was unreliable in `tauri dev`; removed on purpose).
