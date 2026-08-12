//! vale-agent server binary — thin wrapper over the vale-agent library.
//!
//! Runs as a plain console process, or on Windows as the `ValeCommand` service
//! when launched by the Service Control Manager.

use std::path::PathBuf;
use std::sync::Arc;

use vale_agent::state::AppState;
use vale_agent::Config;

/// Startup log file (set in main): every out!/eout! line also lands here, so
/// a boot-task agent (no console) or a silent crash is diagnosable by reading
/// this file instead of asking the user to screenshot a window.
static LOG_FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn log_line(line: &str) {
    if let Some(p) = LOG_FILE.get() {
        use std::io::Write as _;
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
fn fatal(msg: &str) -> ! {
    eout!("\n  ERROR: {msg}\n");
    eout!("  Press Enter to exit...");
    let _ = std::io::stdin().read_line(&mut String::new());
    std::process::exit(1);
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
}

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
    let init_mode = args.get(1).map(String::as_str) == Some("--init");
    let config_path = if init_mode {
        args.get(2).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("config.yaml"))
    } else {
        args.get(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("config.yaml"))
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
        let install_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default();
        let fix_script = install_dir.join("fix-tunnel.ps1");
        if fix_script.exists() && !init_mode {
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&fix_script)
                .spawn();
        }
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
fn load_config(config_path: &PathBuf) -> Config {
    let (config, token) = match vale_agent::bootstrap::load_or_create(config_path, None, &|msg| eout!("{msg}")) {
        Ok(v) => v,
        Err(e) => fatal(&format!("Failed to load {}: {e}", config_path.display())),
    };
    if let Some(token) = token {
        // A NEW token was generated — either a fresh install or the
        // device_token line was dropped/emptied by a hand-edit. The latter
        // silently 401s every remote client until they update; warn loudly.
        eout!("  WARNING: no valid device_token in config — generated a NEW token.");
        eout!("  Every client using the OLD token (console, MCP, panel) will 401 until updated.");
        let yaml = serde_yaml::to_string(&config).expect("serialize config");
        std::fs::write(config_path, &yaml).ok();
        out!("  Auth token: {token}  (saved to {})", config_path.display());
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
fn run_service(args: Vec<std::ffi::OsString>) {
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

    // Service is registered with binPath= "<exe>" "<config>", so the config path
    // arrives as the first service argument.
    let config_path = args
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("config.yaml"));

    // Run the async server on its own tokio runtime — this thread must stay free
    // to answer SCM control requests.
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("create service tokio runtime");
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
