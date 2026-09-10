//! Byte-budget text clipping — ONE owner for "cut this string to at most N
//! bytes, on a UTF-8 character boundary" (SOLID R105).
//!
//! The rule is one line to state and was, before this module, written out at
//! EIGHT sites across six files (mcp_client ×3, session_log ×2, output,
//! playwright, design, plus memory's private helper) in two different styles —
//! some via `str::floor_char_boundary`, some hand-rolling
//! `while !s.is_char_boundary(end) { end -= 1 }`. A ninth copy is always one
//! `&text[..4096]` away, and that mistake is not hypothetical: the crate has
//! paid for it at least three times.
//!
//! * round-68 — `&text[..4096]` in `session_log::log_output` split a
//!   multi-byte char: the panic killed the drainer and **wedged the session**.
//! * rounds 110/111 — `&line[..4096]` in the diag writer panicked the same
//!   way (the R106-H1 class).
//! * audit HIGH — the rpc diagnostic sliced a REMOTE-controlled body at byte
//!   80; a non-200 reply split a char and panicked the handler mid-call.
//!
//! Two helpers, both total (neither can panic, whatever the input):
//!
//!   * [`boundary_at_or_below`] — the index, for callers that report how many
//!     bytes they dropped.
//!   * [`clip`] — the slice itself, for everyone else.
//!
//! Deliberately NOT unified: the truncation SUFFIX. Callers mark the cut as
//! `…`, `…[truncated]` or `…[truncated N bytes]` per their audience (a model
//! reading tool output vs. an audit-trail reader), and that wording is theirs
//! to own. This module owns only where the knife falls.

/// Largest character boundary at or below `max`, clamped to the string length.
///
/// Total: `max` beyond the end yields `s.len()`; an empty string yields 0.
///
/// The clamp is deliberate belt-and-braces rather than a response to a current
/// std hazard: `str::floor_char_boundary` was stabilized (1.80) with a panic
/// for an out-of-range index and later relaxed to saturate — verified on this
/// repo's pinned 1.98.1, where `floor_char_boundary(4096)` on a 2-byte string
/// returns 2. Clamping makes this helper's totality a property of THIS crate
/// instead of a detail of the std version in use, which is what lets every
/// call site stay unguarded.
pub(crate) fn boundary_at_or_below(s: &str, max: usize) -> usize {
    let cap = max.min(s.len());
    s.floor_char_boundary(cap)
}

/// The longest prefix of `s` that fits in `max` bytes, cut on a char boundary.
///
/// Borrows the whole string when it already fits (no copy, and callers that
/// only need `&str` never allocate).
pub(crate) fn clip(s: &str, max: usize) -> &str {
    &s[..boundary_at_or_below(s, max)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_borrows_when_the_string_fits() {
        assert_eq!(clip("hello", 5), "hello", "exactly max bytes fits");
        assert_eq!(
            clip("hello", 99),
            "hello",
            "max beyond the end is not an error"
        );
        assert_eq!(clip("", 10), "");
        assert_eq!(clip("", 0), "");
    }

    #[test]
    fn boundary_never_lands_inside_a_character() {
        // "a汉b": boundaries at 0,1,4,5. Byte 2 and 3 are INSIDE 汉.
        let s = "a汉b";
        assert_eq!(s.len(), 5);
        for max in 0..=5 {
            let cut = boundary_at_or_below(s, max);
            assert!(cut <= max, "cut {cut} must not exceed max {max}");
            assert!(
                s.is_char_boundary(cut),
                "cut {cut} split a char (max {max})"
            );
        }
        // The interesting cases: a mid-char budget rounds DOWN to the boundary.
        assert_eq!(
            boundary_at_or_below(s, 3),
            1,
            "inside 汉 → the 'a' boundary"
        );
        assert_eq!(boundary_at_or_below(s, 2), 1);
        assert_eq!(boundary_at_or_below(s, 4), 4, "past 汉 → its end boundary");
        assert_eq!(boundary_at_or_below(s, 1), 1);
    }

    #[test]
    fn clip_is_total_for_every_budget_on_a_multibyte_string() {
        // The regression the crate paid for three times: a fixed byte budget
        // landing mid-character must cut, never panic.
        let s = "汉字内容测试🚀tail";
        for max in 0..s.len() + 4 {
            let out = clip(s, max); // must not panic
            assert!(out.len() <= max.min(s.len()));
            assert!(
                s.starts_with(out),
                "clip returns a PREFIX, never a re-encoding"
            );
        }
        // A 4-byte emoji is the worst case: budgets inside it round down to
        // the preceding boundary rather than splitting it.
        let rocket = s.find('🚀').expect("emoji present");
        assert_eq!(clip(s, rocket + 1), &s[..rocket]);
        assert_eq!(clip(s, rocket + 3), &s[..rocket]);
        assert_eq!(
            clip(s, rocket + 4),
            &s[..rocket + 4],
            "exactly the emoji fits"
        );
    }

    #[test]
    fn clip_does_not_allocate_a_prefix_of_itself() {
        // Borrow semantics matter at the big call sites (1 MB tool output):
        // clipping must be a slice of the ORIGINAL, not a copy.
        let s = String::from("abcdefghij");
        let out = clip(&s, 4);
        assert_eq!(out, "abcd");
        assert_eq!(out.as_ptr(), s.as_ptr(), "clip must borrow, not copy");
    }

    #[test]
    fn clip_keeps_the_boundary_when_max_is_exact() {
        let s = "汉a";
        assert_eq!(clip(s, 3), "汉");
        assert_eq!(clip(s, 4), "汉a");
    }
}
