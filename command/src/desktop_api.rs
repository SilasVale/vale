//! Pure payload builders for Tauri commands.
//!
//! The commands in src-tauri are untestable glue (they read a process-global
//! `GLOBAL_STATE`); the payload logic they return lives here, where it only
//! needs `&AppState` — headless-constructible, so it gets unit tests.

use crate::state::AppState;
use vale_command_core::EventBus; // recent()/emit() on the bus
use serde_json::Value;

pub fn status_payload(s: &AppState) -> Value {
    serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "serial_ports": s.serial_pool.list_open_ports(),
    })
}

pub fn events_payload(s: &AppState, after: u64) -> Value {
    serde_json::json!({"ok": true, "events": s.event_bus.recent(after)})
}

#[cfg(test)]
mod tests {
    use super::*;
    use vale_command_core::{AgentEvent, Config, EventBus};

    fn state() -> AppState {
        AppState::new(Config::default(), None)
    }

    #[test]
    fn status_payload_ok() {
        let v = status_payload(&state());
        assert_eq!(v["ok"], true);
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert!(v["serial_ports"].is_array());
    }

    #[test]
    fn events_payload_returns_recent() {
        let s = state();
        s.event_bus.emit(&AgentEvent::ShellExec { command: "ls".into() });
        let v = events_payload(&s, 0);
        assert_eq!(v["events"].as_array().unwrap().len(), 1);
        // Polling from the last seq returns nothing new
        let v2 = events_payload(&s, 1);
        assert_eq!(v2["events"].as_array().unwrap().len(), 0);
    }
}
