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
mod pty;
#[cfg(feature = "terminal")]
mod serial;
#[cfg(feature = "terminal")]
mod ssh;
#[cfg(not(feature = "terminal"))]
mod stub;

pub use secrets::{secret_delete, secret_get, secret_list, secret_set};

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
}

/// A chunk of terminal output sent to the frontend
#[derive(Debug, Clone, Serialize)]
pub struct TermOutput {
    pub session_id: String,
    pub data: Vec<u8>,
}

/// Parse an SSH target into (user, host, port).
/// Accepted forms: `user@host`, `user@host:port`, `host`, `host:port`.
/// Defaults: user = "root", port = 22.
pub fn parse_ssh_target(target: &str) -> (String, String, u16) {
    let target = target.trim();
    let (user_host, port) = if let Some((uh, p)) = target.rsplit_once(':') {
        (uh, p.parse::<u16>().unwrap_or(22))
    } else {
        (target, 22)
    };
    let (user, host) = if let Some((u, h)) = user_host.split_once('@') {
        (u.to_string(), h.to_string())
    } else {
        ("root".to_string(), user_host.to_string())
    };
    (user, host, port)
}

/// Parse a serial target into (port_name, baud_rate).
/// Accepted forms: `port_name`, `port_name?baud=115200`. Default baud: 115200.
pub fn parse_serial_target(target: &str) -> (String, u32) {
    let target = target.trim();
    if let Some((port, params)) = target.split_once('?') {
        let baud = params.split('&')
            .find(|p| p.starts_with("baud="))
            .and_then(|p| p[5..].parse().ok())
            .unwrap_or(115200);
        (port.to_string(), baud)
    } else {
        (target.to_string(), 115200)
    }
}

/// Common backend interface — one call site for write/resize/close no matter
/// which kind of session (PTY/SSH/Serial) a session is.
pub trait TermBackend: Send + Sync {
    fn write(&self, data: &[u8]);
    fn resize(&self, rows: u16, cols: u16);
    fn close(&self);
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
        backend: Box<dyn TermBackend>,
        /// Last time output was seen — used by the idle sweeper.
        last_output: std::time::Instant,
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
            // blocks open/close.
            {
                let mgr2 = mgr.clone();
                tokio::spawn(async move {
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
                });
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
                    (Box::new(be) as Box<dyn TermBackend>, label)
                }
                "serial" => {
                    let be = serial::SerialBackend::open(
                        self.serial_pool.clone(), &req.target, tx, id.clone(),
                    ).await?;
                    let label = format!("serial:{}", req.target.split('?').next().unwrap_or(&req.target));
                    (Box::new(be) as Box<dyn TermBackend>, label)
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
                    (Box::new(be) as Box<dyn TermBackend>, label)
                }
            };

            // Session cap: evict the OLDEST session when over MAX_SESSIONS
            // (client-disconnect leak guard; keeps the device usable). Evict
            // the session IDLE LONGEST (last_output oldest), not the OLDEST
            // opened — an old-but-actively-watched session must survive.
            {
                let mut inner = self.inner.lock().await;
                while inner.sessions.len() >= MAX_SESSIONS {
                    let idle = inner.sessions
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, s)| s.last_output)
                        .map(|(i, _)| i);
                    match idle {
                        Some(i) => {
                            inner.sessions[i].backend.close();
                            inner.sessions.remove(i);
                        }
                        None => break,
                    }
                }
                inner.sessions.push(Session { id: id.clone(), kind, label, backend, last_output: std::time::Instant::now() });
            }
            Ok((id, rx))
        }

        pub async fn term_resize(&self, sid: &str, rows: u16, cols: u16) -> Result<(), DeviceError> {
            let inner = self.inner.lock().await;
            let s = inner.sessions.iter().find(|s| s.id == sid)
                .ok_or(DeviceError::Internal { message: format!("session not found: {sid}") })?;
            s.backend.resize(rows, cols);
            Ok(())
        }

        pub async fn term_write(&self, sid: &str, data: &str) -> Result<(), DeviceError> {
            let inner = self.inner.lock().await;
            let s = inner.sessions.iter().find(|s| s.id == sid)
                .ok_or(DeviceError::Internal { message: format!("session not found: {sid}") })?;
            s.backend.write(data.as_bytes());
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
                Err(DeviceError::Internal { message: format!("session not found: {sid}") })
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
            // Client-liveness heartbeat: the panel pings every live session
            // with terminal_select every 30s, and the idle sweeper (15 min
            // without OUTPUT) must not kill a watched-but-silent session
            // (vim, a long quiet build). Advancing last_output here keeps an
            // actively-pinged session alive; a disconnected client stops
            // pinging and the sweeper reaps it as intended. (Lock is already
            // held — touch() would re-lock and deadlock.)
            let mut inner = self.inner.lock().await;
            if let Some(s) = inner.sessions.iter_mut().find(|s| s.id == sid) {
                s.last_output = std::time::Instant::now();
                Ok(())
            } else {
                Err(DeviceError::Internal { message: format!("session not found: {sid}") })
            }
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
        mgr.term_close(&sid).await;
    }
}
