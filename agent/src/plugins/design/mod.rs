//! Design Plugin — lets an AI SEE the Vale pages' design.
//!
//! The agent has no browser (CDP/headless-Chrome is retired) and runs as a
//! Windows service (no interactive desktop), so screenshots are impossible.
//! `page_view` instead fetches a page's live HTML/CSS from the agent's own
//! HTTP surface (/panel, /panel/*) — the AI reads the design tokens,
//! structure and styling directly. This is the honest, token-cheap way an AI
//! "sees" the design.

mod tools;

use vale_agent_core::ToolDef;

/// Plugin struct — stateless; every tool closes over what it needs.
pub struct DesignPlugin {
    console_url: String,
    download_url: String,
}

impl DesignPlugin {
    pub fn new(console_url: String, download_url: String) -> Self {
        Self { console_url, download_url }
    }
}

impl Default for DesignPlugin {
    fn default() -> Self {
        Self::new("https://api.saisi.online".into(), "https://agent.saisi.online".into())
    }
}

impl vale_agent_core::Plugin for DesignPlugin {
    fn name(&self) -> &'static str {
        "design"
    }
    fn display_name(&self) -> &'static str {
        "Design"
    }
    fn description(&self) -> &'static str {
        "Vale page design inspection — view a page's HTML/CSS to see its design"
    }
    fn tools(&self) -> Vec<ToolDef> {
        vec![tools::page_view(self.console_url.clone(), self.download_url.clone())]
    }
}
