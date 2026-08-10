//! PTY backend — local shell via portable-pty (`terminal` feature).

use super::{TermBackend, TermOutput};
use vale_agent_core::DeviceError;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize, SlavePty};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub struct PtyBackend {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Master handle — kept for real PTY resize (ResizePseudoConsole on
    /// Windows, TIOCSWINSZ on Unix).
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// The slave MUST stay alive: on Windows the HPCON closes (killing the
    /// shell) when both master and slave drop. (This is why the old code
    /// mem::forget'ed everything — we keep the handles properly instead.)
    /// Wrapped so the backend can be `Sync` behind `Box<dyn TermBackend>`;
    /// the lock is never taken — the box only needs to stay alive.
    _slave: Arc<Mutex<Box<dyn SlavePty + Send>>>,
    /// Child process — polled by the reaper thread so exits are waited on
    /// (no zombies/orphans). Never taken; kill() on close, reaper reaps.
    child: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
}

impl PtyBackend {
    pub fn spawn(shell: &str, rows: u16, cols: u16, tx: tokio::sync::mpsc::Sender<TermOutput>, sid: String) -> Result<Self, DeviceError> {
        let shell_cmd = if shell.is_empty() {
            if cfg!(windows) { "powershell.exe" } else { "bash" }
        } else { shell };

        tracing::debug!("[vale_command] PTY: spawning shell={shell_cmd}");

        let r = if rows > 0 { rows } else { 24 };
        let c = if cols > 0 { cols } else { 80 };
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| DeviceError::Internal { message: format!("PTY open: {e}") })?;

        let cmd = CommandBuilder::new(shell_cmd);
        let child = pair.slave.spawn_command(cmd)
            .map_err(|e| DeviceError::Internal { message: format!("spawn: {e}") })?;

        let mut reader = pair.master.try_clone_reader()
            .map_err(|e| DeviceError::Internal { message: format!("clone reader: {e}") })?;
        let writer: Box<dyn Write + Send> = Box::new(
            pair.master.take_writer()
                .map_err(|e| DeviceError::Internal { message: format!("take writer: {e}") })?,
        );

        let master: Box<dyn MasterPty + Send> = pair.master;
        let slave: Arc<Mutex<Box<dyn SlavePty + Send>>> = Arc::new(Mutex::new(pair.slave));
        let child_slot: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>> =
            Arc::new(Mutex::new(Some(child)));

        // Reader thread: pushes output to channel. blocking_send applies
        // backpressure — a stalled consumer pauses the shell (PTY semantics).
        let sid_reader = sid.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(TermOutput { session_id: sid_reader.clone(), data: buf[..n].to_vec() }).is_err() { break; }
                    }
                    Err(_) => break,
                }
            }
            tracing::debug!("[vale_command] PTY reader ended: {sid_reader}");
        });

        // Reaper thread: polls try_wait every 100ms so shell exits are
        // actually reaped (try_wait itself performs the wait). NEVER holds
        // the lock across a blocking call — close()'s kill() needs the lock.
        let child_reap = child_slot.clone();
        std::thread::spawn(move || {
            loop {
                let done = if let Ok(mut guard) = child_reap.lock() {
                    match guard.as_mut() {
                        Some(c) => matches!(c.try_wait(), Ok(Some(_)) | Err(_)),
                        None => true,
                    }
                } else {
                    true
                };
                if done { break; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            tracing::debug!("[vale_command] PTY reaper: shell exited: {sid}");
        });

        Ok(PtyBackend {
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(master)),
            _slave: slave,
            child: child_slot,
        })
    }
}

impl TermBackend for PtyBackend {
    fn write(&self, data: &[u8]) {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(data);
            let _ = w.flush();
        }
    }
    fn resize(&self, rows: u16, cols: u16) {
        // Real PTY resize — the shell gets SIGWINCH / ConPTY reflows.
        // (The old code wrote an ANSI escape into the shell's stdin.)
        if let Ok(m) = self.master.lock() {
            let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }
    fn close(&self) {
        // Kill the shell; the reaper thread observes the exit and reaps it.
        // Handles drop with the backend, closing the HPCON cleanly.
        if let Ok(mut guard) = self.child.lock() {
            if let Some(c) = guard.as_mut() {
                let _ = c.kill();
            }
        }
    }
}
