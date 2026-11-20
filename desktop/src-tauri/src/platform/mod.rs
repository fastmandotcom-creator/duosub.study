//! OS-neutral host layer. Everything platform-specific in the desktop shell lives here so adding
//! Windows/Linux support never touches the store, the views, or the bridge HTTP client.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

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

/// Name of the frontmost application, used by per-app profiles. Empty = unavailable.
pub fn frontmost_app() -> String {
    #[cfg(target_os = "macos")]
    return macos::frontmost_app();
    #[cfg(target_os = "windows")]
    return windows::frontmost_app();
    #[cfg(target_os = "linux")]
    return linux::frontmost_app();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return String::new();
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

/// Extracts a JSON string field with a tiny scanner — enough for the CLI JSON emitted by Hyprland
/// and Niri without pulling a JSON crate into the native shell for one field.
/// Linux-only at runtime; kept here so its parser is testable on every host.
#[allow(dead_code)]
pub fn parse_json_string_field(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle)? + needle.len();
    let rest = &json[start..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut value = String::new();
    let mut segment_start = 1;
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            // Both '"' and '\\' are ASCII, so these byte offsets are always char boundaries.
            b'\\' if i + 1 < bytes.len() => {
                value.push_str(&rest[segment_start..i]);
                i += 1;
                match bytes[i] {
                    b'n' => value.push('\n'),
                    b't' => value.push('\t'),
                    b'r' => value.push('\r'),
                    other => value.push(other as char),
                }
                i += 1;
                segment_start = i;
            }
            b'"' => {
                value.push_str(&rest[segment_start..i]);
                return if value.is_empty() { None } else { Some(value) };
            }
            _ => i += 1,
        }
    }
    None
}

/// Best-effort Sway/i3 tree scan: the focused container's `name` is the nearest preceding one.
/// Wayland has no portable "frontmost app" API, so this is deliberately a fallback, not a promise.
#[allow(dead_code)]
pub fn focused_name_from_tree(json: &str) -> Option<String> {
    let focus = json.find("\"focused\":true")?;
    let prefix = &json[..focus];
    let key = "\"name\"";
    let start = prefix.rfind(key)? + key.len();
    let rest = &prefix[start..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let end = rest[1..].find('"')?;
    let name = &rest[1..1 + end];
    if name.is_empty() {
        None
    } else {
        Some(name.to_owned())
    }
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
    fn parses_cli_json_window_titles() {
        assert_eq!(
            parse_json_string_field(r#"{"title":"Zoom — Weekly","id":1}"#, "title").as_deref(),
            Some("Zoom — Weekly")
        );
        assert_eq!(
            parse_json_string_field(r#"{"title":"a\"b"}"#, "title").as_deref(),
            Some("a\"b")
        );
        assert_eq!(parse_json_string_field(r#"{"title":42}"#, "title"), None);
        assert_eq!(parse_json_string_field("{}", "title"), None);
    }

    #[test]
    fn extracts_the_focused_container_name_from_a_sway_tree() {
        let tree =
            r#"{"name":"Terminal","focused":false}, {"name":"Google Chrome","focused":true}"#;
        assert_eq!(
            focused_name_from_tree(tree).as_deref(),
            Some("Google Chrome")
        );
        assert_eq!(
            focused_name_from_tree(r#"{"name":"A","focused":false}"#),
            None
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
