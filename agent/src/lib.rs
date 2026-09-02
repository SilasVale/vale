// Re-export core types from vale-agent-core
pub use vale_agent_core::config;
pub use vale_agent_core::error;
pub use vale_agent_core::events;
pub use vale_agent_core::{Config, DeviceError, AgentEvent, Plugin, ToolDef, ToolHandler, NavItem, EventBus, AppEventBus};

pub mod bootstrap;

/// Cross-task control channel for the cloudflared tunnel supervisor
/// (supervision audit #1): provision_tunnel (web.rs) rewrites tunnel.yml
/// and then REQUESTS a restart; main.rs's supervisor task owns the single
/// child and performs it. Generation counter because both sides are cheap
/// pollers — no channel plumbing through AppState.
pub mod tunnel_ctl {
    use std::sync::atomic::{AtomicU64, Ordering};
    static GEN: AtomicU64 = AtomicU64::new(0);
    pub fn request_restart() {
        GEN.fetch_add(1, Ordering::SeqCst);
    }
    pub fn generation() -> u64 {
        GEN.load(Ordering::SeqCst)
    }
}
pub mod filelog;
pub mod mcp;
pub mod metrics;
pub mod paths;
pub mod session_log;
pub mod plugins;
pub mod state;
pub mod tools;
pub mod web;
pub mod ws_relay;

/// Default config.yaml embedded at compile time.
pub const DEFAULT_CONFIG_YAML: &str = include_str!("../config.yaml");
