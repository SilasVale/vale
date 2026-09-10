//! Append-only JSONL hygiene — the crash-safety rules every append-only,
//! line-oriented file in this crate shares (SOLID R111).
//!
//! Two files are written this way: the per-session audit trail
//! (`<sid>.jsonl`, `session_log.rs`) and the device memory store
//! (`memory.jsonl`, `plugins/memory/store.rs`). Both are opened
//! `create + append` and hold one JSON object per line. Both had grown their
//! own copy of the same two rules, and both documented the same incident in
//! prose:
//!
//!   * an EMPTY file starts with a version header, so a reader can tell a
//!     fresh store from a truncated one (session_log round-56);
//!   * a crash mid-`writeln` leaves a fragment WITHOUT its trailing newline —
//!     a line past the 8 KiB `BufWriter` split is written in more than one
//!     syscall, so the kill can land between them. The next append then FUSES
//!     onto that fragment and the two become one unparseable record. In the
//!     audit trail the fused pair once swallowed the "interrupted" recovery
//!     marker, so a command that crashed read back as FINISHED.
//!
//! [`prepare_append`] is both rules. It takes the caller's already-open append
//! handle plus the path, because an append-mode handle cannot be read back to
//! inspect the last byte — every caller opens its own way (one wraps the File
//! in a `BufWriter`, one writes through the File directly) and that choice
//! stays theirs.

use serde_json::Value;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Does this file end MID-LINE (a torn final write)?
///
/// `false` for a file that is empty or missing: there is no fragment to fuse
/// onto, which is how both call sites already treated that case. `Err` is
/// reserved for a file that exists and cannot be inspected.
pub(crate) fn has_torn_tail(path: &Path) -> std::io::Result<bool> {
    let mut f = std::fs::File::open(path)?;
    if f.metadata()?.len() == 0 {
        return Ok(false);
    }
    f.seek(SeekFrom::End(-1))?;
    let mut b = [0u8; 1];
    f.read_exact(&mut b)?;
    Ok(b[0] != b'\n')
}

/// Ready an append-only JSONL file for its next record.
///
/// Writes `header` when the file is empty; otherwise terminates a torn final
/// line so the record about to be appended cannot fuse onto it. Best-effort by
/// convention — both callers discard the result, because a log or store write
/// must never surface as a tool failure.
pub(crate) fn prepare_append(
    file: &mut std::fs::File,
    path: &Path,
    header: &Value,
) -> std::io::Result<()> {
    if file.metadata()?.len() == 0 {
        // Fresh file: the version header goes first.
        return writeln!(file, "{header}");
    }
    if has_torn_tail(path)? {
        file.write_all(b"\n")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("vale-jsonl-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("log.jsonl")
    }

    fn append_handle(path: &Path) -> std::fs::File {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("append handle")
    }

    #[test]
    fn torn_tail_is_false_for_clean_empty_and_missing_files() {
        let p = tmp("clean");
        std::fs::write(&p, "{\"a\":1}\n{\"b\":2}\n").expect("seed");
        assert!(!has_torn_tail(&p).expect("readable"));

        // Empty: nothing to fuse onto, so not torn.
        let e = tmp("empty");
        std::fs::write(&e, b"").expect("seed");
        assert!(!has_torn_tail(&e).expect("readable"));

        // Missing: an error, not a silent `false` — the caller decides.
        let m = tmp("missing");
        assert!(has_torn_tail(&m).is_err());
    }

    #[test]
    fn torn_tail_is_true_for_a_fragment_without_newline() {
        // THE incident: a crash mid-writeln leaves a partial line.
        let p = tmp("torn");
        std::fs::write(&p, "{\"a\":1}\n{\"b\":").expect("seed");
        assert!(has_torn_tail(&p).expect("readable"));
    }

    #[test]
    fn prepare_append_writes_the_header_into_an_empty_file() {
        let p = tmp("header");
        let header = serde_json::json!({"type": "memory", "version": 1});
        let mut f = append_handle(&p);
        prepare_append(&mut f, &p, &header).expect("prepare");
        drop(f);
        assert_eq!(
            std::fs::read_to_string(&p).expect("read"),
            format!("{header}\n"),
            "a fresh file starts with exactly the header line"
        );
    }

    #[test]
    fn prepare_append_terminates_a_torn_line_and_touches_nothing_else() {
        let p = tmp("repair");
        std::fs::write(&p, "{\"a\":1}\n{\"b\":").expect("seed");
        let before = std::fs::read(&p).expect("read");
        let mut f = append_handle(&p);
        prepare_append(&mut f, &p, &serde_json::json!({"unused": true})).expect("prepare");
        // The record the caller appends next must land on its OWN line.
        writeln!(f, "{{\"c\":3}}").expect("append");
        drop(f);

        let after = std::fs::read_to_string(&p).expect("read");
        assert_eq!(
            after, "{\"a\":1}\n{\"b\":\n{\"c\":3}\n",
            "the fragment is terminated, not repaired or deleted"
        );
        assert_eq!(
            &std::fs::read(&p).expect("read")[..before.len()],
            &before[..],
            "existing bytes are untouched — the newline is APPENDED"
        );
        // ...and no header was written into a non-empty file.
        assert!(!after.contains("unused"));
    }

    #[test]
    fn prepare_append_leaves_a_clean_file_alone() {
        let p = tmp("noop");
        let seed = "{\"a\":1}\n";
        std::fs::write(&p, seed).expect("seed");
        let mut f = append_handle(&p);
        prepare_append(&mut f, &p, &serde_json::json!({"unused": true})).expect("prepare");
        drop(f);
        assert_eq!(
            std::fs::read_to_string(&p).expect("read"),
            seed,
            "nothing is written when the file is already well-formed"
        );
    }

    #[test]
    fn prepare_append_survives_a_single_byte_file() {
        // Boundary: len == 1 exercises `SeekFrom::End(-1)` at its minimum.
        for (tag, seed, expect) in [
            ("one-char-torn", "x", "x\n"),
            ("one-char-clean", "\n", "\n"),
        ] {
            let p = tmp(tag);
            std::fs::write(&p, seed).expect("seed");
            let mut f = append_handle(&p);
            prepare_append(&mut f, &p, &serde_json::json!({"unused": true})).expect("prepare");
            drop(f);
            assert_eq!(std::fs::read_to_string(&p).expect("read"), expect, "{tag}");
        }
    }
}
