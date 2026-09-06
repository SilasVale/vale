//! Build script — panel bundle content hash + panel-first staleness gate.
//!
//! Two jobs, both driven by the panel SPA sources (no new dependencies —
//! pure std, so the Windows xwin cross-compile needs nothing extra):
//!
//! 1. PANEL_BUNDLE_HASH: FNV-1a-64 over `resources/panel/panel.js` +
//!    `panel.css`, exposed as a compile-time env var. `web/panel.rs`
//!    stamps `?v=<hash>` on the bundle URLs, so every panel rebuild gets a
//!    distinct cache key. (The previous key was `env!("CARGO_PKG_VERSION")`
//!    = the Cargo crate version, frozen at 1.0.x while the npm release rides
//!    1.2.x — Cloudflare's 4h Browser-Cache-TTL override for .js/.css kept
//!    serving the PREVIOUS panel for hours after an update.)
//!    FNV-1a is a cache key, NOT an integrity proof — no security property
//!    rides on it, so a non-cryptographic hash is the right tool.
//!
//! 2. STALENESS GATE (panel-first enforcement): `resources/panel/` holds
//!    COMMITTED vite build output (`vite outDir` overwrites it in place),
//!    so a `panel-react/src` edit without a rebuild silently ships the stale
//!    bundle (panel.js is `include_str!`'d at compile time). If the newest
//!    file under `resources/panel-react/src` is newer than the built
//!    products, the build FAILS with the rebuild command — fail loud, not
//!    stale. The gate only fires on genuine drift (see STALENESS_GRACE_SECS),
//!    never on a clean checkout, so `cargo test` stays green by default.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Fresh-checkout skew grace: a clean `git clone` writes every file within
/// seconds, and checkout order across directories is not contractual, so a
/// zero threshold could fail a pristine tree (measured 2026-09-06: the
/// committed products lag the newest src file by only ~11s even when the
/// tree is CONSISTENT — the vite build itself spans ~90s). Real drift (an
/// src edit followed by a build that skipped the panel rebuild) is minutes
/// to days. 120s clears both without letting real drift through, except a
/// sub-2-minute edit→build sprint with no panel rebuild — documented,
/// accepted: the gate is a safety net, not a proof.
const STALENESS_GRACE_SECS: u64 = 120;

/// Products the gate + hash cover: the two `?v=`-stamped bundles. index.html
/// is the host page (rewritten with the hash at serve time); the vendor/
/// third-party files carry no `?v=` and change with the bundle rebuild.
const PRODUCT_FILES: [&str; 2] = ["panel.js", "panel.css"];

fn main() {
    let manifest = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR set by cargo"),
    );
    let panel_dir = manifest.join("resources/panel");
    let src_dir = manifest.join("resources/panel-react/src");

    // Pin rebuild triggers: the default (no directive) reruns on ANY package
    // file change; these narrow it to what this script actually reads.
    println!("cargo:rerun-if-changed=resources/panel/panel.js");
    println!("cargo:rerun-if-changed=resources/panel/panel.css");
    println!("cargo:rerun-if-changed=resources/panel-react/src");

    staleness_gate(&panel_dir, &src_dir);

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a-64 offset basis
    for name in PRODUCT_FILES {
        let bytes = std::fs::read(panel_dir.join(name)).unwrap_or_else(|e| {
            panic!(
                "vale-agent build: resources/panel/{name} unreadable ({e}) — \
                 run the panel build first: `cd agent/resources/panel-react && npm run build` \
                 (or `./scripts/build.sh agent` from the repo root)"
            )
        });
        hash = fnv1a64(&bytes, hash);
    }
    println!("cargo:rustc-env=PANEL_BUNDLE_HASH={hash:016x}");
}

/// Fail the build when the React sources are newer than the committed build
/// output (drift = a rebuild was skipped). Skips silently when the src tree
/// is absent (sparse checkout — nothing to judge); missing products are left
/// to the hash step / `include_str!` errors above, which already name the fix.
fn staleness_gate(panel_dir: &Path, src_dir: &Path) {
    let Ok((newest_src_path, newest_src_mtime)) = newest_mtime(src_dir) else {
        println!("cargo:warning=vale-agent build: resources/panel-react/src not found — skipping panel staleness gate");
        return;
    };
    let mut newest_product_mtime: Option<SystemTime> = None;
    for name in PRODUCT_FILES {
        match std::fs::metadata(panel_dir.join(name)).and_then(|m| m.modified()) {
            Ok(t) => {
                newest_product_mtime =
                    Some(newest_product_mtime.map_or(t, |prev: SystemTime| prev.max(t)))
            }
            Err(_) => return, // missing product: the hash step fails with the fix
        }
    }
    let newest_product_mtime = match newest_product_mtime {
        Some(t) => t,
        None => return,
    };
    let drift = newest_src_mtime
        .duration_since(newest_product_mtime)
        .unwrap_or_default();
    if drift.as_secs() > STALENESS_GRACE_SECS {
        panic!(
            "vale-agent build: STALE panel bundle — resources/panel-react/src is newer than \
             resources/panel/ by {}s (newest source: {}, products predate it). \
             panel.js is embedded at compile time, so this build would ship the OLD panel. \
             Rebuild first: `cd agent/resources/panel-react && npm run build` \
             (or `./scripts/build.sh agent` from the repo root), then rerun cargo.",
            drift.as_secs(),
            newest_src_path.display()
        );
    }
}

/// Newest mtime under `dir` (recursive), with the winning path for the error
/// message. Err when the dir cannot be walked at all.
fn newest_mtime(dir: &Path) -> std::io::Result<(PathBuf, SystemTime)> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    let mut stack = vec![dir.to_path_buf()];
    let mut seen_any = false;
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d)? {
            seen_any = true;
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                let mtime = entry.metadata()?.modified()?;
                let replace = best.as_ref().is_none_or(|(_, t)| mtime > *t);
                if replace {
                    best = Some((path, mtime));
                }
            }
        }
    }
    if !seen_any {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "empty src dir",
        ));
    }
    best.ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no files"))
}

/// FNV-1a-64 fold (chained across files by threading the state through).
fn fnv1a64(bytes: &[u8], mut hash: u64) -> u64 {
    const PRIME: u64 = 0x0000_0100_0000_01B3;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}
