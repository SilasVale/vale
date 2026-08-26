# Vale Agent admin UI implementation plan (Phase 1 core)

**Goal:** Benchmark against DeepSeek Harness's full admin UI (sidebar session list, command card stream, details column, trajectory tab, plugins page), replacing the existing `/panel` terminal panel.

**Architecture:** the agent gains a `PlaywrightManager` (held by AppState) + 3 thin APIs; the panel-react frontend expands to a three-column layout (dsh style: sidebar | sessions | details); the command card stream + trajectory tab reuse the existing `/api/sessions` + `/api/sessions/{sid}`.

**Tech Stack:** Rust (agent) + React + a single Vite iife bundle (panel-react already has one) + a single global CSS.

**Spec:** `docs/superpowers/specs/2026-08-15-agent-admin-ui-design.md`

## Global Constraints

- Single iife bundle (no React.lazy/code-split; the web.rs asset whitelist is 6 files)
- Single global CSS (panel.css, no CSS Modules)
- Design tokens: `--accent #0b7a6e`, `--faint #6e6e73`, `--ds-ease-in-out: cubic-bezier(0.4,0,0.2,1)`, `--ds-transition-duration*`
- New APIs go through check_auth (web.rs:252), not TokenGate
- playwright uses the device's Edge (`--browser msedge`), 127.0.0.1 binding + per-launch secret
- The UI renders command output **always text-only** (no innerHTML)
- Commit only after cargo test / cargo xwin check / npm test are all green for each task
- Don't add `/api/sessions/detail` (reuse the existing one)

---

### Task 1: PlaywrightManager (agent process management)

**Files:**
- Create: `agent/src/plugins/playwright/mod.rs`
- Create: `agent/src/plugins/playwright/manager.rs`
- Modify: `agent/src/plugins/mod.rs` (register PlaywrightPlugin)
- Modify: `agent/src/state.rs` (AppState gains `playwright: Arc<PlaywrightManager>`)

**Interfaces:**
- Consumes: `AppState` (state.rs:14-25), the `vale_agent_core::Plugin` trait, `DeviceError`
- Produces: `PlaywrightManager::new() -> Arc<Self>`, `async fn status(&self) -> Value`, `async fn start(&self) -> Result<Value, DeviceError>`, `async fn stop(&self) -> Result<Value, DeviceError>`

- [ ] **Step 1: Write manager.rs — process state machine + start/stop logic**

```rust
//! playwright-mcp process management — start/stop on demand, using the device's Edge.
//! The per-launch secret is passed to playwright-mcp via argv (prevents port squatting).
use std::process::Stdio;
use std::sync::Mutex;
use tokio::process::Child;
use tokio::sync::oneshot;
use vale_agent_core::DeviceError;

pub struct PlaywrightManager {
    inner: Mutex<Option<ManagedPlaywright>>,
}
struct ManagedPlaywright {
    child: Child,
    port: u16,
    secret: String,
    started_at: u64,
    _kill_tx: oneshot::Sender<()>,
}

impl PlaywrightManager {
    pub fn new() -> Arc<Self> { Arc::new(Self { inner: Mutex::new(None) }) }

    pub async fn status(&self) -> serde_json::Value {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref() {
            Some(m) => serde_json::json!({
                "running": true, "port": m.port, "started_at": m.started_at,
                "healthy": true,
            }),
            None => serde_json::json!({ "running": false }),
        }
    }

    pub async fn start(&self) -> Result<serde_json::Value, DeviceError> {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_some() {
            return Ok(serde_json::json!({ "status": "already_running" }));
        }
        // per-launch secret: random 16 hex chars, passed to --mcp-token (supported by playwright-mcp)
        let secret = random_hex(16);
        let port = 9229u16;
        let node = bundled_node_path()?;
        let mcp_dir = bundled_mcp_dir()?;
        let child = tokio::process::Command::new(&node)
            .arg(mcp_dir.join("dist/cli.js"))
            .arg("--port").arg(port.to_string())
            .arg("--browser").arg("msedge")
            .arg("--mcp-token").arg(&secret)
            .stdout(Stdio::null()).stderr(Stdio::null())
            .spawn()
            .map_err(|e| DeviceError::Internal { message: format!("spawn playwright-mcp: {e}") })?;
        // Health polling (up to 10s): GET http://127.0.0.1:{port}/mcp should return 4xx (any response means it's alive)
        let mut ok = false;
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if let Ok(resp) = reqwest::Client::new().get(format!("http://127.0.0.1:{port}/mcp")).send().await {
                let _ = resp; ok = true; break;
            }
        }
        if !ok {
            let _ = child.kill().await;
            return Err(DeviceError::Internal { message: "playwright-mcp did not become healthy on 127.0.0.1:9229".into() });
        }
        let (kill_tx, _kill_rx) = oneshot::channel();
        *guard = Some(ManagedPlaywright { child, port, secret, started_at: now_ms(), _kill_tx: kill_tx });
        Ok(serde_json::json!({ "status": "started", "port": port, "secret": secret }))
    }

    pub async fn stop(&self) -> Result<serde_json::Value, DeviceError> {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(m) = guard.take() {
            // taskkill /T kills the whole tree (Windows); on unix, kill directly
            #[cfg(windows)]
            { let _ = tokio::process::Command::new("taskkill").args(["/T", "/F", "/PID", &m.child.id().unwrap_or(0).to_string()]).output().await; }
            #[cfg(not(windows))]
            { let _ = m.child.kill().await; }
        }
        Ok(serde_json::json!({ "status": "stopped" }))
    }
}
```

- [ ] **Step 2: Write mod.rs — the Plugin trait**

```rust
//! Playwright Plugin — manages the browser-automation MCP service.
mod manager;
use vale_agent_core::{Plugin, ToolDef};

pub struct PlaywrightPlugin { pub manager: std::sync::Arc<manager::PlaywrightManager> }
impl Plugin for PlaywrightPlugin {
    fn name(&self) -> &'static str { "playwright" }
    fn display_name(&self) -> &'static str { "Playwright" }
    fn description(&self) -> &'static str { "playwright-mcp browser automation" }
    fn tools(&self) -> Vec<ToolDef> { vec![] } // tools are routed via the /api/plugins/* HTTP endpoints, not MCP
}
```

- [ ] **Step 3: Register the manager in state.rs**

```rust
// Add a field to AppState:
pub playwright: std::sync::Arc<crate::plugins::playwright::manager::PlaywrightManager>,
// In new():
playwright: crate::plugins::playwright::manager::PlaywrightManager::new(),
```

- [ ] **Step 4: Register PlaywrightPlugin in plugins/mod.rs** (update the tool-count test expectation: current 4 plugins → 5)

- [ ] **Step 5: Verification**

Run: `cargo test --features terminal,keyring` Expected: PASS
Run: `cargo xwin check -p vale-agent --target x86_64-pc-windows-msvc --features terminal,keyring` Expected: OK

- [ ] **Step 6: Commit**

```bash
git add agent/src/plugins/playwright/ agent/src/plugins/mod.rs agent/src/state.rs
git commit -m "feat(stage-k): admin-UI — PlaywrightManager process state machine"
```

### Task 2: /api/plugins/* HTTP routes

**Files:**
- Modify: `agent/src/web.rs` (add 3 arms to handle_request)

**Interfaces:**
- Consumes: `AppState.playwright` (Task 1)
- Produces: `GET /api/plugins/status`, `POST /api/plugins/playwright/start`, `POST /api/plugins/playwright/stop`

- [ ] **Step 1: Write a failing test** (web.rs test: start without a bundled node → error message)

```rust
#[tokio::test]
async fn plugins_playwright_start_missing_bundle_errors() {
    let state = test_state();
    let req = Request::builder().method("POST").uri("/api/plugins/playwright/start")
        .header("authorization", format!("Bearer {}", state.config.server.device_token.as_deref().unwrap_or("")))
        .body(Body::empty()).unwrap();
    let resp = handle_request(req, state).await;
    assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR); // no bundled node → a clear error
}
```

- [ ] **Step 2: Implement the route arms** (in web.rs handle_request, next to the `/api/tools/{name}` arm)

```rust
// ---- Playwright management (round-admin-ui) ----
if method == "GET" && path == "/api/plugins/status" {
    return json_response(StatusCode::OK, serde_json::json!({ "ok": true, "playwright": state.playwright.status().await }));
}
if method == "POST" && path == "/api/plugins/playwright/start" {
    match state.playwright.start().await {
        Ok(v) => return json_response(StatusCode::OK, serde_json::json!({ "ok": true, ...v })),
        Err(e) => return json_response(StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}
if method == "POST" && path == "/api/plugins/playwright/stop" {
    match state.playwright.stop().await {
        Ok(v) => return json_response(StatusCode::OK, serde_json::json!({ "ok": true, ...v })),
        Err(e) => return json_response(StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}
```

- [ ] **Step 3: Tests** Run: `cargo test` PASS; `cargo xwin check` OK
- [ ] **Step 4: Commit** `feat(stage-k): admin-UI — /api/plugins/* routes`

### Task 3: Frontend three-column layout (AppFrame)

**Files:**
- Modify: `agent/resources/panel-react/src/App.tsx` (refactor to three columns)
- Create: `agent/resources/panel-react/src/components/AppFrame.tsx` (resizable three columns)
- Create: `agent/resources/panel-react/src/components/Sidebar.tsx` (session list)
- Create: `agent/resources/panel-react/src/components/DetailsPanel.tsx` (details column)
- Modify: `agent/resources/panel/panel.css` (dsh visual tokens + three-column grid)

**Interfaces:**
- Consumes: `useSessions` (existing: list/activate/close)
- Produces: `AppFrame` (three draggable columns), `Sidebar` (session rows: title/relative time/rename/archive), `DetailsPanel` (clicking a command card shows details)

- [ ] **Step 1: Add dsh tokens + the three-column grid to panel.css**

```css
/* dsh visual language (round-admin-ui) */
:root {
  --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ds-transition-duration: 0.2s;
  --ds-transition-duration-fast: 0.1s;
  --ds-transition-duration-slow: 0.3s;
  --vale-accent: #0b7a6e;
}
.frame { display: grid; grid-template-columns: 240px 1fr 0px; grid-template-rows: 100%; height: 100%; overflow: hidden; transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.frame[data-dragging] { transition: none; }
.frame[data-details-open] { grid-template-columns: 240px 1fr 360px; }
.frame-handle { width: 4px; cursor: col-resize; }
```

- [ ] **Step 2: AppFrame.tsx — three-column grid + dragging**

```tsx
export function AppFrame({ sidebar, main, details, detailsOpen, onDetailsOpen, onDrag }: {
  sidebar: React.ReactNode; main: React.ReactNode; details: React.ReactNode;
  detailsOpen: boolean; onDetailsOpen: (o: boolean) => void; onDrag: (dx: number) => void;
}) {
  return <div className="frame" data-details-open={detailsOpen}>
    <aside className="frame-side">{sidebar}</aside>
    <div className="frame-handle" onMouseDown={(e) => { /* dragging resizes the grid column widths */ }} />
    <main className="frame-main">{main}</main>
    {detailsOpen && <div className="frame-details">{details}</div>}
  </div>;
}
```

- [ ] **Step 3: Sidebar.tsx — session list (dsh Rows style)**
  Session rows: `{label}` + relative time + hover reveals rename/archive buttons; clicking activates (closed sessions don't activate, round-117).
- [ ] **Step 4: Wire App.tsx to AppFrame**, keeping the terminal pane as the main area.
- [ ] **Step 5: Verification** `npm run build` PASS; `node --check` panel.js PASS
- [ ] **Step 6: Commit** `feat(stage-k): admin-UI — AppFrame three-column layout`

### Task 4: Command card stream + details column

**Files:**
- Create: `agent/resources/panel-react/src/components/CommandCard.tsx`
- Modify: `agent/resources/panel-react/src/components/DetailsPanel.tsx`
- Modify: `agent/resources/panel-react/src/hooks/useSessions.ts` (command event parsing)

**Interfaces:**
- Consumes: `/api/sessions/{sid}` (audit JSONL, events grouped: command/start → output → command/end)
- Produces: `CommandCard` (command/live output/exit code/duration/expand-copy), `DetailsPanel` (details of the selected card)

- [ ] **Step 1: Add a command-event-stream hook to useSessions**
  `useCommandEvents(sid)` polls `/api/sessions/{sid}`, grouping by seq as `command/start`→`output`→`command/end` (backgrounded/closed/exited are terminal states, round-99/100 semantics).
- [ ] **Step 2: CommandCard.tsx — command card (dsh ToolCallTree style)**
  Displays the command, live output (**text-only rendering**), exit code (red on failure / teal on success), duration, expand/copy buttons; clicking a card → `onSelect(cardId)` opens the details column.
- [ ] **Step 3: DetailsPanel.tsx — selected command details**
  Argument JSON (JsonTree style), full output, exit code/reason/duration.
- [ ] **Step 4: Verification** `npm run build` PASS
- [ ] **Step 5: Commit** `feat(stage-k): admin-UI — command cards + details panel`

### Task 5: Trajectory tab

**Files:**
- Create: `agent/resources/panel-react/src/components/TrajectoryView.tsx`
- Modify: `agent/resources/panel-react/src/components/TabBar.tsx` (in-session tabs: terminal/trajectory)

**Interfaces:**
- Consumes: `/api/sessions/{sid}` (existing)
- Produces: `TrajectoryView` (round grouping, search, collapse, load-earlier)

- [ ] **Step 1: TrajectoryView.tsx — event timeline**
  Round grouping (command/start opens a round), search box (filters output text), collapse all, load earlier (offset pagination).
- [ ] **Step 2: Add a "Trajectory" tab to TabBar** (switching within a session)
- [ ] **Step 3: Verification** `npm run build` PASS
- [ ] **Step 4: Commit** `feat(stage-k): admin-UI — trajectory view`

### Task 6: Plugins status page

**Files:**
- Create: `agent/resources/panel-react/src/components/PluginsView.tsx`
- Modify: `agent/resources/panel-react/src/App.tsx` (add a plugins page entry to the sidebar)

**Interfaces:**
- Consumes: `GET /api/plugins/status`, `POST /api/plugins/playwright/start|stop` (Task 2)
- Produces: `PluginsView` (plugin inventory: status dots/enabled tags + playwright start/stop buttons + version)

- [ ] **Step 1: PluginsView.tsx**
  Inventory (dsh PluginInventory style): status dots (success/warn/error/ongoing), enabled tags; playwright card: running status + start/stop buttons + startup log.
- [ ] **Step 2: Verification** `npm run build` PASS
- [ ] **Step 3: Commit** `feat(stage-k): admin-UI — plugins view`

---

## Verification (end-to-end)

1. `cargo test --features terminal,keyring` + `cargo xwin check` + `npm test` (gateway) + `npm run build` (panel) all green
2. Start the agent locally: `cargo run --bin vale-agent --features terminal,keyring -- /tmp/ct.yaml` → `curl /api/plugins/status` shows `running: false` → `POST /api/plugins/playwright/start` → status `running: true` (clear error when node isn't bundled)
3. Open `http://127.0.0.2:18080/panel` in a browser → three-column layout, command card stream, trajectory tab, and plugins page all usable
4. Cloud: `https://d1.agent.saisi.online/panel` works through the proxy as well (after Phase 2 packaging)

## Phase 2/3 (follow-up plans)

- Phase 2: cloud "open panel" button (gateway devices page + extension popup)
- Phase 3: packaging (bundle node.exe + playwright-mcp into NSIS, msedge channel)
