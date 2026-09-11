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

/// What one RETENTION sweep removed, per record.
///
/// A struct rather than a `usize` because the two records answer different
/// questions: "pruned 412" cannot tell an operator whether the AI's screenshots
/// disappeared or its action timeline was shortened. Reported (never logged
/// here) by whoever ran the sweep — the `prune_stale` precedent, where the
/// owning module returns a count and the caller narrates it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetentionSweep {
    pub shots: usize,
    pub scripts: usize,
    pub action_lines: usize,
    pub run_records: usize,
}

impl RetentionSweep {
    pub fn total(&self) -> usize {
        self.shots + self.scripts + self.action_lines + self.run_records
    }

    /// One line for the agent log. Written here rather than at the call site so
    /// the device's record of WHAT WAS DELETED has one wording, and so the
    /// wording is unit-pinned instead of being rebuilt by each caller.
    pub fn describe(&self) -> String {
        format!(
            "retention: pruned {} screenshot(s), {} script(s), {} action line(s), \
             {} run record(s)",
            self.shots, self.scripts, self.action_lines, self.run_records
        )
    }
}

/// Age-bound the device's two append-only AI records: the `pwout` evidence feed
/// and `runs.jsonl`.
///
/// WHY THIS LIVES IN `lib.rs`: the two prunes belong to the modules that own
/// their records (`evidence::prune`, `runs::trim` — a shared `retention.rs`
/// would be a primitive with one consumer, which the repo's PROMOTION rule
/// rejects), and both modules are crate-private, so the BINARY cannot call them.
/// This function is the single piece of glue that resolves the real directories
/// through `paths.rs` and applies the configured windows; the tested core below
/// takes the directories as parameters, the same design the two modules use.
///
/// Call it at boot and periodically — `main.rs` does both. It is deliberately
/// NOT wired into `AppState::new` or the plugin registry: those are constructed
/// by tests, and a sweep that ran there would prune the developer's real
/// `DataDir` from the test suite.
pub fn retention_sweep(cfg: &Config) -> RetentionSweep {
    retention_sweep_in(
        &paths::evidence_dir(),
        &paths::runs_dir(),
        cfg,
        now_millis(),
    )
}

/// The sweep, with its two directories and the clock as parameters — the
/// testable core of [`retention_sweep`].
pub(crate) fn retention_sweep_in(
    evidence_dir: &std::path::Path,
    runs_dir: &std::path::Path,
    cfg: &Config,
    now_ms: u64,
) -> RetentionSweep {
    let (evidence_days, runs_days) = cfg.retention.effective();
    let ev = evidence::prune(evidence_dir, evidence_days, now_ms);
    let rr = runs::trim(runs_dir, runs_days, now_ms);
    RetentionSweep {
        shots: ev.shots,
        scripts: ev.scripts,
        action_lines: ev.action_lines,
        run_records: rr.records,
    }
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

/// The RETENTION sweep's own pins: the glue that ties the two owners together,
/// and the promise that the shipped `config.yaml` says what the binary does.
#[cfg(test)]
mod retention {
    use super::*;
    use vale_agent_core::config::{DEFAULT_EVIDENCE_RETENTION_DAYS, DEFAULT_RUNS_RETENTION_DAYS};

    const NOW: u64 = 1_800_000_000_000;
    const DAY_MS: u64 = 86_400_000;

    /// THE AGREEMENT PIN, and it is the same class of trap the platform block
    /// already documents: `config.yaml` is what a fresh install receives, while
    /// `RetentionConfig::default()` (all `None`) is what the test suite builds
    /// on. The two are allowed to DIFFER in which fields they set — but not in
    /// the VALUES the operator ends up with, or the numbers in the shipped
    /// config become a comment that lies.
    #[test]
    fn retention_defaults_agree_with_the_compiled_ones() {
        let embedded: Config = serde_yaml::from_str(DEFAULT_CONFIG_YAML)
            .expect("the embedded config.yaml must parse as a Config");
        assert_eq!(
            embedded.retention.effective(),
            (DEFAULT_EVIDENCE_RETENTION_DAYS, DEFAULT_RUNS_RETENTION_DAYS),
            "agent/config.yaml's retention block no longer matches the compiled \
             defaults. Fix whichever is wrong — but a fresh install and a \
             `Config::default()` must not mean two different windows"
        );
        // And the block is EXPLICIT in the file, not merely defaulted through:
        // an operator reading config.yaml has to be able to see the number.
        assert!(
            DEFAULT_CONFIG_YAML.contains("retention:")
                && DEFAULT_CONFIG_YAML.contains("evidence_days:"),
            "the shipped config must spell the retention block out — a bound \
             the operator cannot see is one they cannot change"
        );
        assert_eq!(
            Config::default().retention.effective(),
            embedded.retention.effective(),
            "Config::default() and the shipped file must resolve to the SAME \
             window (unlike platform, where the divergence is deliberate)"
        );
    }

    /// A `retention:` block an operator typed is honoured — the sweep is not
    /// silently pinned to the compiled defaults.
    #[test]
    fn a_configured_window_reaches_both_records() {
        let base = std::env::temp_dir().join(format!("vale-sweep-{}", std::process::id()));
        let (ev, rr) = (base.join("pwout"), base.join("runs"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&ev).unwrap();
        std::fs::create_dir_all(&rr).unwrap();

        let aged = |dir: &std::path::Path, name: &str, ms: u64| {
            let p = dir.join(name);
            std::fs::write(&p, b"x").unwrap();
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms))
                .unwrap();
        };
        aged(&ev, "old.png", NOW - 10 * DAY_MS);
        aged(&ev, "fresh.png", NOW - DAY_MS);
        aged(&rr, "unused", NOW);

        let cfg: Config = serde_yaml::from_str("retention:\n  evidence_days: 7\n").unwrap();
        let swept = retention_sweep_in(&ev, &rr, &cfg, NOW);

        assert_eq!(swept.shots, 1, "the 10-day-old shot is past a 7-day window");
        assert!(ev.join("fresh.png").exists());
        assert_eq!(swept.total(), 1);
        assert!(
            swept.describe().contains("pruned 1 screenshot(s)"),
            "the report must name WHAT was deleted, got: {}",
            swept.describe()
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The sweep is a no-op on empty/missing directories — it runs at every
    /// boot, including on a device that has never driven the browser.
    #[test]
    fn a_sweep_over_empty_dirs_reports_nothing() {
        let base = std::env::temp_dir().join(format!("vale-sweep-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let cfg = Config::default();
        let swept = retention_sweep_in(&base.join("pwout"), &base.join("runs"), &cfg, NOW);
        assert_eq!(swept, RetentionSweep::default());
        assert_eq!(swept.total(), 0);
    }

    /// The two records are swept with DIFFERENT windows, from one config read.
    ///
    /// A sweep that used the evidence window for both would silently shorten
    /// the run index — the exact inversion of the reasoning behind the two
    /// defaults, and invisible in the totals.
    #[test]
    fn each_record_gets_its_own_window() {
        let base = std::env::temp_dir().join(format!("vale-sweep-two-{}", std::process::id()));
        let (ev, rr) = (base.join("pwout"), base.join("runs"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&ev).unwrap();
        std::fs::create_dir_all(&rr).unwrap();

        // 40 days old: past the 30 d evidence window, inside the 90 d runs one.
        let p = ev.join("old.png");
        std::fs::write(&p, b"x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(
                std::time::UNIX_EPOCH + std::time::Duration::from_millis(NOW - 40 * DAY_MS),
            )
            .unwrap();
        crate::runs::begin(&rr, Some("old run"), None);
        let line = std::fs::read_to_string(crate::runs::runs_path(&rr)).unwrap();
        let mut stamped = serde_json::from_str::<serde_json::Value>(line.trim()).unwrap();
        stamped["ts_ms"] = serde_json::json!(NOW - 40 * DAY_MS);
        std::fs::write(crate::runs::runs_path(&rr), format!("{stamped}\n")).unwrap();

        let swept = retention_sweep_in(&ev, &rr, &Config::default(), NOW);

        assert_eq!(swept.shots, 1, "40 days is past the evidence window");
        assert_eq!(
            swept.run_records, 0,
            "40 days is INSIDE the runs window — one config read, two windows"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
