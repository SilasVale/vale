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

use vale_agent_core::DeviceError;

fn store_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
        .join("vale-connections.json")
}

fn read_all() -> serde_json::Map<String, serde_json::Value> {
    match std::fs::read_to_string(store_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => serde_json::Map::new(),
    }
}

fn write_all(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), DeviceError> {
    let p = store_path();
    std::fs::write(&p, serde_json::to_string(map).unwrap_or_else(|_| "{}".into()))
        .map_err(|e| DeviceError::Internal { message: format!("write {p:?}: {e}") })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Remember a successful connection. `kind` is pty|ssh|serial, `target` the
/// open target (with ?baud= etc. for serial). Deduped by `kind:target`.
pub fn remember(kind: &str, target: &str, label: &str, params: &serde_json::Map<String, serde_json::Value>) -> Result<(), DeviceError> {
    if kind == "pty" && target.is_empty() { return Ok(()); } // default shell — nothing to remember
    let mut map = read_all();
    let key = format!("{kind}:{target}");
    let mut entry = serde_json::Map::new();
    entry.insert("kind".into(), serde_json::Value::String(kind.to_string()));
    entry.insert("target".into(), serde_json::Value::String(target.to_string()));
    entry.insert("label".into(), serde_json::Value::String(label.to_string()));
    // Preserve the open params so a reconnect passes them through (baud,
    // parity, data/stop bits, rows/cols — the target string alone would lose
    // the ?baud= for serial if the caller passed them separately).
    entry.insert("params".into(), serde_json::Value::Object(params.clone()));
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
    let mut map = read_all();
    let removed = map.remove(id).is_some();
    if removed { write_all(&map)?; }
    Ok(removed)
}
