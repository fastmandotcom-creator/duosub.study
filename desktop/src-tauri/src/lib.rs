mod bridge;
mod commands;
mod hotkeys;
mod platform;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::ShortcutState;

pub fn run() {
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, pressed, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            for (shortcut, name) in hotkeys::shortcuts() {
                if *pressed == shortcut {
                    let _ = app.emit(name, ());
                    return;
                }
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(shortcut_plugin)
        .setup(|app| {
            let handle = app.handle().clone();

            let show_item = MenuItem::with_id(app, "show", "Mở DuoSub", true, None::<&str>)?;
            let start_item = MenuItem::with_id(app, "start_stop", "Bật / tắt phụ đề", true, None::<&str>)?;
            let overlay_item = MenuItem::with_id(app, "overlay", "Bật / tắt overlay", true, None::<&str>)?;
            let copy_item = MenuItem::with_id(app, "copy", "Copy transcript", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &start_item, &overlay_item, &copy_item, &separator, &quit_item],
            )?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "start_stop" => {
                        let _ = app.emit("duosub:start-stop", ());
                    }
                    "overlay" => {
                        let _ = app.emit("duosub:toggle-overlay", ());
                    }
                    "copy" => {
                        let _ = app.emit("duosub:copy-transcript", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            let _tray = tray.build(app)?;

            hotkeys::register_all(&handle)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_frontmost_app,
            commands::host_info,
            commands::show_overlay,
            commands::set_autostart,
            commands::set_hotkeys,
            commands::check_updates,
            bridge::start_bridge,
            commands::app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DuoSub Desktop");
}
