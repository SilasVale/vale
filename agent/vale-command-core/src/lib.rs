//! Core framework for Vale Command — Plugin trait, config, error types, events.

pub mod config;
pub mod error;
pub mod events;

pub use config::Config;
pub use error::DeviceError;
pub use events::{AgentEvent, AppEventBus, EventBus};

// ── Poison recovery ────────────────────────────────────────────

/// Lock a std Mutex, recovering from a poisoned guard (a panic while holding
/// the lock) instead of propagating it. The CLAUDE.md contract: poison is
/// recovered with `into_inner()` — never silently dropped data.
pub fn recover_guard<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ── Plugin Trait ──────────────────────────────────────────────

/// A plugin represents one capability domain (SSH, Serial, Browser, Discovery).
/// It exposes MCP tools and an optional dashboard nav item.
///
/// Tools are the single source of truth — MCP, Web API, and Tauri commands
/// all dispatch through the PluginRegistry.
pub trait Plugin: Send + Sync {
    /// Unique identifier, e.g. "ssh", "serial", "browser"
    fn name(&self) -> &'static str;

    /// Human-readable display name, e.g. "SSH", "Serial Port"
    fn display_name(&self) -> &'static str;

    /// One-line description
    fn description(&self) -> &'static str;

    /// MCP tools exposed by this plugin — the single source of truth for tool registration.
    /// Each handler receives JSON params and returns a JSON Value result.
    /// Handlers are responsible for emitting events via the EventBus.
    fn tools(&self) -> Vec<ToolDef> {
        vec![]
    }

    /// Dashboard navigation item (optional — returns None if no UI needed)
    fn nav_item(&self) -> Option<NavItem> {
        None
    }
}

// ── Tool Definition ───────────────────────────────────────────

/// Handler function: receives JSON params, returns JSON result Value.
pub trait ToolHandler: Send + Sync {
    fn call(
        &self,
        params: serde_json::Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<serde_json::Value, DeviceError>> + Send + '_>,
    >;
}

impl<F, Fut> ToolHandler for F
where
    F: Fn(serde_json::Value) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Result<serde_json::Value, DeviceError>> + Send + 'static,
{
    fn call(
        &self,
        params: serde_json::Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<serde_json::Value, DeviceError>> + Send + '_>,
    > {
        Box::pin(self(params))
    }
}

pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema for the input parameters (hand-written JSON)
    pub input_schema: serde_json::Value,
    pub handler: Box<dyn ToolHandler>,
}

impl ToolDef {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: serde_json::Value,
        handler: impl ToolHandler + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
            handler: Box::new(handler),
        }
    }
}

// ── Navigation Item ───────────────────────────────────────────

pub struct NavItem {
    /// Unique page id, used as HTML id: "page-{id}"
    pub id: &'static str,
    /// Sidebar icon (emoji or SVG)
    pub icon: &'static str,
    /// Sidebar label
    pub label: &'static str,
    /// HTML snippet injected into the dashboard page div
    pub html_snippet: &'static str,
}