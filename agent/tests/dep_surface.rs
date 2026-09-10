//! Dependency-surface pins — the HTTP/MCP crates that shape wire behavior.
//!
//! SOLID Round-66 (R46 audit follow-up): `cargo tree` showed TWO reqwest
//! majors in the binary (direct 0.12 + rmcp's transitive 0.13). Unifying
//! them needs product sign-off + device verification, so the dual stack
//! stays — but it must stay VISIBLE. A silent major drift (new reqwest
//! minor line, rmcp 3.x) changes wire behavior the unit suites cannot see
//! (round-300: a floating rmcp 2.x upgrade silently broke auto-select).
//! These pins read Cargo.lock directly (no new deps — line scan only) and
//! fail LOUD on drift, forcing a conscious decision instead of a silent one.
//! Patch bumps never fail: only (major, minor) lines are compared.

use std::collections::BTreeSet;

fn lock_versions(crate_name: &str) -> BTreeSet<(u64, u64)> {
    // Workspace root is agent/ (members [".", "vale-command-core"]).
    let text = std::fs::read_to_string(format!("{}/Cargo.lock", env!("CARGO_MANIFEST_DIR")))
        .expect("workspace Cargo.lock must exist");
    let mut out = BTreeSet::new();
    let mut want_version = false;
    for line in text.lines() {
        let t = line.trim();
        if t == format!("name = \"{crate_name}\"") {
            want_version = true;
            continue;
        }
        if want_version && t.starts_with("version = \"") {
            let v = t.trim_start_matches("version = \"").trim_end_matches('"');
            let mut it = v.split('.').filter_map(|p| p.parse::<u64>().ok());
            if let (Some(major), Some(minor)) = (it.next(), it.next()) {
                out.insert((major, minor));
            }
            want_version = false;
        }
    }
    out
}

#[test]
fn reqwest_dual_stack_stays_visible() {
    // Direct (agent HTTP calls) 0.12 + transitive-via-rmcp 0.13. If this
    // fails, someone changed the HTTP stack — re-read the R46 decision
    // (docs/solid-program.md open threads) before updating this pin.
    assert_eq!(
        lock_versions("reqwest"),
        BTreeSet::from([(0, 12), (0, 13)]),
        "reqwest majors drifted — conscious review required, not a silent bump"
    );
}

#[test]
fn rmcp_stays_on_major_2() {
    // The 2.x JSON shapes are what the agent parses (round-300 lesson).
    // A 3.x line means a new wire contract to review, not a version bump.
    let majors: BTreeSet<u64> = lock_versions("rmcp").into_iter().map(|(m, _)| m).collect();
    assert_eq!(
        majors,
        BTreeSet::from([2]),
        "rmcp major drifted — review wire shapes first"
    );
}
