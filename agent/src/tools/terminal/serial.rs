//! Serial backend — raw byte I/O on a port taken from SerialPool (`terminal` feature).

use super::{TermBackend, TermOutput};
use crate::tools::serial::SerialPool;
use vale_agent_core::DeviceError;
use std::sync::Arc;

/// Serial link config (port + framing) — captured at open so an
/// auto-reconnect can reopen the SAME port with the SAME parameters
/// (P4b: unplug/reboot → session survives, port is re-opened when it
/// reappears).
#[derive(Clone)]
struct SerialCfg {
    port: String,
    baud: u32,
    data_bits: Option<u8>,
    parity: Option<String>,
    stop_bits: Option<u8>,
}

/// Open a port through the pool and return its (port, port_id). Blocking —
/// callers run this via spawn_blocking.
fn pool_open(
    pool: &Arc<SerialPool>,
    cfg: &SerialCfg,
) -> Result<(Box<dyn serialport::SerialPort>, String), DeviceError> {
    let (port_id, _) = pool.open(cfg.port.clone(), Some(cfg.baud), cfg.data_bits, cfg.parity.clone(), cfg.stop_bits)?;
    match pool.borrow_port(&port_id) {
        Some(port) => Ok((port, port_id)),
        None => {
            pool.release_port(&port_id);
            Err(DeviceError::SerialPortNotOpen { id: port_id })
        }
    }
}

/// Reader-loop body: read one chunk (short timeout so close/reconnect
/// signals are checked frequently). Returns Err on a real I/O error.
fn read_chunk(port: &mut dyn serialport::SerialPort, buf: &mut [u8]) -> std::io::Result<Vec<u8>> {
    port.set_timeout(std::time::Duration::from_millis(50)).ok();
    match port.read(buf) {
        Ok(n) if n > 0 => Ok(buf[..n].to_vec()),
        Ok(_) => Ok(Vec::new()),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

pub struct SerialBackend {
    write_tx: std::sync::mpsc::SyncSender<Vec<u8>>,
    close_tx: std::sync::mpsc::Sender<()>,
    // round-118: the pool entry must be dropped when the session closes so
    // the port can be reopened; without this the exclusivity guard leaked.
    pool: Option<Arc<SerialPool>>,
    port_id: Option<String>,
}

impl SerialBackend {
    /// `data_bits`/`parity`/`stop_bits` override the target-string framing
    /// (round-54: serial framing like 8E1/7N2 was never reachable from
    /// terminal_open — SerialPool supported it, nothing passed it through).
    #[allow(clippy::too_many_arguments)]
    pub async fn open(
        pool: Arc<SerialPool>,
        target: &str,
        data_bits: Option<u8>,
        parity: Option<String>,
        stop_bits: Option<u8>,
        auto_reconnect: bool,
        tx: tokio::sync::mpsc::Sender<TermOutput>, sid: String,
    ) -> Result<Self, DeviceError> {
        let cfg = super::parse_serial_config(target);
        let port_name = cfg.port;
        let baud = cfg.baud;
        // Explicit parameters win over the target string's framing.
        let data_bits = data_bits.or(cfg.data_bits);
        let parity = parity.or(cfg.parity);
        let stop_bits = stop_bits.or(cfg.stop_bits);
        let link = SerialCfg { port: port_name.clone(), baud, data_bits, parity, stop_bits };
        tracing::debug!("[vale-agent] Serial: opening {port_name} at {baud} baud (data_bits={:?} parity={:?} stop_bits={:?} auto_reconnect={})", link.data_bits, link.parity, link.stop_bits, auto_reconnect);

        // Open in pool, then BORROW the handle out (round-118: the old
        // take_port REMOVED the pool entry, defeating open()'s exclusivity
        // check — a second open of the same port passed and double-opened
        // the device). The pool entry stays as the guard; the session owns
        // its cloned handle and reads/writes without pool-lock contention.
        // release_port drops the entry on close.
        let (port, port_id) = {
            let pool = pool.clone();
            let link = link.clone();
            tokio::task::spawn_blocking(move || pool_open(&pool, &link))
                .await
                .map_err(|e| DeviceError::Internal {
                    message: format!("serial open task failed: {e}"),
                })?
        }?;
        let port = Arc::new(tokio::sync::Mutex::new(port));

        // Bounded write queue (was unbounded — a stalled device could buffer
        // keystrokes without limit). sync_channel(1024) + try_send below drops
        // keystrokes when full, matching the documented channel policy.
        let (write_tx, write_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(1024);
        let (close_tx, close_rx) = std::sync::mpsc::channel::<()>();

        // Reader thread — owns its own Arc clone, no pool lock needed.
        // P4b: with auto_reconnect, a read error (unplug / device reboot)
        // releases the pool entry and retries the SAME link config until the
        // port reappears; status lines are emitted so the user/AI sees the
        // session is alive and waiting.
        let port_r = port.clone();
        let pool_r = pool.clone();
        let link_r = link.clone();
        let tx_r = tx.clone();
        let sid_r = sid.clone();
        let port_id_r = port_id.clone();
        std::thread::spawn(move || {
            let mut port = port_r;
            let mut port_id = port_id_r;
            loop {
                if close_rx.try_recv().is_ok() { break; }
                let result = {
                    let mut p = port.blocking_lock();
                    let mut buf = vec![0u8; 4096];
                    read_chunk(p.as_mut(), &mut buf)
                };
                match result {
                    Ok(data) if !data.is_empty() => match tx_r.blocking_send(TermOutput { session_id: sid_r.clone(), data }) {
                        Ok(()) => {}
                        Err(_) => break,
                    },
                    Ok(_) => {}
                    Err(_) if !auto_reconnect => break,
                    Err(_) => {
                        // Port died — try to reopen with the same config.
                        tracing::info!("[vale-agent] Serial {port_name}: link lost, auto-reconnecting…");
                        let _ = tx_r.blocking_send(TermOutput {
                            session_id: sid_r.clone(),
                            data: format!("\r\n\x1b[33m[serial] {port_name}: link lost — waiting for the port to reappear (auto-reconnect)…\x1b[0m\r\n").into_bytes(),
                        });
                        // Release the dead entry so open() can succeed again.
                        {
                            let pool = pool_r.clone();
                            let id = port_id.clone();
                            let _ = std::thread::spawn(move || pool.release_port(&id)).join();
                        }
                        // Retry loop until the port comes back or the session
                        // is closed. pool_open is synchronous (serialport open
                        // with short timeout) — direct call is fine.
                        let mut attempts = 0u32;
                        loop {
                            if close_rx.try_recv().is_ok() { return; }
                            match pool_open(&pool_r, &link_r) {
                                Ok((new_port, new_id)) => {
                                    tracing::info!("[vale-agent] Serial {port_name}: reconnected (attempt {})", attempts + 1);
                                    let _ = tx_r.blocking_send(TermOutput {
                                        session_id: sid_r.clone(),
                                        data: format!("\r\n\x1b[32m[serial] {port_name}: reconnected\x1b[0m\r\n").into_bytes(),
                                    });
                                    port = Arc::new(tokio::sync::Mutex::new(new_port));
                                    port_id = new_id;
                                    break;
                                }
                                Err(_) => {
                                    attempts += 1;
                                    // Probe cadence: fast at first, then 2s.
                                    std::thread::sleep(std::time::Duration::from_millis(if attempts < 5 { 500 } else { 2000 }));
                                }
                            }
                        }
                    }
                }
            }
            tracing::debug!("[vale-agent] Serial reader ended: {sid_r}");
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

        Ok(SerialBackend { write_tx, close_tx, pool: Some(pool), port_id: Some(port_id) })
    }
}

impl TermBackend for SerialBackend {
    fn write(&self, data: &[u8]) {
        // try_send: drop-on-full (never block the caller on a stalled device)
        let _ = self.write_tx.try_send(data.to_vec());
    }
    fn write_async<'a>(&'a self, data: &'a [u8]) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        // round-107: the spawn_blocking + timeout ABANDONED a blocked task
        // per timeout (thread pile-up) AND the queued command was delivered
        // to the device later (the caller was told it failed, then it ran —
        // possibly twice). try_send + a short bounded retry: a full channel
        // means the writer is mid-block; failing fast (without enqueueing)
        // is the honest answer.
        let tx = self.write_tx.clone();
        let d = data.to_vec();
        Box::pin(async move {
            for _ in 0..10 {
                if tx.try_send(d.clone()).is_ok() { return Ok(()); }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            Err("serial write timed out (device not draining)".into())
        })
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
        // round-118: release the pool entry so the port can be reopened —
        // the old take_port removed it at open time (breaking exclusivity),
        // and without a release here the new borrow design would leak it.
        if let (Some(pool), Some(port_id)) = (self.pool.take(), self.port_id.take()) {
            pool.release_port(&port_id);
        }
    }
}
