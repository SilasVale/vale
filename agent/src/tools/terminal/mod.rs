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
#[cfg(feature = "terminal")]
mod connections;
#[cfg(feature = "terminal")]
mod pty;
#[cfg(feature = "terminal")]
mod serial;
#[cfg(feature = "terminal")]
mod ssh;
#[cfg(not(feature = "terminal"))]
mod stub;

pub use secrets::{secret_delete, secret_get, secret_list, secret_set};
#[cfg(feature = "terminal")]
pub use connections::{forget as conn_forget, list as conn_list, remember as conn_remember};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct TermSessionInfo {
    pub id: String,
    pub kind: String, // "pty", "ssh", "serial"
    pub label: String,
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
}

fn default_true() -> bool { true }

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
    let mut cfg = SerialTargetConfig { baud: 115200, ..Default::default() };
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
    fn write(&self, data: &[u8]);
    /// Reliable write (round-103): waits for the transport instead of
    /// drop-on-full — used by terminal_execute, where a dropped command
    /// silently never runs (and the wait loop reports success-like 'idle').
    /// Default = sync write (keystrokes); SSH overrides with an awaitable
    /// send so backpressure never loses a command.
    fn write_async<'a>(&'a self, data: &'a [u8]) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move { self.write(data) })
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
    fn exit_code(&self) -> Option<i32> { None }
}

#[cfg(feature = "terminal")]
mod desktop_impl {
    use super::*;
    use vale_agent_core::DeviceError;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    struct Session {
        id: String,
        kind: String,
        label: String,
        backend: Arc<dyn TermBackend>,
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
                inner: std::sync::Arc::new(tokio::sync::Mutex::new(TerminalInner { sessions: Vec::new(), next_id: 0, boot_prefix })),
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
                        for i in sweep.into_iter().rev() {
                            inner.sessions[i].backend.close();
                            inner.sessions.remove(i);
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
            &self, req: &TermOpenRequest,
        ) -> Result<(String, mpsc::Receiver<TermOutput>), DeviceError> {
            let id = {
                let mut inner = self.inner.lock().await;
                // Unique across boots: the prefix rotates every restart, so a
                // reused sid can never freeze the panel's resurrection logic.
                let id = format!("term-{}-{}", inner.boot_prefix, inner.next_id);
                inner.next_id += 1;
                id
            };
            let kind = if req.kind.is_empty() { "pty".to_string() } else { req.kind.clone() };
            // Bounded: backpressure through the reader threads (blocking_send)
            let (tx, rx) = mpsc::channel(256);

            let (backend, label) = match kind.as_str() {
                "ssh" => {
                    let be = ssh::SshBackend::connect(
                        &req.target, &req.password, req.rows, req.cols, tx, id.clone(),
                    ).await?;
                    let (user, host, _port) = parse_ssh_target(&req.target);
                    let label = format!("{user}@{host}");
                    (Arc::new(be) as Arc<dyn TermBackend>, label)
                }
                "serial" => {
                    let be = serial::SerialBackend::open(
                        self.serial_pool.clone(), &req.target, req.data_bits, req.parity.clone(), req.stop_bits, tx, id.clone(),
                    ).await?;
                    let label = format!("serial:{}", req.target.split('?').next().unwrap_or(&req.target));
                    (Arc::new(be) as Arc<dyn TermBackend>, label)
                }
                _ => {
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
                        if cfg!(windows) { "PowerShell".into() } else { "bash".into() }
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
            {
                let mut inner = self.inner.lock().await;
                while inner.sessions.len() >= MAX_SESSIONS {
                    // Evict the session idle-longest; on a last_output tie
                    // fall back to the OLDEST-opened — an old-but-actively-
                    // watched session must survive.
                    let idle = inner.sessions
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, s)| (s.last_output, s.opened_at))
                        .map(|(i, _)| i);
                    match idle {
                        Some(i) => {
                            inner.sessions[i].backend.close();
                            inner.sessions.remove(i);
                        }
                        None => break,
                    }
                }
                inner.sessions.push(Session { id: id.clone(), kind, label, backend, last_output: std::time::Instant::now(), opened_at: std::time::Instant::now(), busy: false });
            }
            Ok((id, rx))
        }

        pub async fn term_resize(&self, sid: &str, rows: u16, cols: u16) -> Result<(), DeviceError> {
            let mut inner = self.inner.lock().await;
            let s = inner.sessions.iter_mut().find(|s| s.id == sid)
                .ok_or(DeviceError::SessionNotFound { id: sid.to_string() })?;
            s.backend.resize(rows, cols);
            // Activity = heartbeat: a client actively resizing is alive — the
            // 15-min idle sweeper must not kill it (round-49).
            s.last_output = std::time::Instant::now();
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
            let backend = {
                let mut inner = self.inner.lock().await;
                let s = inner.sessions.iter_mut().find(|s| s.id == sid)
                    .ok_or(DeviceError::SessionNotFound { id: sid.to_string() })?;
                // Activity = heartbeat (round-49): typing into a session is liveness.
                s.last_output = std::time::Instant::now();
                s.backend.clone()
            };
            // round-103: reliable write (SSH overrides with an awaitable
            // send) — terminal_execute's command must not be dropped when
            // the transport is under backpressure.
            backend.write_async(data).await;
            Ok(())
        }

        pub async fn term_close(&self, sid: &str) -> Result<String, DeviceError> {
            let mut inner = self.inner.lock().await;
            if let Some(pos) = inner.sessions.iter().position(|s| s.id == sid) {
                let kind = inner.sessions[pos].kind.clone();
                // Signal backend to close
                inner.sessions[pos].backend.close();
                inner.sessions.remove(pos);
                Ok(kind)
            } else {
                Err(DeviceError::SessionNotFound { id: sid.to_string() })
            }
        }

        /// Unregister a session whose backend has died on its own (SSH channel
        /// dropped, PTY shell exited, serial unplugged). Closes the backend and
        /// removes the entry WITHOUT the tool-level event/retain side effects
        /// of term_close (the drainer already retains the buffer in history).
        /// Without this, dead sessions lingered in term_list forever and
        /// terminal_write/terminal_resize silently "succeeded" into a void.
        pub async fn term_unregister(&self, sid: &str) {
            let mut inner = self.inner.lock().await;
            if let Some(pos) = inner.sessions.iter().position(|s| s.id == sid) {
                inner.sessions[pos].backend.close();
                inner.sessions.remove(pos);
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
                Err(DeviceError::SessionNotFound { id: sid.to_string() })
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
            let backend = {
                let inner = self.inner.lock().await;
                let s = inner.sessions.iter().find(|s| s.id == sid)
                    .ok_or(DeviceError::SessionNotFound { id: sid.to_string() })?;
                s.backend.clone()
            };
            backend.terminate();
            Ok(())
        }

        /// Try to acquire the per-session execute lock (round-55): a second
        /// concurrent execute on the same session would share one buffer
        /// cursor and interleave reads + marker ownership — refuse instead.
        pub async fn term_try_execute(&self, sid: &str) -> bool {
            let mut inner = self.inner.lock().await;
            match inner.sessions.iter_mut().find(|s| s.id == sid) {
                Some(s) => {
                    if s.busy { false } else { s.busy = true; true }
                }
                None => false,
            }
        }

        /// Release the per-session execute lock (all exit paths of execute).
        pub async fn term_release_execute(&self, sid: &str) {
            let mut inner = self.inner.lock().await;
            if let Some(s) = inner.sessions.iter_mut().find(|s| s.id == sid) {
                s.busy = false;
            }
        }

        /// The backend's natural exit code (PTY only; None for SSH/serial or
        /// a session that is still running) (round-60).
        pub async fn term_exit_code(&self, sid: &str) -> Option<i32> {
            let inner = self.inner.lock().await;
            inner.sessions.iter().find(|s| s.id == sid).and_then(|s| s.backend.exit_code())
        }

        pub async fn term_list(&self) -> Vec<TermSessionInfo> {
            let inner = self.inner.lock().await;
            inner.sessions.iter()
                .map(|s| TermSessionInfo { id: s.id.clone(), kind: s.kind.clone(), label: s.label.clone() })
                .collect()
        }

        /// Clone a session's info (id/kind/label) if it still exists. Used by
        /// the output drainer and terminal_close to capture metadata BEFORE the
        /// session leaves the manager, so retained history keeps its kind/label.
        pub async fn term_info(&self, sid: &str) -> Option<TermSessionInfo> {
            let inner = self.inner.lock().await;
            inner.sessions.iter().find(|s| s.id == sid).map(|s| TermSessionInfo {
                id: s.id.clone(),
                kind: s.kind.clone(),
                label: s.label.clone(),
            })
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
        assert_eq!(
            parse_ssh_target("[::1]"),
            ("root".into(), "::1".into(), 22)
        );
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
        assert_eq!(parse_serial_target("/dev/ttyUSB0"), ("/dev/ttyUSB0".into(), 115200));
    }

    #[test]
    fn parse_serial_with_baud() {
        assert_eq!(parse_serial_target("COM3?baud=9600"), ("COM3".into(), 9600));
    }

    #[test]
    fn parse_serial_bad_baud_defaults() {
        assert_eq!(parse_serial_target("COM3?baud=xyz"), ("COM3".into(), 115200));
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
                rows: 24,
                cols: 80,
                inject_marker: true,
                data_bits: None,
                parity: None,
                stop_bits: None,
            })
            .await
            .expect("open pty");
        mgr.term_write(&sid, "echo pty-roundtrip\n").await.expect("write");

        let mut saw = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !saw.contains("pty-roundtrip") && std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await {
                Ok(Some(out)) => saw.push_str(&String::from_utf8_lossy(&out.data)),
                _ => break,
            }
        }
        assert!(saw.contains("pty-roundtrip"), "pty output did not echo: {saw:?}");
        let _ = mgr.term_close(&sid).await;
    }
}
