# Vale 终端形态选型调研 —— 生态全景与建议

> 调研日期：2026-08-31
> 调研方式：4 个子代理并行深挖（源码直读，含 License/fork 评估）+ Vale 现状基线核查
> 触发背景：用户提出 Vale 应做成"SecureCRT 式集成终端 + AI 控制"，对 Web 面板形态（显示/重量问题）不满，考虑 A 路线（真像素终端）

## 调研对象

| # | 项目 | 方向 | 详细报告 |
|---|---|---|---|
| 1 | zenbu-labs/terminal-browser | 终端里跑浏览器（像素终端 + Chromium 离屏） | [terminal-browser-research.md](terminal-browser-research.md) |
| 2 | AnalyseDeCircuit/oxideterm | Rust 原生 AI 终端工作区（SSH/串口/SFTP/MCP） | [oxideterm-report.md](oxideterm-report.md) |
| 3 | CloudShell / tabby-web / xterm.js 性能 | Web 终端形态与性能上限 | [web-terminal-xterm-performance.md](web-terminal-xterm-performance.md) |
| 4 | hyperia / exterm_ai / Netcatty / terminal_mcp | MCP-native / AI 终端生态与权限模型 | [ai-terminal-control-research.md](ai-terminal-control-research.md) |

## 核心结论（一句话版）

**Web 终端（xterm.js）的显示/性能问题可以解决，不必换原生**——Vale 的卡顿根因可定位、可修复（SSE 背压 + WebGL 降级 + scrollback 治理）。而"像素终端（A 路线）"生态里，terminal-browser（MIT）可借鉴但 Windows 通路缺失需自绘；OxideTerm（GPL）不能抄代码但审批/审计/增量读取模型值得学。**建议：保留 Web 终端并修性能，浏览器页降级为 AI 证据视图，借鉴生态的 AI 治理层。**

---

## 1. Vale 现状基线（本次核查）

- 终端 = xterm.js 5.5 + Fit + Search，scrollback 20000，reflowOnResize
- **WebGL 渲染器因 WebView2 兼容问题（静默白屏）被整体移除**（round-161），退回默认渲染器——这是"显示问题"的一个实锤，但解法不是"换原生"而是"WebGL+自动降级"（VSCode 同策略）
- 键盘输入 = POST /api/tools/terminal_write（每键一个 HTTP 往返）
- 16 个 terminal_* MCP 工具（open/write/close/list/history/jobs/execute/read/screen/resize/select/saved_connections/connect_saved…）
- 桌面壳 = Tauri 2（68 行 main.rs：窗口+托盘+跳转 /desktop/ 路由），渲染全靠 WebView2 加载 panel-react SPA
- 历史决策：2026-08-27 memory-design 明确"无 kitty graphics protocol（Windows unreliable；主流 web 终端是 xterm.js）"
- 浏览器 = bridge.js(9224) 截帧流 + playwright-mcp(9229) AI runner，坐标合成交互（近期已修焦点/映射 bug，但架构有物理上限）

## 2. 生态对比表

| 维度 | terminal-browser | OxideTerm | CloudShell | tabby-web | Vale 现状 |
|---|---|---|---|---|---|
| 渲染 | kitty 像素（Electron offscreen） | GPUI GPU 直渲（D3D11/wgpu） | xterm.js | xterm.js+WebGL | xterm.js（WebGL 已移除） |
| 终端协议 | Chromium 像素 | alacritty_terminal（含 Sixel/kitty） | xterm.js | xterm.js | xterm.js |
| SSH | SOCKS5 代理（非传帧） | russh（多跳/Agent/重连） | asyncssh | Tabby | pty/ssh/serial |
| 串口 | ❌ | ✅（serialport+热插拔） | ❌ | ✅ | ✅ |
| SFTP | ❌ | ✅（同会话） | ✅ | ✅ | ❌ |
| 多会话 | ✅（daemon+SQLite） | ✅（tab+4-pane） | ✅ | ✅ | ✅ |
| 浏览器 | ✅（核心） | ❌（RDP/VNC 替代） | ❌ | ❌ | ✅（截帧） |
| AI 控制 | agent-browser CDP | ✅（五工具+审批） | ❌ | ❌ | ✅（MCP 16 工具） |
| 审批/审计 | ❌ | ✅（每次工具调用审批） | ✅（审计日志） | ❌ | ❌ |
| License | **MIT** | **GPL-3.0** | GPL-3.0 | GPL-3.0 | — |
| Windows | ❌（无分支） | ✅ | ✅ | ✅ | ✅ |

## 3. 关键发现

### 3.1 terminal-browser（A 路线参照）：思路可借，代码不可搬
- **MIT**，可自由 fork/商用；Rust 引擎层（合成/布局/字体）可复用
- **Windows 通路缺失**：offscreen 渲染只有 macOS/Linux 分支；TTY/kitty/tmux/Swift 输入监听全要重写
- **对 Vale 的启示**：若自绘终端窗口，输出端从"kitty 编码写 TTY"换成"贴自绘 surface"、输入端直接吃前端事件，反而比原项目简单；但自绘窗口 = 放弃 WebView2/浏览器渲染栈，与 Vale 现有 Tauri+React 架构冲突
- 多会话（daemon+SQLite）、AI 接口（agent-touch/release 防人机互抢）值得借鉴

### 3.2 OxideTerm（AI 终端参照）：设计可学，代码不可抄
- ⭐1380 活跃项目，**GPUI GPU 直渲**（非 Tauri！），alacritty_terminal + russh + serialport
- 多会话标签 + 4-pane 分屏；**无浏览器**（RDP/VNC 替代）；AI 五工具 + generation 游标增量读取
- **GPL-3.0 传染**：Vale 闭源不能复制代码，只能借鉴设计
- **最高价值借鉴**：① MCP 服务端审批/审计/过期模型 ② 终端增量读取协议（省 token）③ AI↔终端五工具编排 ④ 作用域+乐观锁记忆 ⑤ Grace Period 重连状态机 ⑥ AI 出站凭据脱敏

### 3.3 Web 终端性能（回答"显示问题能解决吗"）：能，根因已定位
- **Vale 卡顿第一杠杆 = SSE 直推无背压**：useSSE 逐帧 term.write，消费不及则帧堆积、write 缓冲逼近 xterm 50MB 硬上限后丢帧
- **第二杠杆 = WebGL 被整体移除**（应为 WebGL+context 降级+Canvas 兜底，VSCode 的 gpuAcceleration: auto 同款）
- 第三：scrollback 20000 偏大（VSCode 默认 1000）、resize 无限流
- **Web vs 原生**：WebGL 下渲染层视觉差距已很小；瓶颈在解析层（JS 5-35MB/s vs 原生 >100MB/s）。Web 上限 = VSCode 终端水平（日常流畅、大输出不冻结），仅持续 GB 级输出才需原生
- tabby-web/CloudShell 证明了 Web 终端 + 多会话 + SFTP 是成熟形态

### 3.4 AI 控制终端生态（Vale 的最大差距在治理层）
- 交互模型共识：**真实 pty 字节流 + 结构化工具 API**（Vale 已符合）
- 结束判定：Netcatty 用 marker+exit code（最可靠）；hyperia 读屏+shell_state；terminal_mcp pattern-match
- **权限模型（Vale 完全没有）**：hyperia 身份/访问分离 + 一切状态改变需人同意 + 全审计；Netcatty observer/confirm/auto 三档 + blocklist
- **Vale 差距清单**：① 审批三档 + blocklist + 审计（接入云端 agent 前必须）② 长任务 job 三件套（start/poll/stop）③ SFTP 工具 ④ 输出限流/过滤 + shell_state ⑤ 串口 auto_reconnect ⑥ Pulse 唤醒/自报活 + 工具输出存档

## 4. 选型建议

### 结论：不换架构，走"Web 终端修性能 + 浏览器降级 + AI 治理层补齐"

**理由**：
1. **A 路线（像素终端）成本极高且无生态支撑**：terminal-browser 无 Windows 分支、需自绘窗口放弃 WebView2；OxideTerm GPL 不能抄；Vale 现有 Tauri+React+xterm 栈已验证
2. **Web 终端性能问题可修**（根因已定位，见 3.3），修完达到 VSCode 终端水平，日常使用无感
3. **Vale 差异化不在渲染层**：多设备/网关、浏览器工具、纯本地 npm 安装——这些与 Web/原生无关
4. **生态共识是"终端字节流 + 工具 API + 治理层"**，Vale 的 MCP 工具集已齐，缺的是审批/审计/job/SFTP

**建议实施顺序**：
- **P0**：Web 终端性能修复（SSE 背压 → WebGL 降级渲染 → scrollback/resize 治理）——直接回答用户"显示问题能解决吗"：能
- **P1**：浏览器页降级为 AI 证据视图（Evidence 优先，live 交互保留但不承诺实时手感）
- **P2**：AI 治理层（审批三档 + blocklist + 审计 + job 三件套 + SFTP）——借鉴 hyperia/Netcatty/OxideTerm 模型
- **P3**（远期可选）：若确认需要"终端里跑像素浏览器"，参考 terminal-browser 架构自绘窗口（MIT 可借鉴），但这与 Web 路线互斥，需单独决策

## 5. 遗留问题（需用户决策）

1. 浏览器 live 交互是否保留（降级为证据视图 vs 继续修坐标/帧流）？
2. 是否接受"Web 终端 + 审批治理"作为 Vale 2.0 形态（放弃像素终端路线）？
3. SFTP/串口 auto_reconnect 是否纳入路线图（SecureCRT 场景刚需）？
