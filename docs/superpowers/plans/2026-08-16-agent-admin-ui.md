# Vale Agent 管理界面实现计划(Phase 1 核心)

**Goal:** 对标 DeepSeek Harness 的完整管理界面(侧边栏会话列表、命令卡流、详情列、轨迹 tab、插件页),替换现有 `/panel` 终端面板。

**Architecture:** agent 侧新增 `PlaywrightManager`(AppState 持有)+ 3 个薄 API;前端 panel-react 扩展为三列布局(dsh 风格:侧边栏 | 会话 | 详情),命令卡流 + 轨迹 tab 复用现有 `/api/sessions` + `/api/sessions/{sid}`。

**Tech Stack:** Rust(agent)+ React + Vite 单 iife bundle(panel-react 已有)+ 单一全局 CSS。

**Spec:** `docs/superpowers/specs/2026-08-15-agent-admin-ui-design.md`

## Global Constraints

- 单 iife bundle(无 React.lazy/code-split,web.rs 资产白名单 6 文件)
- 单一全局 CSS(panel.css,不引入 CSS Modules)
- design token:`--accent #0b7a6e`、`--faint #6e6e73`、`--ds-ease-in-out: cubic-bezier(0.4,0,0.2,1)`、`--ds-transition-duration*`
- 新 API 走 check_auth(web.rs:252),非 TokenGate
- playwright 用设备 Edge(`--browser msedge`),127.0.0.1 绑定 + per-launch secret
- UI 渲染命令输出**一律 text-only**(不 innerHTML)
- 每个任务 cargo test / cargo xwin check / npm test 全绿后提交
- 不新增 `/api/sessions/detail`(复用现有)

---

### Task 1: PlaywrightManager(agent 进程管理)

**Files:**
- Create: `agent/src/plugins/playwright/mod.rs`
- Create: `agent/src/plugins/playwright/manager.rs`
- Modify: `agent/src/plugins/mod.rs`(注册 PlaywrightPlugin)
- Modify: `agent/src/state.rs`(AppState 加 `playwright: Arc<PlaywrightManager>`)

**Interfaces:**
- Consumes: `AppState`(state.rs:14-25)、`vale_agent_core::Plugin` trait、`DeviceError`
- Produces: `PlaywrightManager::new() -> Arc<Self>`、`async fn status(&self) -> Value`、`async fn start(&self) -> Result<Value, DeviceError>`、`async fn stop(&self) -> Result<Value, DeviceError>`

- [ ] **Step 1: 写 manager.rs — 进程状态机 + 启停逻辑**

```rust
//! Playwright-mcp 进程管理 — 按需启停,用设备 Edge。
//! per-launch secret 通过 argv 传给 playwright-mcp(防端口 squatting)。
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
        // per-launch secret: 随机 16 hex,传给 --mcp-token(playwright-mcp 支持)
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
        // 健康轮询(最多 10s):GET http://127.0.0.1:{port}/mcp 应 4xx(有响应即活着)
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
            // taskkill /T 杀整棵树(Windows);unix 直接 kill
            #[cfg(windows)]
            { let _ = tokio::process::Command::new("taskkill").args(["/T", "/F", "/PID", &m.child.id().unwrap_or(0).to_string()]).output().await; }
            #[cfg(not(windows))]
            { let _ = m.child.kill().await; }
        }
        Ok(serde_json::json!({ "status": "stopped" }))
    }
}
```

- [ ] **Step 2: 写 mod.rs — Plugin trait**

```rust
//! Playwright Plugin — 浏览器自动化 MCP 服务管理。
mod manager;
use vale_agent_core::{Plugin, ToolDef};

pub struct PlaywrightPlugin { pub manager: std::sync::Arc<manager::PlaywrightManager> }
impl Plugin for PlaywrightPlugin {
    fn name(&self) -> &'static str { "playwright" }
    fn display_name(&self) -> &'static str { "Playwright" }
    fn description(&self) -> &'static str { "playwright-mcp browser automation" }
    fn tools(&self) -> Vec<ToolDef> { vec![] } // 工具经 /api/plugins/* HTTP 路由,不走 MCP
}
```

- [ ] **Step 3: state.rs 注册 manager**

```rust
// AppState 加字段:
pub playwright: std::sync::Arc<crate::plugins::playwright::manager::PlaywrightManager>,
// new() 里:
playwright: crate::plugins::playwright::manager::PlaywrightManager::new(),
```

- [ ] **Step 4: plugins/mod.rs 注册 PlaywrightPlugin**(tool-count 测试预期更新:现有 4 plugins → 5)

- [ ] **Step 5: 验证**

Run: `cargo test --features terminal,keyring` Expected: PASS
Run: `cargo xwin check -p vale-agent --target x86_64-pc-windows-msvc --features terminal,keyring` Expected: OK

- [ ] **Step 6: Commit**

```bash
git add agent/src/plugins/playwright/ agent/src/plugins/mod.rs agent/src/state.rs
git commit -m "feat(stage-k): admin-UI — PlaywrightManager process state machine"
```

### Task 2: /api/plugins/* HTTP 路由

**Files:**
- Modify: `agent/src/web.rs`(handle_request 加 3 个 arm)

**Interfaces:**
- Consumes: `AppState.playwright`(Task 1)
- Produces: `GET /api/plugins/status`、`POST /api/plugins/playwright/start`、`POST /api/plugins/playwright/stop`

- [ ] **Step 1: 写失败测试**(web.rs 测试:start 无绑定 node → 错误信息)

```rust
#[tokio::test]
async fn plugins_playwright_start_missing_bundle_errors() {
    let state = test_state();
    let req = Request::builder().method("POST").uri("/api/plugins/playwright/start")
        .header("authorization", format!("Bearer {}", state.config.server.device_token.as_deref().unwrap_or("")))
        .body(Body::empty()).unwrap();
    let resp = handle_request(req, state).await;
    assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR); // 无捆绑 node → 明确错误
}
```

- [ ] **Step 2: 实现路由 arm**(web.rs handle_request,在 `/api/tools/{name}` arm 旁)

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

- [ ] **Step 3: 测试** Run: `cargo test` PASS;`cargo xwin check` OK
- [ ] **Step 4: Commit** `feat(stage-k): admin-UI — /api/plugins/* routes`

### Task 3: 前端三列布局(AppFrame)

**Files:**
- Modify: `agent/resources/panel-react/src/App.tsx`(重构为三列)
- Create: `agent/resources/panel-react/src/components/AppFrame.tsx`(可调三列)
- Create: `agent/resources/panel-react/src/components/Sidebar.tsx`(会话列表)
- Create: `agent/resources/panel-react/src/components/DetailsPanel.tsx`(详情列)
- Modify: `agent/resources/panel/panel.css`(dsh 视觉 token + 三列 grid)

**Interfaces:**
- Consumes: `useSessions`(现有,列表/激活/关闭)
- Produces: `AppFrame`(三列可拖)、`Sidebar`(会话行:标题/相对时间/重命名/归档)、`DetailsPanel`(点命令卡显示详情)

- [ ] **Step 1: panel.css 加 dsh token + 三列 grid**

```css
/* dsh 视觉语言(round-admin-ui) */
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

- [ ] **Step 2: AppFrame.tsx — 三列 grid + 拖拽**

```tsx
export function AppFrame({ sidebar, main, details, detailsOpen, onDetailsOpen, onDrag }: {
  sidebar: React.ReactNode; main: React.ReactNode; details: React.ReactNode;
  detailsOpen: boolean; onDetailsOpen: (o: boolean) => void; onDrag: (dx: number) => void;
}) {
  return <div className="frame" data-details-open={detailsOpen}>
    <aside className="frame-side">{sidebar}</aside>
    <div className="frame-handle" onMouseDown={(e) => { /* 拖拽改 grid 宽度 */ }} />
    <main className="frame-main">{main}</main>
    {detailsOpen && <div className="frame-details">{details}</div>}
  </div>;
}
```

- [ ] **Step 3: Sidebar.tsx — 会话列表(dsh Rows 风格)**
  会话行:`{label}` + 相对时间 + hover 显示重命名/归档按钮;点击激活(closed 不激活,round-117)。
- [ ] **Step 4: App.tsx 接入 AppFrame**,保留终端 pane 作为主区。
- [ ] **Step 5: 验证** `npm run build` PASS;`node --check` panel.js PASS
- [ ] **Step 6: Commit** `feat(stage-k): admin-UI — AppFrame three-column layout`

### Task 4: 命令卡流 + 详情列

**Files:**
- Create: `agent/resources/panel-react/src/components/CommandCard.tsx`
- Modify: `agent/resources/panel-react/src/components/DetailsPanel.tsx`
- Modify: `agent/resources/panel-react/src/hooks/useSessions.ts`(命令事件解析)

**Interfaces:**
- Consumes: `/api/sessions/{sid}`(audit JSONL,事件分组:command/start → output → command/end)
- Produces: `CommandCard`(命令/实时输出/退出码/时长/展开复制)、`DetailsPanel`(选中卡详情)

- [ ] **Step 1: useSessions 加命令事件流 hook**
  `useCommandEvents(sid)` 轮询 `/api/sessions/{sid}`,按 seq 分组 `command/start`→`output`→`command/end`(backgrounded/closed/exited 为终态,round-99/100 语义)。
- [ ] **Step 2: CommandCard.tsx — 命令卡(dsh ToolCallTree 风格)**
  显示命令、实时输出(**)text-only 渲染**)、退出码(失败红/成功 teal)、时长、展开/复制按钮;点卡 → `onSelect(cardId)` 开详情列。
- [ ] **Step 3: DetailsPanel.tsx — 选中命令详情**
  参数 JSON(JsonTree 风格)、完整输出、退出码/原因/时长。
- [ ] **Step 4: 验证** `npm run build` PASS
- [ ] **Step 5: Commit** `feat(stage-k): admin-UI — command cards + details panel`

### Task 5: 轨迹 tab

**Files:**
- Create: `agent/resources/panel-react/src/components/TrajectoryView.tsx`
- Modify: `agent/resources/panel-react/src/components/TabBar.tsx`(会话内 tab:终端/轨迹)

**Interfaces:**
- Consumes: `/api/sessions/{sid}`(已有)
- Produces: `TrajectoryView`(回合分组、搜索、折叠、加载更早)

- [ ] **Step 1: TrajectoryView.tsx — 事件时间线**
  回合分组(command/start 开回合)、搜索框(过滤 output 文本)、折叠全部、加载更早(offset 分页)。
- [ ] **Step 2: TabBar 加"轨迹"tab**(会话内切换)
- [ ] **Step 3: 验证** `npm run build` PASS
- [ ] **Step 4: Commit** `feat(stage-k): admin-UI — trajectory view`

### Task 6: 插件状态页

**Files:**
- Create: `agent/resources/panel-react/src/components/PluginsView.tsx`
- Modify: `agent/resources/panel-react/src/App.tsx`(侧边栏加插件页入口)

**Interfaces:**
- Consumes: `GET /api/plugins/status`、`POST /api/plugins/playwright/start|stop`(Task 2)
- Produces: `PluginsView`(插件目录:状态点/启用标签 + playwright 启停按钮 + 版本)

- [ ] **Step 1: PluginsView.tsx**
  目录(dsh PluginInventory 风格):状态点(success/warn/error/ongoing)、启用标签;playwright 卡:运行状态 + start/stop 按钮 + 启动日志。
- [ ] **Step 2: 验证** `npm run build` PASS
- [ ] **Step 3: Commit** `feat(stage-k): admin-UI — plugins view`

---

## 验证(端到端)

1. `cargo test --features terminal,keyring` + `cargo xwin check` + `npm test`(gateway)+ `npm run build`(panel)全绿
2. 本地起 agent:`cargo run --bin vale-agent --features terminal,keyring -- /tmp/ct.yaml` → `curl /api/plugins/status` 显示 `running: false` → `POST /api/plugins/playwright/start` → status `running: true`(无捆绑 node 时明确报错)
3. 浏览器开 `http://127.0.0.2:18080/panel` → 三列布局、命令卡流、轨迹 tab、插件页可用
4. 云端:`https://d1.agent.saisi.online/panel` 经代理同样可用(等 Phase 2 打包后)

## Phase 2/3(后续计划)

- Phase 2:云端"打开面板"按钮(gateway devices 页 + 扩展 popup)
- Phase 3:打包(node.exe + playwright-mcp 捆绑进 NSIS,msedge channel)
