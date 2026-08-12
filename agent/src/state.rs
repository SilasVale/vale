use std::fmt;
use std::sync::Arc;

use vale_agent_core::events::{AppEventBus, EventBus};
use vale_agent_core::Config;
use crate::plugins::PluginRegistry;
use crate::plugins::design::DesignPlugin;
use crate::plugins::terminal::TerminalPlugin;
use crate::plugins::update::UpdatePlugin;
use crate::tools::serial::SerialPool;
use crate::tools::terminal::TerminalManager;

pub struct AppState {
    pub serial_pool: Arc<SerialPool>,
    pub terminal_mgr: Arc<TerminalManager>,
    /// Unified event bus.
    pub event_bus: Arc<AppEventBus>,
    pub plugin_registry: PluginRegistry,
    pub config: Config,
}

fn build_registry(
    terminal_mgr: &Arc<TerminalManager>,
    serial_pool: &Arc<SerialPool>,
    event_bus: &Arc<AppEventBus>,
) -> PluginRegistry {
    let mut registry = PluginRegistry::new();
    registry.register(Box::new(TerminalPlugin::new(
        terminal_mgr.clone(),
        serial_pool.clone(),
        event_bus.clone() as Arc<dyn EventBus>,
    )));
    registry.register(Box::new(UpdatePlugin::new()));
    registry.register(Box::new(DesignPlugin::new()));
    registry
}

impl AppState {
    /// Create app state with the terminal plugin (PTY/SSH/serial).
    pub fn new(config: Config) -> Self {
        let event_bus = Arc::new(AppEventBus::new());
        let serial_pool = Arc::new(SerialPool::new(
            config.serial.default_baud_rate,
            config.serial.default_timeout_ms,
        ));
        let terminal_mgr = Arc::new(TerminalManager::new(serial_pool.clone()));
        let plugin_registry = build_registry(&terminal_mgr, &serial_pool, &event_bus);

        Self { serial_pool, terminal_mgr, event_bus, plugin_registry, config }
    }
}

impl fmt::Debug for AppState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AppState")
            .field("serial_pool", &"<SerialPool>")
            .field("event_bus", &"<AppEventBus>")
            .finish()
    }
}
