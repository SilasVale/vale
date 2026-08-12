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

/// Convert a path to its Windows 8.3 short form (for NSIS /D= which must be
/// unquoted). No-op on non-Windows / non-spaced paths.
#[cfg(windows)]
fn short_path(p: &std::path::Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // First call returns the required buffer size.
    let needed = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
    if needed == 0 { return None; }
    let mut buf = vec![0u16; needed as usize];
    let n = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), needed) };
    if n == 0 { return None; }
    buf.truncate(n as usize);
    Some(std::ffi::OsString::from_wide(&buf).to_string_lossy().into_owned())
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

            // 1. What does the release server say? Timeout so a hung release
            //    server can't pin the handler forever (MCP client may have
            //    disconnected; the future would linger otherwise).
            let resp = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| DeviceError::Internal { message: format!("client build failed: {e}") })?
                .get(VERSION_URL)
                .send()
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

            // 2. Guard against a concurrent update BEFORE the download — the
            //    tray's auto-update and this MCP path both download to the
            //    same ValeAgent-Setup.exe and spawn the same silent installer;
            //    two installers racing would both taskkill vale-agent.exe and
            //    copy into $INSTDIR (file-lock conflicts, half-updated
            //    install). The marker lives in %ProgramData% (NOT %APPDATA%):
            //    the agent runs as SYSTEM and the tray as the user, so
            //    APPDATA resolves to DIFFERENT directories — the old guard
            //    never fired across processes.
            let busy = std::env::var_os("ProgramData")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
                .join("ValeAgent")
                .join("update-busy");
            // Same 60-min staleness rule as the tray: a crashed update's
            // marker must not block forever.
            let stale = std::fs::metadata(&busy)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|age| age.as_secs() > 3600)
                .unwrap_or(false);
            if busy.exists() && !stale {
                return Err(DeviceError::Internal {
                    message: "another update is already in progress".to_string(),
                });
            }
            // Acquire the marker ourselves (with the staleness rule above).
            if let Some(parent) = busy.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&busy, b"agent_update");

            // 3. Download the installer next to this exe (300s: a slow release
            //    server / bandwidth-limited device shouldn't fail a real update,
            //    but must still terminate).
            let dir = install_dir();
            let installer = dir.join("ValeAgent-Setup.exe");
            let bytes = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .build()
                .map_err(|e| DeviceError::Internal { message: format!("client build failed: {e}") })?
                .get(&download)
                .send()
                .await
                .map_err(|e| DeviceError::Internal { message: format!("download failed: {e}") })?
                .bytes()
                .await
                .map_err(|e| DeviceError::Internal { message: format!("download failed: {e}") })?;
            std::fs::write(&installer, &bytes)
                .map_err(|e| DeviceError::Internal { message: format!("write installer failed: {e}") })?;

            // 4. Spawn the silent installer. This process runs elevated (SYSTEM
            //    task or admin console), so no UAC prompt is needed. The
            //    installer kills us mid-flight — hence the early return. If
            //    the spawn fails (e.g. a truncated download that Windows
            //    refuses to run), report it honestly and drop the bad file so
            //    the next attempt re-downloads.
            #[cfg(windows)]
            {
                // NSIS's /D= must be the LAST, UNQUOTED argument — Rust's
                // Command quotes any arg containing a space, which mangles
                // $INSTDIR for a spaced install dir (device left offline
                // after a 'successful' upgrade). Convert to a short (8.3)
                // path when the dir contains a space.
                #[cfg(windows)]
                let install_arg = if dir.to_string_lossy().contains(' ') {
                    short_path(&dir).unwrap_or_else(|| dir.display().to_string())
                } else {
                    dir.display().to_string()
                };
                #[cfg(not(windows))]
                let install_arg = dir.display().to_string();
                match Command::new(&installer)
                    .args(["/S", &format!("/D={install_arg}")])
                    .spawn()
                {
                    Ok(_) => {}
                    Err(e) => {
                        let _ = std::fs::remove_file(&installer);
                        return Err(DeviceError::Internal {
                            message: format!("installer failed to start: {e}"),
                        });
                    }
                }
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
