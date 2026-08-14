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
        // round-107: SshSession::connect's internal 15s only bounds the TCP
        // + handshake — the AUTH and channel-open phases were bare awaits; a
        // peer that completes the handshake then stalls (tarpit, sshd stuck
        // on reverse-DNS) hung terminal_open forever. Bound the whole
        // connect+auth+open_shell sequence.
        let (session, output_rx, write_tx, resize_tx) = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            async {
                let session = SshSession::connect(
                    &host, port, &user,
                    if pass.is_empty() { None } else { Some(&pass) },
                ).await?;
                let (output_rx, write_tx, resize_tx) = session.open_shell(rows, cols).await?;
                Ok::<_, DeviceError>((session, output_rx, write_tx, resize_tx))
            },
        )
        .await
        .map_err(|_| DeviceError::SshTimeout { host: host.to_string() })??;

        let mut output_rx = output_rx;

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
        // Keystrokes must never block — drop when full (round-53).
        let _ = self.write_tx.try_send(data.to_vec());
    }
    fn write_async<'a>(&'a self, data: &'a [u8]) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        // round-103: RELIABLE write for terminal_execute — the old
        // try_send dropped the whole command when the channel was full
        // (ssh channel task blocked on remote TCP backpressure), and the
        // wait loop reported a success-like 'idle'. Await the send instead;
        // the caller (term_write_bytes) is async so no tokio worker blocks.
        // round-104: BOUNDED — an awaited send on a full channel hangs
        // forever when the remote never drains (foreground sleep 300 with a
        // full n_tty queue, wedged peer where keepalives keep inactivity
        // from firing).
        // round-105: the timeout result is PROPAGATED (not discarded) — a
        // dropped command must surface as an execute error, not a
        // success-shaped 'idle' with an audit trail for a command that never
        // reached the shell.
        let tx = self.write_tx.clone();
        let d = data.to_vec();
        Box::pin(async move {
            match tokio::time::timeout(std::time::Duration::from_secs(5), tx.send(d)).await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(_)) => Err("ssh write channel closed".into()),
                Err(_) => Err("ssh write timed out after 5s (remote not draining)".into()),
            }
        })
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
        // round-102: bounded retry without blocking sleeps — a dropped ^C
        // leaves the timed-out command running on the remote.
        for _ in 0..8 {
            if self.write_tx.try_send(vec![0x03]).is_ok() { return; }
            std::thread::yield_now();
        }
    }
}
