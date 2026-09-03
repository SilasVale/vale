//! vale-agent server binary — thin wrapper over the vale-agent library.
//!
//! Runs as a plain console process, or on Windows as the `ValeCommand` service
//! when launched by the Service Control Manager.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use vale_agent::register::self_register_plan;
use vale_agent::state::AppState;
use vale_agent::Config;

/// Startup log file (set in main): every out!/eout! line also lands here, so
/// a boot-task agent (no console) or a silent crash is diagnosable by reading
/// this file instead of asking the user to screenshot a window.
static LOG_FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn log_line(line: &str) {
    if let Some(p) = LOG_FILE.get() {
        use std::io::Write as _;
        // Rotation: startup.log grows forever (the agent runs indefinitely
        // as a boot task) — rotate to startup.log.old once it passes 1MB.
        if std::fs::metadata(p).map(|m| m.len() > 1_000_000).unwrap_or(false) {
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
const SERVICE_NAME: &str = "ValeCommand";

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

    let env = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info".into());
    let stdout_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stdout);
    // stage-n: on Windows ALSO mirror tracing into agent.log (next to the
    // exe, 1 MB rotation) — the scheduled task / service context has no
    // console, and without this the runtime `tracing!` call sites
    // (recovery notices, bridge supervision…) were invisible on the device.
    #[cfg(windows)]
    {
        let file_layer = std::env::current_exe().ok().and_then(|p| {
            let dir = p.parent()?.to_path_buf();
            vale_agent::filelog::RotatingFile::new(dir.join("agent.log"))
                .ok()
                .map(|w| tracing_subscriber::fmt::layer().with_ansi(false).with_writer(w))
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
        tracing_subscriber::Registry::default().with(env).with(stdout_layer).init();
    }
}

/// Coverage audit row 9: the self-register decision, extracted (it was inlined
/// in the supervisor loop) so the "never leak the token to a hardcoded
fn main() {
    init_tracing();

    // Every out!/eout! line also goes to startup.log next to this exe, so a
    // boot-task run (no console) is diagnosable after the fact.
    #[cfg(windows)]
    {
        if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
            let _ = LOG_FILE.set(dir.join("startup.log"));
            log_line(&format!("=== vale-agent {} starting ===", env!("CARGO_PKG_VERSION")));
        }
    }

    // Must run before ANY child spawns: every PTY shell, SSH/serial session,
    // and helper this process creates joins our kill-on-close job, so the
    // kernel reaps them whenever the agent dies — update swap, Stop-Process,
    // crash. Before round-134 an update orphaned every open shell (observed
    // on d1: shells from hours-old sessions survived four restarts).
    #[cfg(windows)]
    setup_child_reaper_job();

    // If the Service Control Manager launched us, run as a Windows service.
    // service_dispatcher::start() succeeds only when the process was started by
    // the SCM; a normal console launch fails fast (ERROR_FAILED_SERVICE_CONTROLLER_CONNECT)
    // and we fall through to the console path below.
    #[cfg(windows)]
    {
        use windows_service::service_dispatcher;
        if service_dispatcher::start(SERVICE_NAME, ffi_service_main).is_ok() {
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
    // and every client 401'd. Fall back to the exe's own directory.
    let exe_dir_cfg = || std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("config.yaml")));
    let init_mode = args.get(1).map(String::as_str) == Some("--init");
    let config_path = if init_mode {
        args.get(2).map(PathBuf::from).or_else(exe_dir_cfg).unwrap_or_else(|| PathBuf::from("config.yaml"))
    } else {
        args.get(1).map(PathBuf::from).or_else(exe_dir_cfg).unwrap_or_else(|| PathBuf::from("config.yaml"))
    };

    if init_mode {
        let _config = load_config(&config_path);
        tracing::info!("Init complete: {}", config_path.display());
        out!("  Init complete: {} (token above). Start normally next run.", config_path.display());
        return;
    }

    // Legacy-install self-heal BEFORE the tunnel repair and the server bind:
    // a 0.8.x install (vale-command.exe + ValeCommand service/tasks) can
    // coexist with this binary and grab port 18080 first — the SCM starts
    // its service before the ValeAgent boot task, so the new server dies on
    // bind and the device silently keeps serving the old version.
    #[cfg(windows)]
    self_heal();

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
        // injection script under install_dir/shell-integration/ so pty spawn
        // can dot-source it (`-Command . '<path>'`). Embedded at compile time
        // via include_str!, written once per boot (idempotent, no version
        // churn — the script's own guard skips re-install per session).
        let install_dir = vale_agent::paths::install_dir();
        let si_dir = install_dir.join("shell-integration");
        let si_script = si_dir.join("shellIntegration.ps1");
        if std::fs::create_dir_all(&si_dir).is_ok()
            && std::fs::write(&si_script, include_str!("../resources/shell-integration/shellIntegration.ps1")).is_ok()
        {
            log_line(&format!("shell integration script: {}", si_script.display()));
        }

        let fix_script = install_dir.join("fix-tunnel.ps1");
        if fix_script.exists() && !init_mode {
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&fix_script)
                .spawn();
        }
    }

    // C2 unified process model — the AGENT owns the cloudflared tunnel:
    // spawn-if-absent from the boxed install dir tools\cloudflared.exe with
    // --config tunnel.yml. No Windows service, no external owner, single
    // supervision path (setup no longer installs the legacy service; an
    // upgrade removes it).
    #[cfg(windows)]
    {
        let install_dir = vale_agent::paths::install_dir();
        // C2: cloudflared is BOXED under install_dir\tools\ and the AGENT owns
        // the tunnel lifecycle (spawn-if-absent on boot). No Windows service,
        // no external owner — this is the single supervision path.
        // Supervision audit #1: the OLD code spawned cloudflared once,
        // fire-and-forget — a tunnel that exited (CF network-fatal, cert
        // churn, OOM) left the device DARK while /api/status kept answering,
        // and provision_tunnel could stack a SECOND concurrent tunnel. One
        // supervisor task now owns the child for the process lifetime:
        // respawn with capped backoff (reset after a healthy minute) and a
        // RESTART when tunnel_ctl's generation bumps (fresh tunnel.yml).
        // CRITICAL (d1 530 incident, round-80): this block runs in main()
        // BEFORE the runtime exists — tokio::spawn HERE PANICKED the service
        // at boot on Windows only (cfg(windows) elided from Linux checks),
        // killing the agent and the tunnel = device unreachable. Own a
        // private current-thread runtime on a plain thread: correct in ANY
        // context, panic-proof placement.
        std::thread::spawn(move || {
            let inst = install_dir;
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => { log_line(&format!("cloudflared supervisor: no runtime: {e}")); return; }
            };
            rt.block_on(async move {
                use std::time::{Duration, Instant};
                let mut backoff: u64 = 5;
                loop {
                    let cf = inst.join("tools").join("cloudflared.exe");
                    let cfg = inst.join("tunnel.yml");
                    if !(cf.exists() && cfg.exists()) {
                        // Not staged yet — provision downloads later; keep polling.
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        continue;
                    }
                    let my_gen = vale_agent::tunnel_ctl::generation();
                    match tokio::process::Command::new(&cf)
                        .args(["tunnel", "--config"]).arg(&cfg).arg("run")
                        .kill_on_drop(true)
                        .spawn()
                    {
                        Ok(mut child) => {
                            log_line("cloudflared tunnel: launched from install dir (supervised)");
                            let started = Instant::now();
                            let mut restarted = false;
                            loop {
                                if let Ok(Some(_)) = child.try_wait() {
                                    break;
                                }
                                if vale_agent::tunnel_ctl::generation() != my_gen {
                                    let _ = child.kill().await;
                                    let _ = child.wait().await;
                                    restarted = true;
                                    break;
                                }
                                tokio::time::sleep(Duration::from_secs(1)).await;
                            }
                            if started.elapsed() >= Duration::from_secs(60) {
                                backoff = 5; // survived a healthy minute — reset
                            }
                            if restarted {
                                log_line("cloudflared tunnel: restart requested (re-provisioned)");
                                continue; // immediate respawn on the new config
                            }
                            log_line(&format!(
                                "cloudflared tunnel exited after {}s — respawn in {backoff}s",
                                started.elapsed().as_secs()
                            ));
                        }
                        Err(e) => {
                            log_line(&format!("cloudflared tunnel: spawn failed: {e} — retry in {backoff}s"));
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(60);
                }
            });
        });
    }

    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(run_server(config_path));
}

/// Windows boot self-heal — runs before the listener binds, idempotent.
///
/// A legacy 0.8.x install (vale-command.exe + the `ValeCommand` service and
/// scheduled tasks) can coexist with this binary: the SCM starts the service
/// before the `ValeAgent` boot task, the old process grabs port 18080, and
/// this server dies on bind — the device silently keeps serving the old
/// version after an upgrade. Repair that here:
///   1. kill every vale binary that is not THIS install dir (incl. the
///      legacy vale-command.exe, which is never this exe),
///   2. drop the legacy `ValeCommand` service + tasks — the `ValeAgent` boot
///      task is the canonical autostart (a service + task would race for the
///      port at every boot),
///   3. re-register the `ValeAgent` boot task pointing at this exe + config
///      (fixes a manual file-copy update into a different dir; keeps the
///      unlimited ExecutionTimeLimit so the server never dies after 72h),
///   4. point the `ValeAgentTray` logon task at this install dir's tray and
///      start it, so the tray icon always comes back.
///
/// CRITICAL: every child process runs with a hard timeout (run_bounded).
/// An unbounded status() wait here dead-locked the agent on d1 — startup.log
/// showed only "starting" and nothing else, so the server never bound and
/// the device served 502 forever. Self-heal is best-effort: a stuck step
/// must NEVER block the bind.
#[cfg(windows)]
fn self_heal() {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return, // no exe path, nothing to repair
    };
    let exe_str = exe.to_string_lossy().into_owned();
    let install_dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    // 0. Half-swap recovery (round-57): the NSIS upgrade swaps via
    //    exe → .bak then .new → exe — a power cut between the two renames
    //    leaves ONLY .bak + .new (no exe), the boot task fails to start the
    //    agent, and the device is offline with no recovery (self_heal never
    //    ran because the exe couldn't start). This runs from the BOOT task
    //    wrapper (which exists independently), so it can repair before the
    //    exe itself is needed. Idempotent, same naming as the NSIS swap.
    let bak = install_dir.join("vale-agent.exe.bak");
    let new = install_dir.join("vale-agent.exe.new");
    if !exe.exists() && bak.exists() {
        let _ = std::fs::rename(&bak, &exe);
    }
    if exe.exists() && new.exists() {
        let _ = std::fs::rename(&new, &exe);
        let _ = std::fs::remove_file(&bak); // stale copy now
    }
    let tray = install_dir.join("vale-tray.exe");
    let tray_str = tray.to_string_lossy().into_owned();
    let cfg_str = install_dir.join("config.yaml").to_string_lossy().into_owned();

    // 1. Stale binaries from other installs (they lock the exe AND hold the
    //    port). Runs as SYSTEM at boot; Stop-Process -Force is fine from
    //    there. Never kill processes of THIS install dir — and never this
    //    process. Exclude by PID (not by exe path): a path comparison can
    //    miss an 8.3 short path / empty Path and kill ourselves.
    let self_pid = std::process::id();
    let ps = format!(
        "Get-Process vale-agent,vale-command,vale-tray -ErrorAction SilentlyContinue \
         | Where-Object {{ $_.Id -ne {self_pid} -and $_.Path -ne '{exe_str}' -and $_.Path -ne '{tray_str}' }} \
         | Stop-Process -Force"
    );
    run_bounded("self-heal: kill stale procs", {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps]);
        c
    });

    // 2. Legacy service + tasks. The boot task below replaces them.
    run_bounded("self-heal: sc stop ValeCommand", {
        let mut c = std::process::Command::new("sc.exe");
        c.args(["stop", "ValeCommand"]);
        c
    });
    run_bounded("self-heal: sc delete ValeCommand", {
        let mut c = std::process::Command::new("sc.exe");
        c.args(["delete", "ValeCommand"]);
        c
    });
    for name in ["ValeCommand", "ValeCommandTray"] {
        run_bounded(&format!("self-heal: schtasks /End {name}"), {
            let mut c = std::process::Command::new("schtasks");
            c.args(["/End", "/TN", name]);
            c
        });
        run_bounded(&format!("self-heal: schtasks /Delete {name}"), {
            let mut c = std::process::Command::new("schtasks");
            c.args(["/Delete", "/TN", name, "/F"]);
            c
        });
    }

    // 3. Boot task at THIS install dir. ExecutionTimeLimit 0 = never kill the
    //    task (the Task Scheduler default of 72h silently stops the server).
    let script = format!(
        "Register-ScheduledTask -TaskName 'ValeAgent' \
         -Action (New-ScheduledTaskAction -Execute '{exe_str}' -Argument '\"{cfg_str}\"') \
         -Trigger (New-ScheduledTaskTrigger -AtStartup) \
         -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) \
         -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0)) -Force"
    );
    run_bounded("self-heal: Register-ScheduledTask ValeAgent", {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script]);
        c
    });

    // 4. Tray logon task — point at this install dir (keeps the registered
    //    user principal on /Change) and start it so the icon comes back now.
    if tray.exists() {
        run_bounded("self-heal: schtasks /Change ValeAgentTray", {
            let mut c = std::process::Command::new("schtasks");
            c.args(["/Change", "/TN", "ValeAgentTray", "/TR", &format!("\"{tray_str}\"")]);
            c
        });
        run_bounded("self-heal: schtasks /Run ValeAgentTray", {
            let mut c = std::process::Command::new("schtasks");
            c.args(["/Run", "/TN", "ValeAgentTray"]);
            c
        });
    }
    log_line("self-heal: complete");
}

/// Put this process into a kill-on-close Job Object: every child we spawn
/// (PTY shells, SSH/serial sessions, playwright-mcp, short-lived helpers)
/// inherits membership, and when the agent exits for ANY reason the kernel
/// closes our job handle and terminates them all. Nested jobs (Win8+) make
/// this safe under Task Scheduler's own job wrapper.
#[cfg(windows)]
fn setup_child_reaper_job() {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job == 0 {
            log_line("child-reaper job: CreateJobObject failed — update orphans possible");
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            log_line("child-reaper job: SetInformation failed — orphans possible on update");
            return;
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            log_line("child-reaper job: AssignProcess failed — nested jobs unsupported?");
            return;
        }
        // The handle is intentionally never closed: it lives until process
        // exit, whose implicit CloseHandle triggers the kill-on-close.
        log_line("child-reaper job: active — children die with the agent");
    }
}

/// Run a Windows helper process with a hard 30s timeout. Self-heal must never
/// block the bind: a stuck PowerShell/schtasks would otherwise dead-lock the
/// agent at every boot (this actually happened on d1). Logs start/done/timeout
/// to startup.log so a stuck step is visible next boot.
#[cfg(windows)]
fn run_bounded(what: &str, mut cmd: std::process::Command) {
    use std::time::Duration;
    use wait_timeout::ChildExt as _;

    log_line(&format!("{what} …"));
    match cmd.spawn() {
        Ok(mut child) => match child.wait_timeout(Duration::from_secs(30)) {
            Ok(Some(_)) => log_line(&format!("{what} ok")),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                log_line(&format!("{what} TIMED OUT — killed, continuing"));
            }
            Err(e) => log_line(&format!("{what} wait error: {e}")),
        },
        Err(e) => log_line(&format!("{what} spawn failed: {e}")),
    }
}

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
    const SECTIONS: &[(&str, &[&str])] = &[
        ("server", &["host", "port", "name", "device_token", "proxy_secret"]),
        ("serial", &["default_baud_rate", "default_timeout_ms"]),
        ("terminal", &["buffer_mb"]),
        ("browser", &["page_load_timeout_secs", "headless_executable", "headless_cdp_port"]),
        ("platform", &["console_url", "download_url"]),
    ];
    let Ok(raw) = std::fs::read_to_string(config_path) else { return };
    let Ok(val) = serde_yaml::from_str::<serde_yaml::Value>(&raw) else { return };
    let Some(map) = val.as_mapping() else { return };
    let known_top: Vec<&str> = SECTIONS.iter().map(|(k, _)| *k).collect();
    for (k, v) in map {
        let Some(key) = k.as_str() else { continue };
        if let Some((_, fields)) = SECTIONS.iter().find(|(name, _)| *name == key) {
            // one level in: unknown KEYS inside a known section
            if let Some(sec) = v.as_mapping() {
                for (sk, _) in sec {
                    if let Some(s) = sk.as_str() {
                        if !fields.contains(&s) {
                            tracing::warn!("config.yaml: unknown key '{key}.{s}' — IGNORED by the agent (typo? check docs; will never take effect)");
                        }
                    }
                }
            } else {
                tracing::warn!("config.yaml: section '{key}' is not a mapping — ignored");
            }
        } else if !known_top.contains(&key) {
            tracing::warn!("config.yaml: unknown top-level key '{key}' — IGNORED by the agent (typo? check docs; will never take effect)");
        }
    }
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
    let (config, token) = match vale_agent::bootstrap::load_or_create(config_path, None, &|msg| eout!("{msg}")) {
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
        let yaml = serde_yaml::to_string(&config).expect("serialize config");
        // Atomic write (round-57): a half-written config on power loss would
        // quarantine on next boot and rotate the token again.
        let _ = vale_agent::bootstrap::atomic_write(config_path, yaml.as_bytes());
        // Mask the token in startup.log (round-58): the full token is the
        // device's only credential — a support-shared log must not leak it.
        // The console reads the token from config.yaml, not from logs.
        let masked = if token.len() > 8 {
            format!("{}…{}", &token[..4], &token[token.len() - 4..])
        } else {
            "********".to_string()
        };
        out!("  Auth token: {masked}  (saved to {})", config_path.display());
    }
    config
}

/// Serve the MCP + web panel for `config_path` until shutdown.
async fn run_server(config_path: PathBuf) {
    let config = load_config(&config_path);

    tracing::info!("Config loaded from {}", config_path.display());
    out!("  Server: {}:{}", config.server.host, config.server.port);
    out!("  Name:   {}", config.server.name);

    let host = config.server.host.clone();
    let port = config.server.port;
    let name = config.server.name.clone();
    let state = Arc::new(AppState::new(config));
    // round-158: device self-register — the npm-installed agent reports itself
    // ({name, hostname, token = config.device_token}) to the console so the
    // Devices list stays automatic. Hostname comes from vale-agent.hostname
    // next to the exe (written at install); name = first label of the
    // subdomain. Runs at boot after the server is up, then every 6h; failures
    // are silent (the console may be offline at boot).
    {
        let reg_install = vale_agent::paths::install_dir();
        let reg_cfgpath = state.config_path.clone();
        tokio::spawn(async move {
            // Supervision audit #2: the old loop SNAPSHOT-READ the config
            // once and — violating the documented saisi decouple — fell back
            // to the HARDCODED gateway "https://api.saisi.online" plus a
            // hardcoded hostname, POSTing the device TOKEN from "pure local"
            // installs. Now EVERY cycle re-reads live config + hostname file
            // (so Settings-card changes apply without restart), and with no
            // console_url configured NOTHING is ever sent anywhere.
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            loop {
                let cfg_path = reg_cfgpath
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                let cfg = cfg_path.as_ref().and_then(|p| Config::load(p).ok());
                let console = cfg
                    .as_ref()
                    .and_then(|c| c.platform.console_url.clone())
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty());
                let token = cfg
                    .as_ref()
                    .and_then(|c| c.server.device_token.clone())
                    .unwrap_or_default();
                let hostname = std::fs::read_to_string(reg_install.join("vale-agent.hostname"))
                    .map(|x| x.trim().to_string())
                    .unwrap_or_default();
                let mut fast_retry = true;
                if let Some((url, body)) = self_register_plan(console.as_deref(), &token, &hostname)
                {
                    let ok = match reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(10))
                        .build()
                    {
                        Ok(c) => c
                            .post(&url)
                            .header("content-type", "application/json")
                            .body(body)
                            .send()
                            .await
                            .ok()
                            .map(|r| r.status().is_success())
                            .unwrap_or(false),
                        Err(_) => false,
                    };
                    tracing::debug!(ok, "device self-register to gateway");
                    // steady-state heartbeat hourly; failures retry in 60 s.
                    fast_retry = !ok;
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
        match vale_agent::mcp::serve(state.config.clone(), state.clone()).await {
            Ok(()) => return,
            Err(e) => {
                last_err = Some(e);
                eout!("  Server bind attempt {attempt} failed: {}", last_err.as_ref().unwrap());
                eout!("  retrying in 3s...");
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
        }
    }
    fatal(&format!(
        "Server failed to start after 5 attempts: {}",
        last_err.map(|e| e.to_string()).unwrap_or_else(|| "unknown error".into())
    ));
}

// Generates `ffi_service_main`, an `extern "system" fn(u32, *mut *mut u16)`
// that the SCM calls and which forwards the service args to `run_service`.
#[cfg(windows)]
windows_service::define_windows_service!(ffi_service_main, run_service);

/// Windows service entry point: register SCM control handling, report RUNNING,
/// run the server on a dedicated tokio runtime, then stop cleanly when told to.
/// Returns `()` because the SCM bootstrap macro discards the return value; any
/// error is logged and the service simply fails to start.
#[cfg(windows)]
fn run_service(_args: Vec<std::ffi::OsString>) {
    use std::sync::mpsc;
    use std::time::Duration;
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceStatus, ServiceState,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};

    // Channel so the SCM control handler can signal this thread to stop.
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = stop_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };

    let status_handle = match service_control_handler::register(SERVICE_NAME, event_handler) {
        Ok(h) => h,
        Err(e) => {
            eout!("ERROR: failed to register service control handler: {e}");
            return;
        }
    };

    let running = ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::NO_ERROR,
        checkpoint: 0,
        wait_hint: Duration::from_secs(0),
        process_id: None,
    };
    if let Err(e) = status_handle.set_service_status(running) {
        eout!("ERROR: failed to report RUNNING: {e}");
        return;
    }

    // round-120: the SCM does NOT pass the binPath "<config>" argument to
    // ServiceMain — lpServiceArgVectors are the StartService args only (empty
    // for auto-start at boot). The old args.first() was therefore always
    // empty, so the path fell back to a RELATIVE "config.yaml" which resolved
    // against the service CWD (C:\Windows\System32) — bootstrap CREATED a
    // phantom default config there with a fresh unknown token, and every
    // client 401'd while the real install-dir config was never loaded. Read
    // the process command line (env::args carries the binPath param) and fall
    // back to the exe's own directory (never a relative path).
    let config_path = std::env::args().nth(1)
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("config.yaml"))))
        .unwrap_or_else(|| PathBuf::from("config.yaml"));

    // Run the async server on its own tokio runtime — this thread must stay free
    // to answer SCM control requests.
    // round-120: a panic on this thread (Runtime::new().expect, or any panic
    // in run_server) previously unwound only the thread — the service stayed
    // 'Running' with a dead server and the SCM recovery actions never fired.
    // Report the failure so the SCM sees a stopped service and restarts it.
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                eout!("ERROR: failed to create service tokio runtime: {e}");
                let stopped = ServiceStatus {
                    service_type: ServiceType::OWN_PROCESS,
                    current_state: ServiceState::Stopped,
                    controls_accepted: ServiceControlAccept::empty(),
                    exit_code: ServiceExitCode::ServiceSpecific(1),
                    checkpoint: 0,
                    wait_hint: Duration::from_secs(0),
                    process_id: None,
                };
                let _ = status_handle.set_service_status(stopped);
                return;
            }
        };
        rt.block_on(run_server(config_path));
    });

    // Block until the SCM asks us to stop.
    let _ = stop_rx.recv();

    let stopped = ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::NO_ERROR,
        checkpoint: 0,
        wait_hint: Duration::from_secs(0),
        process_id: None,
    };
    let _ = status_handle.set_service_status(stopped);
}
