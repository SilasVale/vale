use std::fmt;
use std::sync::Arc;

use vale_agent_core::events::{AppEventBus, EventBus};
use vale_agent_core::Config;
use crate::plugins::PluginRegistry;
use crate::plugins::design::DesignPlugin;
use crate::plugins::mcp_client::McpClientPlugin;
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
    /// The config file actually loaded (argv[1]) — PUT /api/settings must
    /// persist to THIS path, not a hardcoded exe_dir/config.yaml (round-101:
    /// a dev/custom invocation silently reverted buffer settings on restart).
    /// Arc<Mutex<>> so it can be set after construction (AppState isn't
    /// Clone, so Arc::make_mut is unavailable).
    pub config_path: std::sync::Arc<std::sync::Mutex<Option<std::path::PathBuf>>>,
    /// Per-session output buffer cap in BYTES (round-69): read at runtime by
    /// the terminal buffer logic, written by PUT /api/settings; seeded from
    /// config.terminal.buffer_mb so it survives restarts.
    pub terminal_buf_bytes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

fn build_registry(
    terminal_mgr: &Arc<TerminalManager>,
    serial_pool: &Arc<SerialPool>,
    event_bus: &Arc<AppEventBus>,
    buffer_limit: &Arc<std::sync::atomic::AtomicUsize>,
) -> PluginRegistry {
    let mut registry = PluginRegistry::new();
    registry.register(Box::new(TerminalPlugin::new(
        terminal_mgr.clone(),
        serial_pool.clone(),
        event_bus.clone() as Arc<dyn EventBus>,
        buffer_limit.clone(),
    )));
    registry.register(Box::new(UpdatePlugin::new()));
    registry.register(Box::new(McpClientPlugin::new()));
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
        let terminal_buf_bytes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(
            (config.terminal.buffer_mb.clamp(1, 64) as usize) * 1024 * 1024,
        ));
        let plugin_registry = build_registry(&terminal_mgr, &serial_pool, &event_bus, &terminal_buf_bytes);

        Self { serial_pool, terminal_mgr, event_bus, plugin_registry, config, config_path: std::sync::Arc::new(std::sync::Mutex::new(None)), terminal_buf_bytes }
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
