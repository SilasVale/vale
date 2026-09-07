//! Cloudflared tunnel provisioning for the Settings-page Gateway card
//! (POST /api/gateway/connect → the optional free tunnel). Moved verbatim
//! out of web.rs so the HTTP surface stays auth + dispatch and the
//! cloudflared/Cloudflare infra lives in its own module seam. The RUNNING
//! cloudflared child is NOT owned here — main.rs's supervisor task owns the
//! single child; this module rewrites tunnel.yml and signals the restart via
//! [`crate::tunnel_ctl`].

use sha2::{Digest, Sha256};
use std::path::Path;

// ── Pinned cloudflared release (on-demand download integrity) ────────────
//
// The agent downloads cloudflared.exe on demand, but ONLY when
// InstallDir\tools\cloudflared.exe is absent. NOTE (verified 2026-09-06):
// the published npm tgz currently boxes NO binary (1.2.297 tgz holds only
// the exe + electron shell + vale.js), so THIS download is the live channel
// devices actually use — `vale setup` / `agent_update`'s boxed-staging arms
// are dormant until the release flow packs the binary. That makes the pin
// below load-bearing, not belt-and-braces: a wrong constant breaks ALL
// tunnel provisioning, so it was measured against the exact bytes the
// gateway proxy serves (see CLOUDFLARED_SHA256). The old gate — a
// versionless `latest` URL plus a "bigger than 1MB" size check — is NOT an
// integrity story: upstream can ship new bytes under the same URL at any
// time, and a compromised proxy would hand us an executable we then run at
// SYSTEM. So the download
// is pinned AND hash-gated, mirroring `agent_update`'s ver&&sha double bar
// (round-119): a versioned immutable URL + a sha256 constant, verified
// BEFORE the bytes are written or executed. ANY mismatch fails CLOSED
// (clear error string + error log, no write, no spawn).
//
// HOW TO UPDATE THE PIN (release flow — do all three together):
//   1. On a trusted machine, download the versioned asset for the new
//      release and record its hash:
//        curl -sL -o cloudflared-windows-amd64.exe \
//          https://github.com/cloudflare/cloudflared/releases/download/<NEW_VERSION>/cloudflared-windows-amd64.exe
//        sha256sum cloudflared-windows-amd64.exe
//   2. Set CLOUDFLARED_VERSION to <NEW_VERSION> and CLOUDFLARED_SHA256 to the
//      hash below.
//   3. If the release flow boxes the binary (gitignored staging file
//      `agent/vale-agent-npm/cloudflared.exe`, packed into the tgz),
//      stage the EXACT same bytes and confirm `cloudflared --version`
//      prints the pinned version (today the tgz carries no binary, so
//      this step is a no-op — the download path below is the channel).
//   4. `cargo test` — the unit tests below cover match, mismatch-rejection,
//      and the versioned-URL shape; `cargo clippy -- -D warnings` must stay
//      clean.
///
/// Pinned cloudflared release (`main.Version=2026.8.3`,
/// `BuildTime=2026-08-31T02:48 UTC` per its ldflags).
const CLOUDFLARED_VERSION: &str = "2026.8.3";
/// sha256 of the pinned `cloudflared-windows-amd64.exe` asset, measured
/// 2026-09-06 from the bytes the gateway proxy serves TODAY (the proxy
/// streams the upstream `latest` asset unmodified, so this equals the
/// versioned-asset bytes while `latest` stays 2026.8.3). Re-measure per the
/// steps above whenever CLOUDFLARED_VERSION moves — a stale pin fails CLOSED
/// (that refusal IS the drift signal, not a bug).
const CLOUDFLARED_SHA256: &str = "83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae";

/// Immutable upstream asset for the pinned release (GitHub release assets
/// never change under a versioned path — unlike `.../releases/latest/...`).
fn cloudflared_download_url() -> String {
    format!(
        "https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe"
    )
}

/// Reachability fallback for devices where GitHub is blocked (GFW etc.) —
/// the pre-existing gateway proxy of the official release. STILL hash-gated:
/// it tracks `latest`, so once upstream moves past the pin a proxied
/// download fails CLOSED with the mismatch log below (the signal to run the
/// HOW-TO-UPDATE steps above), exactly like a tampered binary would.
const CLOUDFLARED_PROXY_URL: &str = "https://agent.saisi.online/vale-agent/cloudflared.exe";

/// Lowercase hex encoding (sha256 digest display/comparison — same shape as
/// the update plugin's helper; kept local so this module has no cross-plugin
/// coupling).
fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// True only when `bytes` hash to `expected_hex`. Malformed expectations
/// (wrong length, non-hex) NEVER match — fail closed, never fail open.
pub(crate) fn verify_cloudflared_bytes(bytes: &[u8], expected_hex: &str) -> bool {
    if expected_hex.len() != 64 || !expected_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    hex_encode(&Sha256::digest(bytes)).eq_ignore_ascii_case(expected_hex)
}

/// Download one candidate URL and gate it: 2xx + sane size + pinned sha256.
/// Err carries the human-readable reason (surfaced in the API status string
/// and the error log — an operator must see WHY provisioning refused).
async fn download_and_verify(client: &reqwest::Client, url: &str) -> Result<bytes::Bytes, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let resp = resp
        .error_for_status()
        .map_err(|e| format!("bad status: {e}"))?;
    let bytes = resp.bytes().await.map_err(|e| format!("read error: {e}"))?;
    if bytes.len() <= 1_000_000 {
        return Err(format!("unexpected small payload ({} bytes)", bytes.len()));
    }
    if !verify_cloudflared_bytes(&bytes, CLOUDFLARED_SHA256) {
        tracing::error!(
            "[vale-agent] provision_tunnel: cloudflared sha256 MISMATCH from {url} \
             (want pinned {CLOUDFLARED_VERSION} {CLOUDFLARED_SHA256}, got {}) — \
             refusing unverifiable binary (no write, no spawn)",
            hex_encode(&Sha256::digest(&bytes)),
        );
        return Err("sha256 mismatch — refusing unverifiable binary".to_string());
    }
    Ok(bytes)
}

/// Write already-verified bytes into place (atomic: a kill mid-write must not
/// leave a half-written exe that the supervisor would then spawn). The hash
/// is re-checked here so NO caller can stage unverified bytes by accident —
/// production passes CLOUDFLARED_SHA256; tests pass their fixture digest.
pub(crate) fn write_verified_bytes(
    dest: &Path,
    bytes: &[u8],
    expected_sha256_hex: &str,
) -> Result<(), String> {
    if !verify_cloudflared_bytes(bytes, expected_sha256_hex) {
        tracing::error!(
            "[vale-agent] provision_tunnel: refusing to write {} — \
             integrity check failed (no write performed)",
            dest.display(),
        );
        return Err(
            "cloudflared integrity check failed — refusing unverifiable binary".to_string(),
        );
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("tools dir create failed: {e}"))?;
    }
    crate::bootstrap::atomic_write(dest, bytes)
        .map_err(|e| format!("cloudflared download write failed: {e}"))?;
    Ok(())
}

/// Provision the free cloudflared tunnel from the Settings-page Gateway card:
/// login with the token, create the tunnel, route DNS, write tunnel.yml, and
/// spawn cloudflared (agent-owned, spawn-if-absent model). Returns a status
/// string for the API response. Best-effort — failures are reported, not fatal.
/// `port` is the agent's configured bind port — the ingress must point where
/// the agent actually listens (a hardcoded 18080 502s custom-port installs).
pub(crate) async fn provision_tunnel(cf_token: &str, port: u16) -> String {
    let install_dir = crate::paths::install_dir();
    let cf = install_dir.join("tools").join("cloudflared.exe");
    if !cf.exists() {
        // tools\cloudflared.exe absent (the boxed tgz binary normally covers
        // this) — download the PINNED official Windows binary on demand
        // (one-time). Pinned version + sha256 (see the constants above): the
        // bytes are verified BEFORE they are written or executed, mirroring
        // agent_update's ver&&sha bar. Fail closed on any mismatch.
        tracing::info!(
            "[vale-agent] provision_tunnel: downloading pinned cloudflared {CLOUDFLARED_VERSION}"
        );
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
        {
            Ok(c) => c,
            Err(_) => return "cloudflared download client build failed".to_string(),
        };
        // Versioned upstream first; the gateway proxy (same host the old
        // code used) as the reachability fallback. EVERY candidate is
        // hash-gated inside download_and_verify — an unverified binary can
        // never reach the write below.
        let mut verified: Option<bytes::Bytes> = None;
        let mut last_err = String::new();
        for url in [
            cloudflared_download_url(),
            CLOUDFLARED_PROXY_URL.to_string(),
        ] {
            match download_and_verify(&client, &url).await {
                Ok(b) => {
                    verified = Some(b);
                    break;
                }
                Err(e) => {
                    tracing::warn!(
                        "[vale-agent] provision_tunnel: cloudflared candidate failed ({url}): {e}"
                    );
                    last_err = format!("{url}: {e}");
                }
            }
        }
        let bytes = match verified {
            Some(b) => b,
            None => return format!("cloudflared download failed ({last_err})"),
        };
        if let Err(e) = write_verified_bytes(&cf, &bytes, CLOUDFLARED_SHA256) {
            return e;
        }
        tracing::info!(
            "[vale-agent] provision_tunnel: cloudflared {CLOUDFLARED_VERSION} verified (sha256 ok, {} bytes)",
            bytes.len()
        );
    }
    let hostname = std::fs::read_to_string(install_dir.join("vale-agent.hostname"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    // Supervision audit #5: hostname flows into cloudflared ARGV and an
    // unquoted YAML line. A value starting with '-' becomes a FLAG, an
    // embedded newline injects keys (e.g. a different `service:` target).
    // Validate to bare subdomain charset before anything else touches it.
    let host_ok = |v: &str| -> bool {
        !v.is_empty()
            && v.len() <= 253
            && !v.starts_with('-')
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    };
    if !host_ok(&hostname) {
        return "cannot provision: vale-agent.hostname missing or invalid (set it via `vale setup --hostname <sub>` first)".to_string();
    }
    if !host_ok(cf_token) {
        return "cannot provision: gateway returned a malformed API token".to_string();
    }
    let tunnel_name = format!(
        "vale-agent-{}",
        hostname.split('.').next().unwrap_or("device")
    );
    // 1. login with token. cloudflared writes cert.pem to %USERPROFILE%\.cloudflared\
    //    — under the SYSTEM service that is systemprofile, and `tunnel login
    //    --token` may not write it there reliably. After login, ensure the
    //    credentials exist: copy from a real user profile if missing.
    let login = tokio::process::Command::new(&cf)
        .args(["tunnel", "login", "--token", cf_token])
        .output()
        .await;
    let login_ok = login.map(|o| o.status.success()).unwrap_or(false);
    if !login_ok {
        return "cloudflared login failed".to_string();
    }
    ensure_cf_credentials().await;
    // 2. create tunnel (idempotent-ish: list first). The tunnel ID is a
    //    canonical UUID — parse it with the dash-delimited regex from the
    //    `tunnel list` output; `tunnel create` prints the full ID on success,
    //    so if the list parse fails (table truncation etc.) grab it from the
    //    create output directly.
    let list = tokio::process::Command::new(&cf)
        .args(["tunnel", "list"])
        .output()
        .await;
    let list_text = list
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let mut tunnel_id = find_tunnel_id_by_name(&list_text, &tunnel_name);
    if tunnel_id.is_none() {
        let created = tokio::process::Command::new(&cf)
            .args(["tunnel", "create", &tunnel_name])
            .output()
            .await;
        let (created_text, created_err) = match created {
            Ok(o) => (
                String::from_utf8_lossy(&o.stdout).to_string(),
                String::from_utf8_lossy(&o.stderr).to_string(),
            ),
            Err(_) => (String::new(), String::new()),
        };
        tunnel_id = parse_tunnel_id(&created_text).or_else(|| parse_tunnel_id(&created_err));
        if tunnel_id.is_none() {
            let list2 = tokio::process::Command::new(&cf)
                .args(["tunnel", "list"])
                .output()
                .await;
            let list2_text = list2
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default();
            tunnel_id = find_tunnel_id_by_name(&list2_text, &tunnel_name);
        }
    }
    let Some(id) = tunnel_id else {
        // Include the raw list output in the error so a device report
        // pinpoints WHY parsing failed (auth? empty list? different format?).
        let diag = format!(
            "could not determine tunnel id for '{tunnel_name}'. login_ok={} list_out={:?}",
            login_ok,
            &list_text[..list_text.len().min(400)],
        );
        return diag;
    };
    // 3. DNS route (best-effort)
    let _ = tokio::process::Command::new(&cf)
        .args(["tunnel", "route", "dns", &tunnel_name, &hostname])
        .output()
        .await;
    // 3b. Update the tunnel's REMOTE config via the Cloudflare API — cloudflared
    //     prefers the remote config when one exists, and a stale remote (old
    //     127.0.0.2 ingress) would override the local tunnel.yml. Point the
    //     remote ingress at 127.0.0.1 so both agree.
    update_remote_config(cf_token, &id, &hostname, port).await;
    // 4. write tunnel.yml (single location, agent spawns it on boot)
    let cred = std::env::var("USERPROFILE")
        .map(|u| format!(r"{u}\.cloudflared\{id}.json"))
        .unwrap_or_else(|_| format!(".cloudflared/{id}.json"));
    let yml = format!(
        "tunnel: {id}\ncredentials-file: {cred}\nallow-remote-config: false\ningress:\n  - hostname: {hostname}\n    service: {}\n  - service: http_status:404\n",
        ingress_service(port)
    );
    let cfg_path = install_dir.join("tunnel.yml");
    // Supervision audit #5: atomic (the boot-spawned cloudflared may be
    // mid-read) — and #1: DO NOT spawn a second tunnel here; the supervisor
    // task owns the single child and restarts on the generation bump.
    let _ = crate::bootstrap::atomic_write(&cfg_path, yml.as_bytes());
    crate::tunnel_ctl::request_restart();
    format!("ok ({hostname})")
}

// Tunnel-ID output parsers (round-426: hoisted to module level from
// provision_tunnel verbatim so the hand-rolled scanner is unit-testable;
// the only callers are the two spots above).
fn parse_tunnel_id(text: &str) -> Option<String> {
    // Canonical UUID with dashes: 8-4-4-4-12 hex. Scan char windows to
    // avoid pulling in the regex crate (cargo-xwin build stays lean).
    let bytes = text.as_bytes();
    let is_hex = |c: u8| c.is_ascii_hexdigit();
    let mut i = 0;
    while i + 36 <= bytes.len() {
        let seg = [8usize, 4, 4, 4, 12];
        let mut ok = true;
        let mut pos = i;
        for (si, len) in seg.iter().enumerate() {
            for _ in 0..*len {
                if !is_hex(bytes[pos]) {
                    ok = false;
                    break;
                }
                pos += 1;
            }
            if !ok {
                break;
            }
            if si < seg.len() - 1 {
                if bytes[pos] != b'-' {
                    ok = false;
                    break;
                }
                pos += 1;
            }
        }
        if ok {
            return Some(text[i..i + 36].to_string());
        }
        i += 1;
    }
    None
}
// `tunnel list` WITHOUT --name: the --name filter behaves differently
// across cloudflared versions and can return empty — match the NAME
// column ourselves (ID is col 1, NAME is col 2 in the table).
fn find_tunnel_id_by_name(text: &str, name: &str) -> Option<String> {
    for line in text.lines() {
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.len() >= 2 && toks[1] == name {
            if let Some(id) = parse_tunnel_id(toks[0]) {
                return Some(id);
            }
        }
    }
    None
}

/// Make sure the SYSTEM agent's cloudflared credentials exist. `tunnel
/// login --token` under SYSTEM writes to systemprofile\.cloudflared — if
/// that failed, copy cert.pem + tunnel credentials from a real user profile
/// (Administrator runs the console/install flows and already has them).
async fn ensure_cf_credentials() {
    let sys_cf = std::env::var("USERPROFILE")
        .map(|u| std::path::PathBuf::from(u).join(".cloudflared"))
        .unwrap_or_default();
    if sys_cf.join("cert.pem").exists() {
        return; // already authenticated
    }
    // Candidate user profiles to copy from.
    for user in ["Administrator", "admin", "user"] {
        let src = std::path::PathBuf::from(r"C:\Users")
            .join(user)
            .join(".cloudflared");
        let cert = src.join("cert.pem");
        if cert.exists() {
            let _ = std::fs::create_dir_all(&sys_cf);
            if std::fs::copy(&cert, sys_cf.join("cert.pem")).is_ok() {
                // Copy all *.<uuid>.json credentials too.
                if let Ok(rd) = std::fs::read_dir(&src) {
                    for e in rd.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        if name.ends_with(".json") && e.path().is_file() {
                            let _ = std::fs::copy(e.path(), sys_cf.join(&name));
                        }
                    }
                }
                tracing::info!(
                    "[vale-agent] provision_tunnel: copied cloudflared credentials from {user}"
                );
                return;
            }
        }
    }
    tracing::warn!("[vale-agent] provision_tunnel: no cert.pem found in any user profile — tunnel auth may fail");
}

/// Ingress service URL for the agent's configured port (custom ports must
/// reach the agent where it actually listens — a hardcoded 18080 here 502s
/// every non-default install).
fn ingress_service(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Update a tunnel's REMOTE config (Cloudflare API) so its ingress points at
/// the agent's configured port. cloudflared prefers the remote config over the local file
/// when one exists; a stale remote (e.g. an old 127.0.0.2 ingress) would keep
/// proxying to a dead address (502) no matter what tunnel.yml says.
async fn update_remote_config(cf_token: &str, tunnel_id: &str, hostname: &str, port: u16) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    // 1. Resolve the account id from the token.
    let acc = match client
        .get("https://api.cloudflare.com/client/v4/accounts")
        .header("authorization", format!("Bearer {cf_token}"))
        .send()
        .await
    {
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(j) => j,
            Err(_) => return,
        },
        Err(_) => return,
    };
    let account_id = match acc["result"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|x| x["id"].as_str())
    {
        Some(v) => v.to_string(),
        None => return,
    };
    // 2. PUT the ingress config.
    let body = serde_json::json!({
        "config": {
            "ingress": [
                { "hostname": hostname, "service": ingress_service(port) },
                { "service": "http_status:404" }
            ]
        }
    });
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations"
    );
    match client
        .put(&url)
        .header("authorization", format!("Bearer {cf_token}"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
    {
        Ok(r) => {
            let ok = r.status().is_success();
            tracing::info!("[vale-agent] provision_tunnel: remote config update ok={ok}");
        }
        Err(_) => {
            tracing::warn!("[vale-agent] provision_tunnel: remote config update failed (network)")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingress_service_follows_the_configured_port() {
        assert_eq!(ingress_service(18080), "http://127.0.0.1:18080");
        assert_eq!(ingress_service(7740), "http://127.0.0.1:7740");
        // A custom port must never silently fall back to the default.
        assert!(!ingress_service(7740).contains("18080"));
    }

    /// sha256("abc") — FIPS vector. Hardcodes the digest so the hex-encode +
    /// compare path is NOT tautological (a test that recomputes the expected
    /// with the same code could never catch an encoding bug).
    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn verify_accepts_exact_digest() {
        assert!(verify_cloudflared_bytes(b"abc", ABC_SHA256));
    }

    #[test]
    fn verify_is_case_insensitive_on_hex() {
        assert!(verify_cloudflared_bytes(b"abc", &ABC_SHA256.to_uppercase()));
    }

    #[test]
    fn verify_rejects_tampered_and_malformed() {
        // One-bit payload change.
        assert!(!verify_cloudflared_bytes(b"abd", ABC_SHA256));
        // All-zero digest (wrong value, right shape).
        assert!(!verify_cloudflared_bytes(
            b"abc",
            "0000000000000000000000000000000000000000000000000000000000000000"
        ));
        // Malformed expectations fail CLOSED, never open.
        assert!(!verify_cloudflared_bytes(b"abc", ""));
        assert!(!verify_cloudflared_bytes(b"abc", "not-hex"));
        assert!(!verify_cloudflared_bytes(b"abc", &ABC_SHA256[..63]));
    }

    #[test]
    fn pinned_constants_are_well_formed() {
        // A malformed constant would fail CLOSED on every provision (brick
        // the tunnel path) — pin the shape here so a bad edit fails `cargo
        // test`, not a device at midnight.
        assert!(!CLOUDFLARED_VERSION.is_empty());
        assert!(!CLOUDFLARED_VERSION.contains("latest"));
        assert_eq!(CLOUDFLARED_SHA256.len(), 64);
        assert!(CLOUDFLARED_SHA256.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn download_url_is_versioned_and_immutable() {
        let url = cloudflared_download_url();
        assert!(
            url.contains(CLOUDFLARED_VERSION),
            "versioned URL must name the pin: {url}"
        );
        assert!(
            url.ends_with("cloudflared-windows-amd64.exe"),
            "official asset name: {url}"
        );
        assert!(!url.contains("latest"), "never the mutable latest: {url}");
    }

    fn test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("vale-tunnel-cf-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn write_rejects_tampered_bytes_without_touching_disk() {
        let dir = test_dir("reject");
        let dest = dir.join("tools").join("cloudflared.exe");
        let err = write_verified_bytes(&dest, b"tampered-bytes", ABC_SHA256).unwrap_err();
        assert!(
            err.contains("integrity check failed"),
            "clear fail-closed message: {err}"
        );
        assert!(!dest.exists(), "mismatched bytes must never be written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_stores_verified_bytes_intact() {
        // Happy path: the expected digest is the TRUE digest of the fixture
        // (computed with sha2 directly — this test covers the write + the
        // verify-then-write wiring, while verify_* above covers the digest
        // itself against the hardcoded FIPS vector).
        let dir = test_dir("accept");
        let dest = dir.join("tools").join("cloudflared.exe");
        let fixture = b"vale-test-cloudflared-fixture-bytes";
        let expected = hex_encode(&Sha256::digest(fixture));
        write_verified_bytes(&dest, fixture, &expected).expect("matching bytes must stage");
        assert_eq!(
            std::fs::read(&dest).expect("staged file readable"),
            fixture,
            "staged bytes must equal the verified download"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_tunnel_id_finds_canonical_uuid() {
        let id = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
        assert_eq!(
            parse_tunnel_id(&format!("created tunnel {id} with id")),
            Some(id.to_string())
        );
        // table row shape
        assert_eq!(
            parse_tunnel_id(&format!("{id}  vale-d1  2026-01-01")),
            Some(id.to_string())
        );
    }

    #[test]
    fn parse_tunnel_id_rejects_non_uuid() {
        assert_eq!(parse_tunnel_id("no uuid here"), None);
        assert_eq!(parse_tunnel_id(""), None);
        // dashless 32-hex is not canonical
        assert_eq!(parse_tunnel_id("f47ac10b58cc4372a5670e02b2c3d479"), None);
        // truncated
        assert_eq!(parse_tunnel_id("f47ac10b-58cc-4372-a567"), None);
        // non-hex in a dash-shaped slot
        assert_eq!(
            parse_tunnel_id("f47ac10b-58cc-4372-a567-0e02b2c3d47z"),
            None
        );
    }

    #[test]
    fn find_tunnel_id_by_name_matches_name_column() {
        let id = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
        let other = "aaaaaaaa-1111-2222-3333-444444444444";
        let table = format!("ID  NAME  CREATED\n{other}  other-tunnel  x\n{id}  vale-d1  y\n");
        assert_eq!(
            find_tunnel_id_by_name(&table, "vale-d1"),
            Some(id.to_string())
        );
        assert_eq!(find_tunnel_id_by_name(&table, "missing"), None);
        // header row itself never matches (NAME != a real name… unless asked)
        assert_eq!(find_tunnel_id_by_name("ID  NAME\n", "NAME"), None);
        // name match with a garbage id column is skipped, not returned
        assert_eq!(find_tunnel_id_by_name("oops  vale-d1\n", "vale-d1"), None);
    }
}
