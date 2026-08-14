//! Stub — terminal tools report "backend not enabled" errors when the
//! `terminal` feature is off.

use super::{TermOpenRequest, TermOutput, TermSessionInfo};
use vale_agent_core::DeviceError;
use std::sync::Arc;

pub struct TerminalManager;

fn disabled_err() -> DeviceError {
    DeviceError::Internal { message: "terminal backend not enabled (build with --features terminal)".into() }
}

impl TerminalManager {
    pub fn new(_serial: Arc<crate::tools::serial::SerialPool>) -> Self { Self }
    pub async fn term_open(&self, _req: &TermOpenRequest) -> Result<(String, tokio::sync::mpsc::Receiver<TermOutput>), DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_resize(&self, _sid: &str, _rows: u16, _cols: u16) -> Result<(), DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_write(&self, _sid: &str, _data: &str) -> Result<(), DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_write_bytes(&self, _sid: &str, _data: &[u8]) -> Result<(), DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_close(&self, _sid: &str) -> Result<String, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_unregister(&self, _sid: &str) {}
    pub async fn touch(&self, _sid: &str) {}
    pub async fn term_terminate(&self, _sid: &str) -> Result<(), DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_try_execute(&self, _sid: &str) -> Result<bool, DeviceError> { Err(disabled_err()) }
    pub async fn term_marker_injected(&self, _sid: &str) -> bool { false }
    pub async fn term_release_execute(&self, _sid: &str) {}
    pub async fn term_exit_code(&self, _sid: &str) -> Option<i32> { None }
    pub async fn term_select(&self, _sid: &str) -> Result<(), DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_list(&self) -> Vec<TermSessionInfo> { vec![] }
    pub async fn term_info(&self, _sid: &str) -> Option<TermSessionInfo> { None }
}
