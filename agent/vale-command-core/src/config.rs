use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: ServerConfig,
    pub serial: SerialConfig,
    pub terminal: TerminalConfig,
    pub browser: BrowserConfig,
    pub platform: PlatformConfig,
    pub memory: MemoryConfig,
    pub retention: RetentionConfig,
}

/// Deployment endpoints — where this agent finds the console and the
/// release/download site. BOTH ARE OPTIONAL since the saisi decouple: a
/// purely local device (terminal + memory + MCP) needs neither. When unset,
/// cloud-dependent features degrade with explicit errors (update/design).
/// A different deployment sets them (setup.ps1 writes the section when
/// installing with non-default domains). Only the two bases are stored: the
/// update manifest is always `{download_url}/api/version` — consumers derive
/// it, so the two can never drift.
///
/// ⚠️ `#[derive(Default)]` here leaves both `None`, while the agent's EMBEDDED
/// config.yaml (the file a fresh install actually receives) sets both to the
/// saisi endpoints. So `Config::default()` is the LOCAL-only configuration and
/// is what the test suite builds on; it is deliberately NOT the fresh-install
/// configuration. Pinned by
/// `embedded_default_sets_platform_while_config_default_does_not` in the
/// agent's bootstrap.rs.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PlatformConfig {
    /// Console base (design page_view sources app.js / / / style.css).
    /// `None` = no console configured → page_view errors explicitly.
    pub console_url: Option<String>,
    /// Download-site apex; update manifest = `{download_url}/api/version`.
    /// `None` = no update channel → agent_update errors explicitly.
    pub download_url: Option<String>,
}

/// Per-session terminal output buffer, in MiB (round-69: was a hardcoded
/// compile-time constant — a serial console scrolling GPON logs wrapped in
/// seconds. Configurable now: the panel's settings writes this, the buffer
/// logic reads it at runtime; the file persists across restarts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalConfig {
    /// MiB per session before the oldest half spills to disk (memory) +
    /// spill file (same size) ≈ 2× this of recall. 1..=64.
    pub buffer_mb: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub name: String,
    /// API/MCP bearer token — auto-generated on first launch, written to config.yaml.
    /// `None` means no auth (legacy mode, auto-upgraded to a generated token).
    ///
    /// Renamed from `auth_token` (0.8.5): `alias` keeps old config.yaml files
    /// working — an existing `auth_token:` line is read as `device_token`, so
    /// the token survives the rename without regeneration.
    #[serde(skip_serializing_if = "Option::is_none", alias = "auth_token")]
    pub device_token: Option<String>,
    /// Shared secret for the gateway proxy (round-103): the gateway proxy
    /// sends this as X-Vale-Auth when proxying /panel/ so the agent can
    /// distinguish a gateway-authenticated request (safe to inject the
    /// device token) from a DIRECT public request (must NOT inject — the
    /// R102 marker header was client-spoofable). Auto-generated on first
    /// launch; the console reads it via the device-token-authenticated
    /// /api/status or registration flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SerialConfig {
    pub default_baud_rate: u32,
    pub default_timeout_ms: u64,
}

/// Device-local memory store capacity (`memory:` block in config.yaml).
/// ALL fields optional — absent means the compiled default. Round-357:
/// this block used to be documented-but-never-read (state.rs always passed
/// MemoryLimits::default()), so retention_days could never take effect in
/// production. state.rs now builds limits from effective().
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct MemoryConfig {
    /// Max live entries before oldest-first eviction. 0/absent = 10_000.
    pub max_entries: Option<usize>,
    /// Max live content bytes before oldest-first eviction. 0/absent = 64 MiB.
    pub max_bytes: Option<usize>,
    /// Soft-delete records older than this on open + every mutation.
    /// Absent = keep forever.
    pub retention_days: Option<u64>,
}

impl MemoryConfig {
    /// Resolve to concrete limits. ZERO IS ABSENT, FOR ALL THREE FIELDS — a
    /// `max_entries: 0` would evict everything on boot, and a `retention_days: 0` is
    /// strictly worse: the cutoff becomes NOW, every record is tombstoned, and the startup
    /// compact then rewrites the file from survivors, so the whole knowledge base is
    /// PERMANENTLY deleted rather than soft-deleted.
    ///
    /// `retention_days` was the one field this did not filter — the rule above already said
    /// "zero entries/bytes" and applied to two of the three. `retention_days: 0` is also the
    /// NATURAL way to write "keep forever", and the settings API agrees it means absent
    /// (`web/mod.rs`'s handler filters `> 0`), so only the config-file path could destroy a
    /// store.
    ///
    /// The literals twin vale-agent's MemoryLimits::default — pinned by the
    /// `memory_limits_default_matches_config_effective` test over in the
    /// agent crate (this crate cannot import it; core is the dependency).
    pub fn effective(&self) -> (usize, usize, Option<u64>) {
        (
            self.max_entries.filter(|&n| n > 0).unwrap_or(10_000),
            self.max_bytes
                .filter(|&n| n > 0)
                .unwrap_or(64 * 1024 * 1024),
            self.retention_days.filter(|&n| n > 0),
        )
    }
}

/// Retention for the device's two append-only AI records (`retention:` block
/// in config.yaml): the evidence feed (`DataDir\pwout`) and the runs log
/// (`DataDir\runs`). Both are written once per AI action and, before this
/// block existed, had NO bound at all — the only two durable records on the
/// device that grew forever.
///
/// AGE-BOUNDED ON PURPOSE, and the reason is in `evidence::prune`: a SIZE
/// trigger fires exactly when a long operation has produced the most evidence,
/// i.e. it destroys the most recent material first — the material that
/// explains what the AI is doing right now. An age bound is predictable, it is
/// what the operator reasons about ("a month of evidence"), and it cannot
/// prefer the current run's artifacts for deletion.
///
/// ALL fields optional — absent (or 0) means the compiled default, the same
/// `Option` + `effective()` shape as [`MemoryConfig`].
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RetentionConfig {
    /// Age bound in days for the evidence feed: `*.png` screenshots, the
    /// `pwai_*.js` scripts that produced them, and the `actions.jsonl`
    /// timeline. 0/absent = [`DEFAULT_EVIDENCE_RETENTION_DAYS`].
    pub evidence_days: Option<u64>,
    /// Age bound in days for `runs.jsonl`. 0/absent =
    /// [`DEFAULT_RUNS_RETENTION_DAYS`].
    pub runs_days: Option<u64>,
}

/// 30 days — the SAME window the session audit trail already prunes at
/// (`session_log::prune_stale(30)`), so the device has one retention story an
/// operator can hold in their head: "a month of AI evidence, a month of audit
/// trail".
///
/// Volume behind the number: a screenshot is ~100 KB–2 MB, and a
/// browser-heavy day produces a few hundred of them. At 300 shots × 500 KB
/// that is ~150 MB/day, so this window holds ~4.5 GB at the top of that
/// range — bounded and survivable, which is the entire point (the failure it
/// replaces is unbounded growth over a year with no operator watching). An
/// operator who wants less disk turns it down; the floor in
/// `evidence::MIN_RETENTION_DAYS` is what stops them turning it to zero.
pub const DEFAULT_EVIDENCE_RETENTION_DAYS: u64 = 30;

/// 90 days — deliberately 3× the evidence window.
///
/// The runs log is the INDEX of the evidence (`run/begin` … `run/end` bracket
/// the actions and commands an execution produced), and it is tiny: ~300 bytes
/// per record, so a heavy day of 50 runs is ~30 KB and a whole year is ~11 MB.
/// Deleting the index while the events it names still exist would be
/// backwards, so a run's record outlives every artifact it can be grouping.
pub const DEFAULT_RUNS_RETENTION_DAYS: u64 = 90;

impl RetentionConfig {
    /// Resolve to concrete windows in days. Zero is treated as absent rather
    /// than as "delete everything now" — the same guard, for the same reason,
    /// as [`MemoryConfig::effective`]. The modules that own the two records
    /// apply a further hard floor (`evidence::MIN_RETENTION_DAYS`), so a
    /// config that reaches them by another route cannot empty the feed either.
    pub fn effective(&self) -> (u64, u64) {
        (
            self.evidence_days
                .filter(|&n| n > 0)
                .unwrap_or(DEFAULT_EVIDENCE_RETENTION_DAYS),
            self.runs_days
                .filter(|&n| n > 0)
                .unwrap_or(DEFAULT_RUNS_RETENTION_DAYS),
        )
    }
}

/// DEAD CONFIG — browser automation (CDP/headless-Chrome) was retired; the
/// embedded Electron view + gateway MCP replaced it. Kept only so OLD config.yaml
/// files with a `browser:` section still parse (serde(default) swallows the
/// section; no production code reads these fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BrowserConfig {
    pub page_load_timeout_secs: u64,
    /// Explicit headless browser executable. None = discover Edge/Chrome.
    #[serde(default)]
    pub headless_executable: Option<String>,
    /// CDP debug port for the headless browser. None = default 19623.
    #[serde(default)]
    pub headless_cdp_port: Option<u16>,
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let content = fs::read_to_string(path)?;
        let cfg: Config = serde_yaml::from_str::<Config>(&content)?;
        // round-138: `port: 0` parses as u16 but binds an OS EPHEMERAL port —
        // the server reports healthy while cloudflared's fixed 18080 ingress
        // connects to nothing, so the device 502s silently with no diagnostics
        // (every other bad value is loud: out-of-range → quarantine,
        // unresolvable host → bind error → fatal). Reject 0 explicitly.
        if cfg.server.port == 0 {
            anyhow::bail!("server.port must not be 0 (binds an ephemeral port — the tunnel ingress 18080 would 502)");
        }
        Ok(cfg)
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        // 18080 is the canonical port everywhere else (config.yaml, tunnel
        // ingress, setup.ps1) — a config omitting `port:` previously bound
        // 3000 and the tunnel 502'd.
        // Loopback bind: the server is only ever reached via the cloudflared
        // tunnel (ingress 127.0.0.2:18080) or locally (browser on the device,
        // page_view). Binding 0.0.0.0 exposed the whole API to the LAN, and
        // the /panel/ Host gate (which must accept Host: <device>.agent... for
        // the tunnel) is trivially spoofable with curl — a LAN client could
        // read the injected __PANEL_TOKEN__ and get RCE as SYSTEM.
        // 127.0.0.1, AND THE CLAIM HERE USED TO BE THE OPPOSITE. It read
        // "127.0.0.2 is cloudflared's canonical ingress for this tunnel;
        // 127.0.0.1 covers localhost. Nothing else is reachable" — while the
        // agent's own tunnel provisioning writes 127.0.0.1 and calls 127.0.0.2
        // "a dead address (502)". BOTH COULD NOT BE TRUE, so the live device was
        // asked: `netstat` on d1 shows the listener on 127.0.0.1:18080, and d1's
        // `etc\tunnel.yml` says `service: http://127.0.0.1:18080`. This default
        // only applies when no config file supplies a host (the shipped
        // `config.yaml` says 127.0.0.1), so it was a default that disagreed with
        // the file it exists to replace — and with the ingress the agent writes.
        // Loopback either way; the point is that ONE address must be canonical.
        Self {
            host: "127.0.0.1".into(),
            port: 18080,
            name: "vale-agent".into(),
            device_token: None,
            proxy_secret: None,
        }
    }
}

impl ServerConfig {
    /// If no token is configured, generate a 32-byte hex token and return it.
    /// Callers should persist the config after calling this.
    ///
    /// Uses `getrandom` (CSPRNG, rdrand/OS source) — never a guessable fallback,
    /// since this token gates the entire HTTP/MCP API.
    /// Returns (new_token, changed) — `changed` is true when the config
    /// needs persistence (a token OR proxy secret was generated; round-104:
    /// a pre-secret config got a fresh secret every boot that was never
    /// written, so the console's registered secret went stale and /panel/
    /// injection died permanently after the first restart).
    pub fn ensure_token(&mut self) -> anyhow::Result<(Option<String>, bool)> {
        // Treat empty/whitespace as MISSING: `device_token: ""` (the natural
        // YAML way to express "no auth") previously locked every client out —
        // Some("") passed auth only with an empty Bearer header, so all /mcp
        // and /api/* returned 401 forever with no remote recovery.
        let mut changed = false;
        if self
            .device_token
            .as_deref()
            .is_some_and(|t| !t.trim().is_empty())
        {
            // round-103: still ensure the proxy secret exists (a pre-secret
            // config gets one on this boot; persistence is the caller's).
            if self
                .proxy_secret
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
            {
                return Ok((None, changed));
            }
            let mut b2 = [0u8; 32];
            getrandom::getrandom(&mut b2)
                .map_err(|e| anyhow::anyhow!("failed to generate proxy secret: {e}"))?;
            let sec: String = b2.iter().map(|b| format!("{b:02x}")).collect();
            self.proxy_secret = Some(sec);
            changed = true;
            return Ok((None, changed));
        }
        let mut buf = [0u8; 32];
        getrandom::getrandom(&mut buf)
            .map_err(|e| anyhow::anyhow!("failed to generate device token: {e}"))?;
        let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        self.device_token = Some(token.clone());
        let mut b2 = [0u8; 32];
        getrandom::getrandom(&mut b2)
            .map_err(|e| anyhow::anyhow!("failed to generate proxy secret: {e}"))?;
        let sec: String = b2.iter().map(|b| format!("{b:02x}")).collect();
        self.proxy_secret = Some(sec);
        Ok((Some(token), true))
    }
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            default_baud_rate: 115200,
            default_timeout_ms: 1000,
        }
    }
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self { buffer_mb: 8 }
    }
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            page_load_timeout_secs: 30,
            headless_executable: None,
            headless_cdp_port: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn load_rejects_port_zero() {
        let dir = std::env::temp_dir().join(format!("vale-cfg-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("config.yaml");
        let mut f = std::fs::File::create(&p).unwrap();
        writeln!(f, "server:").unwrap();
        writeln!(f, "  host: \"127.0.0.2\"").unwrap();
        writeln!(f, "  port: 0").unwrap();
        let r = Config::load(&p);
        let err = r.unwrap_err();
        assert!(
            err.to_string().contains("port"),
            "rejection must mention port: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_block_parses_partial_and_defaults() {
        // Absent block → all None → compiled defaults via effective().
        let cfg: Config = serde_yaml::from_str("server:\n  port: 18080\n").unwrap();
        assert_eq!(cfg.memory.effective(), (10_000, 64 * 1024 * 1024, None));
        // Partial block → set fields win, the rest default.
        let cfg: Config =
            serde_yaml::from_str("memory:\n  max_entries: 50\n  retention_days: 30\n").unwrap();
        assert_eq!(cfg.memory.effective(), (50, 64 * 1024 * 1024, Some(30)));
        // Zero entries/bytes are treated as absent (never "evict everything").
        let cfg: Config =
            serde_yaml::from_str("memory:\n  max_entries: 0\n  max_bytes: 0\n").unwrap();
        assert_eq!(cfg.memory.effective(), (10_000, 64 * 1024 * 1024, None));
    }

    #[test]
    fn retention_block_parses_partial_and_defaults() {
        // Absent block → all None → compiled defaults via effective().
        let cfg: Config = serde_yaml::from_str("server:\n  port: 18080\n").unwrap();
        assert_eq!(
            cfg.retention.effective(),
            (DEFAULT_EVIDENCE_RETENTION_DAYS, DEFAULT_RUNS_RETENTION_DAYS)
        );
        // Partial block → the set field wins, the other defaults.
        let cfg: Config = serde_yaml::from_str("retention:\n  evidence_days: 7\n").unwrap();
        assert_eq!(cfg.retention.effective(), (7, DEFAULT_RUNS_RETENTION_DAYS));
        // Zero is treated as ABSENT, never as "delete everything now" — the
        // same guard MemoryConfig carries, for the same reason: a
        // `retention: {evidence_days: 0}` typo must not empty the feed.
        let cfg: Config =
            serde_yaml::from_str("retention:\n  evidence_days: 0\n  runs_days: 0\n").unwrap();
        assert_eq!(
            cfg.retention.effective(),
            (DEFAULT_EVIDENCE_RETENTION_DAYS, DEFAULT_RUNS_RETENTION_DAYS)
        );
        // The two windows are deliberately DIFFERENT: the runs log is the
        // index of the evidence and must outlive it. If they ever agree, the
        // reasoning in DEFAULT_RUNS_RETENTION_DAYS has been lost.
        // ZERO IS ABSENT FOR ALL THREE FIELDS, and `retention_days` was the one that was
        // not filtered. `retention_days: 0` is the NATURAL way to write "keep forever", and
        // it was strictly worse than the caps it sat beside: the cutoff becomes NOW, every
        // record is tombstoned, and the store's startup compact then rewrites the file from
        // survivors — so a config-file typo DELETED the whole knowledge base. The settings
        // API already agreed 0 means absent; only this path disagreed.
        let zeroed = MemoryConfig {
            max_entries: Some(0),
            max_bytes: Some(0),
            retention_days: Some(0),
        };
        assert_eq!(
            zeroed.effective(),
            (10_000, 64 * 1024 * 1024, None),
            "0 in any of the three must mean ABSENT, not 'delete everything'"
        );
        // And a real value still survives.
        let set = MemoryConfig {
            max_entries: Some(7),
            max_bytes: Some(1024),
            retention_days: Some(30),
        };
        assert_eq!(set.effective(), (7, 1024, Some(30)));

        // A COMPILE-TIME assertion, which is what clippy asks for and what this wants to
        // be: if the two constants ever agree, the build should FAIL rather than a test
        // somebody may not be running. (This crate's tests were not run by CI until the
        // same round that added this — an ungated crate is how a stale assertion below sat
        // failing unnoticed.)
        const { assert!(DEFAULT_RUNS_RETENTION_DAYS > DEFAULT_EVIDENCE_RETENTION_DAYS) };
    }

    // SOLID Round-11 (contract completion): ensure_token is the credential
    // bootstrap for the whole HTTP/MCP API yet had zero direct pins — only
    // incidental exercise through agent boot. This fixes its truth table:
    // valid pair → noop; missing secret → backfill (round-103/104:
    // persistence-needed); missing/blank token → fresh pair (blank treated
    // as missing, else `device_token: ""` locks every client out with 401).
    fn is_hex64(s: &str) -> bool {
        s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
    }

    #[test]
    fn ensure_token_valid_pair_is_noop() {
        let mut s = ServerConfig {
            device_token: Some("tok-abc".into()),
            proxy_secret: Some("sec-def".into()),
            ..Default::default()
        };
        let (tok, changed) = s.ensure_token().unwrap();
        assert_eq!(tok, None);
        assert!(!changed, "nothing generated → nothing to persist");
        assert_eq!(s.device_token.as_deref(), Some("tok-abc"));
        assert_eq!(s.proxy_secret.as_deref(), Some("sec-def"));
    }

    #[test]
    fn ensure_token_backfills_missing_proxy_secret() {
        for secret in [None, Some("".to_string()), Some("   ".to_string())] {
            let mut s = ServerConfig {
                device_token: Some("tok-abc".into()),
                proxy_secret: secret,
                ..Default::default()
            };
            let (tok, changed) = s.ensure_token().unwrap();
            assert_eq!(tok, None, "device token untouched");
            assert!(changed, "fresh secret needs persistence");
            assert_eq!(s.device_token.as_deref(), Some("tok-abc"));
            let sec = s.proxy_secret.clone().unwrap();
            assert!(is_hex64(&sec), "32 CSPRNG bytes as hex: {sec}");
        }
    }

    #[test]
    fn ensure_token_generates_pair_when_token_missing_or_blank() {
        for token in [None, Some("".to_string()), Some("  \t ".to_string())] {
            let mut s = ServerConfig {
                device_token: token,
                proxy_secret: None,
                ..Default::default()
            };
            let (tok, changed) = s.ensure_token().unwrap();
            let tok = tok.expect("fresh device token must be returned");
            assert!(changed);
            assert!(is_hex64(&tok));
            let sec = s.proxy_secret.clone().unwrap();
            assert!(is_hex64(&sec));
            assert_ne!(tok, sec, "independent draws");
            assert_eq!(s.device_token.as_deref(), Some(tok.as_str()));
        }
    }

    #[test]
    fn auth_token_alias_survives_the_rename() {
        // Pre-0.8.5 config.yaml files carry `auth_token:` — the alias must
        // keep working so the token survives without regeneration.
        let cfg: Config = serde_yaml::from_str("server:\n  auth_token: legacy-tok\n").unwrap();
        assert_eq!(cfg.server.device_token.as_deref(), Some("legacy-tok"));
    }

    #[test]
    fn platform_decouple_and_server_defaults() {
        // saisi decouple: a purely local device configures neither endpoint.
        let cfg: Config = serde_yaml::from_str("server:\n  port: 18080\n").unwrap();
        assert_eq!(cfg.platform.console_url, None);
        assert_eq!(cfg.platform.download_url, None);
        // Loopback + canonical port (tunnel ingress 18080; never 0.0.0.0).
        //
        // 127.0.0.1, AND THIS ASSERTION USED TO SAY 127.0.0.2 — the disproven claim the
        // comment 240 lines up records: the tunnel provisioning writes 127.0.0.1, `netstat`
        // on d1 shows the listener on 127.0.0.1:18080, and 127.0.0.2 is not bound at all.
        // The CODE was corrected; this assertion was left behind, and it failed silently
        // because CI ran `cargo test -p vale-agent` and never this crate (now fixed too).
        let d = ServerConfig::default();
        assert_eq!((d.host.as_str(), d.port), ("127.0.0.1", 18080));
    }
}
