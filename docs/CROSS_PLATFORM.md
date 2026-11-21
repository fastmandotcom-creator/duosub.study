# Cross-platform status

Generated from the code in this repository, not from a roadmap slide.

| Capability | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Desktop shell (Tauri + React) | ✅ | ✅ config + native platform module | ✅ config + native platform module |
| Tray / global hotkeys | ✅ | ✅ Tauri plugins | ✅ Tauri plugins |
| Overlay window | ✅ | ✅ | ✅ (Wayland compositor permitting) |
| Autostart | ✅ LaunchAgent | ✅ Registry task (plugin) | ✅ XDG autostart (plugin) |
| On-device ASR | ✅ Apple Speech + SenseVoice + Whisper | ✅ Whisper engine | ✅ Whisper engine |
| System/meeting audio capture | ✅ ScreenCaptureKit | ✅ WASAPI loopback (`wisp-loopback`) | ✅ PulseAudio/PipeWire monitor (`wisp-pulseloopback`) |
| Microphone capture | ✅ | ✅ | ✅ cpal (`wisp-audio`, feature `mic`) |
| Signed release artifact | ✅ Developer ID + notarize | ✅ Authenticode (`scripts/sign-windows.ps1`, CI-gated) | ✅ GPG/debsigs (`scripts/sign-linux.sh`, CI-gated) |
| Bundle targets | `app`, `dmg` | `msi`, `nsis` | `deb`, `appimage` |

## What was made OS-neutral

- `desktop/src/platform/os.ts` — capability table (no `isMac()` sprinkled in views).
- `desktop/src/platform/bridgeBinary.ts` — pure binary path resolution, unit-tested for all OSes.
- `desktop/src-tauri/tauri.{macos,windows,linux}.conf.json` — per-OS bundle config merged by Tauri.
- `bridge/src/platform.rs` — `/health` now reports `platform`, `arch`, `capture_backend`,
  `system_audio_supported`; old clients parse missing fields with safe defaults.
- `bridge/crates/wisp-pulseloopback/` — Linux monitor-source `AudioSource` impl (cpal), selected
  by device-name matching and wired into `bridge/src/session.rs::open_system_source()`.
- CI release matrix builds and **signs all three hosts**: Developer ID + notarize on macOS,
  Authenticode on Windows, GPG/debsigs on Linux. Each lane fails loudly when its secret is missing.
- UI copy + install hints switch per host: no `curl | bash` shown to Windows/Linux users.
- Default ASR family: `apple-speech` on macOS, `whisper-medium` everywhere else.

## Remaining optional work

1. **Cross-compile verification from macOS.** The Linux capture crate is cfg-gated correctly but
   `cargo check --target x86_64-unknown-linux-gnu` needs an ALSA/PulseAudio sysroot; the Ubuntu
   CI lane installs `libasound2-dev`/`libpulse-dev` and builds natively instead.
2. **Local translation option.** NLLB/CTranslate2 would let all three hosts translate fully offline.
3. **Distribution polish.** Flatpak manifest and dh_hygiene/Reproducible builds for Linux,
   App Store / MS Store submission pipelines for the GUI shell.

## Verification commands

```bash
npm test                       # includes platform + binary-resolution tests
npm run typecheck
(cd desktop/src-tauri && cargo check)   # native host
(cd bridge && cargo test)              # capability report + lease tests
```
