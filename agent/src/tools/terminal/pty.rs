//! PTY backend — local shell via portable-pty (`terminal` feature).

use super::{TermBackend, TermOutput};
use vale_agent_core::DeviceError;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize, SlavePty};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub struct PtyBackend {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// round-108: one in-flight blocking write per session — a timed-out
    /// spawn_blocking task holds the writer mutex until the queue drains;
    /// without this gate every subsequent write spawns ANOTHER parked task
    /// (thread pile-up). When set, write_async fails fast.
    write_in_flight: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// round-110: unix-ms of the last write timeout — a wedged queue
    /// re-accumulates a parked thread per retry; after a timeout, new
    /// writes fail fast for this window instead of piling on.
    last_write_timeout: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// round-115: unix-ms when the current in-flight write STARTED — a
    /// dropped caller future (client disconnect mid-write) leaves the gate
    /// set forever; a gate older than the 5s write timeout is stale and a
    /// fresh write may clear it and retry.
    last_write_start: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Master handle — kept for real PTY resize (ResizePseudoConsole on
    /// Windows, TIOCSWINSZ on Unix).
    /// review #3: TRUE only when the pwsh shell-integration script was
    /// ACTUALLY appended to the spawn command. execute's 633 wait path keys
    /// on this via term_marker_injected instead of trusting the shell NAME
    /// (missing script = silent injection failure = every execute burning
    /// the full timeout).
    marker_injected: bool,
    /// review #9: an explicit close kills the child; the reaper then records
    /// the kill's exit status like a natural end. Contract says exit_code is
    /// None after terminal_close — this flag enforces it.
    closed_explicitly: std::sync::Arc<std::sync::atomic::AtomicBool>,
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
    /// stage-n: shared reader handle — the reaper (natural exit) and close()
    /// (explicit close) drop it so the reader thread ends. Windows ConPTY
    /// never EOFs its output pipe while the HPCON lives; dropping the reader
    /// is the safe way to end the thread (vs ClosePseudoConsole, which can
    /// kill unrelated processes on a shared console host).
    reader_slot: Arc<Mutex<Option<Box<dyn Read + Send>>>>,
    /// Natural-exit code captured by the reaper (round-60).
    exit_code: Arc<Mutex<Option<i32>>>,
}

impl PtyBackend {
    pub fn spawn(shell: &str, rows: u16, cols: u16, tx: tokio::sync::mpsc::Sender<TermOutput>, sid: String) -> Result<Self, DeviceError> {
        let shell_cmd = if shell.is_empty() {
            // stage-m: the ONLY supported Windows shell is pwsh (PowerShell
            // 7) — it has clean OSC 633 shell integration. Windows
            // PowerShell 5.1 is NOT supported: its PSReadLine 2.0.0
            // re-echoes the injected sequences as input → `>>` (vscode#236841).
            if cfg!(windows) { "pwsh" } else { "bash" }
        } else { shell };

        tracing::debug!("[vale-agent] PTY: spawning shell={shell_cmd}");

        let r = if rows > 0 { rows } else { 24 };
        let c = if cols > 0 { cols } else { 80 };
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| DeviceError::Internal { message: format!("PTY open: {e}") })?;

        // stage-m (VS Code shell integration): PowerShell sessions get the
        // OSC 633 injection — a Prompt override + PSConsoleHostReadLine wrap
        // (transplanted from microsoft/vscode shellIntegration.ps1) so every
        // prompt/command boundary arrives as an invisible OSC 633 sequence.
        // The agent consumes 633;D;<rc> for execute completion (no wrapper
        // text in the user's terminal — the old __VALE_ marker wrapper and
        // its front-end filter are gone). The script is written to the
        // install dir at boot (main.rs) and dot-sourced via -Command, same
        // shape as VS Code's `pwsh -noexit -command . shellIntegration.ps1`.
        // mut only needed on Windows (shell-integration injection below);
        // Linux builds see an unused mut (allowed).
        #[allow(unused_mut)]
        let mut cmd = CommandBuilder::new(shell_cmd);
        // review #3: whether the pwsh integration was ACTUALLY injected.
        // Function-scoped (not inside the cfg(windows) block) so the
        // PtyBackend literal below sees it on both platforms; Linux shells
        // never inject (false).
        #[allow(unused_mut, unused_assignments)]
        let mut marker_injected = false;
        #[cfg(windows)]
        {
            let lower = shell_cmd.to_ascii_lowercase();
            // stage-m: OSC 633 injection is enabled for pwsh (PowerShell 7+)
            // ONLY. Windows PowerShell 5.1 + PSReadLine 2.0.0 + ConPTY
            // re-echoes the injected OSC sequences as INPUT events — every
            // prompt then renders a `>>` continuation marker and command
            // echo fragments (verified on d1 1.0.146; VS Code has the same
            // report, vscode#236841). 5.1 sessions therefore get NO
            // injection: display stays perfectly clean and execute falls
            // back to the quiet-period completion path. The Rust 633
            // consumer (shell_integration.rs) still serves pwsh sessions.
            if lower.contains("pwsh") {
                let script = crate::paths::install_dir()
                    .join("shell-integration")
                    .join("shellIntegration.ps1");
                if script.exists() {
                    marker_injected = true;
                    // Fresh 128-bit nonce for this session's injection — the
                    // script echoes it back inside `633;E;<cmd>;<nonce>` so
                    // command lines from the terminal stream can be trusted.
                    let mut nbuf = [0u8; 16];
                    let _ = getrandom::getrandom(&mut nbuf);
                    let nonce: String = nbuf.iter().map(|b| format!("{b:02x}")).collect();
                    cmd.env("VALE_NONCE", &nonce);
                    // stage-m A: VS Code's exact injection shape for Windows
                    // PowerShell (terminalEnvironment.ts:332):
                    //   ['-noexit', '-command', 'try { . "{0}\shellIntegration.ps1" } catch {}{1}']
                    // Double quotes + try/catch swallow the execution-policy
                    // error so a restricted policy cannot wedge the shell.
                    // The `{1}` (empty) is VS Code's trailing-args slot.
                    cmd.args([
                        "-NoExit",
                        "-Command",
                        &format!(
                            "try {{ . \"{}\" }} catch {{}}",
                            script.to_string_lossy().replace('"', "\\\"")
                        ),
                    ]);
                }
            }
        }
        let child = pair.slave.spawn_command(cmd)
            .map_err(|e| DeviceError::Internal { message: format!("spawn: {e}") })?;

        let reader = pair.master.try_clone_reader()
            .map_err(|e| DeviceError::Internal { message: format!("clone reader: {e}") })?;
        let writer: Box<dyn Write + Send> = Box::new(
            pair.master.take_writer()
                .map_err(|e| DeviceError::Internal { message: format!("take writer: {e}") })?,
        );

        let master: Box<dyn MasterPty + Send> = pair.master;
        let slave: Arc<Mutex<Option<Box<dyn SlavePty + Send>>>> = Arc::new(Mutex::new(Some(pair.slave)));
        let child_slot: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>> =
            Arc::new(Mutex::new(Some(child)));
        // stage-n: the reader lives in a SHARED slot so the reaper can drop
        // it when the shell exits naturally. On Windows ConPTY the output
        // pipe never EOFs while the HPCON lives, and we must NOT close the
        // HPCON eagerly (ClosePseudoConsole kills every process attached to
        // the pseudo console — a shared conhost can take down the agent;
        // observed on d1). The ConPTY reader is non-blocking (see
        // conpty.rs), so the reader polls: each iteration locks briefly,
        // reads what's available, sleeps on WouldBlock. When the reaper
        // takes the reader out of the slot, the next iteration sees None
        // and the thread ends → drainer finalizes → execute's closed-
        // detection fires. On Unix the reader stays blocking (slave-take
        // already EOFs it), so only Windows takes the reader.
        let reader_slot: Arc<Mutex<Option<Box<dyn Read + Send>>>> =
            Arc::new(Mutex::new(Some(reader)));

        // Reader thread: pushes output to channel. blocking_send applies
        // backpressure — a stalled consumer pauses the shell (PTY semantics).
        let sid_reader = sid.clone();
        let reader_reap = reader_slot.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                let result = {
                    // Lock only for the read itself — the reaper's take()
                    // waits at most one non-blocking read (ConPTY) or the
                    // duration of one blocking read (Unix).
                    let mut guard = reader_reap.lock().unwrap_or_else(|p| p.into_inner());
                    match guard.as_mut() {
                        Some(r) => r.read(&mut buf),
                        None => break,
                    }
                };
                match result {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(TermOutput { session_id: sid_reader.clone(), data: buf[..n].to_vec() }).is_err() { break; }
                    }
                    // WouldBlock is the ConPTY non-blocking no-data case —
                    // poll again shortly. Other errors (handle dropped by
                    // the reaper, EBADF) end the thread.
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(10));
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
        // Only used on Windows (see the #[cfg(windows)] take below); the
        // variable itself must exist for both platforms.
        #[cfg_attr(not(windows), allow(unused_variables))]
        let reader_reap = reader_slot.clone();
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
                    // stage-n: Windows ConPTY — the output pipe never EOFs
                    // while the HPCON lives, so additionally drop the READER
                    // handle: the (non-blocking) reader thread then sees the
                    // slot empty within one poll interval and ends, letting
                    // the drainer finalize the session. The HPCON itself is
                    // deliberately NOT closed (ClosePseudoConsole kills every
                    // process attached to the pseudo console — a shared
                    // conhost can take down the agent; node-pty never closes
                    // it on child exit either).
                    #[cfg(windows)]
                    if let Ok(mut guard) = reader_reap.lock() {
                        guard.take();
                    }
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            tracing::debug!("[vale-agent] PTY reaper: shell exited: {sid}");
        });

        Ok(PtyBackend {
            marker_injected,
            closed_explicitly: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            writer: Arc::new(Mutex::new(writer)),
            write_in_flight: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            last_write_timeout: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            last_write_start: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            master: Arc::new(Mutex::new(master)),
            _slave: slave,
            child: child_slot,
            reader_slot,
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
    fn write_async<'a>(&'a self, data: &'a [u8]) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        // round-106: the round-105 version used the BLOCKING std Mutex::lock
        // (only fails on poison) and a blocking write_all on the master fd —
        // a full n_tty input queue (foreground process not reading stdin)
        // blocked FOREVER, wedging the execute busy flag and a tokio worker.
        // The master fd is a blocking ptmx; the only sound bounded path is
        // to run the blocking write on a BLOCKING TASK and time out around
        // it — the timeout abandons the stalled task (the fd stays valid;
        // a later drain unblocks the write_all which then completes into a
        // consumed buffer).
        // round-108: the lock-free ⇒ queue-not-full assumption was wrong —
        // a free mutex only means the PREVIOUS write returned; the n_tty
        // queue can be exactly full at that moment and the blocking
        // write_all hangs. The bounded approach without a thread pile-up:
        // one in-flight blocking write per session (spawn_blocking + 5s
        // timeout); while one is wedged, subsequent writes fail fast
        // instead of parking another thread behind the same mutex.
        // round-115: self-healing gate — a dropped caller future (client
        // disconnect mid-write on the web-panel path) leaves the flag set
        // forever: the spawn_blocking task finishes but nothing clears it.
        // A gate whose START is older than the 5s write timeout can no
        // longer belong to a live writer (a live writer clears it at 5s or
        // completed); clear it and proceed instead of failing permanently.
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        if self.write_in_flight.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let started = self.last_write_start.load(std::sync::atomic::Ordering::SeqCst);
            if started != 0 && now_ms.saturating_sub(started) >= 5000 {
                // Stale gate from an abandoned write — reclaim it. The old
                // spawn_blocking task, if still parked, will drain whenever
                // the queue frees and write into a consumed buffer (safe).
                self.write_in_flight.store(false, std::sync::atomic::Ordering::SeqCst);
            } else {
                return Box::pin(async move {
                    Err("pty write already in flight (previous write wedged on a full input queue)".into())
                });
            }
        }
        self.last_write_start.store(now_ms, std::sync::atomic::Ordering::SeqCst);
        // round-110: cooldown after a timeout — the wedged queue would
        // re-accumulate a parked thread per retry; fail fast for 5s.
        let last_t = self.last_write_timeout.load(std::sync::atomic::Ordering::SeqCst);
        // round-112: saturating_sub — a backward system-clock jump wrapped
        // the raw u64 subtraction (and panicked in debug builds).
        if last_t != 0 && now_ms.saturating_sub(last_t) < 5000 {
            self.write_in_flight.store(false, std::sync::atomic::Ordering::SeqCst);
            return Box::pin(async move {
                Err("pty write in cooldown after a timeout (input queue wedged)".into())
            });
        }
        let writer = self.writer.clone();
        let in_flight = self.write_in_flight.clone();
        let last_timeout = self.last_write_timeout.clone();
        let d = data.to_vec();
        Box::pin(async move {
            // round-132: chunked write + yield between chunks. Measured root cause
            // (Windows ConPTY): when the whole write_all is dumped at once,
            // the console input record queue is consumed slowly by
            // PSReadLine's incremental rendering and can't finish within the
            // 5s budget → the write is abandoned midway → the command is
            // silently truncated (long base64 literals reliably broke at
            // ~300 bytes), and residual bytes later land out of order
            // causing scrambled echo (the other half of the ">>" ghost).
            // Chunking + yielding keeps the queue from ever filling; order
            // comes from sequential awaits. Total budget 30s.
            // round-140: 64B/40ms was too conservative — every command
            // triggered ceil(len/64) PSReadLine redraw frames (measured: a
            // 3.6KB base64 transfer echoed dozens of times on the panel,
            // buffer ballooning 2MB+ — the "echo interference" look), and
            // big commands took 2s+ to finish. 256B/15ms (≈17KB/s, below
            // the ConPTY queue consumption rate) cuts redraw frames ~11x;
            // short writes/blocks stay covered by the per-chunk 9s deadline
            // + backoff, no silent char loss.
            // round-155: 256B/15ms still redraws the edit line once per
            // chunk (leftover `>>`/`> ` half-lines on the panel). 512B/8ms
            // gets the whole command into the edit buffer faster, halving
            // redraws; short writes/blocks stay covered by the per-chunk 9s
            // deadline + backoff, no silent char loss.
            // round-162: 1024B/8ms — the stage-l command wrapper (~568B for
            // a typical command + the marker machinery) with 512B chunks
            // ALWAYS split mid-line: PowerShell shows the PS2 `>>`
            // continuation prompt between the halves (a permanent ghost on
            // the panel after every AI execute), and PSReadLine's
            // incremental redraw of the split paste leaves `$`+first-word
            // residue. 1024B fits the wrapper + ~450-char command in ONE
            // chunk: one atomic paste, one PSReadLine render, no `>>`, no
            // residue. Long pastes still chunk (round-132 semantics: byte-
            // level retry + per-chunk 9s deadline keep the queue from
            // wedging — the original 300B all-at-once breakage was the
            // absence of retry, not the size).
            const CHUNK: usize = 1024;
            const GAP_MS: u64 = 8;
            let mut off = 0usize;
            let mut res = Ok(());
            while off < d.len() {
                let end = (off + CHUNK).min(d.len());
                let slice = d[off..end].to_vec();
                let w2 = writer.clone();
                let step = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    tokio::task::spawn_blocking(move || {
                        // round-132: no more `let _ =` error-swallowing — when the ConPTY
                        // input pipe is full, write returns WouldBlock or a
                        // short write; ignoring it silently = whole chunk
                        // lost (measured ~250B missing mid-command). Advance
                        // byte by byte: short writes/errors back off and
                        // retry until the chunk is written or timed out.
                        let mut w = w2.lock().unwrap_or_else(|p| p.into_inner());
                        let mut done = 0usize;
                        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(9);
                        while done < slice.len() {
                            if std::time::Instant::now() >= deadline { return; }
                            match w.write(&slice[done..]) {
                                Ok(0) => std::thread::sleep(std::time::Duration::from_millis(20)),
                                Ok(n) => done += n,
                                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                                Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
                            }
                        }
                        let _ = w.flush();
                    }),
                ).await;
                match step {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => { res = Err(format!("pty write task failed: {e}")); break; }
                    Err(_) => { res = Err("pty write timed out after 10s (input queue full)".into()); break; }
                }
                off = end;
                if off < d.len() {
                    tokio::time::sleep(std::time::Duration::from_millis(GAP_MS)).await;
                }
            }
            if res.is_err() {
                last_timeout.store(
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
                    std::sync::atomic::Ordering::SeqCst,
                );
            }
            in_flight.store(false, std::sync::atomic::Ordering::SeqCst);
            res
        })
    }
    fn resize(&self, rows: u16, cols: u16) {
        // Real PTY resize — the shell gets SIGWINCH / ConPTY reflows.
        // (The old code wrote an ANSI escape into the shell's stdin.)
        if let Ok(m) = self.master.lock() {
            let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }
    fn close(&self) {
        // review #9: from here on, any recorded exit status belongs to the
        // kill WE issued — report None (explicit close), not "natural exit".
        self.closed_explicitly.store(true, std::sync::atomic::Ordering::SeqCst);
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
        // stage-n: drop the reader handle so the reader thread ends (the
        // reaper does this on natural exit; here it covers explicit close).
        // On Windows ConPTY this is what unblocks the reader (the pipe never
        // EOFs while the HPCON lives); on Unix it's a harmless no-op after
        // slave-take already EOF'd the reader.
        if let Ok(mut guard) = self.reader_slot.lock() {
            guard.take();
        }
    }
    fn exit_code(&self) -> Option<i32> {
        if self.closed_explicitly.load(std::sync::atomic::Ordering::SeqCst) {
            return None;
        }
        self.exit_code.lock().ok().and_then(|g| *g)
    }
    fn marker_injected(&self) -> bool {
        self.marker_injected
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
        // execute-timeout path (term_terminate awaits forever).
        // round-98: but a plain single try_lock ALSO dropped ^C during brief
        // normal writes (a keystroke holding the lock for microseconds) —
        // the execute-timeout abort silently no-ops and the timed-out
        // command keeps running. Retry with a short bounded window (a few
        // ms): covers the brief-write case while still bailing out before
        // the stalled-write deadlock.
        let mut delivered = false;
        for _ in 0..8 {
            if let Ok(mut w) = self.writer.try_lock() {
                let _ = w.write_all(&[0x03]);
                delivered = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let _ = delivered;
    }
}
