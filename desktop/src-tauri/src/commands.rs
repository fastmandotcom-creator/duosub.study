use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::{hotkeys, platform};

#[tauri::command]
pub fn host_info() -> serde_json::Value {
    serde_json::json!({
        "os": platform::host_os().as_str(),
        "default_family": platform::default_family(),
    })
}

#[tauri::command]
pub fn show_overlay(app: AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "overlay window is not configured".to_string())?;
    if visible {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().ok();
    } else {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())
    } else {
        manager.disable().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn set_hotkeys(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        hotkeys::register_all(&app)
    } else {
        hotkeys::unregister_all(&app);
        Ok(())
    }
}

#[tauri::command]
pub async fn check_updates(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|error| error.to_string())?;
    match updater.check().await.map_err(|error| error.to_string())? {
        Some(update) => Ok(format!("Bản {} đã sẵn sàng.", update.version)),
        None => Ok("Bạn đang dùng bản mới nhất.".into()),
    }
}

/// Loopback HTTP request to the DuoSub bridge, performed in Rust.
///
/// WKWebView intermittently rejects `fetch` to http://127.0.0.1 with "TypeError: Load failed"
/// while EventSource on the same URL keeps streaming captions. Rust has no CSP/ATS restriction, so
/// all bridge control calls go through here; the webview keeps only the SSE connection.
#[tauri::command]
pub async fn bridge_request(
    method: String,
    path: String,
    body: Option<String>,
    token: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    let base = std::env::var("DUOSUB_BRIDGE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:4499".to_owned());
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.unwrap_or(4000)))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = match method.to_ascii_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => return Err(format!("unsupported bridge method: {other}")),
    };
    if let Some(token) = token.filter(|t| !t.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.header("content-type", "application/json").body(body);
    }
    let response = request.send().await.map_err(|e| format!("bridge request failed: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let value: serde_json::Value = if text.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::Value::String(text.clone()))
    };
    if !status.is_success() {
        let detail = value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or(&text)
            .to_owned();
        return Err(format!("HTTP {}: {}", status.as_u16(), detail));
    }
    Ok(value)
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
