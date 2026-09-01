//! VS Code shell-integration consumer (stage-m).
//!
//! The PowerShell session is spawned with the OSC 633 injection (see
//! pty.rs / resources/shell-integration/shellIntegration.ps1, transplanted
//! from microsoft/vscode). The script emits OSC 633 sequences from INSIDE
//! the shell — invisible on the terminal, parseable by this module:
//!
//!   ESC ] 633 ; A ST            prompt started
//!   ESC ] 633 ; B ST            command-input area starts
//!   ESC ] 633 ; C ST            command executed (pre-exec)
//!   ESC ] 633 ; D [; rc] ST     command finished (empty = no command)
//!   ESC ] 633 ; E ; cmd [; nonce] ST   explicit command line (trusted)
//!   ESC ] 633 ; P ; Prop=Val ST property report (IsWindows, Cwd, ...)
//!
//! ST = BEL (\x07) or ESC \. This mirrors VS Code's shellIntegrationAddon
//! (terminalEscapeSequences.ts); we only need D (completion + exit code)
//! and E (command text) for execute completion detection.
//!
//! The sequences are consumed from the RAW pty byte stream. A sequence may
//! be split across chunks — callers feed a carry buffer.

/// One parsed 633;D completion record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandFinished {
    /// Exit code from `633;D;<rc>`. `None` = empty command (no rc given).
    pub exit_code: Option<i32>,
    /// Absolute byte offset (in the caller's carry stream) where the
    /// sequence ended — callers drain up to here.
    pub end: usize,
}

/// One parsed 633;E command-line record.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub struct CommandLine {
    /// The escaped command text (backslash-hex escapes are NOT decoded here;
    /// decoding is the caller's job if needed).
    pub command: String,
    /// The nonce if present (trust anchor — matches VALE_NONCE).
    pub nonce: Option<String>,
    /// Absolute byte offset where the sequence ended.
    pub end: usize,
}

const BEL: u8 = 0x07;
const ESC: u8 = 0x1b;

/// Find the first `633;D[;rc]` completion in `data` (raw bytes, may contain
/// partial sequences). Returns the parsed record; the caller should drain
/// `end` bytes and keep scanning.
pub fn find_finished(data: &[u8]) -> Option<CommandFinished> {
    let mut i = 0;
    while i + 1 < data.len() {
        if data[i] == ESC && data[i + 1] == b']' {
            // Is this an OSC 633;D... sequence?
            if let Some((rel_end, rc)) = parse_osc_633_d(&data[i..]) {
                let end = i + rel_end;
                return Some(CommandFinished { exit_code: rc, end });
            }
            // Not a 633;D — skip past this OSC entirely (any ESC ] ... ST),
            // but only if it isn't a partial/malformed 633; sequence (those
            // must stay scannable — a split marker or a literal 633;D; echo
            // must not swallow a real marker after it).
            if let Some(n) = osc_skip_len(data, i) {
                i += n;
                continue;
            }
        }
        i += 1;
    }
    None
}

/// Find the first `633;E;cmd[;nonce]` record.
#[allow(dead_code)]
pub fn find_command_line(data: &[u8]) -> Option<CommandLine> {
    let mut i = 0;
    while i + 1 < data.len() {
        if data[i] == ESC && data[i + 1] == b']' {
            if let Some((rel_end, cmd, nonce)) = parse_osc_633_e(&data[i..]) {
                let end = i + rel_end;
                return Some(CommandLine { command: cmd, nonce, end });
            }
            // Same rule: skip only non-633; OSCs.
            if let Some(n) = osc_skip_len(data, i) {
                i += n;
                continue;
            }
        }
        i += 1;
    }
    None
}

/// Find the first `633;A` (prompt started) in `data`. Returns the offset
/// just past the sequence (caller drains up to here), or None.
pub fn find_prompt_started(data: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + 1 < data.len() {
        if data[i] == ESC && data[i + 1] == b']' {
            // Literal "633;A"
            let mut pos = i + 2;
            for expect in b"633;A" {
                if data.get(pos) != Some(expect) {
                    break;
                }
                pos += 1;
            }
            // If we matched all 5 chars ("633;A"), expect a terminator.
            if pos == i + 7 {
                match data.get(pos) {
                    Some(&BEL) => return Some(pos + 1),
                    Some(&ESC) if data.get(pos + 1) == Some(&b'\\') => return Some(pos + 2),
                    _ => {}
                }
            }
            // Skip past any complete OSC to avoid re-scanning inside it —
            // but never past a partial/malformed 633; sequence (it may be
            // the A marker split across chunks, or a literal 633;A; echo).
            if let Some(n) = osc_skip_len(data, i) {
                i += n;
                continue;
            }
        }
        i += 1;
    }
    None
}

/// Parse `ESC ] 633 ; D [; <digits>] ST` starting at `data[0] == ESC`.
/// Returns (total length INCLUDING terminator, exit code).
fn parse_osc_633_d(data: &[u8]) -> Option<(usize, Option<i32>)> {
    if data.first() != Some(&ESC) || data.get(1) != Some(&b']') {
        return None;
    }
    let mut pos = 2;
    // Literal "633;D"
    for expect in b"633;D" {
        if data.get(pos) != Some(expect) {
            return None;
        }
        pos += 1;
    }
    let mut rc: Option<i32> = None;
    if data.get(pos) == Some(&b';') {
        pos += 1;
        let start = pos;
        while matches!(data.get(pos), Some(c) if c.is_ascii_digit()) {
            pos += 1;
        }
        if pos == start {
            return None; // ";" with no digits — malformed
        }
        let digits = std::str::from_utf8(&data[start..pos]).ok()?;
        // Overflow (or any unparseable digit run) is MALFORMED, not an
        // empty command: `633;D` (no `;` at all) is the only valid
        // no-exit-code form. Return None so the caller keeps scanning for a
        // real marker instead of treating garbage as a completion.
        rc = Some(digits.parse::<i32>().ok()?);
    }
    // Terminator: BEL or ESC \
    match data.get(pos) {
        Some(&BEL) => Some((pos + 1, rc)),
        Some(&ESC) if data.get(pos + 1) == Some(&b'\\') => Some((pos + 2, rc)),
        _ => None, // incomplete — caller keeps buffering
    }
}

/// Parse `ESC ] 633 ; E ; <escaped-cmd> [; <nonce>] ST`.
/// Returns (total length INCLUDING terminator, command, nonce).
#[allow(dead_code)]
fn parse_osc_633_e(data: &[u8]) -> Option<(usize, String, Option<String>)> {
    if data.first() != Some(&ESC) || data.get(1) != Some(&b']') {
        return None;
    }
    let mut pos = 2;
    for expect in b"633;E;" {
        if data.get(pos) != Some(expect) {
            return None;
        }
        pos += 1;
    }
    let body_start = pos;
    // Scan to the terminator, tracking the last `;` before it (nonce split).
    let mut last_semi: Option<usize> = None;
    let mut scan = pos;
    while scan < data.len() {
        match data[scan] {
            BEL | ESC => break,
            b';' => last_semi = Some(scan),
            _ => {}
        }
        scan += 1;
    }
    if scan >= data.len() {
        return None; // incomplete
    }
    let end = match data[scan] {
        BEL => scan + 1,
        ESC if data.get(scan + 1) == Some(&b'\\') => scan + 2,
        _ => return None,
    };
    let body = &data[body_start..scan];
    let body_str = String::from_utf8_lossy(body).into_owned();
    let (cmd, nonce) = match last_semi {
        // `;` at or after body_start splits cmd;nonce. `633;E;;nonce` (empty
        // command — Enter on an empty prompt) has its split at body_start
        // itself: cmd = "", nonce = Some. A `;` BEFORE body_start is the
        // literal `633;E;` separator, not a split point.
        Some(s) if s >= body_start => {
            let c = String::from_utf8_lossy(&data[body_start..s]).into_owned();
            let n = String::from_utf8_lossy(&data[s + 1..scan]).into_owned();
            (c, Some(n))
        }
        _ => (body_str, None),
    };
    Some((end, cmd, nonce))
}

/// Length of a complete OSC payload (`ESC ] ... ST`) starting at data[0],
/// or None if incomplete. Used to skip past OSCs we don't care about.
fn osc_payload_end(data: &[u8]) -> Option<usize> {
    let mut i = 2; // past ESC ]
    while i < data.len() {
        match data[i] {
            BEL => return Some(i + 1),
            ESC if data.get(i + 1) == Some(&b'\\') => return Some(i + 2),
            _ => i += 1,
        }
    }
    None
}

/// Skip length for an OSC at `data[i..]` (caller already verified `ESC ]`)
/// that is NOT a complete 633 sequence we're looking for. Only non-`633;`
/// payloads are skipped: a partial or malformed `633;` sequence (a marker
/// split across chunks, or raw output that literally prints `ESC ] 633;D;`)
/// must NOT be skipped to its next BEL — skipping would swallow a real
/// completion marker that follows it in the same buffer window.
fn osc_skip_len(data: &[u8], i: usize) -> Option<usize> {
    let is_633 = data.get(i + 2..).is_some_and(|rest| rest.starts_with(b"633;"));
    if is_633 {
        return None;
    }
    osc_payload_end(&data[i..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_d_with_exit_code() {
        let data = b"hello\r\n\x1b]633;D;0\x07world";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(0));
        assert_eq!(&data[f.end..], b"world");
    }

    #[test]
    fn find_d_empty_command() {
        let data = b"\x1b]633;D\x07";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, None);
    }

    #[test]
    fn find_d_with_rc_13() {
        let data = b"\x1b]633;D;13\x07";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(13));
    }

    #[test]
    fn find_d_split_across_chunks() {
        let mut carry = b"abc\x1b]633;D;".to_vec();
        assert!(find_finished(&carry).is_none());
        carry.extend_from_slice(b"42\x07");
        let f = find_finished(&carry).expect("finished after second chunk");
        assert_eq!(f.exit_code, Some(42));
    }

    #[test]
    fn find_d_ignores_other_osc() {
        let data = b"\x1b]633;P;IsWindows=True\x07\x1b]633;D;1\x07";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(1));
    }

    #[test]
    fn find_e_command_line() {
        let data = b"\x1b]633;E;echo%20hi;abc123\x07";
        let e = find_command_line(data).expect("cmdline");
        assert_eq!(e.command, "echo%20hi");
        assert_eq!(e.nonce.as_deref(), Some("abc123"));
    }

    #[test]
    fn find_e_no_nonce() {
        let data = b"\x1b]633;E;Write-Output%20x\x07";
        let e = find_command_line(data).expect("cmdline");
        assert_eq!(e.command, "Write-Output%20x");
        assert_eq!(e.nonce, None);
    }

    // ── ST (ESC \) terminator, not just BEL ────────────────

    #[test]
    fn find_d_with_st_terminator() {
        // ST (ESC \) terminates the OSC — used by terminals that don't send BEL.
        let data = b"out\x1b]633;D;0\x1b\\more";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(0));
        assert_eq!(&data[f.end..], b"more");
    }

    #[test]
    fn find_prompt_started_with_st_terminator() {
        let data = b"\x1b]633;A\x1b\\PS>";
        let end = find_prompt_started(data).expect("prompt");
        assert_eq!(&data[end..], b"PS>");
    }

    #[test]
    fn find_d_skips_unrelated_osc_with_backslash_inside() {
        // A Windows path in a title OSC contains `\` — the skip path must not
        // treat a bare backslash as the ST terminator and must still find the
        // real 633;D after it.
        let data = b"\x1b]0;C:\\temp\\x\x07\x1b]633;D;5\x07";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(5));
    }

    // ── exit-code edge cases ───────────────────────────────

    #[test]
    fn find_d_negative_exit_code_not_recognized() {
        // pwsh's FakeCode is `[int]!$global:?` → only 0/1; a `-2` (or any
        // non-digit) is NOT a valid 633;D payload — find_finished returns
        // None (caller keeps waiting) and the malformed OSC must not block
        // a real marker that follows.
        let data = b"\x1b]633;D;-2\x07";
        assert_eq!(find_finished(data), None);
        let data2 = b"\x1b]633;D;-2\x07\x1b]633;D;0\x07";
        let f = find_finished(data2).expect("real marker after malformed one");
        assert_eq!(f.exit_code, Some(0));
    }

    #[test]
    fn find_d_overflow_exit_code_skipped() {
        // i32 overflow (malformed/foreign sequence) is NOT a valid
        // completion — find_finished returns None so the caller keeps
        // waiting for the real marker. The malformed OSC stays scannable.
        let data = b"\x1b]633;D;99999999999\x07";
        assert_eq!(find_finished(data), None);
    }

    #[test]
    fn find_d_missing_digits_skipped() {
        // `633;D;` with no digits is malformed — not a completion, and the
        // real marker after it must still be found.
        let data = b"\x1b]633;D;\x07\x1b]633;D;3\x07";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(3));
    }

    #[test]
    fn find_d_empty_rc_after_semi_means_none() {
        // `633;D;` alone (no digits, no terminator after digits) — None.
        let data = b"\x1b]633;D;\x07";
        assert!(find_finished(data).is_none());
    }

    // ── multi-sequence drain semantics ─────────────────────

    #[test]
    fn find_d_returns_first_of_many() {
        // The caller drains `end` and re-scans; find must return the FIRST
        // completion, not the last.
        let data = b"\x1b]633;D;1\x07\x1b]633;D;2\x07";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(1));
    }

    #[test]
    fn find_prompt_started_ignores_other_osc_before_a() {
        // P reports / B / C sequences precede A in a real stream — A must be
        // found despite them.
        let data = b"\x1b]633;P;IsWindows=True\x07\x1b]633;B\x07\x1b]633;A\x07PS>";
        let end = find_prompt_started(data).expect("prompt");
        assert_eq!(&data[end..], b"PS>");
    }

    // ── fragment / partial-sequence behavior ───────────────

    #[test]
    fn find_prompt_started_partial_prefix_returns_none() {
        assert_eq!(find_prompt_started(b"\x1b]633;"), None);
        assert_eq!(find_prompt_started(b"\x1b]633;A"), None);
        assert_eq!(find_prompt_started(b"\x1b]633;A\x07more"), Some(8));
    }

    #[test]
    fn find_d_incomplete_bel_returns_none() {
        // Terminator not yet present — caller keeps buffering.
        assert_eq!(find_finished(b"\x1b]633;D;4"), None);
        assert_eq!(find_finished(b"\x1b]633;D;42"), None);
    }

    #[test]
    fn find_d_osc_without_terminator_ignored() {
        // An OSC that runs to the end of the buffer (no ST) must not match.
        assert_eq!(find_finished(b"\x1b]633;D;0"), None);
    }

    #[test]
    fn find_e_empty_command_with_nonce() {
        // `633;E;;<nonce>` — Enter on an empty prompt: cmd is EMPTY, nonce is
        // set. Regression: the old split treated the leading `;` as part of
        // the command text.
        let data = b"\x1b]633;E;;abc123\x07";
        let e = find_command_line(data).expect("cmdline");
        assert_eq!(e.command, "");
        assert_eq!(e.nonce.as_deref(), Some("abc123"));
    }

    #[test]
    fn find_e_command_with_escaped_semicolons() {
        // Escaped content (backslash-hex) inside the command: a `\x3b` is
        // literal text, not a split point. Only a RAW `;` separates nonce.
        let data = b"\x1b]633;E;echo%20\x5cx3b\x07";
        let e = find_command_line(data).expect("cmdline");
        assert_eq!(e.command, "echo%20\\x3b");
        assert_eq!(e.nonce, None);
    }

    #[test]
    fn find_e_command_with_raw_semicolon_is_nonce_split() {
        // A RAW `;` in the body splits command;nonce (this is the real
        // shellIntegration.ps1 format — the command text is escaped, so raw
        // `;` only appears as the nonce separator).
        let data = b"\x1b]633;E;echo%20hi;nonce42\x07";
        let e = find_command_line(data).expect("cmdline");
        assert_eq!(e.command, "echo%20hi");
        assert_eq!(e.nonce.as_deref(), Some("nonce42"));
    }

    #[test]
    fn find_e_empty_command_no_nonce() {
        // `633;E;` with nothing after — empty command, no nonce.
        let data = b"\x1b]633;E;\x07";
        let e = find_command_line(data).expect("cmdline");
        assert_eq!(e.command, "");
        assert_eq!(e.nonce, None);
    }

    #[test]
    fn find_e_ignores_unrelated_osc_and_finds_e() {
        let data = b"\x1b]633;P;IsWindows=True\x07\x1b]633;E;dir;n1\x07";
        let e = find_command_line(data).expect("cmdline");
        assert_eq!(e.command, "dir");
        assert_eq!(e.nonce.as_deref(), Some("n1"));
    }

    #[test]
    fn find_d_after_previous_output_and_prompt() {
        // A realistic slice: prior command output + prompt + 633;D;0.
        let data = b"hello\r\n\x1b]633;D;0\x07PS C:\\Users\\x>";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(0));
        assert_eq!(&data[f.end..], b"PS C:\\Users\\x>");
    }

    // ── chunked feed (the caller's carry-buffer loop) ──────

    #[test]
    fn chunked_d_found_across_many_small_chunks() {
        // Feed the stream one byte at a time (worst-case pty chunking): the
        // scanner must find the sequence only when complete, never earlier.
        let full = b"PS>\x1b]633;D;0\x07";
        let mut carry: Vec<u8> = Vec::new();
        for (i, b) in full.iter().enumerate() {
            carry.push(*b);
            let found = find_finished(&carry);
            if i + 1 < full.len() {
                assert!(found.is_none(), "found before full input at byte {i}: {carry:?}");
            } else {
                let f = found.expect("finished at last byte");
                assert_eq!(f.exit_code, Some(0));
            }
        }
    }

    #[test]
    fn chunked_prompt_started_found_at_exact_boundary() {
        // `633;A` + BEL: find_prompt_started returns the offset PAST the
        // BEL (7+1=8) as soon as the terminator arrives — it does not wait
        // for the prompt text that follows.
        let full = b"\x1b]633;A\x07PS>";
        let mut carry: Vec<u8> = Vec::new();
        for (i, b) in full.iter().enumerate() {
            carry.push(*b);
            let found = find_prompt_started(&carry);
            if i < 7 {
                assert!(found.is_none(), "prompt found too early at byte {i}: {carry:?}");
            } else {
                assert_eq!(found, Some(8), "prompt end must be past the BEL at byte {i}");
            }
        }
    }

    #[test]
    fn drain_then_rescan_multi_chunk_stream() {
        // Emulate the wait loop: feed chunks, drain on each find, keep going.
        let chunks: [&[u8]; 4] = [
            b"echo hi\r\nhi\r\n\x1b]633;D;",
            b"0\x07\x1b]633;A\x07PS>",
            b"exit\r\n\x1b]633;D;",
            b"42\x07\x1b]633;A\x07PS>",
        ];
        let mut carry: Vec<u8> = Vec::new();
        let mut codes: Vec<Option<i32>> = Vec::new();
        for chunk in chunks {
            carry.extend_from_slice(chunk);
            while let Some(f) = find_finished(&carry) {
                carry.drain(..f.end);
                codes.push(f.exit_code);
            }
        }
        assert_eq!(codes, vec![Some(0), Some(42)]);
    }

    #[test]
    fn false_633_prefix_does_not_swallow_real_marker() {
        // A literal `ESC ] 633;D;` in output (a log line, or a marker split
        // mid-sequence) must NOT cause the skip path to jump to its BEL —
        // the real 633;D;0 after it must still be found. Regression for the
        // pre-fix osc_payload_end skip that swallowed real markers.
        let data = b"log: \x1b]633;D;\r\nreal\x1b]633;D;0\x07";
        let f = find_finished(data).expect("finished");
        assert_eq!(f.exit_code, Some(0));
        assert_eq!(&data[f.end..], b"");
    }

    #[test]
    fn false_633_a_prefix_does_not_swallow_real_a() {
        let data = b"\x1b]633;A;\x1b]633;A\x07PS>";
        let end = find_prompt_started(data).expect("prompt");
        assert_eq!(&data[end..], b"PS>");
    }
}
