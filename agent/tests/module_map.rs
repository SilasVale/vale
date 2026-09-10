//! The MODULE MAP must describe the tree it claims to describe (SOLID R114).
//!
//! `agent/AGENTS.md` and `agent/CLAUDE.md` both open with a module map, and
//! that map is the first thing a new agent (or human) reads to find out where
//! anything lives. It had silently rotted: FIVE real `src/` modules were
//! missing from it — `text.rs` and `jsonl.rs` (added by SOLID R105/R111,
//! i.e. by this very program) plus `register.rs`, `tunnel.rs` and
//! `winmain.rs`. Nothing failed, because prose does not fail a build. Worse,
//! the two files are required to stay in sync and had drifted identically,
//! so "compare AGENTS.md with CLAUDE.md" would not have caught it either.
//!
//! This suite turns the map into a CHECKED claim:
//!   * every non-test `.rs` module under `src/` is named in the map;
//!   * the map names no module that no longer exists;
//!   * AGENTS.md and CLAUDE.md agree on the SET of modules they document.
//!
//! WHAT THIS DOES NOT CHECK, stated so a green result is not overread: it
//! checks NAMES, not accuracy. A map entry can exist and still describe the
//! wrong thing. That part stays a human/agent reading job — but "the module
//! is not mentioned at all" is the failure mode that actually happened, and
//! it is now impossible.
//!
//! When this fails, the fix is to edit the map — never to loosen the test.
//! Adding a module IS a map change, exactly like adding a tool is a
//! tool-count change.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn agent_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Module names the map is EXPECTED to mention, discovered from the tree.
///
/// Top-level `src/*.rs` (minus `lib.rs`/`main.rs`, which are crate scaffolding
/// rather than feature modules) plus the entry files of the top-level module
/// directories. `src/tools/` and `src/plugins/` are documented as one line
/// each, so only their directory name is required.
fn modules_in_tree() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let src = agent_dir().join("src");
    let entries = std::fs::read_dir(&src).expect("src/ must be readable");
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            out.insert(name);
            continue;
        }
        let Some(stem) = name.strip_suffix(".rs") else {
            continue;
        };
        // `lib.rs`/`main.rs` ARE documented as entries, so they are part of
        // the expected set like any other module (excluding them here would
        // make them permanently "stale").
        // `mod.rs`-style files are covered by their directory entry instead.
        if stem != "mod" {
            out.insert(stem.to_string());
        }
    }
    out
}

/// The module map block from a guide file, as raw text.
fn module_map_block(path: &Path) -> String {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{} must be readable: {e}", path.display()));
    let start = text.find("### Module map").unwrap_or_else(|| {
        panic!(
            "{} must still have a `### Module map` section",
            path.display()
        )
    });
    let after = &text[start..];
    let open = after.find("```").expect("the map must be a fenced block") + 3;
    let rest = &after[open..];
    let close = rest
        .find("```")
        .expect("the map's fenced block must be closed");
    rest[..close].to_string()
}

/// Is this token an ENTRY NAME (as opposed to prose)?
///
/// The map's real shape is:
///
/// ```text
/// src/
///   main.rs          server binary (…)
///                    continuation prose, aligned under the description
///   mcp/server.rs    DeviceServer …
/// vale-command-core/ Plugin/ToolDef/…
/// ```
///
/// So entries are INDENTED, and continuation lines are indented further.
/// Indentation cannot separate them — the distinguishing feature is the token
/// SHAPE: an entry is a `mod.rs`-style path made of lowercase identifier
/// segments, ending in `.rs` or `/` (`text.rs`, `plugins/`, `mcp/server.rs`).
/// Prose lines start with a capital, a bracket, or a word with no such
/// suffix. This was learned the hard way: a column-0 rule reported every real
/// entry as missing.
fn is_entry_token(tok: &str) -> bool {
    if !(tok.ends_with(".rs") || tok.ends_with('/')) {
        return false;
    }
    let body = tok.trim_end_matches('/');
    let body = body.strip_suffix(".rs").unwrap_or(body);
    if body.is_empty() {
        return false;
    }
    body.split('/').all(|seg| {
        !seg.is_empty()
            && seg.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
            && seg
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    })
}

/// The map ENTRY's top-level module name — `mcp/server.rs` → `mcp`,
/// `text.rs` → `text`, `plugins/` → `plugins`.
fn entry_module(tok: &str) -> Option<String> {
    if !is_entry_token(tok) {
        return None;
    }
    let first = tok.split('/').next()?;
    Some(first.trim_end_matches(".rs").to_string())
}

/// Module name → is it mentioned as a map ENTRY?
///
/// Requiring the ENTRY position — rather than a bare substring anywhere in
/// the block — is what makes this check meaningful: `text.rs` appearing only
/// inside some other entry's prose would not count as documented.
fn documented_modules(block: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for line in block.lines() {
        let t = line.trim_start();
        if t.starts_with("//") || t.is_empty() {
            continue;
        }
        // The description column separates them: an ENTRY is followed by a
        // run of TWO OR MORE spaces before its description; a continuation
        // line's first token is followed by a single space (and a bare
        // directory header like `src/` has no description at all). This is
        // the rule that finally separated `plugins/` from the wrapped
        // `mod.rs (plugin struct …` beneath it.
        let tok = t.split_whitespace().next().unwrap_or("");
        let gap = t[tok.len()..].len() - t[tok.len()..].trim_start().len();
        if gap < 2 {
            continue;
        }
        if let Some(m) = entry_module(tok) {
            out.insert(m);
        }
    }
    out
}

/// Entries the map legitimately carries that are NOT modules of `agent/src/`.
/// Explicit and auditable — this is the only escape hatch, so a deleted
/// module cannot silently survive as a "documented" one.
const DOCUMENTED_NON_SRC_ENTRIES: &[&str] = &[
    // A sibling crate in the same workspace, documented here on purpose.
    "vale-command-core",
];

#[test]
fn every_src_module_is_named_in_the_module_map() {
    let tree = modules_in_tree();
    let mut missing = Vec::new();
    for guide in ["AGENTS.md", "CLAUDE.md"] {
        let path = agent_dir().join(guide);
        let documented = documented_modules(&module_map_block(&path));
        for m in &tree {
            if !documented.contains(m) {
                missing.push(format!("{guide}: {m}"));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "every module under agent/src/ must appear as an entry in the module \
         map of BOTH agent/AGENTS.md and agent/CLAUDE.md — a guide that does \
         not describe the tree sends readers to the wrong place, and prose \
         does not fail a build:\n  {}",
        missing.join("\n  ")
    );
}

#[test]
fn the_module_map_names_no_module_that_no_longer_exists() {
    // The other direction: a map that lists a DELETED module is just as
    // misleading, and this repo has deleted real trees before (vale-tray,
    // vale-desktop). Only entry-shaped names are judged, and the sole
    // non-src entry is allowlisted explicitly above.
    let tree = modules_in_tree();
    let mut stale = Vec::new();
    for guide in ["AGENTS.md", "CLAUDE.md"] {
        let path = agent_dir().join(guide);
        for m in documented_modules(&module_map_block(&path)) {
            if !tree.contains(&m) && !DOCUMENTED_NON_SRC_ENTRIES.contains(&m.as_str()) {
                stale.push(format!("{guide}: {m}"));
            }
        }
    }
    assert!(
        stale.is_empty(),
        "the module map names modules that are not in agent/src/ — remove them, \
         or add them to DOCUMENTED_NON_SRC_ENTRIES with a reason:\n  {}",
        stale.join("\n  ")
    );
}

#[test]
fn both_guides_document_the_same_module_set() {
    // The two guides are required to stay in sync. They had drifted
    // IDENTICALLY (both missing the same five modules), which is exactly the
    // case a direct comparison would have missed — so this checks each
    // against the TREE, and this test additionally catches one-sided edits.
    let a = documented_modules(&module_map_block(&agent_dir().join("AGENTS.md")));
    let c = documented_modules(&module_map_block(&agent_dir().join("CLAUDE.md")));
    let only_a: Vec<_> = a.difference(&c).cloned().collect();
    let only_c: Vec<_> = c.difference(&a).cloned().collect();
    assert!(
        only_a.is_empty() && only_c.is_empty(),
        "agent/AGENTS.md and agent/CLAUDE.md must document the same modules.\n  \
         only in AGENTS.md: {only_a:?}\n  only in CLAUDE.md: {only_c:?}"
    );
}

#[test]
fn the_check_actually_detects_an_undocumented_module() {
    // A gate that cannot fail is not a gate — prove the detector fires on the
    // exact shape that rotted here (a real module absent from the map), using
    // the map's REAL indentation so this cannot pass on a parser that only
    // works for a shape nobody writes.
    let block = "\
src/
  main.rs          server binary
  paths.rs         path resolution
";
    let documented = documented_modules(block);
    assert!(documented.contains("paths"), "{documented:?}");
    assert!(documented.contains("main"), "{documented:?}");
    assert!(
        !documented.contains("jsonl"),
        "a module absent from the map must NOT be reported as documented"
    );

    // ...and a name appearing only in another entry's PROSE does not count,
    // which is what makes this an entry check rather than a grep.
    let prose_only = "\
src/
  session_log.rs   per-session JSONL audit log; hygiene lives in jsonl.rs
";
    let d = documented_modules(prose_only);
    assert!(d.contains("session_log"), "{d:?}");
    assert!(
        !d.contains("jsonl"),
        "a mention inside another entry's prose is not a documented module"
    );

    // Continuation lines must not be mistaken for entries: they are indented
    // DEEPER than entries and start with prose. (A column-based rule broke
    // exactly here.)
    let wrapped = "\
src/
  plugins/         PluginRegistry (tools cached once at register); terminal/
                   mod.rs (plugin struct + shared helpers) + tools/ (ctx.rs =
                   ToolCtx, the shared runtime state builders take)
";
    let d = documented_modules(wrapped);
    assert_eq!(
        d,
        ["plugins".to_string()].into_iter().collect(),
        "only the entry itself counts; wrapped prose is not an entry: {d:?}"
    );

    // And the token-shape rule rejects the shapes that actually appear as
    // prose in this map.
    for prose in ["(vale-tray/", "mode", "PluginRegistry", "config_path)"] {
        assert!(
            entry_module(prose).is_none(),
            "{prose:?} is prose, not an entry name"
        );
    }
    // ...while accepting all three real entry forms.
    assert_eq!(entry_module("text.rs").as_deref(), Some("text"));
    assert_eq!(entry_module("plugins/").as_deref(), Some("plugins"));
    assert_eq!(entry_module("mcp/server.rs").as_deref(), Some("mcp"));
}
