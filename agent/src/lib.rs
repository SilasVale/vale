// Re-export core types from vale-agent-core
pub use vale_agent_core::config;
pub use vale_agent_core::error;
pub use vale_agent_core::events;
pub use vale_agent_core::{Config, DeviceError, AgentEvent, Plugin, ToolDef, ToolHandler, NavItem, EventBus, AppEventBus};

pub mod bootstrap;
pub mod mcp;
pub mod plugins;
pub mod state;
pub mod tools;
pub mod web;

/// Default config.yaml embedded at compile time.
pub const DEFAULT_CONFIG_YAML: &str = include_str!("../config.yaml");
