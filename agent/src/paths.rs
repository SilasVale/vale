//! Path resolution — ONE source of truth for where Vale lives on Windows.
//!
//! C1 (2026-08-28): `HKLM\SOFTWARE\Vale\Agent\{InstallDir,DataDir}` (written by
//! the NSIS installer / setup.ps1) is authoritative. Resolution order:
//!   1. registry InstallDir (Windows, when readable)
//!   2. the running exe's directory (self-contained installs, dev builds,
//!      and non-Windows) — the historic behavior
//!
//! No legacy directory probing: exactly one resolution path.
//!
//! DataDir (sessions/memory/logs) likewise comes from the registry; on
//! non-Windows or when unset it defaults next to the exe (install dir), which
//! keeps dev/test behavior unchanged.
//!
//! See docs/superpowers/specs/2026-08-28-vale-desktop-core-design.md §9.

use std::path::PathBuf;

#[cfg(windows)]
fn registry_value(name: &str) -> Option<String> {
    // winreg is not a dependency of vale-agent-core; query via `reg query`
    // (always present on Windows) instead of pulling a crate into the core.
    use std::process::Command;
    let out = Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\Vale\Agent", "/v", name])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // reg query output:  InstallDir    REG_SZ    C:\Program Files\Vale
    let line = text.lines().find(|l| l.contains(name))?;
    let after = line.split("REG_SZ").nth(1)?;
    let v = after.trim();
    if v.is_empty() { None } else { Some(v.to_string()) }
}

#[cfg(not(windows))]
fn registry_value(_name: &str) -> Option<String> {
    None
}

/// Directory the running exe lives in (the historic heuristic).
pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
}

/// The install dir — registry first, then the exe dir. No legacy directory
/// probing: a fresh install always writes the registry (NSIS/setup.ps1/
/// vale.js), and self-contained/dev installs are exe-relative. The exe dir
/// is the ONLY fallback so there is exactly one resolution path.
pub fn install_dir() -> PathBuf {
    if let Some(v) = registry_value("InstallDir") {
        return PathBuf::from(v);
    }
    let exe = exe_dir();
    if !exe.as_os_str().is_empty() {
        return exe;
    }
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\Program Files\Vale")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(".")
    }
}

/// The data dir (sessions/memory/logs) — registry DataDir, else install dir.
pub fn data_dir() -> PathBuf {
    if let Some(v) = registry_value("DataDir") {
        return PathBuf::from(v);
    }
    install_dir()
}

/// Restrict a file to the running account ONLY (temp files pass this BEFORE
/// the atomic rename, so a secret never lives a moment under inherited
/// ACLs). Windows: icacls break-inheritance + grant current user RW. Unix:
/// 0o600. Credential audit round MED-2: the store writers must call this —
/// C:\ProgramData\Vale otherwise inherits Users:RX, exposing plaintext.
pub fn harden_file(path: &std::path::Path) -> Result<(), std::io::Error> {
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME")
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "USERNAME unavailable"))?;
        // Grant CURRENT USER + SYSTEM (S-1-5-18): files move between those
        // two contexts (setup writes config.yaml as the interactive user,
        // the service rewrites it as SYSTEM) — an ACL that only names one
        // bricks the other. Inheritance is stripped, so BUILTIN\Users lose
        // the RX they used to inherit over C:\ProgramData\Vale.
        let out = std::process::Command::new("icacls")
            .args([
                path.to_string_lossy().as_ref(),
                "/inheritance:r",
                "/grant:r",
                &format!("{user}:(R,W)"),
                "*S-1-5-18:(R,W)",
            ])
            .output()?;
        if !out.status.success() {
            return Err(std::io::Error::new(std::io::ErrorKind::Other, "icacls rejected"));
        }
        Ok(())
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        Ok(())
    }
}

/// The session audit-log directory (single source of truth — the writer in
/// plugins/terminal and the /api/sessions readers in web.rs MUST agree; on
/// registry-first installs DataDir != InstallDir, and readers using
/// current_exe() went permanently blind). All path resolution lives here.
pub fn sessions_dir() -> PathBuf {
    data_dir().join("sessions")
}

/// The node runtime path recorded by `vale setup` (registry NodePath).
/// None when unset or missing on disk. The SYSTEM agent may not see the
/// user PATH, so setup records the absolute path explicitly.
pub fn node_path() -> Option<PathBuf> {
    let v = registry_value("NodePath")?;
    let p = PathBuf::from(v);
    p.exists().then_some(p)
}
