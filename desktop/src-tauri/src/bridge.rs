use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::{AppHandle, Manager};

/// Where a locally built bridge binary may live. The install.sh product installs the signed
/// `DuoSub Bridge.app` + LaunchAgent; these candidates are the "spawn it for me" convenience.
fn candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(raw) = std::env::var("DUOSUB_BRIDGE_BINARY") {
        if !raw.trim().is_empty() {
            paths.push(PathBuf::from(raw));
        }
    }
    if let Ok(dir) = app.path().app_local_data_dir() {
        paths.push(dir.join("duosub-bridge"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/duosub-bridge"));
    paths.push(PathBuf::from("/usr/local/bin/duosub-bridge"));
    paths
}

#[tauri::command]
pub fn start_bridge(app: AppHandle) -> Result<String, String> {
    for path in candidates(&app) {
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
