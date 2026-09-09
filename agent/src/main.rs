//! vale-agent server binary — thin wrapper over the vale-agent library.
//!
//! Runs as a plain console process, or on Windows as the `ValeCommand` service
//! when launched by the Service Control Manager.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use vale_agent::register::self_register_plan;
use vale_agent::state::AppState;
use vale_agent_core::Config;

/// Startup log file (set in main): every out!/eout! line also lands here, so
/// a boot-task agent (no console) or a silent crash is diagnosable by reading
/// this file instead of asking the user to screenshot a window.
pub(crate) static LOG_FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub(crate) fn log_line(line: &str) {
    if let Some(p) = LOG_FILE.get() {
        use std::io::Write as _;
        // Rotation: startup.log grows forever (the agent runs indefinitely
        // as a boot task) — rotate to startup.log.old once it passes 1MB.
        if std::fs::metadata(p)
            .map(|m| m.len() > 1_000_000)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(p, p.with_extension("log.old"));
        }
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .and_then(|mut f| writeln!(f, "{line}"));
    }
}

/// Write a line to stdout, ignoring errors — a Windows service process has
/// no console, and println! would panic on the invalid handle, killing the
/// server thread before it can bind the listener.
macro_rules! out {
    () => {{
        let _ = std::io::Write::write_all(&mut std::io::stdout(), b"\n");
        log_line("");
    }};
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let line = format!($($arg)*);
        let _ = writeln!(std::io::stdout(), "{line}");
        log_line(&line);
    }};
}

/// Write a line to stderr, ignoring errors (same reason as `out!`).
macro_rules! eout {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let line = format!($($arg)*);
        let _ = writeln!(std::io::stderr(), "{line}");
        log_line(&line);
    }};
}

/// Windows service name — must match what the installer's `sc create` registers.
#[cfg_attr(not(windows), allow(dead_code))]
// Windows-only plumbing (self-heal, child-reaper job, SCM service, tunnel
// supervisor) — declared AFTER the out!/eout! macros so their textual scope
// reaches the module.
#[cfg(windows)]
mod winmain;

/// Print error and pause before exit (Windows console friendly). In service mode
/// stdin is not connected, so the read returns immediately and we still exit.
/// stage-m: a parent (the Electron shell) may set VALE_NO_PAUSE=1 — then the
/// pause is skipped entirely. Without this, an agent spawned by the shell that
/// loses the 18080 bind race wedges on `read_line` forever, leaking an orphan
/// process per launch (the d1 Chrome-OOM root cause).
fn fatal(msg: &str) -> ! {
    eout!("\n  ERROR: {msg}\n");
    if std::env::var_os("VALE_NO_PAUSE").is_none() {
        eout!("  Press Enter to exit...");
        let _ = std::io::stdin().read_line(&mut String::new());
    } else {
        eout!("  (VALE_NO_PAUSE — exiting immediately)");
    }
    std::process::exit(1);
}

fn init_tracing() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let env =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    let stdout_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stdout);
    // stage-n: on Windows ALSO mirror tracing into agent.log (DataDir\logs,
    // layout v2 — was next to the exe; program files stay read-mostly, and
    // a reinstall keeps diagnostics). 1 MB rotation — the scheduled task /
    // service context has no console, and without this the runtime `tracing!`
    // call sites (recovery notices, bridge supervision…) were invisible.
    #[cfg(windows)]
    {
        let path = vale_agent::paths::agent_log_file();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file_layer = vale_agent::filelog::RotatingFile::new(path).ok().map(|w| {
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(w)
        });
        tracing_subscriber::Registry::default()
            .with(env)
            .with(stdout_layer)
            .with(file_layer)
            .init();
        return;
    }
    #[cfg(not(windows))]
    {
        tracing_subscriber::Registry::default()
            .with(env)
            .with(stdout_layer)
            .init();
    }
}

fn main() {
    // Layout-v2 boot migration FIRST (ADR 0008 backstop): a pre-v2 updater
    // (old Rust agent_update / old vale.js) leaves v1 paths behind; the new
    // agent moves them into their v2 homes before anything reads them.
    // Real installs only (registry-gated inside); idempotent; never fatal.
    // Runs before logging so the moved history is complete.
    #[cfg(windows)]
    {
        for note in vale_agent::paths::migrate_layout_v2() {
            eprintln!("  layout-v2: {note}");
        }
    }
    init_tracing();

    // Every out!/eout! line also goes to startup.log (DataDir\logs — layout
    // v2; was next to the exe), so a boot-task run (no console) is
    // diagnosable after the fact.
    #[cfg(windows)]
    {
        let path = vale_agent::paths::startup_log_file();
        if path.as_os_str().is_empty() {
            // Unresolvable roots — fall back to the exe dir (dev trees).
            let dir = vale_agent::paths::exe_dir();
            if !dir.as_os_str().is_empty() {
                let _ = LOG_FILE.set(dir.join("startup.log"));
            }
        } else {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = LOG_FILE.set(path);
        }
        log_line(&format!(
            "=== vale-agent {} starting ===",
            env!("CARGO_PKG_VERSION")
        ));
    }

    // Must run before ANY child spawns: every PTY shell, SSH/serial session,
    // and helper this process creates joins our kill-on-close job, so the
    // kernel reaps them whenever the agent dies — update swap, Stop-Process,
    // crash. Before round-134 an update orphaned every open shell (observed
    // on d1: shells from hours-old sessions survived four restarts).
    #[cfg(windows)]
    winmain::setup_child_reaper_job();

    // If the Service Control Manager launched us, run as a Windows service.
    // service_dispatcher::start() succeeds only when the process was started by
    // the SCM; a normal console launch fails fast (ERROR_FAILED_SERVICE_CONTROLLER_CONNECT)
    // and we fall through to the console path below.
    #[cfg(windows)]
    {
        if winmain::started_by_scm() {
            return;
        }
    }

    let args: Vec<String> = std::env::args().collect();
    // `--init <path>` bootstraps the config + auth token and exits (used by the
    // Windows one-click installer so a server isn't left running just to
    // generate a token). Without a flag, argv[1] is the config path.
    // round-120: a bare launch (double-click, no boot task) with no argv[1]
    // used to fall back to a RELATIVE "config.yaml" — resolved against the
    // process CWD (C:\Windows\System32 for shell/SYSTEM contexts), where
    // bootstrap CREATED a phantom default config with a fresh unknown token
    // and every client 401'd. Fall back to the layout-v2 config file
    // (etc\config.yaml under the resolved install dir).
    // zero current_exe() guessing outside paths.rs — exe_dir() is the same
    // resolution (empty PathBuf when the exe path is unavailable), so the
    // closure degrades to None exactly when the old one did.
    let default_cfg = || {
        let dir = vale_agent::paths::exe_dir();
        (!dir.as_os_str().is_empty()).then(vale_agent::paths::config_file)
    };
    let init_mode = args.get(1).map(String::as_str) == Some("--init");
    let config_path = if init_mode {
        args.get(2)
            .map(PathBuf::from)
            .or_else(default_cfg)
            .unwrap_or_else(|| PathBuf::from("config.yaml"))
    } else {
        args.get(1)
            .map(PathBuf::from)
            .or_else(default_cfg)
            .unwrap_or_else(|| PathBuf::from("config.yaml"))
    };

    if init_mode {
        let _config = load_config(&config_path);
        tracing::info!("Init complete: {}", config_path.display());
        out!(
            "  Init complete: {} (token above). Start normally next run.",
            config_path.display()
        );
        return;
    }

    // Legacy-install self-heal BEFORE the tunnel repair and the server bind:
    // a 0.8.x install (vale-command.exe + ValeCommand service/tasks) can
    // coexist with this binary and grab port 18080 first — the SCM starts
    // its service before the ValeAgent boot task, so the new server dies on
    // bind and the device silently keeps serving the old version.
    #[cfg(windows)]
    winmain::self_heal();

    // Self-heal the cloudflared tunnel on startup: if the bundled
    // fix-tunnel.ps1 exists (it repairs a legacy vale-command-dN tunnel +
    // *.command.saisi.online ingress to vale-agent-dN + *.agent.saisi.online,
    // idempotent), run it once in the background. Runs as SYSTEM here (the
    // scheduled task), which can write the systemprofile cloudflared config
    // that the service reads — the silent-upgrade path ran it as an admin
    // user and could not always reach that file.
    #[cfg(windows)]
    {
        // stage-m (VS Code shell integration): materialize the OSC 633
        // injection script under scripts\shell-integration\ so pty spawn
        // can dot-source it (`-Command . '<path>'`). Embedded at compile time
        // via include_str!, written once per boot (idempotent, no version
        // churn — the script's own guard skips re-install per session).
        let si_dir = vale_agent::paths::shell_integration_dir();
        let si_script = si_dir.join("shellIntegration.ps1");
        if std::fs::create_dir_all(&si_dir).is_ok()
            && std::fs::write(
                &si_script,
                include_str!("../resources/shell-integration/shellIntegration.ps1"),
            )
            .is_ok()
        {
            log_line(&format!(
                "shell integration script: {}",
                si_script.display()
            ));
        }

        let fix_script = vale_agent::paths::scripts_dir().join("fix-tunnel.ps1");
        if fix_script.exists() && !init_mode {
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&fix_script)
                .spawn();
        }
    }

    // C2 unified process model — the AGENT owns the cloudflared tunnel
    // (spawn-if-absent, supervised; see winmain::supervise_tunnel).
    #[cfg(windows)]
    winmain::supervise_tunnel();

    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("FATAL: cannot create tokio runtime: {e}");
            std::process::exit(1);
        }
    };
    rt.block_on(run_server(config_path));
}

fn load_config(config_path: &Path) -> Config {
    // Core-audit #9 FOLLOW-UP (caught on d1 post-recovery): atomic_write
    // hardening only covers files written AFTER 1.2.224 — a PRE-EXISTING
    // config.yaml keeps its inherited Users:RX until the Settings page is
    // saved again. Harden the file on EVERY boot (idempotent, ~ms) so an
    // upgraded device self-heals without waiting for the next write.
    if config_path.exists() {
        if let Err(e) = vale_agent::paths::harden_file(config_path) {
            tracing::warn!("config.yaml ACL hardening unavailable: {e}");
        }
    }
    let (config, token) =
        match vale_agent::bootstrap::load_or_create(config_path, &|msg| eout!("{msg}")) {
            Ok(v) => v,
            Err(e) => fatal(&format!("Failed to load {}: {e}", config_path.display())),
        };
    // After the load path (a created-if-missing default holds only known
    // keys; anything unexpected here is from the user's file, pre-existing
    // or just typo'd). Non-fatal by design — see warn_unknown_keys.
    warn_unknown_keys(config_path);
    // round-104: bootstrap persists a newly generated proxy secret/token.
    // This branch only warns on a fresh token (it was already persisted by
    // load_or_create; a stale-token rewrite is a no-op here).
    if let Some(token) = &token {
        // A NEW token was generated — either a fresh install or the
        // device_token line was dropped/emptied by a hand-edit. The latter
        // silently 401s every remote client until they update; warn loudly.
        eout!("  WARNING: no valid device_token in config — generated a NEW token.");
        eout!("  Every client using the OLD token (console, MCP, panel) will 401 until updated.");
        let yaml = match serde_yaml::to_string(&config) {
            Ok(y) => y,
            Err(e) => {
                eprintln!("FATAL: serialize config: {e}");
                std::process::exit(1);
            }
        };
        // Atomic write (round-57): a half-written config on power loss would
        // quarantine on next boot and rotate the token again.
        let _ = vale_agent::bootstrap::atomic_write(config_path, yaml.as_bytes());
        // Mask the token in startup.log (round-58): the full token is the
        // device's only credential — a support-shared log must not leak it.
        // The console reads the token from config.yaml, not from logs.
        out!(
            "  Auth token: {}  (saved to {})",
            mask_token(token),
            config_path.display()
        );
    }
    config
}

/// Mask a device token for log output: first 4 + last 4, short tokens fully
/// hidden (round-58: startup.log must never leak the credential).
/// Extracted pure so the binary target has unit coverage (round-401).
pub(crate) fn mask_token(token: &str) -> String {
    if token.len() > 8 {
        format!("{}…{}", &token[..4], &token[token.len() - 4..])
    } else {
        "********".to_string()
    }
}

/// Serve the MCP + web panel for `config_path` until shutdown.
/// Load config (creating a default file + auth token if missing); persist and
/// print a freshly generated token.
/// Core-audit #10: unknown YAML keys were SILENTLY accepted (serde default) —
/// a typo'd `devce_token:` generated a FRESH token while the intended one was
/// ignored: every client 401'd and the only hint was a stdout line nobody
/// sees under the service. deny_unknown_fields is deliberately NOT used (a
/// parse failure triggers bootstrap's quarantine-to-defaults = token churn —
/// the audit's own warning), so we mirror-parse into Value and LOUDLY flag
/// extra keys with the accepted set, recursively for our known sections.
fn warn_unknown_keys(config_path: &Path) {
    for w in unknown_key_warnings(config_path) {
        tracing::warn!("{w}");
    }
}

/// Pure warning-text computation behind warn_unknown_keys (round-401: the
/// logging wrapper is untestable; the text list is asserted directly).
pub(crate) fn unknown_key_warnings(config_path: &Path) -> Vec<String> {
    const SECTIONS: &[(&str, &[&str])] = &[
        (
            "server",
            &["host", "port", "name", "device_token", "proxy_secret"],
        ),
        ("serial", &["default_baud_rate", "default_timeout_ms"]),
        ("terminal", &["buffer_mb"]),
        (
            "browser",
            &[
                "page_load_timeout_secs",
                "headless_executable",
                "headless_cdp_port",
            ],
        ),
        ("platform", &["console_url", "download_url"]),
    ];
    let Ok(raw) = std::fs::read_to_string(config_path) else {
        return Vec::new();
    };
    let Ok(val) = serde_yaml::from_str::<serde_yaml::Value>(&raw) else {
        return Vec::new();
    };
    let Some(map) = val.as_mapping() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let known_top: Vec<&str> = SECTIONS.iter().map(|(k, _)| *k).collect();
    for (k, v) in map {
        let Some(key) = k.as_str() else { continue };
        if let Some((_, fields)) = SECTIONS.iter().find(|(name, _)| *name == key) {
            // one level in: unknown KEYS inside a known section
            if let Some(sec) = v.as_mapping() {
                for (sk, _) in sec {
                    if let Some(s) = sk.as_str() {
                        if !fields.contains(&s) {
                            out.push(format!("config.yaml: unknown key '{key}.{s}' — IGNORED by the agent (typo? check docs; will never take effect)"));
                        }
                    }
                }
            } else {
                out.push(format!(
                    "config.yaml: section '{key}' is not a mapping — ignored"
                ));
            }
        } else if !known_top.contains(&key) {
            out.push(format!("config.yaml: unknown top-level key '{key}' — IGNORED by the agent (typo? check docs; will never take effect)"));
        }
    }
    out
}

pub(crate) async fn run_server(config_path: PathBuf) {
    let config = load_config(&config_path);

    tracing::info!("Config loaded from {}", config_path.display());
    out!("  Server: {}:{}", config.server.host, config.server.port);
    out!("  Name:   {}", config.server.name);
    // system_file_upload posts to the gateway /api/upload with the device
    // token — tools are stateless, so publish the token where they can read
    // it (process env, never logged).
    if let Some(t) = config.server.device_token.clone() {
        std::env::set_var("VALE_DEVICE_TOKEN", t);
    }

    let host = config.server.host.clone();
    let port = config.server.port;
    let name = config.server.name.clone();
    let state = Arc::new(AppState::new(config));
    // round-158: device self-register — the npm-installed agent reports itself
    // ({name, hostname, token = config.device_token}) to the console so the
    // Devices list stays automatic. Hostname comes from etc\vale-agent.hostname
    // (written at install); name = first label of the
    // subdomain. Runs at boot after the server is up, then every 6h; failures
    // are silent (the console may be offline at boot).
    {
        let reg_state = state.clone();
        tokio::spawn(async move {
            // Supervision audit #2: the old loop SNAPSHOT-READ the config
            // once and — violating the documented saisi decouple — fell back
            // to the HARDCODED gateway "https://api.saisi.online" plus a
            // hardcoded hostname, POSTing the device TOKEN from "pure local"
            // installs. Now EVERY cycle reads the live config + hostname file
            // (so Settings-card changes apply without restart), and with no
            // console_url configured NOTHING is ever sent anywhere.
            // Audit A4: "live config" is the write-through snapshot — the
            // same value PUT /api/settings and the gateway card persist; the
            // per-cycle config.yaml disk re-read is gone (one source of
            // truth, trusted in-process).
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            loop {
                let cfg = reg_state.config_snapshot();
                let console = cfg
                    .platform
                    .console_url
                    .clone()
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty());
                let token = cfg.server.device_token.clone().unwrap_or_default();
                let hostname = std::fs::read_to_string(vale_agent::paths::hostname_file())
                    .map(|x| x.trim().to_string())
                    .unwrap_or_default();
                let mut fast_retry = true;
                if let Some((url, body)) = self_register_plan(console.as_deref(), &token, &hostname)
                {
                    // Capture the STATUS, not just ok: the gateway's 409
                    // (hostname fixed + rotated token, proof impossible from
                    // here) is a PERMANENT conflict — retrying it every 60 s
                    // is infinite hammering with zero chance of success, and
                    // a debug-only log made "device not appearing in the
                    // console" undiagnosable. Failures now surface at warn
                    // with the status; a 409 backs off to the hourly cadence.
                    let mut conflict = false;
                    let ok = match reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(10))
                        .build()
                    {
                        Ok(c) => {
                            match c
                                .post(&url)
                                .header("content-type", "application/json")
                                .body(body)
                                .send()
                                .await
                            {
                                Ok(r) => {
                                    let st = r.status();
                                    let ok = st.is_success();
                                    if !ok {
                                        if st.as_u16() == 409 {
                                            conflict = true;
                                        }
                                        tracing::warn!(
                                        "[vale-agent] device self-register to {url} → HTTP {st}{}",
                                        if conflict { " (hostname/token conflict — resolve via the console Devices page; backing off)" } else { "" }
                                    );
                                    }
                                    ok
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "[vale-agent] device self-register to {url} failed: {e}"
                                    );
                                    false
                                }
                            }
                        }
                        Err(_) => false,
                    };
                    fast_retry = !ok && !conflict;
                    if conflict {
                        // Permanent per current credentials: retry at the
                        // hourly heartbeat so a console-side fix still lands
                        // without a restart.
                        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                        continue;
                    }
                    if !fast_retry {
                        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                        continue;
                    }
                }
                // not bound / not ready / failed: retry in 60 s (the old
                // empty-token `return` made a boot-order hiccup PERMANENT).
                let _ = &mut fast_retry;
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            }
        });
    }
    // round-101: remember the ACTUAL loaded config path so PUT /api/settings
    // persists to it (a hardcoded exe_dir/config.yaml silently reverted on
    // restart for dev/custom invocations).
    *state.config_path.lock().unwrap_or_else(|p| p.into_inner()) = Some(config_path.clone());

    // round-142 unified process model — the agent OWNS its browser stack:
    // auto-start playwright-mcp at boot. The kill-on-close reaper ties the
    // child to this process (an update restarts both), so no scheduled task
    // and no orphaned instance can drift out of sync anymore. Non-fatal:
    // failure just leaves the Plugins page Start button as manual recovery;
    // an already-healthy EXTERNAL instance is reused during migration.
    {
        let pw = state.playwright.clone();
        tokio::spawn(async move {
            match pw.start().await {
                Ok(v) => tracing::info!("playwright auto-start: {}", v),
                Err(e) => tracing::warn!("playwright auto-start failed: {e}"),
            }
        });
    }

    out!();
    out!("  MCP server running on http://{host}:{port}/mcp");
    out!("  Claude Code config:");
    out!("    {{ \"mcpServers\": {{ \"{name}\": {{ \"type\": \"http\", \"url\": \"http://{host}:{port}/mcp\" }} }} }}");
    out!();
    out!("  Press Ctrl+C to stop.");
    out!();

    tracing::info!("Starting MCP server...");

    // Bind with retry: a stale process can hold port 18080 for a few seconds
    // after a reboot/upgrade (SCM starting a legacy service, a lingering
    // instance finishing shutdown). A single failed bind used to kill the
    // agent permanently — device d1 stayed 502 after installs. Retry up to 5
    // times, 3s apart; every attempt lands in startup.log. serve() returns
    // only on shutdown (Ok) or an immediate startup failure (Err).
    let mut last_err = None;
    for attempt in 1..=5 {
        match vale_agent::mcp::serve(state.config_snapshot(), state.clone()).await {
            Ok(()) => return,
            Err(e) => {
                last_err = Some(e);
                if let Some(ref err) = last_err {
                    eout!("  Server bind attempt {attempt} failed: {err}");
                }
                eout!("  retrying in 3s...");
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
        }
    }
    fatal(&format!(
        "Server failed to start after 5 attempts: {}",
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".into())
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TMP_CTR: AtomicU64 = AtomicU64::new(0);

    /// Unique scratch config path (no tempfile dep on the binary target).
    fn scratch(yaml: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "vale-main-test-{}-{}-config.yaml",
            std::process::id(),
            TMP_CTR.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::write(&p, yaml).expect("write scratch config");
        p
    }

    #[test]
    fn mask_token_long_shows_first_and_last_four() {
        assert_eq!(mask_token("abcdefghij123456"), "abcd…3456");
    }

    #[test]
    fn mask_token_short_fully_hidden() {
        assert_eq!(mask_token(""), "********");
        assert_eq!(mask_token("12345678"), "********");
        assert_eq!(mask_token("123456789"), "1234…6789");
    }

    #[test]
    fn unknown_keys_clean_config_is_silent() {
        let p = scratch("server:\n  host: 127.0.0.1\n  port: 18080\nterminal:\n  buffer_mb: 8\n");
        assert!(unknown_key_warnings(&p).is_empty());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn unknown_keys_flags_top_level_and_nested() {
        let p = scratch("servre:\n  host: x\nserver:\n  devce_token: y\n  port: 1\n");
        let w = unknown_key_warnings(&p);
        assert!(
            w.iter()
                .any(|s| s.contains("unknown top-level key 'servre'")),
            "{w:?}"
        );
        assert!(
            w.iter()
                .any(|s| s.contains("unknown key 'server.devce_token'")),
            "{w:?}"
        );
        assert_eq!(w.len(), 2);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn unknown_keys_non_mapping_section_and_bad_inputs_are_safe() {
        let p = scratch("server: just-a-string\n");
        let w = unknown_key_warnings(&p);
        assert!(
            w.iter()
                .any(|s| s.contains("section 'server' is not a mapping")),
            "{w:?}"
        );
        std::fs::remove_file(&p).ok();
        // Missing file, invalid YAML, non-mapping root: silent, never panics.
        assert!(
            unknown_key_warnings(&PathBuf::from("/nonexistent-vale-dir-xyz/config.yaml"))
                .is_empty()
        );
        let bad = scratch("{not yaml: [unclosed\n");
        assert!(unknown_key_warnings(&bad).is_empty());
        std::fs::remove_file(&bad).ok();
        let list = scratch("- just\n- a\n- list\n");
        assert!(unknown_key_warnings(&list).is_empty());
        std::fs::remove_file(&list).ok();
    }
}
