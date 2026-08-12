//! Tool builders for the design plugin.

use serde_json::{json, Value};

use vale_agent_core::{DeviceError, ToolDef};

/// Pages served by this agent's own HTTP surface, keyed by a short name.
/// `local` = fetch from 127.0.0.1:port (no tunnel needed); `remote` = the
/// tunnel URL so the AI sees what a browser sees.
const PAGES: &[(&str, &str)] = &[
    ("status", "/"),
    ("panel", "/panel/"),
    ("panel-js", "/panel/panel.js"),
    ("panel-css", "/panel/panel.css"),
    ("panel-html", "/panel/"),
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
    Ok((host, port))
}

/// `page_view` — fetch a Vale page's HTML/CSS so the AI can read its design.
///
/// The device has no browser, so "seeing" the design means reading the source
/// this agent serves: / (status), /panel/ (terminal panel HTML), /panel/panel.js,
/// /panel/panel.css. The console pages live on the gateway worker, not here —
/// use `source` pages via the console's /code/ viewer instead.
pub fn page_view() -> ToolDef {
    ToolDef::new(
        "page_view",
        "View a Vale page's design by fetching its HTML/CSS from this agent. \
         Pages: status (/), panel (/panel/), panel-js, panel-css, panel-html. \
         Returns up to 64KB of source — read the CSS tokens (--accent, --bg, \
         radii, glass) and HTML structure to evaluate the design. Use target \
         '127.0.0.1:18080' (default) or a remote host.",
        json!({
            "type": "object",
            "properties": {
                "page": {
                    "type": "string",
                    "enum": ["status", "panel", "panel-js", "panel-css", "panel-html"],
                    "description": "Which page to fetch."
                },
                "target": {
                    "type": "string",
                    "description": "host:port to fetch from (default 127.0.0.1:18080)."
                }
            },
            "required": ["page"]
        }),
        |params: Value| async move {
            let page = params.get("page").and_then(|v| v.as_str()).unwrap_or("panel");
            let target = params.get("target").and_then(|v| v.as_str()).unwrap_or("127.0.0.1:18080");
            let (host, port) = parse_target(target)?;
            let path = PAGES.iter().find(|(n, _)| *n == page).map(|(_, p)| *p)
                .ok_or_else(|| DeviceError::Internal { message: format!("unknown page: {page}") })?;

            // Fetch the page locally (no auth needed for static pages; the
            // panel HTML is public, token is injected server-side but the
            // static file itself has no secrets).
            let url = format!("http://{host}:{port}{path}");
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
            let truncated = body.len() > MAX_PAGE_BYTES;
            let text = if truncated { &body[..MAX_PAGE_BYTES] } else { &body[..] };

            Ok(json!({
                "page": page,
                "url": url,
                "bytes": body.len(),
                "truncated": truncated,
                "content": text,
            }))
        },
    )
}
