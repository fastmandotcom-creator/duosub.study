# Cross-platform status

Generated from the code in this repository, not from a roadmap slide.

| Capability | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Desktop shell (Tauri + React) | ✅ | ✅ config + native platform module | ✅ config + native platform module |
| Tray / global hotkeys | ✅ | ✅ Tauri plugins | ✅ Tauri plugins |
| Overlay window | ✅ | ✅ | ✅ (Wayland compositor permitting) |
| Autostart | ✅ LaunchAgent | ✅ Registry task (plugin) | ✅ XDG autostart (plugin) |
| Per-app profiles | ✅ osascript | ✅ PowerShell | ✅ Hyprland/Niri/Sway CLI + xdotool/wmctrl; other compositors = manual |
| On-device ASR | ✅ Apple Speech + SenseVoice + Whisper | ✅ Whisper engine | ✅ Whisper engine |
| System/meeting audio capture | ✅ ScreenCaptureKit | ✅ WASAPI loopback (`wisp-loopback`) | ✅ PulseAudio/PipeWire monitor (`wisp-pulseloopback`) |
| Microphone capture | ✅ | ✅ | ✅ cpal (`wisp-audio`, feature `mic`) |
| Signed release artifact | ✅ Developer ID + notarize | ✅ Authenticode (`scripts/sign-windows.ps1`, CI-gated) | ✅ GPG/debsigs (`scripts/sign-linux.sh`, CI-gated) |
| Bundle targets | `app`, `dmg` | `msi`, `nsis` | `deb`, `appimage` |

## What was made OS-neutral

- `desktop/src/platform/os.ts` — capability table (no `isMac()` sprinkled in views).
- `desktop/src/platform/bridgeBinary.ts` — pure binary path resolution, unit-tested for all OSes.
- `desktop/src-tauri/src/platform/{macos,windows,linux}.rs` — native frontmost-app + bridge paths.
- `desktop/src-tauri/tauri.{macos,windows,linux}.conf.json` — per-OS bundle config merged by Tauri.
- `bridge/src/platform.rs` — `/health` now reports `platform`, `arch`, `capture_backend`,
  `system_audio_supported`; old clients parse missing fields with safe defaults.
- `bridge/crates/wisp-pulseloopback/` — Linux monitor-source `AudioSource` impl (cpal), selected
  by device-name matching and wired into `bridge/src/session.rs::open_system_source()`.
- `desktop/src-tauri/src/platform/linux.rs` — Wayland providers (Hyprland `hyprctl`, Niri CLI,
  Sway tree) before the X11/xdotool fallbacks; pure JSON helpers are tested on macOS.
- CI release matrix builds and **signs all three hosts**: Developer ID + notarize on macOS,
  Authenticode on Windows, GPG/debsigs on Linux. Each lane fails loudly when its secret is missing.
- UI copy + install hints switch per host: no `curl | bash` shown to Windows/Linux users.
- Default ASR family: `apple-speech` on macOS, `whisper-medium` everywhere else.

## Remaining optional work

1. **GNOME frontmost app.** GNOME Shell has no stable third-party API for the active window; a
   small shell extension publishing the title over D-Bus would close this gap. Other compositors
   already work through their CLI bridges, and the app falls back to manual profiles.
2. **Cross-compile verification from macOS.** The Linux capture crate is cfg-gated correctly but
   `cargo check --target x86_64-unknown-linux-gnu` needs an ALSA/PulseAudio sysroot; the Ubuntu
   CI lane installs `libasound2-dev`/`libpulse-dev` and builds natively instead.
3. **Local translation option.** NLLB/CTranslate2 would let all three hosts translate fully offline.
4. **Distribution polish.** Flatpak manifest and dh_hygiene/Reproducible builds for Linux,
   App Store / MS Store submission pipelines for the GUI shell.

## Verification commands

```bash
npm test                       # includes platform + binary-resolution tests
npm run typecheck
(cd desktop/src-tauri && cargo check)   # native host
(cd bridge && cargo test)              # capability report + lease tests
```
