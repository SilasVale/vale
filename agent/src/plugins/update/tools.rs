//! Tool builders for the update plugin.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

use crate::plugins::tool_error;
use vale_agent_core::{DeviceError, ToolDef};

/// Build the release manifest endpoint from the configured download site.
fn version_url(download_url: &str) -> String {
    format!("{}/api/version", download_url.trim_end_matches('/'))
}

/// Host part of a URL for the download gate: strips scheme, userinfo and
/// port; lowercases. Pure — extracted from the agent_update handler so the
/// SYSTEM-execution gate below is unit-pinned.
///
/// NOTE: a bare IPv6 loopback URL (`http://::1/x`) parses to "" (the ':'
/// split takes the first segment), so only 127.0.0.1/localhost exercise
/// the loopback exemption in practice; the "::1" match arm below is
/// currently unreachable. Deliberately NOT "fixed" here — widening a
/// SYSTEM-execution gate is a product decision, not a test refactor.
fn host_of(u: &str) -> String {
    u.split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

/// Decide whether a manifest download URL may be fetched and executed.
/// https always; http only for loopback dev; and the host must match the
/// configured release site (an empty site means unset — skip the match).
/// Pure — same verdicts as the inline handler logic it replaces.
///
/// `download` is REMOTE DATA: it comes out of the release server's
/// `version.json`, so a compromised release server (or a transport MITM on
/// the version check) supplies it. This function is the last gate before the
/// bytes are spawned at SYSTEM, which is why the adversarial shapes are
/// pinned in `check_download_url_refuses_every_offsite_shape` rather than
/// left to inspection.
///
/// The empty-`site` branch is DEFENSIVE ONLY: `agent_update` returns early
/// with "no update channel configured" when `platform.download_url` is unset,
/// so production always reaches here with a real site and the match is never
/// skipped. Kept because this is a pure function with its own contract.
fn check_download_url(download: &str, site: &str) -> Result<(), String> {
    let dl_host = host_of(download);
    let site_host = host_of(site);
    let loopback = matches!(dl_host.as_str(), "127.0.0.1" | "localhost" | "::1");
    if !(download.starts_with("https://") || (loopback && download.starts_with("http://"))) {
        return Err(format!("refusing non-https download URL: {download}"));
    }
    if !loopback && !site_host.is_empty() && dl_host != site_host {
        return Err(format!(
            "download host {dl_host} != release site {site_host}"
        ));
    }
    Ok(())
}

/// Is this a well-formed sha256 hex digest (64 hex chars)? The manifest
/// sha is REQUIRED (round-119) — an unverifiable download must never
/// execute at SYSTEM.
fn valid_sha256(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Parse "x.y.z" into comparable parts (missing pieces become 0, so "0.9" == "0.9.0").
fn parse_version(v: &str) -> Vec<u32> {
    v.trim().split('.').filter_map(|p| p.parse().ok()).collect()
}

fn newer(remote: &str, local: &str) -> bool {
    let r = parse_version(remote);
    let l = parse_version(local);
    // round-87: pad both to the max length — a raw Vec comparison treats an
    // extra trailing part as "newer" (newer("1.0.75.0", "1.0.75") == true),
    // so a 4-part build number on the server caused a reinstall loop that
    // never converged (every agent_update taskkilled the agent).
    let n = r.len().max(l.len());
    let rp: Vec<u32> = r
        .iter()
        .copied()
        .chain(std::iter::repeat(0))
        .take(n)
        .collect();
    let lp: Vec<u32> = l
        .iter()
        .copied()
        .chain(std::iter::repeat(0))
        .take(n)
        .collect();
    rp > lp
}

// short_path (Windows 8.3 names for the retired NSIS /D= flag) was removed
// with the NSIS installer — the npm tgz channel never needed it.

/// Install dir — registry-first (HKLM\SOFTWARE\Vale\Agent\InstallDir), then
/// the exe dir (crate::paths::install_dir). One source of truth (C1).
fn install_dir() -> PathBuf {
    crate::paths::install_dir()
}

/// Pure rollback-pin decision (unit-tested): a non-empty pin blocks any
/// remote that differs from it, unless force overrides. pin == remote is
/// allowed (the release channel caught up to the pin — installing it does
/// not undo the pin's intent, and the pin keeps guarding later drift).
fn pin_blocks(pin: &str, remote: &str, force: bool) -> bool {
    !force && !pin.is_empty() && pin != remote
}

/// Best-effort removal of staged `.new` files after a FAILED update.
/// A failed staging must leave zero appliable leftovers: the swap script
/// applies staged `.new` files, so a failure that kept them would let a
/// later boot/swap apply a MIX of the failed release's components under
/// the old (consistent) version marker. Never touches live files.
fn cleanup_staged(dir: &std::path::Path) {
    // dir-relative (NOT the global components_dir() — this runs against the
    // passed install root, and tests pin it with temp dirs).
    let comp = dir.join("components");
    let _ = std::fs::remove_file(dir.join("vale-agent.new.exe"));
    let _ = std::fs::remove_file(comp.join("vale-playwright.new.zip"));
    let _ = std::fs::remove_file(comp.join("cloudflared.new.exe"));
    let _ = std::fs::remove_dir_all(dir.join(".vale-update"));
}

// ── Update busy marker ───────────────────────────────────────
//
// The exclusive cross-process update lock, and the one place its path is
// defined. It used to be spelled out TWICE: the Rust acquirer built
// `<ProgramData>\ValeAgent\update-busy` from PathBuf joins while the
// generated PowerShell swap script carried the same location as two
// hand-written string literals. A drift between the two is invisible until
// an update actually runs — and then the swap releases a file the agent
// never created, the marker survives, and every later update is refused
// for up to an hour. BUSY_MARKER_REL is the single definition;
// busy_marker_path() and busy_marker_ps() both derive from it, and a
// contract test pins that they still name the same file.
//
// The acquire/reclaim DECISION (used to sit inline in the 300-line
// agent_update closure, with no test coverage despite three incidents) is
// acquire_busy_marker below.

/// ProgramData-relative location of the update busy marker.
const BUSY_MARKER_REL: &str = r"ValeAgent\update-busy";

/// How long an abandoned marker blocks further updates before it may be
/// reclaimed. A crashed install leaves the marker behind, so without a
/// staleness window that one crash would lock the device out of updates
/// FOREVER (round-54: a stuck marker blocked updates for up to an hour).
const BUSY_STALE_SECS: u64 = 3600;

/// `%ProgramData%` (machine-wide). NOT `%APPDATA%`: the agent runs as SYSTEM
/// and the tray as the user, whose APPDATA resolve to DIFFERENT directories
/// — the original guard never fired across those processes.
fn programdata_dir() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
}

/// The busy marker as a real path (the acquirer's view of it).
fn busy_marker_path() -> PathBuf {
    let mut p = programdata_dir();
    // Join the SHARED constant component-by-component: a single
    // `join(BUSY_MARKER_REL)` would treat the backslash as part of one file
    // name on Unix, so the two spellings would stop agreeing off-Windows.
    for part in BUSY_MARKER_REL.split('\\') {
        p.push(part);
    }
    p
}

/// The busy marker as the generated swap script spells it — PowerShell
/// resolves `$env:ProgramData` on the device at run time.
#[allow(dead_code)] // used by the Windows swap script; unit-tested on all hosts
fn busy_marker_ps() -> String {
    format!(r"$env:ProgramData\{BUSY_MARKER_REL}")
}

/// Take the exclusive update marker, or refuse the update.
///
/// The marker is acquired ATOMICALLY (`create_new`): the old
/// exists()-then-write check let two concurrent agent_update calls both pass
/// and write the same installer file (round-54).
///
/// A marker older than `stale_after` belongs to a crashed install and is
/// reclaimed — but at most ONCE per call: if that reclaim fails to remove it
/// (locked, or not a plain file), the retry would see it again and the loop
/// would spin forever, so the second sighting is reported as a conflict
/// instead (round-54's "must not spin").
///
/// The caller must NOT release the marker after a successful hand-off
/// (round-115): the swap is still running (taskkill, binary copy, restart
/// take seconds), and clearing it there re-opened the very check-then-act
/// window this marker exists to close. The swap script deletes it once the
/// install provably completes; a crashed install falls back to the
/// staleness window above.
fn acquire_busy_marker(
    path: &std::path::Path,
    stale_after: std::time::Duration,
) -> Result<(), DeviceError> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stale_of = || {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|age| age.as_secs() > stale_after.as_secs())
            .unwrap_or(false)
    };
    let mut reclaimed = false;
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if !reclaimed && stale_of() {
                    let _ = std::fs::remove_file(path);
                    reclaimed = true;
                    continue;
                }
                return Err(DeviceError::Internal {
                    message: "another update is already in progress".to_string(),
                });
            }
            Err(e) => {
                return Err(DeviceError::Internal {
                    message: format!("update busy marker: {e}"),
                })
            }
        }
    }
}

/// Install from the downloaded npm tgz (the single update artifact).
/// Extracts the package (vale-agent.exe + boxed playwright + cloudflared) into a temp dir, then swaps the exe in
/// place via the same WMI-survives-the-kill pattern vale.js uses: a small
/// PowerShell swap script is handed to Win32_Process.Create (parented by
/// WmiPrvSE) so it survives THIS process dying — a plain child spawn dies
/// with the agent mid-copy and leaves the device half-updated.
/// Returns false on failure (busy marker + installer + staged .new files
/// are cleaned by the caller / staging paths).
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
            .args(["-xzf"])
            .arg(installer)
            .arg("-C")
            .arg(&extract)
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => {}
            _ => {
                tracing::error!("[vale-agent] agent_update: tgz extract failed");
                return false;
            }
        }
        // The tgz served its purpose (bytes are already staged from memory
        // below) — remove it now so a 6 MB artifact never lingers at the
        // install root after successful updates.
        let _ = std::fs::remove_file(installer);
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
        // Boxed playwright + cloudflared refresh: staging failures FAIL the
        // update loudly (return false) — the swap script writes .vale-release
        // only after ALL staged swaps succeed, so a silently-skipped boxed
        // component would leave the device REPORTING the new release with
        // STALE components. Failing keeps the old (consistent) version — safe
        // and retryable, never a brick. (Retired Tauri vale-desktop.exe
        // staging was removed here: the crate is deleted, the npm package
        // no longer ships it.)
        // Staged to .new names — NEVER over the live files pre-verdict: a
        // staging failure AFTER a live overwrite left the device RUNNING a
        // mix of new + stale components while still REPORTING the old
        // version (and a retry could never restore the overwritten live
        // file). The $ok-gated swap script moves them into place only when
        // the main-exe copy succeeded.
        let pkg_pw = extract.join("package").join("vale-playwright.zip");
        if pkg_pw.exists() {
            if let Err(e) = std::fs::copy(
                &pkg_pw,
                dir.join("components").join("vale-playwright.new.zip"),
            ) {
                tracing::error!("[vale-agent] agent_update: playwright stage failed: {e}");
                cleanup_staged(&dir);
                return false;
            }
        }
        let pkg_cf = extract.join("package").join("cloudflared.exe");
        if pkg_cf.exists() {
            if let Err(e) = std::fs::create_dir_all(dir.join("components")) {
                tracing::error!("[vale-agent] agent_update: components dir create failed: {e}");
                cleanup_staged(&dir);
                return false;
            }
            if let Err(e) =
                std::fs::copy(&pkg_cf, dir.join("components").join("cloudflared.new.exe"))
            {
                tracing::error!("[vale-agent] agent_update: cloudflared stage failed: {e}");
                cleanup_staged(&dir);
                return false;
            }
        }

        let q = dir.to_string_lossy().replace('\'', "''");
        let ver = release_version.replace('\'', "''");
        // Layout v2 homes (baked — the swap script is static text).
        // dir-relative (same root the staging above used, not globals).
        let etc = dir.join("etc").to_string_lossy().replace('\'', "''");
        let comp = dir.join("components").to_string_lossy().replace('\'', "''");
        let logs = crate::paths::logs_dir()
            .to_string_lossy()
            .replace('\'', "''");
        let scripts = dir.join("scripts").to_string_lossy().replace('\'', "''");
        // The marker path the script must release — same single definition the
        // acquirer above uses (busy_marker_ps), never a second literal.
        let busy_ps = busy_marker_ps();
        let script = format!(
            r#""[$(Get-Date -Format o)] update start" | Out-File '{logs}\vale-update.log' -Append;
try {{
$uaction = New-ScheduledTaskAction -Execute '{q}\vale-agent.exe' -Argument ('"' + '{etc}\config.yaml' + '"');
$uboot = New-ScheduledTaskTrigger -AtStartup;
$uwatch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 5);
$uprincipal = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest;
$usettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 8 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable;
Register-ScheduledTask ValeAgent -Action $uaction -Trigger @($uboot,$uwatch) -Principal $uprincipal -Settings $usettings -Force -ErrorAction Stop | Out-Null;
}} catch {{ "[$(Get-Date -Format o)] task repoint FAILED — aborting, old version keeps running" | Out-File '{logs}\vale-update.log' -Append; Remove-Item -Force -ErrorAction SilentlyContinue "{busy_ps}"; exit 1 }};
"[$(Get-Date -Format o)] task repointed at etc\config.yaml" | Out-File '{logs}\vale-update.log' -Append;
try {{ Stop-ScheduledTask ValeAgent -ErrorAction Stop }} catch {{}};
Get-Process vale-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue;
Get-Process node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '*vale-agent*' }} | Stop-Process -Force -ErrorAction SilentlyContinue;
Start-Sleep -Milliseconds 1500;
$ok=$false;
# MANUAL-ONLY BACKUP: nothing automated reads vale-agent.old.exe, and nothing
# deletes it either, so one accumulates per update. It is kept for a human who
# wants the previous binary in hand; the SANCTIONED recovery path is
# `vale rollback <ver>`, which restores from the CDN and proves the swap landed.
# If this is ever wired to anything, it must be as a LAST resort: it is the build
# the device was already running, never the one it was trying to reach.
if (Test-Path '{q}\vale-agent.exe') {{ try {{ Copy-Item -Force '{q}\vale-agent.exe' '{q}\vale-agent.old.exe' }} catch {{}} }}
foreach($i in 1..12){{ try {{ Copy-Item -Force -ErrorAction Stop '{q}\vale-agent.new.exe' '{q}\vale-agent.exe'; $ok=$true; break }} catch {{ Start-Sleep -Milliseconds 800 }} }};
"[$(Get-Date -Format o)] copy ok=$ok" | Out-File '{logs}\vale-update.log' -Append;
if ($ok) {{ Remove-Item -Force -ErrorAction SilentlyContinue '{q}\vale-agent.new.exe' }};
if ($ok) {{ if (Test-Path '{comp}\vale-playwright.new.zip') {{ Copy-Item -Force '{comp}\vale-playwright.new.zip' '{comp}\vale-playwright.zip'; Remove-Item -Force '{comp}\vale-playwright.new.zip' }} }};
if ($ok) {{ if (Test-Path '{comp}\cloudflared.new.exe') {{ Copy-Item -Force '{comp}\cloudflared.new.exe' '{comp}\cloudflared.exe'; Remove-Item -Force '{comp}\cloudflared.new.exe' }} }};
if ($ok) {{ Set-Content -Path '{etc}\.vale-release' -Value '{ver}' -NoNewline -ErrorAction SilentlyContinue }};
if ($ok -and '{ver}') {{ try {{
$rk = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ValeAgent';
if (-not (Test-Path $rk)) {{ New-Item -Path $rk -Force | Out-Null }};
Set-ItemProperty -Path $rk -Name DisplayVersion -Value '{ver}' -ErrorAction Stop;
Set-ItemProperty -Path $rk -Name DisplayName -Value 'Vale Agent {ver}' -ErrorAction Stop;
Set-ItemProperty -Path $rk -Name InstallLocation -Value '{q}' -ErrorAction Stop;
Set-ItemProperty -Path $rk -Name Publisher -Value 'Vale' -ErrorAction Stop;
}} catch {{}} }};
if (-not $ok) {{ Remove-Item -Force -ErrorAction SilentlyContinue '{q}\vale-agent.new.exe','{comp}\vale-playwright.new.zip','{comp}\cloudflared.new.exe' }};
try {{ Start-ScheduledTask ValeAgent -ErrorAction Stop }} catch {{ schtasks /Run /TN ValeAgent }};
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '{q}\.vale-update';
Remove-Item -Force -ErrorAction SilentlyContinue '{scripts}\vale-update.ps1','{q}\vale-update.ps1';
Remove-Item -Force -ErrorAction SilentlyContinue "{busy_ps}""#,
        );
        let ps1 = crate::paths::scripts_dir().join("vale-update.ps1");
        if let Some(parent) = ps1.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return false;
            }
        }
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
            .output()
            .await;
        // Plugin audit MED (CLI round-217 lesson, Rust twin): powershell's
        // own exit code is NOT the WMI result — Win32_Process.Create reports
        // via ReturnValue; a rejected handoff (9/21) used to print success
        // while nothing swapped, and the busy marker lingered for an hour.
        match r {
            Ok(o) if o.status.success() => {
                let txt = String::from_utf8_lossy(o.stdout.to_vec().as_slice())
                    .trim()
                    .to_string();
                match serde_json::from_str::<serde_json::Value>(&txt) {
                    Ok(v) if v.get("ReturnValue").and_then(|x| x.as_i64()) == Some(0) => true,
                    Ok(v) => {
                        tracing::error!(
                            "[vale-agent] agent_update: WMI Create rejected (ReturnValue {:?})",
                            v.get("ReturnValue")
                        );
                        false
                    }
                    Err(_) => {
                        tracing::error!(
                            "[vale-agent] agent_update: WMI handoff output unparseable: {txt:?}"
                        );
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
            let version_url = download_url.as_deref().map(version_url);
            // (host-pin guard below needs the site URL too — clone OUTSIDE
            // the async block, else the outer closure becomes FnOnce)
            let dl_site = download_url.clone();
            async move {
                let force = params
                    .get("force")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                // round-298: the Cargo version (1.0.x) never changes between
                // releases, so comparing it against the release-server version
                // (1.2.x) ALWAYS looked newer — every agent_update call re-
                // downloaded + swapped, even when the device was current. The
                // release version is now recorded next to the install dir at
                // swap time (.vale-release); read it as the local version when
                // present, falling back to the Cargo version (fresh installs /
                // non-Windows test environments).
                let local = std::fs::read_to_string(crate::paths::release_marker_file())
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

                // saisi decouple: no download_url configured → explicit error
                // instead of a hardcoded host.
                let version_url = match version_url {
                    Some(u) => u,
                    None => {
                        return Ok(
                            tool_error("no update channel configured (platform.download_url unset) — this is a purely local install"),
                        );
                    }
                };

                // 1. What does the release server say? Timeout so a hung release
                //    server can't pin the handler forever (MCP client may have
                //    disconnected; the future would linger otherwise).
                let resp = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(15))
                    .build()
                    .map_err(|e| DeviceError::Internal {
                        message: format!("client build failed: {e}"),
                    })?
                    .get(&version_url)
                    .send()
                    .await
                    .map_err(|e| DeviceError::Internal {
                        message: format!("version check failed: {e}"),
                    })?;
                let j: Value = resp.json().await.map_err(|e| DeviceError::Internal {
                    message: format!("bad version response: {e}"),
                })?;
                let remote = j
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let download = j
                    .get("download")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // Plugin audit MED: sha256 proves CONSISTENCY of whatever was
                // downloaded, not authenticity — over plain http (or pointed at
                // another host) a network MITM supplies exe+matching hash and
                // gets SYSTEM code execution. Require https (loopback dev
                // exempt) and the SAME host as the configured download site.
                if let Err(message) =
                    check_download_url(&download, dl_site.as_deref().unwrap_or(""))
                {
                    return Err(DeviceError::Internal { message });
                }
                // Integrity anchor: the sha256 of the npm tgz, published
                // by the release server and verified against the downloaded bytes
                // BEFORE spawn (round-54 — the installer is AI-triggerable code
                // execution at SYSTEM; trust cannot rest on the transport alone).
                let expected_sha256 = j
                    .get("sha256")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_lowercase();
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
                if !valid_sha256(&expected_sha256) {
                    return Err(DeviceError::Internal {
                    message: "release server returned no/invalid sha256 — refusing unverifiable install".to_string(),
                });
                }

                // vale rollback pin (ADR 0008 companion): while
                // etc\.rollback-pin exists, agent_update must NOT drift the
                // device off the pinned version — the AI-push path is
                // exactly the auto-upgrade that would undo a human
                // rollback. force:true is the explicit override and clears
                // the pin (same intent a `vale rollback --clear`).
                let pin = std::fs::read_to_string(crate::paths::etc_dir().join(".rollback-pin"))
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                if pin_blocks(&pin, &remote, force) {
                    return Ok(json!({
                        "status": "pinned",
                        "pinned_to": pin,
                        "remote": remote,
                        "current": local,
                        "message": format!("device pinned to {pin} by 'vale rollback' — 'vale rollback --clear' on the device, or force:true, overrides"),
                    }));
                }
                if force && !pin.is_empty() {
                    let _ = std::fs::remove_file(crate::paths::etc_dir().join(".rollback-pin"));
                    tracing::info!("[vale-agent] agent_update: force cleared rollback pin {pin}");
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
                //    Acquisition + the 60-min staleness reclaim live in
                //    acquire_busy_marker (atomic create_new; reclaim at most
                //    once so a locked marker cannot spin).
                let busy = busy_marker_path();
                acquire_busy_marker(&busy, std::time::Duration::from_secs(BUSY_STALE_SECS))?;

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
                            .map_err(|e| DeviceError::Internal {
                                message: format!("client build failed: {e}"),
                            })?;
                        client
                            .get(&dl_url)
                            .send()
                            .await
                            .map_err(|e| DeviceError::Internal {
                                message: format!("download failed: {e}"),
                            })?
                            .bytes()
                            .await
                            .map_err(|e| DeviceError::Internal {
                                message: format!("download failed: {e}"),
                            })
                    }
                    .await
                    {
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
                        let actual = crate::hex_encode(&Sha256::digest(&bytes));
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
                        // Post-staging failure (swap-script write / WMI handoff
                        // rejected): no swap will ever run, so drop the staged
                        // .new files best-effort — a reboot must not find a
                        // failed update's leftovers to apply. Retry re-stages
                        // from scratch (safe, same as a staging failure above).
                        cleanup_staged(&install_dir());
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
    fn pin_blocks_matrix() {
        // No pin (empty) never blocks — the release channel is authoritative.
        assert!(!pin_blocks("", "1.2.308", false));
        assert!(!pin_blocks("", "1.2.308", true));
        // A pin blocks every OTHER version; the pinned version itself passes.
        assert!(pin_blocks("1.2.307", "1.2.308", false));
        assert!(!pin_blocks("1.2.307", "1.2.307", false));
        // force is the explicit human override — never blocks.
        assert!(!pin_blocks("1.2.307", "1.2.308", true));
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
        assert_eq!(crate::hex_encode(&[0x00, 0xab, 0xff]), "00abff");
        assert_eq!(crate::hex_encode(b""), "");
    }

    #[test]
    fn version_url_trims_slashes_and_appends_manifest() {
        assert_eq!(
            version_url("https://agent.saisi.online"),
            "https://agent.saisi.online/api/version"
        );
        assert_eq!(
            version_url("https://agent.saisi.online///"),
            "https://agent.saisi.online/api/version"
        );
    }

    #[test]
    fn cleanup_staged_removes_only_staged_leftovers() {
        // The swap script applies staged .new files — after a FAILED update
        // they must be gone (no mixed-version apply later), while every
        // LIVE file stays byte-identical.
        let dir = std::env::temp_dir().join(format!("vale-cleanup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("components")).unwrap();
        std::fs::create_dir_all(dir.join("etc")).unwrap();
        let live = [
            dir.join("vale-agent.exe"),
            dir.join("components").join("vale-playwright.zip"),
            dir.join("components").join("cloudflared.exe"),
            dir.join("etc").join(".vale-release"),
        ];
        for p in &live {
            std::fs::write(p, b"live").unwrap();
        }
        let staged = [
            dir.join("vale-agent.new.exe"),
            dir.join("components").join("vale-playwright.new.zip"),
            dir.join("components").join("cloudflared.new.exe"),
        ];
        for p in &staged {
            std::fs::write(p, b"staged").unwrap();
        }
        let extract = dir.join(".vale-update");
        std::fs::create_dir_all(extract.join("package")).unwrap();
        std::fs::write(extract.join("package").join("junk"), b"x").unwrap();

        cleanup_staged(&dir);

        for p in &staged {
            assert!(!p.exists(), "staged leftover must go: {}", p.display());
        }
        assert!(!extract.exists(), ".vale-update extract dir must go");
        for p in &live {
            assert_eq!(
                std::fs::read(p).unwrap(),
                b"live",
                "live file touched: {}",
                p.display()
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_staged_on_empty_dir_is_a_noop() {
        let dir = std::env::temp_dir().join(format!("vale-cleanup-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        cleanup_staged(&dir); // must not error or create anything
        assert!(std::fs::read_dir(&dir).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Fresh temp path for one busy-marker test (never created here — the
    /// point is what acquire_busy_marker does with it).
    fn marker_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vale-busy-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("update-busy")
    }

    /// Backdate a marker past the staleness window. NOTE the window is
    /// compared in WHOLE SECONDS (faithful to the original
    /// `age.as_secs() > 3600`), so a just-created marker is 0 s old and
    /// `Duration::ZERO` would NOT make it stale — the mtime has to move.
    /// File::open + set_modified works for both files and directories.
    fn age_marker(p: &std::path::Path) {
        let old =
            std::time::SystemTime::now() - std::time::Duration::from_secs(BUSY_STALE_SECS + 60);
        std::fs::File::open(p)
            .expect("open marker to backdate it")
            .set_modified(old)
            .expect("backdate marker mtime");
    }

    #[test]
    fn busy_marker_acquire_creates_then_conflicts() {
        let p = marker_path("acquire");
        assert!(!p.exists());
        acquire_busy_marker(&p, std::time::Duration::from_secs(BUSY_STALE_SECS)).unwrap();
        assert!(p.exists(), "a successful acquire leaves the marker behind");

        // A second (concurrent) update is refused while the marker is fresh.
        let err = acquire_busy_marker(&p, std::time::Duration::from_secs(BUSY_STALE_SECS))
            .expect_err("a fresh marker must refuse a second update")
            .to_string();
        assert!(
            err.contains("another update is already in progress"),
            "message must stay recognizable to callers: {err}"
        );
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn busy_marker_reclaims_an_abandoned_marker() {
        // A crashed install's marker is older than the window → reclaimed
        // (round-54: without this, one crash locked updates out forever).
        let p = marker_path("stale");
        std::fs::write(&p, b"").unwrap();
        age_marker(&p);
        acquire_busy_marker(&p, std::time::Duration::from_secs(BUSY_STALE_SECS))
            .expect("an abandoned marker is reclaimed");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn busy_marker_never_spins_when_reclaim_cannot_remove_it() {
        // The reclaim runs at most ONCE. If removing the abandoned marker
        // fails, the retry sees it again — without the once-flag this loop
        // would spin forever (round-54's "must not spin"). A DIRECTORY at the
        // marker path reproduces that deterministically: create_new reports
        // AlreadyExists, and remove_file (not remove_dir) cannot clear it.
        let p = marker_path("unremovable");
        std::fs::create_dir_all(&p).unwrap();
        age_marker(&p); // stale, so the reclaim path is actually entered
        let err = acquire_busy_marker(&p, std::time::Duration::from_secs(BUSY_STALE_SECS))
            .expect_err("an unremovable marker must be reported, not retried forever")
            .to_string();
        assert!(
            err.contains("another update is already in progress"),
            "{err}"
        );
        assert!(p.is_dir(), "the unremovable marker is left as found");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn busy_marker_path_agrees_with_the_swap_script_spelling() {
        // The marker is released by the generated PowerShell script, which
        // spells the same file as "$env:ProgramData\…". If the two spellings
        // drift, the swap deletes a file the agent never created: the marker
        // survives and every later update is refused for up to an hour. Pin
        // that both sides still name the same location.
        let ps = busy_marker_ps();
        assert_eq!(ps, r"$env:ProgramData\ValeAgent\update-busy");
        let rel = ps
            .strip_prefix(r"$env:ProgramData\")
            .expect("the script's spelling is ProgramData-rooted");
        let mut expected = programdata_dir();
        for part in rel.split('\\') {
            expected.push(part);
        }
        assert_eq!(busy_marker_path(), expected);
        // ...and the marker really is the file the swap script removes (not
        // merely a same-named sibling): two components under ProgramData.
        assert_eq!(
            busy_marker_path()
                .strip_prefix(programdata_dir())
                .unwrap()
                .components()
                .count(),
            2
        );
    }

    #[test]
    fn host_of_strips_scheme_userinfo_port_and_case() {
        assert_eq!(
            host_of("https://agent.saisi.online/vale-agent/x.tgz"),
            "agent.saisi.online"
        );
        assert_eq!(host_of("https://user:pw@EXAMPLE.com:8443/a"), "example.com");
        assert_eq!(host_of("http://127.0.0.1:18080/api/version"), "127.0.0.1");
        assert_eq!(host_of("http://localhost/x"), "localhost");
        assert_eq!(host_of("not-a-url"), "");
        assert_eq!(host_of(""), "");
    }

    #[test]
    fn check_download_url_gates_scheme_and_host() {
        let site = "https://agent.saisi.online";
        // https same-host: the production shape.
        assert!(check_download_url(
            "https://agent.saisi.online/vale-agent/vale-agent-1.2.1.tgz",
            site
        )
        .is_ok());
        // http loopback: dev exemption (127.0.0.1/localhost only — a bare
        // ::1 URL parses to "" via host_of, so it stays refused; see note).
        for host in ["127.0.0.1", "localhost"] {
            assert!(
                check_download_url(&format!("http://{host}/x.tgz"), site).is_ok(),
                "loopback {host} must pass"
            );
        }
        assert!(check_download_url("http://::1/x.tgz", site).is_err());
        // http public: MITM-supplied exe+hash → SYSTEM execution. Refuse.
        assert!(check_download_url("http://agent.saisi.online/x.tgz", site).is_err());
        assert!(check_download_url("http://evil.example/x.tgz", site).is_err());
        // Host mismatch: manifest pointing off-site. Refuse.
        let err = check_download_url("https://evil.example/x.tgz", site).unwrap_err();
        assert!(
            err.contains("evil.example") && err.contains("agent.saisi.online"),
            "{err}"
        );
        // Empty site (unset download channel): skip the host match.
        assert!(check_download_url("https://any.example/x.tgz", "").is_ok());
        // Non-URL garbage: no https prefix. Refuse.
        assert!(check_download_url("vale-agent.tgz", site).is_err());
    }

    #[test]
    fn valid_sha256_requires_64_hex() {
        assert!(valid_sha256(&"a".repeat(64)));
        assert!(valid_sha256(&"A".repeat(64)));
        assert!(!valid_sha256(""));
        assert!(!valid_sha256(&"a".repeat(63)));
        assert!(!valid_sha256(&"a".repeat(65)));
        assert!(!valid_sha256(&format!("{}g", "a".repeat(63))));
    }

    /// The gate that stands between a REMOTE manifest field and SYSTEM code
    /// execution, pinned against the shapes an attacker would try.
    ///
    /// Every verdict here was OBSERVED before it was asserted (a probe test
    /// printed `host_of(u)` + the verdict for each shape). Two of them are
    /// judgement calls rather than obvious outcomes, and both are recorded
    /// with their reasoning so a later "fix" has to argue with the comment:
    ///
    ///   * the SCHEME match is case-SENSITIVE, so `HTTPS://…` is refused. That
    ///     rejects a technically-valid URL, i.e. it fails CLOSED. Lowercasing
    ///     the comparison would be equally safe; the current behaviour is
    ///     pinned so changing it is deliberate.
    ///   * the PORT is not part of the check, so `https://site:8443/x` is
    ///     accepted. That is sound here: the host still has to serve a
    ///     certificate valid for the configured site, so a different port on
    ///     the AUTHENTICATED host is not an escalation.
    #[test]
    fn check_download_url_refuses_every_offsite_shape() {
        // The production shape carries a PATH (the release lives under
        // /vale-agent), which is why host_of strips one.
        let site = "https://agent.saisi.online/vale-agent";
        let refused = |u: &str| {
            check_download_url(u, site)
                .err()
                .unwrap_or_else(|| panic!("{u} must be REFUSED — it is off-site"))
        };

        // userinfo trick: this URL's real host is evil.example (userinfo comes
        // BEFORE the @), so it must be refused...
        refused("https://agent.saisi.online@evil.example/x.tgz");
        // ...and this one's real host IS the site (evil.example is the
        // userinfo), so accepting it is CORRECT — the connection goes to
        // agent.saisi.online. Pinned because it LOOKS like a bypass.
        assert!(
            check_download_url("https://evil.example@agent.saisi.online/x.tgz", site).is_ok(),
            "userinfo is not the host — this connects to the real site"
        );

        // Suffix / prefix lookalikes.
        refused("https://agent.saisi.online.evil.example/x.tgz");
        refused("https://evil.example/agent.saisi.online/x.tgz");
        refused("https://evil.example/agent.saisi.online.tgz");
        // THE SUFFIX TRAP — a DIFFERENT host whose name ENDS WITH the site.
        // This is the shape a `starts_with`/`ends_with`/`contains` host check
        // would wave through, and the first version of this test MISSED it:
        // mutation testing (swapping the equality for `ends_with`) left the
        // test green, proving the pins did not actually discriminate. Both
        // spellings are here: one against the production site, one against a
        // bare domain where the attacker-controlled host is unmistakable.
        refused("https://notagent.saisi.online/x.tgz");
        let bare = "https://cdn.example.com";
        assert!(
            check_download_url("https://cdn.example.com/x.tgz", bare).is_ok(),
            "the exact host must pass"
        );
        assert!(
            check_download_url("https://evilcdn.example.com/x.tgz", bare).is_err(),
            "evilcdn.example.com is a DIFFERENT host that merely ends with \
             cdn.example.com — a suffix match would execute attacker bytes at \
             SYSTEM"
        );

        // Scheme smuggling + malformed shapes.
        refused("HTTPS://agent.saisi.online/x.tgz"); // case-sensitive match
        refused("//agent.saisi.online/x.tgz"); // scheme-relative
        refused("https:/agent.saisi.online/x.tgz"); // one slash
        refused("agent.saisi.online/x.tgz"); // no scheme at all
        refused("http://agent.saisi.online/x.tgz"); // http off-loopback

        // Trailing-dot FQDN: a false NEGATIVE (a technically-valid URL is
        // rejected), i.e. it fails closed. Pinned as-is.
        refused("https://agent.saisi.online./x.tgz");

        // Same authenticated host on another port is accepted — see the note.
        assert!(
            check_download_url("https://agent.saisi.online:8443/x.tgz", site).is_ok(),
            "a different port on the AUTHENTICATED host is not an escalation"
        );

        // And the production shape still passes, so the pins above are not
        // just an over-tightened gate that refuses everything.
        assert!(check_download_url(
            "https://agent.saisi.online/vale-agent/vale-agent-1.2.1.tgz",
            site
        )
        .is_ok());
    }
}
