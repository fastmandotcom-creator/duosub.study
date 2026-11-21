//! OS-neutral host layer. Everything platform-specific in the desktop shell lives here so adding
//! Windows/Linux support never touches the store, the views, or the bridge HTTP client.

use std::path::PathBuf;

use tauri::Manager;

// Variants for other hosts are constructed when this module compiles on those targets.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Macos,
    Windows,
    Linux,
    Unknown,
}

impl Os {
    pub fn as_str(self) -> &'static str {
        match self {
            Os::Macos => "macos",
            Os::Windows => "windows",
            Os::Linux => "linux",
            Os::Unknown => "unknown",
        }
    }
}

pub fn host_os() -> Os {
    #[cfg(target_os = "macos")]
    return Os::Macos;
    #[cfg(target_os = "windows")]
    return Os::Windows;
    #[cfg(target_os = "linux")]
    return Os::Linux;
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return Os::Unknown;
}

/// Apple Speech is macOS-only; every other host starts on multilingual Whisper medium.
pub fn default_family() -> &'static str {
    if host_os() == Os::Macos {
        "apple-speech"
    } else {
        "whisper-medium"
    }
}

/// Candidate paths for a locally installed bridge binary. Pure so it is testable on any host.
pub fn bridge_candidates_for(
    env_binary: Option<String>,
    app_data_dir: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(raw) = env_binary {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            paths.push(PathBuf::from(trimmed));
        }
    }
    if let Some(dir) = app_data_dir {
        paths.push(match host_os() {
            Os::Windows => dir.join("duosub-bridge.exe"),
            _ => dir.join("duosub-bridge"),
        });
    }
    paths.extend(system_candidates());
    let mut seen = std::collections::HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    paths
}

pub fn bridge_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    bridge_candidates_for(
        std::env::var("DUOSUB_BRIDGE_BINARY").ok(),
        app.path().app_local_data_dir().ok(),
    )
}

#[cfg(target_os = "macos")]
fn system_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin/duosub-bridge"),
        PathBuf::from("/usr/local/bin/duosub-bridge"),
    ]
}

#[cfg(target_os = "windows")]
fn system_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        paths.push(
            PathBuf::from(local)
                .join("duosub")
                .join("duosub-bridge.exe"),
        );
    }
    paths.push(PathBuf::from("duosub-bridge.exe")); // resolve from PATH
    paths
}

#[cfg(target_os = "linux")]
fn system_candidates() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    vec![
        PathBuf::from(home).join(".local/bin/duosub-bridge"),
        PathBuf::from("/usr/local/bin/duosub-bridge"),
    ]
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn system_candidates() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_strings_are_stable_wire_values() {
        assert_eq!(Os::Macos.as_str(), "macos");
        assert_eq!(Os::Windows.as_str(), "windows");
        assert_eq!(Os::Linux.as_str(), "linux");
        assert_eq!(Os::Unknown.as_str(), "unknown");
    }

    #[test]
    fn override_is_always_first_and_paths_are_unique() {
        let paths = bridge_candidates_for(
            Some("  /custom/bridge  ".to_owned()),
            Some(PathBuf::from("/custom")),
        );
        assert_eq!(paths[0], PathBuf::from("/custom/bridge"));
        assert_eq!(
            paths.iter().collect::<std::collections::HashSet<_>>().len(),
            paths.len()
        );
    }





    #[test]
    fn app_data_binary_has_the_right_extension_for_the_host() {
        let paths = bridge_candidates_for(None, Some(PathBuf::from("/data")));
        assert!(paths.iter().any(|path| {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            name == if host_os() == Os::Windows {
                "duosub-bridge.exe"
            } else {
                "duosub-bridge"
            }
        }));
    }
}
