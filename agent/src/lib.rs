// Compat shim: core types re-exported so external/embedding consumers can
// import from the `vale_agent` facade. The CANONICAL import path for core
// types is `vale_agent_core::…` (the crate boundary; 5× the usage and the
// convention all internal src/ modules follow) — new code MUST import from
// vale_agent_core directly, never add consumers to these re-exports.
pub use vale_agent_core::config;
pub use vale_agent_core::error;
pub use vale_agent_core::events;
pub use vale_agent_core::{
    AgentEvent, AppEventBus, Config, DeviceError, EventBus, NavItem, Plugin, ToolDef, ToolHandler,
};

pub mod bootstrap;
pub mod register;

/// Seconds since the UNIX epoch (0 on clock errors). Shared by the
/// audit-log writers (filelog.rs, session_log.rs) and the memory store —
/// each used to carry its own private copy of this 3-liner.
pub(crate) fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Milliseconds since the UNIX epoch (0 on clock errors). The mcp_client
/// action feed and the system plugin's timing probe each used to inline
/// this; pairs with unix_now() for sub-second stamps.
pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lowercase hex of `bytes` (sha256-digest display). The update plugin and
/// the tunnel manager each used to carry a private copy.
pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Cross-task control channel for the cloudflared tunnel supervisor
/// (supervision audit #1): provision_tunnel (tunnel.rs) rewrites tunnel.yml
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
/// Internal-only (no embedding consumer): the AI-evidence feed contract is
/// crate-private — its playwright + mcp-client producers and the web reader
/// all live in this crate.
pub(crate) mod evidence;
pub mod filelog;
/// Internal-only (no embedding consumer): append-only JSONL hygiene shared by
/// the audit trail and the memory store (SOLID R111).
pub(crate) mod jsonl;
pub mod mcp;
pub mod metrics;
pub mod paths;
pub mod plugins;
pub mod session_log;
pub mod state;
/// Internal-only (no embedding consumer): byte-budget text clipping, shared by
/// the plugins + the audit trail (SOLID R105).
pub(crate) mod text;
pub mod tools;
pub mod tunnel;
pub mod web;

/// Default config.yaml embedded at compile time.
pub const DEFAULT_CONFIG_YAML: &str = include_str!("../config.yaml");
