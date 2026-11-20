# Cross-platform status

Generated from the code in this repository, not from a roadmap slide.

| Capability | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Desktop shell (Tauri + React) | ✅ | ✅ config + native platform module | ✅ config + native platform module |
| Tray / global hotkeys | ✅ | ✅ Tauri plugins | ✅ Tauri plugins |
| Overlay window | ✅ | ✅ | ✅ (Wayland compositor permitting) |
| Autostart | ✅ LaunchAgent | ✅ Registry task (plugin) | ✅ XDG autostart (plugin) |
| Per-app profiles | ✅ osascript | ✅ PowerShell | ✅ xdotool/wmctrl (X11); Wayland = manual |
| On-device ASR | ✅ Apple Speech + SenseVoice + Whisper | ✅ Whisper engine | ✅ Whisper engine |
| System/meeting audio capture | ✅ ScreenCaptureKit | ✅ WASAPI loopback (`wisp-loopback`) | ❌ backend not ported |
| Microphone capture | ✅ | ✅ | ✅ cpal (`wisp-audio`, feature `mic`) |
| Signed release artifact | ✅ Developer ID + notarize | ⚠️ unsigned until a cert is configured | ⚠️ unsigned until signing is configured |
| Bundle targets | `app`, `dmg` | `msi`, `nsis` | `deb`, `appimage` |

## What was made OS-neutral

- `desktop/src/platform/os.ts` — capability table (no `isMac()` sprinkled in views).
- `desktop/src/platform/bridgeBinary.ts` — pure binary path resolution, unit-tested for all OSes.
- `desktop/src-tauri/src/platform/{macos,windows,linux}.rs` — native frontmost-app + bridge paths.
- `desktop/src-tauri/tauri.{macos,windows,linux}.conf.json` — per-OS bundle config merged by Tauri.
- `bridge/src/platform.rs` — `/health` now reports `platform`, `arch`, `capture_backend`,
  `system_audio_supported`; old clients parse missing fields with safe defaults.
- UI copy + install hints switch per host: no `curl | bash` shown to Windows/Linux users.
- Default ASR family: `apple-speech` on macOS, `whisper-medium` everywhere else.
- CI release matrix builds all three hosts; macOS remains the only signed/notarized lane.

## Remaining work for a complete Linux port

1. **System-audio backend.** Add a `wisp-pulseloopback` crate implementing the same `AudioSource`
   shape as `wisp-screencapture` / `wisp-loopback`, then add one arm to
   `bridge/src/session.rs::open_system_source()` and flip `system_audio_supported` in
   `bridge/src/platform.rs`. PipeWire can be reached through its PulseAudio compatibility server.
2. **Wayland frontmost app.** Replace `xdotool` with an XDG Desktop Portal / GNOME Shell extension
   path; the app already degrades to manual profiles when `frontmost_app()` returns empty.
3. **Signed Windows/Linux artifacts.** Add EV/OV cert secrets and Authenticode signing for MSI/NSIS;
   consider Flatpak + dh_hygiene for Linux distribution.
4. **Cross-compile CI verification.** `cargo check --target x86_64-pc-windows-msvc` and
   `cargo check --target x86_64-unknown-linux-gnu` for `bridge/` once the Linux capture crate exists
   (vendor Wisp's macOS crates are already cfg-gated in `bridge/Cargo.toml`).
5. **Local translation option.** NLLB/CTranslate2 would let all three hosts translate fully offline.

## Verification commands

```bash
npm test                       # includes platform + binary-resolution tests
npm run typecheck
(cd desktop/src-tauri && cargo check)   # native host
(cd bridge && cargo test)              # capability report + lease tests
```
