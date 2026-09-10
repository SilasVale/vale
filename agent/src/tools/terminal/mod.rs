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
// Approval GRANTS: pure functions (no backend deps), so they compile in BOTH
// feature configs and are testable without a PTY — which is deliberate, because
// the grant rule is the safety-critical part of the approval gate (see its
// header) and its tests should not depend on a real terminal existing.
//
// The `allow(dead_code)` is for the HEADLESS config only: the sole caller is the
// real manager in `desktop_impl`, so under the stub the functions have no
// non-test consumer. Gating the module instead would have been the tidier-looking
// choice and would have silently dropped these tests from the default gate —
// the wrong trade for the code that decides what runs unasked.
#[cfg_attr(not(feature = "terminal"), allow(dead_code))]
pub(crate) mod approval;
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
    /// The session is in APPROVAL MODE: `terminal_execute` must be approved by a
    /// person before it reaches the shell. Off by default — autonomous operation
    /// is the point of the product, and a gate nobody asked for is just a delay.
    #[serde(default)]
    pub approval_required: bool,
    /// The request currently waiting for a decision, if any. Carried on session
    /// info so the panel can render the prompt from the list it already polls,
    /// rather than needing a second endpoint to discover that something is
    /// blocked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_approval: Option<PendingApprovalInfo>,
    /// First words the operator has allowed for this session (see `approval.rs`).
    /// Exposed so the panel can LIST them: a grant the operator cannot see is one
    /// they cannot judge or revoke, and these decide what runs unasked.
    #[serde(default)]
    pub approval_grants: Vec<String>,
    /// What the operator asked this session to achieve, if they said.
    ///
    /// Carried HERE, on the list every client already polls, so an AI agent
    /// learns the objective without a new tool and without the operator having to
    /// repeat it into a chat window. That is the whole dispatch beat: the
    /// operator states intent in the panel, the agent records it, and the AI
    /// finds it on the first `terminal_list`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    /// The agent's own PLAN for this session: the steps it intends to take, in
    /// order. Empty when it has not declared one.
    ///
    /// Distinct from `goal` in WHO declares it and in what it answers. The goal is
    /// the OPERATOR's intent ("provision the ONU") and answers *what is this for*;
    /// the plan is the AGENT's intent and answers *what does it mean to do*. A
    /// reader who has both can see a run diverge — the plan says five steps, the
    /// path shows three of them plus two nobody announced.
    #[serde(default)]
    pub plan: Vec<String>,
}

/// A command waiting for an operator decision. `expires_in_ms` is derived at read
/// time rather than stored, so a caller never has to know when the request
/// started to know whether it is still live.
#[derive(Debug, Clone, Serialize)]
pub struct PendingApprovalInfo {
    pub id: String,
    pub command: String,
    pub expires_in_ms: u64,
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
        /// Approval mode: every execute waits for a person's decision first.
        approval_required: bool,
        /// The in-flight request, if an execute is currently blocked on one.
        pending_approval: Option<PendingApproval>,
        /// First words allowed without asking, each derived from a command the
        /// operator actually read and approved. In-memory, like the hold: a
        /// restart must not carry forward a permission nobody re-confirmed.
        approval_grants: Vec<String>,
        /// What the operator asked for. In-memory with the session (a goal
        /// without a session is meaningless), while the STATEMENT of it is
        /// recorded in the audit trail — the same live/durable split as the
        /// handoff, and for the same reason: the live value is coordination, the
        /// record is history.
        goal: Option<String>,
        /// The agent's declared plan, in order. Same live/durable split as the
        /// goal: the list lives here, each DECLARATION is appended to the trail so
        /// a reader can see it was revised rather than only what it ended up as.
        plan: Vec<String>,
    }

    /// Identifier for one approval request. Unpredictable rather than sequential on
    /// purpose: the panel sends it back to decide, and a guessable id would let a
    /// stale view approve a DIFFERENT command than the one it displayed.
    fn approval_id() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("ap-{n}-{nanos:x}")
    }

    /// Project a session's pending approval for a reader, dropping anything
    /// already decided or past its deadline. ONE definition: `term_list` and
    /// `term_info` answering differently would make the panel's prompt flicker
    /// depending on which call it happened to make.
    fn live_pending(s: &Session) -> Option<PendingApprovalInfo> {
        let p = s.pending_approval.as_ref()?;
        if p.decided.is_some() {
            return None;
        }
        let elapsed = p.requested_at.elapsed().as_millis() as u64;
        let left = APPROVAL_WAIT_MS.saturating_sub(elapsed);
        (left > 0).then(|| PendingApprovalInfo {
            id: p.id.clone(),
            command: p.command.clone(),
            expires_in_ms: left,
        })
    }

    /// A command blocked on an operator decision.
    ///
    /// `decided` is the ONLY channel between the waiting execute and the
    /// deciding route, and it is a `bool` rather than a channel/condvar on
    /// purpose: the waiter polls, which is the established pattern in this file
    /// (`term_acquire_execute` polls at 250 ms) and keeps the state visible to
    /// `term_list` for the whole wait. A channel would need a separate copy of
    /// the request just for the panel to render it.
    struct PendingApproval {
        id: String,
        command: String,
        requested_at: std::time::Instant,
        /// `None` while pending; `Some(approve)` once decided.
        decided: Option<bool>,
    }

    /// How long an execute waits for a decision before giving up.
    ///
    /// FAIL-CLOSED at the deadline, and the value is a compromise stated rather
    /// than hidden: long enough that an operator who is watching has time to
    /// read the command, short enough that it fits inside the MCP client
    /// timeouts the existing 30 s acquire wait already lives within. An operator
    /// who needs longer should take the keyboard, which is unbounded.
    const APPROVAL_WAIT_MS: u64 = 60_000;
    /// Longest goal we keep, in bytes.
    ///
    /// Sized to hold a real sentence or two ("get the ONU at 0/1 provisioned on
    /// VLAN 100 and save the config") — an objective, not a specification. A goal
    /// is echoed on every `terminal_list` and every audit read, so this bound is
    /// what keeps a chatty client from inflating both.
    const GOAL_MAX_BYTES: usize = 512;

    /// Most plan steps we keep. A plan is a sequence a person reads to decide
    /// whether to let a run continue, so it has to stay short enough to READ —
    /// past a couple of dozen steps it is a transcript, not a plan.
    const PLAN_MAX_STEPS: usize = 24;
    /// Longest single step label, in bytes. A step is a line, not a paragraph:
    /// the reasoning belongs in the command's `intent`.
    const PLAN_STEP_MAX_BYTES: usize = 200;

    /// Poll cadence while waiting for a decision.
    const APPROVAL_POLL_MS: u64 = 200;

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
                    approval_required: false,
                    pending_approval: None,
                    approval_grants: Vec::new(),
                    goal: None,
                    plan: Vec::new(),
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

        /// Turn APPROVAL MODE on or off for a session. Returns the state now in
        /// force.
        ///
        /// Turning it off while a request is pending decides that request (as a
        /// refusal) rather than abandoning it: a waiter left behind would hold the
        /// execute lock until its deadline, and the operator who switched the mode
        /// off would see the session apparently stuck for no visible reason.
        pub async fn term_set_approval_required(
            &self,
            sid: &str,
            required: bool,
        ) -> Result<bool, DeviceError> {
            let mut inner = self.inner.lock().await;
            match inner.sessions.iter_mut().find(|s| s.id == sid) {
                Some(s) => {
                    s.approval_required = required;
                    if !required {
                        if let Some(p) = s.pending_approval.as_mut() {
                            if p.decided.is_none() {
                                p.decided = Some(false);
                            }
                        }
                        // Grants DIE with the mode. Leaving them would mean a
                        // later re-arm inherits permissions the operator granted
                        // in a context they have since left — and the whole point
                        // of arming is that it is a deliberate act.
                        s.approval_grants.clear();
                    }
                    Ok(s.approval_required)
                }
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// State the session's GOAL, or clear it with an empty string. Returns
        /// the value now in force (trimmed, or `None` when cleared).
        ///
        /// The OPERATOR states this; the AI reads it off `terminal_list`. That
        /// split is deliberate and is what the design's dispatch beat needs: an
        /// objective is the human's to declare, and requiring an AI client to
        /// cooperate in declaring it would make the most valuable beat of the loop
        /// depend on the least controllable part of the system. The AI's own plan
        /// decomposition is a separate, later concern (the intent layer).
        ///
        /// CAPPED, because this is a label rather than a document: a goal rides on
        /// every `terminal_list` response and on every audit read, and an unbounded
        /// one would tax both. The cap is on a char boundary (see `crate::text`),
        /// so a multi-byte goal truncates cleanly rather than panicking.
        pub async fn term_set_goal(
            &self,
            sid: &str,
            goal: &str,
        ) -> Result<Option<String>, DeviceError> {
            let trimmed = goal.trim();
            let value = (!trimmed.is_empty())
                .then(|| crate::text::clip(trimmed, GOAL_MAX_BYTES).to_string());
            let mut inner = self.inner.lock().await;
            match inner.sessions.iter_mut().find(|s| s.id == sid) {
                Some(s) => {
                    s.goal = value.clone();
                    Ok(value)
                }
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// Declare, replace or clear the agent's PLAN for this session.
        ///
        /// Pass an empty slice to CLEAR it. Returns the plan now in force, so a
        /// caller renders the stored value rather than its own request — the
        /// stored one has been trimmed, capped and had blank steps dropped.
        ///
        /// The plan is the AGENT's statement, which is why it lives on the tool
        /// surface rather than the operator's control route: the operator declares
        /// what the session is FOR (`goal`), the agent declares what it means to
        /// DO. Keeping those apart is what lets a reader notice the two diverging.
        ///
        /// Replacing wholesale, rather than add/remove/reorder: a plan is read as
        /// a whole, and a partial edit API would invite a state where nothing
        /// holds the sequence together. A revision is a new statement, and each
        /// one is recorded.
        pub async fn term_set_plan(
            &self,
            sid: &str,
            plan: &[String],
        ) -> Result<Vec<String>, DeviceError> {
            let value: Vec<String> = plan
                .iter()
                .map(|s| s.trim())
                // Blank steps are DROPPED, not stored as empty entries: a
                // numbering with holes in it reads as a missing step rather than
                // as a stray blank.
                .filter(|s| !s.is_empty())
                .take(PLAN_MAX_STEPS)
                .map(|s| crate::text::clip(s, PLAN_STEP_MAX_BYTES).to_string())
                .collect();
            let mut inner = self.inner.lock().await;
            match inner.sessions.iter_mut().find(|s| s.id == sid) {
                Some(s) => {
                    s.plan = value.clone();
                    Ok(value)
                }
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// The session's current plan, in order.
        pub async fn term_plan(&self, sid: &str) -> Result<Vec<String>, DeviceError> {
            let inner = self.inner.lock().await;
            match inner.sessions.iter().find(|s| s.id == sid) {
                Some(s) => Ok(s.plan.clone()),
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// The session's current goal, if any.
        pub async fn term_goal(&self, sid: &str) -> Result<Option<String>, DeviceError> {
            let inner = self.inner.lock().await;
            match inner.sessions.iter().find(|s| s.id == sid) {
                Some(s) => Ok(s.goal.clone()),
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// Whether this session is in approval mode.
        ///
        /// `unwrap_or(false)` at the CALL SITE rather than here: a missing session
        /// (closed between the busy guard and this check) must not silently become
        /// "no approval needed". The execute path treats an error here as "not
        /// armed" only because the shell write immediately below will fail on its
        /// own for the same missing session — see the call site's comment.
        pub async fn term_approval_required(&self, sid: &str) -> Result<bool, DeviceError> {
            let inner = self.inner.lock().await;
            match inner.sessions.iter().find(|s| s.id == sid) {
                Some(s) => Ok(s.approval_required),
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// The request currently awaiting a decision, with its remaining life.
        /// Expired entries read as absent, so a caller cannot be shown a prompt
        /// for a command that has already given up.
        pub async fn term_pending_approval(
            &self,
            sid: &str,
        ) -> Result<Option<PendingApprovalInfo>, DeviceError> {
            let inner = self.inner.lock().await;
            match inner.sessions.iter().find(|s| s.id == sid) {
                Some(s) => Ok(s.pending_approval.as_ref().and_then(|p| {
                    if p.decided.is_some() {
                        return None;
                    }
                    let elapsed = p.requested_at.elapsed().as_millis() as u64;
                    let left = APPROVAL_WAIT_MS.saturating_sub(elapsed);
                    (left > 0).then(|| PendingApprovalInfo {
                        id: p.id.clone(),
                        command: p.command.clone(),
                        expires_in_ms: left,
                    })
                })),
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// Decide the pending request. `Ok(false)` when there was nothing to
        /// decide (already decided, expired, or never asked) — the caller
        /// surfaces that to the operator rather than treating it as success.
        ///
        /// The `id` must match: a stale panel tab must not be able to approve a
        /// DIFFERENT command that arrived after it rendered.
        pub async fn term_decide_approval(
            &self,
            sid: &str,
            id: &str,
            approve: bool,
            grant: bool,
        ) -> Result<bool, DeviceError> {
            let mut inner = self.inner.lock().await;
            match inner.sessions.iter_mut().find(|s| s.id == sid) {
                Some(s) => {
                    // The grant is derived HERE, from the command the operator
                    // was SHOWN — never from a value the caller supplied. A
                    // client therefore cannot widen its own permissions: the
                    // most it can do is say "and remember this", and the
                    // remembered thing is whatever was on screen.
                    let derived = if approve && grant {
                        s.pending_approval
                            .as_ref()
                            .filter(|p| p.id == id && p.decided.is_none())
                            .and_then(|p| approval::grant_for(&p.command))
                    } else {
                        None
                    };
                    if let Some(g) = derived {
                        if !s.approval_grants.iter().any(|x| x == &g) {
                            s.approval_grants.push(g);
                        }
                    }
                    match s.pending_approval.as_mut() {
                        Some(p) if p.id == id && p.decided.is_none() => {
                            p.decided = Some(approve);
                            Ok(true)
                        }
                        _ => Ok(false),
                    }
                }
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// First words currently allowed without asking, for this session.
        pub async fn term_approval_grants(&self, sid: &str) -> Result<Vec<String>, DeviceError> {
            let inner = self.inner.lock().await;
            match inner.sessions.iter().find(|s| s.id == sid) {
                Some(s) => Ok(s.approval_grants.clone()),
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// Revoke one grant, or all of them (`grant == None`). Returns how many
        /// were removed, so a caller can tell "revoked" from "there was nothing".
        pub async fn term_revoke_grants(
            &self,
            sid: &str,
            grant: Option<&str>,
        ) -> Result<usize, DeviceError> {
            let mut inner = self.inner.lock().await;
            match inner.sessions.iter_mut().find(|s| s.id == sid) {
                Some(s) => {
                    let before = s.approval_grants.len();
                    match grant {
                        Some(g) => s.approval_grants.retain(|x| x != g),
                        None => s.approval_grants.clear(),
                    }
                    Ok(before - s.approval_grants.len())
                }
                None => Err(DeviceError::SessionNotFound {
                    id: sid.to_string(),
                }),
            }
        }

        /// Block until this command is approved, refused, or the deadline passes.
        ///
        /// Registers the request so the operator can see it, then polls. Every
        /// exit path CLEARS the registration, so the panel never shows a prompt
        /// for a command that has already finished waiting — the prompt is only
        /// ever a live question.
        ///
        /// The caller runs this BEFORE writing to the shell, so a denial or a
        /// timeout means the command genuinely never reached the device. That
        /// ordering is what makes the gate fail-closed rather than advisory.
        pub async fn term_await_approval(
            &self,
            sid: &str,
            command: &str,
            max_wait_ms: u64,
        ) -> Result<bool, DeviceError> {
            let id = approval_id();
            {
                let mut inner = self.inner.lock().await;
                match inner.sessions.iter_mut().find(|s| s.id == sid) {
                    // A GRANTED command never becomes a request. Skipping the
                    // registration (rather than registering and immediately
                    // deciding) is what keeps the panel from flickering a prompt
                    // for something already allowed.
                    Some(s)
                        if s.approval_grants
                            .iter()
                            .any(|g| approval::grant_matches(g, command)) =>
                    {
                        return Ok(true);
                    }
                    Some(s) => {
                        // At most one request per session: the execute lock
                        // already serialises executes, so a second registration
                        // would mean the first waiter was abandoned and its
                        // prompt should not be overwritten silently.
                        if s.pending_approval
                            .as_ref()
                            .is_some_and(|p| p.decided.is_none())
                        {
                            return Err(DeviceError::SessionBusy {
                                id: sid.to_string(),
                            });
                        }
                        s.pending_approval = Some(PendingApproval {
                            id: id.clone(),
                            command: command.to_string(),
                            requested_at: std::time::Instant::now(),
                            decided: None,
                        });
                    }
                    None => {
                        return Err(DeviceError::SessionNotFound {
                            id: sid.to_string(),
                        })
                    }
                }
            }

            let deadline = std::time::Instant::now()
                + std::time::Duration::from_millis(max_wait_ms.min(APPROVAL_WAIT_MS));
            let outcome = loop {
                {
                    let inner = self.inner.lock().await;
                    let decided = inner
                        .sessions
                        .iter()
                        .find(|s| s.id == sid)
                        .and_then(|s| s.pending_approval.as_ref())
                        .and_then(|p| p.decided);
                    if let Some(d) = decided {
                        break Some(d);
                    }
                }
                if std::time::Instant::now() >= deadline {
                    break None;
                }
                tokio::time::sleep(std::time::Duration::from_millis(APPROVAL_POLL_MS)).await;
            };

            // Clear on EVERY exit path. A registered-but-decided request left in
            // place would make the next execute see a stale entry and refuse
            // itself with SessionBusy.
            {
                let mut inner = self.inner.lock().await;
                if let Some(s) = inner.sessions.iter_mut().find(|s| s.id == sid) {
                    if s.pending_approval.as_ref().is_some_and(|p| p.id == id) {
                        s.pending_approval = None;
                    }
                }
            }

            match outcome {
                Some(true) => Ok(true),
                Some(false) => Err(DeviceError::ApprovalDenied {
                    id: sid.to_string(),
                }),
                // FAIL-CLOSED: no decision means no command.
                None => Err(DeviceError::ApprovalTimeout {
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
                    approval_required: s.approval_required,
                    pending_approval: live_pending(s),
                    approval_grants: s.approval_grants.clone(),
                    goal: s.goal.clone(),
                    plan: s.plan.clone(),
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
                    approval_required: s.approval_required,
                    pending_approval: live_pending(s),
                    approval_grants: s.approval_grants.clone(),
                    goal: s.goal.clone(),
                    plan: s.plan.clone(),
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

    /// Wait (bounded) for an approval request to appear, then return it.
    ///
    /// BOTH properties matter. Bounded: the registration happens on a SPAWNED
    /// task, so a bare `loop {}` here would hang the suite forever if a
    /// regression stopped registering — a timeout fails loudly instead. And it
    /// must WAIT at all: checking `term_pending_approval` straight after
    /// `tokio::spawn` is a race, and three of these tests failed on exactly that
    /// before this helper existed.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    async fn wait_pending(mgr: &std::sync::Arc<TerminalManager>, sid: &str) -> PendingApprovalInfo {
        for _ in 0..250 {
            if let Some(p) = mgr.term_pending_approval(sid).await.unwrap() {
                return p;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("no approval request appeared within 5s — the gate did not register one");
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

    /// THE GATE'S CORE PROPERTY: no decision means the command does not run.
    ///
    /// This is what separates a gate from a delay. If an unanswered request
    /// proceeded, the operator would be rewarded for walking away from the
    /// prompt, and "approval required" would mean "approval requested".
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn an_unanswered_approval_does_not_run_and_says_so() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        let started = std::time::Instant::now();
        // Ask with a tiny budget so the test does not sit for a minute; the
        // production call passes APPROVAL_WAIT_MS.
        let err = mgr
            .term_await_approval(&sid, "rm -rf /", 300)
            .await
            .expect_err("an unanswered request must fail, never proceed");
        assert_eq!(err.code(), "approval_timeout");
        assert!(
            err.to_string().to_lowercase().contains("not run"),
            "the message must state that nothing ran: {err}"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the wait must honour its budget"
        );

        // The request must be GONE afterwards: a prompt for a command that has
        // already given up would invite the operator to answer a question
        // nobody is waiting for.
        assert!(
            mgr.term_pending_approval(&sid).await.unwrap().is_none(),
            "the pending request must be cleared on timeout"
        );

        mgr.term_close(&sid).await.ok();
    }

    /// An approval lets the command through; a denial does not, and the two are
    /// reported differently.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn approval_lets_it_through_and_denial_does_not() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        // Approve: the waiter returns Ok(true).
        {
            let mgr2 = mgr.clone();
            let sid2 = sid.clone();
            let waiter = tokio::spawn(async move {
                mgr2.term_await_approval(&sid2, "display version", 5_000)
                    .await
            });
            // Wait for the request to appear, then decide it.
            let id = wait_pending(&mgr, &sid).await.id;
            assert!(mgr
                .term_decide_approval(&sid, &id, true, false)
                .await
                .unwrap());
            assert!(
                waiter.await.unwrap().unwrap(),
                "an approved command proceeds"
            );
        }

        // Deny: the code says refused, NOT timed out.
        {
            let mgr2 = mgr.clone();
            let sid2 = sid.clone();
            let waiter =
                tokio::spawn(async move { mgr2.term_await_approval(&sid2, "save", 5_000).await });
            let id = wait_pending(&mgr, &sid).await.id;
            assert!(mgr
                .term_decide_approval(&sid, &id, false, false)
                .await
                .unwrap());
            let err = waiter.await.unwrap().unwrap_err();
            assert_eq!(
                err.code(),
                "approval_denied",
                "a refusal must not be reported as a timeout: the AI must not \
                 retry a command the operator said no to"
            );
        }

        mgr.term_close(&sid).await.ok();
    }

    /// The prompt is VISIBLE while it waits and gone the moment it is answered.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_pending_request_is_visible_on_session_info() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        let mgr2 = mgr.clone();
        let sid2 = sid.clone();
        let waiter =
            tokio::spawn(async move { mgr2.term_await_approval(&sid2, "vlan 100", 5_000).await });

        let seen = loop {
            let info = mgr.term_info(&sid).await.unwrap();
            if let Some(p) = info.pending_approval {
                break p;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };
        assert_eq!(
            seen.command, "vlan 100",
            "the prompt shows WHAT it will run"
        );
        assert!(seen.expires_in_ms > 0 && seen.expires_in_ms <= 60_000);
        assert!(mgr.term_info(&sid).await.unwrap().approval_required);

        let id = seen.id.clone();
        mgr.term_decide_approval(&sid, &id, true, false)
            .await
            .unwrap();
        waiter.await.unwrap().unwrap();

        // Answered: the prompt must not linger.
        assert!(mgr
            .term_info(&sid)
            .await
            .unwrap()
            .pending_approval
            .is_none());

        mgr.term_close(&sid).await.ok();
    }

    /// A STALE id must not decide a LIVE request.
    ///
    /// The panel renders the prompt from a polled list; a tab that rendered an
    /// earlier command would otherwise be able to approve the current one, and
    /// the operator's "yes" would attach to a command they never read.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_stale_request_id_cannot_decide_a_live_request() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        let mgr2 = mgr.clone();
        let sid2 = sid.clone();
        let waiter =
            tokio::spawn(async move { mgr2.term_await_approval(&sid2, "real", 5_000).await });
        let live = wait_pending(&mgr, &sid).await;

        assert!(
            !mgr.term_decide_approval(&sid, "ap-0-0", true, false)
                .await
                .unwrap(),
            "an id that does not match the live request must decide NOTHING"
        );
        // ...and the live request is still waiting, so the stale answer did not
        // silently consume it.
        wait_pending(&mgr, &sid).await;

        mgr.term_decide_approval(&sid, &live.id, true, false)
            .await
            .unwrap();
        waiter.await.unwrap().unwrap();
        mgr.term_close(&sid).await.ok();
    }

    /// Switching the mode OFF releases a waiting execute instead of abandoning it.
    ///
    /// An abandoned waiter holds the execute lock until its own deadline, which
    /// the operator experiences as a session that froze for no visible reason
    /// right after they turned the gate off.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn disarming_the_gate_releases_a_waiting_request() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        let mgr2 = mgr.clone();
        let sid2 = sid.clone();
        let waiter =
            tokio::spawn(async move { mgr2.term_await_approval(&sid2, "pending", 10_000).await });
        wait_pending(&mgr, &sid).await;

        assert!(!mgr.term_set_approval_required(&sid, false).await.unwrap());
        let err = tokio::time::timeout(std::time::Duration::from_secs(3), waiter)
            .await
            .expect("disarming must release the waiter promptly, not at the deadline")
            .unwrap()
            .unwrap_err();
        assert_eq!(err.code(), "approval_denied");

        mgr.term_close(&sid).await.ok();
    }

    /// A GRANTED command runs without asking — and only a granted one does.
    ///
    /// The whole point of the grant. Note it is asserted on the WAIT, not on a
    /// flag: `term_await_approval` returning `Ok(true)` immediately is what makes
    /// the execute path proceed, so that is the observable the operator
    /// experiences.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_granted_command_does_not_ask_again() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        // Approve `display version` WITH a grant.
        {
            let mgr2 = mgr.clone();
            let sid2 = sid.clone();
            let waiter = tokio::spawn(async move {
                mgr2.term_await_approval(&sid2, "display version", 5_000)
                    .await
            });
            let id = wait_pending(&mgr, &sid).await.id;
            assert!(mgr
                .term_decide_approval(&sid, &id, true, true)
                .await
                .unwrap());
            assert!(waiter.await.unwrap().unwrap());
        }
        assert_eq!(
            mgr.term_approval_grants(&sid).await.unwrap(),
            vec!["display".to_string()]
        );

        // A sibling command in the same family: NO wait, no prompt.
        let t = std::time::Instant::now();
        assert!(
            mgr.term_await_approval(&sid, "display ont info 0 1", 60_000)
                .await
                .unwrap(),
            "a granted family must run without asking"
        );
        assert!(
            t.elapsed() < std::time::Duration::from_secs(1),
            "it must not have waited at all"
        );
        assert!(
            mgr.term_pending_approval(&sid).await.unwrap().is_none(),
            "no request may be registered for a granted command"
        );

        // A DIFFERENT first word still asks.
        let mgr2 = mgr.clone();
        let sid2 = sid.clone();
        let waiter =
            tokio::spawn(async move { mgr2.term_await_approval(&sid2, "vlan 100", 400).await });
        wait_pending(&mgr, &sid).await;
        let err = waiter.await.unwrap().unwrap_err();
        assert_eq!(
            err.code(),
            "approval_timeout",
            "an ungranted command still asks"
        );

        mgr.term_close(&sid).await.ok();
    }

    /// A grant NEVER covers a command that chains — the injection property,
    /// asserted through the manager rather than only on the pure function.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_grant_does_not_cover_a_chained_command() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        {
            let mgr2 = mgr.clone();
            let sid2 = sid.clone();
            let waiter = tokio::spawn(async move {
                mgr2.term_await_approval(&sid2, "display version", 5_000)
                    .await
            });
            let id = wait_pending(&mgr, &sid).await.id;
            mgr.term_decide_approval(&sid, &id, true, true)
                .await
                .unwrap();
            waiter.await.unwrap().unwrap();
        }

        // Same first word, but it also does something else. It MUST ask.
        let mgr2 = mgr.clone();
        let sid2 = sid.clone();
        let waiter = tokio::spawn(async move {
            mgr2.term_await_approval(&sid2, "display version && rm -rf /", 400)
                .await
        });
        // Bounded wait, not a bare check: the registration happens on a spawned
        // task, so asserting immediately is a race (it was, and it failed).
        wait_pending(&mgr, &sid).await;
        waiter.await.unwrap().unwrap_err();
        mgr.term_close(&sid).await.ok();
    }

    /// The grant is derived from the SHOWN command, never from caller input.
    ///
    /// This is what stops a client widening its own permissions: it can only say
    /// "remember this", and `this` is whatever the operator had on screen.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_grant_cannot_be_widened_by_the_caller() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        let mgr2 = mgr.clone();
        let sid2 = sid.clone();
        // The operator is shown a harmless command.
        let waiter = tokio::spawn(async move {
            mgr2.term_await_approval(&sid2, "display version", 5_000)
                .await
        });
        let id = wait_pending(&mgr, &sid).await.id;
        mgr.term_decide_approval(&sid, &id, true, true)
            .await
            .unwrap();
        waiter.await.unwrap().unwrap();

        // Whatever the caller might have wanted, the only grant is the shown
        // command's first word.
        assert_eq!(
            mgr.term_approval_grants(&sid).await.unwrap(),
            vec!["display".to_string()]
        );
        mgr.term_close(&sid).await.ok();
    }

    /// A NON-grantable command approves ONCE, creating no grant.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn approving_a_chained_command_grants_nothing() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        let mgr2 = mgr.clone();
        let sid2 = sid.clone();
        let waiter = tokio::spawn(async move {
            mgr2.term_await_approval(&sid2, "vlan 100 && save", 5_000)
                .await
        });
        let id = wait_pending(&mgr, &sid).await.id;
        // The operator says "run it" AND "remember this" — but there is nothing
        // safe to remember.
        assert!(mgr
            .term_decide_approval(&sid, &id, true, true)
            .await
            .unwrap());
        assert!(waiter.await.unwrap().unwrap());
        assert!(
            mgr.term_approval_grants(&sid).await.unwrap().is_empty(),
            "a command whose first word does not describe it must not produce a grant"
        );
        mgr.term_close(&sid).await.ok();
    }

    /// Disarming clears every grant — re-arming is a fresh decision.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn disarming_the_gate_forgets_every_grant() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        let mgr2 = mgr.clone();
        let sid2 = sid.clone();
        let waiter = tokio::spawn(async move {
            mgr2.term_await_approval(&sid2, "display version", 5_000)
                .await
        });
        let id = wait_pending(&mgr, &sid).await.id;
        mgr.term_decide_approval(&sid, &id, true, true)
            .await
            .unwrap();
        waiter.await.unwrap().unwrap();
        assert_eq!(mgr.term_approval_grants(&sid).await.unwrap().len(), 1);

        mgr.term_set_approval_required(&sid, false).await.unwrap();
        assert!(
            mgr.term_approval_grants(&sid).await.unwrap().is_empty(),
            "grants must die with the mode: a later re-arm would otherwise inherit \
             permissions the operator granted in a context they have left"
        );

        // Re-arm: the same command asks again.
        mgr.term_set_approval_required(&sid, true).await.unwrap();
        let mgr2 = mgr.clone();
        let sid2 = sid.clone();
        let waiter = tokio::spawn(async move {
            mgr2.term_await_approval(&sid2, "display version", 400)
                .await
        });
        wait_pending(&mgr, &sid).await;
        waiter.await.unwrap().unwrap_err();
        mgr.term_close(&sid).await.ok();
    }

    /// Revocation, singular and total.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn grants_can_be_revoked() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;
        mgr.term_set_approval_required(&sid, true).await.unwrap();

        for cmd in ["display version", "show version"] {
            let mgr2 = mgr.clone();
            let sid2 = sid.clone();
            let c = cmd.to_string();
            let waiter =
                tokio::spawn(async move { mgr2.term_await_approval(&sid2, &c, 5_000).await });
            let id = wait_pending(&mgr, &sid).await.id;
            mgr.term_decide_approval(&sid, &id, true, true)
                .await
                .unwrap();
            waiter.await.unwrap().unwrap();
        }
        let mut g = mgr.term_approval_grants(&sid).await.unwrap();
        g.sort();
        assert_eq!(g, vec!["display".to_string(), "show".to_string()]);

        assert_eq!(
            mgr.term_revoke_grants(&sid, Some("display")).await.unwrap(),
            1
        );
        assert_eq!(
            mgr.term_approval_grants(&sid).await.unwrap(),
            vec!["show".to_string()]
        );
        // Revoking something absent is not an error — it reports "nothing".
        assert_eq!(
            mgr.term_revoke_grants(&sid, Some("display")).await.unwrap(),
            0
        );
        assert_eq!(mgr.term_revoke_grants(&sid, None).await.unwrap(), 1);
        assert!(mgr.term_approval_grants(&sid).await.unwrap().is_empty());

        mgr.term_close(&sid).await.ok();
    }

    /// A goal is set, REPLACED, CLEARED, and visible to whoever lists sessions.
    ///
    /// The third case is the one worth stating: clearing is a real act, not a
    /// no-op, because an objective that has been withdrawn must stop reading as
    /// current — otherwise the path view keeps measuring the run against
    /// something the operator already abandoned.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_goal_is_set_replaced_and_cleared() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;

        assert_eq!(
            mgr.term_goal(&sid).await.unwrap(),
            None,
            "no goal initially"
        );
        assert_eq!(
            mgr.term_set_goal(&sid, "  provision the ONU  ")
                .await
                .unwrap(),
            Some("provision the ONU".to_string()),
            "the stored goal is trimmed"
        );
        // Visible to the AI on the list it already polls — this is the whole
        // dispatch beat, and it needs no new tool.
        assert_eq!(
            mgr.term_info(&sid).await.unwrap().goal.as_deref(),
            Some("provision the ONU")
        );
        assert_eq!(
            mgr.term_list()
                .await
                .iter()
                .find(|s| s.id == sid)
                .unwrap()
                .goal
                .as_deref(),
            Some("provision the ONU")
        );

        // Replaced.
        assert_eq!(
            mgr.term_set_goal(&sid, "roll the VLAN back").await.unwrap(),
            Some("roll the VLAN back".to_string())
        );

        // Cleared — by an empty string, not by a separate verb.
        assert_eq!(mgr.term_set_goal(&sid, "   ").await.unwrap(), None);
        assert_eq!(mgr.term_goal(&sid).await.unwrap(), None);
        assert!(mgr.term_info(&sid).await.unwrap().goal.is_none());

        mgr.term_close(&sid).await.ok();
    }

    /// A long goal is CAPPED, on a char boundary, rather than truncated blindly.
    ///
    /// The cap exists because a goal rides every `terminal_list` and every audit
    /// read; the boundary matters because `&s[..n]` on a multi-byte goal is a
    /// panic, which is a failure this crate has already paid for three times
    /// (see `crate::text`).
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_long_goal_is_capped_on_a_char_boundary() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;

        // Every char is 3 bytes, so a naive byte cut lands mid-character.
        let long = "汉".repeat(400);
        let stored = mgr.term_set_goal(&sid, &long).await.unwrap().unwrap();
        assert!(
            stored.len() <= 512,
            "a goal must be capped so it does not inflate every list response \
             (stored {} bytes)",
            stored.len()
        );
        assert!(stored.len() > 400, "the cap must not be absurdly tight");
        // The result must be valid UTF-8 that ends on a boundary — proven by the
        // fact that we can round-trip it and count whole characters.
        assert_eq!(stored.chars().count(), stored.len() / 3);

        mgr.term_close(&sid).await.ok();
    }

    /// An unknown session is an error, never a silent success.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_goal_on_an_unknown_session_is_an_error() {
        let mgr = control_mgr();
        assert_eq!(
            mgr.term_set_goal("no-such-sid", "x")
                .await
                .unwrap_err()
                .code(),
            "session_not_found"
        );
        assert_eq!(
            mgr.term_goal("no-such-sid").await.unwrap_err().code(),
            "session_not_found"
        );
    }

    /// A plan is declared, REVISED, cleared, and visible to whoever lists sessions.
    ///
    /// Revision is the case that matters and the one a naive API gets wrong: a
    /// plan is not a log of intentions, it is the current statement of them. A run
    /// whose plan changed for good reason must be able to say so without the old
    /// plan lingering as if it still held.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_plan_is_declared_revised_and_cleared() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;

        assert!(
            mgr.term_plan(&sid).await.unwrap().is_empty(),
            "no plan initially"
        );

        let first = vec![
            "check the ONU is online".to_string(),
            "create VLAN 100".to_string(),
            "save the config".to_string(),
        ];
        assert_eq!(mgr.term_set_plan(&sid, &first).await.unwrap(), first);
        // The AI reads it off the list it already polls, like the goal.
        assert_eq!(
            mgr.term_info(&sid).await.unwrap().plan,
            first,
            "the plan must be visible on session info"
        );

        // REVISED: the middle step is dropped after the check made it unnecessary.
        let revised = vec![
            "check the ONU is online".to_string(),
            "save the config".to_string(),
        ];
        assert_eq!(mgr.term_set_plan(&sid, &revised).await.unwrap(), revised);
        assert_eq!(mgr.term_plan(&sid).await.unwrap(), revised);
        assert_eq!(
            mgr.term_info(&sid).await.unwrap().plan.len(),
            2,
            "a revision REPLACES; the old steps must not linger"
        );

        // CLEARED by an empty list.
        assert!(mgr.term_set_plan(&sid, &[]).await.unwrap().is_empty());
        assert!(mgr.term_plan(&sid).await.unwrap().is_empty());
        assert!(mgr.term_info(&sid).await.unwrap().plan.is_empty());

        mgr.term_close(&sid).await.ok();
    }

    /// A plan is CAPPED and its steps clipped on char boundaries.
    ///
    /// Both are remote-input bounds: this arrives from a client and rides every
    /// `terminal_list`. The boundary part matters for the same reason it does
    /// everywhere else in this crate — a naive byte cut panics, and this crate has
    /// paid for that three times.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_plan_is_capped_and_boundary_safe() {
        let mgr = control_mgr();
        let sid = open_pty(&mgr).await;

        // 40 steps offered, each 3-byte chars so a byte cut lands mid-character.
        let many: Vec<String> = (0..40)
            .map(|i| format!("{}汉", "步".repeat(100 + i)))
            .collect();
        let stored = mgr.term_set_plan(&sid, &many).await.unwrap();
        assert_eq!(stored.len(), 24, "the step count is capped");
        for step in &stored {
            assert!(
                step.len() <= 200,
                "each step is capped (got {})",
                step.len()
            );
            // Proven to end on a boundary by round-tripping as whole characters.
            assert_eq!(
                step.chars().count() * 3,
                step.len(),
                "a step must not be cut inside a character"
            );
        }

        // BLANK steps are dropped rather than stored as empty entries: a
        // numbering with holes in it reads as a missing step.
        let with_blanks = vec![
            "one".to_string(),
            "   ".to_string(),
            "".to_string(),
            "two".to_string(),
        ];
        assert_eq!(
            mgr.term_set_plan(&sid, &with_blanks).await.unwrap(),
            vec!["one".to_string(), "two".to_string()]
        );
        // And surrounding whitespace is trimmed.
        assert_eq!(
            mgr.term_set_plan(&sid, &["  spaced  ".to_string()])
                .await
                .unwrap(),
            vec!["spaced".to_string()]
        );

        mgr.term_close(&sid).await.ok();
    }

    /// An unknown session is an error, never a silent success.
    #[cfg(all(feature = "terminal", not(target_os = "windows")))]
    #[tokio::test]
    async fn a_plan_on_an_unknown_session_is_an_error() {
        let mgr = control_mgr();
        assert_eq!(
            mgr.term_set_plan("no-such-sid", &["x".to_string()])
                .await
                .unwrap_err()
                .code(),
            "session_not_found"
        );
        assert_eq!(
            mgr.term_plan("no-such-sid").await.unwrap_err().code(),
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
