//! winmain.rs — Windows-only process plumbing (structure refactor A7: moved
//! verbatim from main.rs; zero behavior change). Everything in this module is
//! `#[cfg(windows)]`: the boot self-heal, the kill-on-close child-reaper job,
//! the bounded helper runner, the SCM service entry, and the supervised
//! cloudflared tunnel owner. Non-Windows builds never compile any of it —
//! main.rs keeps only the `winmain::…` call sites, equally cfg-gated.

#![cfg(windows)]

use std::path::PathBuf;

use crate::{log_line, run_server};

/// The SCM service name — deliberately the LEGACY name ("ValeCommand"): the
/// service was registered under it by the old install path and re-registering
/// under a new name would orphan existing installs. (Moved here with the
/// windows-only plumbing — its only consumers are cfg(windows).)
pub(crate) const SERVICE_NAME: &str = "ValeCommand";

/// C2 unified process model — the AGENT owns the cloudflared tunnel:
/// spawn-if-absent from the boxed install dir tools\cloudflared.exe with
/// --config tunnel.yml. No Windows service, no external owner, single
/// supervision path (setup no longer installs the legacy service; an
/// upgrade removes it).
pub(crate) fn supervise_tunnel() {
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
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log_line(&format!("cloudflared supervisor: no runtime: {e}"));
                return;
            }
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
                    .args(["tunnel", "--config"])
                    .arg(&cfg)
                    .arg("run")
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
                        log_line(&format!(
                            "cloudflared tunnel: spawn failed: {e} — retry in {backoff}s"
                        ));
                    }
                }
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(60);
            }
        });
    });
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
///      unlimited ExecutionTimeLimit so the server never dies after 72h).
///
/// CRITICAL: every child process runs with a hard timeout (run_bounded).
/// An unbounded status() wait here dead-locked the agent on d1 — startup.log
/// showed only "starting" and nothing else, so the server never bound and
/// the device served 502 forever. Self-heal is best-effort: a stuck step
/// must NEVER block the bind.
#[cfg(windows)]
pub(crate) fn self_heal() {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return, // no exe path, nothing to repair
    };
    let exe_str = exe.to_string_lossy().into_owned();
    // P2-8 dual-source install dir: prefer the centralized
    // paths::install_dir() (registry InstallDir, the single source of truth);
    // fall back to exe.parent() when the registry is missing (dev builds /
    // unregistered installs — paths::install_dir() already falls back to the
    // exe dir itself, so this is belt-and-braces). No legacy-dir probing.
    let install_dir = {
        let d = vale_agent::paths::install_dir();
        if d.as_os_str().is_empty() {
            exe.parent().map(|p| p.to_path_buf()).unwrap_or_default()
        } else {
            d
        }
    };
    // 0. Half-swap recovery (round-57): the NSIS upgrade swaps via
    //    exe → .bak then .new → exe — a power cut between the two renames
    //    leaves ONLY .bak + .new (no exe), the boot task fails to start the
    //    agent, and the device is offline with no recovery (self_heal never
    //    ran because the exe couldn't start). This runs from the BOOT task
    //    wrapper (which exists independently), so it can repair before the
    //    exe itself is needed. Idempotent, same naming as the NSIS swap.
    let bak = install_dir.join("vale-agent.exe.bak");
    let new = install_dir.join("vale-agent.exe.new");
    // Half-swap failures must be LOUD and recoverable: every rename result
    // is checked, failures land in startup.log as CRITICAL (not hidden
    // behind a blanket 'self-heal: complete'), stale backups are never
    // deleted on a failed swap, and a copy fallback is attempted when a
    // rename fails (transient AV/lock races).
    let mut heal_failed = false;
    if !exe.exists() && bak.exists() {
        match std::fs::rename(&bak, &exe) {
            Ok(()) => log_line("self-heal: half-swap recovery: restored exe from .bak"),
            Err(e) => {
                log_line(&format!(
                    "self-heal: CRITICAL half-swap recovery FAILED: cannot restore {} -> {}: {e} — attempting copy fallback (.bak preserved for manual recovery)",
                    bak.display(),
                    exe.display()
                ));
                match std::fs::copy(&bak, &exe) {
                    Ok(_) => {
                        log_line("self-heal: copy fallback restored the exe from .bak");
                        if let Err(rm_e) = std::fs::remove_file(&bak) {
                            log_line(&format!(
                                "self-heal: warning: cannot remove stale .bak: {rm_e}"
                            ));
                        }
                    }
                    Err(ce) => {
                        log_line(&format!(
                            "self-heal: CRITICAL copy fallback FAILED too: {ce} — device may be unbootable; .bak preserved, NOT claiming success"
                        ));
                        heal_failed = true;
                    }
                }
            }
        }
    }
    if exe.exists() && new.exists() {
        match std::fs::rename(&new, &exe) {
            Ok(()) => {
                log_line("self-heal: half-swap recovery: applied pending .new over exe");
                if let Err(rm_e) = std::fs::remove_file(&bak) {
                    // Stale-copy cleanup only — not fatal if it fails.
                    log_line(&format!(
                        "self-heal: warning: cannot remove stale .bak: {rm_e}"
                    ));
                }
            }
            Err(e) => {
                // Fallback posture = revert: the current exe is untouched
                // (still bootable on the previous build), .bak is KEPT as
                // the rollback, and .new is KEPT for next-boot retry.
                log_line(&format!(
                    "self-heal: CRITICAL half-swap recovery FAILED: cannot apply {} -> {}: {e} — keeping current exe (revert posture), .bak + .new preserved for retry",
                    new.display(),
                    exe.display()
                ));
                heal_failed = true;
            }
        }
    }
    // npm-channel staged leftovers: a FAILED agent_update stages
    // `vale-agent.new.exe` / boxed `.new` files and
    // returns false WITHOUT launching the swap script — the Rust failure
    // paths and the swap script's own !$ok branch both delete them
    // best-effort, but a power cut between staging and cleanup can still
    // strand them. They must NEVER be applied here: this recovery only
    // understands the NSIS-era `vale-agent.exe.new` half-swap above (a
    // different filename); applying an npm-era staging of unknown provenance
    // could mix a failed release's components under the old version marker
    // (a stranded boxed `.new` would otherwise be picked up by the
    // NEXT successful swap — version skew). Delete best-effort; the next
    // agent_update re-downloads + re-stages from scratch (safe + retryable).
    for stale in [
        install_dir.join("vale-agent.new.exe"),
        install_dir.join("vale-playwright.new.zip"),
        install_dir.join("tools").join("cloudflared.new.exe"),
    ] {
        if stale.exists() {
            match std::fs::remove_file(&stale) {
                Ok(()) => log_line(&format!(
                    "self-heal: removed stale staged file {}",
                    stale.display()
                )),
                Err(e) => log_line(&format!(
                    "self-heal: warning: cannot remove stale staged file {}: {e}",
                    stale.display()
                )),
            }
        }
    }
    let cfg_str = install_dir
        .join("config.yaml")
        .to_string_lossy()
        .into_owned();

    // 1. Stale binaries from other installs (they lock the exe AND hold the
    //    port). Runs as SYSTEM at boot; Stop-Process -Force is fine from
    //    there. Never kill processes of THIS install dir — and never this
    //    process. Exclude by PID (not by exe path): a path comparison can
    //    miss an 8.3 short path / empty Path and kill ourselves.
    let self_pid = std::process::id();
    let ps = format!(
        "Get-Process vale-agent,vale-command -ErrorAction SilentlyContinue \
         | Where-Object {{ $_.Id -ne {self_pid} -and $_.Path -ne '{exe_str}' }} \
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
        c.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ]);
        c
    });

    if heal_failed {
        log_line("self-heal: complete WITH ERRORS — see CRITICAL lines above");
    } else {
        log_line("self-heal: complete");
    }
}

/// Put this process into a kill-on-close Job Object: every child we spawn
/// (PTY shells, SSH/serial sessions, playwright-mcp, short-lived helpers)
/// inherits membership, and when the agent exits for ANY reason the kernel
/// closes our job handle and terminates them all. Nested jobs (Win8+) make
/// this safe under Task Scheduler's own job wrapper.
#[cfg(windows)]
pub(crate) fn setup_child_reaper_job() {
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

// Generates `ffi_service_main`, an `extern "system" fn(u32, *mut *mut u16)`
// that the SCM calls and which forwards the service args to `run_service`.
#[cfg(windows)]
windows_service::define_windows_service!(ffi_service_main, run_service);

/// SCM probe, owned by winmain so main.rs never touches windows_service
/// directly (A7 boundary): start the service dispatcher; `true` means the
/// SCM launched us and took over (caller must return), `false` means a
/// normal console launch — fall through. The macro-generated
/// `ffi_service_main` is module-private, so the call site cannot live in
/// main.rs.
#[cfg(windows)]
pub(crate) fn started_by_scm() -> bool {
    windows_service::service_dispatcher::start(SERVICE_NAME, ffi_service_main).is_ok()
}

/// Windows service entry point: register SCM control handling, report RUNNING,
/// run the server on a dedicated tokio runtime, then stop cleanly when told to.
/// Returns `()` because the SCM bootstrap macro discards the return value; any
/// error is logged and the service simply fails to start.
#[cfg(windows)]
fn run_service(_args: Vec<std::ffi::OsString>) {
    use std::sync::mpsc;
    use std::time::Duration;
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
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
    let config_path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .or_else(|| {
            // Zero current_exe() guessing outside paths.rs — exe_dir() is the
            // same resolution, centralized.
            let dir = vale_agent::paths::exe_dir();
            (!dir.as_os_str().is_empty()).then(|| dir.join("config.yaml"))
        })
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
