/// Uses only PowerShell (present on every supported Windows). Avoids adding a CLI dependency.
pub fn frontmost_app() -> String {
    const SCRIPT: &str =
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Form]::ActiveForm.Text";
    match std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .output()
    {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}
