//! The BOOT PATH must not be able to panic (SOLID R110).
//!
//! `migrate_layout_v2()` is called FIRST in `main()` — before tracing is
//! initialized, before the service registers, before anything can be logged.
//! A panic there does not produce a crash report; it produces a device that
//! never starts and leaves no evidence, which is exactly the 1.2.223
//! dark-device class this repo has already paid for once.
//!
//! Every step of that path documents the same promise in its own words:
//! `migrate_layout_v2` says "Never fails the boot", `main()` says "never
//! fatal", `AppState::new` has no fallible construction. But those were
//! prose, and prose does not fail a build. This suite turns the promise into
//! a gate: the source of the boot path may not contain an explicit panic
//! surface outside its test modules.
//!
//! WHAT THIS DOES NOT COVER — stated plainly, because a green check should
//! not be read as more than it is:
//!   * it is a LINE SCAN, not a proof. It misses panics reached indirectly
//!     (a slicing index, an arithmetic overflow in debug, a `RefCell`
//!     double-borrow, a panic inside a dependency).
//!   * it strips line comments but not block comments or string literals, so
//!     a panic family token inside a multi-line comment or a string would be
//!     reported as a false positive. That direction is deliberate: a false
//!     positive costs a comment edit, a false negative costs a dark device.
//!   * it covers the files listed in BOOT_PATH below. A new module that runs
//!     during boot must be added there by hand — the list is the contract.

use std::path::Path;

/// The modules that execute on the boot path, in the order they run.
///
/// Deliberately NOT "every file in src/": the HTTP/plugin layer runs only
/// once the process is up and logging, where a panic is recoverable (rmcp's
/// catch_unwind maps a tool panic to an isError) and is covered by other
/// gates. Narrowing to the boot path is what makes this list maintainable.
const BOOT_PATH: &[&str] = &[
    "src/main.rs",      // main(), tracing init, service dispatch
    "src/winmain.rs",   // child-reaper job, SCM service, self-heal, tunnel supervisor
    "src/paths.rs",     // layout-v2 migration — the FIRST thing that runs
    "src/filelog.rs",   // the log writer init_tracing installs
    "src/bootstrap.rs", // config load / token minting
    "src/state.rs",     // AppState::new, built before the listener binds
];

/// The explicit panic family. `unwrap_or*` is excluded by requiring the
/// closing paren directly after `unwrap`.
const PANIC_FAMILY: &[&str] = &[
    ".unwrap()",
    ".expect(",
    "panic!(",
    "unreachable!(",
    "todo!(",
    "unimplemented!(",
    "assert!(",
    "assert_eq!(",
    "assert_ne!(",
    "debug_assert",
];

/// Net brace count on a line, IGNORING braces inside string literals, char
/// literals and line comments.
///
/// Necessary rather than pedantic: the test modules this has to skip contain
/// `format!("{{{{{{ broken\n…")` — brace-shaped text inside strings. Counting
/// raw braces ends the skip region early, the rest of the test module gets
/// scanned as if it were production, and the gate reports false positives
/// (which would make it useless and get it deleted).
fn brace_delta(line: &str) -> i32 {
    let b = line.as_bytes();
    let mut i = 0usize;
    let mut d = 0i32;
    while i < b.len() {
        match b[i] {
            // Line comment: nothing after it counts.
            b'/' if i + 1 < b.len() && b[i + 1] == b'/' => break,
            // Raw string: r"…" / r#"…"# / r##"…"##
            b'r' if i + 1 < b.len() && (b[i + 1] == b'"' || b[i + 1] == b'#') => {
                let mut j = i + 1;
                let mut hashes = 0usize;
                while j < b.len() && b[j] == b'#' {
                    hashes += 1;
                    j += 1;
                }
                if j < b.len() && b[j] == b'"' {
                    j += 1;
                    loop {
                        if j >= b.len() {
                            break;
                        }
                        if b[j] == b'"' {
                            let mut k = j + 1;
                            let mut seen = 0usize;
                            while k < b.len() && b[k] == b'#' && seen < hashes {
                                seen += 1;
                                k += 1;
                            }
                            if seen == hashes {
                                j = k;
                                break;
                            }
                        }
                        j += 1;
                    }
                    i = j;
                    continue;
                }
                i += 1;
            }
            // Normal string (or char literal): skip to the closing quote.
            b'"' | b'\'' => {
                let quote = b[i];
                i += 1;
                while i < b.len() {
                    if b[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if b[i] == quote {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'{' => {
                d += 1;
                i += 1;
            }
            b'}' => {
                d -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    d
}

/// Blank out every test-gated item, PRESERVING line count so reported line
/// numbers still point at the real file.
///
/// Test code is EXEMPT on purpose: `unwrap()` in a test is an assertion, and
/// several test helpers here legitimately `expect("valid test sid")`.
///
/// This must be brace-aware rather than "cut at the first `#[cfg(test)]`":
/// `paths.rs` gates one test module with `#[cfg(all(test, unix))]` and a
/// second with plain `#[cfg(test)]`, and a naive truncation would either miss
/// the first (false positives on real test code) or, if production code ever
/// followed a test module, silently stop scanning (false NEGATIVES — the
/// dangerous direction for this gate).
fn strip_test_items(src: &str) -> String {
    let is_test_attr = |l: &str| {
        let t = l.trim();
        t.starts_with("#[cfg(") && t.contains("test")
    };
    let mut lines: Vec<String> = src.lines().map(|l| l.to_string()).collect();
    let mut i = 0;
    while i < lines.len() {
        if !is_test_attr(&lines[i]) {
            i += 1;
            continue;
        }
        // Find what the attribute decorates: a `;` item ends immediately, a
        // `{` item runs until its matching close. Doc/attribute lines between
        // are part of the item and get blanked with it.
        let mut j = i + 1;
        let mut opener = None;
        while j < lines.len() {
            let t = lines[j].trim();
            if t.is_empty() || t.starts_with("//") || t.starts_with("#[") {
                j += 1;
                continue;
            }
            opener = Some(t.contains('{'));
            break;
        }
        let Some(has_brace) = opener else { break };
        if !has_brace {
            // `#[cfg(test)] use …;` — one line's worth.
            for l in lines.iter_mut().take(j + 1).skip(i) {
                l.clear();
            }
            i = j + 1;
            continue;
        }
        // Brace-match from the opening line, counting only REAL braces.
        let mut depth: i32 = 0;
        let mut end = j;
        let mut k = j;
        while k < lines.len() {
            depth += brace_delta(&lines[k]);
            if depth <= 0 {
                end = k;
                break;
            }
            k += 1;
        }
        for l in lines.iter_mut().take(end + 1).skip(i) {
            l.clear();
        }
        i = end + 1;
    }
    lines.join("\n")
}

/// One file's offending lines: (line number, trimmed text).
fn panic_lines(path: &Path) -> Vec<(usize, String)> {
    let src = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("boot-path file {} must be readable: {e}", path.display()));
    let scanned = strip_test_items(&src);
    let mut out = Vec::new();
    for (i, line) in scanned.lines().enumerate() {
        let code = match line.find("//") {
            Some(c) => &line[..c],
            None => line,
        };
        if PANIC_FAMILY.iter().any(|p| code.contains(p)) {
            out.push((i + 1, code.trim().to_string()));
        }
    }
    out
}

fn manifest_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn boot_path_has_no_panic_surface() {
    let root = manifest_dir();
    let mut offences = Vec::new();
    for rel in BOOT_PATH {
        let path = root.join(rel);
        assert!(
            path.exists(),
            "BOOT_PATH lists {rel}, which does not exist — update the list rather than \
             letting a renamed module drop out of the gate"
        );
        for (line, text) in panic_lines(&path) {
            offences.push(format!("{rel}:{line}: {text}"));
        }
    }
    assert!(
        offences.is_empty(),
        "the boot path must not be able to panic — it runs before logging, so a panic \
         here is a device that never starts and leaves no evidence:\n  {}",
        offences.join("\n  ")
    );
}

/// The gate is only real if the list is the whole boot path, so pin the
/// files that the boot sequence is KNOWN to touch. If a future round moves
/// boot logic into a new module, this fails and the author must decide
/// whether that module belongs under the same promise.
#[test]
fn boot_path_list_covers_the_known_boot_sequence() {
    for required in [
        "src/main.rs",
        "src/paths.rs",
        "src/bootstrap.rs",
        "src/state.rs",
    ] {
        assert!(
            BOOT_PATH.contains(&required),
            "{required} is part of the boot sequence and must stay in BOOT_PATH"
        );
    }
    // main() really does call the migration FIRST — if that stops being true
    // this gate is guarding the wrong thing, and the file it moved to must
    // join BOOT_PATH.
    let main_src = std::fs::read_to_string(manifest_dir().join("src/main.rs")).expect("main.rs");
    let first_call = main_src
        .lines()
        .position(|l| l.contains("migrate_layout_v2()"))
        .expect("main() must still run the layout migration");
    let tracing_init = main_src
        .lines()
        .position(|l| l.trim() == "init_tracing();")
        .expect("main() must still initialise tracing");
    assert!(
        first_call < tracing_init,
        "the migration must run BEFORE tracing init (that ordering is why this \
         whole suite exists — a panic before init_tracing leaves no log)"
    );
}

#[test]
fn the_scan_actually_detects_a_planted_panic() {
    // A gate that cannot fail is not a gate. Prove the detector fires on the
    // exact family it exists for, including the `unwrap_or*` lookalikes it
    // must NOT treat as panics.
    let sample = "\
fn a() { let x = foo().unwrap(); }
fn b() { let x = foo().expect(\"boom\"); }
fn c() { panic!(\"no\"); }
fn d() { let x = foo().unwrap_or(1); }
fn e() { let x = foo().unwrap_or_else(|_| 2); }
fn f() { let x = foo().unwrap_or_default(); }
// .unwrap() in a comment must not count
";
    let dir = std::env::temp_dir().join(format!("vale-bootscan-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let probe = dir.join("probe.rs");
    std::fs::write(&probe, sample).expect("write probe");

    let hits = panic_lines(&probe);
    let lines: Vec<usize> = hits.iter().map(|(l, _)| *l).collect();
    assert_eq!(
        lines,
        vec![1, 2, 3],
        "must flag unwrap/expect/panic! and ignore unwrap_or* + comments; got {hits:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_modules_are_exempt_from_the_scan() {
    // Test helpers legitimately `.expect()` (and failing loudly IS the point
    // of a test), so a test module must not trip the gate — in BOTH spellings
    // this crate uses, and with production code AFTER one of them (the case a
    // naive "cut at the first #[cfg(test)]" would silently stop scanning at).
    let sample = "\
fn prod() { let x = safe(); }
#[cfg(all(test, unix))]
mod harden_tests {
    #[test]
    fn t() { let x = foo().unwrap(); }
}
fn more_prod() { let y = safe(); }
#[cfg(test)]
mod tests {
    fn helper() { let z = bar().expect(\"boom\"); }
}
";
    assert!(
        strip_test_items(sample).contains("more_prod"),
        "production code after a test module must still be scanned"
    );
    let dir = std::env::temp_dir().join(format!("vale-bootscan-t-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let probe = dir.join("probe.rs");
    std::fs::write(&probe, sample).expect("write probe");
    assert!(
        panic_lines(&probe).is_empty(),
        "test-gated modules must be exempt: {:?}",
        panic_lines(&probe)
    );

    // ...and a panic in that AFTER-test production code must still be caught.
    let planted = sample.replace(
        "fn more_prod() { let y = safe(); }",
        "fn more_prod() { let y = safe().unwrap(); }",
    );
    std::fs::write(&probe, planted).expect("write probe");
    let hits = panic_lines(&probe);
    assert_eq!(
        hits.iter().map(|(l, _)| *l).collect::<Vec<_>>(),
        vec![7],
        "a panic after a test module must be found; got {hits:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn strip_preserves_line_numbers() {
    // Reported line numbers are useless if stripping shifts them.
    let src = "fn a() {}\n#[cfg(test)]\nmod t {\n    fn x() {}\n}\nfn b() {}\n";
    let stripped = strip_test_items(src);
    assert_eq!(stripped.lines().count(), src.lines().count());
    let b_line = stripped
        .lines()
        .position(|l| l.contains("fn b()"))
        .expect("b survives");
    assert_eq!(b_line, 5, "fn b() must keep its original line number");
}
