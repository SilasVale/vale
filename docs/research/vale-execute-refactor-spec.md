# Vale terminal_execute 重构规格（stage-m，VS Code OSC 633 shell integration）

> 状态：**已实施**（设备 d1 1.2.149 验证通过）。stage-l 的 Netcatty 式命令包装
> 已整体移除（见 `git log 5aaad088`）。本文记录最终方案 + 关键决策，供后续维护参考。

## 目标

修复 Windows 终端会话的显示与完成检测问题（`>>` 续行符、wrapper 回显噪声、
完成检测不可靠），方案对齐 **VS Code shell integration（OSC 633）**——用户
明确要求"用 VS Code 的方案，不要自己发明"。

## 最终架构（三部分）

```
┌─ 注入端（Rust, pty.rs）─────────────────────────────┐
│ pwsh spawn: -NoExit -Command "try { . "<install>/   │
│   shell-integration/shellIntegration.ps1" } catch {}"│
│ env: VALE_NONCE=<128-bit>（信任锚点）                │
│ 仅 pwsh（PowerShell 7）；5.1 不支持（见决策 1）       │
└──────────────────────────────────────────────────────┘
        │  shell 进程内发 OSC 633（不可见序列）
        ▼
┌─ 脚本（resources/shell-integration/shellIntegration.ps1）─┐
│ 移植自 microsoft/vscode@main shellIntegration.ps1：       │
│   Prompt → 633;A（提示符始）/633;D[;rc]（完成+退出码）     │
│   PSConsoleHostReadLine 包装 → 633;E;cmd;nonce / 633;C     │
│ 序列在终端不渲染 → 用户屏幕天然干净，前端零过滤            │
└────────────────────────────────────────────────────────────┘
        │  原始字节流
        ▼
┌─ 消费端（Rust, shell_integration.rs）──────────────────┐
│ find_finished(data) → 633;D[;rc] 解析（跨 chunk）      │
│ find_prompt_started(data) → 633;A（first-prompt gate） │
│ execute：写命令后等 633;D → wait_reason="marker"       │
└────────────────────────────────────────────────────────┘
```

## 关键决策（含实测证据）

1. **只用 pwsh（PowerShell 7），不支持 Windows PowerShell 5.1**
   - 5.1 的 PSReadLine 2.0.0 把注入的 OSC 序列当输入回显 → 每个提示符后 `>>`
   （VS Code 同病：microsoft/vscode#236841，关闭为 duplicate）
   - 设备装 pwsh 7.6.5（zip 解压到 `C:\Program Files\PowerShell\7\`，ghfast.top 加速下载）
   - `infer_shell` 区分 `pwsh`（633 路径）与 `powershell`（quiet 路径）

2. **命令结尾用 `\r`（不是 `\r\n`）—— `>>` 的真正根因**
   - 实测：`\r\n` 被 ConPTY 读成**两个输入事件**（CR + LF），PSReadLine 渲染空续行 `>>`
   - VS Code sendText 语义（`\n→\r`、追加 `\r`）；`append_command_newline` Windows 分支改为 `\r`

3. **ConPTY flags 对齐 node-pty（portable-pty vendored）**
   - portable-pty 原本 `RESIZE_QUIRK | WIN32_INPUT_MODE`；node-pty 只用 `0|INHERIT_CURSOR`
   - 去掉 `WIN32_INPUT_MODE`（0x4）—— 它把控制台输出回传为 Win32 输入事件
   - 命名管道方案（对齐 node-pty CreateNamedPipesAndPseudoConsole）试验过：
     解决不了 `>>`（根因是 `\r\n`），且引入回显重叠 → **回退匿名管道**
   - vendored 方式：`[patch.crates-io] portable-pty = { path = "vendor-portable-pty" }`

4. **执行完成检测 = 633;D[;rc]**（`shell_integration.rs`）
   - execute 不再包 wrapper，直接写原始命令
   - 等待循环扫 `find_finished` → `wait_reason="marker"` + exit_code（实测生效）
   - 非 633 会话（ssh/serial/unknown）保留 quiet-period 兜底

5. **agent 生命周期下沉 Rust（Chrome-OOM 根因修复）**
   - agent `fatal()` 支持 `VALE_NO_PAUSE`：bind 失败立即退出（不挂 "Press Enter"）
   - electron 壳不再 spawn agent（`schtasks /run ValeAgent` 是唯一拉起路径）
   - electron 加单实例锁（`app.requestSingleInstanceLock`）
   - 脚本 boot 时写入 `install_dir/shell-integration/`（include_str! 内嵌）

6. **前端零过滤**（wrapperFilter.ts 删除）
   - OSC 序列 xterm.js 天然不渲染；`TerminalPane` 直接写原始字节
   - stage-l 的 discard-mode filter 及其 10 个测试全删

## 已删除（stage-l 遗留，git 可追溯）

- `wrap_execute_command` / `find_exec_start_marker` / `find_exec_end_marker` /
  `strip_exec_markers` / `WrapShell` / `ps_single_quote` / `sh_single_quote` /
  `cmd_escape` / `new_exec_marker`（~220 行 + 31 个测试）
- `wrapperFilter.ts` + 测试（前端）
- pty.rs 的 `Remove-Module PSReadLine`（round-162 遗留——拆 VS Code 方案的根基）
- electron main.js 的 spawn/waitReady/portBusy/agentExe（下沉 Rust）

## 保留（quiet 兜底路径）

- `find_prompt_marker`（LEGACY OSC 133 扫描，非 633 会话用）
- `append_command_newline`（`\r` Windows / `\n` Unix）

## 验证

- `cargo test --features terminal,keyring` 110 通过
- `cargo clippy --features terminal,keyring --all-targets` 0 警告（本仓库代码）
- `cargo xwin check` 通过
- d1 实测（1.2.149）：
  - 新 pty = pwsh 7.6.5，提示符干净，**无 `>>`**
  - execute 返回 `wait_reason:"marker"`（633;D 消费），`state:"done"`
  - 面板（xterm.js）显示干净：命令回显完整、输出正常、无 wrapper 噪声
  - electron 单实例（4 进程一套）+ 单 agent（无孤儿）
