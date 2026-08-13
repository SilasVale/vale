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
