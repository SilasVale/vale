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
    /// round-87: Option so the reaper can TAKE it on natural exit — dropping
    /// the fd lets the master reader see EOF (the old Arc-clone drop kept
    /// the backend's reference, so the reader never EOF'd and the session
    /// hung 'live' until the 15-min sweeper).
    _slave: Arc<Mutex<Option<Box<dyn SlavePty + Send>>>>,
    /// Child process — polled by the reaper thread so exits are waited on
    /// (no zombies/orphans). Never taken; kill() on close, reaper reaps.
    child: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
    /// Natural-exit code captured by the reaper (round-60).
    exit_code: Arc<Mutex<Option<i32>>>,
}

impl PtyBackend {
    pub fn spawn(shell: &str, rows: u16, cols: u16, tx: tokio::sync::mpsc::Sender<TermOutput>, sid: String) -> Result<Self, DeviceError> {
        let shell_cmd = if shell.is_empty() {
            if cfg!(windows) { "powershell.exe" } else { "bash" }
        } else { shell };

        tracing::debug!("[vale-agent] PTY: spawning shell={shell_cmd}");

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
        let slave: Arc<Mutex<Option<Box<dyn SlavePty + Send>>>> = Arc::new(Mutex::new(Some(pair.slave)));
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
            tracing::debug!("[vale-agent] PTY reader ended: {sid_reader}");
        });

        // Reaper thread: polls try_wait every 100ms so shell exits are
        // actually reaped (try_wait itself performs the wait). NEVER holds
        // the lock across a blocking call — close()'s kill() needs the lock.
        // The shell's exit code when it dies naturally — captured by the
        // reaper, read via TermBackend::exit_code (round-60: the panel/audit
        // can distinguish a clean `exit` from a crash).
        let exit_slot: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));
        let exit_slot_reap = exit_slot.clone();
        let child_reap = child_slot.clone();
        // round-87: the reader thread never EOFs after a natural shell exit —
        // a PTY master read only returns EOF when ALL slave fds are closed,
        // and the backend's _slave kept one open until the session was
        // dropped (15-min sweeper). The reaper now TAKES the slave out of
        // the shared slot on exit — dropping the fd releases the master read
        // so the reader EOFs, the drainer finalizes the session, and the
        // exit code is delivered.
        let slave_reap = slave.clone();
        std::thread::spawn(move || {
            loop {
                let (done, code) = if let Ok(mut guard) = child_reap.lock() {
                    match guard.as_mut() {
                        Some(c) => match c.try_wait() {
                            Ok(Some(status)) => (true, Some(status.exit_code() as i32)),
                            Ok(None) => (false, None),
                            Err(_) => (true, None),
                        },
                        None => (true, None),
                    }
                } else {
                    (true, None)
                };
                if done {
                    if let Some(code) = code {
                        if let Ok(mut slot) = exit_slot_reap.lock() {
                            *slot = Some(code);
                        }
                    }
                    // The child exited NATURALLY (user typed `exit`, pty EOF)
                    // — drop the slot so a later close() cannot SIGKILL a
                    // reaped (possibly pid-recycled) pid (round-50). With the
                    // slot empty, close() below skips the kill entirely.
                    if let Ok(mut guard) = child_reap.lock() {
                        if let Some(c) = guard.as_mut() {
                            if matches!(c.try_wait(), Ok(Some(_)) | Err(_)) {
                                guard.take();
                            }
                        }
                    }
                    // TAKE the slave out of the shared slot and drop it —
                    // the reader's blocking read sees EOF once ALL slave fds
                    // are gone (round-87). Unlike an Arc-clone drop, this
                    // actually releases the fd (the backend's Arc would keep
                    // it alive until the session is removed).
                    if let Ok(mut guard) = slave_reap.lock() {
                        guard.take();
                    }
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            tracing::debug!("[vale-agent] PTY reaper: shell exited: {sid}");
        });

        Ok(PtyBackend {
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(master)),
            _slave: slave,
            child: child_slot,
            exit_code: exit_slot,
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
                // If the shell already exited NATURALLY the reaper dropped
                // the slot (or is about to) — killing a reaped pid is a
                // use-after-reap hazard (the OS may have recycled it).
                // try_wait once: still running → kill; already exited →
                // leave it for the reaper (round-50).
                if matches!(c.try_wait(), Ok(None)) {
                    let _ = c.kill();
                }
            }
        }
    }
    fn exit_code(&self) -> Option<i32> {
        self.exit_code.lock().ok().and_then(|g| *g)
    }
    fn terminate(&self) {
        // Send ^C to the shell's input (round-92) — the old code killed the
        // whole process group with `kill -9 -- -{pid}`. forkpty makes the
        // shell a session leader, so pid == pgid and the group kill SIGKILLed
        // the shell itself: an execute-timeout destroyed the user's session
        // (cwd/env all gone, session unregistered on reaper EOF) despite the
        // documented contract "stop the command, not the shell". ^C to the
        // master interrupts the foreground job (make, agent_update, sleep —
        // the same behavior SSH's terminate has with the remote shell) and
        // keeps the session usable, matching ssh.rs.
        // round-97: try_lock, never block — a stalled write_all (n_tty input
        // queue full, foreground process not reading stdin) holds the writer
        // mutex forever, and terminate() IS the abort that is supposed to
        // unblock that queue. Waiting on the lock would deadlock the
        // execute-timeout path (term_terminate awaits forever). Best-effort:
        // if the writer is busy, the queue is already full of bytes the
        // foreground process isn't reading — ^C can't be delivered anyway
        // until it does.
        if let Ok(mut w) = self.writer.try_lock() {
            let _ = w.write_all(&[0x03]);
        }
    }
}
