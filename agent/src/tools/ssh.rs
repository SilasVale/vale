//! SSH session via russh — used by the terminal SshBackend (`terminal` feature).

use std::sync::Arc;

use russh::client::{self, connect, Handle};
use russh::ChannelMsg;
use tokio::sync::mpsc;

use vale_agent_core::DeviceError;

/// SSH handler with trust-on-first-use host-key verification.
///
/// The first connection to a host records its key fingerprint in
/// vale-known-hosts.json (next to the exe); later connections REJECT a
/// changed key. Without this, any MITM could present its own key and capture
/// the SSH password (the old handler accepted every key). Keyed by
/// "user@host:port" so the same host under a different identity is not
/// silently trusted.
struct SshHandler {
    /// Key to record on first use ("user@host:port").
    trust_key: String,
}

fn fingerprint_of(key: &russh::keys::ssh_key::PublicKey) -> String {
    // SHA-256 fingerprint, stable hex — mirrors ssh-keygen's fingerprint.
    use russh::keys::ssh_key::HashAlg;
    key.fingerprint(HashAlg::Sha256).to_string()
}

fn known_hosts_path() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
        .join("vale-known-hosts.json")
}

/// Parse failure is an Err — the caller (check_server_key) fails the
/// connection. A half-written file must NOT silently become an empty trust
/// table (which would re-TOFU every host and re-open the MITM window the
/// save-side fail-closed protects against) (round-57).
/// Serializes the TOFU read-modify-write (round-118): concurrent first-time
/// connections lost one host's fingerprint (last-save-wins), re-opening that
/// host's MITM window.
static KNOWN_HOSTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn load_known_hosts() -> Result<serde_json::Map<String, serde_json::Value>, std::io::Error> {
    let s = std::fs::read_to_string(known_hosts_path())?;
    serde_json::from_str(&s).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Missing file is a FRESH trust table (round-68): round-57 propagated the
/// NotFound, so check_server_key aborted with UnknownKey BEFORE the first-use
/// TOFU branch could write the file — SSH could never bootstrap on a fresh
/// install (nothing creates vale-known-hosts.json). NotFound → empty map;
/// corrupt/other errors still propagate so check_server_key FAILS CLOSED
/// (the re-TOFU-everything MITM protection round-57 built stays intact).
fn load_known_hosts_or_empty() -> Result<serde_json::Map<String, serde_json::Value>, std::io::Error> {
    match load_known_hosts() {
        Ok(map) => Ok(map),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(e) => Err(e),
    }
}

/// Atomic write (round-57): temp + rename in the same directory — the old
/// std::fs::write (truncate + write) left a half-written file on power loss,
/// which load then silently swallowed as an empty trust table.
fn save_known_hosts(map: &serde_json::Map<String, serde_json::Value>) -> std::io::Result<()> {
    let p = known_hosts_path();
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(map).unwrap_or_else(|_| "{}".into()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = fingerprint_of(key);
        // round-118: TOFU is a load-insert-save of the whole table — two
        // concurrent first-time connections (multi-threaded runtime, parallel
        // terminal_open) both read the empty map and last-save-wins silently
        // dropped one host's fingerprint, re-opening that host's MITM window
        // (the same lost-update class round-101 fixed for secrets via
        // STORE_LOCK). Serialize the whole read-modify-write.
        let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // A corrupt file (half write, disk error) FAILS the connection —
        // re-TOFUing everything would silently re-open the MITM window.
        let mut hosts = load_known_hosts_or_empty().map_err(|_| russh::Error::UnknownKey)?;
        match hosts.get(&self.trust_key) {
            // First use — record and trust (TOFU). FAIL CLOSED on persistence
            // failure: a write error (read-only install dir, disk full) must
            // not silently turn off MITM protection — every later connection
            // would re-trust a fresh attacker key.
            None => {
                hosts.insert(self.trust_key.clone(), serde_json::Value::String(fp));
                save_known_hosts(&hosts).map_err(|e| {
                    // No Io variant in russh::Error — UnknownKey is the closest
                    // (aborts the connection like a host-key mismatch).
                    let _ = e;
                    russh::Error::UnknownKey
                })?;
                Ok(true)
            }
            // Known host — reject a changed key (possible MITM).
            Some(stored) => Ok(stored.as_str() == Some(fp.as_str())),
        }
    }
}

// ── Core SSH Session ─────────────────────────────────────────

/// A single SSH connection with an interactive PTY shell.
pub struct SshSession {
    pub host: String,
    pub username: String,
    handle: Handle<SshHandler>,
}

impl SshSession {
    /// Create a new SSH connection with password authentication.
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        password: Option<&str>,
    ) -> Result<Self, DeviceError> {
        // A dead host (firewall DROP, blackholed) used to hang connect()
        // forever — the terminal_open caller never got a timeout. The
        // inactivity_timeout below is only armed AFTER the handshake
        // (round-53 verified in russh), so the TCP connect + SSH-id exchange
        // window is covered by an explicit 15s timeout here; otherwise a
        // blackholed address blocks for the OS connect timeout (Windows
        // ~21s, Linux up to ~130s).
        let config = Arc::new(client::Config {
            // round-95: the old values were inverted — inactivity_timeout 15s
            // with keepalive_interval 30s meant ANY session with no incoming
            // bytes for 15s died before the keepalive ever fired (a `sleep
            // 20` over SSH, or 16s of reading output, killed the session).
            // keepalive must fire BEFORE the inactivity timer expires: 5s
            // keepalive keeps the connection alive; 30s inactivity is the
            // real dead-peer bound.
            inactivity_timeout: Some(std::time::Duration::from_secs(30)),
            keepalive_interval: Some(std::time::Duration::from_secs(5)),
            ..Default::default()
        });
        // TOFU host-key verification — keyed by user@host:port so a changed
        // key (MITM) is rejected on later connections.
        let handler = SshHandler {
            trust_key: format!("{username}@{host}:{port}"),
        };
        let mut handle: Handle<SshHandler> =
            match tokio::time::timeout(std::time::Duration::from_secs(15), connect(config, format!("{host}:{port}"), handler)).await {
                Ok(Ok(h)) => h,
                Ok(Err(e)) => return Err(DeviceError::SshConnectFailed {
                    host: host.to_string(),
                    reason: format!("connect failed: {e}"),
                }),
                Err(_) => return Err(DeviceError::SshTimeout { host: host.to_string() }),
            };

        // Authenticate
        if let Some(pass) = password {
            let auth = handle
                .authenticate_password(username, pass)
                .await
                .map_err(|e| DeviceError::SshConnectFailed {
                    host: host.to_string(),
                    reason: format!("password auth failed: {e}"),
                })?;
            if !auth.success() {
                // Keyboard-interactive fallback: servers with UsePAM /
                // AD / LDAP / 2FA sshd may reject the password method
                // outright and offer only keyboard-interactive. Answer a
                // single password prompt with the same password (bounded —
                // a 2FA/OTP second prompt cannot be answered by a
                // single-password UI).
                use russh::client::KeyboardInteractiveAuthResponse;
                use russh::MethodKind;
                let mut ki_ok = false;
                if let russh::client::AuthResult::Failure { remaining_methods, .. } = auth {
                    if remaining_methods.contains(&MethodKind::KeyboardInteractive) {
                        let mut resp = handle
                            .authenticate_keyboard_interactive_start(username, None)
                            .await
                            .map_err(|e| DeviceError::SshConnectFailed {
                                host: host.to_string(),
                                reason: format!("keyboard-interactive start failed: {e}"),
                            })?;
                        for _ in 0..4 {
                            match resp {
                                KeyboardInteractiveAuthResponse::Success => { ki_ok = true; break; }
                                KeyboardInteractiveAuthResponse::Failure { .. } => break,
                                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                                    // Answer ONLY a password-looking prompt with
                                    // the password — the first non-empty prompt
                                    // may be an OTP/2FA challenge (Duo, TOTP),
                                    // and sending the real password there is a
                                    // credential leak to the wrong factor.
                                    // A password prompt: hidden echo (p.echo
                                    // false) + prompt text hints (password/
                                    // passphrase/passcode). Empty prompts get
                                    // empty responses (russh requires equal
                                    // lengths).
                                    let responses: Vec<String> = prompts
                                        .iter()
                                        .map(|p| {
                                            let t = p.prompt.to_lowercase();
                                            let pass_like = !p.echo
                                                && (t.contains("password")
                                                    || t.contains("passphrase")
                                                    || t.contains("passcode"));
                                            if pass_like { pass.to_string() } else { String::new() }
                                        })
                                        .collect();
                                    resp = handle
                                        .authenticate_keyboard_interactive_respond(responses)
                                        .await
                                        .map_err(|e| DeviceError::SshConnectFailed {
                                            host: host.to_string(),
                                            reason: format!("keyboard-interactive respond failed: {e}"),
                                        })?;
                                }
                            }
                        }
                    }
                }
                if !ki_ok {
                    return Err(DeviceError::SshConnectFailed {
                        host: host.to_string(),
                        reason: "password authentication rejected (password or keyboard-interactive)".into(),
                    });
                }
            }
        } else {
            return Err(DeviceError::SshConnectFailed {
                host: host.to_string(),
                reason: "no authentication method provided (password required)".into(),
            });
        }

        Ok(Self {
            host: host.to_string(),
            username: username.to_string(),
            handle,
        })
    }

    /// Open an interactive PTY shell on this connection.
    /// Returns (output_rx, write_tx, resize_tx).
    /// A background task multiplexes read/write/resize on the channel.
    /// Output is bounded (backpressure); write/resize are bounded and the
    /// caller uses `try_send` — keystrokes never block.
    pub async fn open_shell(
        &self,
        rows: u16,
        cols: u16,
    ) -> Result<
        (
            mpsc::Receiver<Vec<u8>>,
            mpsc::Sender<Vec<u8>>,
            mpsc::Sender<(u16, u16)>,
        ),
        DeviceError,
    > {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| DeviceError::Internal {
                message: format!("open channel: {e}"),
            })?;

        let r = if rows > 0 { rows } else { 24 };
        let c = if cols > 0 { cols } else { 80 };
        channel
            .request_pty(true, "xterm-256color", c as u32, r as u32, 0, 0, &[])
            .await
            .map_err(|e| DeviceError::Internal {
                message: format!("pty request: {e}"),
            })?;

        channel
            .request_shell(true)
            .await
            .map_err(|e| DeviceError::Internal {
                message: format!("shell request: {e}"),
            })?;

        // Output is bounded: a stalled reader pauses the channel task
        // (backpressure on the SSH stream). Write/resize are small and the
        // backend sends with try_send — dropping when full, never blocking.
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(256);
        let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(16);
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(16);

        // Single task owns the channel, handles read+write+resize via select
        tokio::spawn(async move {
            let mut ch = channel;
            loop {
                tokio::select! {
                    msg = ch.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => match output_tx.send(Vec::from(&*data)).await {
                                // bounded send: awaits if the queue is full
                                Ok(()) => {}
                                Err(_) => break,
                            },
                            Some(ChannelMsg::Eof) | None => break,
                            _ => {}
                        }
                    }
                    data = write_rx.recv() => {
                        match data {
                            Some(d) => { if ch.data(&d[..]).await.is_err() { break; } }
                            None => break,
                        }
                    }
                    resize = resize_rx.recv() => {
                        match resize {
                            // Channel carries (rows, cols); window_change takes (width=cols, height=rows)
                            Some((rows, cols)) => {
                                let _ = ch.window_change(cols as u32, rows as u32, 0, 0).await;
                            }
                            None => break,
                        }
                    }
                }
            }
        });

        Ok((output_rx, write_tx, resize_tx))
    }
}
