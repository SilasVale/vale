use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: ServerConfig,
    pub serial: SerialConfig,
    pub terminal: TerminalConfig,
    pub browser: BrowserConfig,
    pub platform: PlatformConfig,
}

/// Deployment endpoints — where this agent finds the console and the
/// release/download site. BOTH ARE OPTIONAL since the saisi decouple: a
/// purely local device (terminal + memory + MCP) needs neither. When unset,
/// cloud-dependent features degrade with explicit errors (update/design).
/// A different deployment sets them (setup.ps1 writes the section when
/// installing with non-default domains). Only the two bases are stored: the
/// update manifest is always `{download_url}/api/version` — consumers derive
/// it, so the two can never drift.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PlatformConfig {
    /// Console base (design page_view sources app.js / / / style.css).
    /// `None` = no console configured → page_view errors explicitly.
    pub console_url: Option<String>,
    /// Download-site apex; update manifest = `{download_url}/api/version`.
    /// `None` = no update channel → agent_update errors explicitly.
    pub download_url: Option<String>,
}

/// Per-session terminal output buffer, in MiB (round-69: was a hardcoded
/// compile-time constant — a serial console scrolling GPON logs wrapped in
/// seconds. Configurable now: the panel's settings writes this, the buffer
/// logic reads it at runtime; the file persists across restarts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalConfig {
    /// MiB per session before the oldest half spills to disk (memory) +
    /// spill file (same size) ≈ 2× this of recall. 1..=64.
    pub buffer_mb: u32,
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
    /// Shared secret for the gateway proxy (round-103): the gateway proxy
    /// sends this as X-Vale-Auth when proxying /panel/ so the agent can
    /// distinguish a gateway-authenticated request (safe to inject the
    /// device token) from a DIRECT public request (must NOT inject — the
    /// R102 marker header was client-spoofable). Auto-generated on first
    /// launch; the console reads it via the device-token-authenticated
    /// /api/status or registration flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SerialConfig {
    pub default_baud_rate: u32,
    pub default_timeout_ms: u64,
}

/// DEAD CONFIG — browser automation (CDP/headless-Chrome) was retired; the
/// browser extension + gateway MCP replaced it. Kept only so OLD config.yaml
/// files with a `browser:` section still parse (serde(default) swallows the
/// section; no production code reads these fields).
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
        let cfg: Config = serde_yaml::from_str::<Config>(&content)?;
        // round-138: `port: 0` parses as u16 but binds an OS EPHEMERAL port —
        // the server reports healthy while cloudflared's fixed 18080 ingress
        // connects to nothing, so the device 502s silently with no diagnostics
        // (every other bad value is loud: out-of-range → quarantine,
        // unresolvable host → bind error → fatal). Reject 0 explicitly.
        if cfg.server.port == 0 {
            anyhow::bail!("server.port must not be 0 (binds an ephemeral port — the tunnel ingress 18080 would 502)");
        }
        Ok(cfg)
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        // 18080 is the canonical port everywhere else (config.yaml, tunnel
        // ingress, setup.ps1) — a config omitting `port:` previously bound
        // 3000 and the tunnel 502'd.
        // Loopback bind: the server is only ever reached via the cloudflared
        // tunnel (ingress 127.0.0.2:18080) or locally (browser on the device,
        // page_view). Binding 0.0.0.0 exposed the whole API to the LAN, and
        // the /panel/ Host gate (which must accept Host: <device>.agent... for
        // the tunnel) is trivially spoofable with curl — a LAN client could
        // read the injected __PANEL_TOKEN__ and get RCE as SYSTEM.
        // 127.0.0.2 is cloudflared's canonical ingress for this tunnel;
        // 127.0.0.1 covers localhost. Nothing else is reachable.
        Self { host: "127.0.0.2".into(), port: 18080, name: "vale-agent".into(), device_token: None, proxy_secret: None }
    }
}

impl ServerConfig {
    /// If no token is configured, generate a 32-byte hex token and return it.
    /// Callers should persist the config after calling this.
    ///
    /// Uses `getrandom` (CSPRNG, rdrand/OS source) — never a guessable fallback,
    /// since this token gates the entire HTTP/MCP API.
    /// Returns (new_token, changed) — `changed` is true when the config
    /// needs persistence (a token OR proxy secret was generated; round-104:
    /// a pre-secret config got a fresh secret every boot that was never
    /// written, so the console's registered secret went stale and /panel/
    /// injection died permanently after the first restart).
    pub fn ensure_token(&mut self) -> anyhow::Result<(Option<String>, bool)> {
        // Treat empty/whitespace as MISSING: `device_token: ""` (the natural
        // YAML way to express "no auth") previously locked every client out —
        // Some("") passed auth only with an empty Bearer header, so all /mcp
        // and /api/* returned 401 forever with no remote recovery.
        let mut changed = false;
        if self.device_token.as_deref().is_some_and(|t| !t.trim().is_empty()) {
            // round-103: still ensure the proxy secret exists (a pre-secret
            // config gets one on this boot; persistence is the caller's).
            if self.proxy_secret.as_deref().is_some_and(|s| !s.trim().is_empty()) {
                return Ok((None, changed));
            }
            let mut b2 = [0u8; 32];
            getrandom::getrandom(&mut b2).map_err(|e| anyhow::anyhow!("failed to generate proxy secret: {e}"))?;
            let sec: String = b2.iter().map(|b| format!("{b:02x}")).collect();
            self.proxy_secret = Some(sec);
            changed = true;
            return Ok((None, changed));
        }
        let mut buf = [0u8; 32];
        getrandom::getrandom(&mut buf).map_err(|e| anyhow::anyhow!("failed to generate device token: {e}"))?;
        let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        self.device_token = Some(token.clone());
        let mut b2 = [0u8; 32];
        getrandom::getrandom(&mut b2).map_err(|e| anyhow::anyhow!("failed to generate proxy secret: {e}"))?;
        let sec: String = b2.iter().map(|b| format!("{b:02x}")).collect();
        self.proxy_secret = Some(sec);
        Ok((Some(token), true))
    }
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self { default_baud_rate: 115200, default_timeout_ms: 1000 }
    }
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self { buffer_mb: 8 }
    }
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self { page_load_timeout_secs: 30, headless_executable: None, headless_cdp_port: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn load_rejects_port_zero() {
        let dir = std::env::temp_dir().join(format!("vale-cfg-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("config.yaml");
        let mut f = std::fs::File::create(&p).unwrap();
        writeln!(f, "server:").unwrap();
        writeln!(f, "  host: \"127.0.0.2\"").unwrap();
        writeln!(f, "  port: 0").unwrap();
        let r = Config::load(&p);
        let err = r.unwrap_err();
        assert!(err.to_string().contains("port"), "rejection must mention port: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
