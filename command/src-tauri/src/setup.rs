//! Tauri setup — config bootstrap, boot webview, AppState wiring, MCP spawn.

use std::sync::Arc;

use vale_command::state::AppState;
use vale_command::tools::browser::BrowserManager;
use tauri::Manager; // App::get_window
use tokio_util::sync::CancellationToken;

pub(crate) fn run(app: &mut tauri::App, ct: &CancellationToken) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    // Config + auth token (shared bootstrap with the headless binary)
    let config_path = std::path::Path::new("config.yaml");
    let (config, token) = vale_command::bootstrap::load_or_create(
        config_path,
        Some(std::path::Path::new("../config.yaml")),
    )
    .map_err(|e| format!("Failed to load config.yaml: {e}"))?;
    if let Some(token) = token {
        let yaml = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
        std::fs::write(config_path, &yaml).map_err(|e| e.to_string())?;
        println!("  Auth token: {token}  (saved to {config_path:?})");
    }

    // BrowserManager + child webview (first tab)
    let browser_mgr = BrowserManager::new(config.browser.page_load_timeout_secs);
    let main_window = app.get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    browser_mgr.set_main_window(main_window.clone());
    // Event bus slot — filled after AppState is created
    let event_bus_slot: Arc<std::sync::Mutex<Option<Arc<dyn vale_command::EventBus>>>> =
        Arc::new(std::sync::Mutex::new(None));
    let event_bus_for_nav = event_bus_slot.clone();
    let blank_url: url::Url = "about:blank".parse().map_err(|e: url::ParseError| e.to_string())?;
    let wv_builder = vale_command::tools::browser::new_child_webview(
        "browser",
        tauri::WebviewUrl::External(blank_url),
        move |url| {
            let url_str = url.to_string();
            if url_str == "about:blank" { return true; }
            // Emit navigation event via EventBus
            if let Ok(guard) = event_bus_for_nav.lock() {
                if let Some(ref bus) = *guard {
                    bus.emit(&vale_command::AgentEvent::BrowserNavigate {
                        url: url_str,
                        title: String::new(),
                    });
                }
            }
            true
        },
        {
            let slot2 = browser_mgr.child_webview_slot();
            move |url, _features| {
                if let Ok(slot) = slot2.lock() {
                    if let Some(wv) = slot.clone() {
                        let _ = wv.navigate(url);
                    }
                }
                tauri::webview::NewWindowResponse::Deny
            }
        },
    );

    let child = main_window.add_child(
        wv_builder,
        tauri::LogicalPosition::new(0.0, 0.0),
        tauri::LogicalSize::new(800.0, 600.0),
    )?;
    child.hide().ok();
    browser_mgr.set_child_webview_slot(child);

    // State
    let mcp_host = config.server.host.clone();
    let mcp_port = config.server.port;
    let server_config = config.clone();
    let app_state = Arc::new(AppState::new(config, Some(browser_mgr)));
    // Fill event bus slot so on_navigation can emit events
    if let Ok(mut slot) = event_bus_slot.lock() {
        *slot = Some(app_state.event_bus.clone() as Arc<dyn vale_command::EventBus>);
    }
    // Set event bus on BrowserManager for tab_new's on_navigation
    app_state.browser_mgr.set_event_bus(app_state.event_bus.clone() as Arc<dyn vale_command::EventBus>);
    // Set up Tauri event forwarding via EventBus hook
    {
        use tauri::Emitter;
        let tauri_handle = handle.clone();
        app_state.event_bus.set_hook(move |seq, event| {
            let _ = tauri_handle.emit("agent-event", serde_json::json!({"seq": seq, "event": event}));
        });
        // Forward terminal output to desktop UI
        let term_handle = handle.clone();
        app_state.event_bus.set_term_hook(move |output| {
            let _ = term_handle.emit("term-output", &output);
        });
    }
    super::GLOBAL_STATE.set(app_state.clone()).ok();

    // MCP server (external clients only) — runs on Tauri's async
    // runtime instead of a second tokio::Runtime of its own, so the
    // app keeps one thread pool and one shutdown path (CancellationToken).
    let child_ct = ct.child_token();
    let mcp_state = app_state.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = vale_command::mcp::serve_with_token(
            server_config, mcp_state, child_ct,
        ).await {
            eprintln!("MCP server error: {e}");
        }
    });

    println!("Vale Command ready — MCP on http://{mcp_host}:{mcp_port}/mcp");
    Ok(())
}
