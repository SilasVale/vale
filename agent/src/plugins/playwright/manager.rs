//! playwright-mcp process management — start/stop on demand, using the device Edge (round-admin-ui).
//!
//! The management UI (panel plugin page) starts/stops the bundled playwright-mcp
//! via /api/plugins/playwright/start|stop; 127.0.0.1-only binding +
//! allowed-hosts (prevents port squatting: a tokenless service on the same
//! port could otherwise be called directly by any client).
//!
//! Bundled path convention (Phase 3 packaging): node.exe and playwright-mcp (dist/cli.js)
//! both live under install_dir/playwright/ — same root as the update plugin's install_dir();
//! dev builds have no bundle, and start must report a clear error rather than pretend to start.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;
use vale_agent_core::{recover_guard, DeviceError};

/// round-143: CREATE_NO_WINDOW — node.exe is a console-subsystem binary; when
/// the agent (or the swap's powershell/taskkill helpers) spawns it without
/// this flag and the parent has an interactive console, Windows allocates a
/// visible cmd window. 0x08000000 = CREATE_NO_WINDOW. Harmless when the
/// parent has no console (session-0 service) and prevents the flash under
/// `vale run` / dev consoles. We apply it through `std::os::windows::process
/// ::CommandExt::creation_flags` on the inner std Command (tokio Command
/// doesn't expose it directly, but its `as_std_mut` gives us the same
/// underlying handle).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn no_window(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    use std::os::windows::process::CommandExt as _;
    cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Fixed port for the bundled playwright-mcp — matches the mcp_client
/// plugin's DEFAULT_URL (http://127.0.0.1:9229/mcp).
const MCP_PORT: u16 = 9229;

/// playwright-mcp process state machine: None = not running, Some = running.
/// All operations take the lock via recover_guard (poison recovery, consistent with the codebase).
pub struct PlaywrightManager {
    inner: Mutex<Option<ManagedPlaywright>>,
    /// round-163: set by AppState after construction — start/stop push a
    /// `playwright-changed` SSE event so the panel needs no status poll.
    bus: std::sync::Mutex<Option<std::sync::Arc<dyn vale_agent_core::EventBus>>>,
}

/// A running playwright-mcp instance.
struct ManagedPlaywright {
    child: Child,
    /// round-163: HELD OPEN for the child's lifetime. Under a session-0
    /// service the spawned child's inherited stdin is already at EOF, and
    /// playwright-mcp exits right after printing its banner when stdin
    /// closes ("Listening" then instant death — d1). Manual runs always
    /// had a console stdin, which is why they worked. Never written to.
    _stdin: Option<ChildStdin>,
    /// Kept for a later feature that needs the per-launch token again
    /// (e.g. auto-configuring mcp_client_connect) — start() returns it to
    /// the caller, nothing reads the field yet (round-admin-ui).
    #[allow(dead_code)]
    secret: String,
    started_at: u64,
    /// Reserved (round-admin-ui): before stop() an external party may request a graceful
    /// exit; currently only the send end is held.
    _kill_tx: oneshot::Sender<()>,
}

/// Install dir — registry-first, then exe dir (crate::paths::install_dir).
fn install_dir() -> PathBuf {
    crate::paths::install_dir()
}

/// Resolve the node runtime: the agent no longer bundles node.exe (the npm
/// channel guarantees the device has node). Resolution order:
///   1. registry NodePath (written by `vale setup` — the SYSTEM agent may
///      not see the user PATH)
///   2. bundled install_dir/playwright/node.exe (legacy bundles)
///   3. system PATH (`where node`)
///
/// Gives a clear error when none is found.
fn resolve_node() -> Result<PathBuf, DeviceError> {
    // 1. registry NodePath (recorded by `vale setup`)
    if let Some(p) = crate::paths::node_path() {
        return Ok(p);
    }
    // 2. legacy bundled node.exe
    let bundled = install_dir().join("playwright").join("node.exe");
    if bundled.exists() {
        return Ok(bundled);
    }
    // 3. system PATH (`where node`)
    #[cfg(windows)]
    {
        use std::process::Command;
        if let Ok(out) = Command::new("where").arg("node").output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(first) = text.lines().next() {
                    let p = PathBuf::from(first.trim());
                    if p.exists() { return Ok(p); }
                }
            }
        }
    }
    Err(DeviceError::Internal {
        message: "node.exe not found (playwright browser tools need it) — install Node.js (https://nodejs.org) or run `vale setup` to record its path".into(),
    })
}

/// Bundled playwright-mcp entry script — 0.0.79's bin is the package-root cli.js
/// (no dist/; cli.js relatively requires package.json in the same directory).
fn bundled_mcp_entry() -> Result<PathBuf, DeviceError> {
    let p = install_dir().join("playwright").join("node_modules").join("@playwright").join("mcp").join("cli.js");
    if !p.exists() {
        return Err(DeviceError::Internal {
            message: format!(
                "playwright-mcp not found: {} (the agent installer bundles \
                 playwright-mcp under install_dir/playwright/)",
                p.display()
            ),
        });
    }
    Ok(p)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// round-142: reclaim leftovers from the previous generation — a headless
/// chromium left behind by a hard-killed node keeps locking the profile
/// directory, so every later start hits "Browser is already in use".
/// Match precisely on command-line signature (only touches the playwright node
/// and its chromium in this install dir); never reached while a healthy
/// instance exists.
#[cfg(windows)]
async fn reap_leftovers() {
    let script = concat!(
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ",
        "'*\\playwright\\node.exe*' -or $_.CommandLine -like '*ms-playwright-mcp*' } | ",
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    );
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", script]);
    #[cfg(windows)]
    { let _ = no_window(&mut cmd); }
    let _ = cmd.output().await;
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
}

#[cfg(not(windows))]
async fn reap_leftovers() {}

/// round-132: probe whether a healthy playwright-mcp instance is serving on
/// port 9229 — regardless of who started it (scheduled task/panel/manual).
/// In production the ValePlaywright scheduled task hosts the instance in the
/// interactive session and the agent is only a client; status() must honestly
/// report this "externally hosted" form as Running, otherwise the panel always
/// shows Stopped.
async fn probe_healthy() -> bool {
    // round-132 v2: a TCP connection check replaces the HTTP initialize probe —
    // the latter creates a new session on the server per probe, and the chunked
    // read window is easy to misjudge. Port listening = playwright-mcp serving,
    // reliable enough for status display.
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect(("127.0.0.1", MCP_PORT)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

impl PlaywrightManager {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self { inner: Mutex::new(None), bus: std::sync::Mutex::new(None) })
    }

    /// Wire the event bus (called once from AppState::new, after both Arcs
    /// exist). Emits go out on runner start/stop regardless of WHO started
    /// it (panel button, MCP self-heal, AI client).
    pub fn set_bus(&self, bus: std::sync::Arc<dyn vale_agent_core::EventBus>) {
        *self.bus.lock().unwrap() = Some(bus);
    }

    fn notify_changed(&self) {
        if let Some(bus) = self.bus.lock().unwrap().as_ref() {
            bus.emit_term_output(serde_json::json!({ "ev": "playwright-changed" }));
        }
    }

    /// Current state — running/port/started_at, or running:false.
    /// round-128: a dead child (crashed after start) must not report
    /// running/healthy — try_wait detects exit; the record is dropped so
    /// start() can recover.
    pub async fn status(&self) -> serde_json::Value {
        // round-132: the lock scope is strictly limited to an inner block — a std
        // MutexGuard cannot cross an await (otherwise the whole HTTP service
        // future becomes !Send). The external-instance health probe runs
        // outside the lock.
        let (has_live_child, child_exited, started_at) = {
            let mut guard = recover_guard(&self.inner);
            match guard.as_mut() {
                Some(m) => {
                    let started = m.started_at;
                    let exited = m.child.try_wait().ok().flatten().is_some();
                    if exited {
                        let _ = guard.take(); // dead — clear for relaunch
                        (true, true, started)
                    } else {
                        (true, false, started)
                    }
                }
                None => (false, false, 0),
            }
        };
        if !has_live_child || child_exited {
            // round-132: no child spawned by us (or already exited) ≠ service unavailable —
// in production the ValePlaywright scheduled task hosts the instance in the
// interactive session. Probe health before concluding; otherwise the panel
// always shows Stopped.
            if probe_healthy().await {
                return serde_json::json!({
                    "running": true,
                    "port": MCP_PORT,
                    "external": true,
                    "healthy": true,
                });
            }
            if child_exited {
                return serde_json::json!({ "running": false, "error": "child exited" });
            }
            return serde_json::json!({ "running": false });
        }
        serde_json::json!({
            "running": true,
            "port": MCP_PORT,
            "started_at": started_at,
            "healthy": true,
        })
    }

    /// Spawn the bundled playwright-mcp and wait until it answers on
    /// 127.0.0.1:9229 (health poll, up to 10s). On failure the child is
    /// killed and an error is returned — a dead instance is never recorded
    /// as running.
    ///
    /// The Mutex is NEVER held across an await (clippy await_holding_lock):
    /// spawn + health poll run unlocked; the final store re-checks under the
    /// lock so a concurrent start that won the race keeps its child and this
    /// one kills its own — exactly one instance survives.
    pub async fn start(&self) -> Result<serde_json::Value, DeviceError> {
        // round-128: a stored-but-dead child must not block a relaunch —
        // try_wait detects exit; the record is dropped so start proceeds.
        {
            let mut guard = recover_guard(&self.inner);
            if let Some(m) = guard.as_mut() {
                if m.child.try_wait().ok().flatten().is_some() {
                    let _ = guard.take(); // dead — clear for relaunch
                } else {
                    return Ok(serde_json::json!({ "status": "already_running" }));
                }
            }
        }
        // round-132: a healthy instance (scheduled-task/panel-hosted) already owns 9229 —
// reuse it instead of spawning (spawn would fail to bind, the child dies
// instantly, and the panel errors).
        if probe_healthy().await {
            return Ok(serde_json::json!({
                "status": "already_running",
                "external": true,
                "port": MCP_PORT,
            }));
        }

        // round-142: no healthy instance = the previous generation may have left orphans —
// a hard-killed node leaves headless chromium in the background, still locking the
// profile directory ("Browser is already in use"), poisoning every later start
// (measured on d1, 2026-08-25). Reclaim the playwright node + chromium tree first.
        reap_leftovers().await;

        // round-129: @playwright/mcp has no --mcp-token flag (tested: 0.0.79 and
// earlier don't accept it either; the child exits immediately) — the
// per-launch secret plan is a no-go. Anti-squatting changed to:
// 127.0.0.1-only binding (playwright-mcp default) + --allowed-hosts
// 127.0.0.1 (blocks DNS-rebinding remote access). The secret is now only
// displayed as connection info, no longer a security boundary.
        let port = MCP_PORT;
        let node = resolve_node()?;
        let entry = bundled_mcp_entry()?;
        // Build the Command as a single owned expression so we can apply
        // CREATE_NO_WINDOW (round-143) before .spawn() — chained builder
        // methods return &mut Self, so the chain must end on .spawn() (owned
        // Result) unless we break it into a stmt.
        let mut child = tokio::process::Command::new(&node);
        child
            .arg(&entry)
            .arg("--port").arg(port.to_string())
            // round-142: align with the working ValePlaywright scheduled-task command line —
// the agent-hosted path previously lacked --headless; in SYSTEM session 0 a
// headed chromium can't start and the health check inevitably times out
// (always masked by the external instance's already_running short-circuit);
// the duplicate --allowed-hosts arg is gone too.
            .arg("--headless")
            // Edge 151+ crashes on startup under session 0 (SYSTEM service) (exitCode 1002,
// reproducible even with --headless --dump-dom) — switch to Playwright's
// bundled chromium (setup.ps1 Phase 3 / install-browser lands in
// %LOCALAPPDATA%\ms-playwright).
            .arg("--browser").arg("chromium")
            .arg("--host").arg("127.0.0.1")
            // round-131: playwright-mcp's Host comparison is a RAW string including the
// port — on non-default port 9229 you must write "127.0.0.1:9229" (writing
// "127.0.0.1" never matches, all requests 403, start always fails).
// localhost synonym included.
            .arg("--allowed-hosts").arg("127.0.0.1:9229,localhost:9229")
            // The device Web UI uses a self-signed HTTPS certificate — ignore cert
// errors, otherwise navigation always fails with
// net::ERR_CERT_AUTHORITY_INVALID.
            .arg("--ignore-https-errors")
            // round-141 real fix: coreBundle's HTTP heartbeat (pings the client every
// ~3s; at the default 5s timeout it server.close()s → destroys the whole
// browser context) inevitably kills thin clients with no downlink stream —
// that is the root cause of "Session not found ~4s after every call, page
// reset". Setting 0 makes startHeartbeat return immediately; session and
// browser stay resident, snapshot references / panel state survive across
// calls.
            .env("PLAYWRIGHT_MCP_PING_TIMEOUT_MS", "0")
            // stdin PIPED and the handle held in ManagedPlaywright — see
            // the struct comment. Without it the runner cannot survive the
            // service context.
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            // round-163: stderr PIPED, not nulled — the health-failure path
            // reads the last 500 chars into the error message. Nulled stderr
            // made every "did not become healthy" undiagnosable.
            .stderr(Stdio::piped());
        // round-143: CREATE_NO_WINDOW so node.exe doesn't flash a console.
        #[cfg(windows)]
        { let _ = no_window(&mut child); }
        let mut child = child
            .spawn()
            .map_err(|e| DeviceError::Internal { message: format!("spawn playwright-mcp: {e}") })?;
        // Health poll (up to 10s): POST a JSON-RPC initialize to /mcp and verify the
// body is a valid JSON-RPC result. round-129: the old probe.is_ok() passed on
// any HTTP status (GET /mcp is designed to return 4xx) — only an instance
// that truly completes the MCP handshake counts as healthy; a squatter cannot
// answer with a valid JSON-RPC initialize response. The poll also checks
// whether the child exited (port taken → bind failure → instant death). Each
// probe has a 2s timeout.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| DeviceError::Internal { message: format!("http client: {e}") })?;
        let mut ok = false;
        // round-163: 30s of patience, not 10s — right after an update the
        // freshly-extracted node.exe + node_modules get a full Defender pass
        // and the first cold start legitimately exceeds 10s; the old budget
        // made the manager KILL a runner that was about to become healthy
        // (observed d1: stderr said "Listening" while the probe gave up).
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            // Child died (bind failure on an occupied port) — fail fast.
            if child.try_wait().map_err(|e| DeviceError::Internal { message: format!("child wait: {e}") })?.is_some() {
                break;
            }
            let probe = client
                // round-118: 127.0.0.1 rather than localhost — the child's --host 127.0.0.1
                // binds IPv4 only; localhost resolving to [::1] would make the
                // health poll fail forever.
                .post(format!("http://127.0.0.1:{port}/mcp"))
                .header("content-type", "application/json")
                // round-131: MCP transport requires Accept: application/json,
                // text/event-stream — missing it returns 406 and the probe
                // always fails.
                .header("accept", "application/json, text/event-stream")
                .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"vale-agent","version":"1"}}}"#)
                .send()
                .await;
            if let Ok(resp) = probe {
                // Streamable HTTP keeps the response open for server-sent
                // events, so `resp.text().await` waits for EOF and always
                // times out after a successful initialize. Read only the
                // first response chunks; the initialize result is sent at
                // the beginning of the stream.
                let mut stream = resp.bytes_stream();
                let mut body = Vec::new();
                for _ in 0..4 {
                    match tokio::time::timeout(
                        std::time::Duration::from_millis(500),
                        futures::StreamExt::next(&mut stream),
                    )
                    .await
                    {
                        Ok(Some(Ok(chunk))) => {
                            body.extend_from_slice(&chunk);
                            if body.windows(10).any(|w| w == b"serverInfo")
                                && body.windows(8).any(|w| w == b"jsonrpc")
                            {
                                ok = true;
                                break;
                            }
                        }
                        _ => break,
                    }
                }
                if ok {
                    break;
                }
            }
        }
        if !ok {
            let stderr_hint = {
                use tokio::io::AsyncReadExt;
                let mut buf = Vec::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(500),
                        s.read_to_end(&mut buf),
                    ).await;
                }
                String::from_utf8_lossy(&buf).chars().rev().take(500).collect::<String>().chars().rev().collect::<String>()
            };
            let _ = child.kill().await;
            #[cfg(not(windows))]
            let _ = child.wait().await;
            return Err(DeviceError::Internal {
                message: format!(
                    "playwright-mcp did not become healthy on localhost:{port}{}",
                    if stderr_hint.is_empty() { String::new() } else { format!(": {}", stderr_hint) }
                ),
            });
        }
        // Win/lose decided atomically under the lock; the loser's child is
        // taken OUT of the block and killed after the guard is released —
        // no await anywhere in the guard's scope (clippy await_holding_lock).
        let (kill_tx, _kill_rx) = oneshot::channel();
        let mut loser: Option<Child> = None;
        {
            let mut guard = recover_guard(&self.inner);
            if guard.is_some() {
                // A concurrent start landed while we polled — lose cleanly.
                loser = Some(child);
            } else {
                *guard = Some(ManagedPlaywright { _stdin: child.stdin.take(), child, secret: String::new(), started_at: now_ms(), _kill_tx: kill_tx });
            }
        }
        if let Some(mut child) = loser {
            let _ = child.kill().await;
            #[cfg(not(windows))]
            let _ = child.wait().await; // reap (round-129: loser path was missing this)
            return Ok(serde_json::json!({ "status": "already_running" }));
        }
        self.notify_changed();
        Ok(serde_json::json!({ "status": "started", "port": port }))
    }

    /// Kill the running instance: taskkill /T kills the whole tree on
    /// Windows (node forks Edge — killing only the parent would orphan it);
    /// plain kill on unix (dev). The instance is taken under the lock and
    /// killed WITHOUT holding it (clippy await_holding_lock).
    pub async fn stop(&self) -> Result<serde_json::Value, DeviceError> {
        let m = recover_guard(&self.inner).take();
        if let Some(m) = m {
            #[cfg(windows)]
            {
                let mut cmd = tokio::process::Command::new("taskkill");
                cmd.args(["/T", "/F", "/PID", &m.child.id().unwrap_or(0).to_string()]);
                let _ = no_window(&mut cmd);
                let _ = cmd.output().await;
            }
            #[cfg(not(windows))]
            {
                // SIGKILL needs &mut Child; the Windows branch above only
                // reads id(), so `mut` lives here, not on the binding.
                let mut m = m;
                let _ = m.child.kill().await;
                let _ = m.child.wait().await; // reap (round-128: zombie-free)
            }
        }
        self.notify_changed();
        Ok(serde_json::json!({ "status": "stopped" }))
    }
}
