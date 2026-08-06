//! SSH session via russh — used by the terminal SshBackend (`terminal` feature).

use std::sync::Arc;

use russh::client::{self, connect, Handle};
use russh::ChannelMsg;
use tokio::sync::mpsc;

use vale_command_core::DeviceError;

/// Minimal SSH handler that accepts all server keys.
/// (Host-key verification is a known gap — TOFU/known-hosts is deferred.)
struct SshHandler;
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
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
        let config = Arc::new(client::Config::default());
        let mut handle: Handle<SshHandler> =
            connect(config, format!("{host}:{port}"), SshHandler)
                .await
                .map_err(|e| DeviceError::SshConnectFailed {
                    host: host.to_string(),
                    reason: format!("connect failed: {e}"),
                })?;

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
                return Err(DeviceError::SshConnectFailed {
                    host: host.to_string(),
                    reason: "password authentication rejected".into(),
                });
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
