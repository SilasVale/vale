# Vale terminal_execute 重构规格（stage-l，Netcatty 式命令包装）

> 目标：修复 Windows PowerShell 5.1 + ConPTY 下 OSC 133 shell 注入失效，
> 导致 terminal_execute 永远等不到 marker、卡满超时、命令排队（"输出乱/卡顿"）。
> 方案：Netcatty 式命令包装 + 纯文本唯一 marker（11 份研究报告共识的最优解）。

## 背景（研究结论）

- 我们的 OSC 133 注入（`function global:Prompt { Write-Host ...}`）失效根因：
  marker 在 `prompt` **返回值之外**（Write-Host 旁路）→ 被 PSReadLine 重绘擦掉/
  位置错乱 → execute 等不到 → 卡满 timeout（d1 实测 `state:"timeout"` @10s 于 50ms 命令）。
- Netcatty（生产验证）：每个命令包一层单行 shell wrapper，打印 `<marker>_S` 和
  `<marker>_E:<exitcode>` 纯文本标记，在原始字节流里字符串匹配。不依赖 shell 钩子、
  不依赖 OSC 透传（ConPTY 渲染后 VT 流对 OSC 有截断/错位历史 bug）。
- 主流 agent（Claude Code/Codex/Gemini）= 每命令独立子进程等退出——Vale 不能用
  （"看 AI 干活"要求同屏会话）。OpenHands = 长驻会话 + PS1 元数据注入 + 轮询，
  与我们类似但注入点同样脆弱。Netcatty 是唯一"长驻会话 + 可靠完成检测"的成熟方案。

## 已完成的代码（勿重复实现）

`agent/src/plugins/terminal/tools.rs` 已添加：
- `new_exec_marker()` → `__VALE_<time36>_<128bit-hex>__`
- `WrapShell` enum：PowerShell / Cmd / Bash / Fish
- `wrap_execute_command(command, shell, marker)` → 单行 wrapper（无尾部换行）
- `find_exec_start_marker(data, marker)` → START 行后的偏移
- `find_exec_end_marker(data, marker, allow_inline)` → (start, end, exit_code)
- `strip_exec_markers(output, marker)` → 剥 marker 行
- `find_prompt_marker` 已标记为 LEGACY

## 待实施改动

### 1. `agent/src/tools/terminal/mod.rs`
- `Session` struct 加 `shell: String`（"powershell"|"cmd"|"bash"|"fish"|"unknown"）
- `TermSessionInfo` 加 `pub shell: String`
- `term_open` 创建 Session 时推断 shell：
  - Windows pty：target 空或 powershell.exe/pwsh.exe → "powershell"；
    cmd.exe → "cmd"；其他 → "unknown"
  - Unix pty：target 空或 bash/sh → "bash"；fish → "fish"；其他 → "unknown"
  - ssh：先默认 "unknown"（见第 4 点探测）
  - serial：不适用（无 shell）→ "unknown"
- `term_info` 返回 shell 字段
- stub.rs 对应同步（TermSessionInfo 构造处）

### 2. `agent/src/plugins/terminal/tools.rs` — tool_execute 前台路径
- 写入前：`let shell = term_info(&sid).shell` → `WrapShell`
- `let wrapped = wrap_execute_command(&command, shell, &marker)`（marker 每次 execute 生成）
- `let cmd_with_nl = append_command_newline(&wrapped);`（wrapper + 平台换行）
- 替换原 `cmd_with_nl` 写入（保持 busy 锁、first-prompt gate、settle-drain 逻辑不变，
  但 first-prompt gate 不再依赖 OSC marker——改为等 wrapper 能执行即可，
  或直接保留 gate 但检测改为 find_exec_start_marker）
- 等待循环：替换 `find_prompt_marker(&pending)` 检测为：
  - 未确认 START：`find_exec_start_marker(&pending, &marker)` → 确认后丢弃 pre-start
  - 已确认 START：`find_exec_end_marker(&pending, &marker, true)` → (start,end,code)
    → result = 已收集输出（到 end 前），exit_code = code，break
- 加 **启动超时**：等不到 START marker 超过 N 秒（如 15s）→ 明确失败
  "start marker never arrived"（Netcatty 关键：报错而非挂死）
- 返回文本用 `strip_exec_markers` 剥离 marker 行
- `marker_injected` 语义替换：不再需要（包装不依赖注入）。保留 quiet 兜底
  作为 marker 缺失时的 fallback（但 wrapper 应总产生 marker）

### 3. `agent/src/plugins/terminal/tools.rs` — tool_execute 后台路径（run_in_background）
- 同样包装命令 + 生成 marker
- 后台 spawn 的等待循环同样改用新 marker 检测（`find_exec_end_marker`）
- job 完成时记录 exit_code

### 4. SSH shell 探测（可选，低优先）
- SSH 会话首次 execute 时如果 shell=="unknown"，发 `echo __VALE_SHELL__` 探测？
  Netcatty 用独立 exec channel 探测（Windows OpenSSH 查注册表）。Vale 可简化：
  SSH 会话默认按 "powershell" 处理（Windows 目标）或加一个 `shell` 参数覆盖。
  首版可先默认 unknown → 用 quiet 兜底（不包装），后续迭代加探测。

### 5. 测试
- `wrap_execute_command` 单测：四种 shell 的 wrapper 文本断言
- `find_exec_end_marker`：跨 chunk、行首边界、inline、假阳性
- `find_exec_start_marker`：整行匹配
- `strip_exec_markers`：剥 marker 行保留其他
- 现有 `find_prompt_marker` 测试保留（LEGACY）

### 6. 兼容性
- `inject_marker` 参数保留（默认 true）但语义变为"是否用命令包装"——向后兼容
- `term_marker_injected` / `term_set_marker_injected` 保留（内部不再依赖注入，
  或直接废弃——看调用点）

## 验证

- `cargo test --features terminal` 全绿
- `cargo clippy --features terminal --all-targets` 0 警告
- `cargo xwin check -p vale-agent --target x86_64-pc-windows-msvc --features terminal,keyring`
- d1 实测：execute 简单命令应 <2s 返回且带 exit_code，不再卡 timeout
