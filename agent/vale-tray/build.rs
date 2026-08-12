//! Derive the shipped vale-agent version from the workspace manifest
//! (`../Cargo.toml` → `[workspace.package] version`) so the tray's
//! LOCAL_VERSION can never drift from agent/Cargo.toml again. A drift used
//! to cause an hourly reinstall loop: a stale LOCAL_VERSION made the tray
//! see remote > local on every auto-check and re-run the silent installer
//! every hour (killing the agent each time).

use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../Cargo.toml");
    let text = fs::read_to_string(&manifest)
        .expect("read ../Cargo.toml for the vale-agent version");
    let version = text
        .lines()
        .skip_while(|l| l.trim() != "[workspace.package]")
        .find_map(|l| l.trim().strip_prefix("version = "))
        .map(|v| v.trim().trim_matches('"').to_string())
        .expect("[workspace.package] version missing in ../Cargo.toml");
    println!("cargo:rustc-env=VALE_AGENT_VERSION={version}");
    println!("cargo:rerun-if-changed=../Cargo.toml");
}
