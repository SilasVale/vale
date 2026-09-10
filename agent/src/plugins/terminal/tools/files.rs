//! SFTP file tools — stateless one-shot transfers over SSH. One builder fn
//! per MCP tool (`terminal_sftp` canonical + `sftp` legacy alias), built
//! once at registration. Code moved verbatim from the former monolithic
//! `plugins/terminal/tools.rs`.

use serde_json::{json, Value};

use vale_agent_core::ToolDef;
// The real SFTP body only exists under the `terminal` feature; the headless
// build keeps the stub handler that needs none of these.
#[cfg(feature = "terminal")]
use crate::plugins::{require_str, to_value_or_empty};
#[cfg(feature = "terminal")]
use vale_agent_core::DeviceError;

/// P4c: SFTP file operations over SSH — stateless one-shot transfers.
/// Each call connects (password or key), performs ONE op, and closes.
/// Ops: list (remote dir), upload (local file → remote, base64 data),
/// download (remote → local path on THIS device), delete, mkdir.
/// `name` selects the canonical (`terminal_sftp`) or legacy alias (`sftp`).
///
/// Feature-gating: the real implementation needs `crate::tools::ssh`, which
/// only exists under the `terminal` feature. Headless builds get a stub that
/// returns an explicit "backend not enabled" error (same contract as
/// terminal_open's stub path).
/// The error for "the SFTP connect exceeded its 30 s ceiling".
///
/// Extracted so the CODE CHOICE is nameable and pinned (SOLID R113) — it is
/// currently a deliberate-looking DIVERGENCE, not an accident:
///
/// * `crate::tools::ssh`'s terminal path reports the same condition as
///   [`DeviceError::SshTimeout`] (code `ssh_timeout`), which the gateway maps
///   onto its `TIMEOUT` class (`gateway/src/mcp.ts`), telling the client to
///   retry with a longer budget;
/// * SFTP reports `Internal` (code `internal`), which the gateway falls
///   through to `TOOL_ERROR` — the catch-all for "device is up, the tool
///   failed".
///
/// Both readings are defensible and the difference is CLIENT-VISIBLE, so it is
/// NOT repaired here: the program's rule is that a semantic difference found
/// mid-round is recorded for a human decision, never silently fixed (`docs/
/// solid-program.md` → Open threads). `sftp_timeout_code_is_pinned_below`
/// fails the moment the choice changes, so whoever changes it does so on
/// purpose and updates that entry.
#[cfg(feature = "terminal")]
fn sftp_connect_timed_out(host: &str, port: u16, user: &str) -> DeviceError {
    DeviceError::Internal {
        message: format!("sftp: ssh connect to {user}@{host}:{port} timed out after 30s"),
    }
}

pub(super) fn tool_sftp(name: &'static str) -> ToolDef {
    ToolDef::new(
        name,
        "SFTP file transfer over SSH (stateless one-shot): connect with host/user/password or key_path, perform ONE operation, close. Ops: 'list' (remote_path dir → names+attrs), 'upload' (data base64 → remote_path), 'download' (remote_path → local_path on this device), 'delete' (remote_path), 'mkdir' (remote_path). Returns result summary. For persistent browsing use a terminal ssh session.",
        json!({
            "type": "object",
            "properties": {
                "op": {"type": "string", "enum": ["list", "upload", "download", "delete", "mkdir"]},
                "host": {"type": "string", "description": "SSH host"},
                "user": {"type": "string", "description": "SSH username"},
                "port": {"type": "integer", "description": "SSH port (default 22)"},
                "password": {"type": "string", "description": "SSH password (or key passphrase)"},
                "key_path": {"type": "string", "description": "SSH private key path (optional)"},
                "remote_path": {"type": "string", "description": "Remote path (dir for list/mkdir, file for upload/download/delete)"},
                "local_path": {"type": "string", "description": "(download) Local destination path on this device"},
                "data": {"type": "string", "description": "(upload) File content as base64"}
            },
            "required": ["op", "host", "user", "remote_path"]
        }),
        sftp_handler(),
    )
}

/// The sftp handler closure — real SSH under `terminal`, explicit error stub
/// otherwise (the feature-gating rule: public tool paths identical in both
/// configs, only the backend differs).
fn sftp_handler() -> impl vale_agent_core::ToolHandler + 'static {
    move |params: Value| {
        // round-…: headless — silence the unused closure param.
        #[cfg(not(feature = "terminal"))]
        let _ = &params;
        #[cfg(feature = "terminal")]
        {
            async move {
                let op = require_str(&params, "op")?;
                let host = require_str(&params, "host")?;
                let user = require_str(&params, "user")?;
                let port = params.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16;
                let password = params
                    .get("password")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let key_path = params
                    .get("key_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let remote_path = require_str(&params, "remote_path")?;
                let local_path = params
                    .get("local_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let data_b64 = params
                    .get("data")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // Reuse the same connect+auth path as terminal ssh sessions.
                // SSH audit #4 (LOW): the terminal path wraps connect in a
                // 30 s ceiling — sftp called it BARE; a dribbling tarpit can
                // extend an auth hang indefinitely (russh's inactivity timer
                // resets on ANY byte). Bound it identically.
                let session = match tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    crate::tools::ssh::SshSession::connect(
                        &host,
                        port,
                        &user,
                        if password.is_empty() {
                            None
                        } else {
                            Some(&password)
                        },
                        if key_path.is_empty() {
                            None
                        } else {
                            Some(&key_path)
                        },
                    ),
                )
                .await
                {
                    Ok(r) => r?,
                    // NOTE the code choice — see sftp_connect_timed_out.
                    Err(_) => return Err(sftp_connect_timed_out(&host, port, &user)),
                };
                let sftp = session.sftp_session().await?;

                let result = match op.as_str() {
                    "list" => {
                        let mut entries = Vec::new();
                        let rd = sftp.read_dir(&remote_path).await.map_err(|e| {
                            DeviceError::Internal {
                                message: format!("sftp read_dir {remote_path}: {e}"),
                            }
                        })?;
                        for dir in rd {
                            entries.push(serde_json::json!({
                                "name": dir.file_name(),
                                "size": dir.metadata().len(),
                                "is_dir": dir.file_type().is_dir(),
                            }));
                        }
                        serde_json::json!({"entries": entries})
                    }
                    "upload" => {
                        let bytes = {
                            use base64::Engine;
                            base64::engine::general_purpose::STANDARD
                                .decode(data_b64)
                                .map_err(|e| DeviceError::Internal {
                                    message: format!("base64 decode: {e}"),
                                })?
                        };
                        // create() opens with CREATE|TRUNCATE|WRITE — the
                        // high-level write() uses WRITE only and fails with
                        // NoSuchFile on a fresh remote path (P4c).
                        {
                            use tokio::io::AsyncWriteExt;
                            let mut file = sftp.create(&remote_path).await.map_err(|e| {
                                DeviceError::Internal {
                                    message: format!("sftp create {remote_path}: {e}"),
                                }
                            })?;
                            file.write_all(&bytes)
                                .await
                                .map_err(|e| DeviceError::Internal {
                                    message: format!("sftp write: {e}"),
                                })?;
                            file.flush().await.map_err(|e| DeviceError::Internal {
                                message: format!("sftp flush: {e}"),
                            })?;
                        }
                        serde_json::json!({"uploaded_bytes": bytes.len(), "remote_path": remote_path})
                    }
                    "download" => {
                        if local_path.is_empty() {
                            return Ok(to_value_or_empty(
                                json!({"error": "local_path required for download"}),
                            ));
                        }
                        let buf =
                            sftp.read(&remote_path)
                                .await
                                .map_err(|e| DeviceError::Internal {
                                    message: format!("sftp read {remote_path}: {e}"),
                                })?;
                        std::fs::write(&local_path, &buf).map_err(|e| DeviceError::Internal {
                            message: format!("local write {local_path}: {e}"),
                        })?;
                        serde_json::json!({"downloaded_bytes": buf.len(), "local_path": local_path})
                    }
                    "delete" => {
                        sftp.remove_file(&remote_path).await.map_err(|e| {
                            DeviceError::Internal {
                                message: format!("sftp remove {remote_path}: {e}"),
                            }
                        })?;
                        serde_json::json!({"deleted": remote_path})
                    }
                    "mkdir" => {
                        sftp.create_dir(&remote_path)
                            .await
                            .map_err(|e| DeviceError::Internal {
                                message: format!("sftp mkdir {remote_path}: {e}"),
                            })?;
                        serde_json::json!({"created": remote_path})
                    }
                    _ => {
                        return Ok(to_value_or_empty(
                            json!({"error": format!("unknown op: {op}")}),
                        ))
                    }
                };

                // Best-effort close (ignore errors — session drop cleans up).
                let _ = sftp.close().await;
                Ok(to_value_or_empty(result))
            }
        }
        #[cfg(not(feature = "terminal"))]
        {
            async move {
                Err(vale_agent_core::DeviceError::Internal {
                    message: "sftp backend not enabled (built without the terminal feature)"
                        .to_string(),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! SOLID Round-99: the SFTP builders had zero dispatch pins — live SSH
    //! is correctly untestable headless, but two layers precede any
    //! network: the non-terminal stub (clean error, both configs' paths
    //! identical) and require_str validation (missing fields reject before
    //! connect). Unknown ops and op-specific checks need a session — left
    //! to live devices, explicitly.
    use super::*;

    /// PINS A DEFERRED DECISION, not a desired behaviour (SOLID R113).
    ///
    /// An SFTP connect timeout is reported with code `internal`, while the
    /// SSH terminal path reports the SAME condition as `ssh_timeout`. Through
    /// `gateway/src/mcp.ts` those become different client-visible classes:
    /// `ssh_timeout` → TIMEOUT (retry with a longer budget), `internal` →
    /// TOOL_ERROR (the catch-all "device is up, the tool failed").
    ///
    /// The divergence is real, client-visible, and arguably wrong — but
    /// changing it is a BEHAVIOUR change, and this program's rule is that a
    /// semantic difference found mid-round is recorded for a human decision
    /// rather than silently fixed (`docs/solid-program.md` → Open threads).
    /// So the current choice is pinned instead: if someone unifies these, this
    /// fails and sends them to that entry to update it deliberately.
    #[cfg(feature = "terminal")]
    #[test]
    fn sftp_timeout_code_is_pinned_below_its_ledger_entry() {
        use vale_agent_core::DeviceError as E;
        let err = sftp_connect_timed_out("host.example", 22, "deploy");
        assert_eq!(
            err.code(),
            "internal",
            "the SFTP timeout code changed — this is a CLIENT-VISIBLE change \
             (gateway maps ssh_timeout→TIMEOUT, internal→TOOL_ERROR). Update \
             the docs/solid-program.md Open-threads entry for it, then this pin"
        );
        // The message still has to name the endpoint and the ceiling: it is
        // what a human reads when the transfer never starts.
        let msg = err.to_string();
        assert!(msg.contains("deploy@host.example:22"), "{msg}");
        assert!(msg.contains("30s"), "{msg}");
        // And the divergence is pinned from the OTHER side too, so a change to
        // either path fails here rather than only one of them.
        assert_eq!(
            E::SshTimeout {
                host: "host.example".into()
            }
            .code(),
            "ssh_timeout",
            "the terminal SSH path's code moved — re-check the divergence"
        );
    }
    use serde_json::json;

    #[cfg(not(feature = "terminal"))]
    #[tokio::test]
    async fn sftp_stub_errors_cleanly_on_both_names() {
        for name in ["terminal_sftp", "sftp"] {
            let res = tool_sftp(name)
                .handler
                .call(json!({"op": "list", "host": "h", "user": "u", "remote_path": "/"}))
                .await;
            assert!(
                matches!(res, Err(vale_agent_core::DeviceError::Internal { .. })),
                "{name} stub must error, never panic or hang: {res:?}"
            );
        }
    }

    #[cfg(feature = "terminal")]
    #[tokio::test]
    async fn sftp_validation_rejects_before_connect() {
        // No SSH server exists in CI — these must fail on validation alone
        // (require_str precedes SshSession::connect in the handler). Full
        // params would attempt SSH and are NOT exercised headless: the
        // connect itself is the untestable part, not the validation.
        for name in ["terminal_sftp", "sftp"] {
            for params in [
                json!({}),
                json!({"host": "h", "user": "u", "remote_path": "/"}),
                json!({"op": "list", "user": "u", "remote_path": "/"}),
                json!({"op": "list", "host": "h", "remote_path": "/"}),
                json!({"op": "list", "host": "h", "user": "u"}),
            ] {
                let res = tool_sftp(name).handler.call(params.clone()).await;
                assert!(
                    matches!(res, Err(vale_agent_core::DeviceError::InvalidParams { .. })),
                    "{name} must reject without connecting: {res:?}"
                );
            }
        }
    }
}
