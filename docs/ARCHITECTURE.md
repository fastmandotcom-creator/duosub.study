# DuoSub architecture

Four layers, one wire contract. Nothing above the bridge knows which OS it runs on.

```
┌───────────────────────────────────────────────────────────────┐
│ Clients                                                       │
│  desktop/ (Tauri + React)   LiveCode extension (browser)       │
│  UI · translation · overlay · history    UI + cloud-live ASR   │
└───────────────┬──────────────────────────┬────────────────────┘
                │ HTTP/SSE :4499           │ WebSocket (vendor)
┌───────────────▼──────────────┐  ┌────────▼───────────────────┐
│ bridge/ (Rust/axum)          │  │ Gemini Live / OpenAI       │
│ /health /sessions /events    │  │ Realtime (audio never used │
│ lease + capability report    │  │ by desktop app — text only)│
└───────────────┬──────────────┘  └────────────────────────────┘
┌───────────────▼──────────────┐
│ vendor/wisp (submodule)      │
│ capture · VAD · ASR engines  │
│ macOS: SCK + Apple Speech    │
│ Windows: WASAPI + Whisper    │
│ Linux: cpal mic (system TBD) │
└──────────────────────────────┘
```

## Folder responsibilities

| Path | Owns | Must NOT own |
| --- | --- | --- |
| `packages/caption-contract/` | wire types + defensive parsers | transport, UI, OS logic |
| `desktop/src/platform/` | OS detection, capabilities, binary resolution | business rules |
| `desktop/src/bridge/` | HTTP client, install hints per host | caption state |
| `desktop/src/caption/` | pure partial→final upsert | I/O |
| `desktop/src/translation/` | text translation + debounce/cancel | audio capture |
| `desktop/src/store/` | orchestration only | platform-specific branches |
| `desktop/src-tauri/src/platform/` | native OS implementations | caption/translation logic |
| `bridge/src/platform.rs` | host capability report | capture implementation |
| `bridge/src/api.rs`, `session.rs` | HTTP + pipeline | OS string comparisons |

## Invariants

1. **One caption protocol.** Golden bytes are pinned by Rust tests (`contract.rs`) and by TS tests
   (`packages/caption-contract`). A field rename fails both before it reaches a client.
2. **One capture session.** The bridge keeps a single session slot; an advisory lease with TTL
   heartbeat tells a second GUI client who owns it.
3. **Audio stays local in the desktop app.** Only recognised text goes to the cloud translator.
4. **Capability, not OS sniffing.** Clients read `/health.platform`, `capture_backend`,
   `system_audio_supported` and `apple_speech_available` instead of `cfg!(macos)`-style guesses in UI.
5. **Pure core, thin edges.** Caption upsert, export and vocabulary are testable without a browser.

See [CROSS_PLATFORM.md](CROSS_PLATFORM.md) for the port status and the remaining work.
