//! Config bootstrap for the `src/main.rs` binary: create a default config if
//! missing, load it (with an optional fallback path), and ensure an auth token
//! exists.

use vale_agent_core::Config;
use std::path::Path;

/// Load the config at `path`, creating a default file first if it doesn't
/// exist; if the primary file fails to parse, try `fallback`.
///
/// Ensures an auth token is present. Returns `(config, Some(token))` when a
/// new token was generated — callers persist the config and print the token.
///
/// Never `println!` here: in Windows service mode there is no console and a
/// bare `println!` panics (see `out!`/`eout!` in main.rs). Any diagnostics
/// go through the injected `log` callback, which callers may discard.
pub fn load_or_create(
    path: &Path,
    _fallback: Option<&Path>,
    log: &dyn Fn(&str),
) -> anyhow::Result<(Config, Option<String>)> {
    if !path.exists() {
        std::fs::write(path, crate::DEFAULT_CONFIG_YAML)?;
        log(&format!("  Created default config: {}", path.display()));
    }
    let mut config = match Config::load(path) {
        Ok(c) => c,
        Err(primary_err) => {
            // The agent is the ONLY remote access to the device (gateway →
            // cloudflared → agent). An invalid config.yaml (bad port, quoted
            // value, YAML typo) previously made EVERY boot fatal forever —
            // the bad file was never quarantined, so the device went dark
            // with no remote recovery. Quarantine + rewrite a fresh default.
            log(&format!("  !! Failed to load {}: {primary_err}", path.display()));
            log("     Quarantining the bad file as config.yaml.bad and writing a fresh default.");
            let bad = path.with_extension("yaml.bad");
            let _ = std::fs::rename(path, &bad);
            std::fs::write(path, crate::DEFAULT_CONFIG_YAML)?;
            Config::load(path)?
        }
    };
    let token = config.server.ensure_token()?;
    Ok((config, token))
}
