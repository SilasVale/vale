//! Tool builders for the design plugin.

use serde_json::{json, Value};

use vale_agent_core::{DeviceError, ToolDef};

/// Pages viewable via page_view, keyed by a short name. Three sources:
/// `Local(path)`  = this agent's own HTTP surface at host:port (no tunnel).
/// `Remote(url)`  = the deployed worker pages (console / download site) so
///                  the AI sees the REAL production design, not a mirror.
enum PageSource {
    Local(&'static str),
    Remote(&'static str),
}
const PAGES: &[(&str, PageSource)] = &[
    ("status", PageSource::Local("/")),
    ("panel", PageSource::Local("/panel/")),
    ("panel-js", PageSource::Local("/panel/panel.js")),
    ("console-js", PageSource::Remote("https://api.saisi.online/app.js")),
    ("panel-css", PageSource::Local("/panel/panel.css")),
    ("panel-html", PageSource::Local("/panel/")),
    ("console", PageSource::Remote("https://api.saisi.online/")),
    ("console-css", PageSource::Remote("https://api.saisi.online/style.css")),
    ("download", PageSource::Remote("https://agent.saisi.online/")),
    // round-262 (user: extension unused): the Vale Browser Control extension
    // (popup/options/terminal) was removed — its Embedded page entries went
    // with it. PAGES now covers the agent + deployed console/download only.
];

/// Max bytes returned per page — enough to see tokens/structure without
/// flooding the model with a multi-MB console bundle.
const MAX_PAGE_BYTES: usize = 64 * 1024;

fn parse_target(t: &str) -> Result<(String, u16), DeviceError> {
    // host:port (default 18080) — always the LOCAL agent, never arbitrary.
    let (host, port) = match t.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| DeviceError::Internal {
            message: format!("bad port in target: {t}"),
        })?),
        None => (t.to_string(), 18080),
    };
    // Plugin audit MED: the comment promised "always the LOCAL agent" but
    // the host came straight from the caller — an internal GET-read + port
    // scan primitive from SYSTEM. Enforce it.
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Err(DeviceError::InvalidParams {
            message: "design target must be the loopback agent (127.0.0.1[:port])".into(),
        });
    }
    Ok((host, port))
}

/// Replace a `name = "value"` assignment (e.g. the panel's injected
/// window.__PANEL_TOKEN__) with `<redacted>` — a design review must never
/// receive a live credential.
fn redact_tokens(s: &str) -> String {
    const PATTERN: &str = "__PANEL_TOKEN__";
    if !s.contains(PATTERN) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find(PATTERN) {
        out.push_str(&rest[..idx]);
        rest = &rest[idx..];
        let after = &rest[PATTERN.len()..];
        // Find the opening quote of the value, then the closing quote.
        match after.find('"') {
            Some(q) => match after[q + 1..].find('"') {
                Some(c) => {
                    let end = q + 1 + c;
                    out.push_str(&rest[..PATTERN.len()]);
                    out.push_str(&after[..=q]);
                    out.push_str("<redacted>");
                    out.push('"');
                    rest = &after[end + 1..];
                }
                None => { out.push_str(rest); rest = ""; break; }
            },
            None => { out.push_str(rest); rest = ""; break; }
        }
    }
    out.push_str(rest);
    out
}

/// `page_view` — fetch a Vale page's HTML/CSS so the AI can read its design.
///
/// The device has no browser, so "seeing" the design means reading the source.
/// Local pages: / (status), /panel/ (terminal panel HTML), /panel/panel.js,
/// /panel/panel.css. Remote pages: the console (gateway) and download site
/// (index worker) so production design is inspectable. Embedded: the browser
/// extension's popup/options CSS, which is not served by any HTTP surface.
pub fn page_view(console_url: Option<String>, download_url: Option<String>) -> ToolDef {
    ToolDef::new(
        "page_view",
        "View a Vale page's design by fetching its HTML/CSS. \
         Pages: status (/), panel (/panel/), panel-js, panel-css, panel-html, \
         console (gateway page), console-css (gateway style.css), console-js, \
         download (download site), popup-css, popup-html, options-css, \
         options-html, terminal-css, terminal-html, terminal-js, popup-js, options-js \
         Returns up to 64KB of source — read the CSS tokens (--accent, --bg, \
         radii, glass) and HTML structure to evaluate the design. Use target \
         '127.0.0.1:18080' (default) or a remote host. Remote pages fail \
         explicitly when the console/download URL is not configured.",
        json!({
            "type": "object",
            "properties": {
                "page": {
                    "type": "string",
                    "enum": ["status", "panel", "panel-js", "panel-css", "panel-html",
                             "console", "console-css", "console-js", "download",
                             "popup-css", "popup-html", "options-css", "options-html",
                             "terminal-css", "terminal-html", "terminal-js", "popup-js", "options-js"],
                    "description": "Which page to fetch."
                },
                "target": {
                    "type": "string",
                    "description": "host:port to fetch from (default 127.0.0.1:18080)."
                }
            },
            "required": ["page"]
        }),
        move |params: Value| {
            let console_url = console_url.clone();
            let download_url = download_url.clone();
            async move {
            let page = params.get("page").and_then(|v| v.as_str()).unwrap_or("panel");
            let target = params.get("target").and_then(|v| v.as_str()).unwrap_or("127.0.0.1:18080");
            let (host, port) = parse_target(target)?;
            let source = PAGES.iter().find(|(n, _)| *n == page).map(|(_, s)| s)
                .ok_or_else(|| DeviceError::Internal { message: format!("unknown page: {page}") })?;
            // saisi decouple: remote pages need the configured base; when
            // unset, fail explicitly (never fall back to a hardcoded host).
            let remote_url = match page {
                "console-js" => {
                    let base = console_url.as_deref().ok_or_else(|| DeviceError::Internal {
                        message: "console page requires platform.console_url (not configured — purely local install)".into(),
                    })?;
                    Some(format!("{}/app.js", base.trim_end_matches('/')))
                }
                "console" => {
                    let base = console_url.as_deref().ok_or_else(|| DeviceError::Internal {
                        message: "console page requires platform.console_url (not configured — purely local install)".into(),
                    })?;
                    Some(base.trim_end_matches('/').to_string())
                }
                "console-css" => {
                    let base = console_url.as_deref().ok_or_else(|| DeviceError::Internal {
                        message: "console page requires platform.console_url (not configured — purely local install)".into(),
                    })?;
                    Some(format!("{}/style.css", base.trim_end_matches('/')))
                }
                "download" => {
                    let base = download_url.as_deref().ok_or_else(|| DeviceError::Internal {
                        message: "download page requires platform.download_url (not configured — purely local install)".into(),
                    })?;
                    Some(base.trim_end_matches('/').to_string())
                }
                _ => None,
            };

            let url = match source {
                PageSource::Local(p) => format!("http://{host}:{port}{p}"),
                PageSource::Remote(u) => remote_url.unwrap_or_else(|| u.to_string()),
            };
            // Local static pages need no auth (the panel HTML is public;
            // the token is injected server-side, the static file itself has
            // no secrets). Remote pages are public console/download sites.
            let resp = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| DeviceError::Internal { message: format!("client: {e}") })?
                .get(&url)
                .send()
                .await
                .map_err(|e| DeviceError::Internal { message: format!("fetch {url}: {e}") })?;
            let body = resp.text().await
                .map_err(|e| DeviceError::Internal { message: format!("read {url}: {e}") })?;
            let len = body.len();
            let truncated = len > MAX_PAGE_BYTES;
            // Redact any injected device token before returning: the panel
            // HTML embeds window.__PANEL_TOKEN__ = "<token>", which a design
            // review must never see (a leaked review output = device control).
            // The agent's own token is also never part of a design diff.
            let redacted = redact_tokens(&body);
            // char-boundary-safe truncation: slicing a String at a fixed byte
            // index PANICS when it lands inside a multi-byte UTF-8 char.
            let text = if truncated {
                let mut end = MAX_PAGE_BYTES;
                while end > 0 && !redacted.is_char_boundary(end) { end -= 1; }
                &redacted[..end]
            } else {
                &redacted[..]
            };

            Ok(json!({
                "page": page,
                "url": url,
                "bytes": body.len(),
                "truncated": truncated,
                "content": text,
            }))
            }
        },
    )
}
