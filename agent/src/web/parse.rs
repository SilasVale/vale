//! Request-body parsing for the settings endpoints — ONE owner for the rules
//! that decide what a JSON body means (SOLID R104).
//!
//! Two endpoints accept a JSON settings body: `PUT /api/settings`
//! (`api_settings_put`) and `POST /api/gateway/connect`
//! (`api_gateway_connect`). Both had grown their own copies of the same two
//! concerns, and the copies are where their incidents live:
//!
//! 1. **The 400 envelope for an unparseable body.** Built inline in both
//!    handlers (eight lines of `built_response` + JSON each). The status and
//!    code are a contract; only the human-readable text differs, and that
//!    difference is deliberate (see [`json_body`]).
//!
//! 2. **"An optional string field, trimmed; blank means unset."** Written out
//!    five times across the crate. The rule carries two documented incidents —
//!    a console-only save silently clobbering `buffer_mb`, and a reg-key-only
//!    request silently UNBINDING the gateway — so the "blank ⇒ None, absent ⇒
//!    unchanged" distinction is load-bearing, not cosmetic.
//!
//! The parsing is PURE (a `&str`/`&Value` in, a decision out), so every rule
//! below is unit-testable without a server, a config file or a device.

use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;

use super::built_response;

/// The shared 400 envelope for a request body that could not be accepted.
///
/// `code` is `invalid_params` — the same stable code the tool surface uses —
/// and the outer `ok:false` is what the gateway's round-58 check reads. Both
/// settings endpoints were unified onto HTTP 400 with product sign-off (the
/// settings one used to answer 200); this keeps that decision in one place.
pub(super) fn invalid_params_response(message: String) -> Box<Response> {
    Box::new(built_response(
        StatusCode::BAD_REQUEST,
        "application/json",
        Body::from(
            serde_json::json!({
                "ok": false, "error": message, "code": "invalid_params",
            })
            .to_string(),
        ),
    ))
}

/// Parse a JSON request body, or return the shared 400 envelope.
///
/// The error TEXT stays a caller decision because the two endpoints have
/// documented, intentionally different wordings: `PUT /api/settings` appends
/// the serde detail (`invalid JSON: expected value at line 1`), while
/// `POST /api/gateway/connect` answers the bare `invalid JSON`. Unifying them
/// would be a user-visible message change, not a refactor — so the envelope
/// shape is owned here and the wording is passed in.
pub(super) fn json_body(
    body: &str,
    on_error: impl FnOnce(&serde_json::Error) -> String,
) -> Result<Value, Box<Response>> {
    serde_json::from_str(body).map_err(|e| invalid_params_response(on_error(&e)))
}

/// Read an optional string field from a settings body: trimmed, with a BLANK
/// value read as "unset" (`None`).
///
/// The three cases callers depend on:
///   * key absent        → `None`  (caller must leave the setting alone)
///   * key present, `""` → `None`  (an explicit CLEAR)
///   * non-string value  → `None`  (e.g. a number where a URL belongs)
///
/// Callers that must distinguish "absent" from "explicitly cleared" wrap this
/// in `Option<Option<String>>` themselves — see the `console_url` handling in
/// `api_gateway_connect`.
pub(super) fn optional_trimmed_string(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn body_text(resp: Response) -> String {
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.expect("body");
        String::from_utf8_lossy(&bytes).to_string()
    }

    #[test]
    fn optional_trimmed_string_truth_table() {
        let v = serde_json::json!({
            "url": "  https://console.example.com  ",
            "blank": "",
            "spaces": "   ",
            "number": 42,
            "null": null,
            "bool": true,
        });
        assert_eq!(
            optional_trimmed_string(&v, "url").as_deref(),
            Some("https://console.example.com"),
            "a real value is trimmed, not rejected"
        );
        // Every "no usable value" spelling collapses to None.
        for key in ["blank", "spaces", "number", "null", "bool", "absent"] {
            assert_eq!(
                optional_trimmed_string(&v, key),
                None,
                "{key} must read as unset"
            );
        }
    }

    #[test]
    fn optional_trimmed_string_distinguishes_absent_from_cleared() {
        // The distinction the settings endpoints rely on: `None` from this
        // helper is ambiguous on its own, so callers must check presence
        // FIRST. This pins the contract they build on.
        let cleared = serde_json::json!({ "console_url": "" });
        let absent = serde_json::json!({});
        assert_eq!(optional_trimmed_string(&cleared, "console_url"), None);
        assert_eq!(optional_trimmed_string(&absent, "console_url"), None);
        // ...and presence is what tells them apart.
        assert!(cleared.get("console_url").is_some());
        assert!(absent.get("console_url").is_none());
    }

    #[tokio::test]
    async fn json_body_passes_valid_json_through() {
        let v = json_body(r#"{"a":1,"b":"x"}"#, |_| "unused".to_string())
            .unwrap_or_else(|_| panic!("valid JSON must parse"));
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"], "x");
        // A bare scalar is still valid JSON — shape checks are the caller's job.
        assert!(json_body("42", |_| "unused".to_string()).is_ok());
    }

    #[tokio::test]
    async fn json_body_failure_is_a_400_with_the_callers_wording() {
        // settings endpoint wording: serde detail appended.
        let resp = *json_body("{not json", |e| format!("invalid JSON: {e}"))
            .expect_err("invalid JSON must fail");
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let v: Value = serde_json::from_str(&body_text(resp).await).expect("json body");
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "invalid_params");
        assert!(
            v["error"]
                .as_str()
                .is_some_and(|e| e.starts_with("invalid JSON: ")),
            "settings keep their serde detail: {v}"
        );

        // gateway endpoint wording: bare.
        let resp = *json_body("{not json", |_| "invalid JSON".to_string())
            .expect_err("invalid JSON must fail");
        let v: Value = serde_json::from_str(&body_text(resp).await).expect("json body");
        assert_eq!(v["error"], "invalid JSON");
        assert_eq!(v["code"], "invalid_params");
    }

    #[tokio::test]
    async fn json_body_accepts_an_empty_body_as_an_error_not_a_panic() {
        // The dispatcher only calls these handlers with a body; an empty one
        // must still produce the envelope rather than a panic.
        let resp = *json_body("", |_| "invalid JSON".to_string()).expect_err("empty body");
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn invalid_params_response_shape_is_stable() {
        let resp = *invalid_params_response("boom".to_string());
        let v: Value = serde_json::from_str(&body_text(resp).await).expect("json body");
        assert_eq!(
            v,
            serde_json::json!({"ok": false, "error": "boom", "code": "invalid_params"})
        );
    }
}
