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
            DeviceError::InvalidParams { .. } => "invalid_params",
            DeviceError::Keychain { .. } => "keychain",
            DeviceError::Internal { .. } => "internal",
        }
    }
}

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
        assert_eq!(cases.len(), 9, "cover every variant or the table can drift");
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
}
