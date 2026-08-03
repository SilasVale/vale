//! Browser Plugin — web automation via CDP + Tauri WebView.
//!
//! Tools: browser_navigate, browser_snapshot, browser_click, browser_type,
//!        browser_press_key, browser_screenshot, browser_evaluate,
//!        browser_wait_for, browser_scroll, browser_back, browser_forward,
//!        browser_reload, browser_tab_new, browser_tab_list, browser_tab_select,
//!        browser_tab_close, browser_screenshot_ui, browser_evaluate_ui
//!
//! Tool definitions live in `tools.rs` (one builder fn per tool); this module
//! holds the plugin struct and the NavItem.

mod tools;

use std::sync::Arc;

use vale_command_core::{EventBus, NavItem, Plugin, ToolDef};
use crate::tools::browser::BrowserManager;

pub struct BrowserPlugin {
    browser_mgr: Arc<BrowserManager>,
    bus: Arc<dyn EventBus>,
}

impl BrowserPlugin {
    pub fn new(browser_mgr: Arc<BrowserManager>, bus: Arc<dyn EventBus>) -> Self {
        Self { browser_mgr, bus }
    }
}

impl Plugin for BrowserPlugin {
    fn name(&self) -> &'static str { "browser" }
    fn display_name(&self) -> &'static str { "Browser" }
    fn description(&self) -> &'static str {
        "Web automation — navigate, click, type, snapshot, evaluate JavaScript"
    }

    fn tools(&self) -> Vec<ToolDef> {
        tools::build(&self.browser_mgr, &self.bus)
    }

    fn nav_item(&self) -> Option<NavItem> {
        Some(NavItem {
            id: "browser",

            icon: "🌐",
            label: "Browser",
            html_snippet: r##"
<div class="browser-page">
  <div class="topbar">
    <h1>Browser</h1>
    <div style="display:flex;align-items:center;gap:8px;flex:1;margin-left:16px">
      <input id="browser-url" placeholder="https://example.com"
        style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-family:var(--mono);font-size:12px;outline:none"
        onkeydown="if(event.key==='Enter')valeCommand.browserNavigate()">
      <button onclick="valeCommand.browserNavigate()" style="padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">Navigate</button>
      <button onclick="valeCommand.browserSnapshot()" style="padding:8px 16px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer">Snapshot</button>
      <button onclick="valeCommand.toggleBrowser()" id="btn-toggle-browser" style="padding:8px 16px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer">Show Browser</button>
    </div>
  </div>
  <div id="browser-snapshot" style="flex:1;overflow-y:auto;padding:16px;font-family:var(--mono);font-size:12px;white-space:pre-wrap;background:var(--card)"></div>
</div>
"##,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vale_command_core::{AppEventBus, Plugin};
    use serde_json::json;

    fn plugin() -> BrowserPlugin {
        let bus: Arc<dyn EventBus> = Arc::new(AppEventBus::new());
        BrowserPlugin::new(Arc::new(BrowserManager::new(30)), bus)
    }

    #[test]
    fn tool_count_and_names() {
        let tools = plugin().tools();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(tools.len(), 18);
        for expected in [
            "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
            "browser_screenshot", "browser_screenshot_ui", "browser_evaluate_ui",
            "browser_evaluate", "browser_wait_for", "browser_scroll", "browser_press_key",
            "browser_back", "browser_forward", "browser_reload", "browser_tab_new",
            "browser_tab_list", "browser_tab_select", "browser_tab_close",
        ] {
            assert!(names.contains(&expected), "missing tool: {expected}");
        }
    }

    #[cfg(not(feature = "browser"))]
    #[tokio::test]
    async fn browser_navigate_headless_errors_propagate() {
        // The stub manager's "backend not enabled" error must reach the caller
        // through the full tool-handler path. Skipped when the real browser
        // backend is compiled.
        let tools = plugin().tools();
        let t = tools.iter().find(|t| t.name == "browser_navigate").unwrap();
        let err = t.handler.call(json!({"url": "https://example.com"})).await.unwrap_err();
        assert!(err.to_string().contains("backend not enabled"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn browser_navigate_missing_params() {
        let tools = plugin().tools();
        let t = tools.iter().find(|t| t.name == "browser_navigate").unwrap();
        let err = t.handler.call(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("missing required field"), "unexpected error: {err}");
    }
}
