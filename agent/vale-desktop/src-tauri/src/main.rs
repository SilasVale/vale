//! Vale Desktop — Tauri 2 shell over the local vale-agent web UI.
//!
//! The agent runs as a SYSTEM scheduled task (session 0) serving
//! http://127.0.0.1:18080/ — MCP at /mcp, tools at /api/tools/*, the
//! terminal/desktop UI at /desktop/ (React + xterm multi-tab page). This
//! shell runs in the LOGGED-ON USER session and is a pure UI client: all
//! sessions/PTYs/memory live in the agent service, so closing the window
//! never kills a session.
//!
//! Window content = the agent's /desktop/ page (single instance window;
//! re-open focuses instead of duplicating). Tray offers open/hide/quit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

/// The desktop page URL (exposed to the frontend via Tauri).
#[tauri::command]
fn desktop_url() -> String {
    format!("{AGENT_BASE}{DESKTOP_PATH}")
}

/// The agent's local web root (loopback bind from config.yaml).
const AGENT_BASE: &str = "http://127.0.0.1:18080";
/// The desktop UI route served by the agent (panel-react build).
const DESKTOP_PATH: &str = "/desktop/";

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![desktop_url])
        .on_window_event(|window, event| {
            // Hide instead of quit when the user closes the window — the
            // agent UI stays resident in the tray (sessions live in the
            // agent service, so nothing is lost).
            if let WindowEvent::CloseRequested { .. } = event {
                let _ = window.hide();
            }
        })
        .setup(|app| {

            // Tray: open / quit.
            let open = MenuItem::with_id(app, "open", "Open Vale Desktop", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vale Desktop");
}

