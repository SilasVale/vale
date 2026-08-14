//! Config bootstrap for the `src/main.rs` binary: create a default config if
//! missing, load it (with an optional fallback path), and ensure an auth token
//! exists.

use vale_agent_core::Config;
use std::io::Write;
use std::path::Path;

/// Atomic file write (round-57): temp file in the SAME directory + rename.
/// Windows rename is atomic on the same volume (MoveFileEx); the old
/// std::fs::write (truncate + write) left a half-written config on power
/// loss, which the next boot quarantined and replaced with a FRESH token —
/// every client 401'd with no recovery path.
pub fn atomic_write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(".{}.tmp", path.file_name().and_then(|n| n.to_str()).unwrap_or("config")));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

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
        atomic_write(path, crate::DEFAULT_CONFIG_YAML.as_bytes())?;
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
            atomic_write(path, crate::DEFAULT_CONFIG_YAML.as_bytes())?;
            // Round-57: the old device_token lives in the quarantined file —
            // a crash window (half-written config) must NOT rotate the token
            // and 401 every client. Recover it into the fresh default.
            if let Ok(bad_text) = std::fs::read_to_string(&bad) {
                if let Ok(old) = serde_yaml::from_str::<vale_agent_core::Config>(&bad_text) {
                    if let Some(tok) = old.server.device_token {
                        if tok.len() >= 16 {
                            let mut fresh = Config::load(path)?;
                            fresh.server.device_token = Some(tok);
                            atomic_write(path, serde_yaml::to_string(&fresh).unwrap_or_default().as_bytes())?;
                            log("     Recovered the previous device_token from the quarantined config.");
                            return Ok((fresh, None));
                        }
                    }
                }
            }
            Config::load(path)?
        }
    };
    let (token, changed) = config.server.ensure_token()?;
    if changed {
        // round-104: a freshly generated proxy secret (or token) must be
        // persisted NOW — the old code only persisted on new-token, so a
        // pre-secret config rotated the secret every boot without saving it
        // and the console's registered secret went permanently stale.
        let yaml = serde_yaml::to_string(&config).unwrap_or_default();
        atomic_write(path, yaml.as_bytes())?;
    }
    Ok((config, token))
}
