# DuoSub Desktop

A macOS menubar app that turns the headless DuoSub bridge into a complete live-caption product:
translation, always-on-top overlay, global hotkeys, per-app profiles, custom vocabulary, transcript
history, export, autostart and one-click diagnostics.

```
┌──────────────────────────────────────────────┐
│ DuoSub Desktop (Tauri 2 + React/TS)          │  UI · translation · overlay · history
└───────────┬──────────────────────────────────┘
            │ HTTP + SSE (shared caption contract)
┌───────────▼──────────────────────────────────┐
│ duosub-bridge (Rust, unchanged ASR core)     │  capture · on-device ASR · model download
└──────────────────────────────────────────────┘
```

The bridge is bundled as a **sidecar**: the app spawns it on first health miss, so end users never
run a `curl | bash` command themselves. Audio never leaves the machine — only recognised *text* is
sent to the optional cloud translator.

## Run locally

```bash
# from the repository root
npm install
npm run mock     # terminal 1: fake bridge with synthetic captions on :4499
npm run dev      # terminal 2: Vite dev server on :1420
```

Open http://127.0.0.1:1420. Onboarding lets you pick spoken/target language and paste an optional
Gemini/OpenAI key. Click **Start captions** and synthetic utterances stream in with source →
translation rows. The overlay tab works in a second browser tab via `BroadcastChannel`.

### Real bridge / full native app

```bash
npm run tauri dev          # native window, tray, hotkeys, real bridge
bash scripts/build-desktop.sh   # signed + notarized DMG (needs DUOSUB_SIGN_IDENTITY)
```

To let the app launch a locally built bridge, set `DUOSUB_BRIDGE_BINARY` to the built executable or
copy it to the app's local data dir as `duosub-bridge`.

## Quality gates

```bash
npm test                 # 33 TS tests: wire contract, caption upsert, translation, export, SSE
npm run typecheck
(cd bridge && cargo test) # 15 Rust tests incl. golden wire bytes + lease expiry
(cd desktop/src-tauri && cargo check)
```

## Features by phase

| Phase | Shipped |
| --- | --- |
| 0 — shell | Tauri sidecar, one DMG, signed/notarized release gate, 3-step onboarding, SSE client with resume, status pill, tray, hotkeys, autostart |
| 1 — translation | Two-axis presets (ASR source × translator); **text-only** Gemini/OpenAI streaming translation with debounced partials + final refinement; Apple Speech → Whisper auto-route; capture lease with TTL heartbeat |
| 2 — daily use | Overlay, per-app profiles, custom vocabulary, transcript search + SRT/VTT/TXT export, auto-update command |
| 3 — polish | i18n (vi/en), one-click diagnostics, auto-reap of orphan sessions (bridge-side) |

### Deliberate non-goals in v1

- **Cloud audio ASR** (`cloud-live`) stays in the LiveCode extension. Sending audio to a vendor
  conflicts with the privacy promise of this app; text translation gives the same readable output
  without exporting audio. The bridge's `mode: "capture"` wire path remains available.
- **On-device NLLB translation** is not bundled. It would require shipping a multi-GB model and
  cannot produce sub-second drafts. The translator interface accepts a future `OnDeviceTranslator`.
- **OCR / TTS / diarization** are deferred until retention data justifies the maintenance cost.

## Architecture notes

- `packages/caption-contract` is dependency-free TypeScript; both clients parse defensively and
  never throw on an unknown bridge field. The Rust bridge pins the same bytes with golden tests.
- The bridge keeps ONE capture session. A 15-second reaper stops sessions with no live subscriber
  for 3 minutes, so a crashed app cannot burn CPU cores forever.
- A heartbeat lease (`/sessions/claim|heartbeat|release|owner`) tells a second GUI client *who*
  owns capture. It is advisory: the hard guard remains the bridge's single-session slot (409).
- The translation stage is separate from the extension's `cloudLiveCaptionProducer`: that module
  streams audio to a vendor ASR+MT model, whereas this app streams only recognised text.
