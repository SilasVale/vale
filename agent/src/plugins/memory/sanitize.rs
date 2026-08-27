//! Content sanitizer for memory entries — strip credential-shaped data before
//! a memory_save persists user-supplied content.
//!
//! The memory store trusts the AI's explicit save intent, but defense-in-depth
//! still removes common secret shapes so a careless save can't leak a device
//! token into a queryable knowledge base. This is a coarse heuristic, NOT a
//! security boundary — the store is device-local and token-gated anyway.

use serde_json::Value;

/// Secret-shaped key names whose values are redacted (case-insensitive).
const SECRET_KEYS: &[&str] = &[
    "token",
    "auth_token",
    "device_token",
    "access_token",
    "secret",
    "api_key",
    "apikey",
    "password",
    "passwd",
    "authorization",
    "x-api-key",
    "client_secret",
    "cf-access-client-secret",
];

/// Redact credential-shaped data in a content string.
///
/// Strategies (applied in order):
/// 1. `Authorization: Bearer <...>` / `Bearer <...>` lines → replaced.
/// 2. `key=value` / `key: value` / JSON `"key": "value"` where key is
///    secret-shaped → value replaced with `<redacted>`.
/// 3. Long base64-ish or hex blobs (>32 chars) inside obvious secret
///    contexts are covered by strategy 2.
///
/// JSON-aware: if the content is a JSON object/array, redact recursively so
/// nested secrets (e.g. `{"headers":{"Authorization":"Bearer x"}}`) are
/// caught too.
pub fn sanitize(content: &str) -> String {
    // Try JSON-aware redaction first.
    if let Ok(v) = serde_json::from_str::<Value>(content) {
        let redacted = redact_json(v);
        if let Ok(s) = serde_json::to_string(&redacted) {
            return s;
        }
    }
    // Fallback: line-based regex-free redaction.
    let mut out = String::with_capacity(content.len());
    for line in content.lines() {
        out.push_str(&redact_line(line));
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// Redact one text line (no newline).
fn redact_line(line: &str) -> String {
    let trimmed = line.trim();
    // Authorization: Bearer <x> — replace the whole header value.
    if trimmed.to_lowercase().starts_with("authorization:")
        || trimmed.to_lowercase().starts_with("x-api-key:")
    {
        let idx = line.find(':').unwrap_or(0);
        let (head, _) = line.split_at(idx + 1);
        return format!("{head} <redacted>");
    }
    // Bearer <long-token> on its own.
    if trimmed.to_lowercase().starts_with("bearer ") && trimmed.len() > 12 {
        return format!("{} <redacted>", &line[..7]);
    }
    // key=value / key: value with secret-shaped key.
    for sep in ["=", ": "] {
        if let Some(idx) = line.find(sep) {
            let key = line[..idx].trim().trim_matches('"');
            let key_lower = key.to_lowercase();
            if SECRET_KEYS.iter().any(|k| key_lower.contains(k)) {
                let (head, _) = line.split_at(idx + sep.len());
                return format!("{head}<redacted>");
            }
        }
    }
    line.to_string()
}

/// Recursively redact a JSON value in place.
fn redact_json(v: Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, val) in map.into_iter() {
                let k_lower = k.to_lowercase();
                if SECRET_KEYS.iter().any(|s| k_lower.contains(s)) {
                    out.insert(k, Value::String("<redacted>".to_string()));
                } else {
                    out.insert(k, redact_json(val));
                }
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(redact_json).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_authorization_header() {
        let out = sanitize("Authorization: Bearer abc123def456\nother stuff");
        assert!(!out.contains("abc123def456"));
        assert!(out.contains("<redacted>"));
        assert!(out.contains("other stuff"));
    }

    #[test]
    fn redacts_json_nested() {
        let content = r#"{"url":"https://x","headers":{"Authorization":"Bearer tok123"},"body":"ok"}"#;
        let out = sanitize(content);
        assert!(!out.contains("tok123"));
        assert!(out.contains("<redacted>"));
        assert!(out.contains("ok"));
    }

    #[test]
    fn redacts_key_value() {
        let out = sanitize("password=supersecret1\ntoken=abc");
        assert!(!out.contains("supersecret1"));
        assert!(!out.contains("abc"));
        assert!(out.contains("<redacted>"));
    }

    #[test]
    fn leaves_normal_content() {
        let out = sanitize("The quick brown fox jumps over the lazy dog");
        assert_eq!(out, "The quick brown fox jumps over the lazy dog");
    }
}
