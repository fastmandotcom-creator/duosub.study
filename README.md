# DuoSub Bridge

**Live captions from your own machine.** The bridge captures system audio (and your microphone),
runs on-device speech recognition, and streams the transcript to the LiveCode browser extension on
`http://127.0.0.1:4499`.

No account. No cloud. No token. No API key. Audio never leaves your computer.

## Install

**macOS — one command:**

```bash
curl -fsSL https://github.com/fastmandotcom-creator/duosub.study/releases/latest/download/install.sh | bash
```

That single command downloads the prebuilt bridge, registers a LaunchAgent so it starts with your
computer (and restarts if it stops), starts it now, and waits until it reports healthy. The first
run downloads the speech model (~250 MB) once.

> Platform support: **macOS today** — system-audio capture goes through ScreenCaptureKit. Windows
> and Linux are on the roadmap (the engine needs a WASAPI / PulseAudio capture backend).

Prefer a download? Grab the latest build from
[Releases](https://github.com/fastmandotcom-creator/duosub.study/releases) and run the binary
yourself — it works from anywhere.

## Then, in the extension

1. Open LiveCode → **Settings → Live Caption (ASR)**
2. **Caption source** → *Wisp ASR (on-device)*
3. Join a meeting (Meet / Teams / Zoom) and talk — captions appear in the **Live Caption** tab.

Pick *Web CC* instead if you prefer the meeting's own captions. The extension never switches
sources on its own.

## Useful commands

```bash
bash <(curl -fsSL https://github.com/fastmandotcom-creator/duosub.study/releases/latest/download/install.sh) --status      # is it running?
bash <(curl -fsSL https://github.com/fastmandotcom-creator/duosub.study/releases/latest/download/install.sh) --uninstall  # remove + auto-start entry
```

| Where | What |
| --- | --- |
| `http://127.0.0.1:4499/health` | liveness + model status |
| log | `~/Library/Logs/duosub-bridge.log` |

## Configuration (all optional)

| Env var | Default | Meaning |
| --- | --- | --- |
| `DUOSUB_PORT` | `4499` | loopback port |
| `DUOSUB_HOST` | `127.0.0.1` | bind address (loopback only — keep it that way) |
| `DUOSUB_LANGUAGE` | `auto` | `auto` or a language code (`en`, `vi`, `ja`, …) |
| `DUOSUB_TOKEN` | *unset* | set it to require `Authorization: Bearer <token>` on every route |
| `DUOSUB_MODELS_DIR` | `~/.duosub/models` | speech model cache |
| `DUOSUB_AUTODOWNLOAD` | `1` | `0` = fail instead of downloading a missing model |

The HTTP contract (health, session start/stop, SSE transcript stream) is documented in the
extension repo: `docs/live-caption-wisp/BRIDGE-API.md`.

## Build from source

```bash
git clone --recurse-submodules https://github.com/fastmandotcom-creator/duosub.study
cd duosub.study/bridge
cargo build --release
```

`vendor/wisp` is a git submodule (pinned to an upstream Wisp commit) — it provides the audio
capture, VAD and on-device speech recognition engine. Only this repository's code is maintained
here.

## License

MIT. The engine in `vendor/wisp` is licensed by its upstream project.
