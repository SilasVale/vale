//! Append-only JSONL hygiene — the crash-safety rules every append-only,
//! line-oriented file in this crate shares (SOLID R111).
//!
//! FOUR files are written this way: the per-session audit trail
//! (`<sid>.jsonl`, `session_log.rs`), the device memory store
//! (`memory.jsonl`, `plugins/memory/store.rs`), the AI-evidence feed
//! (`actions.jsonl`, `evidence.rs`) and the run-identity log
//! (`runs.jsonl`, `runs.rs`). This header used to name only the first two
//! while claiming "every … file in this crate", which is the shape this repo
//! keeps finding: a sentence that describes a rule the code has not finished
//! applying. It is accurate now because the family is.
//!
//! Both are opened
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

/// Read an append-only JSONL file as TEXT, tolerating damage.
///
/// THE RULE THIS PROJECT KEPT RE-LEARNING, now stated once. `read_to_string`
/// requires the WHOLE file to be valid UTF-8, and the tear a crash actually
/// leaves — a multi-byte character cut in half — is INVALID UTF-8. So a strict
/// read does not degrade gracefully; it rejects every record in the file,
/// including the ones that are perfectly intact.
///
/// That is not hypothetical here. It was found first in the memory store, fixed
/// for the audit trail's list reader, then found AGAIN in the SAME audit file
/// through a different function whose three callers silently lost the recovery
/// arm, the detail route and the seq seed. Each fix was local; the family was
/// never finished. This is the family's owner.
///
/// Callers get bytes decoded lossily, so a damaged line becomes a line that does
/// not PARSE — which every reader in this family already skips — instead of a
/// file that cannot be READ. `None` means the file is missing or unopenable,
/// which is a different fact from "it held nothing usable".
pub(crate) fn read_lossy(path: &Path) -> Option<String> {
    let raw = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&raw).into_owned())
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

/// Replace `path`'s contents with `body` ATOMICALLY: write a sibling temp
/// file, flush + `sync_all`, then rename over the original.
///
/// This is the rewrite half of the same crash-safety concern
/// [`prepare_append`] owns for appends. `File::create` truncates IN PLACE, so
/// a crash (Windows service kill, power loss) between truncate and rewrite
/// loses the whole file; a temp file plus rename is atomic on both platforms,
/// so a reader sees the old file or the new one and never a half-written one.
///
/// THE PRECONDITION IS THE WHOLE LESSON, and it is the caller's to keep: the
/// rename installs a NEW inode at this path, so any writer still holding an
/// append handle from BEFORE the call keeps succeeding against the orphaned
/// one — every byte landing in a file nothing can reach. That is not
/// hypothetical: `session_log::recover_interrupted` used to call its own trim
/// here and silently swallowed the tail of a LIVE session's audit trail
/// (round-116; the handle read 528 bytes while the path held 393). So a caller
/// MUST serialize its writers against this call — `evidence.rs` and `runs.rs`
/// both hold their own write mutex across both the append and this rewrite.
///
/// The temp file is left behind on failure (a caller that wants to clean up
/// may) and shares the target's directory, which is what keeps the rename on
/// one filesystem.
pub(crate) fn rewrite_atomically(path: &Path, body: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("jsonl.tmp");
    let res = (|| -> std::io::Result<()> {
        let mut out = std::fs::File::create(&tmp)?;
        out.write_all(body.as_bytes())?;
        out.flush()?;
        out.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
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

    /// The rewrite half: the file is REPLACED whole, and the caller's new
    /// bytes are what a reader sees even though the old file was longer.
    #[test]
    fn rewrite_atomically_replaces_the_whole_file() {
        let p = tmp("rewrite");
        std::fs::write(&p, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n").expect("seed");
        rewrite_atomically(&p, "{\"c\":3}\n").expect("rewrite");
        assert_eq!(
            std::fs::read_to_string(&p).expect("read"),
            "{\"c\":3}\n",
            "the body REPLACES the file — a truncate-and-rewrite that lost \
             bytes here would silently corrupt an append-only log"
        );
        // No temp residue: a leftover .tmp beside the log is exactly the
        // litter a crash during the session trail's own trim used to leave.
        assert!(!p.with_extension("jsonl.tmp").exists());
    }

    /// The temp file is a SIBLING, and it is cleaned up on failure.
    ///
    /// A rename across filesystems is not atomic (and fails on Windows), so
    /// the sibling placement is load-bearing rather than cosmetic.
    #[test]
    fn rewrite_atomically_fails_cleanly_on_an_unwritable_target() {
        let p = tmp("rewrite-fail");
        std::fs::write(&p, "keep\n").expect("seed");
        // A DIRECTORY at the temp path makes File::create fail.
        std::fs::create_dir_all(p.with_extension("jsonl.tmp")).expect("blocker dir");
        assert!(
            rewrite_atomically(&p, "new\n").is_err(),
            "an unusable temp path must report failure, not silently succeed"
        );
        assert_eq!(
            std::fs::read_to_string(&p).expect("read"),
            "keep\n",
            "a FAILED rewrite must leave the original untouched"
        );
        let _ = std::fs::remove_dir_all(p.with_extension("jsonl.tmp"));
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
