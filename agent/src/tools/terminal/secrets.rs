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

/// DPAPI envelope for the file secret store (Windows): seals the JSON map
/// with CryptProtectData (user-scoped, UI-forbidden) so a file copied off
/// the box — or read via a partial-ACL mishap — is inert. The ACL hardening
/// in write_all stays the FIRST line; this is the belt under the braces.
/// Files without the magic stay plaintext-readable (migration rewrites them
/// sealed on the next mutation).
#[cfg(windows)]
mod dpapi {
    const MAGIC: &[u8] = b"VALEDPA1";

    pub fn is_sealed(bytes: &[u8]) -> bool {
        bytes.starts_with(MAGIC)
    }

    pub fn seal(plain: &[u8]) -> Option<Vec<u8>> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{
            CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
        };
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return None;
        }
        let mut v = MAGIC.to_vec();
        v.extend_from_slice(unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) });
        unsafe { LocalFree(out.pbData as _) };
        Some(v)
    }

    pub fn open(bytes: &[u8]) -> Option<Vec<u8>> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{
            CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
        };
        let payload = bytes.get(MAGIC.len()..)?;
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: payload.len() as u32,
            pbData: payload.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return None;
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as _) };
        Some(v)
    }
}

pub(crate) mod file_impl {
    use super::*;

    fn store_path() -> PathBuf {
        #[cfg(test)]
        if let Some(d) = TEST_DIR.with(|d| d.borrow().clone()) {
            return d.join("vale-secrets.json");
        }
        crate::paths::data_dir().join("vale-secrets.json")
    }

    // Test-only store directory (file_impl CRUD tests without touching the
    // real DataDir).
    #[cfg(test)]
    thread_local! {
        pub(crate) static TEST_DIR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    }

    fn read_all() -> serde_json::Map<String, serde_json::Value> {
        let Ok(bytes) = std::fs::read(store_path()) else { return serde_json::Map::new() };
        #[cfg(windows)]
        {
            if dpapi::is_sealed(&bytes) {
                return match dpapi::open(&bytes) {
                    Some(plain) => serde_json::from_slice(&plain).unwrap_or_default(),
                    // Wrong user / corrupted blob: NO silent empty-store write
                    // later could clobber it — reads degrade to empty, but
                    // write paths refuse below when unseal failed hard.
                    None => serde_json::Map::new(),
                };
            }
        }
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    /// Serialize all mutations — read-modify-write must be atomic within the
    /// process (round-101: concurrent secret_set calls both read the same
    /// map and last-writer-wins silently dropped an entry).
    static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn write_all(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), DeviceError> {
        write_all_with(map, &crate::paths::harden_file)
    }

    /// Seam (coverage audit row 7): the FAIL-CLOSED contract — if the ACL
    /// hardener errors, the plaintext store must NOT be renamed into place
    /// (every local account could read SSH passwords through the inherited
    /// ACLs). Extracted so the refuse-path is unit-testable without making
    /// icacls fail on demand.
    pub(crate) fn write_all_with(
        map: &serde_json::Map<String, serde_json::Value>,
        harden: &dyn Fn(&std::path::Path) -> Result<(), std::io::Error>,
    ) -> Result<(), DeviceError> {
        let p = store_path();
        // round-101: temp + atomic rename — a crash/power loss mid-write
        // previously left a partial file that read_all() parsed to an EMPTY
        // map (the whole password store silently emptied; the repo's own
        // standard, fixed for vale-known-hosts.json/config.yaml in round-57).
        let tmp = p.with_extension("json.tmp");
        let json = serde_json::to_vec(map).unwrap_or_else(|_| b"{}".to_vec());
        #[cfg(windows)]
        let payload = dpapi::seal(&json).unwrap_or(json); // DPAPI outage must not brick storage (ACL line still holds)
        #[cfg(not(windows))]
        let payload = json;
        std::fs::write(&tmp, payload)
            .map_err(|e| DeviceError::Keychain { reason: format!("write {tmp:?}: {e}") })?;
        // Credential audit round MED-2: hardening is FAIL-CLOSED for the
        // password store — if the ACL cannot be restricted, the plaintext
        // file would sit under inherited Users:RX ACLs (every local account
        // could read SSH passwords), so refuse the write instead.
        if let Err(e) = harden(&tmp) {
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
        // Unit-test follow-up: the RAW fallback only matched the IDENTICAL
        // spelling, so an entry stored as "ssh:user@host" (legacy, port
        // absent) was still invisible to the panel's "user@host:22" query.
        // Third shape: explicit port-22 stripped.
        let stripped = target.strip_suffix(":22").map(|s| format!("ssh:{s}"));
        Ok(map
            .get(&key_of(target))
            .or_else(|| map.get(&format!("ssh:{target}")))
            .or_else(|| stripped.as_deref().and_then(|k| map.get(k)))
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
        let stripped = target.strip_suffix(":22").map(|s| format!("ssh:{s}"));
        let removed_norm = map.remove(&key_of(target)).is_some();
        let removed_raw = map.remove(&format!("ssh:{target}")).is_some();
        let removed_strip = stripped.as_deref().map(|k| map.remove(k).is_some()).unwrap_or(false);
        if removed_norm || removed_raw || removed_strip { write_all(&map)?; }
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
                    // Audit round: + port-stripped shape (a "user@host:22"
                    // query must find a legacy "ssh:user@host" CM entry,
                    // same gap closed in file_impl::get).
                    let raw = format!("ssh:{target}");
                    for probe in [raw]
                        .into_iter()
                        .chain(target.strip_suffix(":22").map(|t| format!("ssh:{t}")))
                    {
                        if let Ok(e) = Entry::new(SERVICE, &probe) {
                            if let Ok(p) = e.get_password() {
                                return Ok(Some(p));
                            }
                        }
                    }
                    file_impl::get(target)
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
                let raw = format!("ssh:{target}");
                let mut probes: Vec<String> = vec![raw.clone()];
                if let Some(stripped) = target.strip_suffix(":22") {
                    probes.push(format!("ssh:{stripped}"));
                }
                for probe in probes {
                    if let Ok(l) = Entry::new(SERVICE, &probe) {
                        match l.delete_password() {
                            Ok(()) | Err(keyring::Error::NoEntry) => {}
                            Err(err) => failed = Some(format!("legacy: {err}")),
                        }
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

#[cfg(test)]
mod file_store_tests {
    //! Credential audit follow-up: file_impl had ZERO coverage (the
    //! keyring-branch compile-miss proved why this matters). TEST_DIR
    //! isolates each test thread's store file.
    use super::file_impl::{self, TEST_DIR, write_all_with};

    fn isolated(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("vale-sec-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TEST_DIR.with(|d| *d.borrow_mut() = Some(dir.clone()));
        dir
    }

    #[test]
    fn crud_roundtrip() {
        let dir = isolated("crud");
        file_impl::set("user@host:22", "pw-A").unwrap();
        assert_eq!(file_impl::get("user@host:22").unwrap().as_deref(), Some("pw-A"));
        // normalized identity: the OTHER port-spelling finds the SAME entry
        assert_eq!(file_impl::get("user@host").unwrap().as_deref(), Some("pw-A"));
        file_impl::set("user@host:22", "pw-B").unwrap();
        assert_eq!(file_impl::get("user@host:22").unwrap().as_deref(), Some("pw-B"));
        file_impl::delete("user@host").unwrap();
        assert_eq!(file_impl::get("user@host:22").unwrap(), None);
        assert!(file_impl::list().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_raw_key_is_findable_and_deletable() {
        let dir = isolated("legacy");
        // pre-normalization file: raw "ssh:user@host" key only
        std::fs::write(
            dir.join("vale-secrets.json"),
            r#"{"ssh:user@host":"old-pw"}"#,
        )
        .unwrap();
        assert_eq!(file_impl::get("user@host:22").unwrap().as_deref(), Some("old-pw"));
        assert_eq!(file_impl::get("user@host").unwrap().as_deref(), Some("old-pw"));
        // delete must clear BOTH spellings (round-126 class)
        file_impl::set("user@host:22", "new-pw").unwrap(); // creates normalized twin
        file_impl::delete("user@host").unwrap();
        assert_eq!(file_impl::get("user@host").unwrap(), None);
        let left = std::fs::read_to_string(dir.join("vale-secrets.json")).unwrap();
        assert!(!left.contains("ssh:user@host"), "raw key survived delete: {left}");
        // AND the third shape: legacy raw entry found + purged via the :22 query
        std::fs::write(dir.join("vale-secrets.json"), r#"{"ssh:z@y":"lz"}"#).unwrap();
        assert_eq!(file_impl::get("z@y:22").unwrap().as_deref(), Some("lz"));
        file_impl::delete("z@y:22").unwrap();
        assert_eq!(file_impl::get("z@y").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fail_closed_refuses_write_when_harden_errors() {
        // row 7: harden failure => Err, no tmp left behind, ORIGINAL file
        // untouched (a half-trustworthy store beats a world-readable one).
        let dir = isolated("failclosed");
        let store = dir.join("vale-secrets.json");
        std::fs::write(&store, b"{\"keep\":\"me\"}").unwrap();
        let mut map = serde_json::Map::new();
        map.insert("ssh:x".into(), serde_json::json!("secret"));
        let err = write_all_with(&map, &|_| Err(std::io::Error::other("no icacls here")))
            .expect_err("must refuse");
        assert!(err.to_string().contains("refusing to persist secrets"), "{err}");
        assert!(!dir.join("vale-secrets.json.tmp").exists(), "tmp must be cleaned");
        assert_eq!(std::fs::read(&store).unwrap(), b"{\"keep\":\"me\"}", "original intact");
        // and the happy path still lands through the same seam
        write_all_with(&map, &|_| Ok(())).unwrap();
        assert!(std::fs::read_to_string(&store).unwrap().contains("ssh:x"));
    }

    #[test]
    fn plaintext_file_reads_when_not_sealed() {
        // non-Windows has no seal at all; on Windows a pre-DPAPI plaintext
        // file must still read until the next write migrates it.
        let dir = isolated("plain");
        std::fs::write(dir.join("vale-secrets.json"), r#"{"ssh:a@b:22":"legacy"}"#).unwrap();
        assert_eq!(file_impl::get("a@b").unwrap().as_deref(), Some("legacy"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
