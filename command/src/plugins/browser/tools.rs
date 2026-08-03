//! Per-tool builders — one fn per MCP tool, built once at registration.

use std::sync::Arc;
use serde_json::{json, Value};

use vale_command_core::{AgentEvent, EventBus, ToolDef};
use crate::plugins::{require_str, to_value_or_empty};
use crate::tools::browser::BrowserManager;

pub(super) fn build(
    browser_mgr: &Arc<BrowserManager>,
    bus: &Arc<dyn EventBus>,
) -> Vec<ToolDef> {
    vec![
        tool_navigate(browser_mgr),
        tool_snapshot(browser_mgr),
        tool_click(browser_mgr, bus),
        tool_type(browser_mgr, bus),
        tool_screenshot(browser_mgr, bus),
        tool_screenshot_ui(browser_mgr),
        tool_evaluate_ui(browser_mgr),
        tool_evaluate(browser_mgr, bus),
        tool_wait_for(browser_mgr, bus),
        tool_scroll(browser_mgr, bus),
        tool_press_key(browser_mgr),
        tool_back(browser_mgr),
        tool_forward(browser_mgr),
        tool_reload(browser_mgr),
        tool_tab_new(browser_mgr, bus),
        tool_tab_list(browser_mgr),
        tool_tab_select(browser_mgr, bus),
        tool_tab_close(browser_mgr, bus),
    ]
}

fn tool_navigate(browser_mgr: &Arc<BrowserManager>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    ToolDef::new(
        "browser_navigate",
        "Navigate browser to URL. Returns page snapshot with clickable element refs.",
        json!({"type":"object","properties":{"url":{"type":"string","description":"URL to navigate to"}},"required":["url"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            async move {
                let url = require_str(&params, "url")?;
                let snapshot = browser_mgr.navigate(&url).await?;
                // Navigation event is emitted by on_navigation callback, not here
                Ok(json!(snapshot))
            }
        },
    )
}

fn tool_snapshot(browser_mgr: &Arc<BrowserManager>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    ToolDef::new(
        "browser_snapshot",
        "Get snapshot of current page showing clickable elements with ref numbers.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let browser_mgr = browser_mgr.clone();
            async move {
                let snapshot = browser_mgr.snapshot().await?;
                Ok(json!(snapshot))
            }
        },
    )
}

fn tool_click(browser_mgr: &Arc<BrowserManager>, bus: &Arc<dyn EventBus>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    let bus = bus.clone();
    ToolDef::new(
        "browser_click",
        "Click element by ref number (from snapshot) or CSS selector.",
        json!({"type":"object","properties":{"selector":{"type":"string","description":"Ref number or CSS selector"}},"required":["selector"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            let bus = bus.clone();
            async move {
                let selector = require_str(&params, "selector")?;
                let result = browser_mgr.click(&selector).await?;
                bus.emit(&AgentEvent::BrowserClick { selector: selector.clone() });
                Ok(json!(result))
            }
        },
    )
}

fn tool_type(browser_mgr: &Arc<BrowserManager>, bus: &Arc<dyn EventBus>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    let bus = bus.clone();
    ToolDef::new(
        "browser_type",
        "Type text into an input element.",
        json!({"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"}},"required":["selector","text"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            let bus = bus.clone();
            async move {
                let selector = require_str(&params, "selector")?;
                let text = require_str(&params, "text")?;
                browser_mgr.type_text(&selector, &text).await?;
                bus.emit(&AgentEvent::BrowserType { selector: selector.clone(), text: text.clone() });
                Ok(json!("OK"))
            }
        },
    )
}

fn tool_screenshot(browser_mgr: &Arc<BrowserManager>, bus: &Arc<dyn EventBus>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    let bus = bus.clone();
    ToolDef::new(
        "browser_screenshot",
        "Take screenshot of current page. Returns base64-encoded PNG.",
        json!({"type":"object","properties":{"full_page":{"type":"boolean","description":"Capture full page (default: false)"}}}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            let bus = bus.clone();
            async move {
                let full_page = params.get("full_page").and_then(|v| v.as_bool());
                let b64 = browser_mgr.screenshot(full_page).await?;
                bus.emit(&AgentEvent::BrowserScreenshot);
                Ok(json!(b64))
            }
        },
    )
}

fn tool_screenshot_ui(browser_mgr: &Arc<BrowserManager>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    ToolDef::new(
        "browser_screenshot_ui",
        "Take screenshot of the vale_command main UI window. Returns base64-encoded PNG.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let browser_mgr = browser_mgr.clone();
            async move {
                let b64 = browser_mgr.screenshot_ui().await?;
                Ok(json!(b64))
            }
        },
    )
}

fn tool_evaluate_ui(browser_mgr: &Arc<BrowserManager>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    ToolDef::new(
        "browser_evaluate_ui",
        "Execute JavaScript in the vale_command main UI window and return result as JSON. Useful for reading console output, DOM state, or error messages from the UI.",
        json!({"type":"object","properties":{"js":{"type":"string","description":"JavaScript code to execute"}},"required":["js"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            async move {
                let js = require_str(&params, "js")?;
                Ok(json!(browser_mgr.evaluate_ui(&js).await?))
            }
        },
    )
}

fn tool_evaluate(browser_mgr: &Arc<BrowserManager>, bus: &Arc<dyn EventBus>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    let bus = bus.clone();
    ToolDef::new(
        "browser_evaluate",
        "Execute JavaScript in browser and return result as JSON.",
        json!({"type":"object","properties":{"js":{"type":"string","description":"JavaScript code to execute"}},"required":["js"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            let bus = bus.clone();
            async move {
                let js = require_str(&params, "js")?;
                let result = browser_mgr.evaluate(&js).await?;
                bus.emit(&AgentEvent::BrowserEvaluate { js: js.clone() });
                Ok(json!(result))
            }
        },
    )
}

fn tool_wait_for(browser_mgr: &Arc<BrowserManager>, bus: &Arc<dyn EventBus>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    let bus = bus.clone();
    ToolDef::new(
        "browser_wait_for",
        "Wait for a CSS selector or text to appear on the page.",
        json!({"type":"object","properties":{"selector_or_text":{"type":"string"},"timeout_secs":{"type":"integer"}},"required":["selector_or_text"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            let bus = bus.clone();
            async move {
                let selector = require_str(&params, "selector_or_text")?;
                let timeout = params.get("timeout_secs").and_then(|v| v.as_u64());
                browser_mgr.wait_for(&selector, timeout).await?;
                bus.emit(&AgentEvent::BrowserWaitFor { selector: selector.clone() });
                Ok(json!("OK"))
            }
        },
    )
}

fn tool_scroll(browser_mgr: &Arc<BrowserManager>, bus: &Arc<dyn EventBus>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    let bus = bus.clone();
    ToolDef::new(
        "browser_scroll",
        "Scroll the page up or down.",
        json!({"type":"object","properties":{"direction":{"type":"string","enum":["up","down"],"description":"Scroll direction"},"amount":{"type":"integer","description":"Pixels to scroll (default: 300)"}},"required":["direction"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            let bus = bus.clone();
            async move {
                let direction = require_str(&params, "direction")?;
                let amount = params.get("amount").and_then(|v| v.as_u64()).map(|v| v as u32);
                browser_mgr.scroll(&direction, amount).await?;
                bus.emit(&AgentEvent::BrowserScroll {
                    direction: direction.clone(),
                    amount: amount.map(|a| a.to_string()).unwrap_or_else(|| "300".into()),
                });
                Ok(json!("OK"))
            }
        },
    )
}

fn tool_press_key(browser_mgr: &Arc<BrowserManager>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    ToolDef::new(
        "browser_press_key",
        "Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown). Sends real key events via CDP.",
        json!({"type":"object","properties":{"key":{"type":"string","description":"Key name, e.g. Enter, Tab, Escape, ArrowDown"}},"required":["key"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            async move {
                let key = require_str(&params, "key")?;
                browser_mgr.press_key(&key).await?;
                Ok(json!("OK"))
            }
        },
    )
}

fn tool_back(browser_mgr: &Arc<BrowserManager>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    ToolDef::new(
        "browser_back",
        "Navigate back in browser history. Returns page snapshot.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let browser_mgr = browser_mgr.clone();
            async move {
                let snapshot = browser_mgr.go_back().await?;
                Ok(json!(snapshot))
            }
        },
    )
}

fn tool_forward(browser_mgr: &Arc<BrowserManager>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    ToolDef::new(
        "browser_forward",
        "Navigate forward in browser history. Returns page snapshot.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let browser_mgr = browser_mgr.clone();
            async move {
                let snapshot = browser_mgr.go_forward().await?;
                Ok(json!(snapshot))
            }
        },
    )
}

fn tool_reload(browser_mgr: &Arc<BrowserManager>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    ToolDef::new(
        "browser_reload",
        "Reload the current page. Returns page snapshot.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let browser_mgr = browser_mgr.clone();
            async move {
                let snapshot = browser_mgr.reload().await?;
                Ok(json!(snapshot))
            }
        },
    )
}

fn tool_tab_new(browser_mgr: &Arc<BrowserManager>, bus: &Arc<dyn EventBus>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    let bus = bus.clone();
    ToolDef::new(
        "browser_tab_new",
        "Open a new browser tab. Returns tab ID.",
        json!({"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            let bus = bus.clone();
            async move {
                let url = require_str(&params, "url")?;
                let tab_id = browser_mgr.tab_new(&url).await?;
                bus.emit(&AgentEvent::BrowserTabNew { url: url.clone(), tab_id: tab_id.clone() });
                Ok(json!(tab_id))
            }
        },
    )
}

fn tool_tab_list(browser_mgr: &Arc<BrowserManager>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    ToolDef::new(
        "browser_tab_list",
        "List all open browser tabs.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            let browser_mgr = browser_mgr.clone();
            async move {
                let tabs = browser_mgr.tab_list().await?;
                Ok(to_value_or_empty(&tabs))
            }
        },
    )
}

fn tool_tab_select(browser_mgr: &Arc<BrowserManager>, bus: &Arc<dyn EventBus>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    let bus = bus.clone();
    ToolDef::new(
        "browser_tab_select",
        "Switch to a browser tab by ID.",
        json!({"type":"object","properties":{"tab_id":{"type":"string"}},"required":["tab_id"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            let bus = bus.clone();
            async move {
                let tab_id = require_str(&params, "tab_id")?;
                browser_mgr.tab_select(&tab_id).await?;
                bus.emit(&AgentEvent::BrowserTabSelect { tab_id: tab_id.clone() });
                Ok(json!(format!("Switched to {tab_id}")))
            }
        },
    )
}

fn tool_tab_close(browser_mgr: &Arc<BrowserManager>, bus: &Arc<dyn EventBus>) -> ToolDef {
    let browser_mgr = browser_mgr.clone();
    let bus = bus.clone();
    ToolDef::new(
        "browser_tab_close",
        "Close a browser tab by ID.",
        json!({"type":"object","properties":{"tab_id":{"type":"string"}},"required":["tab_id"]}),
        move |params: Value| {
            let browser_mgr = browser_mgr.clone();
            let bus = bus.clone();
            async move {
                let tab_id = require_str(&params, "tab_id")?;
                browser_mgr.tab_close(&tab_id).await?;
                bus.emit(&AgentEvent::BrowserTabClose { tab_id: tab_id.clone() });
                Ok(json!(format!("Closed {tab_id}")))
            }
        },
    )
}
