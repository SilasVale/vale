//! Config bootstrap for the `src/main.rs` binary: create a default config if
//! missing, load it, and ensure an auth token exists.

use std::io::Write;
use std::path::Path;
use vale_agent_core::Config;

/// Atomic file write (round-57): temp file in the SAME directory + rename.
/// Windows rename is atomic on the same volume (MoveFileEx); the old
/// std::fs::write (truncate + write) left a half-written config on power
/// loss, which the next boot quarantined and replaced with a FRESH token —
/// every client 401'd with no recovery path.
pub fn atomic_write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config")
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
    }
    // Core audit #9 (HIGH): config.yaml carries the device_token (= a bearer
    // key to the whole RCE surface) yet was the ONE secret-adjacent file
    // never ACL-hardened — any local account read it through the inherited
    // Users:RX on the data dir. Harden every atomic write (best-effort: a
    // volume without ACL support must not fail the boot path).
    let _ = crate::paths::harden_file(&tmp);
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Load the config at `path`, creating a default file first if it doesn't
/// exist; an unparseable primary file is quarantined as `config.yaml.bad` and
/// replaced with a fresh default (token recovered when possible).
///
/// Ensures an auth token is present. Returns `(config, Some(token))` when a
/// new token was generated — callers persist the config and print the token.
///
/// Never `println!` here: in Windows service mode there is no console and a
/// bare `println!` panics (see `out!`/`eout!` in main.rs). Any diagnostics
/// go through the injected `log` callback, which callers may discard.
pub fn load_or_create(path: &Path, log: &dyn Fn(&str)) -> anyhow::Result<(Config, Option<String>)> {
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
            log(&format!(
                "  !! Failed to load {}: {primary_err}",
                path.display()
            ));
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
                let extract = |key: &str| {
                    bad_text
                        .lines()
                        .filter_map(|l| {
                            let t = l.trim();
                            let colon = t.find(':')?;
                            if t[..colon].trim() != key {
                                return None;
                            }
                            let v = t[colon + 1..].split('#').next().unwrap_or("").trim();
                            let v = v.trim_matches(|c| c == '"' || c == '\'' || c == ' ');
                            Some(v.to_string())
                        })
                        .rfind(|tok| tok.len() == 64 && tok.chars().all(|c| c.is_ascii_hexdigit()))
                }; // last wins (duplicate keys)
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
                    } else {
                        // round-140: the secret line did not survive intact —
                        // generate + persist one NOW (device_token is already
                        // present, so ensure_token only mints the secret).
                        // The old path returned with secret=None and the
                        // next boot silently rotated it, killing gateway
                        // /panel/ injection (round-104 class). A rotated
                        // secret is unavoidable here; making it explicit and
                        // persisted beats a silent future boot.
                        if let (_, true) = fresh.server.ensure_token()? {
                            log("     !! proxy_secret was missing/corrupt — generated a NEW one; gateway /panel/ injection needs the console to re-read /api/status");
                        }
                    }
                    atomic_write(
                        path,
                        serde_yaml::to_string(&fresh).unwrap_or_default().as_bytes(),
                    )?;
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

#[cfg(test)]
mod bootstrap_tests {
    //! round-374: the boot path (create/quarantine/token-recovery) carries
    //! six incident fixes (rounds 57/104/119/121/138/140) and had ZERO
    //! tests — every claim below is one of those fixes, pinned.
    use super::*;

    const TOK_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TOK_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const SEC: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const NOOP: &dyn Fn(&str) = &|_| {};

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("vale-boot-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn valid_yaml(token: Option<&str>) -> String {
        let mut cfg = Config::default();
        cfg.server.device_token = token.map(|t| t.to_string());
        serde_yaml::to_string(&cfg).unwrap()
    }

    fn is_hex64(s: &str) -> bool {
        s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
    }

    #[test]
    fn missing_file_creates_default_and_mints_token_once() {
        let d = dir("missing");
        let path = d.join("config.yaml");
        let (cfg, token) = load_or_create(&path, NOOP).unwrap();
        let t = token.expect("first boot must mint a token");
        assert!(is_hex64(&t));
        assert!(path.exists());
        // Second boot: the minted token persisted — no rotation.
        let (cfg2, token2) = load_or_create(&path, NOOP).unwrap();
        assert_eq!(token2, None);
        assert_eq!(cfg2.server.device_token, cfg.server.device_token);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn valid_config_with_token_is_untouched() {
        let d = dir("valid");
        let path = d.join("config.yaml");
        std::fs::write(&path, valid_yaml(Some(TOK_A))).unwrap();
        let (cfg, token) = load_or_create(&path, NOOP).unwrap();
        assert_eq!(token, None);
        assert_eq!(cfg.server.device_token.as_deref(), Some(TOK_A));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn missing_token_is_generated_and_persisted() {
        // round-104: the fresh secret/token must hit the disk NOW, not just
        // memory — otherwise the next boot rotates again.
        let d = dir("notoken");
        let path = d.join("config.yaml");
        std::fs::write(&path, valid_yaml(None)).unwrap();
        let (cfg, token) = load_or_create(&path, NOOP).unwrap();
        let t = token.expect("missing token must be minted");
        assert!(is_hex64(&t));
        let disk = Config::load(&path).unwrap();
        assert_eq!(disk.server.device_token, cfg.server.device_token);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn corrupt_file_quarantines_and_recovers_token_by_line() {
        // round-57/119: quarantine as .yaml.bad; recover the token by
        // direct line extraction (the SAME parser just failed on it).
        let d = dir("corrupt");
        let path = d.join("config.yaml");
        std::fs::write(&path, format!("{{{{{{ not yaml\ndevice_token: {TOK_A}\n")).unwrap();
        let (cfg, token) = load_or_create(&path, NOOP).unwrap();
        assert_eq!(token, None, "recovered token is already in place");
        assert_eq!(cfg.server.device_token.as_deref(), Some(TOK_A));
        assert!(d.join("config.yaml.bad").exists(), "bad file must be kept");
        // The rewritten file loads cleanly on the next boot.
        let (cfg2, _) = load_or_create(&path, NOOP).unwrap();
        assert_eq!(cfg2.server.device_token.as_deref(), Some(TOK_A));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn recovery_prefers_device_token_space_colon_last_and_strips_comments() {
        // round-121 (device_token > auth_token, strip # comments) +
        // round-138 (space before colon legal; LAST occurrence wins).
        let d = dir("recover");
        let path = d.join("config.yaml");
        let bad = format!(
            "{{{{{{ broken\nauth_token: {TOK_B}\ndevice_token : {TOK_A} # stale inline\ndevice_token: {SEC}\n"
        );
        std::fs::write(&path, bad).unwrap();
        let (cfg, _) = load_or_create(&path, NOOP).unwrap();
        assert_eq!(
            cfg.server.device_token.as_deref(),
            Some(SEC),
            "last device_token line wins over auth_token and the older line"
        );
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn recovery_carries_proxy_secret() {
        // round-138: the secret must survive the recovery boot or gateway
        // /panel/ injection dies (round-104 class).
        let d = dir("secret");
        let path = d.join("config.yaml");
        let bad = format!("{{{{{{ broken\ndevice_token: {TOK_A}\nproxy_secret: {SEC}\n");
        std::fs::write(&path, bad).unwrap();
        let (cfg, _) = load_or_create(&path, NOOP).unwrap();
        assert_eq!(cfg.server.device_token.as_deref(), Some(TOK_A));
        assert_eq!(cfg.server.proxy_secret.as_deref(), Some(SEC));
        let disk = Config::load(&path).unwrap();
        assert_eq!(disk.server.proxy_secret.as_deref(), Some(SEC));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn recovery_without_secret_mints_and_persists_one() {
        // round-140: token recovered but the secret line lost → mint NOW
        // and persist (not a silent future rotation).
        let d = dir("nosecret");
        let path = d.join("config.yaml");
        std::fs::write(&path, format!("{{{{{{ broken\ndevice_token: {TOK_A}\n")).unwrap();
        let (cfg, _) = load_or_create(&path, NOOP).unwrap();
        let sec = cfg
            .server
            .proxy_secret
            .clone()
            .expect("secret must be minted");
        assert!(is_hex64(&sec));
        let disk = Config::load(&path).unwrap();
        assert_eq!(disk.server.proxy_secret.as_deref(), Some(sec.as_str()));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn atomic_write_roundtrips() {
        let d = dir("atomic");
        let path = d.join("config.yaml");
        atomic_write(&path, b"hello").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        assert!(
            !d.join(".config.yaml.tmp").exists(),
            "temp must be renamed away"
        );
        std::fs::remove_dir_all(&d).ok();
    }
}
