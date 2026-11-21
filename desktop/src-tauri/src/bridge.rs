use std::process::{Command, Stdio};

use tauri::AppHandle;

use crate::platform;

/// Stop the live bridge session synchronously before the app exits. Without this the bridge keeps
/// capturing microphone + system audio after the app is gone, until its 3-minute orphan reaper.
pub fn stop_session_before_exit() {
    let base = std::env::var("DUOSUB_BRIDGE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:4499".to_owned());
    let url = format!("{}/sessions/stop", base.trim_end_matches('/'));
    // A tiny reqwest client keeps this call independent of the webview (which may already be
    // tearing down). Cap it at 3s so quitting never feels hung.
    if let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        if let Ok(response) = client.post(&url).send() {
            let status = response.status();
            eprintln!("duosub-desktop: stop session on exit → HTTP {status}");
        }
    }
}

#[tauri::command]
pub fn start_bridge(app: AppHandle) -> Result<String, String> {
    for path in platform::bridge_candidates(&app) {
        if !path.is_file() {
            continue;
        }
        let _child = Command::new(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("cannot start {}: {error}", path.display()))?;
        return Ok(format!("started bridge at {}", path.display()));
    }
    Err("Không tìm thấy file thực thi bridge. Cài bằng install.sh hoặc đặt DUOSUB_BRIDGE_BINARY.".into())
}
