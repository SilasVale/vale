// Re-export core types from vale_command-core
pub use vale_command_core::config;
pub use vale_command_core::error;
pub use vale_command_core::events;
pub use vale_command_core::{Config, DeviceError, AgentEvent, Plugin, ToolDef, ToolHandler, NavItem, EventBus, AppEventBus};

pub mod bootstrap;
pub mod desktop_api;
pub mod mcp;
pub mod plugins;
pub mod state;
pub mod tools;
pub mod web;

/// Default config.yaml embedded at compile time — single source for both
/// the headless binary and the desktop app.
pub const DEFAULT_CONFIG_YAML: &str = include_str!("../config.yaml");
