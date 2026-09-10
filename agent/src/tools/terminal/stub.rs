//! Stub — terminal tools report "backend not enabled" errors when the
//! `terminal` feature is off.

use super::{TermOpenRequest, TermOutput, TermSessionInfo};
use std::sync::Arc;
use vale_agent_core::DeviceError;

pub struct TerminalManager;

fn disabled_err() -> DeviceError {
    DeviceError::Internal {
        message: "terminal backend not enabled (build with --features terminal)".into(),
    }
}

impl TerminalManager {
    pub fn new(_serial: Arc<crate::tools::serial::SerialPool>) -> Self {
        Self
    }
    pub async fn term_open(
        &self,
        _req: &TermOpenRequest,
    ) -> Result<(String, tokio::sync::mpsc::Receiver<TermOutput>), DeviceError> {
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
    pub async fn term_try_execute(&self, _sid: &str) -> Result<bool, DeviceError> {
        Err(disabled_err())
    }
    /// Wait-with-timeout variant of term_try_execute (round-…: added to the
    /// stub when the execute path gained the acquire-with-timeout call).
    pub async fn term_acquire_execute(
        &self,
        _sid: &str,
        _max_wait_ms: u64,
    ) -> Result<bool, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_marker_injected(&self, _sid: &str) -> bool {
        false
    }
    pub async fn term_set_marker_injected(&self, _sid: &str, _injected: bool) {}
    pub async fn term_release_execute(&self, _sid: &str) {}

    /// Headless twin of the control handoff. `Err(disabled_err())` rather than
    /// a silent `Ok`, so a headless build cannot report a hold it never stored —
    /// the panel's control button must fail loudly here instead of appearing to
    /// work. (Same discipline as `term_try_execute` above.)
    pub async fn term_set_control(&self, _sid: &str, _human: bool) -> Result<bool, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_held_by_human(&self, _sid: &str) -> Result<bool, DeviceError> {
        Err(disabled_err())
    }

    /// Headless twins of the approval gate. Same `disabled_err()` discipline as
    /// the control twins above: a headless build must fail loudly rather than
    /// report a decision it cannot store. In particular `term_await_approval`
    /// must NOT return `Ok(true)` — that would let a headless agent execute
    /// commands while an operator believes the gate is armed.
    pub async fn term_set_approval_required(
        &self,
        _sid: &str,
        _required: bool,
    ) -> Result<bool, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_approval_required(&self, _sid: &str) -> Result<bool, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_pending_approval(
        &self,
        _sid: &str,
    ) -> Result<Option<super::PendingApprovalInfo>, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_decide_approval(
        &self,
        _sid: &str,
        _id: &str,
        _approve: bool,
        _grant: bool,
    ) -> Result<bool, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_approval_grants(&self, _sid: &str) -> Result<Vec<String>, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_revoke_grants(
        &self,
        _sid: &str,
        _grant: Option<&str>,
    ) -> Result<usize, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_await_approval(
        &self,
        _sid: &str,
        _command: &str,
        _max_wait_ms: u64,
    ) -> Result<bool, DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_exit_code(&self, _sid: &str) -> Option<i32> {
        None
    }
    pub async fn term_select(&self, _sid: &str) -> Result<(), DeviceError> {
        Err(disabled_err())
    }
    pub async fn term_list(&self) -> Vec<TermSessionInfo> {
        vec![]
    }
    pub async fn term_info(&self, _sid: &str) -> Option<TermSessionInfo> {
        None
    }
}
