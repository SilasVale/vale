use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: ServerConfig,
    pub serial: SerialConfig,
    pub browser: BrowserConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub name: String,
    /// API/MCP bearer token — auto-generated on first launch, written to config.yaml.
    /// `None` means no auth (legacy mode, auto-upgraded to a generated token).
    ///
    /// Renamed from `auth_token` (0.8.5): `alias` keeps old config.yaml files
    /// working — an existing `auth_token:` line is read as `device_token`, so
    /// the token survives the rename without regeneration.
    #[serde(skip_serializing_if = "Option::is_none", alias = "auth_token")]
    pub device_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SerialConfig {
    pub default_baud_rate: u32,
    pub default_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BrowserConfig {
    pub page_load_timeout_secs: u64,
    /// Explicit headless browser executable. None = discover Edge/Chrome.
    #[serde(default)]
    pub headless_executable: Option<String>,
    /// CDP debug port for the headless browser. None = default 19623.
    #[serde(default)]
    pub headless_cdp_port: Option<u16>,
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let content = fs::read_to_string(path)?;
        Ok(serde_yaml::from_str::<Config>(&content)?)
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self { host: "0.0.0.0".into(), port: 3000, name: "vale-agent".into(), device_token: None }
    }
}

impl ServerConfig {
    /// If no token is configured, generate a 32-byte hex token and return it.
    /// Callers should persist the config after calling this.
    ///
    /// Uses `getrandom` (CSPRNG, rdrand/OS source) — never a guessable fallback,
    /// since this token gates the entire HTTP/MCP API.
    pub fn ensure_token(&mut self) -> anyhow::Result<Option<String>> {
        if self.device_token.is_some() {
            return Ok(None);
        }
        let mut buf = [0u8; 32];
        getrandom::getrandom(&mut buf).map_err(|e| anyhow::anyhow!("failed to generate device token: {e}"))?;
        let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        self.device_token = Some(token.clone());
        Ok(Some(token))
    }
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self { default_baud_rate: 115200, default_timeout_ms: 1000 }
    }
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self { page_load_timeout_secs: 30, headless_executable: None, headless_cdp_port: None }
    }
}
