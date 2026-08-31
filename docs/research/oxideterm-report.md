# OxideTerm 技术调研报告（面向 Vale 选型）

> 调研时间：2026-08-31。数据来源：GitHub API、README.md、克隆源码（main 分支 @135f443，v2.0.25）。
> 仓库：[github.com/AnalyseDeCircuit/oxideterm](https://github.com/AnalyseDeCircuit/oxideterm)

## 1. 项目概览

OxideTerm 是 2026-01-21 开源的 AI 原生远程运维工作台（Rust + GPUI，非 Tauri，见下），定位与 SecureCRT 高度重合：SSH/Mosh/Telnet/串口/RDP/VNC/SFTP/端口转发/本地 shell/轻量 IDE 全部集成在一个原生应用里。核心卖点：**零 Electron、零 WebView**（GPUI 直接 GPU 绘制）、**零 OpenSSL**（russh+ring 纯 Rust SSH）、零遥测、无订阅、BYOK AI。

- **活跃度**：⭐ 1,380 / fork 95 / open issues 20；主提交者 AnalyseDeCircuit（2,024 commits）+ Icarus-Alpha；最近提交 2026-08-31（macOS Keychain SSH key 修复），v2.0.25 于 2026-08-28 发布，日均多提交，**非常活跃**。
- **规模**：~80 个 workspace crates，代码量 ~20 万行+；`[patch.crates-io]` 内嵌了 russh/russh-sftp/alacritty_terminal/vte/GPUI 五个 fork（README 称 portable-pty，实际本地 PTY 走 fork 的 alacritty tty 模块，Windows 动态加载 conpty.dll）。

## 2. 架构

单进程 GPUI（Zed 的 GPU 即时模式 UI 框架，Apache-2.0 fork 自 zed-industries/zed）：

- 渲染层 `gpui-ce`（gpui_wgpu 跨平台 wgpu + `gpui_windows/directx_renderer.rs` 走 D3D11），**无 DOM/CSS/JS 序列化边界**，终端字节直接变更内存态 `TerminalState`，GPUI 读取后发 GPU draw call。
- 域层为 20+ 个独立 crate：`oxideterm-ssh`（russh）、`oxideterm-terminal`（alacritty fork）、`oxideterm-ai`、`oxideterm-public-mcp`、`oxideterm-connections`、`oxideterm-forwarding`、`oxideterm-sftp` 等；Tokio + DashMap；`SshConnectionRegistry` 做物理连接池，`NodeRouter` 以 nodeId→connectionId 寻址，多跳代理链、Grace Period 30s 智能重连（snapshot→probe→重连→恢复 forwards/transfers/IDE）。

## 3. 关键实现

- **终端渲染**：alacritty_terminal fork 做 VT 解析（含 Sixel/Kitty 图像、tmux -CC 控制模式），GPUI 元素直接绘制字形/矩形/图像到 GPU 表面；行布局缓存、语义着色、ghost text、Bidi 均有专门模块。
- **SSH**：vendored russh 0.63（ring 加密，无 OpenSSL/libssh2）；SSH Agent（Unix socket / Windows `\\.\pipe\openssh-ssh-agent`）、TOFU known_hosts、2FA、端口转发为独立消息传递架构（单任务持有 Channel，无 Arc<Mutex<Channel>>）。
- **串口**：`serialport` crate，`SerialSession` 支持波特率/数据位/校验/流控，带 hexdump 调试、设备热插拔错误码。
- **AI（OxideSens）**：BYOK 多 Provider（OpenAI/Anthropic/Gemini/Ollama/任意 OpenAI 兼容端点，预置 DeepSeek/Kimi/GLM 模板）；SSE 流式；本地 RAG（BM25 + HNSW + CJK 分词 + RRF）；凭证 keychain 存储 + 出站消息凭据正则脱敏；**每次工具调用需用户审批**（`pending_tool_approvals` oneshot 通道 + UI 弹窗）。
- **MCP 双角色**：
  - *客户端*：`oxideterm-ai/src/mcp/` 用 rmcp 3.x，支持 stdio/SSE/streamable-HTTP 连接外部 MCP server，工具索引合并进 AI 编排；
  - *服务端*：`oxideterm-public-mcp` 暴露**本机回环 streamable-HTTP MCP server**（`http://127.0.0.1:<port>/mcp`），Bearer token 认证 + 客户端注册表 + 审批/审计/工件过期；工具面覆盖 Terminal（Open/Read/Submit/Resize/Control）、Desktop（RDP/VNC 帧+输入）、Command、SFTP/Artifact、Forward、QuickCommands 等 ~50 个，支持 MCP 客户端反向控制桌面。

## 4. 多会话 / 浏览器 / AI 控制终端

- **多会话标签**：✅ 原生多标签 + 分屏（每标签最多 4 个 pane）。`TabKind` 覆盖 LocalTerminal/SshTerminal/MoshTerminal/Sftp/Ide/Forwards/RemoteDesktop/SessionManager/Settings/Plugin 等，会话树持久化到 `session_tree.json`，重启恢复。
- **浏览器**：❌ **不支持浏览器工具**。AI 工具集中无 browser/playwright 工具，UI 无浏览器标签（代码中 "browser" 仅指 Tauri 遗留的滚动容器等，已废弃）。RDP/VNC 是唯一的"图形会话"能力。
- **AI 控制终端交互**：编排工具 `run_command`（handle_id + command + await_output，直接执行或终端会话内发送）、`observe_terminal`（读屏幕缓冲快照，最大 12000 字符）、`send_terminal_input`（文本/控制键）、`wait_terminal_output`（轮询等待文本出现）、`get_terminal_command_status`；终端是带 generation 游标的增量读取模型（`ai_screen_snapshot`），与 Vale 的 pty 抽象类似；另有 `create_background_task`/`list_background_tasks` 定时任务、`manage_memory_entry` 记忆、`load_skill` Agent Skills。

## 5. License 与 fork 可行性

- **License**：GPL-3.0-only（含内嵌 fork：GPUI Apache-2.0、russh Apache-2.0、alacritty_terminal Apache-2.0、vte Apache-2.0 OR MIT —— 都是宽松许可，**不传染**；GPL 传染面是 OxideTerm 自有代码）。Vale 若闭源商业分发，**不能直接 fork 或链接其 GPL 代码**；合法路径：① 仅借鉴设计/架构（不复制代码）；② 若复制代码则 Vale 整体须 GPL 开源；③ 与其作者洽谈双许可（项目有完整 NOTICE/THIRD_PARTY_NOTICES 规范，作者对贡献政策较严谨）。
- **代码质量**：高。模块化彻底、大量 doc comment 与测试（`#[cfg(test)]` 遍布）、cargo-deny（deny.toml）、提交规范（conventional commits）、CI（GitHub Actions）。风险：① 单飞项目（实质 1 名主作者），长期维护依赖作者意愿；② 体量大（vendored fork 同步上游成本高）；③ README 个别技术声明与实际实现有出入（portable-pty vs alacritty tty）。
- **活跃度**：高（见 §1），近期提交密集且包含真实 bug 修复（Keychain ACL、终端输入法冲突）。

## 6. 与 Vale 能力对比

| 能力 | OxideTerm | Vale (agent) | 备注 |
|---|---|---|---|
| 本地 shell/PTY | ✅ alacritty tty fork（ConPTY） | ✅ pty | 实现可互相印证 |
| SSH | ✅ russh（ring，agent、多跳、2FA） | ✅ | Vale 已具备 |
| 串口 | ✅ serialport + hexdump | ✅ | 均已具备 |
| Telnet | ✅ 内建 | 未知（README 未提） | Vale 可补 |
| 多会话标签/分屏 | ✅ 原生 tab + 4-pane | 桌面版规划中 | OxideTerm 是现成参考 |
| SFTP/文件管理 | ✅ 双栏 + 传输队列 | ❌ | Vale 差异化方向之一 |
| 端口转发 | ✅ -L/-R/-D + 重连恢复 | ❌ | 可借鉴设计 |
| RDP/VNC 桌面 | ✅ 内置 | ❌ | 差异化候选 |
| 浏览器工具 | ❌ | ✅ playwright 捆绑组件 | **Vale 核心差异化** |
| AI（BYOK） | ✅ 多 provider + RAG + 审批 | ✅ MCP server | Vale 通过 MCP 暴露 |
| MCP 服务端 | ✅ 回环 HTTP + 认证/审计 | ✅ | 双方同思路，Vale 可参考其审批/审计模型 |
| 多设备/网关 | ❌ 单机应用 | ✅ Cloudflare worker + 隧道 | **Vale 核心差异化** |
| 记忆 | ✅ 作用域 memory entry | ✅（上下文/会话） | OxideTerm 的 scoped+revision 模型可借鉴 |
| Agent Skills | ✅ 目录化加载 | ❌ | 低成本借鉴 |
| 录制/回放 | ✅ 会话录制 + trzsz | ❌ | 可借鉴 |

## 7. 借鉴点清单（按优先级）

1. **MCP 服务端安全模型**：回环绑定 + Bearer token + 客户端注册表 + 工具审批（per-call oneshot + UI 确认）+ 审计日志 + 工件/审批 30s 过期 —— Vale 的 MCP server 目前缺审批与审计，直接抄这套设计。
2. **终端增量读取协议**：`ai_screen_snapshot`（generation 游标 + tail 行数 + unchanged 短路）—— 比整屏抓取省 token，适合 Vale 的 AI 控制 pty。
3. **AI 编排工具集**：run_command / observe_terminal / send_terminal_input / wait_terminal_output / get_terminal_command_status 五件套 + 后台任务（create/list/get/cancel_background_task），Vale 可对齐工具命名与参数。
4. **作用域记忆**：`manage_memory_entry`（user/workspace/project/host 四作用域 + revision 乐观锁 + provenance）—— Vale 的记忆系统可升级为带作用域与并发保护的模型。
5. **重连编排**：Grace Period 30s 探活 + 会话树快照恢复（forwards/transfers/IDE 一起恢复）—— Vale 的 SSH 重连可借鉴其状态机（queued→snapshot→grace→connect→restore→verify）。
6. **凭据与秘密卫生**：OS keychain + `zeroize`/`Zeroizing` + 诊断日志 redaction + AI 出站消息凭据正则脱敏 —— Vale 的日志与 AI 上下文同样需要。
7. **Agent Skills 目录**：skill catalog + `load_skill`/`read_skill_resource`（路径逃逸校验）—— 与 Vale 的 superpowers/skills 体系思路一致。
8. **串口增强**：hexdump 调试模式、设备热插拔错误分类 —— 低成本。
9. **会话录制 + trzsz**：终端流内文件传输与录制回放 —— 中成本，运维场景加分。
10. **知识库 RAG**（BM25+HNSW+RRF+CJK 分词）—— Vale 若做本地知识问答可参考；注意 Vale 是 gateway 架构，本地 RAG 是否值得引入需单独评估。

**不建议**：直接移植 GPUI 渲染栈（Vale 已确定 Web/浏览器方向，GPUI 无浏览器集成路径）；跟进其 RDP/VNC（Vale 有 playwright 浏览器，图形会话优先级低于差异化能力）。

## 8. 结论

OxideTerm 是当前开源界与 Vale 目标最接近的成熟参考实现（同赛道、同 AI+MCP 思路、质量高、活跃），但**不构成直接竞争威胁**：它没有浏览器工具、没有多设备/网关架构，是单机工具型产品；Vale 的浏览器自动化 + 设备网格 + gateway 是明确差异化。License 上 Vale 应保持"**参考设计、不复制代码**"（GPL-3.0 传染），重点吸收其 MCP 审批/审计模型与 AI↔终端交互协议设计。
