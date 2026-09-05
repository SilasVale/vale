//! Cloudflared tunnel provisioning for the Settings-page Gateway card
//! (POST /api/gateway/connect → the optional free tunnel). Moved verbatim
//! out of web.rs so the HTTP surface stays auth + dispatch and the
//! cloudflared/Cloudflare infra lives in its own module seam. The RUNNING
//! cloudflared child is NOT owned here — main.rs's supervisor task owns the
//! single child; this module rewrites tunnel.yml and signals the restart via
//! [`crate::tunnel_ctl`].

/// Provision the free cloudflared tunnel from the Settings-page Gateway card:
/// login with the token, create the tunnel, route DNS, write tunnel.yml, and
/// spawn cloudflared (agent-owned, spawn-if-absent model). Returns a status
/// string for the API response. Best-effort — failures are reported, not fatal.
pub(crate) async fn provision_tunnel(cf_token: &str) -> String {
    let install_dir = crate::paths::install_dir();
    let cf = install_dir.join("tools").join("cloudflared.exe");
    if !cf.exists() {
        // cloudflared is NOT bundled (the npm package stays small) — download
        // the official Windows binary on demand (same source the installer
        // used; ~54MB, one-time).
        tracing::info!(
            "[vale-agent] provision_tunnel: downloading cloudflared via the gateway proxy"
        );
        // Download through the vale-gate proxy (agent.saisi.online) — the
        // device can reach our worker even when GitHub is blocked (GFW etc.).
        // The worker streams the official GitHub release back to us.
        let url = "https://agent.saisi.online/vale-agent/cloudflared.exe";
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
        {
            Ok(c) => c,
            Err(_) => return "cloudflared download client build failed".to_string(),
        };
        let resp = match client.get(url).send().await {
            Ok(r) => r,
            Err(_) => {
                return "cloudflared download failed (official GitHub release unreachable)"
                    .to_string()
            }
        };
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(_) => return "cloudflared download failed (read error)".to_string(),
        };
        if bytes.len() <= 1_000_000 {
            return "cloudflared download failed (unexpected small payload)".to_string();
        }
        let _ = std::fs::create_dir_all(install_dir.join("tools"));
        if std::fs::write(&cf, &bytes).is_err() {
            return "cloudflared download write failed".to_string();
        }
        tracing::info!(
            "[vale-agent] provision_tunnel: cloudflared downloaded ({} bytes)",
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
    update_remote_config(cf_token, &id, &hostname).await;
    // 4. write tunnel.yml (single location, agent spawns it on boot)
    let cred = std::env::var("USERPROFILE")
        .map(|u| format!(r"{u}\.cloudflared\{id}.json"))
        .unwrap_or_else(|_| format!(".cloudflared/{id}.json"));
    let yml = format!(
        "tunnel: {id}\ncredentials-file: {cred}\nallow-remote-config: false\ningress:\n  - hostname: {hostname}\n    service: http://127.0.0.1:18080\n  - service: http_status:404\n"
    );
    let cfg_path = install_dir.join("tunnel.yml");
    // Supervision audit #5: atomic (the boot-spawned cloudflared may be
    // mid-read) — and #1: DO NOT spawn a second tunnel here; the supervisor
    // task owns the single child and restarts on the generation bump.
    let _ = crate::bootstrap::atomic_write(&cfg_path, yml.as_bytes());
    crate::tunnel_ctl::request_restart();
    format!("ok ({hostname})")
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

/// Update a tunnel's REMOTE config (Cloudflare API) so its ingress points at
/// 127.0.0.1:18080. cloudflared prefers the remote config over the local file
/// when one exists; a stale remote (e.g. an old 127.0.0.2 ingress) would keep
/// proxying to a dead address (502) no matter what tunnel.yml says.
async fn update_remote_config(cf_token: &str, tunnel_id: &str, hostname: &str) {
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
                { "hostname": hostname, "service": "http://127.0.0.1:18080" },
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
