//! OS keychain secrets (SSH passwords) — desktop only.

#[cfg(feature = "keyring")]
mod secrets_impl {
    use vale_command_core::DeviceError;
    use keyring::Entry;
    const SERVICE: &str = "vale-command";

    fn entry(target: &str) -> Result<Entry, DeviceError> {
        Entry::new(SERVICE, &format!("ssh:{target}"))
            .map_err(|e| DeviceError::Keychain { reason: format!("create entry: {e}") })
    }

    pub fn set(target: &str, password: &str) -> Result<(), DeviceError> {
        entry(target)?.set_password(password)
            .map_err(|e| DeviceError::Keychain { reason: format!("set: {e}") })
    }
    pub fn get(target: &str) -> Result<Option<String>, DeviceError> {
        match entry(target)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(DeviceError::Keychain { reason: format!("get: {e}") }),
        }
    }
    pub fn delete(target: &str) -> Result<(), DeviceError> {
        match entry(target)?.delete_password() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(DeviceError::Keychain { reason: format!("delete: {e}") }),
        }
    }
    pub fn list() -> Vec<String> { vec![] }
}

#[cfg(not(feature = "keyring"))]
mod secrets_impl {
    use vale_command_core::DeviceError;

    pub fn set(_: &str, _: &str) -> Result<(), DeviceError> {
        Err(DeviceError::Keychain { reason: "secrets only in desktop mode".into() })
    }
    pub fn get(_: &str) -> Result<Option<String>, DeviceError> {
        Err(DeviceError::Keychain { reason: "secrets only in desktop mode".into() })
    }
    pub fn delete(_: &str) -> Result<(), DeviceError> {
        Err(DeviceError::Keychain { reason: "secrets only in desktop mode".into() })
    }
    pub fn list() -> Vec<String> { vec![] }
}

pub use secrets_impl::{delete as secret_delete, get as secret_get, list as secret_list, set as secret_set};
