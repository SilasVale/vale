// Re-export core types from vale-agent-core
pub use vale_agent_core::config;
pub use vale_agent_core::error;
pub use vale_agent_core::events;
pub use vale_agent_core::{Config, DeviceError, AgentEvent, Plugin, ToolDef, ToolHandler, NavItem, EventBus, AppEventBus};

pub mod bootstrap;
pub mod register;

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

    #[cfg(test)]
    mod tests {
        //! Coverage audit row 10: the restart-signal contract the tunnel
        //! supervisor and provision_tunnel share.
        use super::*;
        use std::sync::Mutex;

        // Serialize against any other test touching GEN.
        static LOCK: Mutex<()> = Mutex::new(());

        #[test]
        fn request_restart_bumps_generation() {
            let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let before = generation();
            request_restart();
            assert_eq!(generation(), before + 1);
            request_restart();
            request_restart();
            assert_eq!(generation(), before + 3);
        }
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

/// Default config.yaml embedded at compile time.
pub const DEFAULT_CONFIG_YAML: &str = include_str!("../config.yaml");
