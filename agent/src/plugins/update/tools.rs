//! Tool builders for the update plugin.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

use vale_agent_core::{DeviceError, ToolDef};

/// Lowercase hex encoding (sha256 digest display/comparison).
fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Build the release manifest endpoint from the configured download site.
fn version_url(download_url: &str) -> String {
    format!("{}/api/version", download_url.trim_end_matches('/'))
}

/// Parse "x.y.z" into comparable parts (missing pieces become 0, so "0.9" == "0.9.0").
fn parse_version(v: &str) -> Vec<u32> {
    v.trim()
        .split('.')
        .filter_map(|p| p.parse().ok())
        .collect()
}

fn newer(remote: &str, local: &str) -> bool {
    let r = parse_version(remote);
    let l = parse_version(local);
    // round-87: pad both to the max length — a raw Vec comparison treats an
    // extra trailing part as "newer" (newer("1.0.75.0", "1.0.75") == true),
    // so a 4-part build number on the server caused a reinstall loop that
    // never converged (every agent_update taskkilled the agent).
    let n = r.len().max(l.len());
    let rp: Vec<u32> = r.iter().copied().chain(std::iter::repeat(0)).take(n).collect();
    let lp: Vec<u32> = l.iter().copied().chain(std::iter::repeat(0)).take(n).collect();
    rp > lp
}

// short_path (Windows 8.3 names for the retired NSIS /D= flag) was removed
// with the NSIS installer — the npm tgz channel never needed it.

/// Install dir — registry-first (HKLM\SOFTWARE\Vale\Agent\InstallDir), then
/// the exe dir (crate::paths::install_dir). One source of truth (C1).
fn install_dir() -> PathBuf {
    crate::paths::install_dir()
}

/// Install from the downloaded npm tgz (the single update artifact).
/// Extracts the package (vale-agent.exe + vale-desktop.exe + bridge.js +
/// boxed playwright + cloudflared) into a temp dir, then swaps the exe in
/// place via the same WMI-survives-the-kill pattern vale.js uses: a small
/// PowerShell swap script is handed to Win32_Process.Create (parented by
/// WmiPrvSE) so it survives THIS process dying — a plain child spawn dies
/// with the agent mid-copy and leaves the device half-updated.
/// Returns false on failure (busy marker + temp files are cleaned by the
/// caller).
async fn update_from_tgz(installer: &std::path::Path, bytes: &[u8], release_version: &str) -> bool {
    #[cfg(windows)]
    {
        use std::io::Write;
        use tokio::process::Command;

        // 1. Write the tgz + extract with tar (Windows 10+ ships bsdtar).
        if std::fs::write(installer, bytes).is_err() {
            tracing::error!("[vale-agent] agent_update: tgz write failed");
            return false;
        }
        let dir = install_dir();
        let extract = dir.join(".vale-update");
        let _ = std::fs::remove_dir_all(&extract);
        if std::fs::create_dir_all(&extract).is_err() {
            return false;
        }
        let out = Command::new("tar")
            .args(["-xzf"]).arg(installer).arg("-C").arg(&extract)
            .output().await;
        match out {
            Ok(o) if o.status.success() => {}
            _ => {
                tracing::error!("[vale-agent] agent_update: tgz extract failed");
                return false;
            }
        }
        // The npm tgz contains package/... — find the exe inside.
        let pkg_exe = extract.join("package").join("vale-agent.exe");
        if !pkg_exe.exists() {
            tracing::error!("[vale-agent] agent_update: tgz has no package/vale-agent.exe");
            return false;
        }

        // 2. Stage the new exe as .new and hand a swap script to WMI.
        let new_exe = dir.join("vale-agent.new.exe");
        if std::fs::copy(&pkg_exe, &new_exe).is_err() {
            return false;
        }
        // Also stage the desktop shell if present (keep in sync).
        // Staging failures FAIL the update loudly (return false): the swap
        // script writes .vale-release on main-exe success alone, so a
        // silently-skipped boxed component would leave the device REPORTING
        // the new release with STALE components. Failing keeps the old
        // (consistent) version — safe and retryable (the caller drops the
        // busy marker + installer), never a brick. A degraded-component
        // status surface would be a larger change for no extra safety.
        let pkg_desktop = extract.join("package").join("vale-desktop.exe");
        if pkg_desktop.exists() {
            if let Err(e) = std::fs::copy(&pkg_desktop, dir.join("vale-desktop.new.exe")) {
                tracing::error!("[vale-agent] agent_update: desktop stage failed: {e}");
                return false;
            }
        }
        // Boxed playwright + cloudflared refresh (same fail-loud rule).
        let pkg_pw = extract.join("package").join("vale-playwright.zip");
        if pkg_pw.exists() {
            if let Err(e) = std::fs::copy(&pkg_pw, dir.join("vale-playwright.zip")) {
                tracing::error!("[vale-agent] agent_update: playwright stage failed: {e}");
                return false;
            }
        }
        let pkg_cf = extract.join("package").join("cloudflared.exe");
        if pkg_cf.exists() {
            if let Err(e) = std::fs::create_dir_all(dir.join("tools")) {
                tracing::error!("[vale-agent] agent_update: tools dir create failed: {e}");
                return false;
            }
            if let Err(e) = std::fs::copy(&pkg_cf, dir.join("tools").join("cloudflared.exe")) {
                tracing::error!("[vale-agent] agent_update: cloudflared stage failed: {e}");
                return false;
            }
        }

        let q = dir.to_string_lossy().replace('\'', "''");
        let ver = release_version.replace('\'', "''");
        let script = format!(
            r#""[$(Get-Date -Format o)] update start" | Out-File '{q}\vale-update.log' -Append;
try {{ Stop-ScheduledTask ValeAgent -ErrorAction Stop }} catch {{}};
Get-Process vale-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue;
Get-Process node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '*vale-agent*' }} | Stop-Process -Force -ErrorAction SilentlyContinue;
Start-Sleep -Milliseconds 1500;
$ok=$false;
if (Test-Path '{q}\vale-agent.exe') {{ try {{ Copy-Item -Force '{q}\vale-agent.exe' '{q}\vale-agent.old.exe' }} catch {{}} }}
foreach($i in 1..12){{ try {{ Copy-Item -Force -ErrorAction Stop '{q}\vale-agent.new.exe' '{q}\vale-agent.exe'; $ok=$true; break }} catch {{ Start-Sleep -Milliseconds 800 }} }};
"[$(Get-Date -Format o)] copy ok=$ok" | Out-File '{q}\vale-update.log' -Append;
if ($ok) {{ Remove-Item -Force -ErrorAction SilentlyContinue '{q}\vale-agent.new.exe' }};
if ($ok) {{ Set-Content -Path '{q}\.vale-release' -Value '{ver}' -NoNewline -ErrorAction SilentlyContinue }};
if (Test-Path '{q}\vale-desktop.new.exe') {{ Copy-Item -Force '{q}\vale-desktop.new.exe' '{q}\vale-desktop.exe'; Remove-Item -Force '{q}\vale-desktop.new.exe' }};
try {{ Start-ScheduledTask ValeAgent -ErrorAction Stop }} catch {{ schtasks /Run /TN ValeAgent }};
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '{q}\.vale-update';
Remove-Item -Force -ErrorAction SilentlyContinue '{q}\vale-update.ps1';
Remove-Item -Force -ErrorAction SilentlyContinue "$env:ProgramData\ValeAgent\update-busy""#,
        );
        let ps1 = dir.join("vale-update.ps1");
        let mut f = match std::fs::File::create(&ps1) {
            Ok(f) => f,
            Err(_) => return false,
        };
        if f.write_all(script.as_bytes()).is_err() {
            return false;
        }
        // WMI handoff — survives this process dying (see vale.js).
        let inner = format!("powershell -NoProfile -File \"{}\"", ps1.to_string_lossy());
        let wmi = format!(
            "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='{}'}} | ConvertTo-Json -Compress",
            inner.replace('\'', "''"),
        );
        let r = Command::new("powershell")
            .args(["-NoProfile", "-Command", &wmi])
            .output().await;
        // Plugin audit MED (CLI round-217 lesson, Rust twin): powershell's
        // own exit code is NOT the WMI result — Win32_Process.Create reports
        // via ReturnValue; a rejected handoff (9/21) used to print success
        // while nothing swapped, and the busy marker lingered for an hour.
        match r {
            Ok(o) if o.status.success() => {
                let txt = String::from_utf8_lossy(o.stdout.to_vec().as_slice()).trim().to_string();
                match serde_json::from_str::<serde_json::Value>(&txt) {
                    Ok(v) if v.get("ReturnValue").and_then(|x| x.as_i64()) == Some(0) => true,
                    Ok(v) => {
                        tracing::error!("[vale-agent] agent_update: WMI Create rejected (ReturnValue {:?})", v.get("ReturnValue"));
                        false
                    }
                    Err(_) => {
                        tracing::error!("[vale-agent] agent_update: WMI handoff output unparseable: {txt:?}");
                        false
                    }
                }
            }
            _ => {
                tracing::error!("[vale-agent] agent_update: WMI handoff failed");
                false
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (installer, bytes, release_version);
        false
    }
}

/// `agent_update` — check for a newer vale-agent and install it.
///
/// This is the AI-push path: an AI holding this device's MCP connection asks
/// for an update; the agent downloads the npm tgz (the single update
/// artifact) and swaps the exe via a WMI-survives-the-kill script. The tool
/// answers "upgrading" before the process dies and the MCP session reconnects
/// on the new build. `force: true` reinstalls the current version (repairs a
/// broken install).
pub fn agent_update(download_url: Option<String>) -> ToolDef {
    ToolDef::new(
        "agent_update",
        "Check the release server for a newer vale-agent and install it on this device. \
         On a newer version (or force:true) the installer runs silently and the agent \
         restarts — MCP disconnects briefly and reconnects ~1 minute later on the new \
         build. Returns up_to_date when already current. Fails explicitly when no \
         update channel is configured (platform.download_url unset).",
        json!({
            "type": "object",
            "properties": {
                "force": {
                    "type": "boolean",
                    "description": "Reinstall even when up to date (repairs a broken install). Default false."
                }
            }
        }),
        move |params: Value| {
            let version_url = download_url
                .as_deref()
                .map(version_url);
            // (host-pin guard below needs the site URL too — clone OUTSIDE
            // the async block, else the outer closure becomes FnOnce)
            let dl_site = download_url.clone();
            async move {
            let force = params.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            // round-298: the Cargo version (1.0.x) never changes between
            // releases, so comparing it against the release-server version
            // (1.2.x) ALWAYS looked newer — every agent_update call re-
            // downloaded + swapped, even when the device was current. The
            // release version is now recorded next to the install dir at
            // swap time (.vale-release); read it as the local version when
            // present, falling back to the Cargo version (fresh installs /
            // non-Windows test environments).
            let local = std::fs::read_to_string(install_dir().join(".vale-release"))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

            // saisi decouple: no download_url configured → explicit error
            // instead of a hardcoded host.
            let version_url = match version_url {
                Some(u) => u,
                None => {
                    return Ok(json!({"ok": false, "error": "no update channel configured (platform.download_url unset) — this is a purely local install"}));
                }
            };

            // 1. What does the release server say? Timeout so a hung release
            //    server can't pin the handler forever (MCP client may have
            //    disconnected; the future would linger otherwise).
            let resp = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| DeviceError::Internal { message: format!("client build failed: {e}") })?
                .get(&version_url)
                .send()
                .await
                .map_err(|e| DeviceError::Internal { message: format!("version check failed: {e}") })?;
            let j: Value = resp
                .json()
                .await
                .map_err(|e| DeviceError::Internal { message: format!("bad version response: {e}") })?;
            let remote = j.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let download = j.get("download").and_then(|v| v.as_str()).unwrap_or("").to_string();
            // Plugin audit MED: sha256 proves CONSISTENCY of whatever was
            // downloaded, not authenticity — over plain http (or pointed at
            // another host) a network MITM supplies exe+matching hash and
            // gets SYSTEM code execution. Require https (loopback dev
            // exempt) and the SAME host as the configured download site.
            {
                let host_of = |u: &str| -> String {
                    u.split("://").nth(1).unwrap_or("")
                        .split('/').next().unwrap_or("")
                        .rsplit('@').next().unwrap_or("")
                        .split(':').next().unwrap_or("").to_lowercase()
                };
                let dl_host = host_of(&download);
                let site_host = host_of(dl_site.as_deref().unwrap_or(""));
                let loopback = matches!(dl_host.as_str(), "127.0.0.1" | "localhost" | "::1");
                if !(download.starts_with("https://") || (loopback && download.starts_with("http://"))) {
                    return Err(DeviceError::Internal { message: format!("refusing non-https download URL: {download}") });
                }
                if !loopback && !site_host.is_empty() && dl_host != site_host {
                    return Err(DeviceError::Internal { message: format!("download host {dl_host} != release site {site_host}") });
                }
            }
            // Integrity anchor: the sha256 of the npm tgz, published
            // by the release server and verified against the downloaded bytes
            // BEFORE spawn (round-54 — the installer is AI-triggerable code
            // execution at SYSTEM; trust cannot rest on the transport alone).
            let expected_sha256 = j.get("sha256").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            if remote.is_empty() || download.is_empty() {
                return Err(DeviceError::Internal {
                    message: "release server returned no version/download".to_string(),
                });
            }
            // round-119: sha256 is NOT optional — an omitted field previously
            // skipped verification entirely (`if !expected_sha256.is_empty()`)
            // and the downloaded bytes were spawned at SYSTEM unverified
            // (re-opening the round-54 HTML-polluted-404 install class).
            // Fail loudly: an unverifiable download must never execute.
            if expected_sha256.len() != 64 || !expected_sha256.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(DeviceError::Internal {
                    message: "release server returned no/invalid sha256 — refusing unverifiable install".to_string(),
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
            //    same npm tgz and run the same swap;
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
            // marker must not block forever. The marker is acquired
            // ATOMICALLY (create_new) — the old exists()+write check-then-act
            // let two concurrent agent_update calls both pass the check and
            // write the same installer file (round-54).
            let stale_of = || std::fs::metadata(&busy)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|age| age.as_secs() > 3600)
                .unwrap_or(false);
            if let Some(parent) = busy.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let mut reclaimed = false;
            loop {
                match std::fs::OpenOptions::new().write(true).create_new(true).open(&busy) {
                    Ok(_) => break, // marker acquired
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        // Reclaim a stale (crashed) marker ONCE; a reclaim
                        // that fails (locked/denied) must not spin forever.
                        if !reclaimed && stale_of() {
                            let _ = std::fs::remove_file(&busy);
                            reclaimed = true;
                            continue;
                        }
                        return Err(DeviceError::Internal {
                            message: "another update is already in progress".to_string(),
                        });
                    }
                    Err(e) => return Err(DeviceError::Internal {
                        message: format!("update busy marker: {e}"),
                    }),
                }
            }

            // 3. Download + install in a BACKGROUND task (round-84): the old
            //    code downloaded synchronously in the MCP handler — a slow
            //    5MB download held the rmcp worker for up to 300s, during
            //    which EVERY other MCP tool call queued behind it (the panel
            //    and other MCP clients appeared "down"). The handler now
            //    returns "upgrading" immediately; the background task does
            //    the download, integrity check, and silent install, then the
            //    installer kills this process and the agent restarts on the
            //    new build. The busy marker is held by the background task
            //    (concurrent updates still rejected).
            let dir = install_dir();
            let installer = dir.join("vale-agent-update.tgz");
            let dl_url = download.clone();
            let busy_bg = busy.clone();
            let remote_resp = remote.clone();
            tokio::spawn(async move {
                // Download (300s: a slow release server / bandwidth-limited
                // device shouldn't fail a real update, but must terminate).
                // tokio::spawn moves the reqwest client (Send); the download
                // runs off the MCP worker entirely.
                let bytes = match async {
                    let client = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(300))
                        .build()
                        .map_err(|e| DeviceError::Internal { message: format!("client build failed: {e}") })?;
                    client.get(&dl_url).send().await
                        .map_err(|e| DeviceError::Internal { message: format!("download failed: {e}") })?
                        .bytes().await
                        .map_err(|e| DeviceError::Internal { message: format!("download failed: {e}") })
                }.await {
                    Ok(b) => b,
                    Err(e) => {
                        // round-88: failures were swallowed — the caller was
                        // told "upgrading" and nothing logged the failure.
                        tracing::error!("[vale-agent] agent_update download failed: {e}");
                        let _ = std::fs::remove_file(&busy_bg);
                        return;
                    }
                };
                // Integrity check BEFORE it touches disk or spawns: the
                // download must match the hash the release server published.
                // HTML-polluted 404 pages and truncated transfers both landed
                // on devices as vale-agent-update.tgz before; a poisoned/corrupt
                // file is deleted and the install is skipped (round-54).
                // round-119: sha256 is now REQUIRED (checked above) and a
                // mismatch must LOG — the old silent return left a stale hash
                // (index worker hand-maintained) failing every agent_update
                // forever with zero diagnostics.
                {
                    let actual = hex_encode(&Sha256::digest(&bytes));
                    if actual != expected_sha256 {
                        tracing::error!(
                            "[vale-agent] agent_update sha256 mismatch: want {expected_sha256}, got {actual} — install skipped"
                        );
                        let _ = std::fs::remove_file(&busy_bg);
                        let _ = std::fs::remove_file(&installer);
                        return;
                    }
                }
                // A failed write (e.g. the installer is locked by AV scanning)
                // must NOT leave the busy marker — drop it so the next
                // attempt can retry (round-54: a stuck marker blocked updates
                // for up to an hour).
                if std::fs::write(&installer, &bytes).is_err() {
                    let _ = std::fs::remove_file(&busy_bg);
                    let _ = std::fs::remove_file(&installer);
                    return;
                }

                // 4. Install: the npm tgz IS the update artifact (npm is the
                //    single install/update channel — NSIS retired). Extract
                //    the package, swap the exe in place. This process runs
                //    elevated (SYSTEM task or admin console). The agent is
                //    killed mid-flight by the swap; on failure the busy
                //    marker is dropped so the next attempt re-downloads.
                //    round-87: non-Windows (dev/test) has no exe to swap —
                //    clean up so the marker does not lock updates.
                let ok = update_from_tgz(&installer, &bytes, &remote).await;
                if !ok {
                    let _ = std::fs::remove_file(&busy_bg);
                    let _ = std::fs::remove_file(&installer);
                }
                // round-115: the busy marker is NOT cleared here — the swap
                // is still running (taskkill, binary copy, restart take
                // seconds). Removing it right after spawn re-opened the
                // check-then-act window round-54's marker exists to close: a
                // second agent_update/tray check would pass create_new and
                // race the swap (two taskkills + two copies → half-updated
                // install). The swap script deletes the marker when the
                // install provably completes; a crashed install falls back
                // to the 60-min stale reclaim above.
            });
            // Handler returns immediately — the download+install run in the
            // background task; the MCP worker is NOT held (round-84: the old
            // synchronous download held it up to 300s, queueing every other
            // MCP call behind it).
            Ok(json!({
                "status": "upgrading",
                "current": local,
                "remote": remote_resp,
                "message": "downloading + installing in the background — vale-agent restarts automatically, MCP reconnects in ~1 minute"
            }))
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing_handles_missing_pieces() {
        assert_eq!(parse_version("0.9"), vec![0, 9]);
        assert_eq!(parse_version("1.0.72"), vec![1, 0, 72]);
        assert_eq!(parse_version(""), Vec::<u32>::new());
    }

    #[test]
    fn newer_compares_part_by_part() {
        assert!(newer("1.0.73", "1.0.72"));
        assert!(newer("1.1.0", "1.0.99"));
        assert!(!newer("1.0.72", "1.0.72"));
        assert!(!newer("0.9.9", "1.0.0"));
        // round-87: unequal part counts with an equal prefix must NOT be
        // "newer" (the old Vec comparison made "1.0.75.0" > "1.0.75" — a
        // reinstall loop that never converged).
        assert!(!newer("1.0.75.0", "1.0.75"));
        assert!(!newer("0.9.0", "0.9"));
        assert!(newer("1.0.76.0", "1.0.75"));
    }

    #[test]
    fn hex_encode_lowercase_padded() {
        assert_eq!(hex_encode(&[0x00, 0xab, 0xff]), "00abff");
        assert_eq!(hex_encode(b""), "");
    }
}
