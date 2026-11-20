/// Prefers xdotool (X11), falls back to wmctrl. Wayland needs a portal-based implementation; the
/// app degrades to manual profiles when this returns an empty string.
pub fn frontmost_app() -> String {
    for (program, args) in [
        ("xdotool", vec!["getactivewindow", "getwindowname"]),
        ("wmctrl", vec!["-l", "-p"]),
    ] {
        if let Ok(output) = std::process::Command::new(program).args(args).output() {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let name = if program == "wmctrl" {
                    // wmctrl prints "<id> <desktop> <host> <title>"; the title is the tail.
                    text.lines().next().and_then(|line| line.splitn(4, ' ').nth(3))
                } else {
                    text.lines().next()
                };
                if let Some(name) = name {
                    let name = name.trim();
                    if !name.is_empty() {
                        return name.to_string();
                    }
                }
            }
        }
    }
    String::new()
}
