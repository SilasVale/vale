//! Tool builders for the design plugin.

use serde_json::{json, Value};

use vale_agent_core::{DeviceError, ToolDef};

/// Pages viewable via page_view, keyed by a short name. Three sources:
/// `Local(path)`  = this agent's own HTTP surface at host:port (no tunnel).
/// `Remote(url)`  = the deployed worker pages (console / download site) so
///                  the AI sees the REAL production design, not a mirror.
/// `Embedded(src)`= static files that are not served anywhere (extension
///                  popup/options CSS) — embedded at compile time so the
///                  design is inspectable without a browser on the device.
enum PageSource {
    Local(&'static str),
    Remote(&'static str),
    Embedded(&'static str),
}
const PAGES: &[(&str, PageSource)] = &[
    ("status", PageSource::Local("/")),
    ("panel", PageSource::Local("/panel/")),
    ("panel-js", PageSource::Local("/panel/panel.js")),
    ("panel-css", PageSource::Local("/panel/panel.css")),
    ("panel-html", PageSource::Local("/panel/")),
    ("console", PageSource::Remote("https://api.saisi.online/")),
    ("console-css", PageSource::Remote("https://api.saisi.online/style.css")),
    ("download", PageSource::Remote("https://agent.saisi.online/")),
    ("popup-css", PageSource::Embedded(include_str!("../../../../extension/popup/popup.css"))),
    ("options-css", PageSource::Embedded(include_str!("../../../../extension/options/options.css"))),
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
/// The device has no browser, so "seeing" the design means reading the source.
/// Local pages: / (status), /panel/ (terminal panel HTML), /panel/panel.js,
/// /panel/panel.css. Remote pages: the console (gateway) and download site
/// (index worker) so production design is inspectable. Embedded: the browser
/// extension's popup/options CSS, which is not served by any HTTP surface.
pub fn page_view() -> ToolDef {
    ToolDef::new(
        "page_view",
        "View a Vale page's design by fetching its HTML/CSS. \
         Pages: status (/), panel (/panel/), panel-js, panel-css, panel-html, \
         console (gateway page), console-css (gateway style.css), download \
         (download site), popup-css, options-css (extension styles). \
         Returns up to 64KB of source — read the CSS tokens (--accent, --bg, \
         radii, glass) and HTML structure to evaluate the design. Use target \
         '127.0.0.1:18080' (default) or a remote host.",
        json!({
            "type": "object",
            "properties": {
                "page": {
                    "type": "string",
                    "enum": ["status", "panel", "panel-js", "panel-css", "panel-html",
                             "console", "console-css", "download", "popup-css", "options-css"],
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
            let source = PAGES.iter().find(|(n, _)| *n == page).map(|(_, s)| s)
                .ok_or_else(|| DeviceError::Internal { message: format!("unknown page: {page}") })?;

            // Embedded pages (extension popup/options CSS) are compile-time
            // constants — no fetch needed.
            let url = match source {
                PageSource::Local(p) => format!("http://{host}:{port}{p}"),
                PageSource::Remote(u) => u.to_string(),
                PageSource::Embedded(_) => String::new(),
            };
            let (body, truncated): (String, bool) = match source {
                PageSource::Embedded(s) => ((*s).to_string(), false),
                _ => {
                    // Local static pages need no auth (the panel HTML is
                    // public; the token is injected server-side, the static
                    // file itself has no secrets). Remote pages are the
                    // public console/download sites — no credentials needed.
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
                    (body, len > MAX_PAGE_BYTES)
                }
            };
            // char-boundary-safe truncation: slicing a String at a fixed byte
            // index PANICS when it lands inside a multi-byte UTF-8 char.
            let text = if truncated {
                let mut end = MAX_PAGE_BYTES;
                while end > 0 && !body.is_char_boundary(end) { end -= 1; }
                &body[..end]
            } else {
                &body[..]
            };

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
