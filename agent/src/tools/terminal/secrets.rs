//! OS keychain secrets (SSH passwords) — file-backed.
//!
//! The production build ships with the `keyring` feature (Windows Credential
//! Manager) but vale-agent runs as a Windows service (Session 0) where the
//! Credential Manager is unreliable, so every keyring operation falls back to
//! a file store next to the exe. Without the feature, the file store is the
//! only store. The file is plaintext JSON — acceptable here: the device
//! already holds the API token in config.yaml, and this keeps SSH passwords
//! out of the panel's localStorage.

use std::path::PathBuf;

use vale_agent_core::{recover_guard, DeviceError};

pub(crate) mod file_impl {
    use super::*;

    fn store_path() -> PathBuf {
        crate::paths::data_dir().join("vale-secrets.json")
    }

    fn read_all() -> serde_json::Map<String, serde_json::Value> {
        match std::fs::read_to_string(store_path()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => serde_json::Map::new(),
        }
    }

    /// Serialize all mutations — read-modify-write must be atomic within the
    /// process (round-101: concurrent secret_set calls both read the same
    /// map and last-writer-wins silently dropped an entry).
    static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn write_all(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), DeviceError> {
        let p = store_path();
        // round-101: temp + atomic rename — a crash/power loss mid-write
        // previously left a partial file that read_all() parsed to an EMPTY
        // map (the whole password store silently emptied; the repo's own
        // standard, fixed for vale-known-hosts.json/config.yaml in round-57).
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string(map).unwrap_or_else(|_| "{}".into()))
            .map_err(|e| DeviceError::Keychain { reason: format!("write {tmp:?}: {e}") })?;
        // Credential audit round MED-2: hardening is FAIL-CLOSED for the
        // password store — if the ACL cannot be restricted, the plaintext
        // file would sit under inherited Users:RX ACLs (every local account
        // could read SSH passwords), so refuse the write instead.
        if let Err(e) = crate::paths::harden_file(&tmp) {
            let _ = std::fs::remove_file(&tmp);
            return Err(DeviceError::Keychain {
                reason: format!("refusing to persist secrets unprotected ({e})"),
            });
        }
        #[allow(unused_must_use)]
        { /* unix permissions handled inside harden_file */ }
        std::fs::rename(&tmp, &p)
            .map_err(|e| DeviceError::Keychain { reason: format!("rename to {p:?}: {e}") })
    }

    pub(crate) fn key_of(target: &str) -> String {
        // round-101: key by the NORMALIZED connection identity — 'user@host'
        // and 'user@host:22' are the same connection (parse_ssh_target
        // defaults the port to 22), but raw-target keying made a password
        // stored under one spelling unfindable via the other (the panel
        // always builds 'user@host:22'; MCP AI commonly stores 'user@host').
        let (user, host, port) = crate::tools::terminal::parse_ssh_target(target);
        format!("ssh:{user}@{host}:{port}")
    }

    pub fn set(target: &str, password: &str) -> Result<(), DeviceError> {
        let _g = recover_guard(&STORE_LOCK);
        let mut map = read_all();
        map.insert(key_of(target), serde_json::Value::String(password.to_string()));
        write_all(&map)
    }
    pub fn get(target: &str) -> Result<Option<String>, DeviceError> {
        let map = read_all();
        // round-102: fall back to the pre-normalization raw key — entries
        // stored before key_of normalization (R101) are still findable.
        Ok(map.get(&key_of(target))
            .or_else(|| map.get(&format!("ssh:{target}")))
            .and_then(|v| v.as_str())
            .map(String::from))
    }
    pub fn delete(target: &str) -> Result<(), DeviceError> {
        let _g = recover_guard(&STORE_LOCK);
        let mut map = read_all();
        // round-126: evaluate BOTH removals unconditionally — the old `||`
        // short-circuited, so when both the normalized and legacy raw keys
        // existed, only the first was removed and the stale password
        // survived "deleted" (findable via the raw fallback).
        let removed_norm = map.remove(&key_of(target)).is_some();
        let removed_raw = map.remove(&format!("ssh:{target}")).is_some();
        if removed_norm || removed_raw { write_all(&map)?; }
        Ok(())
    }
    pub fn list() -> Vec<String> {
        read_all().keys().cloned().collect()
    }
}

#[cfg(feature = "keyring")]
mod secrets_impl {
    use super::*;
    use keyring::Entry;
    const SERVICE: &str = "vale-command";

    fn entry(target: &str) -> Result<Entry, DeviceError> {
        // round-122: key the Credential Manager entry by the SAME normalized
        // identity as the file store (round-101's key_of) — the old raw
        // "ssh:{target}" meant a password stored as 'user@host' was
        // unfindable via 'user@host:22' (the panel spelling), and
        // secret_delete left the other spelling's entry alive in the
        // keychain while reporting "deleted". Same class: IPv6 brackets and
        // hostname case.
        Entry::new(SERVICE, &file_impl::key_of(target))
            .map_err(|e| DeviceError::Keychain { reason: format!("create entry: {e}") })
    }

    pub fn set(target: &str, password: &str) -> Result<(), DeviceError> {
        match entry(target) {
            Ok(e) => match e.set_password(password) {
                Ok(()) => Ok(()),
                // Service context (Session 0) can't reach Credential Manager —
                // fall back to the file store.
                Err(_) => file_impl::set(target, password),
            },
            Err(_) => file_impl::set(target, password),
        }
    }
    pub fn get(target: &str) -> Result<Option<String>, DeviceError> {
        match entry(target) {
            Ok(e) => match e.get_password() {
                Ok(p) => Ok(Some(p)),
                Err(_) => {
                    // round-124: legacy pre-R122 entries keyed by RAW target
                    // (ssh:user@host) — mirror the file store's round-102
                    // fallback so old keychain passwords stay findable.
                    match Entry::new(SERVICE, &format!("ssh:{target}")) {
                        Ok(legacy) => match legacy.get_password() {
                            Ok(p) => Ok(Some(p)),
                            Err(_) => file_impl::get(target),
                        },
                        Err(_) => file_impl::get(target),
                    }
                }
            },
            Err(_) => file_impl::get(target),
        }
    }
    pub fn delete(target: &str) -> Result<(), DeviceError> {
        match entry(target) {
            Ok(e) => {
                // Credential audit round LOW-5: swallowing the keyring delete
                // error let secret_delete report success while the keychain
                // entry (preferred by get!) still authenticated. NoEntrySaved
                // is fine (file fallback may still hold it); anything else
                // propagates.
                let mut failed: Option<String> = None;
                match e.delete_password() {
                    Ok(()) => {}
                    Err(keyring::Error::NoEntry) => {}
                    Err(err) => failed = Some(format!("normalized: {err}")),
                }
                // round-124: also clear the legacy raw-key spelling so a
                // pre-R122 keychain entry does not survive "deleted".
                if let Ok(l) = Entry::new(SERVICE, &format!("ssh:{target}")) {
                    match l.delete_password() {
                        Ok(()) | Err(keyring::Error::NoEntry) => {}
                        Err(err) => failed = Some(format!("legacy: {err}")),
                    }
                }
                file_impl::delete(target)?;
                match failed {
                    Some(f) => Err(DeviceError::Keychain {
                        reason: format!("keychain entry survives delete ({f}) — password NOT fully removed"),
                    }),
                    None => Ok(()),
                }
            }
            Err(_) => file_impl::delete(target),
        }
    }
    pub fn list() -> Vec<String> {
        file_impl::list()
    }
}

#[cfg(not(feature = "keyring"))]
mod secrets_impl {
    pub use super::file_impl::{delete, get, list, set};
}

pub use secrets_impl::{delete as secret_delete, get as secret_get, list as secret_list, set as secret_set};
