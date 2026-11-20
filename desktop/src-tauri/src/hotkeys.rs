use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub static HOTKEYS_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn shortcuts() -> [(Shortcut, &'static str); 3] {
    [
        (
            Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyC),
            "duosub:start-stop",
        ),
        (
            Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyO),
            "duosub:toggle-overlay",
        ),
        (
            Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyX),
            "duosub:copy-transcript",
        ),
    ]
}

pub fn register_all(app: &AppHandle) -> Result<(), String> {
    for (shortcut, _) in shortcuts() {
        app.global_shortcut()
            .register(shortcut)
            .map_err(|error| format!("cannot register {shortcut}: {error}"))?;
    }
    HOTKEYS_ENABLED.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn unregister_all(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    HOTKEYS_ENABLED.store(false, Ordering::SeqCst);
}
