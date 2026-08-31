//! System MCP tools — stateless one-shot OS operations on THIS device.
//!
//! 6 tools: system_file_list / system_file_read / system_file_write /
//!          system_process_list / system_process_kill / system_net_test.
//!
//! Design notes:
//! - Every call is self-contained (no session, no cursor) — AI agents get a
//!   structured answer in one round trip, unlike shell sessions where output
//!   must be read incrementally.
//! - Reads are capped and writes are size-limited so a runaway agent cannot
//!   fill the disk or blow the MCP response.
//! - Errors are returned as structured JSON (`{"ok": false, "error": ...}`),
//!   never thrown — the model sees a readable failure, not an exception.

use serde_json::{json, Value};
use vale_agent_core::ToolDef;

use crate::plugins::{require_str, to_value_or_empty};

const MAX_READ_BYTES: u64 = 256 * 1024; // 256 KiB per file_read
const MAX_WRITE_BYTES: usize = 4 * 1024 * 1024; // 4 MiB per file_write
const MAX_LIST_ENTRIES: usize = 500;

/// Build the system plugin's tool set (stateless — no captures).
pub fn build() -> Vec<ToolDef> {
    vec![
        tool_file_list(),
        tool_file_read(),
        tool_file_write(),
        tool_process_list(),
        tool_process_kill(),
        tool_net_test(),
    ]
}

fn tool_file_list() -> ToolDef {
    ToolDef::new(
        "system_file_list",
        "List a directory on THIS device (the agent host). Returns entries with name, kind (file/dir/symlink), size, and modified time. Absolute or relative paths (relative = agent working dir). Capped at 500 entries.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory to list (absolute path recommended, e.g. C:\\Users\\me\\Documents or /tmp)."},
                "recursive": {"type": "boolean", "description": "Also list one level of subdirectory contents. Default false."}
            },
            "required": ["path"]
        }),
        move |params: Value| {
            async move {
                let path = require_str(&params, "path")?;
                let recursive = params.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
                let dir = std::path::PathBuf::from(&path);
                let mut read = match tokio::fs::read_dir(&dir).await {
                    Ok(r) => r,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("read_dir {path}: {e}")}))),
                };
                let mut entries: Vec<Value> = Vec::new();
                loop {
                    if entries.len() >= MAX_LIST_ENTRIES { break; }
                    let ent = match read.next_entry().await {
                        Ok(Some(e)) => e,
                        Ok(None) => break,
                        Err(_) => break,
                    };
                    let name = ent.file_name().to_string_lossy().to_string();
                    let meta = ent.metadata().await;
                    let (kind, size, modified) = match &meta {
                        Ok(m) => (
                            if m.is_dir() { "dir" } else if m.is_symlink() { "symlink" } else { "file" },
                            m.len(),
                            m.modified().ok().map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)),
                        ),
                        Err(_) => ("unknown", 0u64, None),
                    };
                    entries.push(json!({
                        "name": name,
                        "kind": kind,
                        "size": size,
                        "modified_unix": modified,
                    }));
                    // One level of recursion for dirs.
                    if recursive && kind == "dir" {
                        let mut sub = match tokio::fs::read_dir(ent.path()).await { Ok(s) => s, Err(_) => continue };
                        loop {
                            if entries.len() >= MAX_LIST_ENTRIES { break; }
                            let subent = match sub.next_entry().await {
                                Ok(Some(e)) => e,
                                Ok(None) => break,
                                Err(_) => break,
                            };
                            let sm = subent.metadata().await;
                            entries.push(json!({
                                "name": format!("{name}/{}", subent.file_name().to_string_lossy()),
                                "kind": match &sm { Ok(m) if m.is_dir() => "dir", Ok(_) => "file", _ => "unknown" },
                                "size": sm.as_ref().map(|m| m.len()).unwrap_or(0),
                                "modified_unix": sm.as_ref().ok().and_then(|m| m.modified().ok()).map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)),
                            }));
                        }
                    }
                }
                Ok(to_value_or_empty(json!({"ok": true, "path": path, "count": entries.len(), "entries": entries})))
            }
        },
    )
}

fn tool_file_read() -> ToolDef {
    ToolDef::new(
        "system_file_read",
        "Read a file on THIS device (the agent host). Returns the content as UTF-8 text (binary files return an error — use a terminal session for binary inspection), capped at 256 KiB. `raw: true` returns base64 for binary-safe reads.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path (absolute recommended)."},
                "offset": {"type": "integer", "description": "Byte offset to start from (default 0)."},
                "limit": {"type": "integer", "description": "Max bytes to read (default 65536, cap 262144)."},
                "raw": {"type": "boolean", "description": "Return base64-encoded raw bytes (for binary files). Default false (text)."}
            },
            "required": ["path"]
        }),
        move |params: Value| {
            async move {
                let path = require_str(&params, "path")?;
                let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
                let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(65536).min(MAX_READ_BYTES);
                let raw = params.get("raw").and_then(|v| v.as_bool()).unwrap_or(false);
                // Async read — the agent runtime must never block on disk I/O
                // (a slow network drive would stall the whole MCP server).
                let mut f = match tokio::fs::File::open(&path).await {
                    Ok(f) => f,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("open {path}: {e}")}))),
                };
                use tokio::io::{AsyncReadExt, AsyncSeekExt};
                if offset > 0 {
                    use std::io::SeekFrom;
                    if let Err(e) = f.seek(SeekFrom::Start(offset)).await {
                        return Ok(to_value_or_empty(json!({"ok": false, "error": format!("seek: {e}")})));
                    }
                }
                let mut buf = vec![0u8; limit as usize];
                let mut total = 0usize;
                loop {
                    if total >= buf.len() { break; }
                    match f.read(&mut buf[total..]).await {
                        Ok(0) => break,
                        Ok(n) => total += n,
                        Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("read: {e}")}))),
                    }
                }
                buf.truncate(total);
                let size = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
                if raw {
                    use base64::Engine;
                    Ok(to_value_or_empty(json!({
                        "ok": true, "path": path, "offset": offset, "bytes": buf.len(), "size": size,
                        "data": base64::engine::general_purpose::STANDARD.encode(&buf),
                    })))
                } else {
                    let text = String::from_utf8_lossy(&buf).to_string();
                    Ok(to_value_or_empty(json!({
                        "ok": true, "path": path, "offset": offset, "bytes": buf.len(), "size": size,
                        "text": text, "truncated": buf.len() as u64 == limit,
                    })))
                }
            }
        },
    )
}

fn tool_file_write() -> ToolDef {
    ToolDef::new(
        "system_file_write",
        "Write text or base64 data to a file on THIS device (the agent host). Creates the file if missing, overwrites by default; set `append: true` to append instead. Capped at 4 MiB per call. Returns bytes written.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path (absolute recommended)."},
                "text": {"type": "string", "description": "Text content to write (use either text or data, not both)."},
                "data": {"type": "string", "description": "Base64-encoded binary content to write (use either text or data, not both)."},
                "append": {"type": "boolean", "description": "Append to the file instead of overwriting. Default false."}
            },
            "required": ["path"]
        }),
        move |params: Value| {
            async move {
                let path = require_str(&params, "path")?;
                let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let data_b64 = params.get("data").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let append = params.get("append").and_then(|v| v.as_bool()).unwrap_or(false);
                let bytes: Vec<u8> = if !data_b64.is_empty() {
                    use base64::Engine;
                    match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                        Ok(b) => b,
                        Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("base64 decode: {e}")}))),
                    }
                } else {
                    text.into_bytes()
                };
                if bytes.is_empty() {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": "empty content (provide text or data)"})));
                }
                if bytes.len() > MAX_WRITE_BYTES {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": format!("content too large ({} bytes, max {MAX_WRITE_BYTES})", bytes.len())})));
                }
                use tokio::io::AsyncWriteExt;
                let mut opts = tokio::fs::OpenOptions::new();
                opts.write(true).create(true).append(append);
                if !append { opts.truncate(true); }
                let mut f = match opts.open(&path).await {
                    Ok(f) => f,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("open {path}: {e}")}))),
                };
                match f.write_all(&bytes).await {
                    Ok(()) => {}
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("write: {e}")}))),
                }
                let _ = f.flush().await;
                Ok(to_value_or_empty(json!({"ok": true, "path": path, "bytes": bytes.len(), "append": append})))
            }
        },
    )
}

fn tool_process_list() -> ToolDef {
    ToolDef::new(
        "system_process_list",
        "List running processes on THIS device (the agent host). Returns pid, name, and memory (KB). Optional `name` filter (case-insensitive substring).",
        json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Optional case-insensitive substring filter on process name (e.g. 'electron', 'vale')."}
            }
        }),
        move |params: Value| {
            async move {
                let filter = params.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                let mut out = tokio::process::Command::new("tasklist")
                    .args(["/FO", "CSV", "/NH"])
                    .output()
                    .await;
                if out.is_err() {
                    // tasklist is Windows-only; fall back to ps for Unix.
                    out = tokio::process::Command::new("ps").args(["-eo", "pid,comm,rss"]).output().await;
                }
                let out = match out {
                    Ok(o) if o.status.success() => o,
                    Ok(_) => return Ok(to_value_or_empty(json!({"ok": false, "error": "process listing failed (no tasklist/ps)"}))),
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("spawn: {e}")}))),
                };
                let text = String::from_utf8_lossy(&out.stdout).to_string();
                let mut procs: Vec<Value> = Vec::new();
                for line in text.lines() {
                    let line = line.trim();
                    if line.is_empty() { continue; }
                    // tasklist CSV: "image.exe","pid","session","session#","mem"
                    if line.starts_with('"') {
                        let parts: Vec<&str> = line.split(',').map(|s| s.trim_matches('"')).collect();
                        if parts.len() >= 5 {
                            let name = parts[0].to_string();
                            if !filter.is_empty() && !name.to_lowercase().contains(&filter) { continue; }
                            procs.push(json!({
                                "pid": parts[1].parse::<u64>().unwrap_or(0),
                                "name": name,
                                "mem_kb": parts[4].parse::<u64>().unwrap_or(0),
                            }));
                        }
                    } else {
                        // ps output: pid comm rss
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        if parts.len() >= 3 {
                            let name = parts[1].to_string();
                            if !filter.is_empty() && !name.to_lowercase().contains(&filter) { continue; }
                            procs.push(json!({
                                "pid": parts[0].parse::<u64>().unwrap_or(0),
                                "name": name,
                                "mem_kb": parts[2].parse::<u64>().unwrap_or(0),
                            }));
                        }
                    }
                }
                procs.sort_by_key(|p| p["pid"].as_u64().unwrap_or(0));
                Ok(to_value_or_empty(json!({"ok": true, "count": procs.len(), "processes": procs})))
            }
        },
    )
}

fn tool_process_kill() -> ToolDef {
    ToolDef::new(
        "system_process_kill",
        "Kill a process on THIS device (the agent host) by PID or by name (kills all matching). Use system_process_list first to find the target. Returns what was killed.",
        json!({
            "type": "object",
            "properties": {
                "pid": {"type": "integer", "description": "Process ID to kill (use either pid or name)."},
                "name": {"type": "string", "description": "Process name to kill — all matching processes are killed (use either pid or name)."}
            }
        }),
        move |params: Value| {
            async move {
                let pid = params.get("pid").and_then(|v| v.as_u64());
                let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if pid.is_none() && name.is_empty() {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": "provide pid or name"})));
                }
                let mut killed: Vec<Value> = Vec::new();
                if let Some(pid) = pid {
                    let r = tokio::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/F"])
                        .output()
                        .await;
                    let ok = matches!(&r, Ok(o) if o.status.success());
                    if !ok {
                        let r2 = tokio::process::Command::new("kill").arg("-9").arg(pid.to_string()).output().await;
                        let ok2 = matches!(&r2, Ok(o) if o.status.success());
                        if !ok2 {
                            return Ok(to_value_or_empty(json!({"ok": false, "error": format!("kill {pid} failed (taskkill and kill both failed)")})));
                        }
                    }
                    killed.push(json!({"pid": pid}));
                }
                if !name.is_empty() {
                    let r = tokio::process::Command::new("taskkill")
                        .args(["/IM", &name, "/F"])
                        .output()
                        .await;
                    if let Ok(o) = &r {
                        if o.status.success() {
                            killed.push(json!({"name": name}));
                        } else {
                            // ps fallback: find pids and kill each.
                            if let Ok(o) = tokio::process::Command::new("pgrep").arg("-f").arg(&name).output().await {
                                let text = String::from_utf8_lossy(&o.stdout).to_string();
                                for line in text.lines() {
                                    if let Ok(p) = line.trim().parse::<u64>() {
                                        let _ = tokio::process::Command::new("kill").arg("-9").arg(p.to_string()).output().await;
                                        killed.push(json!({"pid": p, "name": name}));
                                    }
                                }
                            }
                        }
                    }
                }
                if killed.is_empty() {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": format!("no process matched {}{}", pid.map(|p| format!("pid={p} ")).unwrap_or_default(), if name.is_empty() { String::new() } else { format!("name={name}") })})));
                }
                Ok(to_value_or_empty(json!({"ok": true, "killed": killed})))
            }
        },
    )
}

fn tool_net_test() -> ToolDef {
    ToolDef::new(
        "system_net_test",
        "Network diagnostics from THIS device (the agent host): TCP connect test to host:port (with timeout), and ICMP ping. Returns {tcp_reachable, ping_ms, error?}. Use to verify connectivity before SSH/SFTP/browser operations.",
        json!({
            "type": "object",
            "properties": {
                "host": {"type": "string", "description": "Hostname or IP to test."},
                "port": {"type": "integer", "description": "TCP port to test (omit for ping-only)."},
                "timeout_secs": {"type": "integer", "description": "Connect timeout in seconds (default 5)."}
            },
            "required": ["host"]
        }),
        move |params: Value| {
            async move {
                let host = require_str(&params, "host")?;
                let port = params.get("port").and_then(|v| v.as_u64());
                let timeout_secs = params.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(5);
                let mut result = json!({"ok": true, "host": host});

                // TCP connect test (async — never block the runtime on DNS or
                // connect; a dead host must return in timeout_secs, not hang).
                if let Some(port) = port {
                    use tokio::net::TcpStream;
                    use tokio::time::timeout;
                    let started = std::time::Instant::now();
                    match timeout(
                        std::time::Duration::from_secs(timeout_secs),
                        TcpStream::connect((host.as_str(), port as u16)),
                    ).await {
                        Ok(Ok(_)) => {
                            result["tcp_reachable"] = json!(true);
                            result["tcp_ms"] = json!(started.elapsed().as_millis());
                        }
                        Ok(Err(e)) => {
                            result["tcp_reachable"] = json!(false);
                            result["tcp_error"] = json!(e.to_string());
                        }
                        Err(_) => {
                            result["tcp_reachable"] = json!(false);
                            result["tcp_error"] = json!(format!("connect timed out after {timeout_secs}s"));
                        }
                    }
                }

                // ICMP ping (best-effort; async so a hung ping can't block).
                // Windows: ping -n 1 -w <ms>; Unix: ping -c 1 -W <secs>.
                // A tokio timeout wraps the whole call — a platform quirk must
                // never leave the MCP call hanging.
                let is_windows = std::env::consts::OS == "windows";
                let mut cmd = tokio::process::Command::new("ping");
                if is_windows {
                    cmd.args(["-n", "1", "-w", &(timeout_secs * 1000).to_string(), &host]);
                } else {
                    cmd.args(["-c", "1", "-W", &timeout_secs.to_string(), &host]);
                }
                let ping = match tokio::time::timeout(
                    std::time::Duration::from_secs(timeout_secs + 2),
                    cmd.output(),
                ).await {
                    Ok(Ok(o)) => Some(o),
                    Ok(Err(_)) | Err(_) => {
                        result["ping_ok"] = json!(false);
                        result["ping_error"] = json!("ping failed or timed out");
                        None
                    }
                };
                if let Some(o) = &ping {
                    if o.status.success() {
                        // Parse "time=12ms" / "time<1ms" from output.
                        let text = String::from_utf8_lossy(&o.stdout);
                        let ms = text.lines()
                            .find_map(|l| {
                                if let Some(i) = l.find("time") {
                                    let tail = &l[i..];
                                    if let Some(m) = tail.split(|c: char| !c.is_ascii_digit()).find(|s| !s.is_empty()) {
                                        return m.parse::<u64>().ok();
                                    }
                                }
                                None
                            });
                        result["ping_ok"] = json!(true);
                        if let Some(ms) = ms {
                            result["ping_ms"] = json!(ms);
                        }
                    } else {
                        result["ping_ok"] = json!(false);
                    }
                }
                Ok(to_value_or_empty(result))
            }
        },
    )
}
