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
