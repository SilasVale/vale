//! Serial backend — raw byte I/O on a port taken from SerialPool (`terminal` feature).

use super::{TermBackend, TermOutput};
use crate::tools::serial::SerialPool;
use vale_agent_core::DeviceError;
use std::io::Read;
use std::sync::Arc;

pub struct SerialBackend {
    write_tx: std::sync::mpsc::SyncSender<Vec<u8>>,
    close_tx: std::sync::mpsc::Sender<()>,
}

impl SerialBackend {
    pub async fn open(
        pool: Arc<SerialPool>,
        target: &str,
        tx: tokio::sync::mpsc::Sender<TermOutput>, sid: String,
    ) -> Result<Self, DeviceError> {
        let (port_name, baud) = super::parse_serial_target(target);
        tracing::debug!("[vale-agent] Serial: opening {port_name} at {baud} baud");

        // Open in pool, then take ownership out — session owns the port,
        // so reads/writes never contend on the shared pool lock. The open
        // itself can block on flaky hardware, so it runs off-executor.
        let port = {
            let pool = pool.clone();
            let port_name = port_name.clone();
            tokio::task::spawn_blocking(move || {
                let (port_id, _) = pool.open(port_name, Some(baud), None, None, None)?;
                pool.take_port(&port_id)
                    .ok_or_else(|| DeviceError::SerialPortNotOpen { id: port_id.clone() })
            })
            .await
            .map_err(|e| DeviceError::Internal {
                message: format!("serial open task failed: {e}"),
            })??
        };
        let port = Arc::new(tokio::sync::Mutex::new(port));

        // Bounded write queue (was unbounded — a stalled device could buffer
        // keystrokes without limit). sync_channel(1024) + try_send below drops
        // keystrokes when full, matching the documented channel policy.
        let (write_tx, write_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(1024);
        let (close_tx, close_rx) = std::sync::mpsc::channel::<()>();

        // Reader thread — owns its own Arc clone, no pool lock needed
        let port_r = port.clone();
        std::thread::spawn(move || {
            loop {
                if close_rx.try_recv().is_ok() { break; }
                let result = {
                    let mut p = port_r.blocking_lock();
                    // Use a short timeout so we check close signal frequently
                    p.set_timeout(std::time::Duration::from_millis(50)).ok();
                    let mut buf = vec![0u8; 4096];
                    match p.read(&mut buf) {
                        Ok(n) if n > 0 => Ok(buf[..n].to_vec()),
                        Ok(_) => Ok(Vec::new()),
                        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(Vec::new()),
                        Err(e) => Err(e),
                    }
                };
                match result {
                    Ok(data) if !data.is_empty() => match tx.blocking_send(TermOutput { session_id: sid.clone(), data }) {
                        // blocking_send: backpressure on the serial device
                        Ok(()) => {}
                        Err(_) => break,
                    },
                    Err(_) => break,
                    _ => {}
                }
            }
            tracing::debug!("[vale-agent] Serial reader ended: {sid}");
        });

        // Writer thread — direct byte write, no hex encoding
        let port_w = port.clone();
        std::thread::spawn(move || {
            while let Ok(data) = write_rx.recv() {
                let mut p = port_w.blocking_lock();
                if p.write_all(&data).is_err() || p.flush().is_err() {
                    break;
                }
            }
        });

        Ok(SerialBackend { write_tx, close_tx })
    }
}

impl TermBackend for SerialBackend {
    fn write(&self, data: &[u8]) {
        // try_send: drop-on-full (never block the caller on a stalled device)
        let _ = self.write_tx.try_send(data.to_vec());
    }
    fn resize(&self, _rows: u16, _cols: u16) {}
    fn close(&self) {
        let _ = self.close_tx.send(());
    }
    // A serial port has no process to abort — a timed-out write to a device
    // cannot be "killed". Nothing to do (the session stays open).
    fn terminate(&self) {}
}

impl Drop for SerialBackend {
    fn drop(&mut self) {
        let _ = self.close_tx.send(());
    }
}
