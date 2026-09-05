//! Per-tool builders — one fn per MCP tool, built once at registration.
//!
//! The closures capture clones of the shared context (managers, bus, buffer),
//! so the tool list is built a single time by `PluginRegistry::register` and
//! reused for MCP list_tools and the web /api/spec endpoint alike.
//!
//! Layout (split from the former monolithic tools.rs — code moved verbatim,
//! no behavior change): the per-domain modules hold the tool builders,
//! `ctx` holds the shared state/helpers, and THIS module owns the registry
//! assembly. `build()` keeps the exact tool registration order the old
//! monolith had (observable via MCP list_tools / /api/spec); registration
//! order is set here and only here.
//!
//! Dependency rule: `ctx` → nothing; the domain modules → `ctx` (plus the
//! one documented exception: `connections` reuses `sessions::tool_open` for
//! the verbatim reconnect path).

mod connections;
mod ctx;
mod exec;
mod files;
mod output;
mod secrets;
mod sessions;
#[cfg(test)]
mod tests;

// Re-exports for the parent plugin module (SessionStore startup sweep +
// history-eviction spill cleanup call these under the
// `crate::plugins::terminal::tools::*` path).
pub(crate) use ctx::{remove_spill_for, sweep_spills_once};

use std::sync::Arc;

use crate::plugins::terminal::{DiagStore, OutputBuf};
use crate::tools::serial::SerialPool;
use crate::tools::terminal::TerminalManager;
use ctx::JobsMap;
use vale_agent_core::{EventBus, ToolDef};

pub(super) fn build(
    terminal_mgr: &Arc<TerminalManager>,
    serial_pool: &Arc<SerialPool>,
    bus: &Arc<dyn EventBus>,
    output_buf: &OutputBuf,
    diag: &DiagStore,
    logger: &crate::session_log::SessionLogger,
    buffer_limit: &Arc<std::sync::atomic::AtomicUsize>,
) -> Vec<ToolDef> {
    let jobs: JobsMap =
        std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut tools = vec![
        sessions::tool_open(terminal_mgr, bus, output_buf, logger, buffer_limit),
        exec::tool_jobs(&jobs),
        sessions::tool_write(terminal_mgr),
        sessions::tool_close(terminal_mgr, bus, output_buf),
        sessions::tool_list(terminal_mgr),
        output::tool_history(terminal_mgr, output_buf),
        exec::tool_execute(terminal_mgr, bus, output_buf, logger, &jobs),
        sessions::tool_list_ports(serial_pool),
        sessions::tool_resize(terminal_mgr),
        sessions::tool_select(terminal_mgr),
        output::tool_read(output_buf),
        output::tool_screen(output_buf),
        output::tool_diag_write(diag),
        output::tool_diag_read(diag),
        connections::tool_saved_connections(),
        connections::tool_connect_saved(terminal_mgr, bus, output_buf, logger, buffer_limit),
        connections::tool_forget_saved(),
        exec::tool_terminal_env(),
    ];
    // Secrets + SFTP: canonical names carry the `terminal_` prefix (stage-l
    // naming unification); the legacy unprefixed names stay as aliases so
    // existing AI clients keep working.
    tools.push(secrets::tool_secret_set("terminal_secret_set"));
    tools.push(secrets::tool_secret_set("secret_set"));
    tools.push(secrets::tool_secret_get("terminal_secret_get"));
    tools.push(secrets::tool_secret_get("secret_get"));
    tools.push(secrets::tool_secret_delete("terminal_secret_delete"));
    tools.push(secrets::tool_secret_delete("secret_delete"));
    tools.push(files::tool_sftp("terminal_sftp"));
    tools.push(files::tool_sftp("sftp"));
    tools
}
