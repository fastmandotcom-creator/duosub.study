use std::process::{Command, Stdio};

use tauri::AppHandle;

use crate::platform;

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
