//! Headless browser backend — drives a local Chrome/Edge (`--headless=new`)
//! over CDP with no Tauri/WebView required. Compiled when the `browser`
//! feature is on without `tauri`. Reuses the same `CdpClient` and the same
//! snapshot/click/type/press/wait JS as the desktop backend.
//!
//! Lazy launch: the browser process is spawned on first operation that needs
//! a page (`tab_list`/`tab_count` never launch it). On drop, the child is
//! killed and its temp profile removed.

use super::*;
use crate::tools::cdp::{CdpClient, CDP_PORT};
use vale_command_core::{AgentEvent, DeviceError, EventBus};

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Tab {
    id: String,
    url: String,
    /// CDP page-target id — known at creation, so no fuzzy matching is needed.
    target_id: String,
}

/// Manager state behind the internal lock (callers hold `Arc<BrowserManager>`).
struct BrowserInner {
    tabs: Vec<Tab>,
    active_tab_id: Option<String>,
    next_tab_id: u32,
    /// tab_id -> live CDP client
    cdp: HashMap<String, Arc<CdpClient>>,
}

/// Owns the spawned browser child; kills it and removes its temp profile on drop.
struct BrowserProcess {
    child: std::process::Child,
    user_data_dir: PathBuf,
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.user_data_dir);
    }
}

pub struct BrowserManager {
    inner: tokio::sync::Mutex<BrowserInner>,
    default_timeout: Duration,
    event_bus: Arc<std::sync::Mutex<Option<Arc<dyn EventBus>>>>,
    process: Arc<std::sync::Mutex<Option<BrowserProcess>>>,
    executable: Option<String>,
    port: u16,
}

/// Which navigation to fire — navigate, history JS, or reload.
enum NavAction<'a> {
    Navigate(&'a str),
    History(&'a str),
    Reload,
}

/// Wait (bounded) for `Page.loadEventFired` after firing a navigation,
/// then a short settle delay. SPA pushState navigations fire no load
/// event, so the wait falls through after the timeout.
async fn wait_for_load(rx: &mut tokio::sync::broadcast::Receiver<serde_json::Value>, timeout: Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    while let Ok(Ok(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if ev.get("method").and_then(|m| m.as_str()) == Some("Page.loadEventFired") {
            break;
        }
        // Timeout (SPA nav) or channel closed falls out of the while condition.
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
}

/// Probe the well-known Edge/Chrome paths (Windows) or a set of binary names
/// (other platforms). Config/env overrides win in `with_config`.
fn find_default_browser() -> String {
    #[cfg(target_os = "windows")]
    {
        const CANDIDATES: [&str; 4] = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ];
        for p in CANDIDATES {
            if std::path::Path::new(p).exists() {
                return p.to_string();
            }
        }
        "msedge".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        for name in ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"] {
            let ok = std::process::Command::new(name)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                return name.to_string();
            }
        }
        "chromium".to_string()
    }
}

impl BrowserInner {
    /// CDP client for the active tab — reuse the live one, or rebind by the
    /// tab's target id from `/json` (retry in case the target lags).
    async fn active_cdp(&mut self, port: u16) -> Result<Arc<CdpClient>, DeviceError> {
        let tab_id = self.active_tab_id.clone()
            .ok_or_else(|| DeviceError::BrowserNotConnected { reason: "no tab open".into() })?;
        if let Some(cdp) = self.cdp.get(&tab_id) {
            if cdp.evaluate("1").await.is_ok() {
                return Ok(cdp.clone());
            }
            self.cdp.remove(&tab_id);
        }
        let target_id = self.tabs.iter()
            .find(|t| t.id == tab_id)
            .map(|t| t.target_id.clone())
            .ok_or_else(|| DeviceError::BrowserNotConnected { reason: "tab not found".into() })?;
        for _ in 0..10 {
            let ws = CdpClient::list_targets_on(port).await
                .unwrap_or_default()
                .into_iter()
                .find(|t| t.0 == target_id)
                .map(|t| t.3);
            if let Some(ws) = ws {
                let client = Arc::new(CdpClient::connect_ws(&ws).await?);
                self.cdp.insert(tab_id.clone(), client.clone());
                return Ok(client);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(DeviceError::CdpTargetNotFound { tab_id })
    }

    /// Snapshot of the active page's interactive elements (see BrowserManager::navigate).
    async fn snapshot_inner(&self, cdp: &CdpClient) -> Result<String, DeviceError> {
        let meta = cdp.evaluate("JSON.stringify({url:document.location.href,readyState:document.readyState})").await
            .map(|v| v.as_str().unwrap_or("{}").to_string())
            .unwrap_or_else(|_| "{}".to_string());
        let active_id = self.active_tab_id.clone().unwrap_or_default();
        let target_id = self.tabs.iter()
            .find(|t| t.id == active_id)
            .map(|t| t.target_id.clone())
            .unwrap_or_default();
        let meta_json: serde_json::Value = serde_json::from_str(&meta).unwrap_or_default();
        let page_url = meta_json.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let ready = meta_json.get("readyState").and_then(|v| v.as_str()).unwrap_or("");

        let js = r#"(function(){
                var url=document.location.href,title=document.title;
                var els=document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]');
                var out=[],max=150;
                var limit=Math.min(els.length,max);
                // Generation signature for stale-ref detection
                var gen=Date.now().toString(36)+'-'+(Math.random()*0xffff|0).toString(36);
                for(var i=0;i<limit;i++){
                    var e=els[i];
                    e.setAttribute('data-mcp-ref',i+'|'+gen);
                    out.push('['+i+'] <'+e.tagName.toLowerCase()+'> '+(e.textContent||e.value||'').trim().substring(0,80));
                }
                if(els.length>max)out.push('... ('+(els.length-max)+' more elements, use browser_evaluate for full DOM)');
                return out.join('\n');
            })()"#;
        let v = cdp.evaluate(js).await?;
        let body = v.as_str().unwrap_or_default().to_string();
        Ok(format!("tab_id: {active_id}\ntarget_id: {target_id}\nurl: {page_url}\nreadyState: {ready}\n---\n{body}"))
    }

    /// Fire a navigation action and snapshot the result.
    async fn navigate_action(
        &mut self,
        port: u16,
        timeout: Duration,
        action: NavAction<'_>,
    ) -> Result<String, DeviceError> {
        let cdp = self.active_cdp(port).await?;
        if let Err(e) = cdp.send("Page.enable", serde_json::json!({})).await {
            tracing::debug!("[vale_command] Page.enable: {e}");
        }
        let mut rx = cdp.subscribe_events();
        match action {
            NavAction::Navigate(url) => cdp.navigate(url).await?,
            NavAction::History(js) => { cdp.evaluate(js).await?; }
            NavAction::Reload => { cdp.send("Page.reload", serde_json::json!({})).await?; }
        }
        wait_for_load(&mut rx, timeout).await;
        self.snapshot_inner(&cdp).await
    }
}

impl BrowserManager {
    pub fn new(timeout: u64) -> Self {
        Self::with_config(timeout, None, None)
    }

    pub fn with_config(timeout: u64, executable: Option<String>, cdp_port: Option<u16>) -> Self {
        let executable = executable
            .or_else(|| std::env::var("CAPDECK_BROWSER_EXECUTABLE").ok())
            .or_else(|| std::env::var("VALE_COMMAND_BROWSER_EXECUTABLE").ok());
        let port = cdp_port
            .or_else(|| std::env::var("CAPDECK_CDP_PORT").ok().and_then(|p| p.parse().ok()))
            .or_else(|| std::env::var("VALE_COMMAND_CDP_PORT").ok().and_then(|p| p.parse().ok()))
            .unwrap_or(CDP_PORT);
        Self {
            inner: tokio::sync::Mutex::new(BrowserInner {
                tabs: Vec::new(),
                active_tab_id: None,
                next_tab_id: 1,
                cdp: HashMap::new(),
            }),
            default_timeout: Duration::from_secs(timeout),
            event_bus: Arc::new(std::sync::Mutex::new(None)),
            process: Arc::new(std::sync::Mutex::new(None)),
            executable,
            port,
        }
    }

    /// Set the event bus (setup only).
    pub fn set_event_bus(&self, bus: Arc<dyn EventBus>) {
        *self.event_bus.lock().unwrap_or_else(|p| p.into_inner()) = Some(bus);
    }

    pub fn set_main_window(&self, _: ()) {}

    fn emit_nav(&self, url: &str) {
        if let Ok(guard) = self.event_bus.lock() {
            if let Some(ref bus) = *guard {
                bus.emit(&AgentEvent::BrowserNavigate { url: url.to_string(), title: String::new() });
            }
        }
    }

    // ── Browser process lifecycle ──────────────────────────

    /// Lazy-launch the headless browser and wait for its CDP port.
    async fn ensure_browser(&self) -> Result<(), DeviceError> {
        if CdpClient::list_targets_on(self.port).await.is_ok() {
            return Ok(());
        }
        {
            let mut proc = self.process.lock().unwrap_or_else(|p| p.into_inner());
            if proc.is_none() {
                *proc = Some(self.spawn_browser()?);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if CdpClient::list_targets_on(self.port).await.is_ok() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(DeviceError::BrowserNotConnected {
                    reason: format!("CDP port {} did not come up (browser not found?)", self.port),
                });
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    fn spawn_browser(&self) -> Result<BrowserProcess, DeviceError> {
        let exe = self.executable.clone().unwrap_or_else(find_default_browser);
        let user_data_dir = std::env::temp_dir().join(format!("vale-command-cdp-{}", std::process::id()));
        let child = std::process::Command::new(&exe)
            .args([
                "--headless=new",
                &format!("--remote-debugging-port={}", self.port),
                &format!("--user-data-dir={}", user_data_dir.display()),
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-gpu",
                "--remote-allow-origins=*",
                "about:blank",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| DeviceError::BrowserNotConnected { reason: format!("spawn {exe}: {e}") })?;
        Ok(BrowserProcess { child, user_data_dir })
    }

    /// Browser-level WebSocket URL (`/json/version`).
    async fn browser_ws(port: u16) -> Result<String, DeviceError> {
        let version_url = format!("http://localhost:{port}/json/version");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|e| DeviceError::CdpConnectionFailed { reason: format!("http client: {e}") })?;
        let resp = client.get(&version_url).send().await
            .map_err(|e| DeviceError::CdpConnectionFailed { reason: format!("http: {e}") })?;
        let v: serde_json::Value = resp.json().await
            .map_err(|e| DeviceError::CdpConnectionFailed { reason: format!("parse: {e}") })?;
        v.get("webSocketDebuggerUrl").and_then(|x| x.as_str()).map(|s| s.to_string())
            .ok_or_else(|| DeviceError::CdpConnectionFailed { reason: "no webSocketDebuggerUrl".into() })
    }

    async fn connect_browser(&self) -> Result<CdpClient, DeviceError> {
        let ws = Self::browser_ws(self.port).await?;
        CdpClient::connect_ws(&ws).await
    }

    /// Create a page target and wait for it to appear in `/json`.
    async fn create_target(&self, url: &str) -> Result<String, DeviceError> {
        let cdp = self.connect_browser().await?;
        let r = cdp.send("Target.createTarget", serde_json::json!({"url": url})).await?;
        let target_id = r.get("targetId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if target_id.is_empty() {
            return Err(DeviceError::CdpCommand { method: "Target.createTarget".into(), reason: "no targetId".into() });
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let targets = CdpClient::list_targets_on(self.port).await.unwrap_or_default();
            if targets.iter().any(|t| t.0 == target_id) {
                return Ok(target_id);
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // Created even if /json lags; active_cdp retries binding on first use.
        Ok(target_id)
    }

    async fn close_target(port: u16, target_id: &str) -> Result<(), DeviceError> {
        let ws = Self::browser_ws(port).await?;
        let cdp = CdpClient::connect_ws(&ws).await?;
        let _ = cdp.send("Target.closeTarget", serde_json::json!({"targetId": target_id})).await;
        Ok(())
    }

    // ── Tab management ─────────────────────────────────────

    pub async fn tab_new(&self, url: &str) -> Result<String, DeviceError> {
        let _ = url::Url::parse(url)
            .map_err(|e| DeviceError::Internal { message: format!("invalid url: {e}") })?;
        self.ensure_browser().await?;
        let target_id = self.create_target(url).await?;
        let mut inner = self.inner.lock().await;
        let id = format!("tab-{}", inner.next_tab_id);
        inner.next_tab_id += 1;
        inner.tabs.push(Tab { id: id.clone(), url: url.to_string(), target_id });
        inner.active_tab_id = Some(id.clone());
        Ok(id)
    }

    pub async fn tab_list(&self) -> Result<Vec<TabInfo>, DeviceError> {
        let inner = self.inner.lock().await;
        Ok(inner.tabs.iter().map(|t| TabInfo { id: t.id.clone(), url: t.url.clone(), title: String::new() }).collect())
    }

    pub async fn tab_select(&self, tid: &str) -> Result<(), DeviceError> {
        let mut inner = self.inner.lock().await;
        if !inner.tabs.iter().any(|t| t.id == tid) {
            return Err(DeviceError::Internal { message: format!("tab not found: {tid}") });
        }
        inner.active_tab_id = Some(tid.to_string());
        // Best-effort bring-to-front (no-op if the target vanished).
        if let Ok(cdp) = inner.active_cdp(self.port).await {
            let _ = cdp.send("Page.bringToFront", serde_json::json!({})).await;
        }
        Ok(())
    }

    pub async fn tab_close(&self, tid: &str) -> Result<(), DeviceError> {
        let mut inner = self.inner.lock().await;
        if inner.tabs.len() <= 1 {
            return Err(DeviceError::Internal { message: "cannot close last tab".into() });
        }
        if let Some(pos) = inner.tabs.iter().position(|t| t.id == tid) {
            let tab = inner.tabs.remove(pos);
            inner.cdp.remove(tid);
            let _ = Self::close_target(self.port, &tab.target_id).await;
            if inner.active_tab_id.as_deref() == Some(tid) {
                inner.active_tab_id = inner.tabs.first().map(|t| t.id.clone());
            }
        }
        Ok(())
    }

    pub async fn active_tab_id(&self) -> Option<String> {
        self.inner.lock().await.active_tab_id.clone()
    }

    pub async fn tab_count(&self) -> usize {
        self.inner.lock().await.tabs.len()
    }

    pub fn child_webview_slot(&self) -> Arc<std::sync::Mutex<Option<()>>> {
        Arc::new(std::sync::Mutex::new(None))
    }

    pub fn set_child_webview_slot(&self, _: ()) {}

    pub async fn hide_all(&self) {}

    pub async fn active_wv(&self) -> Result<(), DeviceError> {
        Err(DeviceError::BrowserNotConnected { reason: "no webview in headless mode".into() })
    }

    // ── Browser operations (all via CDP) ───────────────────

    pub async fn navigate(&self, url: &str) -> Result<String, DeviceError> {
        let result = {
            let mut inner = self.inner.lock().await;
            if inner.tabs.is_empty() {
                drop(inner);
                self.ensure_browser().await?;
                let target_id = self.create_target(url).await?;
                inner = self.inner.lock().await;
                inner.tabs.push(Tab { id: "tab-0".into(), url: url.to_string(), target_id });
                inner.active_tab_id = Some("tab-0".into());
            }
            let r = inner.navigate_action(
                self.port,
                Duration::from_secs(self.default_timeout.as_secs().max(1)),
                NavAction::Navigate(url),
            ).await;
            let active_id = inner.active_tab_id.clone().unwrap_or_default();
            if let Some(tab) = inner.tabs.iter_mut().find(|t| t.id == active_id) {
                tab.url = url.to_string();
            }
            r
        };
        if result.is_ok() {
            self.emit_nav(url);
        }
        result
    }

    pub async fn snapshot(&self) -> Result<String, DeviceError> {
        let mut inner = self.inner.lock().await;
        let cdp = inner.active_cdp(self.port).await?;
        inner.snapshot_inner(&cdp).await
    }

    pub async fn click(&self, sel: &str) -> Result<String, DeviceError> {
        let mut inner = self.inner.lock().await;
        let cdp = inner.active_cdp(self.port).await?;
        let js = if let Ok(n) = sel.parse::<u32>() {
            format!(
                "(function(){{var e=document.querySelector('[data-mcp-ref^=\"{n}|\"]');\
                if(!e)return'error:ref {n} not found (DOM changed since last snapshot?)';\
                e.scrollIntoView({{block:'center',behavior:'instant'}});\
                var r=e.getBoundingClientRect();\
                e.click();\
                return'clicked ['+n+'] <'+e.tagName.toLowerCase()+'> '+((e.textContent||e.value||'').trim().substring(0,60));}})()")
        } else {
            let safe_sel = sel.replace('\\', "\\\\").replace('\'', "\\'");
            format!(
                "(function(){{var e=document.querySelector('{safe_sel}');\
                if(!e)return'error:selector \"{safe_sel}\" not found';\
                e.scrollIntoView({{block:'center',behavior:'instant'}});\
                e.click();\
                return'clicked <'+e.tagName.toLowerCase()+'> '+((e.textContent||e.value||'').trim().substring(0,60));}})()")
        };
        let result = cdp.evaluate(&js).await?;
        let text = result.as_str().unwrap_or("unknown").to_string();
        tracing::debug!("[vale_command] click: {sel} -> {text}");
        if text.starts_with("error:") {
            Err(DeviceError::Internal { message: text })
        } else {
            Ok(text)
        }
    }

    pub async fn type_text(&self, sel: &str, text: &str) -> Result<(), DeviceError> {
        let mut inner = self.inner.lock().await;
        let cdp = inner.active_cdp(self.port).await?;
        // Step 1: Focus and click the target element
        let safe_sel = sel.replace('\\', "\\\\").replace('\'', "\\'");
        let focus_js = if let Ok(n) = sel.parse::<u32>() {
            format!("(function(){{var e=document.querySelector('[data-mcp-ref=\"{n}\"]');if(e){{e.focus();e.click();return true}}return false}})()")
        } else {
            format!("(function(){{var e=document.querySelector('{safe_sel}');if(e){{e.focus();e.click();return true}}return false}})()")
        };
        cdp.evaluate(&focus_js).await?;
        // Step 2: Select all existing text (Ctrl+A) so insertText replaces it
        for key_type in &["keyDown", "keyUp"] {
            cdp.send("Input.dispatchKeyEvent", serde_json::json!({
                "type": key_type, "modifiers": 2,
                "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65,
            })).await.ok();
        }
        // Step 3: Insert text via CDP Input domain (simulates real typing, works with React etc.)
        cdp.send("Input.insertText", serde_json::json!({ "text": text }))
            .await?;
        Ok(())
    }

    pub async fn press_key(&self, key: &str) -> Result<(), DeviceError> {
        let mut inner = self.inner.lock().await;
        let cdp = inner.active_cdp(self.port).await?;
        // Map common key names to CDP Input.dispatchKeyEvent params
        let (key_name, code, vk) = match key.to_lowercase().as_str() {
            "enter" | "return" => ("Enter", "Enter", 13),
            "tab" => ("Tab", "Tab", 9),
            "escape" | "esc" => ("Escape", "Escape", 27),
            "backspace" => ("Backspace", "Backspace", 8),
            "delete" | "del" => ("Delete", "Delete", 46),
            "arrowup" | "up" => ("ArrowUp", "ArrowUp", 38),
            "arrowdown" | "down" => ("ArrowDown", "ArrowDown", 40),
            "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft", 37),
            "arrowright" | "right" => ("ArrowRight", "ArrowRight", 39),
            "home" => ("Home", "Home", 36),
            "end" => ("End", "End", 35),
            "pageup" => ("PageUp", "PageUp", 33),
            "pagedown" => ("PageDown", "PageDown", 34),
            "space" | " " => (" ", "Space", 32),
            _ => (key, "", 0),
        };
        for key_type in &["keyDown", "keyUp"] {
            let mut params = serde_json::json!({ "type": key_type, "key": key_name });
            if !code.is_empty() {
                params["code"] = serde_json::json!(code);
            }
            if vk > 0 {
                params["windowsVirtualKeyCode"] = serde_json::json!(vk);
            }
            cdp.send("Input.dispatchKeyEvent", params).await?;
        }
        Ok(())
    }

    pub async fn screenshot(&self, full_page: Option<bool>) -> Result<String, DeviceError> {
        let mut inner = self.inner.lock().await;
        let cdp = inner.active_cdp(self.port).await?;
        if full_page == Some(true) {
            // Full-page capture: clip to the document's content size
            if let Ok(metrics) = cdp.send("Page.getLayoutMetrics", serde_json::json!({})).await {
                let content = metrics.get("contentSize");
                let w = content.and_then(|c| c.get("width")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = content.and_then(|c| c.get("height")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                if w > 0.0 && h > 0.0 {
                    let r = cdp.send("Page.captureScreenshot", serde_json::json!({
                        "format": "png",
                        "captureBeyondViewport": true,
                        "clip": {"x": 0.0, "y": 0.0, "width": w, "height": h, "scale": 1.0}
                    })).await?;
                    if let Some(data) = r.get("data").and_then(|d| d.as_str()) {
                        tracing::debug!("[vale_command] screenshot: full page {w}x{h} ({} bytes)", data.len());
                        return Ok(data.to_string());
                    }
                }
            }
            // Metrics unavailable — fall through to a viewport screenshot
        }
        let data = cdp.screenshot().await?;
        tracing::debug!("[vale_command] screenshot: CDP OK ({} bytes)", data.len());
        Ok(data)
    }

    pub async fn evaluate(&self, js: &str) -> Result<String, DeviceError> {
        let mut inner = self.inner.lock().await;
        let cdp = inner.active_cdp(self.port).await?;
        let v = cdp.evaluate(js).await?;
        Ok(serde_json::to_string(&v).unwrap_or_default())
    }

    pub async fn wait_for(&self, sel: &str, timeout: Option<u64>) -> Result<(), DeviceError> {
        let mut inner = self.inner.lock().await;
        let cdp = inner.active_cdp(self.port).await?;
        let t = timeout.unwrap_or(10);
        let safe_sel = sel.replace('\\', "\\\\").replace('\'', "\\'").replace('"', "\\\"");
        // Separate CSS selector probe (with try/catch — CSS-special chars like ":" throw)
        // from textContent search (works for any literal text).
        let js = format!(
            "(function(){{try{{if(document.querySelector(\"{safe_sel}\"))return true}}catch(e){{}}\
             return!!(document.body&&document.body.innerText&&document.body.innerText.indexOf(\"{safe_sel}\")!==-1)}})()"
        );
        let start = std::time::Instant::now();
        loop {
            if let Ok(v) = cdp.evaluate(&js).await {
                if v.as_bool().unwrap_or(false) { return Ok(()); }
            }
            if start.elapsed() > Duration::from_secs(t) {
                return Err(DeviceError::BrowserTimeout { message: format!("wait_for timeout: {sel}") });
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    pub async fn scroll(&self, dir: &str, amt: Option<u32>) -> Result<(), DeviceError> {
        let mut inner = self.inner.lock().await;
        let cdp = inner.active_cdp(self.port).await?;
        let px = amt.unwrap_or(300);
        let js = match dir {
            "up" => format!("window.scrollBy(0,-{px})"),
            "down" => format!("window.scrollBy(0,{px})"),
            _ => return Err(DeviceError::Internal { message: format!("bad direction: {dir}") }),
        };
        cdp.evaluate(&js).await?;
        Ok(())
    }

    pub async fn go_back(&self) -> Result<String, DeviceError> {
        let mut inner = self.inner.lock().await;
        inner.navigate_action(self.port, Duration::from_secs(3), NavAction::History("history.back()")).await
    }

    pub async fn go_forward(&self) -> Result<String, DeviceError> {
        let mut inner = self.inner.lock().await;
        inner.navigate_action(self.port, Duration::from_secs(3), NavAction::History("history.forward()")).await
    }

    pub async fn reload(&self) -> Result<String, DeviceError> {
        let mut inner = self.inner.lock().await;
        inner.navigate_action(
            self.port,
            Duration::from_secs(self.default_timeout.as_secs().max(1)),
            NavAction::Reload,
        ).await
    }

    /// No native UI window in headless mode.
    pub async fn screenshot_ui(&self) -> Result<String, DeviceError> {
        Err(DeviceError::BrowserNotConnected { reason: "Vale Command UI window only exists in desktop mode".into() })
    }

    /// No native UI window in headless mode.
    pub async fn evaluate_ui(&self, _js: &str) -> Result<String, DeviceError> {
        Err(DeviceError::BrowserNotConnected { reason: "Vale Command UI window only exists in desktop mode".into() })
    }
}
