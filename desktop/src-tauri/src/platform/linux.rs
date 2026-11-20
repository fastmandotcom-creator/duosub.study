//! Frontmost application on Linux.
//!
//! X11 (and XWayland under GNOME): `xdotool`, then `wmctrl`.
//! Native Wayland compositors expose no portable API, so we try the CLI bridges offered by the
//! common ones (Hyprland, Niri, Sway). When none is available the app falls back to manual profiles
//! instead of guessing — `frontmost_app()` returning "" is a supported state.

use super::{focused_name_from_tree, parse_json_string_field};

fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_owned())
    }
}

/// Wayland compositor-specific providers, in preference order.
pub fn wayland_frontmost() -> Option<String> {
    // Hyprland: `hyprctl activewindow -j` → {"title":"Zoom — Weekly", ...}
    let hyprland = run("hyprctl", &["activewindow", "-j"])
        .and_then(|json| parse_json_string_field(&json, "title"));
    if hyprland.is_some() {
        return hyprland;
    }

    // Niri: `niri msg --json focused-window` → {"title":"...", ...}
    let niri = run("niri", &["msg", "--json", "focused-window"])
        .and_then(|json| parse_json_string_field(&json, "title"));
    if niri.is_some() {
        return niri;
    }

    // Sway / i3: a tree with `"focused":true` on the active container.
    run("swaymsg", &["-t", "get_tree"]).and_then(|tree| focused_name_from_tree(&tree))
}

/// Name of the frontmost application, used by per-app profiles. Empty = unavailable.
pub fn frontmost_app() -> String {
    if let Some(name) = wayland_frontmost() {
        return name;
    }

    if let Some(name) = run("xdotool", &["getactivewindow", "getwindowname"]) {
        return name;
    }

    if let Some(raw) = run("wmctrl", &["-l", "-p"]) {
        // Format: "<id> <desktop> <host> <title>". The title is the tail.
        if let Some(title) = raw.splitn(4, ' ').nth(3) {
            let title = title.trim();
            if !title.is_empty() {
                return title.to_owned();
            }
        }
    }

    String::new()
}
