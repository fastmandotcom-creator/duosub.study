use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::{hotkeys, platform};

/// Frontmost app name, used by the "profile follows the active app" feature. The OS-specific
/// implementation lives in `platform/`; unsupported hosts return an empty string (manual profiles).
#[tauri::command]
pub fn get_frontmost_app() -> String {
    platform::frontmost_app()
}

/// Snapshot of macOS Live Captions text. Polled from the frontend in system-live mode.
#[tauri::command]
pub fn read_system_captions() -> Vec<String> {
    platform::read_system_captions()
}

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

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
