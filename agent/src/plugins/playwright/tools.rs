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

use serde_json::{json, Value};

use vale_agent_core::ToolDef;
use crate::plugins::to_value_or_empty;

/// Install dir = directory of the running vale-agent.exe (same heuristic as
/// the bridge watchdog in main.rs).
fn install_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("D:\\vale-agent"))
}

/// Read playwright-core's version from the bundled package.json.
fn pw_version(pw_dir: &std::path::Path) -> Option<String> {
    let pkg = pw_dir.join("node_modules").join("playwright-core").join("package.json");
    let text = std::fs::read_to_string(pkg).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn node_exe_path(pw_dir: &std::path::Path) -> std::path::PathBuf {
    pw_dir.join("node.exe")
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
                    "const path = require('path');",
                    "const PW = path.join(process.env.VALE_PW_DIR, 'node_modules', 'playwright-core');",
                    "const { chromium } = require(PW);",
                    "const OUT = process.env.VALE_PW_OUT;",
                    "const BASE = process.env.VALE_PW_URL || 'https://example.com';",
                    "(async () => {",
                    "  const browser = await chromium.launch({ headless: true });",
                    "  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });",
                    "  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });",
                    "  console.log('TITLE:', await page.title());",
                    "  console.log('URL:', page.url());",
                    "  console.log('TEXT:', (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '')).replace(/\\s+/g, ' '));",
                    "  await page.screenshot({ path: path.join(OUT, 'shot.png') });",
                    "  await browser.close();",
                    "})().catch(e => { console.error('FATAL', e); process.exit(1); });",
                ].join("\n");
                Ok(to_value_or_empty(&json!({
                    "pw_dir": pw.to_string_lossy(),
                    "node_exe": node_exe_path(&pw).to_string_lossy(),
                    "playwright_core_version": core_ver,
                    "chromium_bundled": chromium.exists(),
                    "screenshot_output_dir": out_dir.to_string_lossy(),
                    "usage": "Write a standalone Node script (CommonJS), require the bundled core via the exact path, screenshot to the output dir, and hand the SCRIPT SOURCE to browser_run_script — it executes with bundled node and returns stdout/stderr/exit code plus the screenshot list.",
                    "script_template": script_template,
                    "env_vars": {
                        "VALE_PW_DIR": pw.to_string_lossy(),
                        "VALE_PW_OUT": out_dir.to_string_lossy(),
                        "VALE_PW_URL": "(set by AI — any URL, e.g. https://192.168.1.1:8000/?Role=Gpon)",
                    }
                })))
            }
        },
    )
}

/// 2) browser_run_script — execute a playwright script with the bundled
/// runtime. Scripts should require the bundled core (see browser_pw_info).
fn tool_browser_run_script() -> ToolDef {
    ToolDef::new(
        "browser_run_script",
        "Run a self-contained Node/Playwright script with the device's BUNDLED node + playwright-core (never install your own). Params: script (JS source, CommonJS; require the bundled core per browser_pw_info), timeout_secs (default 120, max 600). Screenshots saved to the pwout dir are listed in the result. Returns exit_code, stdout, stderr (each capped), screenshots, timed_out.",
        json!({
            "type": "object",
            "properties": {
                "script": {"type": "string", "description": "JavaScript source (CommonJS). Use require(process.env.VALE_PW_DIR + '/node_modules/playwright-core') per browser_pw_info template."},
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
                    return Ok(to_value_or_empty(&json!({"error": format!("bundled node not found at {}", node.to_string_lossy())})));
                }
                let out_dir = dir.join("pwout");
                let _ = std::fs::create_dir_all(&out_dir);
                let before: std::collections::HashSet<String> = std::fs::read_dir(&out_dir)
                    .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".png")).map(|e| e.file_name().to_string_lossy().to_string()).collect())
                    .unwrap_or_default();
                let script_src = params.get("script").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if script_src.trim().is_empty() {
                    return Ok(to_value_or_empty(&json!({"error": "script is required"})));
                }
                let timeout_secs = params.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(120).min(600);
                let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                let script_path = out_dir.join(format!("pwai_{ts}.js"));
                if let Err(e) = std::fs::write(&script_path, &script_src) {
                    return Ok(to_value_or_empty(&json!({"error": format!("write script failed: {e}")})));
                }
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(timeout_secs),
                    async {
                        let mut cmd = tokio::process::Command::new(&node);
                        cmd.arg(&script_path)
                            .current_dir(&out_dir)
                            .env("VALE_PW_DIR", pw.to_string_lossy().to_string())
                            .env("VALE_PW_OUT", out_dir.to_string_lossy().to_string())
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
                Ok(to_value_or_empty(&json!({
                    "exit_code": exit_code,
                    "timed_out": timed_out,
                    "stdout": trunc(stdout),
                    "stderr": trunc(stderr),
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
