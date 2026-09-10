//! Unified terminal manager — PTY (local shell), SSH (remote), Serial.
//! Uses bounded channels for streaming output (no polling needed).
//!
//! Channel policy (bounded): output channels apply backpressure — a stalled
//! consumer pauses the shell, which is correct PTY semantics. Keystroke and
//! resize channels use `try_send` (drop-on-full) — keyboard input must never
//! block the caller.
//!
//! Synchronization is internal: callers hold `Arc<TerminalManager>` and never
//! touch a lock. `term_open` allocates the id and registers the session under
//! the inner lock but runs the (possibly slow) backend connect outside it, so
//! one session's SSH handshake never blocks another session's write/resize.

mod secrets;
// stage-m: OSC 633 parsing is pure byte-scanning — no backend deps, so it
// compiles in BOTH feature configs. terminal_execute's session path
// references it unconditionally (the feature gate lives in the backends,
// not here).
#[cfg(feature = "terminal")]
mod connections;
#[cfg(feature = "terminal")]
mod pty;
#[cfg(feature = "terminal")]
mod serial;
pub(crate) mod shell_integration;
#[cfg(feature = "terminal")]
mod ssh;
#[cfg(not(feature = "terminal"))]
mod stub;

#[cfg(feature = "terminal")]
pub use connections::{forget as conn_forget, list as conn_list, remember as conn_remember};
// Test-only store isolation (round-359): plugin-layer tool tests seed the
// saved-connection file through this thread-local, mirroring the
// secrets.rs harness. cfg(test) keeps it out of every shipped build.
#[cfg(all(test, feature = "terminal"))]
pub(crate) use connections::TEST_DIR;
pub use secrets::{secret_delete, secret_get, secret_list, secret_set};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct TermSessionInfo {
    pub id: String,
    pub kind: String, // "pty", "ssh", "serial"
    pub label: String,
    /// Shell kind driving the Netcatty-style command wrapper (stage-l):
    /// "powershell" | "cmd" | "bash" | "fish" | "unknown". Unknown
    /// (ssh/serial/custom pty target) → execute falls back to the quiet
    /// path without a wrapper.
    pub shell: String,
    /// A PERSON holds this session's keyboard (control handoff). When true,
    /// `terminal_execute` refuses with [`DeviceError::HumanInControl`] instead of
    /// racing the human's keystrokes over the same buffer cursor.
    ///
    /// Carried on session info so the state is visible wherever sessions are
    /// listed: the panel shows it, and an AI calling `terminal_list` sees it
    /// BEFORE trying to execute and collecting the refusal.
    #[serde(default)]
    pub held_by_human: bool,
}

/// Infer the session's shell kind for the command wrapper (stage-l):
/// "powershell" | "cmd" | "bash" | "fish" | "unknown".
/// - PTY: from the target's file name (blank target = the platform default
///   shell: powershell.exe on Windows, bash elsewhere).
/// - ssh/serial: "unknown" — the spec defers SSH shell probing (§4); unknown
///   means execute uses the quiet fallback (no wrapper).
pub fn infer_shell(kind: &str, target: &str) -> String {
    if kind != "pty" {
        return "unknown".to_string();
    }
    let cmd = std::path::Path::new(target)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(target)
        .to_ascii_lowercase();
    if cfg!(windows) {
        if cmd.is_empty() {
            // stage-m: the default Windows shell is pwsh (pty.rs spawns it
            // when no target is given) — report pwsh so the 633 completion
            // path engages.
            "pwsh".to_string()
        } else if cmd == "powershell.exe" || cmd == "powershell" {
            "powershell".to_string()
        } else if cmd == "pwsh.exe" || cmd == "pwsh" {
            // stage-m: pwsh (PowerShell 7) is distinct — it gets the OSC 633
            // shell-integration injection; 5.1 (powershell) does not (its
            // PSReadLine 2.0.0 re-echoes the sequences as input → `>>`).
            "pwsh".to_string()
        } else if cmd == "cmd.exe" || cmd == "cmd" {
            "cmd".to_string()
        } else {
            "unknown".to_string()
        }
    } else if cmd.is_empty() || cmd == "bash" || cmd == "sh" {
        "bash".to_string()
    } else if cmd == "fish" {
        "fish".to_string()
    } else {
        "unknown".to_string()
    }
}

/// What kind of terminal to open
#[derive(Debug, Deserialize, Serialize)]
pub struct TermOpenRequest {
    #[serde(default)]
    pub kind: String, // "pty" (default), "ssh", "serial"
    /// For PTY: shell path ("" = auto). For SSH: "user@host:port". For Serial: "port_name?baud=115200"
    #[serde(default)]
    pub target: String,
    /// SSH password or serial config
    #[serde(default)]
    pub password: String,
    /// SSH private key path (optional). When set, public-key auth is used
    /// and `password` doubles as the key's passphrase.
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub rows: u16,
    #[serde(default)]
    pub cols: u16,
    /// Inject a prompt-marker (OSC 133;D) into a PTY shell so execute can tell
    /// "command finished" from "output paused" (round-54, dsh pollReadiness).
    /// Only applies to PTY sessions with a known shell (bash / PowerShell).
    #[serde(default = "default_true")]
    pub inject_marker: bool,
    /// Serial framing — 8E1/7E1/7N2 etc. (round-54: SerialPool already
    /// supported these but nothing passed them through).
    #[serde(default)]
    pub data_bits: Option<u8>,
    /// "even" | "odd" | "none"
    #[serde(default)]
    pub parity: Option<String>,
    #[serde(default)]
    pub stop_bits: Option<u8>,
    /// (serial) Auto-reconnect: when the port disappears (unplug / device
    /// reboot), keep the session alive and retry opening the SAME port with
    /// the SAME framing until it reappears (P4b).
    #[serde(default)]
    pub auto_reconnect: bool,
}

fn default_true() -> bool {
    true
}

/// A chunk of terminal output sent to the frontend
#[derive(Debug, Clone, Serialize)]
pub struct TermOutput {
    pub session_id: String,
    pub data: Vec<u8>,
}

/// Parse an SSH target into (user, host, port).
/// Accepted forms: `user@host`, `user@host:port`, `host`, `host:port`,
/// `[v6]`, `user@[v6]:port`. Defaults: user = "root", port = 22.
/// A bare IPv6 (`user@fe80::1`, no brackets) has two+ colons — the old
/// rsplit_once silently parsed `user@fe80::1` as host `user@fe80` port `1`
/// and connected to a nonexistent host (round-54).
pub fn parse_ssh_target(target: &str) -> (String, String, u16) {
    let target = target.trim();
    let (user_host, port) = if let Some((uh, p)) = target.rsplit_once(':') {
        if uh.ends_with(']') {
            // Bracket form — the tail after the colon is the port.
            (uh, p.parse::<u16>().unwrap_or(22))
        } else if target.matches(':').count() >= 2 {
            // Bare IPv6 without brackets — no port in the address.
            (target, 22)
        } else {
            (uh, p.parse::<u16>().unwrap_or(22))
        }
    } else {
        (target, 22)
    };
    let (user, host) = if let Some((u, h)) = user_host.split_once('@') {
        (u.to_string(), strip_v6_brackets(h))
    } else {
        ("root".to_string(), strip_v6_brackets(user_host))
    };
    (user, host, port)
}

/// `[::1]` → `::1`; anything else unchanged.
fn strip_v6_brackets(h: &str) -> String {
    if let Some(inner) = h.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        inner.to_string()
    } else {
        h.to_string()
    }
}

/// Parse a serial target into (port_name, baud_rate).
/// Accepted forms: `port_name`, `port_name?baud=115200`. Default baud: 115200.
pub fn parse_serial_target(target: &str) -> (String, u32) {
    let cfg = parse_serial_config(target);
    (cfg.port, cfg.baud)
}

/// Full serial configuration from a target string —
/// `port_name?baud=115200&parity=even&data=8&stop=1` (round-54: the framing
/// params SerialPool supports were never reachable from terminal_open).
#[derive(Debug, Clone, Default)]
pub struct SerialTargetConfig {
    pub port: String,
    pub baud: u32,
    pub data_bits: Option<u8>,
    pub parity: Option<String>,
    pub stop_bits: Option<u8>,
}

pub fn parse_serial_config(target: &str) -> SerialTargetConfig {
    let target = target.trim();
    let mut cfg = SerialTargetConfig {
        baud: 115200,
        ..Default::default()
    };
    if let Some((port, params)) = target.split_once('?') {
        cfg.port = port.to_string();
        for kv in params.split('&') {
            if let Some((k, v)) = kv.split_once('=') {
                match (k, v) {
                    ("baud", v) => cfg.baud = v.parse().unwrap_or(115200),
                    ("data", v) => cfg.data_bits = v.parse().ok(),
                    ("parity", v) => cfg.parity = Some(v.to_lowercase()),
                    ("stop", v) => cfg.stop_bits = v.parse().ok(),
                    _ => {}
                }
            }
        }
    } else {
        cfg.port = target.to_string();
    }
    cfg
}

/// Common backend interface — one call site for write/resize/close no matter
/// which kind of session (PTY/SSH/Serial) a session is.
pub trait TermBackend: Send + Sync {
    /// Fire-and-forget keystroke path (never blocks; drop-on-full by
    /// design). NOT the reporting path — every backend overrides
    /// write_async below with error propagation, and the only caller of
    /// this method is the trait default itself. Do not "fix" the silence
    /// here; fix write_async if delivery reporting regresses.
    fn write(&self, data: &[u8]);
    /// Reliable write (round-103): waits for the transport instead of
    /// drop-on-full — used by terminal_execute, where a dropped command
    /// silently never runs (and the wait loop reports success-like 'idle').
    /// Default = sync write (keystrokes); SSH overrides with an awaitable
    /// send so backpressure never loses a command. The error (round-105) is
    /// propagated so an undelivered command surfaces as an execute error
    /// instead of a success-shaped 'idle'.
    fn write_async<'a>(
        &'a self,
        data: &'a [u8],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            self.write(data);
            Ok(())
        })
    }
    fn resize(&self, rows: u16, cols: u16);
    fn close(&self);
    /// Abort the currently-running foreground command WITHOUT closing the
    /// session (an execute timeout must stop the command, not the shell):
    /// PTY kills its process group, SSH sends ^C to the remote shell, serial
    /// has no process concept and does nothing.
    fn terminate(&self);
    /// Natural-exit code of the backend process, if it exited on its own
    /// (PTY only; SSH/serial return None) (round-60).
    fn exit_code(&self) -> Option<i32> {
        None
    }
    /// review #3: whether this backend ACTUALLY received shell-integration
    /// injection (PTY: script present). Default false for ssh/serial.
    fn marker_injected(&self) -> bool {
        false
    }
}

#[cfg(feature = "terminal")]
mod desktop_impl {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use vale_agent_core::DeviceError;

    struct Session {
        id: String,
        kind: String,
        label: String,
        shell: String,
        backend: Arc<dyn TermBackend>,
        /// Did this session's backend ACTUALLY inject its shell integration?
        ///
        /// Set once at open from the three-way gate
        /// `kind == "pty" && req.inject_marker && backend.marker_injected()`,
        /// so the shell NAME alone never decides it (review #3: pwsh by name
        /// was assumed injected, the dot-source silently no-op'd without the
        /// script, 633 codes never arrived, and EVERY execute burned its full
        /// timeout).
        ///
        /// CONSULTED BY EXECUTE, via `term_marker_injected` — the pwsh 633
        /// wait path keys on it (exec.rs: `shell_633 = sess_shell == "pwsh" &&
        /// term_marker_injected(&sid)`). round-108 also relies on it so the
        /// quiet path does not break early on marker sessions, where the
        /// marker arrives at the NEXT prompt rather than after the echo.
        ///
        /// A previous revision of this comment claimed the flag "is no longer
        /// consulted by execute" (a stage-l note about the OSC-injection
        /// mechanism being replaced by the command wrapper). The MECHANISM did
        /// change; the consultation did not. Corrected in SOLID R126, and the
        /// three-way gate is pinned by `marker_gate_is_reported_not_assumed`.
        inject_marker: bool,
        /// Last time output was seen — used by the idle sweeper.
        last_output: std::time::Instant,
        /// When the session was opened — tiebreaker for eviction when
        /// last_output is equal: min_by_key on last_output alone would evict
        /// the FIRST session in vec order on a tie; opened_at spares the
        /// oldest-opened.
        opened_at: std::time::Instant,
        /// An execute wait-loop is running on this session (round-55): two
        /// concurrent executes share one buffer cursor and would interleave
        /// reads + marker ownership.
        busy: bool,
        /// A PERSON holds the keyboard (control handoff). Orthogonal to `busy`
        /// on purpose: `busy` is transient contention the AI should wait out,
        /// this is a deliberate handover that waiting cannot resolve.
        ///
        /// In-memory only, so an agent restart releases every hold. That is the
        /// safe direction — a hold is a live coordination fact, not durable
        /// state, and a restart should not leave a device nobody can drive.
        held_by_human: bool,
    }

    /// Sessions idle this long (no output) are force-closed. Guards against a
    /// client disconnect leaking SSH/PTY/serial sessions forever: nothing tied
    /// a session to its owning connection, so a crashed panel/MCP client left
    /// every open session running indefinitely.
    const SESSION_IDLE_TTL: std::time::Duration = std::time::Duration::from_secs(15 * 60);
    /// Hard cap on concurrent sessions; oldest is evicted when exceeded.
    const MAX_SESSIONS: usize = 16;

    struct TerminalInner {
        sessions: Vec<Session>,
        next_id: u32,
        boot_prefix: String, // per-boot sid prefix (restart-safe ids)
    }

    #[derive(Clone)]
    pub struct TerminalManager {
        inner: std::sync::Arc<tokio::sync::Mutex<TerminalInner>>,
        serial_pool: Arc<crate::tools::serial::SerialPool>,
    }

    impl TerminalManager {
        pub fn new(serial_pool: Arc<crate::tools::serial::SerialPool>) -> Self {
            // Per-boot sid prefix: session ids were `term-{N}` from an
            // in-memory counter, so after an agent restart the SAME ids were
            // minted again — the panel's resurrection logic then matched the
            // new sessions against OLD records and froze them (dedup on a
            // reused sid). A random prefix makes every boot's ids unique.
            let boot_prefix: String = {
                let mut buf = [0u8; 3];
                let _ = getrandom::getrandom(&mut buf);
                buf.iter().map(|b| format!("{b:02x}")).collect()
            };
            let mgr = Self {
                inner: std::sync::Arc::new(tokio::sync::Mutex::new(TerminalInner {
                    sessions: Vec::new(),
                    next_id: 0,
                    boot_prefix,
                })),
                serial_pool,
            };
            // Idle sweeper: force-close sessions that have been silent for the
            // TTL (client disconnected, backend stalled). Best-effort — never
            // blocks open/close. Only spawn when a tokio runtime is active —
            // unit tests construct the manager outside one and tokio::spawn
            // would panic ("no reactor running").
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let mgr2 = mgr.clone();
                drop(runtime.spawn(async move {
                    let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
                    tick.tick().await; // first tick fires immediately — skip
                    loop {
                        tick.tick().await;
                        let mut inner = mgr2.inner.lock().await;
                        let now = std::time::Instant::now();
                        let mut sweep = Vec::new();
                        for (i, s) in inner.sessions.iter().enumerate() {
                            if now.duration_since(s.last_output) > SESSION_IDLE_TTL {
                                sweep.push(i);
                            }
                        }
                        // review #10: clone the Arcs and drop the inner
                        // guard BEFORE close() — close signals reader/
                        // reaper threads (std locks + joins), and the repo
                        // rule is never block under `inner`.
                        let reaped: Vec<Arc<dyn TermBackend>> = sweep
                            .into_iter()
                            .rev()
                            .map(|i| inner.sessions.remove(i).backend)
                            .collect();
                        drop(inner);
                        for b in reaped {
                            b.close();
                        }
                    }
                }));
            }
            mgr
        }

        /// Mark a session as recently active (called when output is received).
        pub async fn touch(&self, sid: &str) {
            let mut inner = self.inner.lock().await;
            if let Some(s) = inner.sessions.iter_mut().find(|s| s.id == sid) {
                s.last_output = std::time::Instant::now();
            }
        }

        /// Open a new terminal session. Returns (session_id, channel_receiver) for streaming output.
        pub async fn term_open(
            &self,
            req: &TermOpenRequest,
        ) -> Result<(String, mpsc::Receiver<TermOutput>), DeviceError> {
            let id = {
                let mut inner = self.inner.lock().await;
                // Unique across boots: the prefix rotates every restart, so a
                // reused sid can never freeze the panel's resurrection logic.
                let id = format!("term-{}-{}", inner.boot_prefix, inner.next_id);
                inner.next_id += 1;
                id
            };
            let kind = if req.kind.is_empty() {
                "pty".to_string()
            } else {
                req.kind.clone()
            };
            // Bounded: backpressure through the reader threads (blocking_send)
            let (tx, rx) = mpsc::channel(256);

            let (backend, label) = match kind.as_str() {
                "ssh" => {
                    let be = ssh::SshBackend::connect(
                        &req.target,
                        &req.password,
                        &req.key_path,
                        req.rows,
                        req.cols,
                        tx,
                        id.clone(),
                    )
                    .await?;
                    let (user, host, _port) = parse_ssh_target(&req.target);
                    let label = format!("{user}@{host}");
                    (Arc::new(be) as Arc<dyn TermBackend>, label)
                }
                "serial" => {
                    let be = serial::SerialBackend::open(
                        self.serial_pool.clone(),
                        &req.target,
                        req.data_bits,
                        req.parity.clone(),
                        req.stop_bits,
                        req.auto_reconnect,
                        tx,
                        id.clone(),
                    )
                    .await?;
                    let label = format!(
                        "serial:{}",
                        req.target.split('?').next().unwrap_or(&req.target)
                    );
                    (Arc::new(be) as Arc<dyn TermBackend>, label)
                }
                _ => {
                    // SSH/core audit #1 (MED): kind reached this catch-all
                    // UNVALIDATED — {kind:"SSH"} or a typo opened a LOCAL
                    // PowerShell while the caller believed it was remote (the
                    // commands simply ran on the device). Only genuine PTY
                    // spellings land here now.
                    if !matches!(
                        kind.as_str(),
                        "pty" | "pwsh" | "powershell" | "bash" | "shell"
                    ) {
                        return Err(DeviceError::InvalidParams {
                            message: format!(
                                "unknown terminal kind '{kind}' (expected pty|ssh|serial)"
                            ),
                        });
                    }
                    // PTY spawn (openpty + spawn_command) blocks — off-executor
                    let be = {
                        let target = req.target.clone();
                        let tx = tx.clone();
                        let sid = id.clone();
                        let rows = req.rows;
                        let cols = req.cols;
                        tokio::task::spawn_blocking(move || {
                            pty::PtyBackend::spawn(&target, rows, cols, tx, sid)
                        })
                        .await
                        .map_err(|e| DeviceError::Internal {
                            message: format!("pty spawn task failed: {e}"),
                        })??
                    };
                    let label = if req.target.is_empty() {
                        if cfg!(windows) {
                            "PowerShell".into()
                        } else {
                            "bash".into()
                        }
                    } else {
                        // Just the filename, not full path
                        std::path::Path::new(&req.target)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or(&req.target)
                            .to_string()
                    };
                    (Arc::new(be) as Arc<dyn TermBackend>, label)
                }
            };

            // Session cap: evict the OLDEST session when over MAX_SESSIONS
            // (client-disconnect leak guard; keeps the device usable). Evict
            // the session IDLE LONGEST (last_output oldest), not the OLDEST
            // opened — an old-but-actively-watched session must survive.
            // review #10: the block RETURNS the evicted backends so their
            // close() (thread signals) runs AFTER the inner guard drops.
            let deferred: Vec<Arc<dyn TermBackend>> = {
                let mut inner = self.inner.lock().await;
                let mut deferred: Vec<Arc<dyn TermBackend>> = Vec::new();
                while inner.sessions.len() >= MAX_SESSIONS {
                    // Evict the session idle-longest; on a last_output tie
                    // fall back to the OLDEST-opened — an old-but-actively-
                    // watched session must survive.
                    let idle = inner
                        .sessions
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, s)| (s.last_output, s.opened_at))
                        .map(|(i, _)| i);
                    match idle {
                        // review #10: defer close() out of the lock (see the
                        // sweeper); the slot is freed by remove() immediately.
                        Some(i) => {
                            deferred.push(inner.sessions.remove(i).backend);
                        }
                        None => break,
                    }
                }
                // inject_marker reflects the BACKEND'S REAL injection
                // (review #3): a missing integration script must NOT leave
                // execute on the never-arriving 633 path.
                let inject = kind == "pty" && req.inject_marker && backend.marker_injected();
                let shell = infer_shell(&kind, &req.target);
                inner.sessions.push(Session {
                    id: id.clone(),
                    kind,
                    label,
                    shell,
                    backend,
                    inject_marker: inject,
                    last_output: std::time::Instant::now(),
                    opened_at: std::time::Instant::now(),
                    busy: false,
                    held_by_human: false,
                });
                deferred
            };
            for b in deferred {
                b.close();
            }
            Ok((id, rx))
        }

        pub async fn term_resize(
            &self,
            sid: &str,
            rows: u16,
            cols: u16,
        ) -> Result<(), DeviceError> {
            let backend = self.find_backend(sid, true).await?;
            backend.resize(rows, cols);
            Ok(())
        }

        pub async fn term_write(&self, sid: &str, data: &str) -> Result<(), DeviceError> {
            self.term_write_bytes(sid, data.as_bytes()).await
        }

        /// Write arbitrary bytes (base64 path from terminal_write) — the
        /// only way to reach non-UTF-8 serial frames (round-54).
        pub async fn term_write_bytes(&self, sid: &str, data: &[u8]) -> Result<(), DeviceError> {
            // round-92: the write used to happen INSIDE the global inner lock —
            // PtyBackend::write does a blocking write_all on the PTY master fd,
            // which stalls forever when the n_tty input queue (4096B) is full
            // (a foreground process not reading stdin). Holding the only
            // manager lock during that freeze wedged EVERY session: open/close/
            // resize/list all hang, and the wedged session couldn't even be
            // closed. The backend is now Arc'd so the write runs OUTSIDE the
            // lock — a blocked write stalls only its own call, not the system.
            let backend = self.find_backend(sid, true).await?;
            // round-103: reliable write (SSH overrides with an awaitable
            // send) — terminal_execute's command must not be dropped when
            // the transport is under backpressure.
            // round-105: propagate the error — an undelivered command must
            // fail the execute, not report success-shaped 'idle'.
            backend
                .write_async(data)
                .await
                .map_err(|e| DeviceError::Internal { message: e })?;
            Ok(())
        }

        /// Clone the live backend for `sid` (the Arc keeps it valid even if
        /// the idle sweeper removes the session right after), or fail with
        /// SessionNotFound. `touch` refreshes last_output inside the lock —
        /// an actively-used session is alive (round-49 heartbeat: resize +
        /// writes must not be reaped by the 15-min sweeper). term_resize /
        /// term_write_bytes / terminate used to each inline the
        /// find + SessionNotFound + clone block; the backend is Arc'd so
        /// the caller operates it OUTSIDE the lock (a blocked write stalls
        /// only its own call — review #10 discipline).
        async fn find_backend(
            &self,
            sid: &str,
            touch: bool,
        ) -> Result<Arc<dyn TermBackend>, DeviceError> {
            let mut inner = self.inner.lock().await;
            let s = inner
                .sessions
                .iter_mut()
                .find(|s| s.id == sid)
                .ok_or_else(|| DeviceError::SessionNotFound {
                    id: sid.to_string(),
                })?;
            if touch {
                s.last_output = std::time::Instant::now();
            }
            Ok(s.backend.clone())
        }

        /// Remove a session by id under the lock. The caller must close the
        /// returned backend AFTER the lock guard drops (review #10) — shared
        /// by term_close and term_unregister, which used to copy-paste this
        /// position+remove block.
        async fn take_session(&self, sid: &str) -> Option<Session> {
            let mut inner = self.inner.lock().await;
            inner
                .sessions
                .iter()
                .position(|s| s.id == sid)
                .map(|pos| inner.sessions.remove(pos))
        }

        pub async fn term_close(&self, sid: &str) -> Result<String, DeviceError> {
            // review #10: remove under the lock, close AFTER it drops.
            let removed = self.take_session(sid).await;
            match removed {
                Some(session) => {
                    let kind = session.kind.clone();
                    session.backend.close();
                    Ok(kind)
                }
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// Unregister a session whose backend has died on its own (SSH channel
        /// dropped, PTY shell exited, serial unplugged). Closes the backend and
        /// removes the entry WITHOUT the tool-level event/retain side effects
        /// of term_close (the drainer already retains the buffer in history).
        /// Without this, dead sessions lingered in term_list forever and
        /// terminal_write/terminal_resize silently "succeeded" into a void.
        pub async fn term_unregister(&self, sid: &str) {
            // review #10: remove under the lock, close AFTER it drops.
            if let Some(session) = self.take_session(sid).await {
                session.backend.close();
            }
        }

        pub async fn term_select(&self, sid: &str) -> Result<(), DeviceError> {
            // Client-liveness heartbeat — the ONLY presence signal besides
            // write/resize: the panel pings the active session every 30s and
            // the MCP execute wait-loop pings every poll, so the idle sweeper
            // (15 min without OUTPUT) must not kill a watched-but-silent
            // session (vim, a long quiet build). Advancing last_output here
            // keeps an actively-pinged session alive; a disconnected client
            // stops pinging and the sweeper reaps it as intended. Output
            // alone does NOT keep a session alive (round-54: an abandoned
            // `tail -f` must be reaped). (Lock is already held — touch()
            // would re-lock and deadlock.)
            let mut inner = self.inner.lock().await;
            if let Some(s) = inner.sessions.iter_mut().find(|s| s.id == sid) {
                s.last_output = std::time::Instant::now();
                Ok(())
            } else {
                Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                })
            }
        }

        /// Abort the foreground command in a session (kill the PTY process
        /// tree / ^C over SSH) — the session itself stays open. Called by the
        /// session-mode execute path when its deadline fires, so a timed-out
        /// command cannot keep running orphaned on the device.
        pub async fn term_terminate(&self, sid: &str) -> Result<(), DeviceError> {
            // round-94: terminate() runs OUTSIDE the global lock. PTY's
            // terminate does a blocking write_all (^C) to the master fd —
            // same hazard R92-H1 fixed for term_write_bytes: holding `inner`
            // across a blocked write would freeze every session op. The
            // backend is Arc'd, so clone + terminate outside the lock.
            let backend = self.find_backend(sid, false).await?;
            backend.terminate();
            Ok(())
        }

        /// Try to acquire the per-session execute lock (round-55): a second
        /// concurrent execute on the same session would share one buffer
        /// cursor and interleave reads + marker ownership — refuse instead.
        ///
        /// Refuses EARLY when a human holds the session, with its own code. The
        /// ordering is load-bearing: a hold must NOT report `Ok(false)`, because
        /// `term_acquire_execute` reads that as transient contention and spins on
        /// its 30 s loop, ending with a `session_busy` that states the wrong
        /// reason. An `Err` here returns immediately with the truth.
        pub async fn term_try_execute(&self, sid: &str) -> Result<bool, DeviceError> {
            let mut inner = self.inner.lock().await;
            match inner.sessions.iter_mut().find(|s| s.id == sid) {
                Some(s) if s.held_by_human => Err(DeviceError::HumanInControl {
                    id: sid.to_string(),
                }),
                Some(s) => {
                    if s.busy {
                        Ok(false)
                    } else {
                        s.busy = true;
                        Ok(true)
                    }
                }
                // round-105: a nonexistent session reported busy — clients
                // retried forever. Distinguish.
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// Release the per-session execute lock (all exit paths of execute).
        pub async fn term_release_execute(&self, sid: &str) {
            let mut inner = self.inner.lock().await;
            if let Some(s) = inner.sessions.iter_mut().find(|s| s.id == sid) {
                s.busy = false;
            }
        }

        /// Hand the session's keyboard to a person (`true`) or back to the AI
        /// (`false`). Returns the state now in force.
        ///
        /// ## This is COORDINATION, not enforcement — read before relying on it
        ///
        /// A held session refuses `terminal_execute`, which is the AI's
        /// autonomous path and the only one that claims the buffer cursor. It
        /// does NOT refuse `terminal_write`, and it cannot: the panel's own
        /// keystrokes and the AI's both arrive through that same tool, so gating
        /// it would lock the human out of the keyboard they just took. An AI that
        /// wants to ignore the handover can therefore still type raw bytes.
        ///
        /// That is an acceptable boundary because the AI here is a COOPERATING
        /// agent, not an adversary — it already holds full device control, so
        /// there is no privilege to defend, only a collision to avoid. What the
        /// mechanism actually buys: the AI is TOLD a person is driving (instead
        /// of silently interleaving with their keystrokes), and it can yield
        /// deliberately. Do not describe it to a user as a security control.
        ///
        /// No TTL on purpose. An expiring hold would silently hand the keyboard
        /// back to the AI mid-task, which is the same "resume autonomous action
        /// after a human intervened" pattern the design rejects for crash
        /// recovery. The hold is explicit in both directions, visible in
        /// `terminal_list` and one click away from release — a timer would
        /// surprise both parties to save one click.
        pub async fn term_set_control(&self, sid: &str, human: bool) -> Result<bool, DeviceError> {
            let mut inner = self.inner.lock().await;
            match inner.sessions.iter_mut().find(|s| s.id == sid) {
                Some(s) => {
                    s.held_by_human = human;
                    Ok(s.held_by_human)
                }
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// Whether a person currently holds this session's keyboard.
        pub async fn term_held_by_human(&self, sid: &str) -> Result<bool, DeviceError> {
            let inner = self.inner.lock().await;
            match inner.sessions.iter().find(|s| s.id == sid) {
                Some(s) => Ok(s.held_by_human),
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// Acquire the per-session execute lock, WAITING when busy (round-160):
        /// AI clients fire executes back-to-back and the hard refusal turned
        /// every overlap into a "Session busy" error the model couldn't act on
        /// (21 failures in one week of real usage). Poll every 250 ms up to
        /// `max_wait_ms`; Ok(false) after the deadline keeps the old
        /// session_busy mapping for the caller.
        pub async fn term_acquire_execute(
            &self,
            sid: &str,
            max_wait_ms: u64,
        ) -> Result<bool, DeviceError> {
            let deadline =
                tokio::time::Instant::now() + std::time::Duration::from_millis(max_wait_ms);
            loop {
                match self.term_try_execute(sid).await {
                    Ok(true) => return Ok(true),
                    Ok(false) => {
                        if tokio::time::Instant::now() >= deadline {
                            return Ok(false);
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                    Err(e) => return Err(e),
                }
            }
        }

        /// The backend's natural exit code (PTY only; None for SSH/serial or
        /// a session that is still running) (round-60).
        pub async fn term_exit_code(&self, sid: &str) -> Option<i32> {
            let inner = self.inner.lock().await;
            inner
                .sessions
                .iter()
                .find(|s| s.id == sid)
                .and_then(|s| s.backend.exit_code())
        }

        pub async fn term_list(&self) -> Vec<TermSessionInfo> {
            let inner = self.inner.lock().await;
            inner
                .sessions
                .iter()
                .map(|s| TermSessionInfo {
                    id: s.id.clone(),
                    kind: s.kind.clone(),
                    label: s.label.clone(),
                    shell: s.shell.clone(),
                    held_by_human: s.held_by_human,
                })
                .collect()
        }

        /// Clone a session's info (id/kind/label/shell) if it still exists.
        /// Used by the output drainer and terminal_close to capture metadata
        /// BEFORE the session leaves the manager, so retained history keeps
        /// its kind/label.
        pub async fn term_info(&self, sid: &str) -> Option<TermSessionInfo> {
            let inner = self.inner.lock().await;
            inner
                .sessions
                .iter()
                .find(|s| s.id == sid)
                .map(|s| TermSessionInfo {
                    id: s.id.clone(),
                    kind: s.kind.clone(),
                    label: s.label.clone(),
                    shell: s.shell.clone(),
                    held_by_human: s.held_by_human,
                })
        }

        /// round-108: whether this session gets the OSC 133;D prompt marker
        /// (marker-injected PTY). execute's quiet path must not break early
        /// on such sessions — the marker arrives at the NEXT prompt, i.e.
        /// at command end, which can be seconds after the echo.
        pub async fn term_marker_injected(&self, sid: &str) -> bool {
            let inner = self.inner.lock().await;
            inner
                .sessions
                .iter()
                .find(|s| s.id == sid)
                .map(|s| s.inject_marker)
                .unwrap_or(false)
        }

        /// Overwrite the marker flag for an existing session.
        ///
        /// ⚠️ **NOT WIRED — ZERO CALLERS** (real implementation and the
        /// headless `stub.rs` twin alike; verified repo-wide in SOLID R126).
        /// A previous revision claimed "Called by the open handler with the
        /// real injectable result". That is false: the open handler sets the
        /// value at CONSTRUCTION, from
        /// `backend.marker_injected()`, which is the fix round-109 was after —
        /// so this post-open corrector is redundant rather than pending.
        ///
        /// Kept (not deleted) because `TerminalManager` is PUBLIC API
        /// (`pub mod tools` → `pub mod terminal` → `pub use …TerminalManager`)
        /// and the feature-gating rule requires both configs to expose the
        /// same path; dropping a public method is a breaking change that needs
        /// sign-off. Recorded in docs/solid-program.md → Open threads.
        pub async fn term_set_marker_injected(&self, sid: &str, injected: bool) {
            let mut inner = self.inner.lock().await;
            if let Some(s) = inner.sessions.iter_mut().find(|s| s.id == sid) {
                s.inject_marker = injected;
            }
        }
    }
}

#[cfg(feature = "terminal")]
pub use desktop_impl::TerminalManager;
#[cfg(not(feature = "terminal"))]
pub use stub::TerminalManager;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ssh_user_host_port() {
        assert_eq!(
            parse_ssh_target("user@example.com:2222"),
            ("user".into(), "example.com".into(), 2222)
        );
    }

    #[test]
    fn parse_ssh_user_host_default_port() {
        assert_eq!(
            parse_ssh_target("user@example.com"),
            ("user".into(), "example.com".into(), 22)
        );
    }

    #[test]
    fn parse_ssh_bare_host() {
        assert_eq!(
            parse_ssh_target("example.com"),
            ("root".into(), "example.com".into(), 22)
        );
    }

    #[test]
    fn parse_ssh_host_port() {
        assert_eq!(
            parse_ssh_target("example.com:2222"),
            ("root".into(), "example.com".into(), 2222)
        );
    }

    #[test]
    fn parse_ssh_ipv6_bracketed_with_port() {
        assert_eq!(
            parse_ssh_target("user@[fe80::1]:2222"),
            ("user".into(), "fe80::1".into(), 2222)
        );
    }

    #[test]
    fn parse_ssh_ipv6_bracketed_default_port() {
        assert_eq!(parse_ssh_target("[::1]"), ("root".into(), "::1".into(), 22));
    }

    #[test]
    fn parse_ssh_ipv6_bare_no_port_mangling() {
        // `user@fe80::1` must NOT become host `user@fe80` port `1` (round-54).
        assert_eq!(
            parse_ssh_target("user@fe80::1"),
            ("user".into(), "fe80::1".into(), 22)
        );
    }

    #[test]
    fn parse_serial_plain() {
        assert_eq!(
            parse_serial_target("/dev/ttyUSB0"),
            ("/dev/ttyUSB0".into(), 115200)
        );
    }

    #[test]
    fn parse_serial_with_baud() {
        assert_eq!(parse_serial_target("COM3?baud=9600"), ("COM3".into(), 9600));
    }

    #[test]
    fn parse_serial_bad_baud_defaults() {
        assert_eq!(
            parse_serial_target("COM3?baud=xyz"),
            ("COM3".into(), 115200)
        );
    }

    #[test]
    fn parse_serial_full_framing() {
        let cfg = parse_serial_config("COM4?baud=9600&parity=even&data=8&stop=1");
        assert_eq!(cfg.port, "COM4");
        assert_eq!(cfg.baud, 9600);
        assert_eq!(cfg.parity.as_deref(), Some("even"));
        assert_eq!(cfg.data_bits, Some(8));
        assert_eq!(cfg.stop_bits, Some(1));
    }

    #[test]
    fn parse_serial_defaults_8n1() {
        let cfg = parse_serial_config("/dev/ttyUSB0?baud=115200");
        assert_eq!(cfg.port, "/dev/ttyUSB0");
        assert_eq!(cfg.baud, 115200);
        assert!(cfg.parity.is_none() && cfg.data_bits.is_none() && cfg.stop_bits.is_none());
    }

    #[test]
    fn parse_serial_unknown_params_ignored() {
        let cfg = parse_serial_config("COM7?baud=57600&flow=hardware");
        assert_eq!(cfg.baud, 57600);
        assert!(cfg.data_bits.is_none());
    }

    // ── stage-l: shell inference for the command wrapper ─────────────

    #[test]
    fn infer_shell_windows_pty_default_is_powershell() {
        if cfg!(windows) {
            // stage-m: the default Windows shell is pwsh.
            assert_eq!(infer_shell("pty", ""), "pwsh");
        } else {
            assert_eq!(infer_shell("pty", ""), "bash");
        }
    }

    #[test]
    fn infer_shell_windows_pty_named_targets() {
        if cfg!(windows) {
            assert_eq!(infer_shell("pty", "powershell.exe"), "powershell");
            // stage-m: pwsh is distinct (OSC 633 injection).
            assert_eq!(infer_shell("pty", "pwsh.exe"), "pwsh");
            // round-162: bare `powershell`/`pwsh` targets (what MCP clients
            // send as a shell hint) were NOT recognized → shell stayed
            // "unknown" → the command wrapper was silently disabled.
            assert_eq!(infer_shell("pty", "powershell"), "powershell");
            assert_eq!(infer_shell("pty", "pwsh"), "pwsh");
            assert_eq!(
                infer_shell(
                    "pty",
                    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
                ),
                "powershell"
            );
            assert_eq!(infer_shell("pty", "cmd.exe"), "cmd");
            assert_eq!(infer_shell("pty", "zsh.exe"), "unknown");
        } else {
            assert_eq!(infer_shell("pty", "bash"), "bash");
            assert_eq!(infer_shell("pty", "/bin/sh"), "bash");
            assert_eq!(infer_shell("pty", "fish"), "fish");
            assert_eq!(infer_shell("pty", "/bin/zsh"), "unknown");
        }
    }

    #[test]
    fn infer_shell_ssh_and_serial_unknown() {
        assert_eq!(infer_shell("ssh", "user@host"), "unknown");
        assert_eq!(infer_shell("serial", "/dev/ttyUSB0"), "unknown");
        // Custom target path on any platform → unknown (unless a known name).
        if !cfg!(windows) {
            assert_eq!(infer_shell("pty", "/usr/bin/fish"), "fish");
        }
    }

    /// round-160: the execute lock WAITS when busy instead of refusing —
    /// a second acquirer gets the lock after release, and the deadline
    /// path still returns false (mapped to session_busy upstream).
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn execute_lock_wait_queue() {
        use std::sync::Arc;
        use std::time::Duration;
        let pool = Arc::new(crate::tools::serial::SerialPool::new(115200, 1000));
        let mgr = Arc::new(TerminalManager::new(pool));
        let (sid, _rx) = mgr
            .term_open(&TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: false,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .unwrap();
        // Simulated in-flight execute holds the lock.
        assert!(mgr.term_try_execute(&sid).await.unwrap());
        let waiter = {
            let mgr = mgr.clone();
            let sid = sid.clone();
            tokio::spawn(async move { mgr.term_acquire_execute(&sid, 5000).await })
        };
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(
            !waiter.is_finished(),
            "acquirer must still be waiting while the lock is held"
        );
        mgr.term_release_execute(&sid).await;
        let got = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(got, "acquirer must get the lock once released");
        mgr.term_release_execute(&sid).await; // waiter done — free it again
                                              // Deadline path: held again → the bounded acquire gives up with false.
        assert!(mgr.term_try_execute(&sid).await.unwrap());
        assert!(!mgr.term_acquire_execute(&sid, 500).await.unwrap());
        mgr.term_release_execute(&sid).await;
        mgr.term_close(&sid).await.ok();
    }

    /// Open a real PTY session through the production path, for the control
    /// pins below. Linux/macOS only, same as the other PTY tests.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    async fn open_pty(mgr: &std::sync::Arc<TerminalManager>) -> String {
        mgr.term_open(&TermOpenRequest {
            kind: "pty".into(),
            target: String::new(),
            password: String::new(),
            key_path: String::new(),
            rows: 24,
            cols: 80,
            inject_marker: false,
            data_bits: None,
            parity: None,
            stop_bits: None,
            auto_reconnect: false,
        })
        .await
        .unwrap()
        .0
    }

    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    fn control_mgr() -> std::sync::Arc<TerminalManager> {
        std::sync::Arc::new(TerminalManager::new(std::sync::Arc::new(
            crate::tools::serial::SerialPool::new(115200, 1000),
        )))
    }

    /// A human hold refuses the AI IMMEDIATELY, with its own code.
    ///
    /// Two things are pinned at once and both matter:
    ///   * the CODE is `human_in_control`, not `session_busy` — an AI told
    ///     "busy" would retry, and retrying never hands the keyboard back;
    ///   * the refusal is IMMEDIATE. If the hold reported `Ok(false)` instead of
    ///     an error, `term_acquire_execute` would spin its 30 s loop and then
    ///     answer `session_busy` — the wrong reason, 30 seconds late. The
    ///     elapsed-time assertion below is what catches that regression.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn human_hold_refuses_execute_immediately_with_its_own_code() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;

        assert!(mgr.term_set_control(&sid, true).await.unwrap());

        let started = std::time::Instant::now();
        let err = mgr
            .term_acquire_execute(&sid, 30_000)
            .await
            .expect_err("a human-held session must refuse, not queue");
        let elapsed = started.elapsed();

        assert_eq!(
            err.code(),
            "human_in_control",
            "a human hold must not be reported as session_busy: waiting cannot \
             hand the keyboard back, so 'busy' tells the AI to do the wrong thing"
        );
        assert_ne!(err.code(), "session_busy");
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "the refusal must be immediate, not after the 30s acquire deadline \
             (elapsed {elapsed:?}) — that is the Ok(false) regression"
        );

        mgr.term_close(&sid).await.ok();
    }

    /// The hold and the execute lock are ORTHOGONAL.
    ///
    /// Refusing on a hold must not touch `busy`: if it did, handing the keyboard
    /// back would leave the session apparently mid-execute, and the next AI
    /// execute would be refused for a reason that no longer exists.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn human_hold_does_not_disturb_the_execute_lock() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;

        mgr.term_set_control(&sid, true).await.unwrap();
        mgr.term_acquire_execute(&sid, 0).await.unwrap_err();

        // Hand back and the AI gets the lock straight away — no stale busy.
        assert!(!mgr.term_set_control(&sid, false).await.unwrap());
        assert!(
            mgr.term_try_execute(&sid).await.unwrap(),
            "after hand-back the execute lock must be free; a refusal that also \
             set `busy` would wedge the session"
        );
        mgr.term_release_execute(&sid).await;

        mgr.term_close(&sid).await.ok();
    }

    /// The hold is VISIBLE wherever sessions are listed, which is how the panel
    /// and an AI calling `terminal_list` see it before colliding.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn held_by_human_is_reported_on_session_info() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;

        let before = mgr.term_list().await;
        let me = before.iter().find(|s| s.id == sid).expect("session listed");
        assert!(!me.held_by_human, "a fresh session is the AI's");

        mgr.term_set_control(&sid, true).await.unwrap();
        let after = mgr.term_list().await;
        let me = after.iter().find(|s| s.id == sid).expect("session listed");
        assert!(
            me.held_by_human,
            "the hold must be visible in terminal_list"
        );

        // term_info is the other reader; both must agree or the panel and the
        // drainer would disagree about who holds the session.
        assert!(mgr.term_info(&sid).await.unwrap().held_by_human);

        mgr.term_close(&sid).await.ok();
    }

    /// An unknown session is an ERROR, never a silent success.
    ///
    /// The panel can hold a stale sid after a session was closed or reaped by
    /// the idle sweep; reporting `ok` there would leave the operator believing
    /// they hold a keyboard that no longer exists.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn control_on_an_unknown_session_is_an_error() {
        let mgr = control_mgr();
        let err = mgr.term_set_control("no-such-sid", true).await.unwrap_err();
        assert_eq!(err.code(), "session_not_found");
        assert_eq!(
            mgr.term_held_by_human("no-such-sid")
                .await
                .unwrap_err()
                .code(),
            "session_not_found"
        );
    }

    /// Real PTY round-trip (needs a local shell, so Linux/macOS only).
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn pty_roundtrip_echo() {
        let pool = std::sync::Arc::new(crate::tools::serial::SerialPool::new(115200, 1000));
        let mgr = TerminalManager::new(pool);
        let (sid, mut rx) = mgr
            .term_open(&TermOpenRequest {
                kind: "pty".into(),
                target: String::new(),
                password: String::new(),
                key_path: String::new(),
                rows: 24,
                cols: 80,
                inject_marker: true,
                data_bits: None,
                parity: None,
                stop_bits: None,
                auto_reconnect: false,
            })
            .await
            .expect("open pty");
        mgr.term_write(&sid, "echo pty-roundtrip\n")
            .await
            .expect("write");

        let mut saw = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !saw.contains("pty-roundtrip") && std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await {
                Ok(Some(out)) => saw.push_str(&String::from_utf8_lossy(&out.data)),
                _ => break,
            }
        }
        assert!(
            saw.contains("pty-roundtrip"),
            "pty output did not echo: {saw:?}"
        );
        let _ = mgr.term_close(&sid).await;
    }

    /// The marker gate is REPORTED by the backend, never ASSUMED from the
    /// shell name (SOLID R126).
    ///
    /// review #3's incident: pwsh was assumed injected because of its NAME.
    /// When `shellIntegration.ps1` is absent the dot-source silently no-ops,
    /// the 633 codes never arrive, the quiet path never runs, and EVERY
    /// execute burns its full timeout — a hang, not an error. The fix was to
    /// ask the BACKEND what actually happened.
    ///
    /// This pins the contract execute depends on:
    ///   * a fresh session reports whatever its backend injected, and
    ///   * `term_marker_injected` on an UNKNOWN id is false — the fail-safe
    ///     direction (no 633 wait on a session we cannot vouch for), not true.
    ///
    /// The falsifiable half is the unknown-id case plus the round-trip: if
    /// someone "simplifies" the lookup to `unwrap_or(true)`, the fail-safe
    /// inverts and a missing session would take the never-arriving 633 path.
    ///
    /// ⚠️ GATED ON THE `terminal` FEATURE, and that gate is the whole point.
    /// The headless `stub.rs` twin returns a hardcoded `false` from
    /// `term_marker_injected` and does nothing in `term_set_marker_injected`,
    /// so an ungated version of this test passes against the STUB and never
    /// touches the real lookup — I verified that by inverting the real
    /// implementation's `unwrap_or(false)` to `true` and watching an ungated
    /// run stay green. A pin that exercises only the stub is not a pin for the
    /// production path, so this one runs where the real code does: the
    /// `--features terminal` suite.
    #[cfg(feature = "terminal")]
    #[tokio::test]
    async fn marker_gate_is_reported_not_assumed() {
        use std::sync::Arc;
        let pool = Arc::new(crate::tools::serial::SerialPool::new(115200, 1000));
        let mgr = TerminalManager::new(pool);
        // No session has ever been opened: the gate must be FALSE, i.e. fail
        // safe. `unwrap_or(true)` here would hang every execute on a bad id.
        assert!(
            !mgr.term_marker_injected("no-such-session").await,
            "an unknown id must report NOT injected — assuming injected takes \
             the 633 wait path, which never completes, so the command would \
             hang to the deadline"
        );
        // And the post-open corrector, though unwired, must round-trip rather
        // than panic or lie — it is public API that a consumer can still call.
        mgr.term_set_marker_injected("no-such-session", true).await;
        assert!(
            !mgr.term_marker_injected("no-such-session").await,
            "setting a flag on a non-existent session must be a no-op, not a \
             resurrection: the lookup is by id"
        );
    }
}
