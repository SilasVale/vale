use thiserror::Error;

#[derive(Debug, Error)]
pub enum DeviceError {
    #[error("SSH connection failed to {host}: {reason}")]
    SshConnectFailed { host: String, reason: String },

    #[error("SSH command timed out after {timeout}s on session {session}")]
    SshCommandTimeout { session: String, timeout: u32 },

    #[error("Serial port not found: {port}")]
    SerialPortNotFound { port: String },

    #[error("Serial port not open: {id}")]
    SerialPortNotOpen { id: String },

    #[error("Serial I/O error on {port}: {message}")]
    SerialIoError { port: String, message: String },

    #[error("Browser not connected: {reason}")]
    BrowserNotConnected { reason: String },

    #[error("Browser timeout: {message}")]
    BrowserTimeout { message: String },

    #[error("CDP target not found for tab: {tab_id}")]
    CdpTargetNotFound { tab_id: String },

    #[error("CDP connection failed: {reason}")]
    CdpConnectionFailed { reason: String },

    #[error("CDP command {method} failed: {reason}")]
    CdpCommand { method: String, reason: String },

    #[error("Invalid parameters: {message}")]
    InvalidParams { message: String },

    #[error("Timeout: {message}")]
    Timeout { message: String },

    #[error("Keychain error: {reason}")]
    Keychain { reason: String },

    #[error("Internal error: {message}")]
    Internal { message: String },
}
