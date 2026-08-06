//! SSH backend — remote shell via SshSession (`terminal` feature).

use super::{TermBackend, TermOutput};
use crate::tools::ssh::SshSession;
use vale_command_core::DeviceError;
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
        let session = SshSession::connect(
            &host, port, &user,
            if password.is_empty() { None } else { Some(password) },
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
        // try_send: keystrokes must never block — drop when full
        let _ = self.write_tx.try_send(data.to_vec());
    }
    fn resize(&self, rows: u16, cols: u16) {
        let _ = self.resize_tx.try_send((rows, cols));
    }
    fn close(&self) {
        // The russh Handle drops with the backend, disconnecting the session
    }
}
