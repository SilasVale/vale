//! Tool builders for the update plugin.

use serde_json::{json, Value};
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;

use vale_agent_core::{DeviceError, ToolDef};

/// Release info endpoint — must match index/src/index.js VERSION.
const VERSION_URL: &str = "https://agent.saisi.online/api/version";

/// Parse "x.y.z" into comparable parts (missing pieces become 0, so "0.9" == "0.9.0").
fn parse_version(v: &str) -> Vec<u32> {
    v.trim()
        .split('.')
        .filter_map(|p| p.parse().ok())
        .collect()
}

fn newer(remote: &str, local: &str) -> bool {
    parse_version(remote) > parse_version(local)
}

/// The directory this exe lives in — where the installer lands and where the
/// NSIS /D= install root points.
fn install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("C:\\vale-agent"))
}

/// `agent_update` — check for a newer vale-agent and install it.
///
/// This is the AI-push path: an AI holding this device's MCP connection asks
/// for an update; the agent downloads ValeAgent-Setup.exe and spawns it
/// silently. The installer `taskkill`s vale-agent.exe, copies the new
/// binaries, re-runs fix-tunnel.ps1 and restarts the ValeAgent task, so the
/// tool answers "upgrading" before the process dies and the MCP session
/// reconnects on the new build. `force: true` reinstalls the current version
/// (repairs a broken install).
pub fn agent_update() -> ToolDef {
    ToolDef::new(
        "agent_update",
        "Check the release server for a newer vale-agent and install it on this device. \
         On a newer version (or force:true) the installer runs silently and the agent \
         restarts — MCP disconnects briefly and reconnects ~1 minute later on the new \
         build. Returns up_to_date when already current.",
        json!({
            "type": "object",
            "properties": {
                "force": {
                    "type": "boolean",
                    "description": "Reinstall even when up to date (repairs a broken install). Default false."
                }
            }
        }),
        |params: Value| async move {
            let force = params.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            let local = env!("CARGO_PKG_VERSION").to_string();

            // 1. What does the release server say?
            let resp = reqwest::get(VERSION_URL)
                .await
                .map_err(|e| DeviceError::Internal { message: format!("version check failed: {e}") })?;
            let j: Value = resp
                .json()
                .await
                .map_err(|e| DeviceError::Internal { message: format!("bad version response: {e}") })?;
            let remote = j.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let download = j.get("download").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if remote.is_empty() || download.is_empty() {
                return Err(DeviceError::Internal {
                    message: "release server returned no version/download".to_string(),
                });
            }

            if !newer(&remote, &local) && !force {
                return Ok(json!({
                    "status": "up_to_date",
                    "current": local,
                    "remote": remote,
                }));
            }

            // 2. Download the installer next to this exe.
            let dir = install_dir();
            let installer = dir.join("ValeAgent-Setup.exe");
            let bytes = reqwest::get(&download)
                .await
                .map_err(|e| DeviceError::Internal { message: format!("download failed: {e}") })?
                .bytes()
                .await
                .map_err(|e| DeviceError::Internal { message: format!("download failed: {e}") })?;
            std::fs::write(&installer, &bytes)
                .map_err(|e| DeviceError::Internal { message: format!("write installer failed: {e}") })?;

            // 3. Spawn the silent installer. This process runs elevated (SYSTEM
            //    task or admin console), so no UAC prompt is needed. The
            //    installer kills us mid-flight — hence the early return.
            #[cfg(windows)]
            {
                let _ = Command::new(&installer)
                    .args(["/S", &format!("/D={}", dir.display())])
                    .spawn();
            }

            Ok(json!({
                "status": "upgrading",
                "current": local,
                "remote": remote,
                "message": "installer started — vale-agent restarts automatically, MCP reconnects in ~1 minute"
            }))
        },
    )
}
