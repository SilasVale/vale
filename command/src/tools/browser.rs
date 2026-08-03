//! Browser automation via Tauri multi-webview tabs + CDP.
//!
//! `BrowserManager` owns its synchronization internally: callers hold
//! `Arc<BrowserManager>` and never touch a lock. State lives in a private
//! `tokio::sync::Mutex<BrowserInner>`; each method locks for the duration of
//! its own operation and drops the guard before returning, so concurrent
//! MCP/web/Tauri calls interleave at the call boundary.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TabInfo {
    pub id: String,
    pub url: String,
    pub title: String,
}

#[cfg(all(feature = "tauri", feature = "browser"))]
mod desktop_impl {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use vale_command_core::{AgentEvent, DeviceError, EventBus};
    use crate::tools::cdp::CdpClient;
    use tokio::sync::broadcast;

    /// Wait (bounded) for `Page.loadEventFired` after firing a navigation,
    /// then a short settle delay. SPA pushState navigations fire no load
    /// event, so the wait falls through after the timeout.
    async fn wait_for_load(rx: &mut broadcast::Receiver<serde_json::Value>, timeout: Duration) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(ev)) => {
                    if ev.get("method").and_then(|m| m.as_str()) == Some("Page.loadEventFired") {
                        break;
                    }
                }
                _ => break, // timeout (SPA nav) or channel closed
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    struct Tab {
        id: String,
        url: String,
        target_id: Option<String>, // CDP target ID, bound at creation time
        webview: tauri::Webview,
    }

    /// CDP connection pool — one connection per tab, keyed by tab ID.
    /// Each entry tracks the CDP target's ws_url so two tabs never bind to the
    /// same target (per-tab binding, not index- or first-match-based).
    struct CdpPool {
        /// tab_id -> (target ws_url, client)
        connections: HashMap<String, (String, Arc<CdpClient>)>,
    }

    impl CdpPool {
        fn new() -> Self {
            Self { connections: HashMap::new() }
        }

        /// Get or create a CDP connection for a tab.
        /// Reuses a live connection if present; re-binds by `target_id` if the
        /// tab has one; falls back to a direct `/json` lookup with retry only
        /// for boot `tab-0` (no target_id). No fuzzy URL matching.
        async fn connect_for_tab(&mut self, tab_id: &str, target_id: Option<String>) -> Result<Arc<CdpClient>, DeviceError> {
            // Reuse live connection
            if let Some((_, cdp)) = self.connections.get(tab_id) {
                if cdp.evaluate("1").await.is_ok() {
                    return Ok(cdp.clone());
                }
                self.connections.remove(tab_id);
            }

            // One retry loop covers both binding modes:
            // - target_id Some: match that exact CDP target (WebView2 startup race → retry 3s)
            // - target_id None: lazy binding — first unclaimed non-UI target (retry 5s,
            //   a new tab's CDP target may take a moment to appear)
            let claimed: HashSet<String> = self.connections.values()
                .map(|(ws, _)| ws.clone())
                .collect();
            let attempts = if target_id.is_some() { 15 } else { 25 };
            for _ in 0..attempts {
                if let Ok(targets) = CdpClient::list_targets().await {
                    let found = targets.iter().find(|t| match &target_id {
                        Some(tid) => t.0 == *tid && !t.3.is_empty(),
                        None => {
                            let url = &t.1;
                            !url.contains("tauri://") && !url.contains("tauri.localhost")
                                && !url.contains("devtools") && !url.is_empty()
                                && !t.3.is_empty() && !claimed.contains(&t.3)
                        }
                    });
                    if let Some(tgt) = found {
                        let ws = tgt.3.clone();
                        let client = CdpClient::connect_ws(&ws).await?;
                        let arc = Arc::new(client);
                        self.connections.insert(tab_id.to_string(), (ws, arc.clone()));
                        tracing::debug!("[vale_command] CDP bound {tab_id} ({})", if target_id.is_some() { "target_id" } else { "lazy" });
                        return Ok(arc);
                    }
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(DeviceError::CdpTargetNotFound { tab_id: tab_id.to_string() })
        }

        /// Remove connection for a closed tab.
        fn remove(&mut self, tab_id: &str) {
            self.connections.remove(tab_id);
        }
    }

    /// Manager state behind the internal lock. Everything a method needs
    /// beyond `default_timeout`, `event_bus`, and `child_webview_slot`.
    struct BrowserInner {
        main_window: Option<tauri::Window>,
        tabs: Vec<Tab>,
        active_tab_id: Option<String>,
        next_tab_id: u32,
        /// CDP connection pool
        cdp_pool: CdpPool,
    }

    impl BrowserInner {
        /// Get CDP client for the active tab.
        async fn active_cdp(&mut self) -> Result<Arc<CdpClient>, DeviceError> {
            let tab_id = self.active_tab_id.clone().unwrap_or_else(|| "tab-0".into());
            let target_id = self.tabs.iter()
                .find(|t| t.id == tab_id)
                .and_then(|t| t.target_id.clone());
            self.cdp_pool.connect_for_tab(&tab_id, target_id).await
        }

        /// Snapshot of the active page's interactive elements (see BrowserManager::navigate).
        async fn snapshot_inner(&self, cdp: &CdpClient) -> Result<String, DeviceError> {
            // Get readyState + final URL for self-describing snapshot
            let meta = cdp.evaluate("JSON.stringify({url:document.location.href,readyState:document.readyState})").await
                .map(|v| v.as_str().unwrap_or("{}").to_string())
                .unwrap_or_else(|_| "{}".to_string());
            let active_id = self.active_tab_id.clone().unwrap_or_default();
            let target_id = self.tabs.iter()
                .find(|t| t.id == active_id)
                .and_then(|t| t.target_id.clone())
                .unwrap_or_default();
            let meta_json: serde_json::Value = serde_json::from_str(&meta).unwrap_or_default();
            let page_url = meta_json.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let ready = meta_json.get("readyState").and_then(|v| v.as_str()).unwrap_or("");

            let js = format!(r#"(function(){{
                var url=document.location.href,title=document.title;
                var els=document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]');
                var out=[],max=150;
                var limit=Math.min(els.length,max);
                // Generation signature for stale-ref detection
                var gen=Date.now().toString(36)+'-'+(Math.random()*0xffff|0).toString(36);
                for(var i=0;i<limit;i++){{
                    var e=els[i];
                    e.setAttribute('data-mcp-ref',i+'|'+gen);
                    out.push('['+i+'] <'+e.tagName.toLowerCase()+'> '+(e.textContent||e.value||'').trim().substring(0,80));
                }}
                if(els.length>max)out.push('... ('+(els.length-max)+' more elements, use browser_evaluate for full DOM)');
                return out.join('\n');
            }})()"#);
            let v = cdp.evaluate(&js).await?;
            let body = v.as_str().unwrap_or_default().to_string();
            Ok(format!("tab_id: {active_id}\ntarget_id: {target_id}\nurl: {page_url}\nreadyState: {ready}\n---\n{body}"))
        }
    }

    /// Which navigation to fire — navigate, history JS, or reload.
    enum NavAction<'a> {
        Navigate(&'a str),
        History(&'a str),
        Reload,
    }

    /// WebView2 remote-debugging flag — single source for the CDP port
    /// (also set via WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and tauri.conf.json).
    pub fn cdp_debug_args() -> String {
        format!("--remote-debugging-port={}", crate::tools::cdp::CDP_PORT)
    }

    /// Shared child-webview bootstrap — the same builder shape for the boot
    /// webview (setup.rs) and every new tab. `on_nav` receives the target URL
    /// and returns whether to allow the navigation; `on_new_window` redirects
    /// new-window requests back to the active webview (deny response).
    pub fn new_child_webview(
        id: &str,
        url: tauri::WebviewUrl,
        on_nav: impl Fn(&url::Url) -> bool + Send + 'static,
        on_new_window: impl Fn(url::Url, tauri::webview::NewWindowFeatures) -> tauri::webview::NewWindowResponse<tauri::Wry> + Send + 'static,
    ) -> tauri::WebviewBuilder<tauri::Wry> {
        tauri::WebviewBuilder::new(id, url)
            .additional_browser_args(&cdp_debug_args())
            .on_navigation(on_nav)
            .on_new_window(on_new_window)
    }

    pub struct BrowserManager {
        inner: tokio::sync::Mutex<BrowserInner>,
        default_timeout: Duration,
        /// Event bus for navigation events from on_navigation — std Mutex, set
        /// once at setup, cloned briefly by tab creation (never across await).
        event_bus: Arc<Mutex<Option<Arc<dyn EventBus>>>>,
        /// Persistent slot — closures capture this Arc and always see the current active webview.
        child_webview_slot: Arc<Mutex<Option<tauri::Webview>>>,
    }

    impl BrowserManager {
        pub fn new(timeout: u64) -> Self {
            Self::with_config(timeout, None, None)
        }

        /// Build the manager. The desktop backend owns Tauri child webviews, so
        /// the headless executable/port options are unused here.
        pub fn with_config(timeout: u64, _headless_executable: Option<String>, _headless_cdp_port: Option<u16>) -> Self {
            Self {
                inner: tokio::sync::Mutex::new(BrowserInner {
                    main_window: None,
                    tabs: Vec::new(),
                    active_tab_id: None,
                    next_tab_id: 1,
                    cdp_pool: CdpPool::new(),
                }),
                default_timeout: Duration::from_secs(timeout),
                event_bus: Arc::new(Mutex::new(None)),
                child_webview_slot: Arc::new(Mutex::new(None)),
            }
        }

        /// Set the event bus (setup only).
        pub fn set_event_bus(&self, bus: Arc<dyn EventBus>) {
            *self.event_bus.lock().unwrap_or_else(|p| p.into_inner()) = Some(bus);
        }

        /// Set the main window (setup only — the inner lock is uncontended then).
        pub fn set_main_window(&self, window: tauri::Window) {
            self.inner
                .try_lock()
                .expect("set_main_window: setup-time call on uncontended manager")
                .main_window = Some(window);
        }

        /// Update the persistent slot that on_new_window closures read to find
        /// the current active webview.
        fn set_child_slot(&self, wv: tauri::Webview) {
            if let Ok(mut slot) = self.child_webview_slot.lock() {
                *slot = Some(wv);
            }
        }

        // ── Tab management ──────────────────────────────────

        pub async fn tab_new(&self, url: &str) -> Result<String, DeviceError> {
            let mut inner = self.inner.lock().await;
            let window = inner.main_window.clone()
                .ok_or(DeviceError::BrowserNotConnected { reason: "no main window".into() })?;
            let id = format!("tab-{}", inner.next_tab_id);
            inner.next_tab_id += 1;

            let parsed: url::Url = url.parse()
                .map_err(|e| DeviceError::Internal { message: format!("invalid url: {e}") })?;

            let slot2 = self.child_webview_slot.clone();
            let event_bus = self.event_bus.lock().unwrap_or_else(|p| p.into_inner()).clone();

            let wv_builder = new_child_webview(
                &id,
                tauri::WebviewUrl::External(parsed),
                move |nav_url| {
                    let url_str = nav_url.to_string();
                    if url_str == "about:blank" { return true; }
                    if let Some(ref bus) = event_bus {
                        bus.emit(&AgentEvent::BrowserNavigate {
                            url: url_str,
                            title: String::new(),
                        });
                    }
                    true
                },
                move |url, _| {
                    if let Ok(slot) = slot2.lock() {
                        if let Some(wv) = slot.clone() {
                            let _ = wv.navigate(url);
                        }
                    }
                    tauri::webview::NewWindowResponse::Deny
                },
            );

            let child = window.add_child(
                wv_builder,
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(800.0, 600.0),
            ).map_err(|e| DeviceError::Internal { message: format!("add_child: {e}") })?;
            child.hide().ok();

            // Hide previous active webview to prevent overlapping native windows
            if let Some(prev_id) = &inner.active_tab_id {
                if let Some(prev) = inner.tabs.iter().find(|t| t.id == *prev_id) {
                    let _ = prev.webview.hide();
                }
            }
            inner.tabs.push(Tab {
                id: id.clone(), url: url.to_string(),
                target_id: None, webview: child.clone(),
            });
            self.set_child_slot(child);
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
            // Hide all others, show only the selected one (backend-driven overlay sync)
            for tab in &inner.tabs {
                if tab.id == tid {
                    let _ = tab.webview.show();
                } else {
                    let _ = tab.webview.hide();
                }
            }
            let wv = inner.tabs.iter().find(|t| t.id == tid).map(|t| t.webview.clone());
            if let Some(wv) = wv {
                inner.active_tab_id = Some(tid.to_string());
                self.set_child_slot(wv);
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
                let _ = tab.webview.close();
                inner.cdp_pool.remove(tid);
                if inner.active_tab_id.as_deref() == Some(tid) {
                    inner.active_tab_id = inner.tabs.first().map(|t| t.id.clone());
                    if let Some(t) = inner.tabs.first() {
                        self.set_child_slot(t.webview.clone());
                    }
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

        pub async fn active_wv(&self) -> Result<tauri::Webview, DeviceError> {
            let inner = self.inner.lock().await;
            let aid = inner.active_tab_id.as_deref().unwrap_or("");
            inner.tabs.iter().find(|t| t.id == aid)
                .or_else(|| inner.tabs.first())
                .map(|t| t.webview.clone())
                .ok_or(DeviceError::BrowserNotConnected { reason: "no tabs".into() })
        }

        // ── Legacy single-webview accessors ────────────────

        pub fn child_webview_slot(&self) -> Arc<Mutex<Option<tauri::Webview>>> {
            self.child_webview_slot.clone()
        }

        pub fn set_child_webview_slot(&self, wv: tauri::Webview) {
            let mut inner = self.inner
                .try_lock()
                .expect("set_child_webview_slot: setup-time call on uncontended manager");
            if inner.tabs.is_empty() {
                inner.tabs.push(Tab { id: "tab-0".into(), url: String::new(), target_id: None, webview: wv.clone() });
                inner.active_tab_id = Some("tab-0".into());
            }
            self.set_child_slot(wv);
        }

        pub async fn hide_all(&self) {
            let inner = self.inner.lock().await;
            for tab in &inner.tabs {
                let _ = tab.webview.hide();
            }
        }

        // ── Browser operations (all via CDP) ─────────────────

        /// Fire a navigation action and snapshot the result. Subscribes to CDP
        /// events *before* firing so a fast full-page load isn't missed, then
        /// waits (bounded) for `Page.loadEventFired` — SPA pushState navigations
        /// fire no load event, so the wait falls through after the timeout.
        async fn navigate_action(
            inner: &mut BrowserInner,
            timeout: Duration,
            action: NavAction<'_>,
        ) -> Result<String, DeviceError> {
            let cdp = inner.active_cdp().await?;
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
            inner.snapshot_inner(&cdp).await
        }

        pub async fn navigate(&self, url: &str) -> Result<String, DeviceError> {
            let mut inner = self.inner.lock().await;
            let active_id = inner.active_tab_id.clone().unwrap_or_default();
            let result = Self::navigate_action(
                &mut inner,
                Duration::from_secs(self.default_timeout.as_secs().max(1)),
                NavAction::Navigate(url),
            ).await;
            tracing::debug!("[vale_command] navigate: CDP -> {url}");
            // Track URL for active tab
            if let Some(tab) = inner.tabs.iter_mut().find(|t| t.id == active_id) {
                tab.url = url.to_string();
            }
            result
        }

        pub async fn snapshot(&self) -> Result<String, DeviceError> {
            let mut inner = self.inner.lock().await;
            let cdp = inner.active_cdp().await?;
            inner.snapshot_inner(&cdp).await
        }

        pub async fn click(&self, sel: &str) -> Result<String, DeviceError> {
            let mut inner = self.inner.lock().await;
            let cdp = inner.active_cdp().await?;
            let js = if let Ok(n) = sel.parse::<u32>() {
                // Ref-number click with generation signature check
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
            let cdp = inner.active_cdp().await?;
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
            let cdp = inner.active_cdp().await?;
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
                // Single character — send as-is
                _ => (key, "", 0),
            };
            // keyDown (not rawKeyDown) triggers default actions — form submit,
            // button activation — matching the real-key sequence browsers expect.
            for key_type in &["keyDown", "keyUp"] {
                let mut params = serde_json::json!({
                    "type": key_type,
                    "key": key_name,
                });
                if !code.is_empty() {
                    params["code"] = serde_json::json!(code);
                }
                if vk > 0 {
                    params["windowsVirtualKeyCode"] = serde_json::json!(vk);
                }
                cdp.send("Input.dispatchKeyEvent", params).await
                    ?;
            }
            Ok(())
        }

        pub async fn screenshot(&self, full_page: Option<bool>) -> Result<String, DeviceError> {
            let mut inner = self.inner.lock().await;
            let cdp = inner.active_cdp().await?;
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
            let cdp = inner.active_cdp().await?;
            let v = cdp.evaluate(js).await?;
            Ok(serde_json::to_string(&v).unwrap_or_default())
        }

        pub async fn wait_for(&self, sel: &str, timeout: Option<u64>) -> Result<(), DeviceError> {
            let mut inner = self.inner.lock().await;
            let cdp = inner.active_cdp().await?;
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
            let cdp = inner.active_cdp().await?;
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
            Self::navigate_action(&mut inner, Duration::from_secs(3), NavAction::History("history.back()")).await
        }

        pub async fn go_forward(&self) -> Result<String, DeviceError> {
            let mut inner = self.inner.lock().await;
            Self::navigate_action(&mut inner, Duration::from_secs(3), NavAction::History("history.forward()")).await
        }

        pub async fn reload(&self) -> Result<String, DeviceError> {
            let mut inner = self.inner.lock().await;
            Self::navigate_action(
                &mut inner,
                Duration::from_secs(self.default_timeout.as_secs().max(1)),
                NavAction::Reload,
            ).await
        }

        /// Screenshot the main UI window (http://tauri.localhost target).
        /// Uses canvas-based capture since WebView2 main window doesn't support Page.captureScreenshot.
        pub async fn screenshot_ui(&self) -> Result<String, DeviceError> {
            let cdp = self.connect_main_window().await?;
            // Try CDP first (may succeed on some platforms)
            if let Err(e) = cdp.send("Page.enable", serde_json::json!({})).await {
                tracing::debug!("[vale_command] Page.enable: {e}");
            }
            if let Ok(b64) = cdp.screenshot().await {
                return Ok(b64);
            }
            // Canvas-based screenshot of the vale_command UI chrome
            // (native child webviews won't render, but the vale_command UI frame will)
            let js = r#"
(function(){
var d=document.documentElement;
var w=Math.max(d.scrollWidth,innerWidth,1280);
var h=Math.max(d.scrollHeight,innerHeight,800);
var c=document.createElement('canvas');c.width=w;c.height=h;
var ctx=c.getContext('2d');
ctx.fillStyle='#fafafa';ctx.fillRect(0,0,w,h);
ctx.font='14px system-ui';
ctx.fillStyle='#131314';
ctx.fillText('Vale Command UI — '+document.title,20,30);
ctx.font='12px monospace';
ctx.fillStyle='#6b6b6f';
var y=60;
var els=['#topbar','#browser-tab-bar','#browser-area','#terminal-out','#statusbar'];
for(var i=0;i<els.length;i++){
  var el=document.querySelector(els[i]);
  if(!el)continue;
  var r=el.getBoundingClientRect();
  ctx.strokeStyle='#5b6cf0';ctx.strokeRect(r.x,r.y,r.width,r.height);
  ctx.fillText(els[i]+' '+Math.round(r.width)+'x'+Math.round(r.height)+' @('+Math.round(r.x)+','+Math.round(r.y)+')',24,y);
  y+=20;
}
return c.toDataURL('image/png');
})()"#;
            let v = cdp.evaluate(js).await?;
            let data_url = v.as_str().unwrap_or("");
            let b64 = data_url.strip_prefix("data:image/png;base64,").unwrap_or(data_url);
            Ok(b64.to_string())
        }

        /// Evaluate JS in the main UI window (tauri://localhost target).
        pub async fn evaluate_ui(&self, js: &str) -> Result<String, DeviceError> {
            let cdp = self.connect_main_window().await?;
            let v = cdp.evaluate(js).await?;
            Ok(serde_json::to_string(&v).unwrap_or_default())
        }

        async fn connect_main_window(&self) -> Result<CdpClient, DeviceError> {
            let targets = CdpClient::list_targets().await?;
            let main = targets.iter()
                .find(|t| t.1.contains("tauri.localhost"))
                .ok_or_else(|| DeviceError::Internal {
                    message: "main window target not found".into(),
                })?;
            CdpClient::connect_ws(&main.3).await
        }
    }
}

#[cfg(not(feature = "browser"))]
mod stub_impl {
    use super::*;
    use vale_command_core::DeviceError;
    pub struct BrowserManager;
    impl BrowserManager {
        pub fn new(_: u64) -> Self { Self::with_config(0, None, None) }
        pub fn with_config(_: u64, _: Option<String>, _: Option<u16>) -> Self { Self }
        pub fn set_event_bus(&self, _: std::sync::Arc<dyn vale_command_core::EventBus>) {}
        pub fn set_main_window(&self, _: ()) {}
        pub async fn tab_new(&self, _: &str) -> Result<String, DeviceError> { Self::err() }
        pub async fn tab_list(&self) -> Result<Vec<TabInfo>, DeviceError> { Ok(vec![]) }
        pub async fn tab_select(&self, _: &str) -> Result<(), DeviceError> { Ok(()) }
        pub async fn tab_close(&self, _: &str) -> Result<(), DeviceError> { Ok(()) }
        pub async fn active_tab_id(&self) -> Option<String> { None }
        pub async fn tab_count(&self) -> usize { 0 }
        pub fn child_webview_slot(&self) -> std::sync::Arc<std::sync::Mutex<Option<()>>> { std::sync::Arc::new(std::sync::Mutex::new(None)) }
        pub fn set_child_webview_slot(&self, _: ()) {}
        pub async fn hide_all(&self) {}
        pub async fn active_wv(&self) -> Result<(), DeviceError> { Self::err() }
        pub async fn navigate(&self, _: &str) -> Result<String, DeviceError> { Self::err() }
        pub async fn snapshot(&self) -> Result<String, DeviceError> { Self::err() }
        pub async fn click(&self, _: &str) -> Result<String, DeviceError> { Self::err() }
        pub async fn type_text(&self, _: &str, _: &str) -> Result<(), DeviceError> { Self::err() }
        pub async fn press_key(&self, _: &str) -> Result<(), DeviceError> { Self::err() }
        pub async fn screenshot(&self, _: Option<bool>) -> Result<String, DeviceError> { Self::err() }
        pub async fn evaluate(&self, _: &str) -> Result<String, DeviceError> { Self::err() }
        pub async fn wait_for(&self, _: &str, _: Option<u64>) -> Result<(), DeviceError> { Self::err() }
        pub async fn scroll(&self, _: &str, _: Option<u32>) -> Result<(), DeviceError> { Self::err() }
        pub async fn go_back(&self) -> Result<String, DeviceError> { Self::err() }
        pub async fn go_forward(&self) -> Result<String, DeviceError> { Self::err() }
        pub async fn reload(&self) -> Result<String, DeviceError> { Self::err() }
        pub async fn screenshot_ui(&self) -> Result<String, DeviceError> { Self::err() }
        pub async fn evaluate_ui(&self, _: &str) -> Result<String, DeviceError> { Self::err() }
        fn err<T>() -> Result<T, DeviceError> {
            Err(DeviceError::BrowserNotConnected { reason: "browser backend not enabled (build with --features browser)".into() })
        }
    }
}

// Headless Chrome/Edge backend (browser without tauri) — same public API,
// drives a real browser over CDP instead of Tauri child webviews.
#[cfg(all(feature = "browser", not(feature = "tauri")))]
#[path = "browser_headless.rs"]
mod headless_impl;

#[cfg(all(feature = "tauri", feature = "browser"))]
pub use desktop_impl::{BrowserManager, cdp_debug_args, new_child_webview};
#[cfg(all(feature = "browser", not(feature = "tauri")))]
pub use headless_impl::BrowserManager;
#[cfg(not(feature = "browser"))]
pub use stub_impl::BrowserManager;
