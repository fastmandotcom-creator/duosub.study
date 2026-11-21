/// Reads every caption line from the Live Captions accessibility tree. The window keeps a rolling
/// transcript, so the caller diffs the list and only appends new lines.
pub fn read_system_captions() -> Vec<String> {
    const SCRIPT: &[&str] = &[
        "tell application \"System Events\" to tell process \"Live Captions\"",
        "if (count of windows) = 0 then return \"\"",
        "set xs to entire contents of window 1",
        "set out to \"\"",
        "repeat with e in xs",
        "if (class of e) is static text then set out to out & (value of e) & linefeed",
        "end repeat",
        "return out",
        "end tell",
    ];
    match std::process::Command::new("osascript").args(SCRIPT).output() {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

pub fn frontmost_app() -> String {
    const SCRIPT: &str =
        "tell application \"System Events\" to get name of first application process whose frontmost is true";
    match std::process::Command::new("osascript")
        .args(["-e", SCRIPT])
        .output()
    {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}
