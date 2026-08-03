//! Tauri commands — thin wrappers over AppState/PluginRegistry.
//!
//! Plugin-defined tools (browser_*, terminal_*) are dispatched through the
//! generic `call_tool` command by the frontend (single dispatch via
//! PluginRegistry). Only window/webview-level commands with no plugin
//! equivalent live here.

use super::state;

/// Diagnostics from the frontend (printed to stderr).
#[tauri::command]
pub(crate) fn log_diag(msg: String) {
    eprintln!("[vale_command JS] {msg}");
}

/// Generic tool dispatch — routes through PluginRegistry.
#[tauri::command]
pub(crate) async fn call_tool(tool: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let s = state()?;
    let t = s.plugin_registry.find_tool(&tool)
        .ok_or_else(|| format!("unknown tool: {tool}"))?;
    match t.handler.call(params).await {
        Ok(result) => Ok(serde_json::json!({"ok": true, "result": result})),
        Err(e) => Ok(serde_json::json!({"ok": false, "error": e.to_string()})),
    }
}

#[tauri::command]
pub(crate) async fn get_status() -> Result<serde_json::Value, String> {
    let s = state()?;
    Ok(vale_command::desktop_api::status_payload(&s))
}

#[tauri::command]
pub(crate) async fn events_poll(after: u64) -> Result<serde_json::Value, String> {
    let s = state()?;
    Ok(vale_command::desktop_api::events_payload(&s, after))
}

/// Fire-and-forget history navigation for the desktop UI (back/forward/reload).
/// Unlike the MCP plugin tools, this does NOT wait for the load event — SPA
/// navigations would otherwise block the UI for seconds.
#[tauri::command]
pub(crate) async fn browser_nav_cmd(action: String) -> Result<serde_json::Value, String> {
    tracing::debug!("[vale_command] browser_nav_cmd: {action}");
    let s = state()?;
    match s.browser_mgr.active_wv().await {
        Ok(wv) => {
            let js = match action.as_str() {
                "back" => "window.history.back()",
                "forward" => "window.history.forward()",
                "reload" => "window.location.reload()",
                _ => return Ok(serde_json::json!({"ok": false, "error": "unknown action"})),
            };
            // Back/forward/reload — on_navigation allows all navigations now
            let _ = wv.eval(js);
            Ok(serde_json::json!({"ok": true}))
        }
        Err(e) => Ok(serde_json::json!({"ok": false, "error": e.to_string()})),
    }
}

#[tauri::command]
pub(crate) async fn browser_cmd_show() -> Result<serde_json::Value, String> {
    let s = state()?;
    tracing::debug!("[vale_command] browser_cmd_show: active_tab={:?}, tab_count={}",
        s.browser_mgr.active_tab_id().await, s.browser_mgr.tab_count().await);
    match s.browser_mgr.active_wv().await {
        Ok(wv) => {
            let _ = wv.show();
            // Do NOT set_focus() — stealing focus from the parent WebView2 causes
            // Windows to route mouse events to the child webview even outside its bounds,
            // making the topbar/toolbars unclickable.
            Ok(serde_json::json!({"ok": true}))
        }
        Err(e) => Ok(serde_json::json!({"ok": false, "error": e.to_string()})),
    }
}

#[tauri::command]
pub(crate) async fn browser_cmd_hide() -> Result<serde_json::Value, String> {
    let s = state()?;
    s.browser_mgr.hide_all().await;
    Ok(serde_json::json!({"ok": true}))
}

#[tauri::command]
pub(crate) async fn browser_cmd_set_rect(x: f64, y: f64, width: f64, height: f64) -> Result<serde_json::Value, String> {
    let s = state()?;
    match s.browser_mgr.active_wv().await {
        Ok(wv) => {
            let mut ok = true;
            if let Err(e) = wv.set_position(tauri::LogicalPosition::new(x, y)) {
                tracing::error!("[vale_command] set_position({x},{y}) error: {e}");
                ok = false;
            }
            if let Err(e) = wv.set_size(tauri::LogicalSize::new(width, height)) {
                tracing::error!("[vale_command] set_size({width},{height}) error: {e}");
                ok = false;
            }
            Ok(serde_json::json!({"ok": ok}))
        }
        Err(e) => Ok(serde_json::json!({"ok": false, "error": e.to_string()})),
    }
}
