# AI 控制终端生态调研（hyperia / exterm_ai / Netcatty / terminal_mcp）

> 调研日期：2026-09-04。目标：为 Vale（SecureCRT 式多会话终端 + MCP server）梳理"AI/MCP 如何控制终端会话"的生态现状与最佳实践。
> 主要来源：各仓库 README 与源码（hyperia `sidecar/src/mcp.rs`、`docs/mcp-tools.md`；Netcatty `infrastructure/ai/`、`electron/mcp/`、`electron/capabilities/catalog/`；exterm_ai `lib/exterm/llm/tools/terminal.ex`；terminal_mcp README）。

## 1. 项目概览

| 项目 | 形态 | AI 接入方式 | 工具面 |
|---|---|---|---|
| **hyperia**（DeepBlueDynamics，Vercel Hyper fork） | Electron + Rust sidecar(:9800) | MCP streamable HTTP（读匿名、写需 Bearer token） | 72 个工具 |
| **Netcatty**（binaricat） | Electron + React + xterm.js | 内置 Catty Agent（侧边栏）+ 对外 MCP stdio（TCP JSON-RPC 桥） | ~45 工具（4 terminal + 11 sftp + vault/portforward/harness 等） |
| **exterm_ai**（metehan） | Elixir + xterm.js 网页终端 | 自研 WebSocket 聊天，OpenRouter | 5 个工具，无 MCP |
| **terminal_mcp**（AuraFriday，MCP-Link 生态） | Python 服务，闭源 | MCP | operation API（open_session/sftp_*/pattern 等） |

## 2. AI↔终端交互模型对比

核心问题：**AI 是直接读写 pty 字节流，还是调工具 API？**

结论：**四家都是"pty 字节流打底 + 工具 API 包装"，差异在"命令结束判定"与"输出截取"**。

| 维度 | hyperia | Netcatty | exterm_ai | terminal_mcp | Vale（现状） |
|---|---|---|---|---|---|
| 执行 | `terminal_keys`/`terminal_run` 打字+回车，**读屏**（vt100 渲染态）判断结果 | `terminal_execute`：PTY 写入 + **唯一 marker** 检测结束与 exit code；长命令 `terminal_start`/`poll`/`stop` job 化 | `send_to_terminal` + 50ms 轮询输出稳定性 | 命令 + **pattern-match** 等待指定响应 | `terminal_execute`：**OSC 133:D marker** + quiet 兜底（已有 ✓） |
| 读 | `terminal_screen`（当前屏）/`terminal_scrollback`（回滚） | 上下文读取 viewport/tail/head/lines 分档 | `read_terminal` 读历史 N 行 | 会话缓冲 | `terminal_read`(offset) ✓ |
| 输出治理 | **Maximus**（本地 Ollama 按 `focus` 关键词过滤，`raw` 绕过） | `terminalMonitorGuard` 令牌桶限流 watch/tail -f，输出截断 | 历史条数限制 | 智能缓冲 | 无过滤/限流 ✗ |
| 多会话 | windows>tabs>panes 三级；`terminal_status` 全览、`tab_snapshot` 一次读全部、可 `terminal_split` 自建 pane | 多会话但**受限 scope**（workspace 内），system prompt 禁止 AI 自开会话 | 单终端绑定 | 多会话 session_id | 多会话 session_id ✓ |
| 命令判定 | 读屏 + `shell_state`（idle/dialog/running/empty 分类）+ `shell_confirm` 自动处理 y/n | marker + exit code（机器判定）；SSH 另有不可见 exec channel 兜底 | 输出静默窗口 | pattern wait + 原子多步 | marker + quiet ✓（无 shell_state ✗） |

## 3. 会话 / 权限模型

- **hyperia**：身份与访问分离——token（pane 内自动注入 `HYPERIA_AGENT_TOKEN` 或持久 `hyp_agent_`）只证明"你是谁"；**一切状态改变动作（开 pane、驱动他人 pane）需人同意**，同意弹窗异步返回 202 awaiting / 403 denied；`request_access(pane, purpose)` 主动请求；`consent_log`/`audit_search` 全审计。另有三件套：**Pane Pulse**（`pane_pulse_set` 定时向卡住 pane 重发 prompt 唤醒）、`pane_on_idle` 自唤醒、`pane_busy`/`pane_idle` 自报活——解决"agent 挂死无人知"。
- **Netcatty**：三档 permission mode——**observer（只读）/ confirm（写操作弹 UI 审批）/ auto（靠 blocklist）**；审批按工具 policy（write/bypassesApproval）路由，支持 once/session 级 grant 持久化；命令 blocklist（ReDoS 防护编译）；网络设备 CLI（Cisco 等）跳过 shell blocklist。
- **exterm_ai**：`suggest_terminal_command` 走"建议待批准"路径，其余直发。
- **terminal_mcp**：会话隔离 + 审计 + host key 校验 + **提权需明确批准**；杀手锏是 **auto_reconnect 持久会话**（串口拔插/复位/DFU 重枚举自动重连、捕获完整 boot log）与 **同 SSH 连接开独立 SFTP channel**（不打断 shell）。
- **Vale**：无审批层 ✗（最大差距）。

## 4. 对 Vale 的差距分析（缺什么）

Vale 已有 20 个 `terminal_*`（open/exec/read/write/connect_saved/env/diag 等）+ 6 个 `memory_*`，执行与多会话基础扎实。缺：

1. **权限/审批层（最优先）**：observer/confirm/auto 模式、命令 blocklist、按工具/会话粒度的批准 + grant 持久化。Vale 是"本地全权"，一旦接入云端 agent 就是裸奔。
2. **长任务 job 三件套**：`terminal_start`/`terminal_poll`/`terminal_stop` 独立工具（现 run_in_background 只给 cursor）。
3. **SFTP 工具**：Netcatty 11 个 sftp_*、terminal_mcp 同连接 SFTP——Vale 的 SSH 会话没有文件通道。
4. **输出治理**：tail -f/watch 限流（monitor guard）、focus 过滤、screen 状态分类（`shell_state`），否则长输出刷爆 agent 上下文。
5. **会话持久化**：串口 auto_reconnect（device 场景刚需）。
6. **Agent 协同**：hyperia 的 Pulse 唤醒/自报活、跨会话一次读全部（`tab_snapshot` 等价物）、工具输出存档（compaction 后仍可检索）。

## 5. 最佳实践结论

- 交互模型 = **真实 pty（用户可见、可介入）+ 结构化工具**：执行用 marker/exit-code 机器判定结束（比读屏判断可靠），长命令 job 化，读带范围分档。
- 安全 = **审批三档 + blocklist + 审计**是底线，hyperia 的"身份/访问分离 + 异步 202"最优雅，Netcatty 的"工具级 policy + grant 持久化"最可落地。
- 编排 = 多会话受限 scope + 输出限流/过滤 + 日志检索 + 自报活，缺一不可。
