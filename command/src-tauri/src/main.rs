mod commands;
mod setup;

use std::sync::Arc;

use vale_command::state::AppState;
use tokio_util::sync::CancellationToken;

// Global state reference (set once at startup, read by commands).
// OnceLock — commands only fire after setup completes, no busy-wait needed.
static GLOBAL_STATE: std::sync::OnceLock<Arc<AppState>> = std::sync::OnceLock::new();

pub(crate) fn state() -> Result<Arc<AppState>, String> {
    GLOBAL_STATE.get().cloned().ok_or_else(|| "state not initialized — command fired before setup".into())
}

fn main() {
    // Enable CDP via WebView2 remote debugging
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", vale_command::tools::browser::cdp_debug_args());

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let ct = CancellationToken::new();

    let ct_setup = ct.clone();
    let ct_window = ct.clone();

    if let Err(e) = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::log_diag,
            commands::call_tool,
            commands::get_status,
            commands::events_poll,
            commands::browser_nav_cmd,
            commands::browser_cmd_show,
            commands::browser_cmd_hide,
            commands::browser_cmd_set_rect,
        ])
        .setup(move |app| setup::run(app, &ct_setup))
        .on_window_event(move |window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    ct_window.cancel();
                }
            }
        })
        .run(tauri::generate_context!())
    {
        eprintln!("Vale Command error: {e}");
        std::process::exit(1);
    }
}
