//! `duosub-bridge` — the loopback HTTP bridge in front of Wisp's live transcription pipeline.
//!
//! The Live-Code extension's "Wisp ASR" mode talks to this server instead of scraping meeting CC
//! DOMs: it pings `GET /health`, starts a session, and subscribes to the SSE transcript stream on
//! `GET /events`. Everything else (audio capture, VAD, ASR, diarization) is Wisp's.

mod api;
mod bus;
mod config;
mod contract;
mod session;

use config::BridgeConfig;
use session::AsrModel;

/// Resolve the bridge's auth token. **Auth is OFF by default** — the bridge binds to loopback
/// (127.0.0.1), which is the real boundary for a personal on-device tool; forcing a token adds a
/// paste step for the end user with no security gain on loopback.
///
/// Opt-in, explicit-only (a stale token file must never re-enable auth behind the user's back):
/// 1. `DUOSUB_TOKEN` env var non-empty → auth ON, that is the token.
/// 2. `DUOSUB_TOKEN_FILE` env var explicitly set AND the file holds a non-empty token →
///    auth ON, that is the token.
/// 3. Otherwise → auth OFF (open on loopback).
fn resolve_token(cfg: &BridgeConfig) -> String {
    if let Ok(env_token) = std::env::var("DUOSUB_TOKEN") {
        if !env_token.trim().is_empty() {
            return env_token.trim().to_owned();
        }
    }
    if std::env::var_os(config::BRIDGE_TOKEN_FILE_ENV).is_some() {
        if let Ok(existing) = std::fs::read_to_string(&cfg.token_file) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    String::new()
}

/// CLI override for the listen port: `--port 4499` / `--port=4499` / `-p 4499`.
/// The installers pass this so a scheduled task / LaunchAgent can pin the port without env setup.
fn port_from_args(default: u16) -> u16 {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let value = if let Some(v) = arg.strip_prefix("--port=") {
            Some(v.to_owned())
        } else if arg == "--port" || arg == "-p" {
            args.next().map(|v| v.to_owned())
        } else {
            None
        };
        if let Some(v) = value {
            if let Ok(port) = v.trim().parse::<u16>() {
                return port;
            }
        }
    }
    default
}

async fn run() -> Result<(), String> {
    let mut cfg = BridgeConfig::from_env();
    cfg.port = port_from_args(cfg.port);
    let token = resolve_token(&cfg);
    if token.is_empty() {
        eprintln!("duosub-bridge: auth OFF (loopback-only) — set DUOSUB_TOKEN to require a token");
    } else {
        eprintln!("duosub-bridge: auth ON (DUOSUB_TOKEN) — every route requires it");
    }

    let bus = bus::EventBus::new();

    // Resolve the ASR model up front: the bridge is only useful once its engine can actually run.
    // A missing model with auto-download on is a one-time slow start; with it off we fail loud.
    let model = AsrModel::resolve(&cfg)
        .map_err(|e| format!("duosub-bridge: ASR model unavailable: {e:?}"))?;

    let state = api::AppState {
        cfg: BridgeConfig {
            token,
            ..cfg
        },
        bus,
        model: std::sync::Arc::new(std::sync::RwLock::new(model)),
    };

    api::serve(state)
        .await
        .map_err(|e| format!("duosub-bridge: serve failed: {e}"))?;
    Ok(())
}

fn main() {
    if let Err(e) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(run())
    {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
