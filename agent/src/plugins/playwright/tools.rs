//! AI-friendly browser tools (round-151): make the agent's BUNDLED playwright
//! discoverable and executable through MCP so AI agents never need to install
//! their own copy / re-download browser binaries.
//!
//!   browser_pw_info      — paths/versions/template for the bundled playwright
//!   browser_run_script   — run a playwright script with the bundled node+core,
//!                          collect stdout/stderr/exit code + screenshots
//!
//! The bundled runtime lives next to vale-agent.exe (`playwright/node.exe` +
//! `playwright/node_modules/playwright-core`), which `vale update` keeps in
//! sync with the agent binary.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::plugins::to_value_or_empty;
use vale_agent_core::ToolDef;

/// Install dir — registry-first, then exe dir (crate::paths::install_dir).
fn install_dir() -> std::path::PathBuf {
    crate::paths::install_dir()
}

/// Per-run script stem: millisecond time + pid + process-wide counter.
/// Concurrent browser_run_script calls run as independent node processes
/// with NO runner lock (headless runs are fully parallel) — a bare
/// timestamp filename collides when two calls land in the same millisecond
/// and one process would execute the other's script. The stem doubles as
/// VALE_RUN_ID so screenshots can be namespaced per run.
static SCRIPT_SEQ: AtomicU64 = AtomicU64::new(0);

fn next_run_stem(ts_ms: u128) -> String {
    let seq = SCRIPT_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{ts_ms}_{}_{seq}", std::process::id())
}

/// Read playwright-core's version from the bundled package.json.
fn pw_version(pw_dir: &std::path::Path) -> Option<String> {
    let pkg = pw_dir
        .join("node_modules")
        .join("playwright-core")
        .join("package.json");
    let text = std::fs::read_to_string(pkg).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn node_exe_path(pw_dir: &std::path::Path) -> std::path::PathBuf {
    pw_dir.join("node.exe")
}

/// Attach-or-headless helper shipped to every script (single source — the
/// template below and AI scripts require it via VALE_BROWSER_HELPER).
/// Decides INSIDE node at run time: CDP up + watchable view -> attach
/// (actions show live); else private headless (batch-safe).
const BROWSER_HELPER_JS: &str = include_str!("helper.js");
const BROWSER_HELPER_NAME: &str = "vale-browser-helper.js";

/// Ensure the helper exists next to the run with current content.
/// Best-effort (a failed write only means scripts fall back to the
/// documented manual pattern) — never fail the tool call over it.
fn ensure_browser_helper(out_dir: &std::path::Path) -> std::path::PathBuf {
    let dest = out_dir.join(BROWSER_HELPER_NAME);
    let fresh = std::fs::read_to_string(&dest)
        .map(|s| s == BROWSER_HELPER_JS)
        .unwrap_or(false);
    if !fresh {
        let _ = std::fs::write(&dest, BROWSER_HELPER_JS);
    }
    dest
}

/// 1) browser_pw_info — what the AI can use, no install needed.
fn tool_browser_pw_info() -> ToolDef {
    ToolDef::new(
        "browser_pw_info",
        "Info about the BUNDLED Playwright runtime on this device (no install needed — AI agents must reuse it instead of installing their own): returns pw_dir, playwright-core version, node.exe path, chromium availability, screenshot output dir, and a ready-to-use script template. Combined with browser_run_script this is the canonical way to drive this device's browser.",
        json!({"type":"object","properties":{}}),
        move |_params: Value| {
            async move {
                let dir = install_dir();
                let pw = dir.join("playwright");
                let md = std::fs::metadata(pw.join("node_modules").join("playwright-core"));
let has_core = md.map(|m| m.is_dir()).unwrap_or(false);
                let core_ver = if has_core { pw_version(&pw).unwrap_or_else(|| "?".into()) } else { String::new() };
                let _node_ok = node_exe_path(&pw).exists();
                let out_dir = dir.join("pwout");
                let chromium = pw.join("chromium");
                let script_template = [
                    "const { acquireBrowser } = require(process.env.VALE_BROWSER_HELPER);",
                    "const path = require('path');",
                    "const OUT = process.env.VALE_PW_OUT;",
                    "const BASE = process.env.VALE_PW_URL || 'https://example.com';",
                    "(async () => {",
                    "  const { page, attached, close } = await acquireBrowser();",
                    "  console.log('ATTACHED=' + attached);",
                    "  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });",
                    "  console.log('TITLE:', await page.title());",
                    "  console.log('URL:', page.url());",
                    "  console.log('TEXT:', (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '')).replace(/\\s+/g, ' '));",
                    "  await page.screenshot({ path: path.join(OUT, 'shot.png') });",
                    "  await close();",
                    "})().catch(e => { console.error('FATAL', e); process.exit(1); });",
                ].join("\n");
                Ok(to_value_or_empty(json!({
                    "pw_dir": pw.to_string_lossy(),
                    "node_exe": node_exe_path(&pw).to_string_lossy(),
                    "playwright_core_version": core_ver,
                    "chromium_bundled": chromium.exists(),
                    "screenshot_output_dir": out_dir.to_string_lossy(),
                    "usage": "Write a standalone Node script (CommonJS) that requires VALE_BROWSER_HELPER and drives acquireBrowser() — it attaches to the visible embedded view when present (actions show live in the desktop Browser panel) and falls back to a private headless chromium otherwise. Screenshot to the output dir, hand the SCRIPT SOURCE to browser_run_script — it executes with bundled node and returns stdout/stderr/exit code plus the screenshot list.",
                    "script_template": script_template,
                    "env_vars": {
                        "VALE_PW_DIR": pw.to_string_lossy(),
                        "VALE_PW_OUT": out_dir.to_string_lossy(),
                        "VALE_CDP_ENDPOINT": "(desktop CDP when up, else empty — the helper reads it)",
                        "VALE_BROWSER_HELPER": "(absolute path of the acquireBrowser() helper module)",
                        "VALE_RUN_ID": "(unique per call — prefix screenshot names with it for exact attribution under concurrency)",
                        "VALE_PW_URL": "(set by AI — any URL, e.g. https://192.168.1.1:8000/?Role=Gpon)",
                    }
                })))
            }
        },
    )
}

/// 2) browser_run_script — execute a playwright script with the bundled
///    runtime. Scripts should require the bundled core (see browser_pw_info).
fn tool_browser_run_script() -> ToolDef {
    ToolDef::new(
        "browser_run_script",
        "Run a self-contained Node/Playwright script with the device's BUNDLED node + playwright-core (never install your own). Scripts run with VALE_BROWSER_HELPER set (acquireBrowser(): attaches to the visible embedded view when present so actions show live, else private headless) — prefer it over launching your own browser; headless only for batch jobs that must not disturb the watched screen. Concurrency: calls run as independent processes with NO runner lock — headless runs are fully parallel, but attached runs SHARE the single visible tab (one view shows one page; parallel visible drivers interleave, so keep interactive work serial). Screenshot namespacing: pass shots as \"<VALE_RUN_ID>-*.png\" (env, unique per call) for exact attribution under concurrency; the returned list is otherwise a best-effort before/after diff. Params: script (JS source, CommonJS; follow the browser_pw_info template), timeout_secs (default 120, max 600). Screenshots saved to the pwout dir are listed in the result. Returns exit_code, stdout, stderr (each capped), screenshots, timed_out.",
        json!({
            "type": "object",
            "properties": {
                "script": {"type": "string", "description": "JavaScript source (CommonJS). Follow the browser_pw_info template (VALE_BROWSER_HELPER acquireBrowser) so actions show live when a view is watched."},
                "timeout_secs": {"type": "integer", "description": "Execution timeout in seconds (default 120, max 600)."}
            },
            "required": ["script"]
        }),
        move |params: Value| {
            async move {
                let dir = install_dir();
                let pw = dir.join("playwright");
                let node = node_exe_path(&pw);
                if !node.exists() {
                    return Ok(to_value_or_empty(json!({"error": format!("bundled node not found at {}", node.to_string_lossy())})));
                }
                let out_dir = dir.join("pwout");
                let _ = std::fs::create_dir_all(&out_dir);
                // The helper + detection inputs every script gets: the
                // attach-or-headless module (always in sync — rewritten on
                // content drift) and the desktop CDP endpoint when up
                // (empty = no watchable view, helper falls back silently).
                let helper = ensure_browser_helper(&out_dir);
                let cdp = crate::plugins::mcp_client::tools::preferred_cdp_endpoint()
                    .unwrap_or_default();
                let before: std::collections::HashSet<String> = std::fs::read_dir(&out_dir)
                    .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".png")).map(|e| e.file_name().to_string_lossy().to_string()).collect())
                    .unwrap_or_default();
                let script_src = params.get("script").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if script_src.trim().is_empty() {
                    return Ok(to_value_or_empty(json!({"error": "script is required"})));
                }
                let timeout_secs = params.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(120).min(600);
                let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                let run_stem = next_run_stem(ts);
                let script_path = out_dir.join(format!("pwai_{run_stem}.js"));
                if let Err(e) = std::fs::write(&script_path, &script_src) {
                    return Ok(to_value_or_empty(json!({"error": format!("write script failed: {e}")})));
                }
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(timeout_secs),
                    async {
                        let mut cmd = tokio::process::Command::new(&node);
                        cmd.arg(&script_path)
                            .current_dir(&out_dir)
                            .env("VALE_PW_DIR", pw.to_string_lossy().to_string())
                            .env("VALE_PW_OUT", out_dir.to_string_lossy().to_string())
                            .env("VALE_CDP_ENDPOINT", cdp)
                            .env(
                                "VALE_BROWSER_HELPER",
                                helper.to_string_lossy().to_string(),
                            )
                            // Run identity for screenshot namespacing: the
                            // screenshots list is a before/after diff over
                            // the shared pwout dir, so under concurrency a
                            // sibling run's shot can be misattributed.
                            // Naming shots "<VALE_RUN_ID>-*.png" makes
                            // attribution exact; without it, best-effort.
                            .env("VALE_RUN_ID", run_stem.clone())
                            .stdout(std::process::Stdio::piped())
                            .stderr(std::process::Stdio::piped());
                        let output = cmd.output().await;
                        output
                    },
                ).await;
                let (timed_out, exit_code, stdout, stderr) = match result {
                    Err(_) => (true, None, String::new(), format!("timed out after {timeout_secs}s")),
                    Ok(Err(e)) => (false, None, String::new(), format!("spawn failed: {e}")),
                    Ok(Ok(o)) => (
                        false,
                        o.status.code(),
                        String::from_utf8_lossy(&o.stdout).to_string(),
                        String::from_utf8_lossy(&o.stderr).to_string(),
                    ),
                };
                let trunc = |s: String| {
                    if s.len() <= 131072 { return s; }
                    let mut end = 131072;
                    while !s.is_char_boundary(end) { end -= 1; }
                    format!("{}…[truncated]", &s[..end])
                };
                let after: Vec<String> = std::fs::read_dir(&out_dir)
                    .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".png") && !before.contains(&e.file_name().to_string_lossy().to_string())).map(|e| e.file_name().to_string_lossy().to_string()).collect())
                    .unwrap_or_default();
                // P2: AI-action timeline — append one JSONL line per
                // browser_run_script execution (the panel's Evidence view
                // polls /api/browser/actions and renders these as the "what
                // did the AI do" log, paired with the screenshot strip).
                let script_preview: String = {
                    let s = script_src.replace('\n', " ").trim().to_string();
                    if s.len() > 200 { format!("{}…", &s[..200]) } else { s }
                };
                let duration_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0).saturating_sub(ts);
                let stdout_full = trunc(stdout);
                let stderr_full = trunc(stderr);
                let tail = |s: &str| s.chars().rev().take(300).collect::<String>().chars().rev().collect::<String>();
                let _ = std::fs::OpenOptions::new().create(true).append(true).open(out_dir.join("actions.jsonl")).and_then(|mut f| {
                    use std::io::Write;
                    writeln!(f, "{}", serde_json::json!({
                        "ts": ts,
                        "duration_ms": duration_ms,
                        "exit_code": exit_code,
                        "timed_out": timed_out,
                        "script": script_preview,
                        "screenshots": after,
                        "stdout_tail": tail(&stdout_full),
                        "stderr_tail": tail(&stderr_full),
                    }))
                });
                Ok(to_value_or_empty(json!({
                    "exit_code": exit_code,
                    "timed_out": timed_out,
                    "stdout": stdout_full,
                    "stderr": stderr_full,
                    "screenshots": after,
                    "pwout_dir": out_dir.to_string_lossy(),
                    "script_file": script_path.to_string_lossy(),
                })))
            }
        },
    )
}

pub(super) fn build() -> Vec<ToolDef> {
    vec![tool_browser_pw_info(), tool_browser_run_script()]
}

#[cfg(test)]
mod tools_tests {
    //! round-382: the bundled-playwright discovery helpers had zero tests.
    use super::*;

    #[test]
    fn node_exe_path_joins_under_pw_dir() {
        let pw = std::path::Path::new("/opt/vale/playwright");
        assert_eq!(node_exe_path(pw), pw.join("node.exe"));
    }

    #[test]
    fn pw_version_reads_bundled_package_json() {
        let dir = std::env::temp_dir().join(format!("vale-pwver-{}", std::process::id()));
        let core = dir.join("node_modules").join("playwright-core");
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(
            core.join("package.json"),
            r#"{"name":"playwright-core","version":"1.2.3"}"#,
        )
        .unwrap();
        assert_eq!(pw_version(&dir).as_deref(), Some("1.2.3"));
        assert_eq!(
            pw_version(std::path::Path::new("/definitely/not/here")),
            None
        );
        std::fs::write(core.join("package.json"), "not json").unwrap();
        assert_eq!(pw_version(&dir), None);
        std::fs::write(core.join("package.json"), r#"{"version":42}"#).unwrap();
        assert_eq!(pw_version(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_exposes_two_browser_tools() {
        let names: Vec<String> = build().iter().map(|t| t.name.clone()).collect();
        assert_eq!(names, vec!["browser_pw_info", "browser_run_script"]);
    }

    #[test]
    fn run_stems_are_unique_within_a_millisecond() {
        // The concurrency fix: same-ms stems must still differ (pid+seq).
        let a = next_run_stem(1_700_000_000_000);
        let b = next_run_stem(1_700_000_000_000);
        assert_ne!(a, b, "same-ms stems collided");
        assert!(
            a.starts_with("1700000000000_") && b.starts_with("1700000000000_"),
            "stem carries the timestamp: {a} / {b}"
        );
        assert!(
            a.contains(&std::process::id().to_string()),
            "stem carries the pid: {a}"
        );
    }

    #[test]
    fn helper_is_ascii_acquire_or_headless() {
        // The shipped helper is the attach default — pin its contract:
        // acquire entry, CDP attach first, headless fallback, shared-
        // browser-safe close, and ASCII-only (system-locale node).
        for token in [
            "acquireBrowser",
            "connectOverCDP",
            "headless",
            "ignoreHTTPSErrors",
            "module.exports",
            "VALE_CDP_ENDPOINT",
            "VALE_PW_DIR",
        ] {
            assert!(
                BROWSER_HELPER_JS.contains(token),
                "helper must contain {token}"
            );
        }
        assert!(
            !BROWSER_HELPER_JS.bytes().any(|b| b > 127),
            "helper must be ASCII-only"
        );
        assert_eq!(BROWSER_HELPER_NAME, "vale-browser-helper.js");
    }

    #[test]
    fn ensure_browser_helper_writes_and_repairs() {
        let dir = std::env::temp_dir().join(format!("vale-helper-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = ensure_browser_helper(&dir);
        assert_eq!(dest, dir.join(BROWSER_HELPER_NAME));
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), BROWSER_HELPER_JS);
        // Second call is a no-op rewrite-skip (content already fresh).
        let dest2 = ensure_browser_helper(&dir);
        assert_eq!(dest2, dest);
        // Drift (operator edit) is repaired on next run.
        std::fs::write(&dest, "// stale").unwrap();
        ensure_browser_helper(&dir);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), BROWSER_HELPER_JS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn pw_info_template_prefers_the_helper() {
        // The default template must drive acquireBrowser (visible view
        // first), not a private headless launch.
        let tools = build();
        let info = tools
            .iter()
            .find(|t| t.name == "browser_pw_info")
            .expect("browser_pw_info");
        let out = info
            .handler
            .call(serde_json::json!({}))
            .await
            .expect("pw_info call");
        let template = out
            .get("script_template")
            .and_then(|v| v.as_str())
            .expect("template string");
        assert!(
            template.contains("acquireBrowser"),
            "template must use the helper"
        );
        assert!(
            !template.contains("chromium.launch"),
            "template must not default to a private headless browser"
        );
        for key in ["VALE_BROWSER_HELPER", "VALE_CDP_ENDPOINT"] {
            assert!(
                out.get("env_vars").and_then(|e| e.get(key)).is_some(),
                "env_vars must document {key}"
            );
        }
    }
}
