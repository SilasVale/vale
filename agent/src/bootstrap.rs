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
            // round-119: the recovery re-parsed the quarantined file with the
            // SAME serde_yaml parser that just failed — for any YAML SYNTAX
            // error (truncated half-write, hand-edit typo, tab indentation —
            // the dominant failure class) the re-parse failed identically,
            // the token was silently discarded, and every client 401'd with
            // no recovery. Extract the token line directly instead.
            if let Ok(bad_text) = std::fs::read_to_string(&bad) {
                // round-121: (1) strip trailing inline comments (# can never
                // appear in a real hex token); (2) prefer device_token over
                // the legacy auth_token (first-match-wins could recover a
                // stale auth_token and silently discard the live one).
                // round-138: (3) accept 'device_token : value' (space before
                // the colon is legal YAML — the old strict matcher missed it
                // and silently rotated the token); (4) take the LAST
                // occurrence (a merged/appended duplicate's later line is
                // what a working parser used before the file broke — the old
                // first-wins kept a stale token and 401'd newer clients).
                let extract = |key: &str| bad_text.lines()
                    .filter_map(|l| {
                        let t = l.trim();
                        let colon = t.find(':')?;
                        if t[..colon].trim() != key { return None; }
                        let v = t[colon + 1..].split('#').next().unwrap_or("").trim();
                        let v = v.trim_matches(|c| c == '"' || c == '\'' || c == ' ');
                        Some(v.to_string())
                    })
                    // round-139: recovered values must be COMPLETE 64-hex —
                    // a tail-truncated line (power-loss on a pre-atomic file)
                    // passing the old len>=16 filter wrote a corrupt value
                    // with full confidence and kept X-Vale-Auth broken.
                    .filter(|tok| tok.len() == 64 && tok.chars().all(|c| c.is_ascii_hexdigit()))
                    .next_back(); // last wins (duplicate keys)
                let recovered = extract("device_token").or_else(|| extract("auth_token"));
                // round-138: also recover the proxy_secret — the old path
                // returned early with secret=None, and the next boot's
                // ensure_token generated a NEW secret that never matched the
                // console's registered one: gateway /panel/ injection died
                // permanently (round-104 failure class). Keep the secret on
                // the recovery boot so X-Vale-Auth stays in sync.
                let recovered_secret = extract("proxy_secret");
                if let Some(tok) = recovered {
                    let mut fresh = Config::load(path)?;
                    fresh.server.device_token = Some(tok);
                    if let Some(sec) = recovered_secret {
                        fresh.server.proxy_secret = Some(sec);
                    }
                    atomic_write(path, serde_yaml::to_string(&fresh).unwrap_or_default().as_bytes())?;
                    log("     Recovered the previous device_token from the quarantined config.");
                    return Ok((fresh, None));
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
