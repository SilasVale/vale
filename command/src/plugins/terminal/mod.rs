//! Terminal Plugin — unified terminal access (PTY, SSH, Serial).
//!
//! Tools: terminal_open, terminal_write, terminal_close, terminal_list,
//!        terminal_execute, terminal_list_ports, terminal_read,
//!        terminal_resize, terminal_select, secret_set/get/delete
//!
//! Tool definitions live in `tools.rs` (one builder fn per tool); this module
//! holds the plugin struct, the per-session output buffer, and the shared
//! ANSI-stripping helper.

mod tools;

use std::collections::HashMap;
use std::sync::Arc;

use vale_command_core::{Plugin, ToolDef};
use crate::tools::serial::SerialPool;
use crate::tools::terminal::TerminalManager;
use vale_command_core::EventBus;

/// Per-session output buffer for non-destructive MCP read access.
/// Stores accumulated raw bytes with a cursor tracking how much has been read.
#[derive(Default)]
pub struct SessionBuf {
    pub data: Vec<u8>,
    pub cursor: usize,    // bytes already consumed by terminal_read (index into data)
    pub dropped: u64,     // total bytes evicted from the front (absolute offset base)
}

impl SessionBuf {
    pub fn new() -> Self {
        Self::default()
    }

    /// Absolute end offset — bytes evicted plus bytes retained.
    pub fn end_abs(&self) -> usize {
        self.dropped as usize + self.data.len()
    }

    /// Slice from an absolute byte offset, clamped. Eviction can at worst
    /// skip or boundedly duplicate data — never panic on an out-of-range index.
    pub fn slice_from(&self, abs: usize) -> &[u8] {
        let rel = abs.saturating_sub(self.dropped as usize).min(self.data.len());
        &self.data[rel..]
    }
}

pub(super) type OutputBuf = Arc<std::sync::Mutex<HashMap<String, SessionBuf>>>;

/// Strip ANSI escape sequences and normalize line endings for AI readability.
pub fn clean_terminal_output(raw: &[u8]) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Skip ANSI CSI sequence: ESC [ ... letter
            i += 2;
            while i < bytes.len() && !(bytes[i] >= 0x40 && bytes[i] <= 0x7e) {
                i += 1;
            }
            if i < bytes.len() { i += 1; } // skip the terminating letter
        } else if bytes[i] == b'\r' {
            // \r\n → \n, standalone \r → \n
            if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                out.push('\n');
                i += 2;
            } else {
                out.push('\n');
                i += 1;
            }
        } else {
            // ASCII or properly-sized UTF-8 sequence
            let b = bytes[i];
            let len = if b < 0x80 {
                1
            } else if b & 0xE0 == 0xC0 {
                2
            } else if b & 0xF0 == 0xE0 {
                3
            } else if b & 0xF8 == 0xF0 {
                4
            } else {
                1 // continuation byte or invalid — replacement below
            };
            let end = (i + len).min(bytes.len());
            let chunk = &bytes[i..end];
            match std::str::from_utf8(chunk) {
                Ok(s) => { out.push_str(s); i = end; }
                Err(_) => { out.push(char::REPLACEMENT_CHARACTER); i += 1; }
            }
        }
    }
    out
}

pub struct TerminalPlugin {
    terminal_mgr: Arc<TerminalManager>,
    serial_pool: Arc<SerialPool>,
    bus: Arc<dyn EventBus>,
    output_buf: OutputBuf,
}

impl TerminalPlugin {
    pub fn new(
        terminal_mgr: Arc<TerminalManager>,
        serial_pool: Arc<SerialPool>,
        bus: Arc<dyn EventBus>,
    ) -> Self {
        Self { terminal_mgr, serial_pool, bus, output_buf: Arc::new(std::sync::Mutex::new(HashMap::new())) }
    }
}

impl Plugin for TerminalPlugin {
    fn name(&self) -> &'static str { "terminal" }
    fn display_name(&self) -> &'static str { "Terminal" }
    fn description(&self) -> &'static str {
        "Terminal access — PTY local shell, SSH remote, serial port"
    }

    fn tools(&self) -> Vec<ToolDef> {
        tools::build(&self.terminal_mgr, &self.serial_pool, &self.bus, &self.output_buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vale_command_core::{AppEventBus, Plugin};
    use serde_json::json;

    fn plugin() -> TerminalPlugin {
        let bus: Arc<dyn EventBus> = Arc::new(AppEventBus::new());
        let serial = Arc::new(SerialPool::new(115200, 1000));
        let mgr = Arc::new(TerminalManager::new(serial.clone()));
        TerminalPlugin::new(mgr, serial, bus)
    }

    #[test]
    fn tool_count_and_names() {
        let tools = plugin().tools();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(tools.len(), 12);
        for expected in [
            "terminal_open", "terminal_write", "terminal_close", "terminal_list",
            "terminal_execute", "terminal_list_ports", "terminal_resize",
            "terminal_select", "terminal_read", "secret_set", "secret_get", "secret_delete",
        ] {
            assert!(names.contains(&expected), "missing tool: {expected}");
        }
    }

    #[cfg(not(feature = "terminal"))]
    #[tokio::test]
    async fn terminal_open_headless_errors_propagate() {
        // The stub manager's "backend not enabled" error must reach the caller
        // through the full tool-handler path. Skipped when the real terminal
        // backend is compiled (it would open a real PTY).
        let tools = plugin().tools();
        let t = tools.iter().find(|t| t.name == "terminal_open").unwrap();
        let err = t.handler.call(json!({"kind": "pty", "target": ""})).await.unwrap_err();
        assert!(err.to_string().contains("backend not enabled"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn terminal_write_missing_params() {
        let tools = plugin().tools();
        let t = tools.iter().find(|t| t.name == "terminal_write").unwrap();
        let err = t.handler.call(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("missing required field"), "unexpected error: {err}");
    }
}
