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
/// RUN identity — one AI execution's mint/end log (a label, never a credential).
pub(crate) mod runs;

/// Seconds since the UNIX epoch (0 on clock errors). Shared by the
/// audit-log writers (filelog.rs, session_log.rs) and the memory store —
/// each used to carry its own private copy of this 3-liner.
pub(crate) fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Milliseconds since the UNIX epoch (0 on clock errors). Pairs with
/// `unix_now()` for sub-second stamps. See `now_helpers` tests for the unit
/// contract.
///
/// `u64`, like `unix_now()` — NOT `i64`. A timestamp is never negative (the
/// clock-error arm is `0`), so the signed form bought nothing and cost a cast
/// at every consumer that stores one in a `u64` field. This is the SAME
/// number the old `i64` form produced for every reachable input: a real stamp
/// is ~1.7e12, far below `i64::MAX`, and `as i64`/`as u64` agree there, so the
/// JSON these helpers feed is byte-identical (`now_helpers_are_the_same_unit_apart`
/// pins the relationship).
///
/// CONSOLIDATION STATUS (SOLID R115): this helper was added to kill this
/// 3-liner, but the playwright plugin kept its own copy (`manager::now_ms`,
/// plus two inline sites in `playwright/tools.rs`) — the doc claimed a
/// consolidation that had not actually happened. All of them now use this.
pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
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
/// The device's merged operation timeline (terminal audit + browser actions).
pub(crate) mod operation;
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

/// The two epoch helpers, and the UNIT CONTRACT between them.
///
/// They are one word apart in a call site (`unix_now()` vs `now_millis()`) and
/// differ by 1000×, which is the classic silent bug: a millis stamp written
/// into a seconds field (or read back as seconds) is wrong by three orders of
/// magnitude and still looks like a plausible number. An audit of this crate
/// found `started_unix` produced as seconds and echoed to the model with NO
/// comparison anywhere — harmless TODAY, and one line away from not being.
///
/// These tests make the units machine-checked instead of remembered, using a
/// MAGNITUDE bound rather than a relation to each other: `1.7e12` millis vs
/// `1.7e9` seconds. A century of drift (up to the year 2286) stays inside the
/// bounds, so the test asserts a real property and not a clock reading.
#[cfg(test)]
mod now_helpers {
    use super::*;

    /// Year 2001 in seconds / millis — anything before this is a broken clock,
    /// not a unit mixup, and both helpers return 0 on a clock error anyway.
    const FLOOR_SECS: u64 = 1_000_000_000;
    const FLOOR_MILLIS: u64 = 1_000_000_000_000;
    /// Year 2286 — far past any plausible reading, still inside both types.
    const CEIL_SECS: u64 = 10_000_000_000;
    const CEIL_MILLIS: u64 = 10_000_000_000_000;

    #[test]
    fn now_helpers_are_the_same_unit_apart() {
        let secs = unix_now();
        let millis = now_millis();
        assert!(
            (FLOOR_SECS..CEIL_SECS).contains(&secs),
            "unix_now() returned {secs}, outside a seconds range — a millis \
             value here means the two helpers were swapped at a call site"
        );
        assert!(
            (FLOOR_MILLIS..CEIL_MILLIS).contains(&millis),
            "now_millis() returned {millis}, outside a millis range — a seconds \
             value here means the two helpers were swapped at a call site"
        );
        // Same epoch, 1000× apart. Compared as a RATIO with slack for the
        // microseconds between the two reads, never as an equality.
        let ratio = millis / secs.max(1);
        assert!(
            (999..=1001).contains(&ratio),
            "now_millis()/unix_now() = {ratio}, expected ~1000 — the helpers no \
             longer describe the same instant in different units"
        );
    }

    #[test]
    fn now_millis_is_monotonic_and_nonzero() {
        let a = now_millis();
        let b = now_millis();
        assert!(a > 0, "a clock-error reading (0) would silently stamp 1970");
        assert!(a <= b, "{a} then {b} — the epoch went backwards");
    }

    #[test]
    fn now_millis_is_not_a_seconds_value() {
        // The exact mistake the magnitude bound exists for: treating millis as
        // seconds yields 1970-01-20, and treating seconds as millis yields a
        // date in 1970 too. Assert the concrete dates differ by ~55 years.
        let millis_as_secs = now_millis() / 1000;
        let secs_as_millis = unix_now() * 1000;
        assert!(
            millis_as_secs.saturating_sub(unix_now()) < 5,
            "now_millis()/1000 must land within seconds of unix_now()"
        );
        assert!(
            secs_as_millis < now_millis(),
            "unix_now()*1000 must stay below now_millis()"
        );
    }
}
