//! Path resolution — ONE source of truth for where Vale lives on Windows.
//!
//! C1 (2026-08-28): `HKLM\SOFTWARE\Vale\Agent\{InstallDir,DataDir}` (written by
//! `vale setup`; retired predecessors: NSIS/setup.ps1) is authoritative. Resolution order:
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
use std::sync::OnceLock;

/// Boot-invariant directory cache. The registry InstallDir/DataDir values are
/// written ONLY at install/setup time (`vale setup`, the installer, vale.js) —
/// never mutated while the agent runs; the npm update flow swaps the exe and
/// RESTARTS the process, so a fresh process re-resolves. The first resolution
/// therefore wins for the process lifetime, and caching it keeps the
/// registry-backed path helpers free of a synchronous `reg query` subprocess
/// on every call (they run inside the async HTTP handler — /api/status polls
/// every 15 s).
static INSTALL_DIR: OnceLock<PathBuf> = OnceLock::new();
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

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
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
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
/// probing: a fresh install always writes the registry (via `vale setup`;
/// retired predecessors NSIS/setup.ps1), and self-contained/dev installs are
/// exe-relative. The exe dir is the ONLY fallback so there is exactly one
/// resolution path.
///
/// Cached (see the static above): boot-invariant for a running process.
pub fn install_dir() -> PathBuf {
    INSTALL_DIR.get_or_init(compute_install_dir).clone()
}

fn compute_install_dir() -> PathBuf {
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
/// Cached (see the static above): boot-invariant for a running process.
pub fn data_dir() -> PathBuf {
    DATA_DIR.get_or_init(compute_data_dir).clone()
}

fn compute_data_dir() -> PathBuf {
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
        // d1 PROVED the old NAME-based grant silently never applied: under
        // the service context USERNAME is the MACHINE ACCOUNT
        // ('DESKTOP-xxx$'), which icacls cannot map (“no mapping between
        // security IDs and names”) -> whole command rejected -> config.yaml
        // kept its inherited Users:RX. Fixed SIDs resolve in EVERY context
        // (icacls '*' prefix = already-SID, no name lookup):
        //   *S-1-5-18       SYSTEM — the service (setup writes as the
        //   *S-1-5-32-544   Administrators —   interactive user, both cover)
        // files move between those two writer contexts; stripping
        // inheritance is what actually removes BUILTIN\Users' inherited RX
        // over C:\ProgramData\Vale / the install dir.
        let out = std::process::Command::new("icacls")
            .args([
                path.to_string_lossy().as_ref(),
                "/inheritance:r",
                "/grant:r",
                "*S-1-5-18:(R,W)",
                "*S-1-5-32-544:(R,W)",
            ])
            .output()?;
        if !out.status.success() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "icacls rejected",
            ));
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

/// Layout v2 (ADR 0008): subdirectories under the install dir. The install
/// ROOT keeps only the service exe (+ transient .new/.old) and the NSIS
/// uninstaller; everything else lives in one of these directories. Every
/// helper derives from install_dir()/data_dir() — no second root anywhere,
/// no leaf-name changes (Electron packaging + task arguments are sensitive
/// to renames; only the PARENT moves).
/// Config + markers + machine state (never logs, never evidence).
pub fn etc_dir() -> PathBuf {
    install_dir().join("etc")
}

/// Boxed, release-locked components (portable node, npm-global, cloudflared,
/// playwright bundle, desktop shell). Replaces the flat `tools\` dir and the
/// root-level `playwright\` / `vale-desktop-electron\` dirs.
pub fn components_dir() -> PathBuf {
    install_dir().join("components")
}

/// Supervisor + bootstrap scripts (desktop pulse, playwright probe, update
/// swap staging, shell-integration). Written by setup/installer/update, read
/// by the scheduled tasks.
pub fn scripts_dir() -> PathBuf {
    install_dir().join("scripts")
}

/// Runtime logs live under DataDir — program files stay read-mostly
/// (Program Files semantics; a reinstall wipes the program dir but keeps
/// diagnostics).
pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

/// AI evidence (screenshots, transfers served by /api/browser/pwshots) —
/// runtime data, not program. Was the install-root `pwout\` dir.
pub fn evidence_dir() -> PathBuf {
    data_dir().join("pwout")
}

/// RUN identity log directory (device-level, beside sessions + evidence).
///
/// Device-level rather than per-session because a run spans the terminal AND the
/// browser, and the embedded browser has no session ownership at all — a run is
/// what an AI EXECUTION is, not what a terminal session is.
pub fn runs_dir() -> PathBuf {
    data_dir().join("runs")
}

pub fn config_file() -> PathBuf {
    etc_dir().join("config.yaml")
}
pub fn hostname_file() -> PathBuf {
    etc_dir().join("vale-agent.hostname")
}
pub fn tunnel_file() -> PathBuf {
    etc_dir().join("tunnel.yml")
}
pub fn release_marker_file() -> PathBuf {
    etc_dir().join(".vale-release")
}
pub fn boxed_versions_file() -> PathBuf {
    etc_dir().join("boxed-versions.json")
}
pub fn cloudflared_bin() -> PathBuf {
    components_dir().join("cloudflared.exe")
}
pub fn playwright_dir() -> PathBuf {
    components_dir().join("playwright")
}
pub fn desktop_shell_dir() -> PathBuf {
    components_dir().join("vale-desktop-electron")
}
pub fn agent_log_file() -> PathBuf {
    logs_dir().join("agent.log")
}
pub fn startup_log_file() -> PathBuf {
    logs_dir().join("startup.log")
}
pub fn shell_integration_dir() -> PathBuf {
    scripts_dir().join("shell-integration")
}
/// Layout-v2 migration done-marker (ADR 0008 aging). Presence means the
/// boot backstop already ran to completion; `migrate_layout_v2` returns a
/// no-op note instead of re-scanning every boot. Written ONLY when no move
/// is left pending (an old path exists while its new path does not) — a
/// partially-failed migration retries on the next boot. Deletion criterion:
/// once the oldest release kept by the CDN last-5-per-minor policy is a
/// layout-v2 build, this shim (marker check + move plan) can be removed.
pub fn layout_marker_file() -> PathBuf {
    marker_in(&install_dir())
}

/// The layout-v2 marker inside a GIVEN install root.
///
/// ONE expression, three uses. `layout_marker_file()` derives from the live
/// install dir for callers that have no root in hand, while `migration_notes`
/// takes its roots as ARGUMENTS (it is pure so tests can pin the plan without
/// touching the process-global cached dirs) and therefore cannot call the
/// accessor. That is a good reason to have two functions and no reason to have
/// three copies of the literal: the marker WROTE here and was READ here, and a
/// path that must agree in two places is a path that will eventually disagree.
fn marker_in(install: &std::path::Path) -> PathBuf {
    install.join("etc").join(".layout-v2")
}

/// Layout-v2 migration plan (ADR 0008): (old, new) pairs for every path
/// that moved off the install root. PURE — takes both roots as args so
/// tests pin it without touching the global OnceLock-cached dirs.
/// Semantics (applied by `migrate_layout_v2`): move only when the target is
/// missing (never clobber); directory pairs merge children the same way.
/// Files nobody reads anymore are intentionally ABSENT here (dead weight
/// stays behind for the uninstall rmdir, it is not migrated).
fn migration_moves(install: &std::path::Path, data: &std::path::Path) -> Vec<(PathBuf, PathBuf)> {
    let etc = install.join("etc");
    let comp = install.join("components");
    let scripts = install.join("scripts");
    let logs = data.join("logs");
    let mut moves = Vec::new();
    // etc\
    for name in [
        "config.yaml",
        "vale-agent.hostname",
        "tunnel.yml",
        ".vale-release",
        "boxed-versions.json",
    ] {
        moves.push((install.join(name), etc.join(name)));
    }
    // components\ (leaf names unchanged)
    for name in ["node", "npm-global"] {
        moves.push((install.join("tools").join(name), comp.join(name)));
    }
    moves.push((
        install.join("tools").join("cloudflared.exe"),
        comp.join("cloudflared.exe"),
    ));
    moves.push((install.join("playwright"), comp.join("playwright")));
    moves.push((
        install.join("vale-desktop-electron"),
        comp.join("vale-desktop-electron"),
    ));
    // scripts\
    for name in [
        "ensure-desktop.ps1",
        "desktop-pulse.vbs",
        "start-desktop.ps1",
        "vale-online-setup.ps1",
        "fix-tunnel.ps1",
    ] {
        moves.push((install.join(name), scripts.join(name)));
    }
    for name in ["run-hidden.vbs", "playwright-probe.ps1"] {
        moves.push((install.join("playwright").join(name), scripts.join(name)));
    }
    moves.push((
        install.join("shell-integration"),
        scripts.join("shell-integration"),
    ));
    // logs\ (best-effort history, never gated)
    for name in [
        "installer.log",
        "install-result.txt",
        "vale-update.log",
        "agent.log",
        "startup.log",
    ] {
        moves.push((install.join(name), logs.join(name)));
    }
    // evidence (best-effort, never gated)
    moves.push((install.join("pwout"), data.join("pwout")));
    moves
}

/// Copy a file or a directory TREE, used when `rename` cannot be used.
///
/// Only the fallback for a cross-device move needs the recursion; a same-device
/// move never reaches here.
fn copy_tree(old: &std::path::Path, new: &std::path::Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(old)?;
    if meta.is_dir() {
        std::fs::create_dir_all(new)?;
        for entry in std::fs::read_dir(old)? {
            let entry = entry?;
            copy_tree(&entry.path(), &new.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(old, new).map(|_| ())
    }
}

/// Move `old` to `new`, working ACROSS VOLUMES.
///
/// `std::fs::rename` is documented to fail when the two paths are on different
/// mount points (`EXDEV`, "Invalid cross-device link"). That is not a corner case
/// here: the layout-v2 migration moves the LOGS and `pwout` from InstallDir to
/// DataDir, and on the project's own device those are `D:\Vale` and
/// `C:\ProgramData\Vale` — two volumes. So every data-side move failed, the
/// migration reported `INCOMPLETE (pending moves locked?)` on EVERY boot, and the
/// marker was never written. The diagnosis was wrong too: nothing was locked; the
/// rename simply cannot work between volumes, and the message sent a reader
/// looking for a file lock that never existed.
///
/// The fallback is copy-then-remove, which is what every cross-device mover does.
/// Only on rename failure, so a same-volume move keeps its atomicity.
///
/// PRECONDITION, and it is the caller's: `new`'s PARENT exists. `move_one` creates
/// it before calling; this does not, so that a directory merge and a fresh move
/// cannot disagree about who owns creation.
fn move_path(old: &std::path::Path, new: &std::path::Path) -> bool {
    if std::fs::rename(old, new).is_ok() {
        return true;
    }
    // The target must not exist for a copy to be unambiguous — `move_one`'s
    // callers decide that, and this only runs after rename failed, so clearing
    // nothing here is deliberate: a partial copy is worse than a refused move.
    if new.exists() {
        return false;
    }
    if copy_tree(old, new).is_err() {
        // Leave the source in place: a half-copied tree that also deleted its
        // origin would lose data, and the next boot retries.
        return false;
    }
    let removed = if old.is_dir() {
        std::fs::remove_dir_all(old).is_ok()
    } else {
        std::fs::remove_file(old).is_ok()
    };
    if !removed {
        // The COPY succeeded, so the data is safe at the new home; the leftover
        // is a duplicate, not a loss. Report the move as done so the marker can
        // be written — retrying forever over an undeletable leftover would keep
        // the device permanently "INCOMPLETE".
        return true;
    }
    true
}

fn move_one(old: &std::path::Path, new: &std::path::Path) -> bool {
    if !old.exists() {
        return false;
    }
    if let Some(parent) = new.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    if !old.is_dir() {
        // Files never clobber: a present target wins (staged .new output or
        // an already-migrated file).
        if new.exists() {
            return false;
        }
        return move_path(old, new);
    }
    // Dirs: fast rename when the target is absent, else merge children one
    // level (a staged tree or a previous partial migration must never be
    // clobbered): move what's missing, keep what's there.
    if !new.exists() && move_path(old, new) {
        return true;
    }
    if new.exists() {
        let entries = match std::fs::read_dir(old) {
            Ok(e) => e,
            Err(_) => return false,
        };
        let mut moved_any = false;
        for entry in entries.flatten() {
            let dest = new.join(entry.file_name());
            if dest.exists() {
                continue;
            }
            if std::fs::rename(entry.path(), &dest).is_ok() {
                moved_any = true;
            }
        }
        if moved_any
            && std::fs::read_dir(old)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false)
        {
            let _ = std::fs::remove_dir(old);
        }
        return moved_any;
    }
    false
}

/// One-time layout-v2 boot migration (ADR 0008 backstop). Runs at agent
/// boot BEFORE logging/config load: moves every legacy root path into its
/// v2 home when the new home is still missing. Covers the one updater that
/// cannot migrate itself — a pre-v2 Rust `agent_update` swapping in a v2
/// exe with v1 paths (the updater is old code; the layout it leaves is
/// old). Gated by the `.layout-v2` marker: once a full pass ends with
/// nothing pending, the marker is written and every later boot returns a
/// one-line no-op note. Idempotent; real installs only (registry
/// InstallDir present — dev trees with exe-dir fallback never had the v1
/// layout and must not be touched). Returns human-readable notes for the
/// boot log. Never fails the boot.
pub fn migrate_layout_v2() -> Vec<String> {
    let mut notes = Vec::new();
    if registry_value("InstallDir").is_none() {
        return notes;
    }
    let install = install_dir();
    let data = data_dir();
    if marker_in(&install).exists() {
        notes.push("layout v2 marker present (migration done)".into());
        return notes;
    }
    for (old, new) in migration_moves(&install, &data) {
        // move_one decides clobber/merge per kind; report only real moves.
        // (Dirs with a present target merge children instead of no-op.)
        if old.exists() && move_one(&old, &new) {
            notes.push(format!("migrated {} -> {}", old.display(), new.display()));
        }
    }
    // Marker only when NOTHING is pending: a move that failed because its
    // source is locked retries next boot (a locked leftover is garbage for
    // uninstall, but a MISSING new home — config.yaml especially — must
    // never be accepted silently).
    if migration_pending(&install, &data) {
        // NOT "(pending moves locked?)" — that guess was WRONG and it sent a
        // reader after a file lock that never existed. The moves it describes
        // cross volumes (InstallDir -> DataDir), and before the fallback landed
        // they could not succeed at all. Name the condition, and the two things
        // that actually cause it.
        notes.push(
            "layout v2 migration INCOMPLETE — some paths are still at their old \
             home; a move either could not be written (permissions/space) or its \
             target already exists. Retrying next boot."
                .into(),
        );
    } else {
        let marker = marker_in(&install);
        // BOOT-PATH RULE (SOLID R110): this function is called FIRST in
        // `main()`, BEFORE tracing is initialized — a panic here is a device
        // that never starts and leaves no log at all (the 1.2.223 dark-device
        // class). `parent()` is `Some` for any real install root, but the
        // `.unwrap()` that used to sit here made this function's own
        // "Never fails the boot" contract depend on that path arithmetic
        // staying true forever. The `None` arm is unreachable today and is
        // kept as a note instead of a panic, so the contract holds by
        // construction. Enforced by tests/boot_surface.rs.
        let written = marker
            .parent()
            .ok_or_else(|| "install root has no parent".to_string())
            .and_then(|dir| {
                std::fs::create_dir_all(dir)
                    .and_then(|()| {
                        std::fs::write(&marker, b"migrated by vale-agent boot backstop\n")
                    })
                    .map_err(|e| e.to_string())
            });
        match written {
            Ok(()) => notes.push(format!("layout v2 marker written: {}", marker.display())),
            Err(e) => notes.push(format!(
                "layout v2 marker write failed: {e} (retries next boot)"
            )),
        }
    }
    notes
}

/// Pure pending check (testable without the registry-gated globals): any
/// moved path whose old home still exists while its new home does not.
fn migration_pending(install: &std::path::Path, data: &std::path::Path) -> bool {
    migration_moves(install, data)
        .into_iter()
        .any(|(old, new)| old.exists() && !new.exists())
}

/// The node runtime path recorded by `vale setup` (registry NodePath).
/// None when unset or missing on disk. The SYSTEM agent may not see the
/// user PATH, so setup records the absolute path explicitly.
pub fn node_path() -> Option<PathBuf> {
    let v = registry_value("NodePath")?;
    let p = PathBuf::from(v);
    p.exists().then_some(p)
}

#[cfg(all(test, unix))]
mod harden_tests {
    //! Coverage audit row 6: the unix harden_file arm runs on CI (ubuntu)
    //! today — the 0o600 contract behind every secrets/config write on
    //! non-Windows devices had no test at all.
    use super::*;

    #[test]
    fn harden_file_reduces_to_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("vale-harden-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("secret.yaml");
        std::fs::write(&p, b"x").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        harden_file(&p).expect("harden ok");
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn harden_file_on_missing_path_errors() {
        let missing =
            std::env::temp_dir().join(format!("vale-harden-missing-{}", std::process::id()));
        let _ = std::fs::remove_file(&missing);
        assert!(harden_file(&missing).is_err());
    }
}

#[cfg(test)]
mod resolution_tests {
    //! round-380: the registry-first resolution chain (the single source of
    //! truth for install/data/sessions dirs) had zero tests. The public
    //! fns are OnceLock-cached (boot-invariant — untestable repeatedly),
    //! so these pin the private compute_* fns + the structural contracts.
    //! On machines without a Vale install (all CI runners, this box) the
    //! registry reads None and every dir falls back to the exe dir.
    use super::*;

    #[test]
    fn exe_dir_is_non_empty() {
        assert!(!exe_dir().as_os_str().is_empty());
    }

    #[test]
    fn install_falls_back_to_exe_dir_without_registry() {
        if registry_value("InstallDir").is_some() {
            return; // a real install: registry wins by design, nothing to pin
        }
        assert_eq!(compute_install_dir(), exe_dir());
    }

    #[test]
    fn data_dir_defaults_to_install_dir_without_registry() {
        if registry_value("DataDir").is_some() {
            return;
        }
        assert_eq!(compute_data_dir(), compute_install_dir());
    }

    /// A MOVE ACROSS VOLUMES MUST WORK — and on the project's own device it must.
    ///
    /// The layout-v2 migration moves the logs and `pwout` from InstallDir to
    /// DataDir. On d1 those are `D:\Vale` and `C:\ProgramData\Vale`: DIFFERENT
    /// VOLUMES. `std::fs::rename` is documented to fail across mount points, so
    /// every data-side move failed, `migration_pending` stayed true forever, the
    /// marker was never written, and every boot announced
    /// "INCOMPLETE (pending moves locked?)" — blaming a file lock that was never
    /// there and sending a reader after it.
    ///
    /// THE TEST USES A REAL CROSS-DEVICE RENAME. `/tmp` is ext4 and `/dev/shm` is
    /// tmpfs on the development box, so `rename` between them fails with EXDEV
    /// for the same reason it does on the device. That makes this behavioural
    /// rather than structural — it exercises the fallback the way production does.
    ///
    /// LABELLED LIMIT: it is `cfg(target_os = "linux")` because it needs a second
    /// filesystem that exists on this box, while the product ships on Windows.
    /// The FALLBACK is platform-neutral and the migration's own tests cover the
    /// same-volume path on every platform.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_move_across_volumes_actually_moves() {
        let src_root =
            std::path::Path::new("/tmp").join(format!("vale-xdev-{}", std::process::id()));
        let dst_root =
            std::path::Path::new("/dev/shm").join(format!("vale-xdev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&src_root);
        let _ = std::fs::remove_dir_all(&dst_root);
        std::fs::create_dir_all(src_root.join("tree/inner")).expect("mkdir");
        std::fs::write(src_root.join("tree/top.txt"), b"top").expect("write");
        std::fs::write(src_root.join("tree/inner/deep.txt"), b"deep").expect("write");

        // The premise: a plain rename across these two paths really does fail,
        // so the test would be vacuous if it did not.
        assert!(
            std::fs::rename(src_root.join("tree/top.txt"), dst_root.join("probe.txt")).is_err(),
            "the two paths are on the same filesystem — this test cannot exercise \
             the cross-device path and must be re-pointed"
        );

        // A FILE and a DIRECTORY TREE, both across the boundary. The parent must
        // exist: `move_path` assumes its caller created it, which `move_one`
        // does before calling.
        std::fs::create_dir_all(&dst_root).expect("mkdir dst");
        let file_old = src_root.join("tree/top.txt");
        let file_new = dst_root.join("top.txt");
        assert!(
            move_path(&file_old, &file_new),
            "a file must move across volumes"
        );
        assert_eq!(std::fs::read(&file_new).expect("read"), b"top");
        assert!(
            !file_old.exists(),
            "the source must be gone, not duplicated"
        );

        let dir_new = dst_root.join("moved-tree");
        assert!(
            move_one(&src_root.join("tree"), &dir_new),
            "a directory TREE must move across volumes"
        );
        assert_eq!(
            std::fs::read(dir_new.join("inner/deep.txt")).expect("deep"),
            b"deep"
        );
        assert!(
            !src_root.join("tree").exists(),
            "the tree's source must be gone"
        );

        let _ = std::fs::remove_dir_all(&src_root);
        let _ = std::fs::remove_dir_all(&dst_root);
    }

    #[test]
    fn sessions_dir_nests_under_data_dir() {
        assert_eq!(sessions_dir(), data_dir().join("sessions"));
    }

    #[test]
    fn node_path_is_none_without_registry() {
        if registry_value("NodePath").is_some() {
            return;
        }
        assert_eq!(node_path(), None);
    }

    #[test]
    fn layout_v2_dirs_derive_from_the_two_roots() {
        // Structural contract (ADR 0008): single-level nesting, exact names.
        // Leaf renames break Electron packaging + task arguments — only the
        // parent moves, so these names are pinned.
        assert_eq!(etc_dir(), install_dir().join("etc"));
        assert_eq!(components_dir(), install_dir().join("components"));
        assert_eq!(scripts_dir(), install_dir().join("scripts"));
        assert_eq!(logs_dir(), data_dir().join("logs"));
        assert_eq!(evidence_dir(), data_dir().join("pwout"));
        assert_eq!(config_file(), etc_dir().join("config.yaml"));
        assert_eq!(hostname_file(), etc_dir().join("vale-agent.hostname"));
        assert_eq!(tunnel_file(), etc_dir().join("tunnel.yml"));
        assert_eq!(release_marker_file(), etc_dir().join(".vale-release"));
        assert_eq!(boxed_versions_file(), etc_dir().join("boxed-versions.json"));
        assert_eq!(cloudflared_bin(), components_dir().join("cloudflared.exe"));
        assert_eq!(playwright_dir(), components_dir().join("playwright"));
        assert_eq!(
            desktop_shell_dir(),
            components_dir().join("vale-desktop-electron")
        );
        assert_eq!(agent_log_file(), logs_dir().join("agent.log"));
        assert_eq!(startup_log_file(), logs_dir().join("startup.log"));
        assert_eq!(
            shell_integration_dir(),
            scripts_dir().join("shell-integration")
        );
        assert_eq!(layout_marker_file(), etc_dir().join(".layout-v2"));
    }

    #[test]
    fn migration_pending_tracks_unmoved_paths_only() {
        // A migrated tree (new home present) is not pending even while the
        // emptied old dir lingers; a failed move (old present, new missing)
        // IS pending and keeps the boot marker from being written.
        let base = std::env::temp_dir().join(format!("vale-pending-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let install = base.join("I");
        let data = base.join("D");
        // config.yaml pair: fully migrated (file moved to etc\).
        std::fs::create_dir_all(install.join("etc")).unwrap();
        std::fs::write(install.join("etc").join("config.yaml"), b"x").unwrap();
        assert!(
            !migration_pending(&install, &data),
            "migrated config must not be pending"
        );
        // hostname pair: old exists, new missing -> pending.
        std::fs::write(install.join("vale-agent.hostname"), b"d1").unwrap();
        assert!(
            migration_pending(&install, &data),
            "unmoved hostname must be pending"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn migration_plan_covers_every_moved_path() {
        // The plan is the migration: a moved path missing here stays behind
        // on upgraded devices forever. Pin the full set (files + dirs).
        use std::collections::HashSet;
        let install = std::path::Path::new("I:");
        let data = std::path::Path::new("D:");
        let plan: HashSet<(PathBuf, PathBuf)> =
            migration_moves(install, data).into_iter().collect();
        for (old, new) in [
            ("I:/config.yaml", "I:/etc/config.yaml"),
            ("I:/vale-agent.hostname", "I:/etc/vale-agent.hostname"),
            ("I:/tunnel.yml", "I:/etc/tunnel.yml"),
            ("I:/.vale-release", "I:/etc/.vale-release"),
            ("I:/boxed-versions.json", "I:/etc/boxed-versions.json"),
            ("I:/tools/node", "I:/components/node"),
            ("I:/tools/npm-global", "I:/components/npm-global"),
            ("I:/tools/cloudflared.exe", "I:/components/cloudflared.exe"),
            ("I:/playwright", "I:/components/playwright"),
            (
                "I:/vale-desktop-electron",
                "I:/components/vale-desktop-electron",
            ),
            ("I:/ensure-desktop.ps1", "I:/scripts/ensure-desktop.ps1"),
            ("I:/desktop-pulse.vbs", "I:/scripts/desktop-pulse.vbs"),
            ("I:/start-desktop.ps1", "I:/scripts/start-desktop.ps1"),
            (
                "I:/vale-online-setup.ps1",
                "I:/scripts/vale-online-setup.ps1",
            ),
            ("I:/fix-tunnel.ps1", "I:/scripts/fix-tunnel.ps1"),
            ("I:/playwright/run-hidden.vbs", "I:/scripts/run-hidden.vbs"),
            (
                "I:/playwright/playwright-probe.ps1",
                "I:/scripts/playwright-probe.ps1",
            ),
            ("I:/shell-integration", "I:/scripts/shell-integration"),
            ("I:/installer.log", "D:/logs/installer.log"),
            ("I:/install-result.txt", "D:/logs/install-result.txt"),
            ("I:/vale-update.log", "D:/logs/vale-update.log"),
            ("I:/agent.log", "D:/logs/agent.log"),
            ("I:/startup.log", "D:/logs/startup.log"),
            ("I:/pwout", "D:/pwout"),
        ] {
            assert!(
                plan.contains(&(PathBuf::from(old), PathBuf::from(new))),
                "migration plan missing {old} -> {new}"
            );
        }
    }

    #[test]
    fn move_one_never_clobbers_and_merges_dirs() {
        let base = std::env::temp_dir().join(format!("vale-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // File move.
        std::fs::create_dir_all(base.join("src")).unwrap();
        std::fs::write(base.join("src/a.txt"), b"old").unwrap();
        assert!(move_one(&base.join("src/a.txt"), &base.join("dst/a.txt")));
        assert_eq!(std::fs::read(base.join("dst/a.txt")).unwrap(), b"old");
        // Existing target is never overwritten.
        std::fs::write(base.join("src/b.txt"), b"old").unwrap();
        std::fs::write(base.join("dst/b.txt"), b"new").unwrap();
        assert!(!move_one(&base.join("src/b.txt"), &base.join("dst/b.txt")));
        assert_eq!(std::fs::read(base.join("dst/b.txt")).unwrap(), b"new");
        // Missing source is a no-op.
        assert!(!move_one(
            &base.join("src/nope.txt"),
            &base.join("dst/nope.txt")
        ));
        // Dir merge: existing child kept, missing child moved, source removed.
        std::fs::create_dir_all(base.join("olddir")).unwrap();
        std::fs::create_dir_all(base.join("newdir")).unwrap();
        std::fs::write(base.join("olddir/keep.txt"), b"staged").unwrap();
        std::fs::write(base.join("newdir/keep.txt"), b"live").unwrap();
        std::fs::write(base.join("olddir/extra.txt"), b"x").unwrap();
        assert!(move_one(&base.join("olddir"), &base.join("newdir")));
        assert_eq!(
            std::fs::read(base.join("newdir/keep.txt")).unwrap(),
            b"live"
        );
        assert_eq!(std::fs::read(base.join("newdir/extra.txt")).unwrap(), b"x");
        let _ = std::fs::remove_dir_all(&base);
    }
}
