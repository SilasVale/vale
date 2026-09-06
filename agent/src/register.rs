/// Pure self-register planning seam (boundary review 2026-09-06: the exact
/// "extract pure logic for testability" pattern — the network call lives in
/// main.rs's register loop, this fn is trivially unit-testable).
pub fn self_register_plan(
    console: Option<&str>,
    token: &str,
    hostname: &str,
) -> Option<(String, String)> {
    let console = console?.trim();
    if console.is_empty() || token.trim().is_empty() || hostname.trim().is_empty() {
        return None;
    }
    let name = hostname.split('.').next().unwrap_or("device").to_string();
    let body =
        serde_json::json!({ "name": &name, "hostname": hostname, "token": token }).to_string();
    Some((
        format!(
            "{}/api/devices/self-register",
            console.trim_end_matches('/')
        ),
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "d1.agent.saisi.online";
    const TOK: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 64 hex

    #[test]
    fn full_config_plans_url_and_body() {
        let (url, body) = self_register_plan(Some("https://api.saisi.online/"), TOK, HOST).unwrap();
        // Trailing slash on the console must not double up.
        assert_eq!(url, "https://api.saisi.online/api/devices/self-register");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["name"], "d1", "name = first DNS label of the hostname");
        assert_eq!(v["hostname"], HOST);
        assert_eq!(v["token"], TOK);
    }

    #[test]
    fn pure_local_never_plans_a_send() {
        // The saisi decouple: no console_url → None (nothing is ever sent).
        assert_eq!(self_register_plan(None, TOK, HOST), None);
        assert_eq!(
            self_register_plan(Some("  "), TOK, HOST),
            None,
            "blank console"
        );
        assert_eq!(
            self_register_plan(Some("https://x"), "  ", HOST),
            None,
            "blank token"
        );
        assert_eq!(
            self_register_plan(Some("https://x"), TOK, "  "),
            None,
            "blank hostname"
        );
    }

    #[test]
    fn name_falls_back_and_url_tolerates_trailing_slashes() {
        // A hostname without dots still plans (name = whole label).
        let (url, body) = self_register_plan(Some("https://gw"), TOK, "barebox").unwrap();
        assert_eq!(url, "https://gw/api/devices/self-register");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["name"], "barebox");
        // Multiple trailing slashes are trimmed once per trim_end_matches.
        let (url2, _) = self_register_plan(Some("https://gw///"), TOK, HOST).unwrap();
        assert_eq!(url2, "https://gw/api/devices/self-register");
    }
}
