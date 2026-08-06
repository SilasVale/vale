//! Config bootstrap for the `src/main.rs` binary: create a default config if
//! missing, load it (with an optional fallback path), and ensure an auth token
//! exists.

use vale_command_core::Config;
use std::path::Path;

/// Load the config at `path`, creating a default file first if it doesn't
/// exist; if the primary file fails to parse, try `fallback`.
///
/// Ensures an auth token is present. Returns `(config, Some(token))` when a
/// new token was generated — callers persist the config and print the token.
pub fn load_or_create(path: &Path, fallback: Option<&Path>) -> anyhow::Result<(Config, Option<String>)> {
    if !path.exists() {
        std::fs::write(path, crate::DEFAULT_CONFIG_YAML)?;
        println!("  Created default config: {}", path.display());
    }
    let mut config = Config::load(path).or_else(|_| {
        fallback
            .and_then(|p| Config::load(p).ok())
            .ok_or_else(|| anyhow::anyhow!("failed to load {}", path.display()))
    })?;
    let token = config.server.ensure_token()?;
    Ok((config, token))
}
