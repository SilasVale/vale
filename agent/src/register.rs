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
