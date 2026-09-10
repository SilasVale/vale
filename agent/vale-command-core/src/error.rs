use thiserror::Error;

#[derive(Debug, Error)]
pub enum DeviceError {
    #[error("SSH connection failed to {host}: {reason}")]
    SshConnectFailed { host: String, reason: String },

    #[error("SSH connection to {host} timed out")]
    SshTimeout { host: String },

    #[error("Serial port not found: {port}")]
    SerialPortNotFound { port: String },

    #[error("Serial port not open: {id}")]
    SerialPortNotOpen { id: String },

    #[error("Session not found: {id}")]
    SessionNotFound { id: String },

    #[error("Session busy (another execute in progress): {id}")]
    SessionBusy { id: String },

    /// A PERSON holds this session's keyboard (control handoff).
    ///
    /// Deliberately a separate code from [`DeviceError::SessionBusy`], and the
    /// difference is not cosmetic: `session_busy` means "another execute is
    /// running right now — wait and retry", while this means "a human took the
    /// keyboard — retrying will not help". Collapsing them would make the AI
    /// spin on the 30 s acquire loop and then report a lie about why.
    ///
    /// It exists so the AI can tell WHOM it is yielding to. Before this, a human
    /// typing into the same session was invisible to the agent, so an AI execute
    /// would interleave with the human's keystrokes: `busy` serialised AI-vs-AI
    /// only, never human-vs-AI.
    #[error("A human holds this session (control handed over): {id}")]
    HumanInControl { id: String },

    #[error("Invalid parameters: {message}")]
    InvalidParams { message: String },

    #[error("Keychain error: {reason}")]
    Keychain { reason: String },

    #[error("Internal error: {message}")]
    Internal { message: String },
}

impl DeviceError {
    /// Stable machine-readable code (round-59): the transport carries the
    /// variant name so clients route on the code, not on message text.
    pub fn code(&self) -> &'static str {
        match self {
            DeviceError::SshConnectFailed { .. } => "ssh_connect_failed",
            DeviceError::SshTimeout { .. } => "ssh_timeout",
            DeviceError::SerialPortNotFound { .. } => "serial_port_not_found",
            DeviceError::SerialPortNotOpen { .. } => "serial_port_not_open",
            DeviceError::SessionNotFound { .. } => "session_not_found",
            DeviceError::SessionBusy { .. } => "session_busy",
            DeviceError::HumanInControl { .. } => "human_in_control",
            DeviceError::InvalidParams { .. } => "invalid_params",
            DeviceError::Keychain { .. } => "keychain",
            DeviceError::Internal { .. } => "internal",
        }
    }
}

/// The codes the GATEWAY dispatches on by literal string.
///
/// This is a CROSS-BOUNDARY contract, and the boundary is not compiled
/// together: the gateway matches these three strings in
/// `gateway/src/mcp.ts` (the `!ok || data.ok === false` arm of
/// `callTerminalToolOnce`) and maps them onto its own failure classes —
/// `SESSION_NOT_FOUND` / `SESSION_BUSY` / `TIMEOUT`. **Every other typed code
/// falls through to `TOOL_ERROR`**, which is a deliberate round-64 decision:
/// after the mapping was widened, a device-UP tool failure (say a bad
/// parameter) must not read as "device offline" and send clients on a
/// device-recovery detour.
///
/// Renaming any of these three on the agent side does not break the build and
/// does not fail the gateway's own tests — the client-visible failure class
/// silently degrades to `TOOL_ERROR`. The pins below exist so that rename is
/// a test failure here instead.
pub const GATEWAY_DISPATCHED_CODES: &[&str] = &["session_not_found", "session_busy", "ssh_timeout"];

/// Codes that are deliberately NOT gateway-dispatched, recorded so the omission
/// is a decision instead of an oversight.
///
/// `human_in_control` is the first entry, and the reasoning is the round-64 rule
/// this table exists to apply: the gateway maps an unmatched typed code onto
/// `TOOL_ERROR`, which means "the device is UP and the tool refused". That is
/// exactly right here — a human holding the keyboard is a device-UP condition,
/// not a device outage, so sending the client on a device-recovery detour (a
/// `SESSION_BUSY`-style class) would be wrong in the same way the round-64
/// widening fixed.
///
/// The AI does not need a gateway class to understand this: it reads the code
/// directly off the tool result and can tell its user that a person has the
/// session. Pinned by `undispatched_codes_are_deliberate`.
pub const GATEWAY_UNDISPATCHED_CODES: &[&str] = &["human_in_control"];

#[cfg(test)]
mod error_tests {
    //! round-385: the machine-readable code table (the contract the
    //! gateway matches on for SESSION_NOT_FOUND/TOOL_ERROR routing) had
    //! zero pins — a renamed code would silently break gateway retries.
    use super::*;

    #[test]
    fn every_variant_has_its_stable_code() {
        let cases: Vec<(DeviceError, &str)> = vec![
            (
                DeviceError::SshConnectFailed {
                    host: "h".into(),
                    reason: "r".into(),
                },
                "ssh_connect_failed",
            ),
            (DeviceError::SshTimeout { host: "h".into() }, "ssh_timeout"),
            (
                DeviceError::SerialPortNotFound { port: "p".into() },
                "serial_port_not_found",
            ),
            (
                DeviceError::SerialPortNotOpen { id: "i".into() },
                "serial_port_not_open",
            ),
            (
                DeviceError::SessionNotFound { id: "i".into() },
                "session_not_found",
            ),
            (DeviceError::SessionBusy { id: "i".into() }, "session_busy"),
            (
                DeviceError::HumanInControl { id: "i".into() },
                "human_in_control",
            ),
            (
                DeviceError::InvalidParams {
                    message: "m".into(),
                },
                "invalid_params",
            ),
            (DeviceError::Keychain { reason: "r".into() }, "keychain"),
            (
                DeviceError::Internal {
                    message: "m".into(),
                },
                "internal",
            ),
        ];
        assert_eq!(
            cases.len(),
            10,
            "cover every variant or the table can drift"
        );
        for (e, code) in &cases {
            assert_eq!(e.code(), *code);
        }
    }

    #[test]
    fn display_carries_the_human_detail() {
        let e = DeviceError::SessionNotFound {
            id: "sess-9".into(),
        };
        assert!(e.to_string().contains("sess-9"));
        let e = DeviceError::InvalidParams {
            message: "provide pid or name".into(),
        };
        assert!(e.to_string().contains("provide pid or name"));
    }

    /// Every code named in [`GATEWAY_DISPATCHED_CODES`] must actually be
    /// produced by a variant.
    ///
    /// This is the pin that catches a RENAME. The table test above pins the
    /// strings, but it can be "fixed" by editing both the enum and the test in
    /// one commit — silently breaking the gateway, which matches
    /// `"ssh_timeout"` and would degrade to `TOOL_ERROR`. Here the constant
    /// carries the gateway's expectation, so a rename leaves a name in the
    /// list that no variant produces, and this fails.
    #[test]
    fn gateway_dispatched_codes_are_all_reachable() {
        let produced: Vec<&str> = all_variants().iter().map(|e| e.code()).collect();
        for code in GATEWAY_DISPATCHED_CODES {
            assert!(
                produced.contains(code),
                "the gateway dispatches on {code:?} but no DeviceError variant produces it — \
                 renaming it degrades that failure class to TOOL_ERROR"
            );
        }
    }

    /// The dispatched set is exactly the gateway's three literals — not a
    /// superset that would overstate the contract, and not a subset that would
    /// leave a real dispatch undocumented.
    #[test]
    fn gateway_dispatched_codes_are_exactly_three() {
        assert_eq!(
            GATEWAY_DISPATCHED_CODES,
            &["session_not_found", "session_busy", "ssh_timeout"],
            "gateway/src/mcp.ts matches exactly these three; changing the set is a \
             gateway behaviour change, not a refactor"
        );
        // No duplicates: a repeated entry would let a rename hide behind its twin.
        let mut sorted = GATEWAY_DISPATCHED_CODES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), GATEWAY_DISPATCHED_CODES.len());
    }

    /// Codes that reach the gateway but are NOT dispatched fall through to its
    /// `TOOL_ERROR` class. Naming them here is what makes the deliberate
    /// round-64 widening auditable: a NEW variant lands in this list (and thus
    /// in TOOL_ERROR) rather than silently acquiring a special class.
    #[test]
    fn every_other_code_falls_through_to_tool_error() {
        for e in all_variants() {
            let code = e.code();
            if GATEWAY_DISPATCHED_CODES.contains(&code) {
                continue;
            }
            assert!(
                !code.is_empty(),
                "a code-less variant would take the gateway's legacy \
                 message-text-guessing path instead of a typed class"
            );
        }
        // The three dispatched codes are a strict minority of the table — if
        // this ever inverts, the gateway's fallback is carrying the contract.
        assert!(GATEWAY_DISPATCHED_CODES.len() < all_variants().len());
    }

    /// The undispatched set is a DECISION, kept honest in both directions.
    ///
    /// Two ways to get this wrong, both silent: a code that is neither
    /// dispatched nor listed here (an accident acquiring a behaviour nobody
    /// chose), and a listed code that a rename left stale (the list starts
    /// lying). This fails on both.
    #[test]
    fn undispatched_codes_are_deliberate() {
        let produced: Vec<&str> = all_variants().iter().map(|e| e.code()).collect();

        for code in GATEWAY_UNDISPATCHED_CODES {
            assert!(
                produced.contains(code),
                "{code:?} is listed as deliberately-undispatched but no variant \
                 produces it — the list has gone stale after a rename"
            );
            assert!(
                !GATEWAY_DISPATCHED_CODES.contains(code),
                "{code:?} is in BOTH tables; the two sets must be disjoint or the \
                 gateway contract is ambiguous"
            );
        }

        // `human_in_control` specifically must NOT be dispatched. If someone
        // adds it to GATEWAY_DISPATCHED_CODES, the gateway would need a matching
        // arm in gateway/src/mcp.ts or the code would be matched-and-dropped;
        // this pin forces that to be a conscious cross-repo change.
        assert!(
            !GATEWAY_DISPATCHED_CODES.contains(&"human_in_control"),
            "human_in_control is a device-UP refusal and must fall through to the \
             gateway's TOOL_ERROR class — see GATEWAY_UNDISPATCHED_CODES"
        );
    }

    /// The two codes must stay DISTINGUISHABLE — this is the whole reason
    /// `HumanInControl` exists rather than reusing `SessionBusy`.
    ///
    /// A human holding the keyboard is not transient contention: the AI must not
    /// be told to wait and retry, because no amount of waiting hands the
    /// keyboard back. If a refactor ever merged these, the AI would sit in the
    /// 30 s acquire loop and then report the wrong reason.
    #[test]
    fn human_in_control_is_not_session_busy() {
        let busy = DeviceError::SessionBusy { id: "s".into() };
        let human = DeviceError::HumanInControl { id: "s".into() };
        assert_ne!(busy.code(), human.code());
        assert_ne!(busy.to_string(), human.to_string());
        // Both name the session, so a client can act on either without parsing
        // the message class.
        assert!(human.to_string().contains('s'));
    }

    /// One constructor per variant, so the tests above enumerate the SAME set.
    /// Co-located on purpose: adding a variant means adding it here, which
    /// makes the new code visible to every pin in this module.
    fn all_variants() -> Vec<DeviceError> {
        vec![
            DeviceError::SshConnectFailed {
                host: "h".into(),
                reason: "r".into(),
            },
            DeviceError::SshTimeout { host: "h".into() },
            DeviceError::SerialPortNotFound { port: "p".into() },
            DeviceError::SerialPortNotOpen { id: "i".into() },
            DeviceError::SessionNotFound { id: "i".into() },
            DeviceError::SessionBusy { id: "i".into() },
            DeviceError::HumanInControl { id: "i".into() },
            DeviceError::InvalidParams {
                message: "m".into(),
            },
            DeviceError::Keychain { reason: "r".into() },
            DeviceError::Internal {
                message: "m".into(),
            },
        ]
    }
}
