# Web 终端（xterm.js）显示/性能调研报告

> 调研时间：2026 年。目的：评估 Vale（Windows agent + Web 面板，xterm.js + React/SSE）的"Web 终端卡顿"能否在 Web 形态内解决，以及两个参考项目（CloudShell、tabby-web）的做法。相关既有笔记：`docs/research/terminal-browser-research.md`（像素终端路线）。

## 项目概览

**CloudShell**（[iu2frl/CloudShell](https://github.com/iu2frl/CloudShell)）：Docker 部署的 Web SSH/SFTP/FTP 网关，FastAPI + asyncssh 后端、React 18 + Vite 前端。会话模型：`create_session()` 建 SSH 连接拿 UUID → 浏览器开 WebSocket（二进制帧）→ 后端 `stream_session()` 双任务桥接（`read(4096)` → `send_bytes` 直推，无缓冲节流）。前端 [Terminal.tsx](https://github.com/iu2frl/CloudShell/blob/main/frontend/src/components/Terminal.tsx)：每会话一个 `Terminal` 组件、`scrollback: 5000`、FitAddon + WebLinksAddon，`ws.onmessage` 逐帧 `term.write(data)`——**没有任何背压/批量写入/渲染优化**。多标签由父组件持有 sessionId 列表、每个 tab 一个实例；SFTP/审计等由 REST API 承担，不经过终端流。结论：它是"能用"的参考实现，不是性能标杆。

**tabby-web**（[Eugeny/tabby-web](https://github.com/Eugeny/tabby-web)）：Tabby 桌面的 Web 版（已停止维护）。架构特殊：前端只是壳，通过 `__connector__` postMessage 桥从服务器加载 `tabby-web-container`（Tabby 本体编译产物），Tabby 桌面的 `XTermFrontend` 在浏览器里原样运行（Angular 12 + xterm.js）。后端 Django 管认证/配置同步，SSH/Telnet 由独立 [tabby-connection-gateway](https://github.com/Eugeny/tabby-connection-gateway) 转发。**tabby-web 本身没写性能代码——性能方案全在 Tabby 本体的 `xtermFrontend.ts`**，Web 端直接复用，这是它值得抄的关键。

## Tabby 的 xterm.js 性能方案（可直接抄）

源码：[tabby-terminal/src/frontends/xtermFrontend.ts](https://github.com/Eugeny/tabby/blob/master/tabby-terminal/src/frontends/xtermFrontend.ts)

1. **FlowControl 背压（核心）**：`xterm.write(data, cb)` 每 128KB 记账一次；pending callbacks 超过 high-watermark(10) 就暂停写入，低于 low-watermark(5) 恢复。xterm.js 官方[流控文档](https://xtermjs.org/docs/guides/flowcontrol/)确认：`write` 无背压时缓冲无限增长，超过硬上限（约 50MB）直接丢数据；且建议 WebSocket 场景在客户端用 write callback 回 ACK、服务端据此 `pause/resume` PTY。
2. **渲染器分层**：默认 WebGL（`WebglAddon`，glyph atlas 上传 GPU，大输出滚动不占 CPU），Web 平台回退 `CanvasAddon`，兜底 DOM renderer。WebGL context lost 有 `MAX_WEBGL_RECOVERY_ATTEMPTS=3` 的自动重建+降级。VSCode 同理：`terminal.integrated.gpuAcceleration: auto` = WebGL 优先、启动异常或实测低 FPS 自动降级 DOM 并缓存选择（[microsoft/vscode#106202](https://github.com/microsoft/vscode/issues/106202)）。
3. **scroll pinning 修复**：xterm `onScroll` 只对内容驱动滚动触发（xterm.js #3864/#3201），快速输出时会误判；Tabby 用 wheel/键盘事件捕获相位主动 unpin + 写后 `_scrollToBottom` 补正，防止"写一点跳一下"的抖动。
4. **resize 限流**：`RESIZE_MIN_INTERVAL=32ms` + rAF 合并，窗口拖动/ResizeObserver 高频触发时只做尾随 fit，避免每帧重传 glyph atlas。
5. **其他**：resize 后强制 `_renderRows` 消除一帧白屏；displayMetricsChanged 清 texture atlas；字体加载后延迟 1s（Web）再 fit。

## Vale Web 终端卡顿的根因分析

Vale 现状（`agent/resources/panel-react/src/components/TerminalPane.tsx` + `hooks/useSSE.ts`）：**SSE 流**（非 WebSocket）逐帧 `term.write(new Uint8Array(frame.data))`；`scrollback: 20000`；WebGL addon 曾用过但因"部分 GPU/WebView2 上静默白屏"被移除（round-161），回落默认 renderer；每次 resize/主题切换都走 React 状态 + `terminal_resize` 推送后端。

对照 Tabby/官方文档，Vale 的卡顿根因按可能性排序：

1. **无背压的 SSE 直推**：agent 端输出通道虽有界（blocking_send），但 `/api/events/term` 的 SSE 广播是 agent→浏览器单向流，浏览器写不进 xterm 时（`yes`/编译日志）SSE 帧在 fetch reader 侧堆积，`term.write` 缓冲逼近 50MB 上限后丢帧或 UI 线程持续被解析占满——这正是 xterm.js 官方流控指南描述的场景。需要客户端 write-callback 计数 → 回 ACK/暂停 → agent 端暂停 PTY 读取，或至少客户端节流丢弃（跳帧渲染）。
2. **缺渲染器优化**：WebGL 被移除后只剩默认 renderer；大输出时 DOM/canvas 逐格重绘。正确做法是 WebGL 优先 + `onContextLoss`/启动异常时自动降级（而不是整个移除），并加 `CanvasAddon` 兜底。
3. **React 外壳干扰**：`useSSE` 的 state 更新（`sseState`）+ `vale-term-output` CustomEvent + 每帧 write 回调都在主线程；若 write 回调里触发 React setState 或重渲染，会把解析帧率拖垮。xterm 的 DOM 子树必须完全排除在 React reconciliation 之外（TerminalPane 已把 overlay 移出 `.term-host`，方向正确，但要确保 write 路径零 React 参与）。
4. **scrollback 20000 偏大**：配合无背压，长会话内存/重绘成本上升；VSCode 默认 1000。可降到 5000-10000 或做成设置。
5. **resize 风暴**：ResizeObserver + visibilitychange + window resize 三路都直接 `fit()`+`terminal_resize`，无 32ms 限流；快速拖窗时高频 fit 重排 grid。

## Web 终端 vs 原生终端的显示性能差距

- **渲染**：原生终端（alacritty 等）用 OpenGL/Vulkan 直接光栅化字形，整屏脏矩形只重绘变化行，CPU 占用近零；xterm.js WebGL 走浏览器 WebGL2 同样 GPU 光栅化，glyph atlas 上传后滚动只是纹理拷贝，**60fps 下两者视觉差距已很小**。差距主要在**解析层**：xterm.js 的 VT 解析是单线程 JS，官方吞吐 5-35MB/s（有界于 16ms/帧的时间片），而原生终端是 C/Rust 解析器（alacritty 的 vte 解析 >100MB/s），`yes` 这类纯输出场景 Web 端先到解析瓶颈。
- **输入延迟**：原生 <5ms；Web 端受浏览器合成/事件循环影响，实测 10-30ms 可感知但可接受（VSCode 即此水平）。
- **结论**：Web 终端可达到"日常流畅、大输出不冻结"的可用上限（VSCode/Tabby 证明），但极端吞吐（日志洪水）永远落后原生一个数量级；若 Vale 的用户场景包含持续大输出，应在 Web 端做**流控 + 跳帧**保证 UI 不冻结，而不是追求像素级不丢帧。

## 结论：Web 终端能否解决显示问题

**能，且不必换原生。** 按优先级落地即可：

1. 客户端 FlowControl：write-callback 计数 + high/low watermark，超限暂停消费 SSE 帧（必要时回 ACK 让 agent 端停读 PTY）——这是消除"卡死/丢帧"的第一杠杆；
2. 渲染器：WebGL 优先 + context lost 自动重建/降级 + Canvas 兜底（VSCode 的 auto 策略），替代"整体移除 WebGL"；
3. 降 scrollback 到 10000 内、resize 32ms 限流合并、保证 write 路径零 React 重渲染；
4. 服务端（agent）给 SSE 广播加背压感知（订阅者消费慢时合并/丢弃中间帧，仅保最新 + start 偏移，前端用既有 lagBackfill 补洞——Vale 已有该机制，扩展它即可）。

参考优先级排序：Tabby 的 FlowControl + 渲染器策略（成熟、可整体借鉴）> xterm.js 官方流控指南（协议层 ACK）> CloudShell（仅作会话管理参考）。Web 形态上限 = VSCode 终端水平；只有"持续 GB 级输出 + 像素级滚动"这类需求才需要原生（alacritty_terminal 嵌入）或像素管线（见 terminal-browser-research.md）。

## 参考链接

- CloudShell README：https://github.com/iu2frl/CloudShell
- CloudShell 前端 Terminal.tsx：https://github.com/iu2frl/CloudShell/blob/main/frontend/src/components/Terminal.tsx
- CloudShell 后端 ssh.py（WS 桥接）：https://github.com/iu2frl/CloudShell/blob/main/backend/services/ssh.py
- tabby-web：https://github.com/Eugeny/tabby-web （前端壳 terminal.ts）
- Tabby xtermFrontend.ts：https://github.com/Eugeny/tabby/blob/master/tabby-terminal/src/frontends/xtermFrontend.ts
- xterm.js 官方 Flow Control 指南：https://xtermjs.org/docs/guides/flowcontrol/
- VSCode 渲染器迁移 issue：https://github.com/microsoft/vscode/issues/106202
- xterm.js WriteBuffer 硬上限（50MB）：https://github.com/xtermjs/xterm.js/blob/7f598a36753f4d950ee63dc91bd6a92290f7e037/src/common/input/WriteBuffer.ts
