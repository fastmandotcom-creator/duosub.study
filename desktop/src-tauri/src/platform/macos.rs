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
