//! Execution tools — terminal_execute (session wait-loop + local shell),
//! terminal_jobs (background-job registry) and terminal_env.
//!
//! One builder fn per MCP tool, built once at registration. Code moved
//! verbatim from the former monolithic `plugins/terminal/tools.rs`.

use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;

use super::ctx::{session_lost, JobInfo, JobsMap};
use crate::plugins::terminal::clean_terminal_output;
use crate::plugins::{require_str, to_value_or_empty};
use vale_agent_core::{recover_guard, AgentEvent, DeviceError, EventBus, ToolDef};

/// Build the session-mode execute result JSON (round-157): a partial (idle)
/// return means the command is STILL RUNNING — the wait loop gave up on
/// output, not on the command. Models misread a bare partial as "commands
/// queuing up" and answered with retries and new sessions (d1: 321
/// idle-partials → 167 terminal_open). Surface the continuation contract
/// EXPLICITLY inside the text the model reads, plus a structured
/// `still_running` flag for future clients. Pure so the shape is unit-tested
/// without a real shell.
pub(super) fn execute_result_json(
    state: &str,
    result: String,
    truncated: bool,
    timed_out: bool,
    wait_reason: &str,
    marker_code: Option<i32>,
    read_abs: usize,
) -> serde_json::Value {
    let mut final_text = result;
    let still_running = state == "partial";
    if still_running {
        final_text.push_str(
            "\n[note: the command is still running (wait_reason=idle; the shell produced no output for the quiet window). Read the rest with terminal_read(session_id, offset=read_from). Do NOT re-run the command and do NOT open a new session — its output will arrive in this session's buffer.]",
        );
    }
    json!({
        "kind": "session",
        "state": state,
        "text": final_text,
        "truncated": truncated,
        "timed_out": timed_out,
        "wait_reason": wait_reason,
        "exit_code": marker_code,
        "read_from": read_abs,
        "still_running": still_running,
    })
}

/// round-151: terminal_env — AI-friendly environment info: default shell,
/// install dir, bundled node, and guidance for using terminal_execute.
pub(super) fn tool_terminal_env() -> ToolDef {
    ToolDef::new(
        "terminal_env",
        "Environment info for the AI when driving this device's terminal: default shell, install dir, bundled node.exe (for one-off node scripts run via terminal_execute), and usage guidance. Run BEFORE opening sessions/executing commands.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            async move {
                let dir = crate::paths::install_dir();
                let node = crate::paths::playwright_dir().join("node.exe");
                let node_ver = if node.exists() {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(4),
                        tokio::process::Command::new(&node).arg("--version").output(),
                    ).await
                    .ok()
                    .and_then(|o| o.ok())
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default()
                } else { String::new() };
                Ok(to_value_or_empty(json!({
                    "default_shell": "pwsh (PowerShell 7)",
                    "shell_hint": "PowerShell 7 — OSC 633 shell integration active (clean display + exit codes); Windows PowerShell 5.1 is not supported",
                    "install_dir": dir.to_string_lossy(),
                    "bundled_node": { "path": node.to_string_lossy(), "version": node_ver },
                    "router_reachable": "ssh stc@192.168.1.1 (user stc)",
                    "ai_usage": [
                        "Open a PTY with terminal_open (kind=pty), then terminal_execute commands.",
                        "For script-driven work (playwright etc.) prefer browser_pw_info / browser_run_script instead of the shell.",
                    ],
                })))
            }
        },
    )
}

/// Append the platform-appropriate line terminator to a command sent to a
/// terminal session. Windows PowerShell only ends a command on CRLF (\r\n) — a
/// bare \n leaves the shell in the multi-line continuation prompt (>>) and the
/// command never runs. Unix shells accept a bare \n.
pub fn append_command_newline(command: &str) -> String {
    if command.ends_with('\n') || command.ends_with('\r') {
        command.to_string()
    } else if cfg!(target_os = "windows") {
        // stage-m: `\r` ONLY — VS Code's sendText sends `\r` (the terminal
        // driver maps it to Enter). `\r\n` on ConPTY can be read as TWO
        // input events (CR + LF), so PSReadLine renders an empty
        // continuation prompt (`>>`) after every command.
        format!("{command}\r")
    } else {
        format!("{command}\n")
    }
}
/// Read new output for `sid` past `read_abs`, advancing the cursor past
/// anything eviction dropped (shared by the foreground + background wait
/// loops — the dropped-jump + slice_from pair used to be inlined at both
/// sites). round-94: the cursor MUST jump forward to `dropped`, not stay
/// behind — slice_from clamps to the in-memory window and a stale cursor
/// would re-read the window tail already appended to the result,
/// duplicating it on every poll while eviction continues. The foreground
/// loop additionally reports truncation via `truncated`.
fn poll_output_chunk(
    buf: &super::super::OutputBuf,
    sid: &str,
    read_abs: &mut usize,
    truncated: Option<&mut bool>,
) -> (Vec<u8>, usize) {
    recover_guard(buf)
        .live
        .get(sid)
        .map(|e| {
            if e.dropped as usize > *read_abs {
                *read_abs = e.dropped as usize;
                if let Some(t) = truncated {
                    *t = true;
                }
            }
            let s = e.slice_from(*read_abs);
            (s.to_vec(), s.len())
        })
        .unwrap_or_default()
}

/// Find a complete prompt marker — `ESC ] 133 ; D ; <exit-code> BEL` — in
/// `data`, returning (start, end, exit_code) over the WHOLE sequence.
/// The marker may be split across chunks, so it is searched over the
/// un-finalized tail; an incomplete sequence returns None and the caller
/// keeps waiting for the next chunk.
///
/// stage-l: LEGACY — the shell-injection OSC 133 marker was replaced, first
/// by the Netcatty-style command wrapper (stage-l, later removed with its
/// subsystem), now by OSC 633 shell integration (see
/// crate::tools::terminal::shell_integration::find_finished).
/// Kept only for the headless-stub path and backward-compat reads; new code
/// must use shell_integration::find_finished.
pub(super) fn find_prompt_marker(data: &[u8]) -> Option<(usize, usize, i32)> {
    const PREFIX: &[u8] = b"\x1b]133;D;";
    // round-100: the old code stopped at the FIRST prefix — a false
    // \x1b]133;D; sequence in output (e.g. a literal escape in a log line)
    // with no digits/BEL made the whole search fail even when a REAL marker
    // followed. Scan ALL prefixes; only a complete sequence counts.
    let mut search_from = 0;
    while let Some(rel) = data[search_from..]
        .windows(PREFIX.len())
        .position(|w| w == PREFIX)
    {
        let start = search_from + rel;
        let mut i = start + PREFIX.len();
        let digits_start = i;
        while i < data.len() && data[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits_start {
            search_from = start + 1;
            continue;
        } // prefix but no digits yet — try the next prefix
        if i >= data.len() || data[i] != 0x07 {
            search_from = start + 1;
            continue;
        } // incomplete — try the next
          // round-101: a digit run that overflows i32 (11+ digits) must not
          // abort the whole scan — continue to the next prefix like the other
          // false-prefix cases.
        let code: i32 = match std::str::from_utf8(&data[digits_start..i])
            .ok()
            .and_then(|s| s.parse().ok())
        {
            Some(c) => c,
            None => {
                search_from = start + 1;
                continue;
            }
        };
        return Some((start, i + 1, code));
    }
    None
}

// ── stage-l: Netcatty-style command wrapper + plain-text markers ────────
//
// The OSC 133 shell-injection marker FAILED on Windows PowerShell 5.1 +
// ConPTY: the injected `function global:Prompt` never emitted the sequence
// (PSReadLine unload / ConsoleHost prompt path), so terminal_execute waited
// for a marker that never came and burned the full timeout on every command
// (observed live on d1: `state:"timeout"` at 10s on a 50ms `echo`).
//
// The replacement (proven by Netcatty in production on the same platform):
// wrap EVERY executed command in a single-line shell wrapper that prints a
// random START marker, runs the command, then prints END:<exitcode>. The
// ── Jobs (Phase 3) ───────────────────────────────

/// `terminal_plan` — the agent declares what it MEANS to do, in order.
///
/// The counterpart to the operator's session goal, and deliberately a separate
/// thing: the operator says what the session is FOR, the agent says what it is
/// going to DO about it. Recorded in the audit trail on every declaration, so a
/// reader sees that a plan was revised rather than only what it ended up as.
///
/// No `plan_step`-style per-command linkage here — a command claims the step it
/// advances through `terminal_execute`'s `plan_step`, which keeps the naming in
/// one place and lets a step be claimed by the command that actually did it.
pub(super) fn tool_plan(ctx: &super::ctx::ToolCtx) -> ToolDef {
    let mgr = ctx.terminal_mgr.clone();
    let logger = ctx.logger.clone();
    ToolDef::new(
        "terminal_plan",
        "Declare, revise, clear or read this session's PLAN — the steps you intend to take, in order. Call it before starting a multi-step task so the operator can see what you are about to do and judge it; call it again with a revised list when the plan changes. Pass an empty array to clear it. With `plan` omitted it just returns the current plan. Steps are short labels, not explanations — put the reasoning for a specific command in terminal_execute's `intent`, and name the step a command advances with terminal_execute's `plan_step`.",
        json!({"type":"object","properties":{
            "session_id":{"type":"string","description":"The session this plan is for."},
            "plan":{"type":"array","items":{"type":"string"},"description":"The steps, in order (max 24, each a short line). An empty array CLEARS the plan. Omit the key entirely to read the current plan without changing it."},
            "run_id":{"type":"string","description":"Optional: the id returned by run_begin, naming the execution this plan belongs to. A declared plan belongs to the run that declared it, so passing the id lets an operator see what a run said it would do next to what it actually did."}
        },"required":["session_id"]}),
        move |params: Value| {
            let mgr = mgr.clone();
            let logger = logger.clone();
            async move {
                let sid = params
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| DeviceError::InvalidParams {
                        message: "session_id is required".to_string(),
                    })?;

                // ABSENT vs EMPTY is the whole contract, so it is tested here
                // rather than defaulted: omitting `plan` reads, an empty array
                // clears. Collapsing them would make a client that forgot the key
                // silently withdraw the plan.
                let Some(raw) = params.get("plan") else {
                    let plan = mgr.term_plan(sid).await?;
                    return Ok(json!({ "session_id": sid, "plan": plan }));
                };

                let steps: Vec<String> = raw
                    .as_array()
                    .ok_or_else(|| DeviceError::InvalidParams {
                        message: "plan must be an array of strings".to_string(),
                    })?
                    .iter()
                    // A non-string entry is a client bug. Dropped rather than
                    // failing the whole declaration: the plan is advisory, and
                    // losing the rest of a good plan over one bad element is the
                    // worse trade.
                    .filter_map(|v| v.as_str())
                    .map(|v| v.to_string())
                    .collect();

                let stored = mgr.term_set_plan(sid, &steps).await?;
                // The run this plan belongs to, when the client named one.
                let run_id = params.get("run_id").and_then(|v| v.as_str());
                logger.log_plan_run(sid, &stored, run_id);
                Ok(json!({ "session_id": sid, "plan": stored, "revised": true }))
            }
        },
    )
}

pub(super) fn tool_jobs(jobs: &JobsMap) -> ToolDef {
    let jobs = jobs.clone();
    ToolDef::new(
        "terminal_jobs",
        "Background-job registry. With no params: list recent run_in_background jobs {job_id, command, done, exit_code}. With {job_id, wait_secs}: block until that job finishes or the timeout elapses, then return its final state.",
        json!({"type":"object","properties":{
            "job_id":{"type":"string","description":"Job id returned by terminal_execute(run_in_background:true)."},
            "wait_secs":{"type":"integer","description":"Max seconds to wait for completion when job_id is given. Default 0 (instant snapshot)."}
        }}),
        move |params: Value| {
            let jobs = jobs.clone();
            async move {
                let deadline_secs = params.get("wait_secs").and_then(|v| v.as_u64()).unwrap_or(0).min(3600);
                let target = params.get("job_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(deadline_secs);
                loop {
                    {
                        let jm = jobs.lock().unwrap_or_else(|p| p.into_inner());
                        if let Some(id) = &target {
                            match jm.get(id) {
                                Some(j) if j.done => {
                                    return Ok(json!({"job_id": id, "state": "done", "exit_code": j.exit_code}));
                                }
                                None => {
                                    return Err(DeviceError::InvalidParams { message: format!("unknown job_id: {}", id) });
                                }
                                _ => {}
                            }
                        } else {
                            let mut out = Vec::new();
                            for (k, j) in jm.iter() {
                                out.push(json!({
                                    "job_id": k, "session": j.sid, "command": j.command,
                                    "done": j.done, "exit_code": j.exit_code,
                                    "started_unix": j.started_unix,
                                }));
                            }
                            return Ok(json!({"jobs": out}));
                        }
                    }
                    if std::time::Instant::now() >= deadline {
                        let state = if target.is_some() { "running" } else { "snapshot" };
                        return Ok(json!({"state": state}));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        },
    )
}

// ── Execute ──────────────────────────────────────

/// How long a timed-out command's tree gets to exit on its own after the
/// graceful signal, before it is killed outright.
const KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(3);
/// How long to keep waiting for the tree AFTER the forced signal. A group
/// stuck in D-state (uninterruptible IO) would otherwise hang the tool
/// forever — the call returns with whatever output arrived instead.
const KILL_REAP: std::time::Duration = std::time::Duration::from_secs(5);

/// Signal a whole process TREE, not just the direct child (round-55).
///
/// The local shell is spawned with `process_group(0)` on Unix, so the child's
/// pid IS its group id and a NEGATIVE pid targets every process in it. That
/// matters because the commands this guards are things like `make` and the
/// installer: killing only the shell left the real work running orphaned on
/// the device (round-54). Windows has no process groups here, so `taskkill
/// /T` walks the child tree instead.
///
/// `force = false` is the graceful signal (SIGTERM / plain `taskkill /T`:
/// SIGKILL straight away left databases and build caches half-written);
/// `force = true` is the last resort (SIGKILL / `/F`).
///
/// Both platform arms live here rather than inline at each call site, so the
/// policy is stated ONCE. Note the arms are never compiled together — Linux
/// tests exercise the Unix one and `cargo xwin` the Windows one — which is
/// exactly why a single owner beats four inline copies.
async fn signal_tree(pid: u32, force: bool) {
    let pid = pid.to_string();
    #[cfg(unix)]
    {
        // SIGTERM -15 / SIGKILL -9, addressed to the process GROUP.
        let sig = if force { "-9" } else { "-15" };
        let _ = tokio::process::Command::new("kill")
            .args([sig, "--", &format!("-{pid}")])
            .output()
            .await;
    }
    #[cfg(windows)]
    {
        let mut args: Vec<&str> = vec!["/T", "/PID", pid.as_str()];
        if force {
            args.insert(0, "/F");
        }
        let _ = tokio::process::Command::new("taskkill")
            .args(&args)
            .output()
            .await;
    }
    // Platforms with neither arm: nothing to signal.
    #[cfg(not(any(unix, windows)))]
    let _ = (pid, force);
}

/// Poll until the child exits or `patience` elapses; true when it exited.
///
/// Both kill-path waits use this (the grace window and the post-SIGKILL
/// re-await). They were two hand-written copies of the same 50 ms poll loop —
/// identical structure, separately maintained.
async fn wait_for_exit(child: &mut tokio::process::Child, patience: std::time::Duration) -> bool {
    tokio::time::timeout(patience, async {
        loop {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .is_ok()
}

/// Session-mode result cap (1 MB tail). The old code grew `result` to the
/// command's TOTAL output; `yes` at 1 MB/s for the 3600 s deadline OOM'd the
/// agent (round-105). The tail is kept — it is what the model needs — and
/// `truncated` tells the caller bytes were dropped.
pub(super) const MAX_SESSION_BYTES: usize = 1_048_576;

/// Append terminal output to a capped result buffer, keeping the TAIL.
///
/// This is the session wait loop's single choke point for result growth, and
/// every rule in it exists because its absence wedged the session busy flag
/// forever (the panic aborts the loop past `term_release_execute`):
///
/// * **Cap the incoming chunk itself** (round-113). A burst between two 50 ms
///   polls can arrive as ONE chunk bigger than the cap. Trimming only on the
///   *next* append let that chunk through in full.
/// * **`floor_char_boundary` bounds the window, not the slice start.** After
///   trimming `s` to `max`, `s.len() - keep` may land mid-character on a CJK
///   or emoji flood — `&s[start..]` then PANICS (review #1, same class as the
///   round-106 drain below). Walk forward to the next boundary.
/// * **`String::drain` panics on a non-boundary too** (round-106). Output is
///   lossy-converted arbitrary bytes, so walk the drop index BACK to a
///   boundary before draining.
///
/// Walking back (rather than forward, as the slice start does) is deliberate:
/// the drop index is clamped to `result.len()` and walking back can only
/// shrink the drain, so the buffer never exceeds `max` by more than one
/// character's worth of bytes.
///
/// Pure — no session, clock or buffer dependency — so all three incident
/// rules are unit-pinned without a real shell.
pub(super) fn bounded_append(result: &mut String, truncated: &mut bool, s: &str, max: usize) {
    let mut s = s;
    if s.len() > max {
        *truncated = true;
        let keep = s.floor_char_boundary(max);
        let mut start = s.len() - keep;
        while start < s.len() && !s.is_char_boundary(start) {
            start += 1;
        }
        s = &s[start..];
    }
    if result.len() + s.len() > max {
        *truncated = true;
        let drop = result.len() + s.len() - max;
        let drop = drop.min(result.len());
        let mut bound = drop;
        while bound > 0 && !result.is_char_boundary(bound) {
            bound -= 1;
        }
        result.drain(..bound);
    }
    result.push_str(s);
}

/// Local shell mode with enforced timeout (tokio::process) — a separate
/// module-level fn so the tool_execute closure stays a router between the
/// session wait-loop and this path. Self-contained: spawn (own process
/// group on Unix so a timeout kills shell AND descendants), bounded 1 MB
/// tail capture with truncation, kill-on-timeout, same {kind, text,
/// truncated} shape as the session mode.
/// Tail-append with a byte cap (round-55 BOUNDED capture): on overflow
/// keep the NEWEST half before appending — a single huge chunk must not
/// wipe the older tail — then trim to the cap; `truncated` records any
/// drop. Shared by the live receive path and the final drains of the
/// local-execute capture loop.
fn tail_append(captured: &mut Vec<u8>, truncated: &mut bool, c: Vec<u8>, max: usize) {
    if captured.len() + c.len() > max {
        let keep = max / 2;
        if captured.len() > keep {
            captured.drain(..captured.len() - keep);
        }
        *truncated = true;
    }
    captured.extend_from_slice(&c);
    if captured.len() > max {
        captured.drain(..captured.len() - max);
        *truncated = true;
    }
}

async fn execute_local(
    command: &str,
    timeout_secs: u64,
    bus: &Arc<dyn EventBus>,
) -> Result<serde_json::Value, DeviceError> {
    // ── Local shell mode with enforced timeout (tokio::process) ──
    let (shell, flag) = if cfg!(target_os = "windows") {
        ("cmd", "/C")
    } else {
        ("sh", "-c")
    };
    let mut cmd = tokio::process::Command::new(shell);
    cmd.arg(flag)
        .arg(command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // The command runs in its own process group (Unix) so a
    // timeout can kill the WHOLE tree — shell AND descendants.
    // Without this a timed-out `make` / `agent_update`
    // installer kept running orphaned on the device after
    // only the direct child died (round-54).
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| DeviceError::Internal {
        message: format!("spawn failed: {e}"),
    })?;
    let pid = child.id();

    // BOUNDED capture (round-55): wait_with_output buffered
    // stdout+stderr into RAM WITHOUT limit — a `yes`-style
    // command OOM'd the device. Two reader tasks stream both
    // pipes into a bounded channel; the main loop keeps only
    // the TAIL (1 MB cap, oldest half dropped on overflow).
    // stdout/stderr are merged to preserve interleaving.
    use tokio::io::AsyncReadExt as _;
    fn pipe_reader<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
        mut stream: R,
        tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).await.is_err() {
                            break;
                        }
                    }
                }
            }
        })
    }
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    // round-n: never panic on a missing pipe — tokio spawn
    // with Stdio::piped() normally guarantees both, but a
    // defensive take() keeps a platform quirk from killing
    // the whole execute handler (MCP request) with an
    // unwrap panic. Missing stdout → no output capture;
    // missing stderr just drops stderr. Both reader tasks
    // are still spawned so the wait loop below behaves the
    // same (an empty reader just ends immediately).
    let reader_stdout = match child.stdout.take() {
        Some(out) => pipe_reader(out, tx.clone()),
        None => tokio::task::spawn(async {}),
    };
    let reader_stderr = match child.stderr.take() {
        Some(err) => pipe_reader(err, tx.clone()),
        None => tokio::task::spawn(async {}),
    };
    drop(tx); // main loop is the last receiver

    const MAX_LOCAL_BYTES: usize = 1_048_576; // 1 MB tail cap
    let mut captured: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut timed_out = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    // Capture tail append + truncation — shared by the live
    // receive path and the final drain before exit (round-57).
    loop {
        tokio::select! {
            chunk = rx.recv() => {
                if let Some(c) = chunk {
                    tail_append(&mut captured, &mut truncated, c, MAX_LOCAL_BYTES);
                } else {
                    // Both pipes closed but the child still runs
                    // (`sh -c 'exec >/dev/null 2>&1; sleep 100'`)
                    // — recv() returns None IMMEDIATELY every
                    // round, and select! keeps picking the only
                    // ready branch, starving the 50ms probe and
                    // hot-spinning try_wait at full core. Yield
                    // briefly (round-58: round-57 dropped the
                    // old is_closed throttle and re-opened the
                    // burn).
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }
            // Periodic wakeup so the exit probe below runs even
            // when NO output ever arrives — a daemonized
            // grandchild holding the pipes open keeps rx.recv()
            // pending forever (round-57: the probe sat AFTER the
            // select, which never woke in pure-silent daemon
            // cases — `sh -c 'sleep 100 & exit 0'` was falsely
            // reported as TIMEOUT).
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
        }
        // Deadline check OUTSIDE the select (round-59): select!
        // picks the FIRST ready branch in declaration order —
        // after both pipes EOF, rx.recv() is Ready(None) every
        // round, so the None branch always wins and a sleep
        // branch declared after it NEVER fires (verified: the
        // timeout branch did not trigger once in 60 rounds).
        // The timeout contract ("kill the command at the
        // deadline") was silently broken for pipe-closed
        // commands; a plain instant compare cannot starve.
        if std::time::Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        // Exit probe — the authoritative done signal (round-56):
        // the child exited but a daemon grandchild keeps rx
        // open forever.
        if let Ok(Some(_)) = child.try_wait() {
            // round-107/108: the exit-flush drain used
            // try_recv — the pipe_reader tasks may still hold
            // the final bytes, so a fast exit lost the tail.
            // Give the readers one bounded tick to flush and
            // APPEND the received chunk (the R107 fix
            // discarded it with `let _`).
            if let Ok(Some(c)) =
                tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
            {
                tail_append(&mut captured, &mut truncated, c, MAX_LOCAL_BYTES);
            }
            // Drain whatever the exit flushed out (round-57):
            // skipping this silently dropped up to 16 chunks
            // (~128KB) of tail output with truncated unset.
            while let Ok(c) = rx.try_recv() {
                tail_append(&mut captured, &mut truncated, c, MAX_LOCAL_BYTES);
            }
            // round-115: the readers block in stream.read(),
            // NOT tx.send — closing rx only fails future sends
            // and does NOT wake the pending reads (round-55's
            // "Close rx so the two pipe_reader tasks stop
            // blocking" was wrong for the daemon case: a
            // grandchild inherits the pipe write ends, so the
            // reads never EOF and 2 tasks + 2 fds leaked per
            // execute forever). Abort them explicitly.
            rx.close();
            reader_stdout.abort();
            reader_stderr.abort();
            break;
        }
    }

    if timed_out {
        // Graceful → forced → bounded reap (policy in signal_tree /
        // wait_for_exit). Only signal a child that is still running: a
        // command that already exited must not have its pid reused.
        if child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
            if let Some(pid) = pid {
                signal_tree(pid, false).await;
            }
            if !wait_for_exit(&mut child, KILL_GRACE).await {
                if let Some(pid) = pid {
                    signal_tree(pid, true).await;
                }
                // Bounded re-await: return with the partial output either way.
                let _ = wait_for_exit(&mut child, KILL_REAP).await;
            }
        }
        // Drain whatever the kill flushed out (bounded).
        while let Ok(c) = rx.try_recv() {
            tail_append(&mut captured, &mut truncated, c, MAX_LOCAL_BYTES);
        }
    }
    // Reap whatever exited (may be None if the group is stuck).
    let exit_code = child
        .try_wait()
        .ok()
        .flatten()
        .and_then(|s| s.code())
        .unwrap_or(-1);
    let text = String::from_utf8_lossy(&captured);
    let mut result = format!("Exit: {exit_code}\nOutput:\n{text}");
    if timed_out {
        // Explicit TIMEOUT marker: the output above is
        // PARTIAL — the model must not read it as a complete
        // result (round-54).
        result.push_str(&format!(
            "\nTIMEOUT: killed after {timeout_secs}s — output above is partial"
        ));
    }
    if truncated {
        result.push_str("\n[output truncated — tail only]");
    }
    // Strip ANSI/OSC noise for the model — the MCP text path
    // must be printable text, the panel keeps raw bytes via
    // its own SSE stream (round-54, dsh sanitize.ts).
    let result = clean_terminal_output(result.as_bytes());
    bus.emit(&AgentEvent::ShellExec {
        command: command.to_string(),
    });
    // Unified shape (round-60): same `kind`/`output`/truncated
    // contract as the session mode; stdout/stderr stay as
    // attached fields for old parsers.
    Ok(json!({
        "kind": "local",
        "text": result,
        "truncated": truncated,
    }))
}
/// How long the approval gate waits for an operator decision (design beat 3).
/// Mirrors the manager's own deadline; named here so the call site reads as a
/// budget rather than a magic number.
const APPROVAL_WAIT_MS: u64 = 60_000;

pub(super) fn tool_execute(ctx: &super::ctx::ToolCtx) -> ToolDef {
    let terminal_mgr = ctx.terminal_mgr.clone();
    let buf = ctx.output_buf.clone();
    let bus = ctx.bus.clone();
    let logger = ctx.logger.clone();
    let jobs = ctx.jobs.clone();
    ToolDef::new(
        "terminal_execute",
        "Run a command. If `session_id` is given, writes the command to that session and waits for output (prompt-marker detection on PTY shells, quiet-period fallback otherwise). Otherwise spawns a local shell with enforced timeout. Session mode returns {kind, state, text, read_from, wait_reason, exit_code, truncated, still_running}: state=done means text is COMPLETE; partial/timeout means text is a PREFIX and `still_running=true` — the command is STILL RUNNING, continue with terminal_read(offset=read_from) until you see the prompt/exit. NEVER re-run a command or open a new session just because a partial was returned: the output arrives in the SAME session's buffer; opening new sessions (terminal_open) while old commands run is what causes output to look interleaved/queued. Long silent SSH commands: prefer run_in_background:true or bigger timeout_secs (idle window scales: ssh 3s, serial 4s, pty 1s). Local mode returns {kind, text, truncated}. `run_in_background: true` (session mode) writes the command and returns immediately with a read_from cursor — collect output via terminal_read; do NOT busy-poll, the wait loop is the foreground path. Note: a quiet timeout or truncation does not prove the foreground command exited.",
        json!({"type":"object","properties":{"command":{"type":"string"},"session_id":{"type":"string","description":"Optional: execute in an existing terminal session."},"timeout_secs":{"type":"integer","description":"Max wait time in seconds. Default 30."},"quiet_ms":{"type":"integer","description":"(Session mode) Quiet period in ms before considering output complete. Default 200."},"run_in_background":{"type":"boolean","description":"(Session mode) Write the command and return immediately with a read_from cursor; collect via terminal_read. Default false."},"intent":{"type":"string","description":"Optional: WHY you are running this, in one sentence. Recorded with the command and shown to the operator on the session's path — it is what turns a list of commands into a readable account of what you were doing and why. Send it whenever the reason is not obvious from the command itself."},"considered":{"type":"array","items":{"type":"string"},"description":"Optional: the alternatives you passed over for this step (short labels, max 8). Recorded and shown as the branches NOT taken, which is the part a command log can never reconstruct. Send it when you made a real choice — not for the only way to do something."},"plan_step":{"type":"integer","description":"Optional: which step of your declared terminal_plan this command advances (1-based). Lets the operator see the plan being followed — or quietly abandoned — instead of having to guess which command served which step."},"run_id":{"type":"string","description":"Optional: the id returned by run_begin, naming the execution this command belongs to. One run spans many commands AND browser actions, so this is what lets an operator see a coherent piece of work instead of the day's traffic. Pass back the id verbatim."},"approval_id":{"type":"string","description":"Optional: the approval id from a result whose state was `awaiting_approval`. If the operator has since approved, the command runs without asking again; the permit covers exactly this command text, once. Omit it for a normal execute."}},"required":["command"]}),
        move |params: Value| {
            let terminal_mgr = terminal_mgr.clone();
            let buf = buf.clone();
            let bus = bus.clone();
            let logger = logger.clone();
            let jobs = jobs.clone();
            async move {
                let command = require_str(&params, "command")?;
                // round-98: clamp — a client-supplied u64::MAX made
                // `Instant::now() + Duration::from_secs(timeout_secs)`
                // overflow and PANIC after the busy guard was taken and the
                // command written, wedging the session busy flag forever and
                // orphaning the command. 1h is the practical max.
                let timeout_secs = params.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(30).min(3600);
                let quiet_ms = params.get("quiet_ms").and_then(|v| v.as_u64()).unwrap_or(200);

                if let Some(session_id) = params.get("session_id").and_then(|v| v.as_str()) {
                    // ── Session-aware mode: write + wait for output ──
                    let sid = session_id.to_string();
                    // Refactor 1.0.81: session kind drives the idle-confirm
                    // window below — SSH commands run REMOTELY and their long
                    // silent stretches must not read as "command finished".
                    let sess_info = terminal_mgr.term_info(&sid).await;
                    // P2-5: no expect("checked above") — the session may close
                    // between the check and this line; degrade to the enriched
                    // not-found error instead of panicking the handler.
                    let Some(sess_info) = sess_info else {
                        return Err(session_lost(&terminal_mgr, &sid).await);
                    };
                    let sess_kind = sess_info.kind.clone();
                    let sess_shell = sess_info.shell.clone();
                    // Background mode (round-60): write the command and return
                    // IMMEDIATELY — no wait loop, no busy lock. The caller
                    // collects output via terminal_read with the returned
                    // cursor, so long-running commands (builds, tail -f) don't
                    // block an MCP call or trip the busy guard.
                    let run_in_background = params.get("run_in_background").and_then(|v| v.as_bool()).unwrap_or(false);
                    // The agent's stated reasoning, if the client sent any. Read
                    // ONCE here and carried to the audit write below, so the
                    // record and any later reader see the same values — a second
                    // extraction at the log site is how the two drift.
                    //
                    // A malformed `considered` (not an array of strings) is
                    // treated as ABSENT rather than refused: the reasoning is
                    // optional metadata about a command that is about to run
                    // anyway, and failing the execute over it would trade a real
                    // action for a nice-to-have annotation.
                    let intent: Option<String> = params
                        .get("intent")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    // Which declared step this command advances. The plan is
                    // 1-based, so 0 and negatives read as ABSENT rather than
                    // matching no step — see SessionEvent::command_start_full.
                    let plan_step: Option<u32> = params
                        .get("plan_step")
                        .and_then(|v| v.as_u64())
                        .and_then(|n| u32::try_from(n).ok());
                    let considered: Option<Vec<String>> = params
                        .get("considered")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str())
                                .map(|s| s.to_string())
                                .collect::<Vec<_>>()
                        })
                        .filter(|c| !c.is_empty());
                    // The RUN this command belonged to, as declared by
                    // run_begin. An ATTRIBUTE, never an authorization input —
                    // see crate::runs for the rule and its pin. Unknown ids are
                    // accepted verbatim: the runs log is best-effort, so a
                    // client that lost its begin record must not lose its
                    // commands too.
                    let run_id: Option<String> = params
                        .get("run_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    // The approval request this command is picking up. Sent when
                    // re-issuing a command whose gate PARKED: the operator has
                    // since answered, so the decision is waiting as a one-shot
                    // permit and this id is how the command claims it. A wrong or
                    // stale id simply asks again — it can never widen anything,
                    // because the permit is bound to the exact command string
                    // the operator read.
                    let approval_id: Option<String> = params
                        .get("approval_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    // Absolute position of the first post-command byte.
                    // All tracking is byte-exact against the raw buffer, so
                    // UTF-8 lossy conversion and 1MB eviction can never
                    // desynchronize the index (the old String-length-based
                    // offset could panic on an out-of-range slice).
                    // stage-l: Netcatty-style command wrapping. When the
                    // session's shell is known AND the open-time
                    // `inject_marker` switch is on (its stage-l meaning: "use
                    // the command wrapper"; default true), the command is
                    // wrapped in a single-line wrapper that prints
                    // `<marker>_S` / `<marker>_E:<exitcode>` PLAIN-TEXT
                    // markers; completion is detected by scanning the raw
                    // byte stream for them. Unknown shells (ssh/serial/custom
                    // pty target) or inject_marker=false fall back to the
                    // stage-m (VS Code shell integration): PowerShell sessions
                    // were spawned WITH the OSC 633 injection (pty.rs), so the
                    // command is written RAW — no wrapper text — and completion
                    // comes from `633;D[;rc]`. Other shells (unknown/ssh/serial)
                    // keep the quiet-period fallback. Windows PowerShell only
                    // recognizes the end of a command on CRLF (\r\n) — a bare
                    // \n drops it into the multi-line continuation prompt (>>).
                    // Unix shells accept either.
                    // stage-m: 633 completion detection only for pwsh — Windows PowerShell
                    // 5.1 gets NO injection (pty.rs: its PSReadLine 2.0.0 +
                    // ConPTY re-echoes OSC as input, rendering `>>` after
                    // every prompt — VS Code has the same report, #236841).
                    // 5.1 sessions use the quiet-period completion path.
                    // review #3: pwsh by NAME was assumed injected — when
                    // shellIntegration.ps1 is missing the dot-source
                    // silently no-ops, 633 codes never arrive, and the
                    // quiet path never runs: EVERY execute burns the full
                    // timeout. The PTY backend now reports actual injection
                    // (marker_injected) through the revived
                    // term_marker_injected API.
                    let shell_633 = sess_shell == "pwsh"
                        && terminal_mgr.term_marker_injected(&sid).await;
                    // Windows PowerShell only recognizes the end of a command
                    // on CRLF (\r\n); Unix shells accept either.
                    let cmd_with_nl = append_command_newline(&command);
                    // Busy guard FIRST (round-56): acquiring the per-session
                    // execute lock must happen BEFORE the command reaches the
                    // shell. The old order wrote the command + logged start
                    // first — on refusal the command still sat in the shell's
                    // input queue and executed anyway, and the audit trail
                    // held a dangling start with no end (misreported as
                    // interrupted on the next boot).
                    // round-160: bounded WAIT instead of hard refusal — AI
                    // clients fire executes back-to-back; 21 "Session busy"
                    // failures in one week of real usage.
                    if !terminal_mgr.term_acquire_execute(&sid, 30_000).await? {
                        return Err(DeviceError::SessionBusy { id: sid.clone() });
                    }
                    // APPROVAL GATE (design beat 3). Placed HERE — after the busy
                    // guard, before anything reaches the shell — and that
                    // ordering IS the safety property: on a denial or a timeout
                    // the command was never written, so the device did nothing.
                    // Moved below the write it would be advice, not a gate.
                    //
                    // Only when the operator armed it: approval mode is opt-in per
                    // session, because autonomous operation is the product and a
                    // gate nobody asked for is just a delay.
                    //
                    // The busy lock is held ACROSS this wait on purpose. A second
                    // execute queueing behind would otherwise slip past the gate
                    // while the first was unanswered — the operator would be
                    // approving one command while another ran.
                    if terminal_mgr
                        .term_approval_required(&sid)
                        .await
                        .unwrap_or(false)
                    {
                        // A LATE YES runs the command unasked. Checked BEFORE the
                        // gate: if the operator answered after the previous
                        // execute parked, their decision became a one-shot permit,
                        // and re-asking would throw away the answer they already
                        // gave. Consumed on match, so the permit authorises ONE
                        // run of ONE command.
                        let permitted = match approval_id.as_deref() {
                            Some(gid) => terminal_mgr
                                .term_consume_permit(&sid, gid, &command)
                                .await
                                .unwrap_or(false),
                            None => false,
                        };
                        if !permitted {
                            // PUSH, so an operator who is not staring at this
                            // pane learns a decision is waiting. Emitted BEFORE
                            // the await because the prompt has to exist for them
                            // to act on: registration is the first thing
                            // `term_await_approval` does, synchronously, while the
                            // panel still has a network round trip to make before
                            // it reads `terminal_list`. (The panel also keeps a
                            // slow poll as a backstop, which is what covers the
                            // case where that ordering ever stops holding.)
                            //
                            // The frame is the EXISTING control frame, not a new
                            // event type: the panel's SSE layer forwards any `ev`
                            // frame as a window event and `useSessions` already
                            // refreshes `terminal_list` on this one.
                            bus.emit_term_output(
                                serde_json::json!({ "ev": "sessions-changed" }),
                            );
                            match terminal_mgr
                                .term_await_approval(&sid, &command, APPROVAL_WAIT_MS)
                                .await
                            {
                                Ok(crate::tools::terminal::ApprovalOutcome::Granted) => {}
                                // NOBODY ANSWERED. The command still does not run
                                // — fail-closed is unchanged — but the session is
                                // handed back and the question stays answerable,
                                // so an operator who was not watching can still
                                // say yes and the AI can pick it up with
                                // `approval_id`.
                                Ok(crate::tools::terminal::ApprovalOutcome::Parked {
                                    id,
                                    expires_in_ms,
                                }) => {
                                    terminal_mgr.term_release_execute(&sid).await;
                                    return Ok(json!({
                                        "kind": "session",
                                        "session_id": sid,
                                        // A STATE, not an error: the existing
                                        // vocabulary is done/partial/timeout, and
                                        // an error would tell the model the same
                                        // thing a refusal does. The two must stay
                                        // distinguishable — one means stop, the
                                        // other means the question is still open.
                                        "state": "awaiting_approval",
                                        // Unambiguous for a model that skims.
                                        "ran": false,
                                        "text": "",
                                        "approval": { "id": id, "expires_in_ms": expires_in_ms },
                                        "note": "The approval gate is armed and nobody has \
                                                 answered yet. The command did NOT run. Ask the \
                                                 operator to decide, then re-issue the SAME \
                                                 command with approval_id set to this id.",
                                    }));
                                }
                                // A refusal, or a device error. Both release the
                                // lock: this gate sits between the acquire above
                                // and every normal release below, so returning
                                // through `?` would leave `busy` set forever and
                                // the session would look alive while refusing
                                // every later command.
                                Err(e) => {
                                    terminal_mgr.term_release_execute(&sid).await;
                                    return Err(e);
                                }
                            }
                        }
                    }
                    // First-prompt gate (stage-l rework): the old gate waited
                    // for the OSC prompt marker that PowerShell 5.1 + ConPTY
                    // never emitted. A command entering PowerShell during
                    // profile-init still gets shredded into continuation
                    // prompts, so the gate stays — but completion no longer
                    // depends on an injected marker: it waits for the shell to
                    // produce ANY output (the profile banner, or the wrapper's
                    // echo once execute writes), and for wrapped commands also
                    // for the START marker. A session that produced output is
                    // alive and ready; a fully silent one gets a bounded wait
                    // then proceeds (the execute wait loop's start-timeout
                    // reports the failure explicitly instead of hanging).
                    // review #6: NO live entry yet (banner still in flight)
                    // must mean "prompt not seen" — the old false skipped
                    // the gate for open→execute races, dumping the command
                    // into mid-profile-init PowerShell (`>>` shredding).
                    let gate_needed = recover_guard(&buf)
                        .live.get(&sid).map(|e| !e.first_prompt_seen).unwrap_or(true);
                    if gate_needed && shell_633 {
                        // stage-m: the 633-injected shell announces itself with
                        // `633;A` at the first prompt — wait up to 12s for it
                        // (cold PowerShell + PSReadLine + profile init on a
                        // slow device regularly exceeds 3s). A shell that
                        // produced ANY output (banner or prompt) is alive; a
                        // fully silent one gets marked ready anyway and the
                        // execute wait loop's start-timeout reports the dead
                        // shell explicitly instead of hanging.
                        let gate_deadline = Instant::now() + std::time::Duration::from_secs(12);
                        let mut scan_from = recover_guard(&buf)
                            .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                        let mut pend: Vec<u8> = Vec::new();
                        let mut saw_any_output = false;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            if terminal_mgr.term_info(&sid).await.is_none() { break; }
                            let (chunk, n) = recover_guard(&buf)
                                .live.get(&sid)
                                .map(|e| {
                                    if e.dropped as usize > scan_from { scan_from = e.dropped as usize; }
                                    let sl = e.slice_from(scan_from);
                                    (sl.to_vec(), sl.len())
                                })
                                .unwrap_or_default();
                            if n > 0 {
                                scan_from += n;
                                saw_any_output = true;
                                pend.extend_from_slice(&chunk);
                            }
                            let cut = pend.len().saturating_sub(64);
                            if cut > 0 { pend.drain(..cut); }
                            // `633;A` = the injected Prompt ran → shell ready.
                            if crate::tools::terminal::shell_integration::find_prompt_started(&pend).is_some() {
                                if let Some(e) = recover_guard(&buf).live.get_mut(&sid) {
                                    e.first_prompt_seen = true;
                                }
                                break;
                            }
                            if Instant::now() >= gate_deadline { break; }
                        }
                        // Gate expired with NO output at all: mark the session
                        // ready anyway — the execute wait loop's start-timeout
                        // reports a dead shell explicitly instead of hanging.
                        if !saw_any_output {
                            if let Some(e) = recover_guard(&buf).live.get_mut(&sid) {
                                e.first_prompt_seen = true;
                            }
                        }
                    } else if gate_needed {
                        // Unknown-shell sessions (ssh/serial) have no 633
                        // injection — the shell is ready as soon as the
                        // session exists (the quiet path is tolerant).
                        if let Some(e) = recover_guard(&buf).live.get_mut(&sid) {
                            e.first_prompt_seen = true;
                        }
                    }
                    // Settle-drain: consume whatever still streams in from the
                    // PREVIOUS command before sampling the start offset —
                    // sampling end_abs while an earlier tail was mid-flight
                    // baked stale bytes into THIS result (observed live).
                    {
                        let settle_deadline = Instant::now() + std::time::Duration::from_millis(600);
                        let mut last_len: Option<usize> = None;
                        loop {
                            let cur = recover_guard(&buf)
                                .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                            if Some(cur) == last_len { break; }
                            last_len = Some(cur);
                            if Instant::now() >= settle_deadline { break; }
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    }
                    let mut read_abs = recover_guard(&buf)
                        .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                    // round-162: NO temporary widen — PSReadLine is removed
                    // at session open (see tool_open), so the wrapper echoes
                    // as one clean line at any width. No reflow scrambling.
                    // Write the command; on failure (session reaped mid-write)
                    // release the lock — the command never ran, nothing to
                    // audit, and the next execute must not bounce off a stale
                    // busy flag.
                    // round-162: (Netcatty's `\x1b\x15\x0b` clear-line prefix
                    // was TRIED and REVERTED — under Vale's ConPTY the ESC
                    // arrives as a keypress, not a sequence, so PowerShell
                    // executed the stray `\x15` as a command. The pre-START
                    // no-finalize rule (below) already keeps all pre-marker
                    // noise out of the result, so no prefix is needed.)
                    if let Err(e) = terminal_mgr.term_write(&sid, &cmd_with_nl).await {
                        terminal_mgr.term_release_execute(&sid).await;
                        return Err(e);
                    }
                    // Audit trail: command started — AFTER the write succeeded.
                    // A command that never reached the shell must not leave a
                    // dangling start that crash recovery reports as
                    // "interrupted" (round-55).
                    logger.log_command_start_run(
                        &sid,
                        &command,
                        intent.as_deref(),
                        considered.as_deref(),
                        plan_step,
                        run_id.as_deref(),
                    );
                    let quiet_dur = std::time::Duration::from_millis(quiet_ms);
                    // Background mode: return immediately with the read cursor
                    // so the caller can collect output incrementally.
                    // round-115: the busy lock is NOT released here — a
                    // background command still running while a foreground
                    // execute takes the lock makes the marker stream
                    // ambiguous (the marker carries no command identity, so
                    // the foreground call could return the BACKGROUND
                    // command's marker + exit code and miss its own output).
                    // A background task releases the lock when THIS command's
                    // marker (PTY) or quiet period (SSH/serial) arrives;
                    // foreground executes during that window get SessionBusy
                    // (correct — one shell runs one command at a time).
                    if run_in_background {
                        let start = recover_guard(&buf)
                            .live.get(&sid).map(|e| e.end_abs()).unwrap_or(0);
                        // round-98: audit — the command was handed to the
                        // shell; without an end line the trail permanently
                        // misreports it as "interrupted" on the next boot.
                        logger.log_status(&sid, "backgrounded");
                        // Phase 3: queryable job record — callers poll
                        // terminal_jobs instead of blind-read loops.
                        let job_id = format!("{}#{}", sid, start);
                        {
                            let jm_arc = jobs.clone();
                            let mut jm = jm_arc.lock().unwrap_or_else(|p| p.into_inner());
                            if jm.len() > 64 {
                                let mut finished: Vec<String> = jm.iter()
                                    .filter(|(_, j)| j.done).map(|(k, _)| k.clone()).collect();
                                finished.sort();
                                let excess = jm.len().saturating_sub(64);
                                for k in finished.into_iter().take(excess) { jm.remove(&k); }
                            }
                            jm.insert(job_id.clone(), JobInfo {
                                sid: sid.clone(), command: command.clone(),
                                started_unix: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_secs()).unwrap_or(0),
                                done: false, exit_code: None,
                            });
                        }
                        let job_id2 = job_id.clone();
                        // review #2: the waiter wrote the static jobs_map()
                        // while the insert used the per-registry `jobs`
                        // (the openapi test harness) map — terminal_jobs
                        // never observed done/exit_code. One map now.
                        let jobs_bg = jobs.clone();
                        let marker_confirm = std::time::Duration::from_millis(300);
                        let mgr2 = terminal_mgr.clone();
                        let buf2 = buf.clone();
                        let sid2 = sid.clone();
                        let quiet_dur2 = quiet_dur;
                        let start2 = start;
                        // stage-m: the background waiter uses the same
                        // 633;D detection as the foreground loop. Unknown
                        // shells (ssh/serial) → quiet fallback.
                        let shell_633_2 = shell_633;
                        tokio::spawn(async move {
                            // Wait for the background command to finish (same
                            // 633;D/quiet semantics as the foreground wait
                            // loop), then release the execute lock.
                            let mut read_abs = start2;
                            let mut quiet_since: Option<Instant> = None;
                            let mut marker_seen_at: Option<Instant> = None;
                            let mut pending: Vec<u8> = Vec::new();
                            loop {
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                // Session closed → release; retain_live already
                                // logged the end.
                                if mgr2.term_info(&sid2).await.is_none() { break; }
                                let (chunk, chunk_len) =
                                    poll_output_chunk(&buf2, &sid2, &mut read_abs, None);
                                if chunk_len > 0 {
                                    read_abs += chunk_len;
                                    pending.extend_from_slice(&chunk);
                                    if shell_633_2 {
                                        while let Some(f) = crate::tools::terminal::shell_integration::find_finished(&pending) {
                                            pending.drain(..f.end);
                                            marker_seen_at = Some(Instant::now());
                                            // P2-6: poison recovery, never skip the
                                            // write — an if-let-Ok drop here
                                            // swallowed done/exit_code and left
                                            // terminal_jobs reporting running
                                            // forever (same idiom as 377/988/1291).
                                            let mut jm = jobs_bg.lock().unwrap_or_else(|p| p.into_inner());
                                            if let Some(j) = jm.get_mut(&job_id2) {
                                                j.done = true;
                                                j.exit_code = f.exit_code;
                                            }
                                        }
                                    } else {
                                        // Unknown shell: quiet-period fallback.
                                        while let Some((mstart, mend, _code)) = find_prompt_marker(&pending) {
                                            pending.drain(..mend);
                                            marker_seen_at = Some(Instant::now());
                                            let _ = mstart;
                                        }
                                    }
                                    let keep = pending.len().saturating_sub(64);
                                    if keep > 0 { pending.drain(..keep); }
                                    quiet_since = None;
                                } else if quiet_since.is_none() {
                                    quiet_since = Some(Instant::now());
                                }
                                if let Some(at) = marker_seen_at {
                                    if at.elapsed() >= marker_confirm { break; }
                                } else if let Some(qs) = quiet_since {
                                    // 633 shells never break on quiet — the
                                    // 633;D marker (at command end) or the
                                    // session close is the only terminator.
                                    // Unknown-shell backends keep the quiet
                                    // fallback.
                                    if !shell_633_2 && qs.elapsed() >= quiet_dur2 { break; }
                                }
                            }
                            mgr2.term_release_execute(&sid2).await;
                        });
                        return Ok(json!({
                            "kind": "session",
                            "status": "running",
                            "job_id": job_id,
                            "read_from": start,
                            "hint": "collect output with terminal_read offset=read_from; command may still be running",
                        }));
                    }
                    // For the audit duration (round-58): wall-clock start.
                    let cmd_started = Instant::now();

                    let deadline = Instant::now() + std::time::Duration::from_secs(timeout_secs);
                    // Marker-confirm window (dsh handoffGraceMs): once the
                    // prompt marker arrives, wait this long before returning —
                    // bash prints the prompt and then hands the tty back, and
                    // a too-eager return could race that handoff.
                    let marker_confirm = std::time::Duration::from_millis(300);
                    // Idle confirm scales with session kind — SSH commands run
                    // remotely; their silent stretches must not read as done.
                    // round-157: doubled — plink/ssh tunnels and long silent
                    // commands (Start-Sleep, remote uci) have multi-second
                    // output gaps; the old 300ms/1.2s windows returned
                    // `state:"partial"` while the command was still running,
                    // which models misread as "commands queuing" and answered
                    // by spawning new sessions (observed: 321 idle-partials,
                    // 167 opens on d1 in one session).
                    let idle_confirm = match sess_kind.as_str() {
                        "ssh" => std::time::Duration::from_millis(3000),
                        "serial" => std::time::Duration::from_millis(4000),
                        _ => std::time::Duration::from_millis(1000),
                    };
                    let mut quiet_since: Option<Instant> = None;
                    // round-105: the quiet path extends ONCE (marker-injected
                    // PTYs: echo → quiet → marker at next prompt). A second
                    // quiet expiry breaks idle — marker-less backends must
                    // not loop to the deadline.
                    let mut quiet_extended = false;
                    // round-107: when the extension is taken, the second
                    // expiry fires marker_confirm after the FIRST expiry
                    // (not 2x quiet_dur, and never a future panic).
                    let mut quiet_confirm_at: Option<Instant> = None;
                    // stage-l: the OSC marker contract is gone. Wrapped
                    // (known-shell) sessions end on the wrapper's END marker;
                    // unknown-shell sessions (ssh/serial) keep the bounded
                    // quiet path. The marker_injected flag is no longer
                    // consulted — `wrap_shell` is the only driver.
                    let mut result = String::new();
                    // Result-cap rules (chunk trim + char-boundary safety)
                    // live in bounded_append — every call site below passes
                    // MAX_SESSION_BYTES.
                    // Marker scanner state: the wrapper's plain-text markers
                    // (`<marker>_S` / `<marker>_E:<code>`) may span chunks, so
                    // the un-finalized tail stays pending until it cannot be a
                    // marker prefix anymore. `pending` starts EMPTY for wrapped
                    // commands — the settle-drain + START marker scan discard
                    // everything before the marker (the wrapper echo + prompt).
                    // Unknown-shell sessions keep the old OSC scan for
                    // backward-compat reads (a marker-injected legacy session
                    // still emits them), plus the quiet fallback.
                    let mut pending: Vec<u8> = Vec::new();
                    let mut marker_code: Option<i32> = None;
                    let mut marker_seen_at: Option<Instant> = None;
                    // Every exit path below assigns it (marker / idle / timeout).
                    let wait_reason: &str;

                    let mut truncated = false;
                    let mut timed_out = false;
                    // Poll cadence: 50ms keeps output responsiveness; the
                    // liveness heartbeat only needs ~1s granularity — a
                    // term_select every 50ms hammered the manager lock
                    // for no benefit (round-55).
                    let mut ticks: u64 = 0;
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        ticks += 1;
                        // Client-liveness heartbeat every 1s: the 15-min idle
                        // sweeper kills sessions with no OUTPUT — a long quiet
                        // command (build, sleep 600, interactive SSH) would be
                        // reaped mid-execute even though the MCP client is
                        // actively waiting on this execute (round-49). A
                        // genuinely abandoned session still dies via the
                        // sweeper once the execute returns.
                        if ticks.is_multiple_of(20) {
                            let _ = terminal_mgr.term_select(&sid).await;
                        }
                        // round-110: session liveness comes from the MANAGER
                        // map, not the output buffer — the buffer entry is
                        // created lazily on the first output chunk, so a
                        // silent-but-alive session (serial modem, no-echo PTY)
                        // would false-fire 'closed' before its first output.
                        if terminal_mgr.term_info(&sid).await.is_none() {
                            wait_reason = "closed";
                            break;
                        }
                        let (chunk, chunk_len) = poll_output_chunk(
                            &buf,
                            &sid,
                            &mut read_abs,
                            Some(&mut truncated),
                        );
                        if chunk_len > 0 {
                            read_abs += chunk_len;
                            pending.extend_from_slice(&chunk);
                            if shell_633 {
                                // stage-m (VS Code shell integration): the
                                // injected PowerShell emits `633;D[;rc]` when a
                                // command finishes — scan for it. Everything
                                // before the FIRST `633;D` of this command is
                                // pre-command noise (prompt sequences + the
                                // command's own echo), finalized into `result`
                                // once the first 633;D arrives (the sequence
                                // itself is invisible on the terminal).
                                while let Some(f) = crate::tools::terminal::shell_integration::find_finished(&pending) {
                                    if f.end > 0 {
                                        bounded_append(&mut result, &mut truncated, &String::from_utf8_lossy(&pending[..f.end]), MAX_SESSION_BYTES);
                                    }
                                    pending.drain(..f.end);
                                    marker_code = f.exit_code;
                                    marker_seen_at = Some(Instant::now());
                                }
                            } else {
                                // Unknown shell: legacy OSC scan (backward-
                                // compat for marker-injected legacy sessions)
                                // + quiet fallback.
                                while let Some((start, end, code)) = find_prompt_marker(&pending) {
                                    if start > 0 {
                                        bounded_append(&mut result, &mut truncated, &String::from_utf8_lossy(&pending[..start]), MAX_SESSION_BYTES);
                                    }
                                    pending.drain(..end);
                                    marker_code = Some(code);
                                    marker_seen_at = Some(Instant::now());
                                    if let Some(e) = recover_guard(&buf).live.get_mut(&sid) {
                                        e.first_prompt_seen = true;
                                    }
                                }
                            }
                            // Finalize everything that can no longer be a
                            // marker prefix.
                            // stage-m: no START marker — keep the 64B finalize
                            // window so a 633;D split across chunks is never
                            // lost, then append the rest.
                            let keep = pending.len().saturating_sub(64);
                            if keep > 0 {
                                bounded_append(&mut result, &mut truncated, &String::from_utf8_lossy(&pending[..keep]), MAX_SESSION_BYTES);
                                pending.drain(..keep);
                            }
                            quiet_since = None;
                        } else if quiet_since.is_none() {
                            quiet_since = Some(Instant::now());
                        }
                            // The 633;D marker is the AUTHORITATIVE "command
                            // finished" signal: while its confirm window runs, a
                            // quiet gap must not trigger the idle path — the
                            // command may be done and the marker chunk simply not
                            // read yet.
                            if let Some(at) = marker_seen_at {
                                if at.elapsed() >= marker_confirm {
                                    wait_reason = "marker";
                                    break;
                                }
                            } else if let Some(qs) = quiet_since {
                                if qs.elapsed() >= quiet_dur {
                                    // Unknown-shell backends (ssh/serial) keep the
                                    // bounded once-extension quiet path. 633 shells
                                    // never break on quiet — the 633;D marker (at
                                    // command end) or the deadline is the only
                                    // terminator.
                                    if !shell_633 {
                                        if !quiet_extended {
                                            quiet_extended = true;
                                            quiet_since = Some(Instant::now());
                                            quiet_confirm_at = Some(Instant::now() + idle_confirm);
                                        } else if quiet_confirm_at.map(|t| Instant::now() >= t).unwrap_or(true) {
                                            wait_reason = "idle";
                                            break;
                                        }
                                    } else {
                                        // Still waiting for 633;D — keep polling
                                        // (the deadline check below ends the wait
                                        // if the command truly hangs).
                                        quiet_since = Some(Instant::now());
                                    }
                                }
                            }
                            if Instant::now() >= deadline {
                                // Timeout: abort the running command (kill the PTY
                                // process tree / ^C over SSH) so a timed-out
                                // command cannot keep running on the device. The
                                // session itself stays open (round-54).
                                let _ = terminal_mgr.term_terminate(&sid).await;
                                timed_out = true;
                                wait_reason = "timeout";
                                break;
                            }
                        }
                    // round-103: flush the un-finalized marker window — the
                    // last ≤64 bytes of real output sat in `pending` and were
                    // DROPPED on the idle/timeout break (a short command's
                    // ENTIRE output; marker-less SSH/serial always).
                    if !pending.is_empty() {
                        let keep = pending.len();
                        bounded_append(&mut result, &mut truncated, &String::from_utf8_lossy(&pending[..keep]), MAX_SESSION_BYTES);
                        pending.clear();
                    }
                    // Audit trail: command ended, with the shell's exit code
                    // (marker) and the reason the wait stopped (round-54).
                    logger.log_command_end(&sid, marker_code, Some(wait_reason),
                        Some(cmd_started.elapsed().as_millis() as u64));
                    // Release the per-session execute lock (round-55) — the
                    // only exit path from the wait loop.
                    terminal_mgr.term_release_execute(&sid).await;
                    bus.emit(&AgentEvent::ShellExec {
                    command: command.to_string(),
                });
                    // stage-m: no wrapper → nothing to strip. The 633
                    // sequences are invisible on the terminal and were already
                    // consumed during the wait.
                    let result = result;
                    // Strip ANSI/OSC noise for the model — the MCP text path
                    // must be printable text; the panel keeps raw bytes
                    // via its own SSE stream (round-54, dsh sanitize.ts).
                    let result = clean_terminal_output(result.as_bytes());
                    let state = match wait_reason {
                        "marker" => "done",
                        // stage-l: a wrapped command whose START marker never
                        // arrived is a DEFINITE failure (the shell swallowed
                        // the wrapper) — report it like a timeout, never as
                        // "still running" (that note would make the model
                        // re-read/retry a command that never started).
                        "start-timeout" => "timeout",
                        "timeout" => "timeout",
                        _ => "partial",
                    };
                    Ok(execute_result_json(
                        state, result, truncated, timed_out, wait_reason, marker_code, read_abs,
                    ))
                } else {
                    Ok(execute_local(&command, timeout_secs, &bus).await?)
                }
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_append, find_prompt_marker, poll_output_chunk, signal_tree, tail_append,
        wait_for_exit,
    };
    use crate::plugins::terminal::SessionBuf;
    use crate::plugins::terminal::SessionStore;
    use std::sync::{Arc, Mutex};

    fn store_with(sid: &str, buf: SessionBuf) -> Arc<Mutex<SessionStore>> {
        let mut st = SessionStore::new();
        st.live.insert(sid.to_string(), buf);
        Arc::new(Mutex::new(st))
    }

    #[test]
    fn poll_chunk_reads_from_cursor() {
        let buf = store_with(
            "s1",
            SessionBuf {
                data: b"hello world".to_vec(),
                ..Default::default()
            },
        );
        let mut read_abs = 6;
        let mut truncated = false;
        let (chunk, len) = poll_output_chunk(&buf, "s1", &mut read_abs, Some(&mut truncated));
        assert_eq!(len, 5);
        assert_eq!(chunk, b"world");
        assert_eq!(
            read_abs, 6,
            "helper leaves the cursor for the caller to advance (read_abs += chunk_len)"
        );
        assert!(!truncated);
    }

    #[test]
    fn poll_chunk_jumps_past_eviction_and_reports_truncation() {
        // round-94 semantics: eviction advanced `dropped` past the cursor;
        // the cursor must jump to `dropped` and the foreground loop must
        // learn the output was truncated (1MB burst).
        let buf = store_with(
            "s1",
            SessionBuf {
                data: b"tail-after-burst".to_vec(),
                dropped: 100,
                ..Default::default()
            },
        );
        let mut read_abs = 40; // stale cursor, eviction already at 100
        let mut truncated = false;
        let (chunk, len) = poll_output_chunk(&buf, "s1", &mut read_abs, Some(&mut truncated));
        assert!(truncated, "foreground loop must be told about the drop");
        assert_eq!(read_abs, 100, "cursor jumps to the eviction mark");
        assert_eq!(len, b"tail-after-burst".len(), "window tail is returned");
        assert_eq!(chunk, b"tail-after-burst");
    }

    #[test]
    fn poll_chunk_bg_loop_ignores_truncation_reporting() {
        // The background wait loop passes None: same jump semantics, no
        // truncation flag (nothing to report it to).
        let buf = store_with(
            "s1",
            SessionBuf {
                data: b"xy".to_vec(),
                dropped: 7,
                ..Default::default()
            },
        );
        let mut read_abs = 0;
        let (chunk, len) = poll_output_chunk(&buf, "s1", &mut read_abs, None);
        assert_eq!(read_abs, 7);
        assert_eq!(len, 2);
        assert_eq!(chunk, b"xy");
    }

    #[test]
    fn poll_chunk_unknown_session_returns_empty() {
        let buf = store_with("s1", SessionBuf::default());
        let mut read_abs = 0;
        let (chunk, len) = poll_output_chunk(&buf, "nope", &mut read_abs, None);
        assert_eq!(len, 0);
        assert!(chunk.is_empty());
        assert_eq!(read_abs, 0);
    }

    #[test]
    fn poll_chunk_cursor_past_end_returns_empty_window() {
        let buf = store_with(
            "s1",
            SessionBuf {
                data: b"abc".to_vec(),
                ..Default::default()
            },
        );
        let mut read_abs = 99; // beyond end (no eviction)
        let (chunk, len) = poll_output_chunk(&buf, "s1", &mut read_abs, None);
        assert_eq!(len, 0);
        assert!(chunk.is_empty());
        assert_eq!(read_abs, 99, "no eviction → cursor unchanged");
    }
    #[test]
    fn tail_append_within_cap_keeps_everything() {
        let mut cap = Vec::new();
        let mut truncated = false;
        tail_append(&mut cap, &mut truncated, b"ab".to_vec(), 100);
        tail_append(&mut cap, &mut truncated, b"cd".to_vec(), 100);
        assert_eq!(cap, b"abcd");
        assert!(!truncated);
    }

    #[test]
    fn tail_append_oversized_chunk_keeps_newest_half() {
        let mut cap = b"prefix-older".to_vec(); // 12 bytes; keep = 50
        let mut truncated = false;
        tail_append(&mut cap, &mut truncated, vec![b'x'; 90], 100);
        assert!(truncated);
        // 12 < keep (50) so the pre-drain does not fire; 12+90=102 > cap →
        // the post-extend trim drops the newest 2 oldest bytes → exactly 100
        assert_eq!(cap.len(), 100);
        assert!(cap.ends_with(&[b'x'; 90]));
    }

    #[test]
    fn tail_append_accumulated_overflow_trims_to_cap() {
        let mut cap = Vec::new();
        let mut truncated = false;
        for _ in 0..5 {
            tail_append(&mut cap, &mut truncated, vec![b'a'; 30], 100);
        }
        // 4th append: 90+30=120 > 100 → keep=50, drain to 50, +30 = 80
        // (< cap — no post-trim). Semantics: newest half + the new chunk.
        assert_eq!(cap.len(), 80);
        assert!(truncated);
    }
    #[test]
    fn prompt_marker_complete_sequence() {
        // ESC ]133;D;42 BEL → (start, end, 42)
        let data = b"out\x1b]133;D;42\x07more";
        let (s, e, code) = find_prompt_marker(data).unwrap();
        assert_eq!(&data[s..e], b"\x1b]133;D;42\x07");
        assert_eq!(code, 42);
    }

    #[test]
    fn prompt_marker_incomplete_returns_none() {
        // Marker split across chunks (no BEL yet) — caller keeps waiting.
        assert_eq!(find_prompt_marker(b"\x1b]133;D;4"), None);
        assert_eq!(find_prompt_marker(b"no marker here"), None);
    }

    #[test]
    fn prompt_marker_false_prefix_then_real_marker() {
        // round-100: a literal \x1b]133;D; with no digits/BEL must not
        // poison the search — a REAL marker later still matches.
        let data = b"log \x1b]133;D; text\n\x1b]133;D;7\x07";
        let (s, e, code) = find_prompt_marker(data).unwrap();
        assert_eq!(code, 7);
        assert_eq!(&data[s..e], b"\x1b]133;D;7\x07");
    }

    // ── bounded_append (session-mode result cap) ─────────────
    //
    // Every assertion here corresponds to an incident that wedged the
    // session busy flag forever, so each one is a regression gate, not a
    // style preference.

    #[test]
    fn bounded_append_under_cap_is_a_plain_append() {
        let mut out = String::from("head|");
        let mut truncated = false;
        bounded_append(&mut out, &mut truncated, "tail", 64);
        assert_eq!(out, "head|tail");
        assert!(!truncated, "no bytes were dropped");
    }

    #[test]
    fn bounded_append_on_overflow_keeps_the_newest_bytes() {
        // 10 + 6 = 16 against max=12 → drop exactly 4, so the buffer lands ON
        // the cap: the oldest bytes go and the incoming tail is kept whole.
        let mut out = String::from("aaaaaaaaaa"); // 10
        let mut truncated = false;
        bounded_append(&mut out, &mut truncated, "bbbbbb", 12);
        assert!(truncated, "dropping bytes must be reported");
        assert_eq!(out, "aaaaaabbbbbb", "the OLDEST bytes go, the tail stays");
        assert_eq!(out.len(), 12, "the drain reclaims exactly the overflow");
    }

    #[test]
    fn bounded_append_trims_an_oversized_single_chunk() {
        // round-113: one burst between two 50ms polls can exceed the cap.
        // Trimming only on the NEXT append let it through in full.
        let mut out = String::new();
        let mut truncated = false;
        bounded_append(&mut out, &mut truncated, &"x".repeat(100), 10);
        assert!(truncated);
        assert_eq!(out.len(), 10, "the chunk itself is capped");
        assert_eq!(out, "x".repeat(10));
    }

    #[test]
    fn bounded_append_chunk_trim_never_slices_mid_character() {
        // review #1: after floor_char_boundary(max), `s.len() - keep` can land
        // mid-character; `&s[start..]` then panicked INSIDE the wait loop,
        // past term_release_execute. "a汉" repeats to 16 bytes with boundaries
        // at 0,1,4,5,8,9,12,13,16 — max=10 gives keep=9, start=7 (NOT a
        // boundary), so the walk-forward is what prevents the panic.
        let s = "a汉a汉a汉a汉";
        assert_eq!(s.len(), 16);
        assert!(
            !s.is_char_boundary(7),
            "the fixture must reproduce the hazard"
        );
        let mut out = String::new();
        let mut truncated = false;
        bounded_append(&mut out, &mut truncated, s, 10);
        assert!(truncated);
        assert!(
            s.ends_with(&out),
            "the kept window is a suffix of the chunk"
        );
        assert!(
            out.is_char_boundary(out.len()),
            "valid UTF-8, not a torn char"
        );
        assert_eq!(out, "a汉a汉");
    }

    #[test]
    fn bounded_append_drain_never_cuts_mid_character() {
        // round-106: String::drain panics on a non-boundary; output is
        // lossy-converted arbitrary bytes, so a CJK flood panicked the loop.
        // drop = 16 + 4 - 10 = 10, and 10 is NOT a boundary of the 16-byte
        // buffer (boundaries 0,1,4,5,8,9,12,13,16) — the walk back to 9 is
        // what prevents the panic.
        let mut out = String::from("a汉a汉a汉a汉");
        assert_eq!(out.len(), 16);
        assert!(
            !out.is_char_boundary(10),
            "the fixture must reproduce the hazard"
        );
        let mut truncated = false;
        bounded_append(&mut out, &mut truncated, "tail", 10);
        assert!(truncated);
        assert!(out.ends_with("tail"));
        assert!(out.len() >= 4, "draining must not eat the whole buffer");
    }

    #[test]
    fn bounded_append_drain_is_clamped_to_the_buffer() {
        // The drop index is clamped to result.len(): an incoming chunk larger
        // than `max` must not underflow or drain past the end.
        let mut out = String::from("abc");
        let mut truncated = false;
        bounded_append(&mut out, &mut truncated, &"z".repeat(50), 4);
        assert!(truncated);
        assert_eq!(out, "zzzz", "old buffer dropped, cap respected");
    }

    #[test]
    fn bounded_append_survives_an_exact_fit() {
        let mut out = String::from("abcd");
        let mut truncated = false;
        bounded_append(&mut out, &mut truncated, "efgh", 8);
        assert_eq!(out, "abcdefgh");
        assert!(!truncated, "exactly max is not an overflow");
    }

    // ── kill-tree policy (signal_tree / wait_for_exit) ───────
    //
    // These drive REAL processes. They are the only coverage of the round-55
    // contract ("a timeout kills the tree, not just the shell") — previously
    // the whole policy was inline in execute_local and untested, with the
    // Unix and Windows arms never compiled together.

    /// Spawn a local shell exactly like `execute_local` does — same shell,
    /// same `process_group(0)` on Unix, so the test exercises the real
    /// group-targeting the kill path depends on.
    fn spawn_shell(script: &str) -> tokio::process::Child {
        let (shell, flag) = if cfg!(target_os = "windows") {
            ("cmd", "/C")
        } else {
            ("sh", "-c")
        };
        let mut cmd = tokio::process::Command::new(shell);
        cmd.arg(flag)
            .arg(script)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        cmd.process_group(0);
        cmd.spawn().expect("spawn test shell")
    }

    #[tokio::test]
    async fn wait_for_exit_sees_a_finished_child() {
        // `exit 0` finishes immediately: the helper must report the exit well
        // inside its patience, not merely time out successfully.
        let mut child = spawn_shell("exit 0");
        assert!(
            wait_for_exit(&mut child, std::time::Duration::from_secs(10)).await,
            "a finished child must be reported as exited"
        );
    }

    #[tokio::test]
    async fn wait_for_exit_gives_up_on_a_stubborn_child() {
        // A long sleeper must NOT be reported as exited — that is what makes
        // the bounded re-await bounded (a D-state group cannot hang the tool).
        let mut child = spawn_shell("sleep 30");
        let started = std::time::Instant::now();
        assert!(
            !wait_for_exit(&mut child, std::time::Duration::from_millis(400)).await,
            "a running child must not be reported as exited"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "the helper must return at its patience, not the child's lifetime"
        );
        let _ = child.kill().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn force_signal_kills_the_whole_group_not_just_the_shell() {
        // THE round-55 contract. The shell backgrounds a grandchild and waits,
        // so the direct child dying is NOT proof: the grandchild holds the
        // pipe. Kill the GROUP and the grandchild must go too.
        let mut child = spawn_shell("sleep 30 & sleep 30");
        let pid = child.id().expect("child pid");
        // Let the background grandchild actually start before signalling.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        signal_tree(pid, true).await;

        assert!(
            wait_for_exit(&mut child, std::time::Duration::from_secs(10)).await,
            "the direct child must die from a group SIGKILL"
        );
        // `kill -0 -PID` probes the whole group: it fails only when EVERY
        // member is gone, which is the actual promise being made here.
        //
        // IT IS POLLED, NOT SAMPLED ONCE. A killed group member becomes a
        // ZOMBIE, and `kill -0` succeeds on a zombie — its pid still exists
        // until the reaper runs. On a loaded runner (this suite is 12 parallel
        // binaries) that reaping can lag the direct child's by milliseconds, so
        // a single sample straight after `wait_for_exit` intermittently saw a
        // corpse and failed. That is what this test did, and it went red on CI
        // while passing 20/20 locally — the classic tell of a load-dependent
        // race rather than a broken kill.
        //
        // Polling does NOT weaken the assertion: a genuinely live member never
        // disappears, so a kill that failed to reach the tree still fails here,
        // just a second later. Verified by mutation — see the commit message.
        let mut group_alive = true;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            group_alive = std::process::Command::new("kill")
                .args(["-0", "--", &format!("-{pid}")])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !group_alive {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            !group_alive,
            "group {pid} still has live members 5s after the group SIGKILL — \
             the kill did not reach the tree (a zombie would have been reaped by now)"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn graceful_signal_is_enough_for_a_cooperative_tree() {
        // The graceful arm must be a real SIGTERM (a typo there would leave
        // the grace window pointless and force every timeout to SIGKILL).
        let mut child = spawn_shell("sleep 30");
        let pid = child.id().expect("child pid");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        signal_tree(pid, false).await;

        assert!(
            wait_for_exit(&mut child, std::time::Duration::from_secs(10)).await,
            "SIGTERM must terminate the group"
        );
    }

    #[tokio::test]
    async fn signalling_an_already_dead_pid_is_harmless() {
        // The kill path is best-effort by design (`let _ =`): a pid that
        // already exited — or a signal binary that refuses — must never turn
        // a timeout into a tool error.
        let mut child = spawn_shell("exit 0");
        let pid = child.id().expect("child pid");
        assert!(wait_for_exit(&mut child, std::time::Duration::from_secs(10)).await);
        signal_tree(pid, false).await;
        signal_tree(pid, true).await;
    }

    /// THE GATE SITS BEFORE THE SHELL WRITE — and that ordering IS the safety
    /// property, so it is pinned structurally rather than left to review.
    ///
    /// The approval wait and the shell write are ~110 lines apart inside one
    /// branch of a very long function, which is exactly the distance across which
    /// a later edit can move one without noticing. Moving the wait BELOW the
    /// write turns the gate into advice: a denied or unanswered command would
    /// already be running on the device while the operator is still reading the
    /// prompt.
    ///
    /// A source scan rather than a behavioural test because the property is about
    /// ORDER of two calls on one code path; driving it end-to-end would need a
    /// real PTY, a spawned approver and a race, and would still only cover the
    /// branch it happened to exercise.
    ///
    /// Limits, stated: this compares line positions in THIS file, so it cannot see
    /// a write that moves into a helper.
    #[test]
    fn the_approval_gate_is_placed_before_the_shell_write() {
        let src = include_str!("exec.rs");
        let production = src.split("#[cfg(test)]").next().expect("file is not empty");
        let gate = production.find("term_await_approval(").expect(
            "the approval gate is GONE from the execute path — an armed \
                     session would run commands with nobody asked",
        );
        let write = production.find("term_write(&sid, &cmd_with_nl)").expect(
            "the shell write moved or was renamed; re-point this pin rather \
                     than deleting it — it is the only thing asserting the gate \
                     comes first",
        );
        assert!(
            gate < write,
            "the approval gate must be evaluated BEFORE the command reaches the \
             shell (gate at byte {gate}, write at byte {write}). After the write \
             a denied command has already run."
        );
        // And it must be GATED on the mode, not called unconditionally: an
        // unconditional wait would block every autonomous execute for a minute.
        let guard = production
            .find("term_approval_required(")
            .expect("the gate lost its mode check — every execute would now block");
        assert!(
            guard < gate,
            "the mode check must come before the wait, or an unarmed session still \
             blocks"
        );
    }
}
