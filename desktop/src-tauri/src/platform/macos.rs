//! macOS-specific platform helpers: reading the system Live Captions transcript via the
//! Accessibility API, and prompting for the grant when it is missing.

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::CFString;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
}

/// Ask macOS to grant Accessibility to this app. Shows the system dialog once; the user only has
/// to click OK. Returns false when the grant is still pending.
pub fn ensure_accessibility_permission(prompt: bool) -> bool {
    let key = CFString::new("AXTrustedCheckOptionPrompt");
    let value = if prompt {
        CFBoolean::true_value()
    } else {
        CFBoolean::false_value()
    };
    let options = CFDictionary::from_CFType_pairs(&[(
        key.as_CFType(),
        value.as_CFType(),
    )]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
}

/// Reads every caption line from the Live Captions accessibility tree. The window keeps a rolling
/// transcript, so the caller diffs the list and only appends new lines.
pub fn read_system_captions() -> Vec<String> {
    if !ensure_accessibility_permission(false) {
        return Vec::new();
    }
    const SCRIPT: &[&str] = &[
        "tell application \"System Events\" to tell process \"Live Captions\"",
        "if (count of windows) = 0 then return \"\"",
        "set xs to entire contents of window 1",
        "set out to \"\"",
        "repeat with e in xs",
        "try",
        "if (class of e) is static text then set out to out & (value of e) & linefeed",
        "end try",
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
    match std::process::Command::new("osascript").args(["-e", SCRIPT]).output() {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout).trim().to_string(),
        _ => String::new(),
    }
}
