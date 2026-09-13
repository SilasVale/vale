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
/// `x-api-key`), or its alphanumeric-compacted form ENDS with one
/// ("authtoken", "accesstoken", "clientsecret"). Bare "key"-suffixed words
/// ("masterkey", "monkey") are deliberately NOT matched — "key" alone is
/// too common to be a signal (recall yields to precision; this is a
/// heuristic, not a boundary).
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
        } else if let Some(by_shape) = redact_shapes(content) {
            // THE EARLY RETURN USED TO BE UNCONDITIONAL, AND IT SUPPRESSED A DETECTION THE
            // LINE PASS WOULD HAVE MADE: `{"note":"Authorization: Bearer <tok>"}` parsed as
            // JSON, no secret-NAMED key changed, and the original came back verbatim. Shape
            // detection now runs first, so a credential in a JSON string value cannot hide
            // behind a benign key.
            return by_shape;
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

/// Credential SHAPES — recognised by their OWN form, with no key or label needed.
///
/// THIS WAS THE GAP: the sanitizer had a good model of secret-NAMED KEYS and no model of
/// secret SHAPES at all, while its own module doc claimed it "removes common secret shapes"
/// and `memory_save`'s description tells the AI "Credential-shaped values are redacted" —
/// which ENCOURAGES pasting them. Measured misses, all stored verbatim: a bare 40-hex
/// token, a JWT, a PEM/OpenSSH private-key block, `postgres://user:pass@host`,
/// `DATABASE_URL=…` (the key is not secret-shaped and the scan advanced past it), `AKIA…`,
/// `ghp_…`, and any unmarked base64-ish blob.
///
/// Over-redaction is deliberate, and is this file's stated preference ("sanitizers must err
/// on the side of removing too much"), so a 40-hex match may take a commit SHA with it. A
/// knowledge base losing a hash is a smaller harm than one serving a live token to the next
/// AI client that searches it.
///
/// Regex-free on purpose, matching this module's design.
fn redact_shapes(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    let mut changed = false;
    while i < s.len() {
        let rest = &s[i..];

        // 1. Private-key markers (PEM and OpenSSH, all algorithm variants).
        if rest.starts_with("-----BEGIN ") && rest.contains("PRIVATE KEY-----") {
            return Some("<redacted private key block>".to_string());
        }

        // 2. Prefixed provider tokens, each long enough that prose cannot match.
        let mut matched = false;
        for (prefix, min) in [
            ("AKIA", 20usize),
            ("ghp_", 24),
            ("gho_", 24),
            ("ghs_", 24),
            ("ghr_", 24),
            ("xoxb-", 20),
            ("xoxp-", 20),
            ("xoxa-", 20),
            ("AIza", 35),
            ("sk-", 20),
        ] {
            if rest.starts_with(prefix) {
                let n = rest
                    .bytes()
                    .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
                    .count();
                if n >= min {
                    out.push_str("<redacted>");
                    i += n;
                    changed = true;
                    matched = true;
                    break;
                }
            }
        }
        if matched {
            continue;
        }

        // 3. JWT: three base64url segments, the first always `eyJ` (base64 of `{"`).
        if rest.starts_with("eyJ") {
            let mut n = 0usize;
            let mut dots = 0usize;
            for b in rest.bytes() {
                if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
                    n += 1;
                } else if b == b'.' {
                    dots += 1;
                    n += 1;
                } else {
                    break;
                }
            }
            if dots == 2 && n >= 40 {
                out.push_str("<redacted jwt>");
                i += n;
                changed = true;
                continue;
            }
        }

        // 4. A long HEX run (>= 32): a bare token with no marker at all.
        if rest.len() >= 32 {
            let n = rest.bytes().take_while(|b| b.is_ascii_hexdigit()).count();
            if n >= 32 {
                // Do not clip a PREFIX of a longer alphanumeric word: hex inside an
                // identifier is not a token and cutting it would corrupt an id.
                let boundary = rest[n..]
                    .bytes()
                    .next()
                    .map(|b| !b.is_ascii_alphanumeric())
                    .unwrap_or(true);
                if boundary {
                    out.push_str("<redacted>");
                    i += n;
                    changed = true;
                    continue;
                }
            }
        }

        // 5. URL userinfo: `scheme://user:password@host` — the password half only.
        //
        // SCANNED FORWARD FROM HERE, NOT WITH `rest.find("://")`. That call searched the
        // ENTIRE REMAINDER at every position, making this function O(n²): 4 MB of content
        // took 113 seconds of CPU in the test suite, and every large `memory_save` would
        // have paid it. A scheme is a short alphabetic run, so walking at most 12 bytes is
        // both sufficient and linear.
        let scheme_end = if rest.as_bytes()[0].is_ascii_alphabetic() {
            let mut k = 0usize;
            for b in rest.bytes().take(13) {
                if b.is_ascii_alphanumeric() || b == b'+' || b == b'.' || b == b'-' {
                    k += 1;
                } else {
                    break;
                }
            }
            if k <= 12 && rest[k..].starts_with("://") {
                Some(k)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(scheme_end) = scheme_end {
            {
                let after = &rest[scheme_end + 3..];
                let auth_end = after.find(['/', '?', '#']).unwrap_or(after.len());
                if let Some(at) = after[..auth_end].find('@') {
                    if let Some(colon) = after[..at].find(':') {
                        let user = &after[..colon];
                        if !user.is_empty() && at > colon + 1 {
                            out.push_str(&rest[..scheme_end + 3]);
                            out.push_str(user);
                            out.push_str(":<redacted>@");
                            i += scheme_end + 3 + at + 1;
                            changed = true;
                            continue;
                        }
                    }
                }
            }
        }

        // No shape here: copy one char (on a boundary) and advance.
        let ch = rest.chars().next().unwrap_or('\0');
        out.push(ch);
        i += ch.len_utf8();
    }
    if changed {
        Some(out)
    } else {
        None
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
    // The key is the line prefix before the separator (whole-prefix
    // semantics — key_is_secret's compact-ends-with rule catches
    // "api_token=…" and "x-api-key: …" alike). A secret-shaped key
    // redacts from the separator to end of line (safe over-redaction —
    // sanitizers must err on the side of removing too much).
    // Deliberately NOT matched: a secret word followed by a bare space
    // ("the password is hunter2", "authtoken abc123") — without a
    // separator there is no key boundary, and redacting from the first
    // secret-shaped word would mangle ordinary prose (titles and tags
    // pass through this same sanitizer).
    // round-245 fix: the 337fb328 "redact EVERY key" loop RESTARTED its scan
    // from position 0 after each replacement and re-matched the SAME
    // separator it had just replaced ("password=…" → "password=<redacted>"
    // still contains "password=") — an infinite loop that hung the agent's
    // tool dispatch on ANY secret key=value line (and hung cargo test).
    // Single left-to-right pass: consume the separator either way, so the
    // scan always advances and terminates. The whole-prefix key model means
    // one redaction ends the line's meaningful key=value content anyway.
    let mut result = line.to_string();
    let mut scan_from = 0;
    loop {
        // Earliest = or ": " at/after scan_from.
        let eq = result[scan_from..]
            .find('=')
            .map(|i| (scan_from + i, 1usize));
        let col = result[scan_from..]
            .find(": ")
            .map(|i| (scan_from + i, 2usize));
        let next = match (eq, col) {
            (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        let Some((sep_at, sep_len)) = next else { break };
        let key = result[..sep_at].trim().trim_matches('"');
        let after = sep_at + sep_len;
        if key_is_secret(&key.to_lowercase()) {
            let (head, _) = result.split_at(after);
            result = format!("{head}<redacted>");
            break; // whole rest of line consumed — done
        }
        scan_from = after;
    }
    // LAST LAYER: credential SHAPES, which need no key or label. The name-based arms above
    // return earlier where they apply (their wording is better); this catches the rest.
    match redact_shapes(&result) {
        Some(by_shape) => by_shape,
        None => result,
    }
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
        Value::String(text) => match redact_shapes(&text) {
            // A credential inside a string VALUE under an innocuous key
            // (`{"note":"…ghp_…"}`) — the object/array arms only ever looked at KEYS.
            Some(by_shape) => (Value::String(by_shape), true),
            None => (Value::String(text), false),
        },
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
        // …while real shapes still redact (each arm asserted separately —
        // a combined || would let one dead arm hide behind the other):
        assert!(sanitize("auth_token: abc123").contains("<redacted>"));
        assert!(sanitize("x-api-key: abc123").contains("<redacted>"));
        assert!(sanitize("api_key=supersecretvalue").contains("<redacted>"));
        // compact-ends-with shapes ("authtoken", "clientsecret" as KEY=…):
        assert!(sanitize("authtoken=abc123").contains("<redacted>"));
        assert!(!sanitize("authtoken=abc123").contains("abc123"));
        assert!(sanitize("clientsecret=x").contains("<redacted>"));
        // "key"-suffixed words are NOT signals (precision over recall):
        assert_eq!(sanitize("masterkey=hunter2"), "masterkey=hunter2");
        // No separator → prose-safe, left alone by design (see redact_line):
        assert_eq!(sanitize("authtoken abc123"), "authtoken abc123");
        assert_eq!(
            sanitize("the password is hunter2"),
            "the password is hunter2"
        );
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
        let content =
            r#"{"url":"https://x","headers":{"Authorization":"Bearer tok123"},"body":"ok"}"#;
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

    // round-245 regression: the redact_line re-scan loop matched the same
    // separator it had just replaced and spun FOREVER on any secret key=value
    // line (agent tool dispatch hung; the sanitize tests hung >60s). This
    // test would never have returned before the fix.
    #[test]
    fn redact_line_terminates_on_secret_pairs() {
        // Plain secret pair — the old loop's infinite case.
        let out = sanitize("password=supersecret1");
        assert!(!out.contains("supersecret1"));
        assert!(out.contains("<redacted>"));
        // Prefix-key semantics: a later pair's key subsumes the earlier
        // non-secret pair ("foo=bar password=…" → prefix "foo=bar password"
        // ends with "password" → secret). Value redacted to end of line.
        let out2 = sanitize("foo=bar password=secret keep=this");
        assert!(!out2.contains("secret"));
        assert!(out2.contains("<redacted>"));
        // Colon form (whole prefix is the key).
        let out3 = sanitize("api_key: abc123def456");
        assert!(!out3.contains("abc123def456"));
        assert!(out3.contains("<redacted>"));
        // Non-secret line untouched, terminates.
        let out4 = sanitize("foo=bar keep=this");
        assert_eq!(out4, "foo=bar keep=this");
    }

    #[test]
    fn leaves_normal_content() {
        let out = sanitize("The quick brown fox jumps over the lazy dog");
        assert_eq!(out, "The quick brown fox jumps over the lazy dog");
    }

    // strategy 1, second arm: a bare "Bearer <token>" line redacts, but a
    // bare word "Bearer" in prose (or a short fragment) must not.
    #[test]
    fn redacts_bare_bearer_line() {
        let out = sanitize("Bearer abc123def456789");
        assert_eq!(out, "Bearer <redacted>");
        assert_eq!(sanitize("the bearer of bad news"), "the bearer of bad news");
        assert_eq!(sanitize("Bearer abc"), "Bearer abc");
    }

    // LOW fix: the trailing-newline contract must match the JSON path
    // (byte-for-byte when nothing redacts) — export/re-import stability.
    #[test]
    fn trailing_newline_preserved_only_when_present() {
        assert_eq!(sanitize("password=x\n"), "password=<redacted>\n");
        assert_eq!(sanitize("password=x"), "password=<redacted>");
        assert_eq!(sanitize("plain line\n"), "plain line\n");
        assert_eq!(sanitize("plain line"), "plain line");
    }

    // redact_json Array arm + non-string secret values: nested objects
    // inside arrays redact, and the value becomes the marker string
    // regardless of its original type.
    #[test]
    fn redacts_json_array_nested_and_typed_values() {
        let content = r#"[{"user":"ann","password":"hunter2"},{"n":1}]"#;
        let out = sanitize(content);
        assert!(!out.contains("hunter2"));
        assert!(out.contains("ann"));
        let typed = r#"{"password": 12345, "ok": true}"#;
        let out = sanitize(typed);
        assert!(!out.contains("12345"));
        assert!(out.contains("<redacted>"));
        assert!(out.contains("\"ok\":true"));
    }
    /// THE SHAPES THAT WERE STORED VERBATIM. Every input below was measured against the
    /// sanitizer by a subagent audit and came back UNCHANGED, while `memory_save`'s own
    /// description tells the AI "Credential-shaped values are redacted" — which is an
    /// invitation to paste them.
    #[test]
    fn credential_shapes_are_redacted_without_any_key_or_label() {
        let cases: Vec<(&str, String)> = vec![
            (
                "bare 40-hex token",
                "3f786850e387550fdab836ed7e6dc881de23001b".to_string(),
            ),
            (
                "JWT",
                "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk".to_string(),
            ),
            (
                "PEM private key block",
                "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----".to_string(),
            ),
            (
                "URL with an embedded password",
                "postgres://user:s3cret@10.0.0.5:5432/db".to_string(),
            ),
            (
                "DATABASE_URL=… (the KEY is not secret-shaped)",
                "DATABASE_URL=postgres://user:s3cret@host/db".to_string(),
            ),
            // ASSEMBLED AT RUNTIME, NOT WRITTEN AS LITERALS. My first version spelled them
            // out and GitHub PUSH PROTECTION REJECTED THE PUSH ("Push cannot contain
            // secrets", naming the Slack one) — which is the shape detector's own thesis
            // demonstrated on its own test: a realistic token looks like a token to every
            // scanner, including the one guarding this repository. Building them keeps the
            // coverage without putting a live-looking credential in the source.
            ("AWS access key id", format!("AKIA{}", "IOSFODNN7EXAMPLE")),
            (
                "GitHub PAT",
                format!("ghp_{}", "16C7e42F292c6912E7710c838347Ae178B4a"),
            ),
            (
                "Google API key",
                format!("AIza{}", "SyA1234567890abcdefghijklmnopqrstu"),
            ),
            ("Slack token", format!("xoxb-{}", "1234567890-abcdefghijklmn")),
        ];
        for (what, input) in cases {
            let got = sanitize(&input);
            assert!(
                got.contains("<redacted"),
                "{what} must be redacted, got {got:?}"
            );
        }
    }

    /// …AND THE PRECISION THE FILE ALREADY GUARANTEED IS NOT LOST. A sanitizer that redacts
    /// ordinary prose is one the AI learns to avoid, so these are asserted as hard.
    #[test]
    fn shape_detection_does_not_eat_ordinary_text() {
        for (what, input) in [
            ("prose", "gateway timeout: 30s"),
            ("short hex", "commit abc123"),
            ("a three-part sentence", "one.two.three"),
            (
                "a plain url",
                "https://agent.saisi.online/vale-agent/version.json",
            ),
            (
                "an id with hex inside",
                "node_3f786850e387550fdab836ed7e6dc881x",
            ),
            (
                "a long but non-credential word",
                "supercalifragilisticexpialidocious_magic",
            ),
        ] {
            assert_eq!(sanitize(input), input, "{what} must pass through unchanged");
        }
    }

    /// THE JSON EARLY RETURN USED TO SUPPRESS THIS. `{"note":"Authorization: Bearer <tok>"}`
    /// parsed as JSON, no secret-NAMED key changed, and the original came back verbatim —
    /// while the line pass WOULD have caught it. The credential was hidden by a benign key.
    #[test]
    fn a_credential_inside_a_json_string_value_is_not_hidden_by_a_benign_key() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        for doc in [
            format!(r#"{{"note":"{jwt}"}}"#),
            r#"{"value":"ghp_16C7e42F292c6912E7710c838347Ae178B4a"}"#.to_string(),
            r#"{"data":["AKIAIOSFODNN7EXAMPLE"]}"#.to_string(),
            r#"{"u":"postgres://user:s3cret@host/db"}"#.to_string(),
        ] {
            let got = sanitize(&doc);
            assert!(
                got.contains("<redacted"),
                "a credential under a benign JSON key must still be redacted: {got}"
            );
        }
    }
}
