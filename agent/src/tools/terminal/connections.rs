//! Saved terminal connections (round-70) — file-backed memory of
//! successfully-opened sessions so an AI (or the panel) can reconnect
//! without re-entering the target/params. The file is plaintext JSON next
//! to the exe (same trust model as vale-secrets.json: the device already
//! holds the API token in config.yaml).
//!
//! Dedup: the map is keyed by `kind:target` — reopening the same target
//! updates the entry (refreshes label/params) instead of accumulating.
//! No passwords here — SSH passwords live in the keychain (secrets.rs).

use std::path::PathBuf;

use vale_agent_core::{recover_guard, DeviceError};

fn store_path() -> PathBuf {
    crate::paths::data_dir().join("vale-connections.json")
}

fn read_all() -> serde_json::Map<String, serde_json::Value> {
    match std::fs::read_to_string(store_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => serde_json::Map::new(),
    }
}

/// round-109: serialize remember()/forget() — concurrent calls both read
/// the same map and last-writer-wins silently dropped an entry.
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn write_all(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), DeviceError> {
    let p = store_path();
    // round-109: temp + atomic rename — a crash/power loss mid-write left a
    // partial file (read_all then parsed to an empty map, losing every saved
    // connection), the same class fixed for secrets.rs/config.yaml.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(map).unwrap_or_else(|_| "{}".into()))
        .map_err(|e| DeviceError::Internal { message: format!("write {tmp:?}: {e}") })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p)
        .map_err(|e| DeviceError::Internal { message: format!("rename to {p:?}: {e}") })
}

/// Remember a successful connection. `kind` is pty|ssh|serial, `target` the
/// open target (with ?baud= etc. for serial). Deduped by `kind:target`.
pub fn remember(kind: &str, target: &str, label: &str, params: &serde_json::Map<String, serde_json::Value>) -> Result<(), DeviceError> {
    if kind == "pty" && target.is_empty() { return Ok(()); } // default shell — nothing to remember
    let _g = recover_guard(&STORE_LOCK);
    let mut map = read_all();
    let key = format!("{kind}:{target}");
    let mut entry = serde_json::Map::new();
    entry.insert("kind".into(), serde_json::Value::String(kind.to_string()));
    entry.insert("target".into(), serde_json::Value::String(target.to_string()));
    entry.insert("label".into(), serde_json::Value::String(label.to_string()));
    // Preserve the open params so a reconnect passes them through (baud,
    // parity, data/stop bits, rows/cols — the target string alone would lose
    // the ?baud= for serial if the caller passed them separately).
    // round-92: the params were persisted VERBATIM — an ssh open's "password"
    // landed in vale-connections.json in the clear and was returned by
    // terminal_saved_connections to any token holder. SSH passwords belong in
    // the keychain (secret_set/secret_get); persist everything except
    // credentials — terminal_connect_saved replays the config and ssh.rs's
    // keychain fallback supplies the password.
    let safe: serde_json::Map<String, serde_json::Value> = params
        .iter()
        .filter(|(k, _)| k.as_str() != "password")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    entry.insert("params".into(), serde_json::Value::Object(safe));
    map.insert(key, serde_json::Value::Object(entry));
    write_all(&map)
}

/// List all saved connections (sorted by key). The panel/AI renders these
/// as one-click reconnect options.
pub fn list() -> Vec<serde_json::Value> {
    let mut v: Vec<serde_json::Value> = read_all()
        .into_iter()
        .map(|(k, val)| {
            let mut e = val;
            if let Some(obj) = e.as_object_mut() {
                obj.insert("id".into(), serde_json::Value::String(k));
            }
            e
        })
        .collect();
    v.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    v
}

/// Forget a saved connection by its `kind:target` id.
pub fn forget(id: &str) -> Result<bool, DeviceError> {
    let _g = recover_guard(&STORE_LOCK);
    let mut map = read_all();
    let removed = map.remove(id).is_some();
    if removed { write_all(&map)?; }
    Ok(removed)
}
