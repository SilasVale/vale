# 设备操作重设计 v2：浏览器扩展 + AI-first MCP

日期：2026-08-06
状态：已批准（用户确认扩展方案 + 环境约束调整后批准计划）

## Context

现有设备管理的 terminal/browser 方法不好用，且 Windows 上远程 CDP（headless Chrome 端口 19623）连不上、功能坏掉。经多轮澄清，根因：

1. **browser**：Windows headless Chrome 截图 → 2s 一帧 PNG SSE → `<img>` 观察窗，不可交互；远程 CDP 端口跨网络连不上
2. **terminal**：xterm.js + SSE 下行 + 每击键一次 HTTP POST 上行（浏览器→网关→cloudflared→Windows），WAN 延迟明显
3. **MCP 工具面**：坐标式 `browser_click`、字节流终端，AI（Claude Code）不好用
4. **vale-command**：Web 面板、Tauri 桌面、浏览器自动化体验差

**核心转变**：Claude Code 是"大脑"（知道改了什么、该测什么），**浏览器扩展是"手和眼"**。MCP 工具面从坐标/字节流改为 **AI-first：视觉 + 语义**。

**环境约束（关键）**：开发机（跑 Claude Code）= 无界面服务器，无浏览器；日常用浏览器的机器 = Windows 设备本身。因此扩展装 **Windows 设备的 Chrome/Edge**，开发机只管 HTTPS 到网关。

## 架构

```
Claude Code（开发机，无界面）
  → MCP (HTTPS) → https://<console>/mcp   （Bearer 用户 token，admin）
  → 网关 Worker vale-gate
      ├─ 终端工具 → deviceFetch → https://dN.command.saisi.online（Bearer 注入）
      └─ 浏览器工具 → PluginHubDO(idFromName(device)) → WebSocket
  → 浏览器扩展（Windows 设备 Chrome/Edge）
      ├─ chrome.debugger（进程内部，无端口）→ 受控真实标签页
      │    URL = https://<console>/api/devices/<d>/proxy/（面板内嵌，零额外组件）
      └─ 终端页：xterm ← EventSource 代理 SSE；击键 POST
```

**关键机制**：
- 扩展主动出站连网关 WS（复用 443，无新端口），和 cloudflared 隧道同模式；网关按设备路由命令
- `chrome.debugger` 是 Chrome 内部机制，控制本机标签页，**不走网络端口**——根治"远程 CDP 连不上"
- 标签页形态 = **面板内嵌**（反代后的设备面板，设备网页嵌在里面看）
- 会话持久：普通 cookie，首次需在受控标签页登录一次 console

**工具链路**（以 `browser_click` 为例）：
Claude Code → /mcp → mcp.js 鉴权(admin) → PluginHubDO `/call` 登记 pending(60s) → ws.send → 扩展 SW → cdp 控制器（Runtime.evaluate 解析 CSS 路径 → Input.dispatchMouseEvent）→ 快照 → 原路返回。截图时返回 MCP image content block（PNG base64，Claude Code 直接看图）。

**终端工具链路**（`terminal_send`）：Claude Code → /mcp → deviceFetch 透传 `/api/tools/terminal_execute`（写命令→quiet 检测→返回累计文本）。**不经过扩展 WS**（终端物理依赖设备，少一跳）。

## 扩展（新目录 `extension/`）

- **manifest**：MV3，permissions `["tabs","debugger","storage","alarms"]`，host_permissions 覆盖 console 域名 + 设备子域通配；**无 content script**（一切页面内操作走 CDP Runtime.evaluate，零侵入）
- **SW 生命周期**：WS 20s 双向 ping（Chrome 116+ 消息重置空闲计时器）+ `chrome.alarms` 4 分钟兜底；状态存 `chrome.storage.session` 可重水合；Chrome 118+ 活跃 debugger 会话保活 SW
- **attach 策略**：每设备一条受控标签页（`tabs.create`），按需 attach、保持；attach 失败返回可操作错误（DevTools 冲突/不可 attach 页面）；WS 断连**绝不 detach**
- **CDP 域**：Page（navigate/captureScreenshot/loadEventFired）、Runtime（元素树/focus/scrollIntoView）、Input（dispatchMouseEvent 点击、insertText 输入——真实事件）
- **元素树**：注入 JS 穿透 open shadow root，收集可交互元素（a/button/input/select/textarea/[role=button] 等），过滤不可见，上限 120；每元素 `{ref, tag, role, text, name, type, value(密码打码), href, rect, visible}` + 页面 `{url, title, readyState}`；ref 绑定**唯一 CSS 选择器路径**，click/type 时重解析，DOM 变了→自动重拍快照提示
- **WS 客户端**：先 `POST /api/plugins/ws-ticket`（Bearer 插件 token）拿一次性短票 → `wss://<console>/api/plugins/ws?device=<d>&ticket=<t>`；帧协议 `{id, type:"request|response|ping|pong|hello", tool, params, ok, result, error}`；指数退避重连 1s→30s+抖动
- **终端页**：xterm 全屏 + 多会话 tab；下行 EventSource 代理 SSE（网关注入 Bearer），上行 fetch 代理 POST
- **popup**：连接状态/设备/受控标签页/按钮（开面板/开终端/配对/选项）
- 安装方式（待最终确认）：控制台 Devices 面板"安装扩展"按钮 + 指引（zip + chrome://extensions 加载），可加 Windows 端安装脚本

## 网关改造（`gateway/`）

### 1. 修复 WS 反代（第一阶段，根因修复）

`index.js:720-725` 现在构造 `status:101` 无 `webSocket` 属性的 Response → **必抛 RangeError → 500**（WS 经代理必坏的根因）。改为：

```js
if (resp.status === 101) {
  if (resp.webSocket) {
    try { return new Response(null, { status: 101, webSocket: resp.webSocket }); }
    catch { return resp; }          // workerd #3047 兜底: 重包异常直接透传
  }
  return new Response(resp.body || null, { status: 101, headers: outHeaders });
}
```
SSE/octet-stream 分支保持，101 拆出。

### 2. PluginHubDO（新 `src/plugin-hub.js`）

- 每设备一个 DO 实例（`idFromName(deviceName)`），**必须用 DO + WebSocket Hibernation**（裸 Worker WS 随 isolate 驱逐）
- `/ws`：`state.acceptWebSocket`（hibernation），记录 device；同设备第二条连接关旧（单实例）
- `/call`：无 WS → `503 {error:"extension_offline"}`；否则登记 pending（60s 超时）→ ws.send → webSocketMessage 按 id resolve
- `/status`：`getWebSockets().length>0` 或 storage lastSeen
- **探活**（hibernation 定时器不跑）：webSocketMessage 时 `setAlarm(+65s)`；alarm 触发无存活 WS → 关连接。扩展 20s ping 自然重置 alarm

### 3. 插件配对与票据（`src/store.js` + `index.js` 路由）

KV 新增：
- `plugins:v1`：`pluginToken → {device, createdAt}`，helper `addPluginLink/removePluginLink/getPluginByToken`
- 一次性票据 `plg-ticket:<rand> → device`（TTL 60s）、配对码 `pair:<code> → device`（TTL 600s），复用 `randomHex`

路由（admin 区）：
- `POST /api/plugins/pair`（admin 会话）`{device}` → 配对码
- `POST /api/plugins/pair/claim`（公开、码即凭证，仿 `/api/register`）→ 校验/消费/签发 pluginToken
- `POST /api/plugins/ws-ticket`（Bearer pluginToken）→ 一次性 WS 票据
- `POST /api/plugins/unpair`（admin）`{device}`
- `GET /api/plugins/status`（admin）→ 每设备 `{online}`

`wrangler.jsonc`：DO 绑定 `PLUGIN_HUB → PluginHubDO` + 迁移 `v2-plugin-hub`（`new_sqlite_classes`，照 BreakerDO 先例）。

### 4. MCP server 端点（新 `src/mcp.js` + `src/mcp-tools.js`）

- **手写 JSON-RPC 2.0**（不用 @modelcontextprotocol/sdk：gateway 零依赖，sdk streamable-http 上 Worker 需 fetch-to-node 桥，代价大于收益；协议子集约 200 行，风险由 stage 1 接真实 Claude Code 对冲）
- 路由：`isPageHost && path === "/mcp"`（console API 检查之后、静态页之前）
- 鉴权：`Authorization: Bearer <token>` → `findUserByToken` → `role.admin`
- **GET /mcp 必须返回保持打开的 SSE 流**（Claude Code v2.1.84+ 先 GET 后 POST；405 判失败）+ 每 15s keepalive 注释；POST 返回 application/json；stateless
- `initialize`：回显 protocolVersion、`capabilities:{tools:{listChanged:false}}`、`serverInfo:{name:"vale-gate"}`

工具注册表（全带 `device` 参数，validate against KV）：

| 工具 | 路由 | 说明 |
|---|---|---|
| `browser_open(device,url)` | DO→扩展 | 开/导航受控标签页，等 load(30s)，返回快照 |
| `browser_snapshot(device)` | DO→扩展 | 可交互元素树 JSON |
| `browser_screenshot(device,full_page?)` | DO→扩展 | **image content block**（PNG base64） |
| `browser_click(device,element_ref)` | DO→扩展 | 点击后返回快照 |
| `browser_type(device,element_ref,text)` | DO→扩展 | 聚焦+insertText，返回快照 |
| `browser_wait(device,condition,timeout_s?)` | DO→扩展 | 轮询条件(选择器/文本)，返回快照 |
| `browser_close(device)` | DO→扩展 | 关受控标签页 |
| `terminal_open(device,kind,target,rows?,cols?)` | deviceFetch | 透传 `/api/tools/terminal_open` |
| `terminal_screen(device,session_id,lines?)` | deviceFetch | **新设备工具**，尾部 N 行屏幕文本 |
| `terminal_send(device,session_id,input,quiet_ms?)` | deviceFetch | 透传 `terminal_execute` 会话模式（quiet 检测在设备端） |
| `terminal_list(device)` | deviceFetch | 透传 |
| `terminal_close(device,session_id)` | deviceFetch | 透传 |

- **`deviceFetch(env, device, path, body)` 提取**：从 `proxyDevice` 抽共享函数（Bearer 注入、host/cookie 清洗、502 包装），行为零变化
- 超时纪律：工具内 timeout < 90s（Worker 子请求 100s 上限）；终端 quiet 默认 400ms

### 5. console SPA 小改

Devices 区加：每设备"在线"列（轮询 /api/plugins/status）、「生成扩展配对码」按钮、「网关 MCP 配置」复制按钮（`https://<console>/mcp` + 当前用户 token）。

## 设备端小改（`command/`）

1. **新增 `terminal_screen`**（`src/plugins/terminal/tools.rs`，仿 `tool_read` 结构）：
   - schema `{session_id: string, lines?: integer 默认60}`
   - 实现：OutputBuf 取 SessionBuf → 从尾部倒扫 N 个 `\n` 起点 → `clean_terminal_output` → `{screen, dropped, total_bytes}`。屏幕缓冲已在 OutputBuf（1MB 环剪），不需要新后端
   - `build()` 注册；更新工具数量测试 12→13 与 CLAUDE.md 计数
2. **"等输出稳定"不动**：已在设备端 `tool_execute` 会话模式
3. **终端显示保持 SSE+POST**（本阶段）：设备端新 WS 端点与 Windows 交叉编译约束冲突（web.rs:1-19），收益（人看为主）不划算；WS 反代修好后随时可加

## 保留/降级

- 设备注册/列表/token、反代路径重写、登录/管理员：**全部不动**
- Claude Code 直连设备 MCP（`https://dN.../mcp`）：**向后兼容保留**（旧 headless 浏览器工具不删）
- 本次不动的重构（后续阶段）：vale-command 退役 Web 面板/Tauri/浏览器自动化、托盘独立小应用（开关+状态/复制配置+打开控制台/本地终端入口）

## 风险与缓解

1. **chrome.debugger MV3**：attach 对 chrome:// 等失败、DevTools 冲突、canceled_by_user、SW 重启丢在途请求 → 自开标签页、明确错误、target_closed 重试、storage.session 重水合、debugger 保活+心跳+alarms 三重保活
2. **Worker WS 生命周期**：非 DO WS 不可靠 → 用 DO；hibernation 定时器不跑 → alarm 探活；101 重包 RangeError → 分支最小化+透传兜底
3. **MCP streamable HTTP**：GET 流必须实现（v2.1.84+）；协议边缘 → stage 1 用真实 Claude Code 验证；子请求 100s → 工具超时 <90s
4. **console 会话依赖**：受控标签页走反代需 console 登录 → browser_open 后快照检测登录页并提示
5. **多调用并发**：DO 按 requestId 并发关联；扩展侧每标签页串行化（SW 内 mutex）
6. **配对安全**：插件 token 授予设备浏览器控制权 → 仅 admin 签发/可吊销/按设备隔离；claim 仿注册码一次性消费

## 验证

分 6 阶段（详见计划文件实现顺序表），每阶段收尾基准：
- gateway：`node --test` + `wrangler deploy`
- command：`cargo test` → `cargo clippy --all-targets` → `cargo xwin check -p vale-command-desktop`

端到端剧本：Claude Code 直连网关 MCP 跑"改代码→开面板→截图→点击→终端跑测试"。

## 实施文件

- `extension/`（新）：manifest.json、background.js、lib/{ws,cdp,elements,tools,state}.js、popup/、options/、terminal/、vendor/、icons/
- `gateway/src/plugin-hub.js`（新）、`src/mcp.js`（新）、`src/mcp-tools.js`（新）
- `gateway/src/index.js`：101 分支修复、deviceFetch 提取、/mcp + /api/plugins/* 路由
- `gateway/src/store.js`：plugins:v1、配对码/票据 helper
- `gateway/wrangler.jsonc`：PLUGIN_HUB DO 绑定 + v2 迁移
- `gateway/public/app.js|index.html|style.css`：在线列/配对 UI/MCP 配置复制
- `command/src/plugins/terminal/tools.rs`：terminal_screen
- 计划文件：/home/zhengsaisi/.claude/plans/terminal-browser-rustling-hopcroft.md
