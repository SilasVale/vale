# Vale 2.0 — Electron 化技术方案

> 日期：2026-08-31
> 状态：方案（待用户拍板后实施）
> 背景：用户需求 = SecureCRT 式多会话终端工作台（PowerShell/SSH/串口/浏览器）+ AI 控制 + 看 AI 操作；要求跨平台（Win/mac/Linux）；确定不要远程、不装浏览器插件。经生态调研（terminal-browser/hyperia/Netcatty/OxideTerm 等 9 项目源码级），结论：**Electron 壳 + Rust agent 子进程**（hyperia 模式）是匹配"浏览器会话 + AI 控制 + 跨平台"的成熟路线。

## 1. 目标形态

```
Vale 2.0（Electron 桌面应用，三平台一致）
├─ 会话标签体系（SecureCRT 式）
│    ├─ PowerShell / 本地 shell（pty 会话）
│    ├─ SSH（ssh 会话）
│    ├─ 串口（serial 会话）
│    └─ 浏览器（WebContentsView 真浏览器）★ 新增
│         ├─ AI 驱动：playwright/CDP 控制
│         └─ 你实时看 + 可接管（agent-touch/release 互斥）
├─ AI 控制（MCP server）
│    ├─ 16 个 terminal_* 工具（现有）
│    ├─ 6 个 memory 工具（现有）
│    ├─ 浏览器工具（现有 playwright）
│    └─ ★ 新增：审批/审计/blocklist（hyperia 治理模型）
├─ AI 操作时间线（看 AI 干活）★ 重构
│    ├─ 操作日志（第 1 步/第 2 步…）
│    └─ 截图证据流（现有 Evidence 能力升级）
└─ Rust agent 子进程（sidecar，现有不变）
     └─ 127.0.0.1:18080 HTTP/WS（Electron 通过本地接口通信）
```

## 2. 架构决策（基于调研）

| 决策 | 选择 | 理由 |
|---|---|---|
| 桌面壳 | **Electron**（替换 Tauri 壳） | 浏览器会话 + CDP + 跨平台一致；terminal-browser/hyperia/VSCode 均此路线 |
| 核心服务 | **Rust agent 不变**（子进程） | 现有 pty/ssh/serial/memory/playwright/MCP 全部保留，零重写 |
| 通信 | 127.0.0.1:18080 HTTP/WS（现有接口） | Vale 已有完整 API 契约，Electron 直接消费 |
| 前端 | panel-react 复用（加载进 Electron） | 终端页/记忆页/设置页已可用，只加浏览器会话 + 时间线 |
| 浏览器会话 | Electron WebContentsView | 原生支持 CDP；terminal-browser 已验证 |
| AI 治理 | hyperia 模型（审批三档+审计+blocklist） | Vale 目前完全无审批层，这是最大差距 |

## 3. 模块划分与迁移

### 3.1 保留不动（现有 80%）
| 模块 | 说明 |
|---|---|
| vale-agent（Rust） | 服务 + pty/ssh/serial + memory + playwright + MCP server，作为 Electron 子进程 |
| panel-react 前端 | 终端/记忆/插件/设置页，作为 Electron 加载的本地 SPA |
| API 契约 | `/api/tools/*`、SSE、`/api/browser/*` 不变 |
| MCP 工具集 | 16+6+20 工具不变（治理层叠加在其上） |

### 3.2 新增/改造（20%）
| 模块 | 工作量 | 说明 |
|---|---|---|
| Electron 壳 | 3-5 天 | 窗口/托盘/加载 SPA/管理 agent 子进程生命周期 |
| 浏览器会话 | 3-5 天 | WebContentsView + CDP 暴露 + playwright 连接 + 人机互斥 |
| AI 治理层 | 3-5 天 | 审批/审计/blocklist（agent 端 MCP 层加） |
| AI 操作时间线 | 2-3 天 | 操作日志 + 截图流（复用 Evidence/命令卡片） |
| 三平台迁移验证 | 2-3 天 | Win/mac/Linux 打包与行为一致性 |

**总计约 2-3 周**（单人全职），分阶段可独立交付。

## 4. 分阶段实施

### Phase 1（P0）：Electron 壳 + 现有能力跑通
- 建 Electron 主进程：窗口 + 托盘 + 加载 panel-react 构建产物
- 启动 Rust agent 子进程（现有 vale-agent.exe），本地通信 127.0.0.1:18080
- 验证：终端会话（pty/ssh/serial）在 Electron 里工作正常
- **交付标准**：现有 Vale 全部功能在 Electron 壳里可用（替换 Tauri 壳）

### Phase 2（P1）：浏览器会话（核心新增）
- WebContentsView 作为"浏览器会话标签"
- 暴露 CDP 端口，playwright 连接（Vale 现有浏览器工具指向它）
- 人机互斥（agent-touch/release，terminal-browser 模式）
- AI 驱动浏览器 + 你实时看
- **交付标准**：开浏览器会话标签，AI 控制它，你实时看到操作

### Phase 3（P2）：AI 操作时间线（你要的核心体验）
- 操作日志时间线（AI 每步：打开 URL/点击/输入/等待）
- 截图证据流（升级现有 Evidence）
- **交付标准**：AI 干活时你能看到"它做了什么 + 页面截图 + 进行到哪步"

### Phase 4（P3）：AI 治理层（安全）
- 审批三档（observer/confirm/auto）+ blocklist + 审计（hyperia 模型）
- **交付标准**：AI 所有状态改变操作需审批/记录

## 5. 关键技术点

### 5.1 Electron + Rust agent 生命周期
- Electron 启动时 spawn vale-agent.exe（--local 模式，纯本机，不注册网关）
- 退出时优雅关闭 agent
- agent 崩溃自动重启（Electron 侧 watchdog）

### 5.2 浏览器会话（WebContentsView）
- 每个浏览器会话 = 一个 WebContentsView
- CDP：`webContents.debugger`（Electron 内置）或 `--remote-debugging-port`（独立端口）
- playwright 通过 `connectOverCDP` 连接 → Vale 现有浏览器工具复用
- 人机互斥：AI 操作时 WebContentsView 输入冻结 + 显示"AI 正在操作"标记

### 5.3 AI 治理层（agent 端实现）
- MCP 工具包装：所有状态改变工具（terminal_write/execute、browser 操作）先过审批
- 审批三档：observer（只读）/ confirm（弹窗确认）/ auto（blocklist 白名单自动放行）
- 审计：所有调用记日志（谁/何时/什么/结果），可检索
- 实现位置：agent 的 MCP server 层（Rust），不碰前端

### 5.4 跨平台
- Electron 三平台一致（Chromium 内核相同）
- Rust agent 三平台编译（已有 cargo-xwin Windows；mac/Linux 需补 CI）
- panel-react 前端三平台一致

## 6. 风险与决策点

| 风险/决策 | 说明 | 缓解 |
|---|---|---|
| Electron 体积 ~150MB | 浏览器会话需要自带 Chromium | 可接受（Chrome/Edge 同量级）；分阶段下载可选 |
| agent 三平台编译 | 现在只验证过 Windows (xwin) | mac/Linux 需补构建（Rust 跨平台成本低） |
| WebContentsView 嵌入细节 | 三平台行为有差异 | 先 Windows 验证，再 mac/Linux 适配 |
| 浏览器会话 vs 无头 AI 浏览器 | AI 操作可见浏览器 vs 无头 | Phase 2 先做可见（WebContentsView），无头作为 AI 批量场景保留 |
| Vale 是否完全开源 | 影响 GPL 项目代码复用（hyperia 是 GPL） | 方案只借鉴模式（Electron+Rust sidecar+审批），不抄代码，License 无风险 |

## 7. 与现状的对比

| 维度 | 现状（Tauri+Web） | Vale 2.0（Electron） |
|---|---|---|
| 浏览器会话 | 截帧流 + 坐标（1-20fps，点击问题） | WebContentsView 真浏览器（60fps，AI 驱动） |
| 看 AI 操作 | Evidence 截图（弱） | 操作时间线 + 截图 + 实时画面（强） |
| 跨平台 | WebView2/WKWebView/WebKitGTK 不一致 | Chromium 一致 |
| 安装 | npm + 系统组件 | Electron 打包（nsis/dmg/AppImage） |
| 体积 | ~10MB | ~150MB |
| AI 治理 | 无审批 | 审批三档 + 审计（hyperia 模式） |

## 8. 待用户确认

1. 阶段顺序：P0→P4 是否认可？还是浏览器会话（P1）优先于壳稳定（P0）？
2. Vale 是否完全开源（影响后续能否直接用 GPL 项目代码，本方案不依赖）
3. 浏览器会话的"人机互斥"交互（AI 操作时冻结你的输入）是否接受？
