//! Tool definitions for the runs plugin.
//!
//! Two tools, and the split between them is the whole design:
//!
//! * `run_begin` MINTS the id. The client never supplies one, so one execution
//!   cannot claim another's identity even by accident.
//! * `run_end` ACCEPTS an id and reports whether it was ever minted (`known`).
//!   It reports that and does nothing else with it — see the credential rule in
//!   [`crate::runs`].
//!
//! Both are best-effort writers: a device whose runs directory is unwritable
//! still answers `ok`, because the log is observability and must never fail the
//! work it describes (the same contract as the pwout evidence feed).

use crate::plugins::require_str;
use serde_json::{json, Value};
use vale_agent_core::ToolDef;

pub fn build() -> Vec<ToolDef> {
    vec![tool_begin(), tool_end()]
}

fn tool_begin() -> ToolDef {
    ToolDef::new(
        "run_begin",
        "Declare the start of ONE run — one execution of your work on this device — and get back the `run_id` that names it. \
         Call it when you begin a piece of work that spans more than a single command, then pass the id to run_end when you stop. \
         The device cannot tell two AIs apart (the token identifies the device, not the caller), so this declared boundary is what lets an operator see that a set of commands and browser actions belonged to one execution rather than to the day's whole traffic. \
         The id is minted here and embeds its start time; store it and pass it back verbatim.",
        json!({
            "type": "object",
            "properties": {
                "label": {"type": "string", "description": "Optional: a short human-readable name for this run, e.g. \"provision the ONU on VLAN 100\". Shown to the operator, so keep it to a phrase. A blank label is recorded as absent, not as an empty string."},
                "goal": {"type": "string", "description": "Optional: the objective this run is pursuing, when you know it. Distinct from the session goal the OPERATOR sets — one goal can span several runs (a retry after a failure), and a run can have no goal at all."}
            }
        }),
        move |params: Value| {
            async move {
                let label = params.get("label").and_then(|v| v.as_str());
                let goal = params.get("goal").and_then(|v| v.as_str());
                let run_id = crate::runs::begin(&crate::paths::runs_dir(), label, goal);
                Ok(json!({"ok": true, "run_id": run_id}))
            }
        },
    )
}

fn tool_end() -> ToolDef {
    ToolDef::new(
        "run_end",
        "Declare that a run started with run_begin is finished, so an operator sees a closed interval instead of work that never stopped. \
         Pass back the `run_id` run_begin gave you. \
         A run left unclosed is NOT an error — the device renders it as open with the extent of the events it actually carries, because a client may still be working, may have stopped, or the agent may have restarted. \
         `known` in the reply says whether this id was ever minted here; it is information for you, never a permission.",
        json!({
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "description": "The id returned by run_begin."},
                "outcome": {"type": "string", "description": "Optional: how it ended, in a word or a short phrase (\"done\", \"failed: ONU did not register\"). Omit it rather than guessing — an absent outcome is rendered as nothing, never as a failure."}
            },
            "required": ["run_id"]
        }),
        move |params: Value| {
            async move {
                let run_id = require_str(&params, "run_id")?;
                let outcome = params.get("outcome").and_then(|v| v.as_str());
                let dir = crate::paths::runs_dir();
                // Read BEFORE appending. The append that follows may be the only
                // record of this id (the unregistered case), and asking
                // afterwards would still be correct only by luck of ordering.
                let known = crate::runs::known(&dir, &run_id);
                crate::runs::end(&dir, &run_id, outcome);
                Ok(json!({"ok": true, "known": known}))
            }
        },
    )
}
