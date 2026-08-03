use std::fmt;
use std::sync::Arc;

use vale_command_core::events::{AppEventBus, EventBus};
use vale_command_core::Config;
use crate::plugins::PluginRegistry;
use crate::plugins::browser::BrowserPlugin;
use crate::plugins::terminal::TerminalPlugin;
use crate::tools::browser::BrowserManager;
use crate::tools::serial::SerialPool;
use crate::tools::terminal::TerminalManager;

pub struct AppState {
    pub serial_pool: Arc<SerialPool>,
    pub browser_mgr: Arc<BrowserManager>,
    pub terminal_mgr: Arc<TerminalManager>,
    /// Unified event bus.
    pub event_bus: Arc<AppEventBus>,
    pub plugin_registry: PluginRegistry,
    pub config: Config,
}

fn build_registry(
    browser_mgr: &Arc<BrowserManager>,
    terminal_mgr: &Arc<TerminalManager>,
    serial_pool: &Arc<SerialPool>,
    event_bus: &Arc<AppEventBus>,
) -> PluginRegistry {
    let mut registry = PluginRegistry::new();
    registry.register(Box::new(BrowserPlugin::new(
        browser_mgr.clone(),
        event_bus.clone() as Arc<dyn EventBus>,
    )));
    registry.register(Box::new(TerminalPlugin::new(
        terminal_mgr.clone(),
        serial_pool.clone(),
        event_bus.clone() as Arc<dyn EventBus>,
    )));
    registry
}

impl AppState {
    /// Create app state. Pass `Some(browser_mgr)` from the desktop binary to
    /// inject the BrowserManager that owns the real webviews; headless mode
    /// passes `None` and gets a stub manager.
    pub fn new(config: Config, browser_mgr: Option<BrowserManager>) -> Self {
        let event_bus = Arc::new(AppEventBus::new());
        let serial_pool = Arc::new(SerialPool::new(
            config.serial.default_baud_rate,
            config.serial.default_timeout_ms,
        ));
        let browser_mgr = Arc::new(
            browser_mgr.unwrap_or_else(|| BrowserManager::with_config(
                config.browser.page_load_timeout_secs,
                config.browser.headless_executable.clone(),
                config.browser.headless_cdp_port,
            )),
        );
        let terminal_mgr = Arc::new(TerminalManager::new(serial_pool.clone()));
        // Headless browser navigation should reach the event bus too. Desktop
        // setup.rs sets the same bus again — idempotent.
        browser_mgr.set_event_bus(event_bus.clone() as Arc<dyn EventBus>);
        let plugin_registry = build_registry(&browser_mgr, &terminal_mgr, &serial_pool, &event_bus);

        Self { serial_pool, browser_mgr, terminal_mgr, event_bus, plugin_registry, config }
    }
}

impl fmt::Debug for AppState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AppState")
            .field("serial_pool", &"<SerialPool>")
            .field("browser_mgr", &"<BrowserManager>")
            .field("event_bus", &"<AppEventBus>")
            .finish()
    }
}
