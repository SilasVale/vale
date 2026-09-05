use std::fmt;
use std::sync::Arc;

use vale_agent_core::events::{AppEventBus, EventBus};
use vale_agent_core::Config;
use crate::plugins::PluginRegistry;
use crate::plugins::design::DesignPlugin;
use crate::plugins::mcp_client::McpClientPlugin;
use crate::plugins::memory::MemoryPlugin;
use crate::plugins::memory::store::{MemoryLimits, MemoryStore};
use crate::plugins::playwright::manager::PlaywrightManager;
use crate::plugins::playwright::PlaywrightPlugin;
use crate::plugins::system::SystemPlugin;
use crate::plugins::terminal::TerminalPlugin;
use crate::plugins::update::UpdatePlugin;
use crate::tools::serial::SerialPool;
use crate::tools::terminal::TerminalManager;
use anyhow::Context;

pub struct AppState {
    // Lock posture: managers own their locks internally (callers hold
    // Arc<Manager>); AppState itself holds the config RwLock below + the
    // small config_path Mutex.
    pub serial_pool: Arc<SerialPool>,
    pub terminal_mgr: Arc<TerminalManager>,
    /// Unified event bus.
    pub event_bus: Arc<AppEventBus>,
    pub plugin_registry: PluginRegistry,
    /// Write-through config (architecture audit A4 — one source of truth):
    /// the in-process RwLock IS the live config; read via `config_snapshot`,
    /// mutated ONLY via `update_config` (which optionally persists to
    /// config_path). The old plain `Config` field was an immutable boot
    /// snapshot, so PUT /api/settings + gateway-connect mutations were
    /// invisible in-process until restart.
    pub config: std::sync::RwLock<Config>,
    /// Process start time — /api/status exposes uptime_secs for health
    /// diagnosis (a low uptime after an update/crash is a red flag; stage-n).
    pub started_at: std::time::Instant,
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
    /// playwright-mcp process manager (round-admin-ui): shared with
    /// PlaywrightPlugin so /api/plugins/* routes and the registry see one
    /// state machine.
    pub playwright: std::sync::Arc<PlaywrightManager>,
    /// Device-local memory store (shared across AI clients) — the MemoryPlugin
    /// and the /api/tools/memory_* dispatch share this Arc.
    pub memory: std::sync::Arc<MemoryStore>,
}

/// Registry construction dependencies — one context instead of an 8-arg
/// function (clippy too_many_arguments); keeps build_registry call sites
/// stable as plugins are added.
struct RegistryDeps {
    terminal_mgr: Arc<TerminalManager>,
    serial_pool: Arc<SerialPool>,
    event_bus: Arc<AppEventBus>,
    buffer_limit: Arc<std::sync::atomic::AtomicUsize>,
    playwright: Arc<PlaywrightManager>,
    download_url: Option<String>,
    console_url: Option<String>,
    memory: Arc<MemoryStore>,
}

fn build_registry(deps: &RegistryDeps) -> PluginRegistry {
    let mut registry = PluginRegistry::new();
    registry.register(Box::new(TerminalPlugin::new(
        deps.terminal_mgr.clone(),
        deps.serial_pool.clone(),
        deps.event_bus.clone() as Arc<dyn EventBus>,
        deps.buffer_limit.clone(),
    )));
    registry.register(Box::new(UpdatePlugin::new(deps.download_url.clone())));
    registry.register(Box::new(McpClientPlugin::new(deps.event_bus.clone() as Arc<dyn EventBus>)));
    registry.register(Box::new(DesignPlugin::new(deps.console_url.clone(), deps.download_url.clone())));
    registry.register(Box::new(PlaywrightPlugin::new(deps.playwright.clone())));
    registry.register(Box::new(MemoryPlugin::new(deps.memory.clone())));
    registry.register(Box::new(SystemPlugin));
    registry
}

impl AppState {
    /// Create app state with the terminal plugin (PTY/SSH/serial).
    pub fn new(config: Config) -> Self {
        let started_at = std::time::Instant::now();
        let event_bus = Arc::new(AppEventBus::new());
        let serial_pool = Arc::new(SerialPool::new(
            config.serial.default_baud_rate,
            config.serial.default_timeout_ms,
        ));
        let terminal_mgr = Arc::new(TerminalManager::new(serial_pool.clone()));
        let terminal_buf_bytes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(
            (config.terminal.buffer_mb.clamp(1, 64) as usize) * 1024 * 1024,
        ));
        let playwright = PlaywrightManager::new();
        // Device-local memory store — lives under the DATA dir
        // (data_dir()/memory). Capacity from config `memory:`
        // (defaults when absent). Shared Arc with the MemoryPlugin.
        let memory = Arc::new(MemoryStore::new(
            crate::plugins::memory::default_memory_dir(),
            MemoryLimits::default(),
        ));
        // round-163: runner start/stop pushes `playwright-changed` over the
        // SSE bus — the panel dropped its 5s status poll for this event.
        playwright.set_bus(event_bus.clone());
        let plugin_registry = build_registry(&RegistryDeps {
            terminal_mgr: terminal_mgr.clone(),
            serial_pool: serial_pool.clone(),
            event_bus: event_bus.clone(),
            buffer_limit: terminal_buf_bytes.clone(),
            playwright: playwright.clone(),
            download_url: config.platform.download_url.clone(),
            console_url: config.platform.console_url.clone(),
            memory: memory.clone(),
        });

        Self {
            serial_pool,
            terminal_mgr,
            event_bus,
            plugin_registry,
            config: std::sync::RwLock::new(config),
            started_at,
            config_path: std::sync::Arc::new(std::sync::Mutex::new(None)),
            terminal_buf_bytes,
            playwright,
            memory,
        }
    }

    /// Cheap read-side snapshot of the live config (Config is Clone: a few
    /// Options/Strings). Poison recovery per the lock convention — a
    /// panicked writer never takes the config (or the server) down.
    pub fn config_snapshot(&self) -> Config {
        let cfg = self.config.read().unwrap_or_else(|p| p.into_inner());
        cfg.clone()
    }

    /// Write-through config update: swap the in-process value and — when
    /// `persist` is set — atomically rewrite the ACTUALLY-LOADED config file
    /// (`config_path`, set at boot from argv[1], main.rs round-101) from the
    /// SAME value, so the file can never drift from memory (audit A4: two
    /// sources of truth).
    ///
    /// `persist=false` swaps memory only — for tests and callers whose
    /// persistence is handled elsewhere. With no config_path wired (dev
    /// invocations / harnesses), `persist=true` still swaps in-memory and
    /// simply writes nothing.
    pub fn update_config(&self, cfg: Config, persist: bool) -> anyhow::Result<()> {
        // ONE write guard across persist + swap: concurrent updates can never
        // interleave out of order (file is always written in swap order), and
        // no reader can observe memory ahead of the file. Persist happens
        // BEFORE the swap, so a failed disk write leaves BOTH sides untouched
        // — either both move or neither does (write-through, not write-behind).
        let mut guard = self.config.write().unwrap_or_else(|p| p.into_inner());
        if persist {
            let path = self
                .config_path
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if let Some(path) = path {
                let yaml = serde_yaml::to_string(&cfg).context("failed to serialize config")?;
                crate::bootstrap::atomic_write(&path, yaml.as_bytes())
                    .with_context(|| format!("failed to persist config to {}", path.display()))?;
            }
        }
        *guard = cfg;
        Ok(())
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
