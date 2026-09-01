# 主流 AI Coding Agent 的"终端执行命令并等待完成"机制研究

> 研究日期：2026-09-01（美国时间 2025 年版本对应的文档快照；Claude Code 文档已迁移至 code.claude.com）
> 核心问题：AI agent 在终端执行命令时，**如何知道命令"完成"了？如何避免输出乱序？如何避免卡住？**
> 方法：以官方文档 + 一手源码为准（每条结论附来源），5 个方向并行研究：Claude Code、OpenAI Codex CLI、OpenHands、Gemini CLI、tmux control mode。

---

## TL;DR（结论速览）

| 项目 | 执行模型 | 完成检测 | 输出隔离 | 超时处理 |
|---|---|---|---|---|
| **Claude Code** (Bash) | 每次命令一个独立子进程（非持久 shell） | **等待子进程退出**（waitpid 语义，官方"runs each command in a separate process"）；**无静默窗口机制** | 每次独立进程天然隔离；输出流式写 working file，结束回读（默认 30,000 字符窗口） | 默认 **120s**（`BASH_DEFAULT_TIMEOUT_MS`）；超时**移到后台**（非杀）；`sleep`/`git`/复合命令超时则 SIGTERM 终止 |
| **OpenAI Codex CLI** (Rust) | 每次工具调用一个 **PTY 子进程**（portable-pty / Windows ConPTY），非持久 shell | **等待子进程退出码**（`child.wait()` / `exit_rx` oneshot），**非静默/非 marker** | stdout/stderr 合并为单一流；HeadTailBuffer 1 MiB 头尾截断；按 `session_id`/`process_id` 关联 | **无硬超时 kill**：`yield_time_ms`（默认 10s）只"先拿一轮输出"，存活则返回 session_id 供 `write_stdin` 轮询；取消时才 kill 进程组 |
| **OpenHands**（V1 现行） | **长驻终端会话**（factory 自动选：TmuxTerminal / SubprocessTerminal-PTY / WindowsTerminal-PowerShell）；浏览器终端 UI 路径是每命令子进程 | **PS1 元数据 marker + 0.5s 轮询**（新 PS1 出现 或 屏幕以 PS1END 结尾）；浏览器路径 `process.wait()` 等退出 | 两个 PS1 marker 之间的内容 = 本次命令输出；buffer 清理 + `prev_output.removeprefix`；浏览器路径按 `command_id` 隔离 | 两级超时：no-change 30s 软超时（命令继续跑）+ hard 超时；**终端路径超时不 kill**（返回部分输出）；浏览器路径 SIGTERM→1s→SIGKILL |
| **Gemini CLI** (TS) | 每次命令新起 shell（`bash -c` / PowerShell），可选 PTY（@lydell/node-pty） | **子进程 `close` 事件 / PTY `onExit`**；无 marker | stdout/stderr 合并；PTY 写入 headless xterm（scrollback 30 万行），退出时取全缓冲；child_process 16 MB 上限 | **inactivity timeout（无输出超时）** 默认 300s，非硬超时；超时 abort → killProcessGroup |
| **tmux control mode** | 终端复用器（pty 管理） | **%exit 是 client 退出事件，不是命令完成事件！** 真正方案：`%window-close`、`pane_dead` 轮询、**sentinel（echo __DONE__）+ %output 流**、`wait-for` 通道 | %output 无边界，需双 sentinel 夹取或独立 window；`%begin…%end` 只框定 tmux 命令输出 | 无内置超时；外部程序自己管 |

**一句话总结**：主流 AI coding agent 的完成检测**几乎全部是"等子进程退出"**（`wait()` / `close` / `onExit` / `process.wait()`），每次工具调用新起独立进程以天然获得输出隔离；**唯一例外是 OpenHands 的终端工具**（长驻 tmux/PTY 会话 + 注入 PS1 元数据 marker + 0.5s 轮询），以及 tmux control mode 本身的 sentinel/轮询方案。**"输出静默窗口（silent period）"机制在主流实现中不存在**——命令没结束就一直在等（配合超时兜底）。

---

## 1. Claude Code 的 Bash（ExecuteCommand）工具

来源：官方文档已迁移至 [code.claude.com/docs](https://code.claude.com/docs/en/overview)（原 docs.anthropic.com 域名 301 跳转）；工具参考 [tools-reference.md](https://code.claude.com/docs/en/tools-reference.md)、Hooks 参考 [hooks.md](https://code.claude.com/docs/en/hooks.md)、环境变量 [env-vars.md](https://code.claude.com/docs/en/env-vars.md)；源码闭源（npm bundle），社区逆向 [how-claude-code-works](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/main/docs/04-tool-system.md)。

### 1.1 完成检测：等待子进程退出（waitpid 语义），无"静默窗口"

- 官方文档明确：**"The Bash tool runs each command in a separate process."**（[tools-reference.md#bash-tool-behavior](https://code.claude.com/docs/en/tools-reference.md#bash-tool-behavior)）——每次工具调用都是新起独立进程。
- 完成判定 = **子进程退出**。官方 Hooks 文档描述 Bash 工具结果格式："a command that ran and exited produces a first line `Exit code N`, then any output the command produced"（[hooks.md#posttoolusefailure-input](https://code.claude.com/docs/en/hooks.md#posttoolusefailure-input)）——结果按退出码封装，证实完成以进程 exit 为标志。
- **未发现"timeout + 输出静默窗口（silent period）"机制的任何权威证据**。社区逆向（基于 2026-03 源码快照）确认 BashTool 通过 `LocalShellTask` 流式把 stdout/stderr 写入工作文件，命令结束（进程退出）后才回读（[how-claude-code-works 4.6 节](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/main/docs/04-tool-system.md)）。命令在超时前一直阻塞等待，不存在按输出静止判定的窗口。
- 注意：Bash 工具输入参数里有 `timeout`（毫秒，默认 120000，见 PreToolUse hook 输入 JSON 示例：`"timeout": 120000, "run_in_background": false`，[hooks.md#common-input-fields](https://code.claude.com/docs/en/hooks.md#common-input-fields)）。

### 1.2 输出收集：独立进程隔离 + 流式写文件 + 回读窗口

- **每次调用独立进程** → 一次工具调用返回的输出必属当次命令。环境变量不跨命令保留；`cd` 仅当落在项目目录/附加目录内才延续，否则重置并提示（[tools-reference.md#what-persists-between-commands](https://code.claude.com/docs/en/tools-reference.md#what-persists-between-commands)）。
- stdout/stderr **合并**为一块（"any output the command produced as one block with stdout and stderr interleaved"，[hooks.md](https://code.claude.com/docs/en/hooks.md#posttoolusefailure-input)）；结果对象含 `stdout`、`stderr`、`interrupted`、`isImage` 字段。
- 输出流式写入 working file；**超过 5 GB 被 kill**。命令结束后回读，上限 `BASH_MAX_OUTPUT_LENGTH` 默认 **30,000 字符**（上限 150,000）。成功结果内联 ≤ 约 30,000 字符，超出给文件路径+预览（文件截断 64 MiB）；失败结果内联 ≤ 约 10,000 字符，超出给首尾摘录（[tools-reference.md#output-limits](https://code.claude.com/docs/en/tools-reference.md#output-limits)）。

### 1.3 超时处理：默认 120 秒，超时"移到后台"而非杀死

- `BASH_DEFAULT_TIMEOUT_MS` 默认 **120000（2 分钟）**；`BASH_MAX_TIMEOUT_MS` 默认 600000（10 分钟），是模型可设超时的上限（[env-vars.md](https://code.claude.com/docs/en/env-vars.md)）。
- **默认行为：超时不杀，移到后台**："When a command reaches its timeout without finishing, Claude Code moves it to the background instead of stopping it"，结果报告 `Command did not complete within its 120s timeout and was moved to the background`（[tools-reference.md#background-commands](https://code.claude.com/docs/en/tools-reference.md#background-commands)）。
- 例外（超时直接终止）：以 `sleep` 开头、含 `git`、或无法解析的复合命令。终止用 **SIGTERM**（GitHub issue [#45717](https://github.com/anthropics/claude-code/issues/45717) 证实：超时用 SIGTERM 杀子进程，且曾因进程组共享误杀 Claude Code 自身，"Status 143 = 128 + 15 = killed by SIGTERM"）。已知 bug：后台命令被超时杀却误报 "completed (exit code 0)"（[#90616](https://github.com/anthropics/claude-code/issues/90616)）。
- 输出上限兜底：命令输出超 5 GB 被杀（见 1.2）。

### 1.4 Windows / PowerShell

- 旧路径：Bash 工具在 Windows 走 **Git Bash**（MSYS2/MinGW），非 cmd.exe；曾出现长会话 stdout 捕获丢失 bug（[#36038](https://github.com/anthropics/claude-code/issues/36038)）。
- 新路径（v2.1.13+）：原生 **PowerShell 工具**——无 Git Bash 时自动启用；有 Git Bash 时 claude.ai/Console 账户默认开。`pwsh.exe`（7+）优先、回退 `powershell.exe`（5.1）；`-ExecutionPolicy Bypass` 进程级启动；PowerShell 配置文件不加载；**Windows 上沙箱不支持**（[tools-reference.md#powershell-tool](https://code.claude.com/docs/en/tools-reference.md#powershell-tool)）。v2.1.214+ 修了 Windows 编码问题（`>` 重定向写 UTF-8、捕获错误输出无 ANSI、等待 stdin 的子进程收到 EOF 而非挂起）。
- cmd.exe 不作为工具 shell。

### 1.5 Hooks 与 settings 的关系

- **Hooks 不参与完成检测**：PreToolUse（执行前，可 deny/改命令）、PostToolUse（成功后，可拿到 `tool_response`）都在 Bash 进程生命周期之外。PostToolUse 输入含 `tool_response`——"contains the same content the model receives in the corresponding `tool_result` block"（[hooks.md#posttooluse-input](https://code.claude.com/docs/en/hooks.md#posttooluse-input)），即能拿到输出，但那是事后观察，不是完成判定机制。
- settings.json 相关：permissions（`Bash(...)` 规则）、`defaultShell: "powershell"`、sandbox 配置（macOS Seatbelt / Linux bubblewrap，不支持原生 Windows）与完成检测无关（[settings-reference.md](https://code.claude.com/docs/en/settings-reference.md)、[sandboxing.md](https://code.claude.com/docs/en/sandboxing.md)）。

---

## 2. OpenAI Codex CLI（Rust）

来源：仓库 [openai/codex](https://github.com/openai/codex)（研究时 main 分支 HEAD `5f49aba876922d6f2f55caa153bbb0ed1b46feba`）；代码路径：`codex-rs/core/src/{shell.rs, unified_exec/{mod,process,process_manager,async_watcher,head_tail_buffer}.rs, tools/handlers/{unified_exec.rs, shell_spec.rs, unified_exec/{exec_command,write_stdin}.rs}, exec.rs}`、`codex-rs/utils/pty/src/{pty,process,pipe}.rs`、`codex-rs/shell-command/src/shell_detect.rs`。

### 2.1 执行模型：每次工具调用一个 PTY 子进程

- 对每个 `exec_command` 工具调用**新起一个子进程**（shell 一次性执行），非跨调用复用的持久 shell。子进程挂在 **PTY** 上（`tty:false` 时退化为普通管道）。
- `core/src/shell.rs` `derive_exec_args`：bash/zsh/sh → `[shell_path, "-lc"/"-c", command]`；PowerShell → `[powershell, "-NoProfile"? , "-Command", command]`；cmd → `[cmd, "/c", command]`。
- PTY 用 **portable-pty 0.9.0**（wezterm 的 crate；Windows 上替换为自研 ConPTY 实现 `utils/pty/src/win/conpty.rs`）。`spawn_process` → `spawn_blocking` 中 `child.wait()`，通过 `oneshot::Receiver<i32>`（`exit_rx`）通知退出（`utils/pty/src/process.rs`）。
- 进程由 `UnifiedExecProcessManager` 管理（存活进程上限 64），返回 `session_id`/`process_id` 供后续 `write_stdin` 复用同一进程（"每命令一个 PTY 子进程 + 可选复用"）。

### 2.2 完成检测：等子进程退出码（exit_rx），非静默/非 marker

- `utils/pty/src/process.rs`：`wait_handle` 任务 `exit_rx.await` 后置位 `exit_status` 与 `exit_code`；`has_exited()`/`exit_code()` 即此状态。
- `core/src/unified_exec/process.rs` `from_spawned`：先 `try_recv`、再等 `EARLY_EXIT_GRACE_PERIOD=150ms`；仍运行则 `tokio::spawn` 任务 `exit_rx.await` 后写 `watch::Sender<ProcessState>` 并 cancel 输出 token——**退出信号即完成信号**。
- 远程/exec-server 路径用 `ExecProcessEvent::Exited`/`Closed` 事件。**无任何"提示符检测"或"输出静默检测"实现**（已 grep 验证）。

### 2.3 输出收集：合并流 + 头尾截断 + 流式 Delta

- stdout/stderr **合并**为单一 broadcast 流（`combine_output_receivers`；PTY 模式下 stderr 本就被 PTY 合并）。
- 截断：`HeadTailBuffer` 上限 **1 MiB**（`UNIFIED_EXEC_OUTPUT_MAX_BYTES`），保留前 50% + 后 50%，中间插 `... N bytes omitted ...`；模型侧再按 `max_output_tokens`（默认 10000）截断。
- 流式：`async_watcher.rs` 后台任务把输出分块（每 delta ≤ 8192 字节，UTF-8 边界切分）发 `ExecCommandOutputDelta` 事件（上限 10000 个 delta/调用）；进程退出后发带聚合转录的 `ExecCommandEnd`。

### 2.4 超时处理：软超时 = 先拿一轮输出，不杀进程

- **没有"命令总超时 kill"**：`exec_command` 的 `yield_time_ms` 默认 **10000 ms**（有效范围 250-30000 ms，Windows 下限 10000）。`collect_output_until_deadline` 只等到 deadline 就返回当前输出；若进程仍存活，返回 `Process running with session ID N`，模型随后用 `write_stdin`（空 chars 即纯轮询，默认等待 5000-300000 ms）继续拿输出——**这就是后台/长命令机制**。
- 真正 kill 只发生在：取消（`ExecExpiration::Cancellation`：先 `terminate_process_group` 优雅 TERM、50ms 宽限后 `kill_process_group`）、用户 Ctrl-C、`terminate` 工具、网络拒绝。旧管道路径 `exec.rs` 有 `DEFAULT_EXEC_COMMAND_TIMEOUT_MS=10000` + `IO_DRAIN_TIMEOUT_MS=2000`，超时后 `kill_child_process_group` 并以退出码 124 报告。
- 中断：`write_stdin` 收到 `chars="\u{3}"`（Ctrl-C）时对 PTY 进程组发 `ProcessSignal::Interrupt`。

### 2.5 Windows / PowerShell

- Windows 是一等公民：`ShellType::{Zsh,Bash,PowerShell,Sh,Cmd}`；默认 PowerShell，兜底 cmd.exe；PowerShell 参数含 `-NoProfile`、`-Command`；有 `prefix_powershell_script_with_utf8` 处理 UTF-8。
- Windows PTY 用自研 **ConPTY** 后端（`win/conpty.rs`、Job Object、`WindowsTtyInputNormalizer`）；`platform_native_pty_system()` 在 Windows 返回 `ConPtySystem`。

---

## 3. OpenHands（原 OpenDevin）

来源：主仓库 [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands)（已重构为 TS "Agent Canvas" 前端）；Python 运行时在 [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk)。**架构沿革**：V0 运行时（含 `openhands/runtime/impl/docker/docker_runtime.py`、`BashSession`）在 2026-04-24 commit `e86067c15` "Removed V0 runtime (#14117)" 被删除；agentic core 迁至 software-agent-sdk。研究覆盖 **V0（2026-04 前主仓库，git 全历史考古）** 与 **V1（software-agent-sdk 现行）**。

### 3.1 执行模型：长驻终端会话（V0/V1 相同），非每命令新进程

- **V1 现行**：`openhands-tools/openhands/tools/terminal/terminal/factory.py` 按能力自动选择后端：
  - tmux 可用 → **`TmuxTerminal`**（libtmux，长驻 bash pane；默认后端，带 pane pool 并发 + 崩溃恢复）；
  - 否则 → **`SubprocessTerminal`**（PTY：`pty.openpty()` + `subprocess.Popen([bash, "-i"], stdin/stdout/stderr=slave_fd)` + 后台 `reader_thread` 用 `select.select` + `os.read(4096)` 持续读 PTY 写入 `deque(maxlen=HISTORY_LIMIT+50)` 环形缓冲）——**用户线索中的"subprocess + stdin + reader 线程"正是这个实现**；
  - Windows → **`WindowsTerminal`**（PowerShell）。
  - 全部是**长驻会话**，非每条命令新起进程（这与 Claude Code/Codex/Gemini 形成鲜明对比）。
- **V0**：`openhands/runtime/utils/bash.py` 的 `BashSession` 用 **tmux/libtmux** 长驻 bash；2025-01-03 commit `ec70af941` "Replace pexpect with libtmux in BashSession"（PR #4881）之前用 **pexpect.spawn** 长驻 shell。
- **V0 架构细节**：`docker_runtime.py` 自 2024-10（commit `2d5b36050`）起**不直接持有 BashSession**——BashSession 由容器内 `action_execution_server.py` 创建，docker 侧经 **HTTP POST `/execute_action`**（timeout+5，超时抛 `AgentRuntimeTimeoutError`）调用。
- **完整时间线**：pxssh（SSH，2024-04~06，`echo $?` 取退出码）→ pexpect.spawn（2024-08~12，`[PEXPECT_BEGIN/END]` marker）→ libtmux（2025-01 PR #4881 `ec70af941` 起）→ V1 SDK（2026-04 起，tmux 默认/PTY 降级/PowerShell Windows；bash_service 每命令 subprocess 仅浏览器终端）。

### 3.2 完成检测（核心）：PS1 元数据 marker + 轮询，非 sentinel

- **marker 机制**：bash 的 `PROMPT_COMMAND` 把 PS1 设为 `\n###PS1JSON###\n{json}\n###PS1END###\n`，JSON 里是 **shell 变量展开**：`{"pid": "$!", "exit_code": "$?", "username": r"\u", "hostname": r"\h", "working_dir": r"$(pwd)", "py_interpreter_path": ...}` —— **每条命令结束后 shell 渲染 PS1 时自动填入真实值**（退出码 `$?`、pid `$!`、当前目录 `$(pwd)`）。由 `CmdOutputMetadata.from_ps1_match` 解析 JSON（V1 [metadata.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-tools/openhands/tools/terminal/metadata.py)；V0 相同逻辑在 `openhands/events/observation/commands.py`）。
- **完成检测 = 轮询**：`execute()` 循环每 `POLL_INTERVAL=0.5s`（`constants.py`）调用 `read_screen()`（V0 `_get_pane_content` = tmux `capture-pane -J -pS -`；V1 SubprocessTerminal 读 PTY 环形缓冲），正则 `matches_ps1_metadata` 数 PS1 块数。**完成条件有版本差异**：
  - **0.30.0 及早期：单条件**——当前内容以 `###PS1END###` 结尾（endswith）；
  - **V0 末期（2025-04 之后，commit `da7041b5e`/`107789b5a` 引入）与 V1：双条件**——`current_ps1_count > initial_ps1_count`（**新提示符出现**）**或** 当前内容以 `###PS1END###` 结尾（旧提示符滚出屏幕的情况）。V0 代码注释原文："1) Execution completed: Condition 1: A new prompt has appeared... Condition 2: ...the *current* visible pane ends with a prompt"（`bash.py` 646-649 行）。
  - V1 的 PS1 正则用 **negative lookahead 抗嵌套损坏**（命令输出里出现类似 PS1 文本时不被误匹配），PS1 缺失时有降级分支。
- **输出缓冲重置** = `_ready_for_next_command()` → `clear_screen()`：V0 发 `C-l` + `clear-history`（tmux）；V1 SubprocessTerminal 保留最后一个 PS1 块、丢弃其前内容。下次命令从干净屏开始，配合 `prev_output`（`_get_command_output` 用 `raw.removeprefix(self.prev_output)` 去掉上次输出）保证"只拿这次命令的输出"。
- 退出码来自 PS1 JSON 里的 `exit_code:$?`，**不是**单独 `echo $?`（2024 年 pexpect 时代倒是 `sendline('echo $?')` 再 expect，见 `client.py` 2024 版）。
- V1 TmuxTerminal 的 `is_running()` 同样明确："If the screen ends with our PS1 prompt, no command is running"（[tmux_terminal.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-tools/openhands/tools/terminal/terminal/tmux_terminal.py)）。

### 3.3 输出收集与流式回传（V1 双路径并存）

**V1 有两条并行的命令执行路径，机制完全不同**：

- **路径 A：agent 终端工具**（agent 在对话中调用的 `terminal` 工具）= 长驻 tmux/PTY/PowerShell 会话（见 3.1），阻塞式返回最终 Observation，**不是逐行增量流**。输出 = 两个 PS1 marker 之间的内容（`_combine_outputs_between_matches`），配合 buffer 清理 + `prev_output.removeprefix` 三重保证隔离。V1 agent loop 中 `agent._execute_action_event` 同步调 tool，把返回的 `Observation` 包成 `ObservationEvent` 交给 `on_event` 回调，再由 `LocalConversation._on_event` 派发给事件存储/订阅者（前端 SSE）。
- **路径 B：Agent Server `/bash/execute_bash_command`**（[bash_service.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/bash_service.py)，**仅浏览器终端 UI 用**）：每命令 `asyncio.create_subprocess_shell` + `read_stream` 读 chunk（8192 字节）按 `MAX_CONTENT_CHAR_LENGTH` 分块发布 BashOutput 事件（pub/sub + 事件存储轮询）；**完成检测 = `asyncio.wait_for(asyncio.gather(read_stream(stdout), read_stream(stderr), process.wait()), timeout=command.timeout)`** —— 进程退出即完成（L337-349）；输出隔离 = 按 `command_id` 查询（[bash_router.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/bash_router.py)，`order__gt` 支持增量轮询）。**增量分块流（BashOutput、output_order）只存在于这条路径**。
- **截断**：`MAX_CMD_OUTPUT_SIZE = 30000` 字符（`constants.py`），`maybe_truncate` 保留头尾、中间插 `<response clipped>` 通知；配置了 `full_output_save_dir` 时完整输出存文件并提示路径（`truncate.py`）。V0 的 hidden 命令跳过截断。
- **V1 安全层**：`_export_envs` 注入 secret、`_mask_observation` 输出掩码（防 secret 泄漏到模型）、tmux pane pool 崩溃恢复。

### 3.4 超时处理：两级超时，超时后不 kill（终端会话路径）

- **两级超时**（V0 与 V1 相同机制，`terminal_session.py` / `bash.py`）：
  - **no-change 软超时**：默认 30s（V1 `NO_CHANGE_TIMEOUT_SECONDS=30`；V0 action_execution_server 里 env 默认 10）无新输出 → 返回带部分输出的 Observation，状态 `NO_CHANGE_TIMEOUT`，**命令继续在跑**，agent 可发空命令取更多输出、`C-c` 中断；
  - **hard 超时**：`action.timeout`（V1 `TerminalAction.timeout`，无默认值）；V0 默认来自 `SandboxConfig.timeout=120`（`sandbox_config.py` L68），setup 脚本硬编码 600s。
  - **超时后不 kill、不自动发 Ctrl-C**（长驻终端会话里无法 kill 前台进程组；libtmux 时代超时只返回 observation，命令继续跑），返回"命令超时"Observation，suffix 提示用空命令/C-c/timeout 参数。**自动 SIGINT（exit_code=130）是 2024 pexpect 时代的旧行为**（`sendintr()` + `echo $?`），PR #4881 换 libtmux 时已移除。
- **真正 kill 的是浏览器终端路径** `bash_service.py`：超时 → 对进程组 SIGTERM（`os.killpg(os.getpgid(pid), sig)`，让用户 trap 有机会跑）→ 1s 后 SIGKILL，`exit_code=-1`。
- V1 还有 `timeout_policy.py`（`foreground_timeout_rejection_for`）：托管 runtime 有 idle timeout（`OH_RUNTIME_IDLE_TIMEOUT_SECONDS`）时，拒绝超过其 90% 的前台 timeout。

### 3.5 Windows

- **V0**：`openhands/runtime/utils/windows_bash.py` — `WindowsPowershellSession`，用 **pythonnet + .NET PowerShell SDK** 跑 pwsh，job 模型 + 轮询 `_check_active_job`。
- **V1**：`terminal/windows_terminal.py`（`WindowsTerminal`），factory 在 Windows 自动选它；`SubprocessTerminal` 明确 `ImportError` 不支持 Windows（需要 fcntl/pty/select）。主运行路径是 Docker/Linux；V0 容器里是 `su openhands -` 起 bash（`bash.py` initialize）。

### 3.6 tmate：OpenHands 从未使用（纠正此前的错误推断）

- **穷尽扫描零命中**：对 OpenHands 主仓库全部 8122 个 commit 用 `git log -S "tmate"` + 2024 全年 2995 个 commit 逐 commit 全文件 grep + docs/CHANGELOG 全历史扫描，**0 处命中**；software-agent-sdk 同样 0 命中。
- 浏览器终端自 2024-04 起就是 **xterm.js**（`frontend/src/components/terminal/Terminal.tsx`，commit `27246aca7`/`c74332020` "Interactive Terminal"），通过 WebSocket 发 `{action: RUN, args:{command}}` 事件（`terminalService.ts`）。
- **容器侧早期历史**：2024-04~06 是 **pxssh（SSH）** + `echo $?` 取退出码；2024-08 起 **pexpect.spawn** + `[PEXPECT_BEGIN/END]` marker；2025-01 起 libtmux（见 3.1 时间线）。全程与 tmate 无关。
- **结论：OpenHands/OpenDevin 从未在仓库代码里用 tmate**（GitHub issue 讨论区未逐条遍历，标注"未验证"）。tmate 更可能是其他项目（如早期 Claude Code 类工具）的用法。本报告第 1 版中"OpenDevin 早期用 tmate"的推断**已纠正删除**。

---

## 4. Gemini CLI（TypeScript）

来源：仓库 [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)（main 分支，monorepo）；文件：`packages/core/src/services/shellExecutionService.ts`、`packages/core/src/services/executionLifecycleService.ts`、`packages/core/src/tools/shell.ts`、`packages/core/src/utils/getPty.ts`、`packages/core/src/utils/shell-utils.ts`、`packages/core/src/config/config.ts`、`packages/core/src/tools/shellBackgroundTools.ts`、`docs/tools/shell.md`。

### 4.1 执行模型

- 单条命令 = **新起 shell 进程**（`bash -c` / PowerShell `-Command`），无持久 shell 会话。`shellExecutionService.ts` 的 `execute()` 优先 `executeWithPty`（**@lydell/node-pty**，动态 import 于 `getPty.ts`），失败回退 `childProcessFallback`（child_process.spawn，stdio pipe、detached）。
- "interactive shell"（tools.shell.enableInteractiveShell）只是 PTY 模式下可用 `writeToPty` 发输入，不是持久命令会话。

### 4.2 完成检测

- 不用 marker、不用输出静默。child_process 靠 **`child.on('close')`**；PTY 靠 **`pty.onExit`**，再用 `Promise.race([processingChain, abortFired])` 等串行处理队列清空后 finalize（防丢尾输出），最后 `ExecutionLifecycleService.completeWithResult` resolve。

### 4.3 输出收集

- stdout/stderr **合并**（child_process 双 pipe 汇入同一 state.output；PTY 单流）。
- PTY 写入 headless xterm（scrollback **300,000 行**），退出时 `getFullBufferText` 提取；流式上屏节流 1s（`OUTPUT_UPDATE_INTERVAL_MS=1000`，实时缓冲 100k 字符）；child_process 缓冲 **16 MB 上限** + 截断警告；前 4 KB 二进制嗅探。
- 输出按 pid 绑 Map、后台历史按 sessionId 隔离。

### 4.4 超时：inactivity timeout（无输出超时），默认 300 秒

- 非硬超时，是 **inactivity timeout**：默认 300 秒（config.ts `(shellToolInactivityTimeout ?? 300)*1000`；文档 tools.shell.inactivityTimeout 秒）。每次输出事件 resetTimeout；超时 → abort → killProcessGroup → 返回 "exceeded the timeout of X minutes without output"。

### 4.5 Windows / PowerShell

- 完整支持：pwsh.exe 优先（-NoProfile -Command），回退 powershell.exe（-NoProfile -NonInteractive -Command）；**ConPTY**（useConpty:true）；chcp 65001 注入；PowerShell AST -EncodedCommand 解析；Windows 跳过后台 PID trap 包装。

### 4.6 后台化（background processes）

- 无 tmate 式功能。有 `is_background` 后台化：PTY 保持存活，输出写 `<temp>/background-processes/background-<pid>.log`；`list_background_processes`/`read_background_output` 工具按 sessionId 校验 + O_NOFOLLOW + 64 KB 上限读日志；`backgroundCompletionBehavior` inject|notify|silent，inject 时完成输出（截断 5000 字符）注入回对话。

---

## 5. tmux Control Mode 协议（含 %exit 澄清）

来源：tmux man page（[man.archlinux.org/tmux.1](https://man.archlinux.org/man/tmux.1.en)、[man7.org](https://man7.org/linux/man-pages/man1/tmux.1.html)）、tmux 官方源码（[control-notify.c](https://github.com/tmux/tmux/blob/master/control-notify.c)、[client.c](https://github.com/tmux/tmux/blob/master/client.c)、cmd-queue.c、window.c、cmd-wait-for.c）、tmux 官方 [Control-Mode Wiki](https://github.com/tmux/tmux/wiki/Control-Mode)、tmate 源码 [tmate-io/tmate](https://github.com/tmate-io/tmate)、[libtmux Automation patterns](https://libtmux.git-pull.com/topics/automation_patterns/)。

### 5.1 事件清单与 %exit 的准确定义（纠正常见误解）

man page CONTROL MODE 小节定义的通知事件：`%client-detached`、`%client-session-changed`、`%config-error`、`%continue`、`%exit`、`%extended-output`、`%layout-change`、`%message`、`%output`、`%pane-mode-changed`、`%paste-buffer-changed`、`%paste-buffer-deleted`、`%pause`、`%session-changed`、`%session-renamed`、`%session-window-changed`、`%sessions-changed`、`%subscription-changed`、`%unlinked-window-add`、`%unlinked-window-close`、`%unlinked-window-renamed`、`%window-add`、`%window-close`、`%window-pane-changed`、`%window-renamed`。

**%exit 的 man page 原文**：

> `%exit [reason]` — "The tmux client is exiting immediately, either because it is not attached to any session or an error occurred. If present, reason describes why the client exited."

**关键结论：%exit 是「control-mode client 自身退出」事件，不是「命令完成」事件。** 源码 `client.c` 只在 client 退出路径打印 `%exit`；只要 control-mode client 一直挂着（attached 且无错误），%exit 永远不会出现。把 %exit 当"命令完成通知"是常见误解——用户问题中的假设需要纠正。control mode 里真正用于命令完成检测的是 %end/%error（tmux 命令完成）和 %output 流事件（pane 输出）。

### 5.2 %begin/%end 的用途：框定 tmux 命令的输出块

man page 原文：

> "Each command will produce one block of output on standard output. An output block consists of a `%begin` line followed by the output (which may be empty). The output block ends with a `%end` or `%error`."

- %begin/%end/%error 带三个参数：epoch 秒时间、命令编号、flags；"A notification will never occur inside an output block."（源码 `cmd-queue.c` 的 `cmdq_guard` 在每条命令 dispatch 前后发 begin/end/error）。
- **它们框定的是 tmux 命令**（capture-pane、display-message 等）**的输出，不是 pane 里 shell 命令的输出**。shell 命令输出走 %output。所以 %begin…%end 只能同步"tmux 查询命令"的完成（如轮询 `display-message -p` 时靠 %end 知道查询完成）。

### 5.3 命令完成的检测模式（逐条核实）

**a. 监听 %window-close**：可靠。man page new-window 原文："When the shell command completes, the window closes. See the remain-on-exit option to change this behaviour." 注意事项：`remain-on-exit` 开启时窗口不关闭、事件不来；另一个 session 关闭的窗口走 `%unlinked-window-close`；`exit-empty` 只影响 server 生命周期。

**b. remain-on-exit + `#{pane_dead}` 轮询**：format 变量（man page FORMATS）：`pane_dead`="1 if pane is dead"、`pane_dead_signal`、`pane_dead_status`（退出状态，可判成败）、`pane_dead_time`。用 `display-message -p '#{pane_dead}'` 轮询，或 `refresh-client -B` 格式订阅收 `%subscription-changed`（每秒最多一次）。

**c. sentinel（echo __DONE__）+ 解析 %output 流**：社区主流做法，有权威佐证——[libtmux Automation patterns](https://libtmux.git-pull.com/topics/automation_patterns/) 明确推荐："Pair the command with a completion marker and poll until either the marker shows up or the clock runs out"，示例 `send_keys(f'{command}; echo {marker}')`，marker 用 `__DONE__`；同页 "Capturing output between markers" 即用双 marker 界定输出边界。

**d. tmux wait-for 通道**：man page 原文："When used without options, prevents the client from exiting until woken using wait-for -S with the same channel. When -L is used, the channel is locked and any clients that try to lock the same channel are made to wait until the channel is unlocked with wait-for -U." 它是跨客户端/命令的同步原语（阻塞 + 信号），可作为官方构件：命令尾部 `wait-for -S chan`，外部 `wait-for chan` 阻塞等待。注意等待方是 client、有阻塞语义。

**e. %exit 出现场景**：仅当该 control-mode client 进程退出（未 attach、出错、被 detach/kill-server）。不能当命令完成信号。

### 5.4 %output 的流式语义

- **触发时机**：pane 的 pty 每次可读回调即发（源码 `window.c` `window_pane_read_callback` → `control.c` `control_write_output`）——有新输出就发数据块，非行缓冲；不可打印字符与 `\` 转义为八进制（`\r`→`\015`）。
- **默认范围**：Wiki 原文："Any output in any pane in any window in the attached session is sent to the control client." 可用 client flag `no-output` 关闭（man page："the client does not receive pane output in control mode"）。
- **输出边界**：%output 无边界标记，无法区分"本次命令"输出；做法是**双 sentinel 夹取**（起始/结束标记之间的 %output 即本次命令输出），或独立 window + %window-close / pane_dead。

### 5.5 tmate

- **关系**：tmate 是 tmux 的 **fork**（[README](https://github.com/tmate-io/tmate)："Tmate is a fork of tmux. It provides an instant pairing solution."；Debian man page："tmate is a modified version of tmux"）。
- **机制差异**：control mode 与事件协议继承自 tmux（man page 有同结构 CONTROL MODE 小节），但基线较旧（事件子集更少，无 %subscription-changed 等）。tmate 特有：通过 SSH 连接官方服务器 `ssh.tmate.io`（源码 `options-table.c` 默认值）转发会话、生成随机共享链接（可只读）；`tmate -F` 前台/纯远程模式（"if you wish to use tmate only for remote access, run: tmate -F"）；特殊通道 `tmate-ready`（`tmate -S /tmp/tmate.sock wait tmate-ready` 等待环境就绪，源码 `cmd-wait-for.c` 特判）。**web client 不在 tmate 源码内**（无 websocket 代码），浏览器查看是 tmate.io 服务端功能（[opensource.com](https://opensource.com/article/22/6/share-linux-terminal-tmate)）。
- **AI agent 典型场景**：远程 SSH 终端共享（人类远程查看/接管 agent 终端）、`tmate -F` 无交互后台共享、tmate-ready 就绪同步；命令完成检测原语与 tmux 相同。

### 5.6 pipe-pane

man page 原文："Pipe output sent by the program in target-pane to a shell command or vice versa... with -O stdin is connected (so any output in the pane is piped to shell-command)." 常用于把 pane 输出实时管道给外部程序（如 `pipe-pane -o 'cat >>~/output.#I-#P'`），但**不带完成信号**，对完成检测不是主流方案——主流仍是 sentinel + %output、%window-close、pane_dead、wait-for 组合。

---

## 6. 横向对比：四问四答

### 6.1 完成检测机制对比

| 机制 | 谁在用 | 可靠性 | 备注 |
|---|---|---|---|
| **等子进程退出（exit/wait/close/onExit）** | Claude Code、Codex、OpenHands 新版、Gemini CLI | 最高（OS 级保证） | 主流方案的共同答案 |
| **PS1/marker 检测（正则匹配注入的 prompt）** | **OpenHands 终端工具**（V0 BashSession / V1 TmuxTerminal & SubprocessTerminal） | 高，但需防输出含 marker 文本 | PROMPT_COMMAND 注入 PS1 JSON（exit_code/pid/cwd），轮询"新 PS1 出现或屏幕以 PS1END 结尾" |
| **sentinel（echo __DONE__）+ 流解析** | tmux control mode 社区方案（libtmux 推荐） | 高（配合轮询） | %output 无边界，用双 sentinel 夹取 |
| **%window-close / pane_dead 轮询** | tmux control mode | 高 | 受 remain-on-exit 影响 |
| **输出静默窗口（silent period）** | **主流 agent 中不存在**（仅 OpenHands no-change 超时作兜底） | 低（误判风险） | 用户假设里的机制实为常见误解/谣言 |

### 6.2 输出收集：如何保证是"这次命令"的？

- **独立进程方案**（Claude Code / Codex / Gemini / OpenHands 浏览器终端路径）：每次工具调用新起子进程，输出从该进程的管道读，天然无残留。Claude Code 额外用"流式写 working file + 结束回读"避免内存爆掉；Codex 用 HeadTailBuffer 截断。
- **长驻终端方案**（OpenHands 终端工具 / tmux control mode）：输出边界靠 marker——两个注入 PS1 之间的内容（`_combine_outputs_between_matches` + `prev_output.removeprefix` + 清屏）或双 sentinel 之间的 %output。

### 6.3 超时处理：命令不结束怎么办？

| 项目 | 超时默认值 | 超时行为 |
|---|---|---|
| Claude Code | 120s（BASH_DEFAULT_TIMEOUT_MS，可调） | **移到后台**继续跑（sleep/git/复合命令除外，SIGTERM 终止） |
| Codex CLI | 无硬超时；yield_time_ms=10s 先返回一轮 | 返回 session_id 供轮询；取消时才 TERM→KILL 进程组 |
| OpenHands 终端工具 | no-change 30s（软，命令继续跑）+ hard timeout（V0 默认 120s） | 超时**不 kill**，返回部分输出，提示空命令/C-c；浏览器路径 SIGTERM→1s→SIGKILL |
| OpenHands 浏览器终端 | command.timeout（调用方传） | **SIGTERM 进程组 → 1s → SIGKILL**，exit_code=-1 |
| Gemini CLI | inactivity 300s（无输出才计时） | abort → killProcessGroup，报 "exceeded the timeout ... without output" |
| tmux control mode | 无内置 | 外部程序自己管 |

### 6.4 Windows / PowerShell 下的工作方式

- **Claude Code**：Windows 上 Bash 工具走 Git Bash（旧）；v2.1.13+ 原生 PowerShell 工具（pwsh 优先 → powershell.exe 回退，`-NoProfile -ExecutionPolicy Bypass`，不加载 profile，沙箱不支持）。
- **Codex CLI**：一等公民。默认 PowerShell（`-NoProfile -Command`），兜底 cmd.exe（`/c`）；自研 ConPTY 后端（win/conpty.rs + Job Object）；`prefix_powershell_script_with_utf8` 处理编码。
- **Gemini CLI**：pwsh.exe 优先（-NoProfile -Command）、powershell.exe 回退；ConPTY（useConpty:true）；chcp 65001 注入；PowerShell AST -EncodedCommand 解析。
- **OpenHands**：主运行路径是 Docker/Linux（容器内 `su openhands -` 起 bash）；V0 有 `WindowsPowershellSession`（pythonnet + .NET PowerShell SDK，job 模型 + 轮询 `_check_active_job`）；V1 有 `WindowsTerminal`（factory 在 Windows 自动选），`SubprocessTerminal` 明确不支持 Windows（需 fcntl/pty/select）。
- **tmux**：官方不支持原生 Windows（需 WSL/Cygwin）；tmate 同理。Windows 下"终端复用 + 命令完成通知"的对应物是 **ConPTY**（Windows 的伪终端 API，Codex/Gemini 均使用）。

---

## 7. 对实现"AI 终端执行工具"的工程启示（基于以上研究）

1. **完成检测首选"等子进程退出"**：每次命令新起子进程（`spawn` + 进程组），`await exit` / `on('close')` / `child.wait()`——这是所有主流 agent 的答案，OS 级可靠，无解析歧义。
2. **输出隔离靠"新进程 + 独立管道"**：天然保证一次 execute 的输出属于该次命令；大输出用"写文件 + 回读窗口"或"头尾缓冲"防爆内存。
3. **必须做进程组管理**：`start_new_session=True`（Unix）/ Job Object（Windows），超时才能整组 SIGTERM→SIGKILL，避免孤儿进程（OpenHands/Codex 均如此）。
4. **超时策略两派**：①超时"移后台"（Claude Code，体验好但复杂）；②超时"杀进程组 + 返回部分输出"（OpenHands，简单可靠）；Codex 用"先返回一轮 + 轮询句柄"折中。至少要有硬超时兜底，否则一条 `sleep 1000` 会卡死整个 agent。
5. **长驻终端方案需要 marker**：若必须复用持久 shell（tmux/PTY——OpenHands 终端工具就是这样），用注入的 PS1（JSON 元数据含 exit_code/pid/cwd）+ 轮询"新 PS1 出现或屏幕以 PS1END 结尾"，配合清屏 + `prev_output.removeprefix` 界定命令边界；tmux control mode 社区则用双 sentinel（`echo __DONE__`）。这是 OpenHands 与 tmux 社区验证过的做法。
6. **Windows 用 ConPTY**：需要 PTY 语义时 Windows 走 ConPTY（Codex 自研、Gemini 用 node-pty 的 useConpty），PowerShell 用 `-NoProfile -Command` 避免 profile 干扰；OpenHands 在 Windows 用 .NET PowerShell SDK（V0）/专用 WindowsTerminal（V1）。
7. **避免"输出静默窗口"作为完成判定**：误判风险高（命令可能长时间无输出但仍在运行）；只可作为"无输出超时"兜底（OpenHands 的 no-change 30s、Gemini 的 inactivity 300s），且要明确提示模型可以继续等待。

---

## 附：未验证项与局限

- Claude Code 源码闭源（npm bundle），"等待子进程 exit"是从官方文档行为描述 + 社区逆向的强推断，非逐行源码实锤；未发现任何静默窗口证据。
- Codex CLI 研究基于 main 分支 2026-08-27 提交；未运行代码实测。
- OpenHands V0 基于主仓库 git 全历史考古（V0 运行时在 2026-04-24 commit `e86067c15` 被删除）；V1 基于 software-agent-sdk main 分支。
- OpenHands 仓库代码中从未出现 tmate（8122 commit 全历史扫描 0 命中）；但 GitHub issue 讨论未能直接验证（code search 需登录）。
- tmate.io 网页端内部实现（服务端闭源）未验证。
- 各项目版本迭代快，具体默认值（超时秒数、截断大小）以研究时点为准。

## 主要来源汇总

- Claude Code: [tools-reference.md](https://code.claude.com/docs/en/tools-reference.md) · [hooks.md](https://code.claude.com/docs/en/hooks.md) · [env-vars.md](https://code.claude.com/docs/en/env-vars.md) · [sandboxing.md](https://code.claude.com/docs/en/sandboxing.md) · [settings-reference.md](https://code.claude.com/docs/en/settings-reference.md) · issues [#45717](https://github.com/anthropics/claude-code/issues/45717) [#36038](https://github.com/anthropics/claude-code/issues/36038) [#90616](https://github.com/anthropics/claude-code/issues/90616) · [how-claude-code-works](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/main/docs/04-tool-system.md)
- Codex: [openai/codex](https://github.com/openai/codex) 源码 `codex-rs/core/src/{shell.rs, unified_exec/*, tools/handlers/*}`、`codex-rs/utils/pty/src/*`
- OpenHands: [software-agent-sdk bash_service.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/bash_service.py) · [bash_router.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/bash_router.py) · [metadata.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-tools/openhands/tools/terminal/metadata.py) · [tmux_terminal.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-tools/openhands/tools/terminal/terminal/tmux_terminal.py) · V0 [bash.py](https://github.com/All-Hands-AI/OpenHands/blob/0.30.0/openhands/runtime/utils/bash.py)（V0 运行时已于 2026-04-24 commit `e86067c15` 删除）· PR [#4881](https://github.com/OpenHands/OpenHands/pull/4881)（pexpect→libtmux）
- Gemini CLI: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) 源码 `packages/core/src/services/shellExecutionService.ts`、`packages/core/src/tools/shell.ts` 等
- tmux: [tmux.1 man page](https://man.archlinux.org/man/tmux.1.en) · [control-notify.c](https://github.com/tmux/tmux/blob/master/control-notify.c) · [Control-Mode Wiki](https://github.com/tmux/tmux/wiki/Control-Mode) · [libtmux Automation patterns](https://libtmux.git-pull.com/topics/automation_patterns/) · [tmate](https://github.com/tmate-io/tmate) · [opensource.com tmate 介绍](https://opensource.com/article/22/6/share-linux-terminal-tmate)
