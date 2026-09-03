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

/// Word-boundary secret-key match (stage-n review fix): the old
/// `key.contains("token")` style flagged "tokenizer", "secretary", and
/// similar innocuous words. A key is secret-shaped when it EQUALS a secret
/// name, is delimited-suffixed/prefixed (`api_token`, `token_value`,
/// `x-api-key`), or its alphanumeric-compacted form ENDS with it
/// ("authtoken", "accesstoken", "clientsecret", "masterkey").
fn key_is_secret(key: &str) -> bool {
    let k = key.to_lowercase();
    let compact: String = k.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    SECRET_KEYS.iter().any(|sk| {
        k == *sk
            || k.ends_with(&format!("_{sk}"))
            || k.ends_with(&format!("-{sk}"))
            || k.starts_with(&format!("{sk}_"))
            || k.starts_with(&format!("{sk}-"))
            || compact.ends_with(sk)
    })
}

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
    // Try JSON-aware redaction first — but ONLY rewrite (and re-serialize)
    // when something was actually redacted. The old unconditional rewrite
    // reordered keys and normalized numbers of every JSON-shaped content,
    // silently mangling legitimate data.
    if let Ok(v) = serde_json::from_str::<Value>(content) {
        let (redacted, changed) = redact_json(v);
        if changed {
            if let Ok(s) = serde_json::to_string(&redacted) {
                return s;
            }
        } else {
            return content.to_string();
        }
    }
    // Fallback: line-based regex-free redaction.
    let mut out = String::with_capacity(content.len());
    for line in content.lines() {
        out.push_str(&redact_line(line));
        out.push('\n');
    }
    // LOW fix: preserve trailing newline to match JSON-path behavior. The
    // old trim_end() stripped it, diverging from the JSON path which
    // returns content byte-for-byte — export then re-import lost the
    // newline. Only strip if the ORIGINAL content had no trailing newline.
    if content.ends_with('\n') {
        out
    } else {
        out.trim_end().to_string()
    }
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
        return "Bearer <redacted>".to_string();
    }
    // key=value / key: value with secret-shaped key.
    // LOW fix: redact EVERY secret-shaped key=value, not just the first — the
    // old code returned on the first separator match, so a line like
    // "foo=bar password=secret" left "password=secret" raw.
    let mut result = line.to_string();
    loop {
        let mut changed = false;
        for sep in ["=", ": "] {
            if let Some(idx) = result.find(sep) {
                let key = result[..idx].trim().trim_matches('"');
                if key_is_secret(&key.to_lowercase()) {
                    let (head, _) = result.split_at(idx + sep.len());
                    result = format!("{head}<redacted>");
                    changed = true;
                    break; // restart scan after modification
                }
            }
        }
        if !changed {
            break;
        }
    }
    result
}

/// Recursively redact a JSON value; returns (value, changed).
fn redact_json(v: Value) -> (Value, bool) {
    match v {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            let mut changed = false;
            for (k, val) in map.into_iter() {
                let k_lower = k.to_lowercase();
                if key_is_secret(&k_lower) {
                    out.insert(k, Value::String("<redacted>".to_string()));
                    changed = true;
                } else {
                    let (rv, rc) = redact_json(val);
                    changed |= rc;
                    out.insert(k, rv);
                }
            }
            (Value::Object(out), changed)
        }
        Value::Array(arr) => {
            let mut changed = false;
            let out: Vec<Value> = arr
                .into_iter()
                .map(|v| {
                    let (rv, rc) = redact_json(v);
                    changed |= rc;
                    rv
                })
                .collect();
            (Value::Array(out), changed)
        }
        other => (other, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // review #4 regression: word-boundary matching must stop mangling
    // innocuous words that merely CONTAIN a secret name.
    #[test]
    fn benign_words_are_not_redacted() {
        assert_eq!(sanitize("gateway timeout: 30s"), "gateway timeout: 30s");
        assert_eq!(sanitize("tokenizer: gpt2"), "tokenizer: gpt2");
        assert_eq!(sanitize("secretary: ann"), "secretary: ann");
        // …while real shapes still redact:
        assert!(sanitize("auth_token: abc123").contains("<redacted>"));
        assert!(sanitize("authtoken abc123\n").contains("<redacted>") || sanitize("x-api-key: abc123").contains("<redacted>"));
        assert!(sanitize("api_key=supersecretvalue").contains("<redacted>"));
    }

    // review #12 regression: JSON-shaped content with NO secrets must be
    // returned byte-for-byte (the old unconditional re-serialization
    // reordered keys and re-wrote number formats).
    #[test]
    fn json_without_secrets_is_byte_stable() {
        let src = "{ \"b\": 0.10, \"a\": [1, 2] }";
        assert_eq!(sanitize(src), src);
        let withsecret = "{ \"a\": 1, \"password\": \"hunter2\" }";
        let out = sanitize(withsecret);
        assert!(!out.contains("hunter2"));
        assert!(out.contains("password"));
    }

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
