//! SSH backend — remote shell via SshSession (`terminal` feature).

use super::{TermBackend, TermOutput};
use crate::tools::ssh::SshSession;
use vale_agent_core::DeviceError;
use tokio::sync::mpsc;

pub struct SshBackend {
    /// Keep session alive (owns the russh Handle)
    _session: SshSession,
    /// Send keystrokes to the task that owns the channel
    write_tx: mpsc::Sender<Vec<u8>>,
    /// Send resize to the task
    resize_tx: mpsc::Sender<(u16, u16)>,
}

impl SshBackend {
    pub async fn connect(
        target: &str, password: &str,
        rows: u16, cols: u16,
        tx: mpsc::Sender<TermOutput>, sid: String,
    ) -> Result<Self, DeviceError> {
        let (user, host, port) = super::parse_ssh_target(target);
        // Keychain fallback: an empty password param consults the OS keychain
        // for a previously saved credential (secret_set under the same target
        // key). Without this, terminal_open {kind:"ssh", target} failed with
        // "no authentication method provided" even when a password was stored.
        let mut pass = password.to_string();
        if pass.is_empty() {
            if let Ok(Some(stored)) = super::secret_get(target) {
                pass = stored;
            }
        }
        let session = SshSession::connect(
            &host, port, &user,
            if pass.is_empty() { None } else { Some(&pass) },
        ).await?;

        let (mut output_rx, write_tx, resize_tx) = session.open_shell(rows, cols).await?;

        // Forward raw output bytes as TermOutput (bounded send — awaits)
        tokio::spawn(async move {
            while let Some(data) = output_rx.recv().await {
                if tx.send(TermOutput { session_id: sid.clone(), data }).await.is_err() {
                    break;
                }
            }
        });

        Ok(SshBackend { _session: session, write_tx, resize_tx })
    }
}

impl TermBackend for SshBackend {
    fn write(&self, data: &[u8]) {
        // try_send: keystrokes must never block — drop when full. (The
        // round-53 'drop-oldest' idea doesn't apply: tokio mpsc Sender has
        // no try_recv, and a full 16-slot channel on a keystroke stream is
        // practically unreachable — the consumer drains faster than typing.)
        let _ = self.write_tx.try_send(data.to_vec());
    }
    fn resize(&self, rows: u16, cols: u16) {
        let _ = self.resize_tx.try_send((rows, cols));
    }
    fn close(&self) {
        // The russh Handle drops with the backend, disconnecting the session
    }
    fn terminate(&self) {
        // ^C to the remote shell — interrupts the foreground command without
        // dropping the connection (the session stays usable).
        let _ = self.write_tx.try_send(vec![0x03]);
    }
}
