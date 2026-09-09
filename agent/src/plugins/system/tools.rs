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

use futures::StreamExt;
use serde_json::{json, Value};
use vale_agent_core::ToolDef;

use crate::plugins::{require_str, to_value_or_empty};

const MAX_READ_BYTES: u64 = 1024 * 1024; // 1 MiB per file_read
const MAX_WRITE_BYTES: usize = 4 * 1024 * 1024; // 4 MiB per file_write
const MAX_LIST_ENTRIES: usize = 500;

/// Build the system plugin's tool set (stateless — no captures).
pub fn build() -> Vec<ToolDef> {
    vec![
        tool_file_list(),
        tool_file_stat(),
        tool_file_read(),
        tool_file_write(),
        tool_file_download(),
        tool_file_upload(),
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

fn tool_file_stat() -> ToolDef {
    ToolDef::new(
        "system_file_stat",
        "Stat a file or directory on THIS device: size, modified time, kind. Use it BEFORE a transfer to plan paging (system_file_read offset/limit + system_file_write append), or to check a path exists.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path (absolute recommended)."}
            },
            "required": ["path"]
        }),
        move |params: Value| {
            async move {
                let path = require_str(&params, "path")?;
                match tokio::fs::metadata(&path).await {
                    Ok(md) => {
                        use std::time::UNIX_EPOCH;
                        let modified = md.modified().ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0);
                        Ok(to_value_or_empty(json!({
                            "ok": true,
                            "path": path,
                            "kind": if md.is_dir() { "dir" } else if md.is_file() { "file" } else { "other" },
                            "size": md.len(),
                            "modified_ms": modified,
                        })))
                    }
                    Err(e) => Ok(to_value_or_empty(json!({"ok": false, "error": format!("stat {path}: {e}")}))),
                }
            }
        },
    )
}

fn tool_file_read() -> ToolDef {
    ToolDef::new(
        "system_file_read",
        "Read a file on THIS device (the agent host). Returns the content as UTF-8 text (binary files return an error — use a terminal session for binary inspection), capped at 1 MiB. `raw: true` returns base64 for binary-safe reads. Content passes through the AI context (costs tokens) — to move a large file from this device outward WITHOUT context cost, use system_file_upload and read the returned R2 URL instead.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path (absolute recommended)."},
                "offset": {"type": "integer", "description": "Byte offset to start from (default 0)."},
                "limit": {"type": "integer", "description": "Max bytes to read (default 65536, cap 1048576)."},
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
        "Write text or base64 data to a file on THIS device (the agent host). Creates the file if missing, overwrites by default; set `append: true` to append instead. Capped at 4 MiB per call. Returns bytes written. Content passes through the AI context (costs tokens) — to place a large file here WITHOUT context cost, upload it to R2 first and then use system_file_download with the URL.",
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

/// Normalize a Windows VERBATIM path (`\\?\C:\…`, `\\?\UNC\server\share\…`)
/// to the plain form, so a destination copied from a canonicalizing source
/// (`Get-ChildItem`'s FullName, a `.NET` resolved path) lands where the caller
/// can find it and the returned `path` matches what they passed.
///
/// HISTORY — this is where `system_file_download` died on every real device
/// until round-554: the confinement rule it used to enforce compared
/// `dest.canonicalize()` (Windows: `\\?\C:\ProgramData\Vale\x`, whose disk
/// prefix is a `VerbatimDisk` component) against `paths::data_dir()` (the
/// plain registry string `C:\ProgramData\Vale`), so `starts_with` was FALSE
/// for every path — device-verified on d1: both `D:\Vale\x.txt` and
/// `C:\ProgramData\Vale\x.txt` answered "path must be under data dir". The
/// rule is gone (see `resolve_dest`); the normalization stayed, and the
/// regression test kept the shape visible.
///
/// Deliberately NOT `#[cfg(windows)]`: as pure string logic it runs (and is
/// tested) on every platform — a cfg-gated fix would have been invisible to
/// the suite that ships it, which is exactly how the bug survived (the
/// round-351 lesson).
fn strip_verbatim(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    std::path::PathBuf::from(s.as_ref())
}

/// Resolve a caller-supplied destination into an absolute write target.
/// Relative names land in `<data dir>/downloads`; absolute ones are used as
/// given (the handler creates missing parents).
///
/// NO directory confinement, deliberately: `system_file_write` never had one,
/// the credential that reaches either tool is admin-equivalent (the same
/// token opens a PTY on this host), and the transfers this tool exists for
/// target work directories (`F:\Projects\…\bugs\…`, `D:\Vale\…`) no sane
/// allowlist would cover. The protection that mattered is the `.part` +
/// rename in the handler: a truncated transfer never appears complete.
fn resolve_dest(path_str: &str) -> std::path::PathBuf {
    let raw = std::path::Path::new(path_str);
    if raw.is_absolute() {
        return raw.to_path_buf();
    }
    crate::paths::data_dir().join("downloads").join(raw)
}

fn tool_file_download() -> ToolDef {
    ToolDef::new(
        "system_file_download",
        "Receive a file onto THIS device (the agent host) from a URL — the device fetches it directly, so the bytes NEVER pass through the AI context (this is how a 100 MB firmware image moves; system_file_write is only for ≤4 MiB inline text). Pair with system_file_upload: the sender uploads to the Vale relay and hands back the one-time URL, this tool lands it. Returns {ok, path, bytes}. Destination is any absolute path (parents are created; relative = <data dir>/downloads).",
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "HTTP or HTTPS URL to download (a relay URL from system_file_upload counts). IP-literal hosts are rejected (SSRF guard) — use a hostname."},
                "path": {"type": "string", "description": "Destination path on the device (absolute recommended, e.g. D:\\Vale\\downloads\\file.zip). Parent dirs are auto-created."}
            },
            "required": ["url", "path"]
        }),
        move |params: Value| {
            async move {
                let url_str = require_str(&params, "url")?;
                let path_str = require_str(&params, "path")?;
                if !url_str.starts_with("http://") && !url_str.starts_with("https://") {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": "url must start with http:// or https://"})));
                }
                let url = match reqwest::Url::parse(&url_str) {
                    Ok(u) => u,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("invalid url: {e}")}))),
                };
                let host = match url.host_str() {
                    Some(h) => h.to_string(),
                    None => return Ok(to_value_or_empty(json!({"ok": false, "error": "url has no host"}))),
                };
                if host.parse::<std::net::IpAddr>().is_ok() {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": "IP-based URLs are blocked (SSRF protection)"})));
                }
                let canonical = strip_verbatim(&resolve_dest(&path_str));
                if let Some(parent) = canonical.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        let msg = format!("create parent {}: {e}", parent.display());
                        return Ok(to_value_or_empty(json!({"ok": false, "error": msg})));
                    }
                }
                const MAX_BYTES: u64 = 100 * 1024 * 1024;
                let client = match reqwest::Client::builder()
                    // 600 s, not 120: the whole point of this tool is the
                    // 100 MB image, and 100 MB over a real uplink (the 30 MB
                    // transfer that ran at ~0.8 MB/s) is minutes. The old 120
                    // s capped the tool at roughly a third of the size it
                    // advertises — and did so with a bare "download failed".
                    // Matches the gateway's own 600 s upload window.
                    .timeout(std::time::Duration::from_secs(600))
                    .build()
                {
                    Ok(c) => c,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("reqwest build: {e}")}))),
                };
                let resp = match client.get(&url_str).send().await {
                    Ok(r) => r,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("download failed: {e}")}))),
                };
                if !resp.status().is_success() {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": format!("upstream returned {}", resp.status())})));
                }
                let mut stream = resp.bytes_stream();
                let mut total: u64 = 0;
                use tokio::io::AsyncWriteExt;
                // Land in a `.part` file and rename into place. A firmware
                // image that dies at 40 % must not sit at the caller's target
                // path looking complete — that is how a half-written trx gets
                // flashed onto a device.
                let tmp = {
                    let mut s = canonical.as_os_str().to_os_string();
                    s.push(".part");
                    std::path::PathBuf::from(s)
                };
                let mut f = match tokio::fs::OpenOptions::new()
                    .write(true).create(true).truncate(true)
                    .open(&tmp).await
                {
                    Ok(f) => f,
                    Err(e) => {
                        let msg = format!("open {}: {}", tmp.display(), e);
                        return Ok(to_value_or_empty(json!({"ok": false, "error": msg})));
                    }
                };
                // Every early exit below must leave no corpse behind: the
                // rename never runs, so delete the partial (best effort).
                macro_rules! bail_part {
                    ($($t:tt)*) => {{
                        let msg = format!($($t)*);
                        let _ = f.shutdown().await;
                        let _ = tokio::fs::remove_file(&tmp).await;
                        return Ok(to_value_or_empty(json!({"ok": false, "error": msg})));
                    }};
                }
                while let Some(chunk) = stream.next().await {
                    let chunk = match chunk {
                        Ok(c) => c,
                        Err(e) => bail_part!("read chunk: {e}"),
                    };
                    total += chunk.len() as u64;
                    if total > MAX_BYTES {
                        bail_part!("file too large (>{MAX_BYTES} bytes)");
                    }
                    if let Err(e) = f.write_all(&chunk).await {
                        bail_part!("write: {e}");
                    }
                }
                if let Err(e) = f.flush().await {
                    bail_part!("flush: {e}");
                }
                drop(f);
                if let Err(e) = tokio::fs::rename(&tmp, &canonical).await {
                    let msg = format!("rename {} -> {}: {e}", tmp.display(), canonical.display());
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return Ok(to_value_or_empty(json!({"ok": false, "error": msg})));
                }
                Ok(to_value_or_empty(json!({"ok": true, "path": canonical.to_string_lossy(), "bytes": total})))
            }
        },
    )
}

fn tool_file_upload() -> ToolDef {
    ToolDef::new(
        "system_file_upload",
        "Send a local file to the Vale relay and return its one-time download URL (the other half of the file-transfer pair: hand that URL to system_file_download on the receiving device, or fetch it here on Linux). The file is streamed from disk straight to the relay — the bytes NEVER pass through the AI context, so 100 MB images are fine (system_file_write is the ≤4 MiB inline path only). The relay holds it until first download or 24 h. Returns {ok, url, bytes}.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path of the local file to upload."}
            },
            "required": ["path"]
        }),
        move |params: Value| {
            async move {
                let path_str = require_str(&params, "path")?;
                let path = std::path::Path::new(&path_str);
                if !path.exists() {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": format!("file not found: {path_str}")})));
                }
                let meta = match std::fs::metadata(path) {
                    Ok(m) => m,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("metadata: {e}")}))),
                };
                if !meta.is_file() {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": "not a file"})));
                }
                const MAX_BYTES: u64 = 100 * 1024 * 1024;
                if meta.len() > MAX_BYTES {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": format!("file too large ({} bytes, max {MAX_BYTES})", meta.len())})));
                }
                let bytes = match std::fs::read(path) {
                    Ok(b) => b,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("read: {e}")}))),
                };
                let gateway_url = std::env::var("VALE_GATEWAY_URL")
                    .unwrap_or_else(|_| "https://api.saisi.online".to_string());
                let device_token = std::env::var("VALE_DEVICE_TOKEN").unwrap_or_default();
                // RAW-STREAM PUT, not multipart (round-554). The index worker's
                // multipart branch calls formData(), which materializes the
                // ENTIRE body inside the 128 MB isolate — the reason the
                // gateway kept a 25 MB pre-screen that made this tool's own
                // advertised "100 MB+" a lie (a 30 MB image answered 413).
                // The filename rides in ?name= (percent-encoded by
                // parse_with_params, so non-ASCII survives: an HTTP header
                // could not carry it).
                let upload_url = match reqwest::Url::parse_with_params(
                    &format!("{gateway_url}/api/upload"),
                    &[("name", path.file_name().unwrap_or_default().to_string_lossy().as_ref())],
                ) {
                    Ok(u) => u.to_string(),
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("bad upload url: {e}")}))),
                };
                let req = reqwest::Client::new()
                    .put(&upload_url)
                    .header("Authorization", format!("Bearer {device_token}"))
                    .header("X-Content-Type", "application/octet-stream")
                    .body(bytes);
                let resp = match req.send().await {
                    Ok(r) => r,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("upload failed: {e}")}))),
                };
                if !resp.status().is_success() {
                    return Ok(to_value_or_empty(json!({"ok": false, "error": format!("upload returned {}", resp.status())})));
                }
                let body: serde_json::Value = match resp.json().await {
                    Ok(b) => b,
                    Err(e) => return Ok(to_value_or_empty(json!({"ok": false, "error": format!("parse response: {e}")}))),
                };
                let url = body["url"].as_str().unwrap_or("").to_string();
                let size = body["size"].as_u64().unwrap_or(0);
                Ok(to_value_or_empty(json!({"ok": true, "url": url, "bytes": size})))
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
                // Plugin audit: 1e19 secs parked the handler ~forever and
                // orphaned the ping child — clamp to a minute.
                let timeout_secs = params.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(5).clamp(1, 60);
                let mut result = json!({"ok": true, "host": host});

                // TCP connect test (async — never block the runtime on DNS or
                // connect; a dead host must return in timeout_secs, not hang).
                if let Some(port) = port.filter(|p| (1..=65535).contains(p)) {
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

#[cfg(test)]
mod file_tool_tests {
    //! round-266: system_file_stat + the read/write paging contract that
    //! makes bidirectional device file transfer work for AI agents.
    use super::*;
    use base64::Engine;
    use serde_json::json;

    async fn run(tool: &ToolDef, params: serde_json::Value) -> serde_json::Value {
        tool.handler
            .call(params)
            .await
            .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}))
    }

    /// Shared by the VALE_GATEWAY_URL-mutating upload tests (round-370):
    /// fn-local statics would be DISTINCT locks (no exclusion) — one
    /// module-level lock serializes them. tokio Mutex: the guard is held
    /// across awaits by design (the env must stay stable for the whole
    /// test body), and a std guard across await trips await_holding_lock.
    static UPLOAD_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Captured stub-server requests: (head, body) per POST.
    type CapturedUploads = std::sync::Arc<std::sync::Mutex<Vec<(String, Vec<u8>)>>>;

    #[tokio::test]
    async fn file_stat_reports_size_and_kind() {
        let tmp = std::env::temp_dir().join(format!("vale-stat-test-{}", std::process::id()));
        std::fs::write(&tmp, b"hello world").unwrap();
        let out = run(&tool_file_stat(), json!({ "path": tmp.to_string_lossy() })).await;
        assert_eq!(out["ok"], true);
        assert_eq!(out["kind"], "file");
        assert_eq!(out["size"], 11);
        assert!(out["modified_ms"].as_i64().unwrap() > 0);
        std::fs::remove_file(&tmp).ok();
    }

    #[tokio::test]
    async fn file_stat_missing_returns_error() {
        let out = run(
            &tool_file_stat(),
            json!({ "path": "Z:/definitely/not/here.txt" }),
        )
        .await;
        assert_eq!(out["ok"], false);
    }

    #[test]
    fn file_build_includes_stat() {
        let names: Vec<String> = build().iter().map(|t| t.name.clone()).collect();
        assert!(names.contains(&"system_file_stat".to_string()));
        assert!(names.contains(&"system_file_upload".to_string()));
        assert_eq!(names.len(), 9);
    }

    #[tokio::test]
    async fn write_then_paged_read_roundtrip() {
        // The AI transfer contract: stat -> paged raw read (or append write).
        let tmp = std::env::temp_dir().join(format!("vale-paging-test-{}", std::process::id()));
        let content = vec![b'x'; 200_000]; // 200 KiB
        let w = run(&tool_file_write(), json!({ "path": tmp.to_string_lossy(), "data": base64::engine::general_purpose::STANDARD.encode(&content) })).await;
        assert_eq!(w["ok"], true);
        let r1 = run(
            &tool_file_read(),
            json!({ "path": tmp.to_string_lossy(), "offset": 0, "limit": 131072, "raw": true }),
        )
        .await;
        assert_eq!(r1["ok"], true);
        assert_eq!(r1["bytes"], 131072);
        assert_eq!(r1["size"], 200000);
        let r2 = run(&tool_file_read(), json!({ "path": tmp.to_string_lossy(), "offset": 131072, "limit": 131072, "raw": true })).await;
        assert_eq!(r2["ok"], true);
        assert_eq!(r2["bytes"], 200000 - 131072);
        std::fs::remove_file(&tmp).ok();
    }

    #[tokio::test]
    async fn file_list_returns_entries() {
        let tmp = std::env::temp_dir().join(format!("vale-list-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.txt"), b"hello").unwrap();
        std::fs::write(tmp.join("b.txt"), b"world").unwrap();
        let out = run(&tool_file_list(), json!({ "path": tmp.to_string_lossy() })).await;
        assert_eq!(out["ok"], true);
        let entries = out["entries"].as_array().unwrap();
        assert!(entries.len() >= 2);
        let names: Vec<&str> = entries.iter().filter_map(|e| e["name"].as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"b.txt"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn file_download_rejects_non_http() {
        let out = run(
            &tool_file_download(),
            json!({ "url": "ftp://example.com/file.txt", "path": "/tmp/test.txt" }),
        )
        .await;
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains("http"));
    }

    #[tokio::test]
    async fn file_download_rejects_ip_url() {
        let out = run(
            &tool_file_download(),
            json!({ "url": "http://127.0.0.1/secret", "path": "/tmp/test.txt" }),
        )
        .await;
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains("IP"));
    }

    #[test]
    fn strip_verbatim_normalizes_windows_canonical_forms() {
        // The round-554 regression pin: canonicalize() on Windows returns
        // `\\?\C:\…`, whose disk prefix is a DIFFERENT component kind from a
        // plain `C:\…`, so any starts_with/== against a registry-sourced path
        // fails and system_file_download rejected every destination —
        // including one inside the data dir. Device-verified on d1.
        assert_eq!(
            strip_verbatim(std::path::Path::new(r"\\?\C:\ProgramData\Vale\x.bin")),
            std::path::PathBuf::from(r"C:\ProgramData\Vale\x.bin")
        );
        assert_eq!(
            strip_verbatim(std::path::Path::new(r"\\?\UNC\server\share\x.bin")),
            std::path::PathBuf::from(r"\\server\share\x.bin")
        );
        // Plain paths (and everything a Linux test throws at it) pass through.
        for plain in [r"C:\ProgramData\Vale\x.bin", "/tmp/x.bin"] {
            assert_eq!(
                strip_verbatim(std::path::Path::new(plain)),
                std::path::PathBuf::from(plain)
            );
        }
        // After stripping, the comparison the device needs can hold at all.
        // `starts_with` on a Windows-shaped path is only meaningful with
        // Windows component parsing (Linux splits on `/` alone), so that half
        // is pinned where it applies; the string shape is pinned everywhere.
        let canonical = strip_verbatim(std::path::Path::new(r"\\?\C:\ProgramData\Vale\x.bin"));
        assert_eq!(canonical.to_string_lossy(), r"C:\ProgramData\Vale\x.bin");
        #[cfg(windows)]
        assert!(canonical.starts_with(std::path::Path::new(r"C:\ProgramData\Vale")));
    }

    #[test]
    fn resolve_dest_absolute_wins_relative_roots_in_downloads() {
        let abs = if cfg!(windows) {
            r"D:\Vale\fw.bin"
        } else {
            "/tmp/vale-fw.bin"
        };
        assert_eq!(resolve_dest(abs), std::path::PathBuf::from(abs));
        let rel = resolve_dest("fw.bin");
        assert!(
            rel.ends_with(
                "downloads/fw.bin"
                    .replace('/', std::path::MAIN_SEPARATOR_STR)
                    .as_str()
            ),
            "relative destinations root at <data dir>/downloads: {rel:?}"
        );
        assert!(rel.is_absolute());
    }

    #[tokio::test]
    async fn file_download_lands_anywhere_and_renames_the_part() {
        // The transfer contract this tool exists for: an arbitrary work
        // directory (NOT the data dir — the rule that made it dead on
        // Windows), a parent that does not exist yet, and no `.part` corpse
        // left at either name.
        let dir = std::env::temp_dir().join(format!("vale-dl-{}", std::process::id()));
        let deep = dir.join("nested").join("deeper");
        let payload: Vec<u8> = (0u16..=255).map(|b| b as u8).cycle().take(70_000).collect();
        let md5 = format!("{:x}", md5_like(&payload));
        let port = stub_serve_server(payload.clone()).await;
        let dest = deep.join("fw.bin");
        let out = run(
            &tool_file_download(),
            json!({ "url": format!("http://localhost:{port}/fw.bin"), "path": dest.to_string_lossy() }),
        )
        .await;
        assert_eq!(out["ok"], true, "download must succeed: {out}");
        assert_eq!(out["bytes"], payload.len() as u64);
        let got = std::fs::read(&dest).unwrap_or_default();
        assert_eq!(got.len(), payload.len(), "byte count must match");
        assert_eq!(
            format!("{:x}", md5_like(&got)),
            md5,
            "content must be verbatim"
        );
        assert!(
            !deep.join("fw.bin.part").exists(),
            "the .part staging file must be gone after the rename"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn file_download_rejects_bad_status_without_touching_dest() {
        let dir = std::env::temp_dir().join(format!("vale-dl404-{}", std::process::id()));
        let port = stub_serve_status(404).await;
        let dest = dir.join("nope.bin");
        let out = run(
            &tool_file_download(),
            json!({ "url": format!("http://localhost:{port}/nope"), "path": dest.to_string_lossy() }),
        )
        .await;
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains("404"), "got: {out}");
        assert!(
            !dest.exists(),
            "a failed download must leave no file at the target"
        );
        assert!(!dir.join("nope.bin.part").exists(), "…and no .part either");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// FNV-1a 64 — enough to prove byte-fidelity across the stream/rename
    /// path without pulling a hash crate into the dependency graph.
    fn md5_like(bytes: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        h
    }

    /// Serve `payload` for any GET; port returned. "localhost" (not an IP
    /// literal) keeps the tool's SSRF guard out of the way.
    async fn stub_serve_server(payload: Vec<u8>) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let mut seen = Vec::new();
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                let Ok(n) = sock.read(&mut buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                seen.extend_from_slice(&buf[..n]);
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                payload.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(&payload).await;
            let _ = sock.flush().await;
        });
        port
    }

    /// Answer any GET with a bare status (no body) — the failure-path probe.
    async fn stub_serve_status(status: u16) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let mut seen = Vec::new();
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                let Ok(n) = sock.read(&mut buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                seen.extend_from_slice(&buf[..n]);
            }
            let _ = sock
                .write_all(
                    format!(
                        "HTTP/1.1 {status} Gone\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await;
        });
        port
    }

    #[tokio::test]
    async fn process_list_returns_entries() {
        let out = run(&tool_process_list(), json!({})).await;
        assert_eq!(out["ok"], true);
        let procs = out["processes"].as_array().unwrap();
        assert!(!procs.is_empty());
    }

    #[tokio::test]
    async fn net_test_tcp_reachable() {
        let out = run(
            &tool_net_test(),
            json!({ "host": "127.0.0.1", "port": 1, "timeout_secs": 2 }),
        )
        .await;
        assert_eq!(out["ok"], true);
        assert_eq!(out["tcp_reachable"], false);
    }

    #[tokio::test]
    async fn process_kill_requires_target() {
        let out = run(&tool_process_kill(), json!({})).await;
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains("pid or name"));
    }

    #[tokio::test]
    async fn process_kill_bogus_pid_and_name_fail_cleanly() {
        // PID that cannot exist; both taskkill and kill -9 must fail, and
        // the tool reports ok:false instead of throwing.
        let out = run(&tool_process_kill(), json!({ "pid": 99999999 })).await;
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains("failed"));
        // A name matching nothing: pgrep finds no pids (and taskkill is
        // absent outside Windows) → "no process matched", nothing killed.
        let out = run(
            &tool_process_kill(),
            json!({ "name": "vale-definitely-no-such-proc-xyz-123" }),
        )
        .await;
        assert_eq!(out["ok"], false);
        assert!(out["error"]
            .as_str()
            .unwrap()
            .contains("no process matched"));
    }

    #[tokio::test]
    async fn file_upload_rejects_missing_and_directories() {
        let out = run(
            &tool_file_upload(),
            json!({ "path": "/tmp/vale-upload-definitely-missing-xyz.bin" }),
        )
        .await;
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains("file not found"));
        let dir = std::env::temp_dir().join(format!("vale-upload-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = run(
            &tool_file_upload(),
            json!({ "path": dir.to_string_lossy() }),
        )
        .await;
        assert_eq!(out["ok"], false);
        assert_eq!(out["error"].as_str().unwrap(), "not a file");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Minimal HTTP/1.1 stub for the upload endpoint: reads one request,
    /// captures head+body, answers a fixed manifest. Single-shot (one test
    /// drives exactly one upload).
    async fn stub_upload_server(captured: CapturedUploads) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 65536];
            let mut req = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
                if req.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&req).to_string();
            let len: usize = head
                .lines()
                .find_map(|l| {
                    let low = l.trim().to_lowercase();
                    low.strip_prefix("content-length:")?.trim().parse().ok()
                })
                .unwrap_or(0);
            let body_start = req
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|i| i + 4)
                .unwrap_or(req.len());
            let mut body = req[body_start..].to_vec();
            while body.len() < len {
                let n = sock.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&buf[..n]);
            }
            captured.lock().unwrap().push((head, body));
            let payload = r#"{"url":"https://cdn.example/f/abc","size":11}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                payload.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
        });
        port
    }

    #[tokio::test]
    async fn file_upload_puts_raw_stream_and_reports_manifest() {
        // Serialize with the unreachable-gateway test below (shared module
        // lock): both mutate the process-global VALE_GATEWAY_URL /
        // VALE_DEVICE_TOKEN and cargo runs tests on parallel threads —
        // without this, the URLs cross and this test dials 127.0.0.1:1
        // (or vice versa).
        let _env_guard = UPLOAD_ENV_LOCK.lock().await;
        // Sole VALE_GATEWAY_URL/VALE_DEVICE_TOKEN writer in the suite; set +
        // removed inside this one test so parallel tests cannot cross-talk.
        let captured: CapturedUploads = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let port = stub_upload_server(captured.clone()).await;
        std::env::set_var("VALE_GATEWAY_URL", format!("http://127.0.0.1:{port}"));
        std::env::set_var("VALE_DEVICE_TOKEN", "tok-test");
        let path = std::env::temp_dir().join(format!("vale-upload-ok-{}", std::process::id()));
        std::fs::write(&path, b"hello world").unwrap();
        let out = run(
            &tool_file_upload(),
            json!({ "path": path.to_string_lossy() }),
        )
        .await;
        std::env::remove_var("VALE_GATEWAY_URL");
        std::env::remove_var("VALE_DEVICE_TOKEN");
        assert_eq!(out["ok"], true, "upload must succeed: {out}");
        assert_eq!(out["url"], "https://cdn.example/f/abc");
        assert_eq!(out["bytes"], 11);
        let got = captured.lock().unwrap();
        assert_eq!(got.len(), 1, "exactly one upstream request");
        let (head, body) = &got[0];
        let low = head.to_lowercase();
        assert!(
            low.contains("authorization: bearer tok-test"),
            "device Bearer must ride: {head}"
        );
        // Raw stream, NOT multipart: formData() on the worker side buffers the
        // whole body in the isolate, which is what forced the 25 MB ceiling.
        assert!(
            head.contains("PUT /api/upload?name=vale-upload-ok-"),
            "must be a raw-stream PUT carrying ?name=<basename>: {head}"
        );
        assert!(
            !low.contains("multipart/form-data"),
            "must NOT be multipart any more: {head}"
        );
        assert_eq!(
            body.as_slice(),
            b"hello world",
            "the body must be the file bytes verbatim"
        );
        assert!(
            low.contains("content-length: 11"),
            "declared length must survive for the worker's pre-screen: {head}"
        );
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn file_upload_unreachable_gateway_fails_closed() {
        let _env_guard = UPLOAD_ENV_LOCK.lock().await;
        std::env::set_var("VALE_GATEWAY_URL", "http://127.0.0.1:1");
        std::env::set_var("VALE_DEVICE_TOKEN", "tok-test");
        let path = std::env::temp_dir().join(format!("vale-upload-down-{}", std::process::id()));
        std::fs::write(&path, b"hi").unwrap();
        let out = run(
            &tool_file_upload(),
            json!({ "path": path.to_string_lossy() }),
        )
        .await;
        std::env::remove_var("VALE_GATEWAY_URL");
        std::env::remove_var("VALE_DEVICE_TOKEN");
        assert_eq!(out["ok"], false);
        assert!(
            out["error"].as_str().unwrap().contains("upload failed"),
            "{out}"
        );
        std::fs::remove_file(&path).ok();
    }
}
