# Netcatty `terminal_execute` Marker 机制研究报告

> 目标：研究 Netcatty（binaricat/Netcatty, Electron + React + xterm.js SSH 终端工作台）MCP 工具 `terminal_execute` 的"唯一 marker 检测命令结束与 exit code"实现，为 Vale 修复"Windows PowerShell 5.1 + ConPTY 下 OSC 133:D shell 注入失效导致 execute 永远等不到 marker"提供参考。
>
> 全部结论均基于 GitHub 主分支（`main`）源码，文件位置与行号见各节引用。拉取时间：2026-09（commit 对应 main 当前 HEAD）。

---

## 0. 结论速览（TL;DR）

Netcatty **不用 OSC 序列**（不用 OSC 133:D 之类 shell 集成序列），而是**向 PTY 键入一段"包装命令"（wrapped command）**：每次执行生成一个**随机唯一 marker**（`__NCMCP_<time36>_<hex>__`），把用户命令用 eval 包进一段单行 shell 代码，命令前后分别打印 `marker_S`（开始）和 `marker_E:<exitcode>`（结束），然后**在原始字节流里做字符串匹配**（不做 ANSI 解析、不做 OSC 解析），命中 `marker_E:<数字>` 即判定完成并拿到 exit code。

对 Vale 最有参考价值的五点：

1. **Marker 是普通文本行，不是 OSC 序列** —— 它在 ConPTY/PowerShell 5.1 下同样走 PTY 回显路径，不依赖终端模拟器转发控制序列，因此不会出现"OSC 被 ConPTY 吞掉"类失效。
2. **PowerShell 包装用 `Write-Output '<marker>_S'` + `Invoke-Expression` + `$LASTEXITCODE`** —— 关键细节：先 `$LASTEXITCODE=$null` 再执行，用 `if ($LASTEXITCODE -ne $null) {...} elseif ($?) {...}` 区分原生程序退出码与 cmdlet 成败；`catch { rc=1 }` 兜底。**末尾必须有 `\r\n`**（代码里显式 `\r\n`）。
3. **Shell 种类选择是"确认值 + 软提示 + 活体 prompt 覆盖"三层机制**：本地 shell 由可执行路径静态分类；远程 SSH 首次执行前用**独立的不可见 SSH exec channel 静默探测登录 shell**（Unix 用 `getent passwd` 打标记输出路径；Windows OpenSSH 用 `cmd.exe reg query HKLM\SOFTWARE\OpenSSH /v DefaultShell`，见 `electron/bridges/ai/sessionShellKind.cjs`）；探测结果只作为软提示，**活体 prompt（`PS ...>` / `C:\...>` / `user@host:~$`）在 shellKind 未确认时优先**，防止把 PowerShell 包成 bash 导致"挂等 marker"。这正是 Vale 场景（Windows PowerShell 5.1）的针对性方案。
4. **完成判定是纯文本 `findEndMarker`**：搜索 `<marker>_E:` 后跟数字；在 start marker 确认**之前**要求行首边界（防回声误判），确认后允许 inline。字符分块跨 chunk 用 carry 拼接；UTF-8 用 StringDecoder。
5. **等待逻辑不是"等 marker 出现就结束"**：marker 出现即结束（截到 `_E:` 前），另有 60s 默认无输出超时、start marker 启动超时（后台任务固定 30s）、可选墙钟超时（MCP 前台强制开启），以及 **prompt 后缀兜底**（等 marker 期间若看到期望的 idle prompt 且 250ms 后仍在，则视为完成）。

完整方案见下文，每个机制都附源码位置与关键文本。

---

## 1. 文件地图（marker 相关核心文件）

| 文件 | 角色 |
|---|---|
| `electron/bridges/ai/ptyExec.cjs` | 统一 PTY/SSH 执行引擎：`startPtyJob` / `execViaPty` / `execViaChannel` / `execViaRawPty`；marker 生成、写入、匹配、超时、取消 |
| `electron/bridges/ai/ptyExecHelpers.cjs` | `buildWrappedCommand`（**marker 注入方案本体**）、`findEndMarker`、`normalizePtyOutput`、`resolveEffectiveShellKind`、`buildPendingInputClearPrefix` |
| `electron/bridges/ai/sessionShellKind.cjs` | 远程登录 shell 探测（Unix / Windows OpenSSH 两条路径）、软提示应用 |
| `electron/bridges/ai/shellUtils.cjs` | idle prompt 提取/追踪（`trackSessionIdlePrompt` / `getFreshIdlePrompt`）、prompt 形态判定 |
| `electron/bridges/mcpServerBridge/execHandlers.cjs` | MCP `terminal.execute`（= `terminal_execute`）与 `terminal.start` 的处理器：会话查找、安全拦截、执行锁、路由到 PTY / SSH channel / raw |
| `electron/bridges/mcpServerBridge/backgroundJobs.cjs` | `terminal_start` 的 job 登记、poll 序列化（offset 窗口）、stop/取消、保留期清理 |
| `electron/bridges/boundedSshExec.cjs` | 带边界（open/run 超时、输出字节上限）的 SSH exec channel 执行器 |
| `electron/terminalWorker/aiExec.cjs` | terminal worker 里的 AI 执行处理器（IPC `netcatty:ai:exec/jobStart/jobPoll/jobStop`），与 MCP bridge 共享 `ptyExec` |
| `electron/capabilities/catalog/terminal.cjs` | 能力清单：`terminal.execute/start/poll/stop` → rpcMethod `netcatty/exec` 等 + mcpTool 名 `terminal_execute` 等 |
| `electron/capabilities/codegen/mcpToolRegistry.cjs` | MCP 工具注册与结果格式化 |
| `electron/capabilities/schemas/toolInputs.cjs` | 工具入参 schema + 模型提示（"60 秒以内用 terminal_execute"） |
| `electron/bridges/mcpServerBridge.cjs` | MCP server bridge 主文件：RPC 分发、`commandTimeoutMs` 配置、worker 转发 |
| `electron/bridges/ai/ptyExec.test.cjs` | marker 行为测试（含 PowerShell/cmd wrapper 断言） |

> 注意：仓库里还有 `electron/bridges/ai/ptyExec.cjs` 与 `electron/terminalWorker/aiExec.cjs` 两套相近实现。MCP server bridge（`mcpServerBridge.cjs`）通过 `terminalWorkerManager.request("netcatty:ai:exec", ...)` 转发到 terminal worker，由 `electron/terminalWorker/aiExec.cjs` 的 `createWorkerAiExecHandler` 执行，最终都调用同一份 `ptyExec.cjs`。**marker 机制完全相同**（worker 路径多一个 `stripMarkers: true`，即从返回 stdout 中剥掉 marker 行）。

---

## 2. marker 注入方案（重点）

### 2.1 注入方式：**键入包装命令**（shell 注入），不是 OSC 序列

`electron/bridges/ai/ptyExec.cjs:585-586`：

```js
const wrapped = buildWrappedCommand(command, resolvedShellKind, marker);
ptyStream.write(`${buildPendingInputClearPrefix(resolvedShellKind)}${wrapped}`);
```

- 先写一个"清空未提交输入"的前缀（防半行输入拼接到注入命令上，issue #2962），再写整段包装命令（**以换行结尾，模拟回车**）。PowerShell 的清除前缀是 `\x1b\x15\x0b`（ESC + Ctrl+U + Ctrl+K，PSReadLine 的 Escape/RevertLine），见 `ptyExecHelpers.cjs:184-197`。
- 之后完全依赖 PTY 回显的原始字节流匹配，**没有任何 OSC/控制序列解析**。

### 2.2 marker 文本格式

`ptyExec.cjs:56`：

```js
const marker = `__NCMCP_${Date.now().toString(36)}_${crypto.randomBytes(16).toString('hex')}__`;
```

每次 `startPtyJob` 生成一次；时间戳 base36 + 128 位随机数，**每次调用唯一**。同类变体：
- SSH exec channel 兜底：`__NCMCP_CH_<time36>_<hex>__`（`ptyExec.cjs:719`）
- channel 打开前的 pending 取消标记：`__NCMCP_CH_PENDING_...__`（`ptyExec.cjs:656`）
- shell probe 的 pending 标记：`__NCMCP_SK_PENDING_...__`（`sessionShellKind.cjs:408`）
- serial/raw：不发 marker，`__NCRAW_<time36>_<seq>__` 仅作取消 map 的 key（`ptyExec.cjs:860`）

marker 之后追加两种后缀：
- **开始标记**：`${marker}_S`（start）
- **结束标记**：`${marker}_E:<exitcode>`（end + exit code）

### 2.3 各 shell 的包装命令（`ptyExecHelpers.cjs:buildWrappedCommand`, L210-288）

#### POSIX / bash / zsh（L199-208, L240-286）

```sh
 __NCMCP_xxx=0; __NCMCP_xxx_cmd='<单引号转义后的命令>'; { printf '%s\n' '__NCMCP_xxx_S'; trap ':' INT; ( PAGER=cat SYSTEMD_PAGER= GIT_PAGER=cat LESS= eval "$__NCMCP_xxx_cmd" ); __NCMCP_rc=$?; trap - INT; printf '%s\n' '__NCMCP_xxx_E:'"$__NCMCP_rc"; (exit $__NCMCP_rc); }
```

设计要点（源码注释 L242-285）：
- **最前面放 `__NCMCP_xxx=0`**：确保 PTY 回声行的头几个字节就含 `__NCMCP_`，配合 preload 的 chunk 过滤（缓冲含 `__NCMCP_` 的不完整行）避免长命令行回声泄漏成终端垃圾。
- **命令经 `eval "$marker_cmd"` 执行**：shell 语法错误也留在 eval 内部，包装器仍能打出 `_E:` 并返回非零码。
- **整段是单行 `{ ... }` 复合命令**：解析一次性完成，SIGINT 不会让 bash 把 end marker 从输入缓冲里冲掉；`trap ':' INT` 让子进程正常收 SIGINT 而 shell 不中断复合命令。
- **eval 跑在子 shell `( ... )` 里**：`set -e`/`exit`/trap/函数定义等只影响子 shell，不炸掉用户的登录 shell（issue #1850）；副作用是 `cd`/`export` 不跨命令持久，工具描述里明确告知模型（见 §7）。
- **行首一个空格**：让开了 `HISTCONTROL=ignorespace`（Debian/Ubuntu 默认）/`HIST_IGNORE_SPACE`（zsh）的会话不把包装命令记进历史。
- 多行命令用 `printf '%s\n' '<逐行单引号转义>'` 拼进 `_cmd` 变量，**保证注入后仍是单物理行**（测试断言 `wrapped.indexOf("\n") === wrapped.length - 1`，即整段除末尾换行外无换行，防 PS2 `>` 续行回声泄漏，`ptyExec.test.cjs:405-422`）。

#### PowerShell（L212-218）—— Vale 最相关

```powershell
$__NCMCP_xxx=0; $__NCMCP_xxx_cmd='<单引号转义(''加倍)后的命令>'; & { Write-Output '__NCMCP_xxx_S'; $env:PAGER='cat'; $env:SYSTEMD_PAGER=''; $env:GIT_PAGER='cat'; $env:LESS=''; $LASTEXITCODE=$null; try { Invoke-Expression $__NCMCP_xxx_cmd; $__NCMCP_xxx_rc = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 } } catch { $__NCMCP_xxx_rc = 1 }; Write-Output "__NCMCP_xxx_E:$__NCMCP_xxx_rc" }\r\n
```

逐点拆解：
- 用户命令单引号包裹、内部 `'` 双写（`escapePowerShellSingleQuoted`, L72-74）——PowerShell 单引号字符串的转义方式。
- `& { ... }` 脚本块调用；`Write-Output '<marker>_S'` 打印开始标记。
- **`$LASTEXITCODE=$null` 先清空**，再 `Invoke-Expression`：这样能区分"运行了原生 exe"（`$LASTEXITCODE` 有值）与"纯 cmdlet/表达式"（用 `$?` 布尔判断成功与否），是 PowerShell 拿退出码的正确姿势（原生 exe 失败不会抛异常、`$?` 仍为 true 的坑被绕开）。
- `catch { rc=1 }` 兜底（终止性错误）。
- **字符串以 `\r\n` 结尾**（源码里显式 `\r\n`，POSIX 分支是 `\n`）——PowerShell 5.1/ConPTY 下回车换行缺一不可，这是本方案在 Windows 下能成立的一个直接细节。
- `$marker=0; $marker_cmd='...'` 的赋值本身也把 marker 带进回声首行。

#### cmd.exe（L220-225）

```bat
set "__NCMCP_xxx=0" & set "__NCMCP_xxx_CMD=<"转义: "" 与 %%>" & (echo __NCMCP_xxx_S & set "PAGER=cat" & set "SYSTEMD_PAGER=" & set "GIT_PAGER=cat" & set "LESS=" & call cmd /d /s /c "%__NCMCP_xxx_CMD%" & call echo __NCMCP_xxx_E:^%errorlevel%)\r\n
```

- 命令内 `"` 双写、`%` 双写（`escapeCmdForNestedShell`, L80-82），用 `call cmd /d /s /c` 跑嵌套 cmd 以取 `errorlevel`（`^%errorlevel%` 防过早展开），退出码用 `call echo __NCMCP_xxx_E:^%errorlevel%`。
- 注意测试断言：`%__NCMCP_xxx_CMD%` 是**交互式展开**（非 `%%...%%` 批处理展开），因为这段是键入到交互 shell 而非批处理文件（`ptyExec.test.cjs:377-381`）。

#### fish（L227-238）

```fish
 set __NCMCP_xxx 0; function __ncmcp_int --on-signal INT; printf '%s\n' '__NCMCP_xxx_E:130'; functions -e __ncmcp_int; end; set -l __NCMCP_xxx_cmd '<转义>'; begin; set -gx PAGER cat; ...; printf '%s\n' '__NCMCP_xxx_S'; eval $__NCMCP_xxx_cmd; set __NCMCP_rc $status; functions -e __ncmcp_int; printf '%s\n' '__NCMCP_xxx_E:'$__NCMCP_rc; end
```

fish 特有：`--on-signal INT` 事件函数在 Ctrl+C 时打 `_E:130`。

### 2.4 "防混淆"设计：怎么保证用户输出不误触发

1. **128 位随机 marker**：用户输出几乎不可能恰好包含完整 `<marker>_E:<数字>`。
2. **开始标记前的行首边界要求**（`findEndMarker`, `ptyExecHelpers.cjs:290-312`）：
   - start 确认**前**（allowInline=false 或未 foundStart）：`_E:` 必须出现在行首（前一个字符是 `\n`/`\r` 或文本开头），否则跳过继续找——回声中的包装命令自身（含 `marker_E:` 文本）不会被误判为完成。
   - start 确认**后**（allowInline=true）：允许 marker 跟在无换行的输出后面（命令输出不一定以换行结尾，测试 `printf 'abc'` 无尾换行仍能完成）。
3. **剥 marker 行时用"本 job 的 marker"而非通用前缀**：`stripJobMarkerLines` / `normalizePtyOutput` 只剥含本 marker 的行（`ptyExec.cjs:32-37, 294-299`），用户自己 `printf '__NCMCP_demo\n'` 之类的输出保留。
4. **分块 carry**：`visibleMarkerCarry` 只扣留"含 `__NCMCP_` 前缀且无换行结尾"的尾部（`ptyExec.cjs:269-299`），防止 marker 恰被 PTY 数据块边界劈开而漏匹配（测试 `ptyExec.test.cjs:72-97` 验证 marker 拆两半 + UTF-8 拆两半）。
5. **start marker 匹配是整行相等**：`stripAnsi(line).trim() === startMarker`（`ptyExec.cjs:435`），且回显的包装命令行会被"取最后一个 `_S` 出现位置"逻辑跳过（L443-462）。

### 2.5 PowerShell 包装的完整匹配流程（Vale 修复的直接参照）

1. 写入 `\x1b\x15\x0b` + 包装命令（含 `\r\n`）。
2. 流式 `onData` 在 foundStart 前累积 `preStartOutput` + `pendingStart`（跨 chunk 拼接）。
3. 逐行 `stripAnsi(line).trim() === '<marker>_S'` 命中 → foundStart=true，清空 pre-start 缓冲，从**最后一个** `_S` 行之后开始记 output（跳过回显），随后 `schedulePromptFallback()` + `checkEnd()`。
4. 之后每次数据到达都 `checkEnd()`：`findEndMarker(output, marker, { allowInline: true })` 找 `<marker>_E:<数字>`，命中即 `finish(stdout, exitCode)`——**stdout 截到 `_E:` 前，exitCode 来自 marker 内嵌数字**。
5. 输出清理：`normalizePtyOutput`（剥 ANSI、剥 marker 行、剥尾部 prompt、可选 trim）。

---

## 3. exit code 捕获

- **PTY 路径**：exit code **内嵌在 end marker 里**——`<marker>_E:<code>`，`findEndMarker` 用 `/^(\d+)/` 从 `_E:` 后取数字（`ptyExecHelpers.cjs:302-307`）；取不到数字则不算完成，继续找。`finish` 里 `ok = exitCode === 0 || exitCode === null`（`ptyExec.cjs:404`）。
- **SSH exec channel 路径（`execViaChannel`）**：不用 marker，直接靠 ssh2 exec stream 的 `close` 事件回调的退出码参数：`stream.on("close", (code) => ...)`，`code == null`（SSH 断开/信号终止）报错，否则 `exitCode = code`（`ptyExec.cjs:784-791`）。
- **raw/serial 路径**：厂商 CLI 无退出码概念，恒为 `null`（`ptyExec.cjs:838, 917`）。
- **取消**：`requestCancel` 后若在 marker 前命中 prompt 则 `finish(preStartOutput, 130, "Cancelled")`（SIGINT 语义 130）。

---

## 4. 等待逻辑与超时（`ptyExec.cjs`）

`startPtyJob` 内部四个计时器 + 一个 prompt 兜底：

| 机制 | 默认 | 触发动作 | 源码 |
|---|---|---|---|
| `armOutputTimeout` 无输出超时 | `timeoutMs`（MCP 前台默认 60s，配置见 §7） | 每次 onData 重置；到点先 `ptyStream.signal("INT")` + 写 `\x03`，`finish(..., -1, "Command timed out after Ns without output")` | L110-121 |
| `armWallTimeout` 墙钟超时 | 仅 `enforceWallTimeout: true` 时启用（MCP terminal_execute 开启；Catty 前台不开，靠无输出超时支持长流式命令） | 到点同样中断 + `finish(..., "Command timed out (Ns)")` | L123-136 |
| `armStartupTimeout` 启动超时 | 前台 = timeoutMs；后台 job（maxBufferedChars>0）固定 30s | "start marker never arrived" → 失败；防 chatty PTY（如 `tail -f`）让 onData 无限重臂无输出计时器 | L138-154 |
| 取消墙钟 | 取消重试 5s，强制 30s | `requestCancel`：立即 `sendInterrupt()`，之后每 5s 重发；30s 后强制 `finish(..., 130, "Cancelled (forced — process may still be running)")` | L162-219 |
| `schedulePromptFallback` prompt 兜底 | 前台 250ms / 后台 30s | 检测到输出尾部 = 期望 idle prompt 后延时再确认（防子 shell/REPL 同 prompt 误判），仍在则 `finish(output, null, null)`（exitCode 为 null → ok:true） | L221-233 |

注意：**prompt 兜底是"等 marker 失败"时的第二完成信号**，但它要求 `expectedPrompt`（来自 `getFreshIdlePrompt`，见 §6）。对 Windows PowerShell 场景，Netcatty 的兜底依赖 `isDefaultPowerShellPromptLine` 匹配到 `PS ...>` 形态的 idle prompt。

`checkEnd()` 是主完成判定（L235-240）：`findEndMarker` 命中即 finish，**不等 PTY 空闲、不等更多输出**。

---

## 5. terminal_start / terminal_poll / terminal_stop 的 job 化

### 5.1 三个工具（`catalog/terminal.cjs`）

- `terminal.execute` → rpc `netcatty/exec` / 公开 `public/terminalExecute`；policy: longRunning、requiresChatSession、默认不绕过审批与 chat 取消。
- `terminal.start` → `netcatty/jobStart`：**长命令**；同样要审批。
- `terminal.poll` → `netcatty/jobPoll`：只读，`bypassesApproval: true`、`bypassesChatCancel: true`。
- `terminal.stop` → `netcatty/jobStop`：**stop 绕过审批与 chat 取消**（注释：否则失控的 terminal_start 无法打断，`mcpServerBridge.cjs:1906-1908`）。

模型提示（`schemas/toolInputs.cjs:379-384`）：`terminal_execute` 只用于 **60 秒内能完成的命令**；`terminal_start/poll/stop` 用于构建、扫描、日志跟随等；poll 间隔建议 ≥30s。

### 5.2 job 生命周期（`execHandlers.cjs` + `backgroundJobs.cjs` + worker 版）

1. **`handleJobStart`**（`execHandlers.cjs:203-376`）：`jobId = job_<time36>_<6字节hex>`（`backgroundJobs.cjs:18-20`）；**先往 `backgroundJobs` Map 登记 job（status:"running", pendingShellProbe:true）再探测 shell**，保证探测期间 chat cancel 也能看到它（Codex P2 #2061）；随后 `ensureSessionShellKind(session)` 探测，探测完 `startPtyJob(..., maxBufferedChars: 256KB, normalizeFinalOutput: false)`。**故意不注册进 activePtyExecs**：terminal_start 任务设计为在 SDK Stop 后继续存活，模型可停止轮询而不中断长构建；取消走 `terminal_stop` + 会话执行锁。
2. **`resultPromise.then`**（L315-355）：按结果把 job 置为 `cancelled` / `failed`（含非零退出码 → `failed`, error=`Command exited with code N`）/ `completed`，并 `storeCompletedJobOutput` 冻结输出快照、释放执行锁。
3. **`handleJobPoll`**（L392-405）：`serializeBackgroundJob(job, offset)`（`backgroundJobs.cjs:262-291`）：运行中 job 实时 `getSnapshot()`；输出按 **offset 窗口** 增量返回——`output.slice(relativeOffset)`，`nextOffset = totalOutputChars`，超 256KB 窗口时 `outputBaseOffset` 前进并 `outputTruncated: true`（轮询偏移保持单调，见 `ptyExec.cjs:70-74` 的 high-watermark 设计）；`\r` 进度条重绘在序列化时折叠成最新帧（`collapseCarriageReturns`，L237-260）。
4. **`handleJobStop`**（L407-435）：status → "stopping" + `handle.cancel()`（触发 §4 的取消序列），返回当前快照。
5. **保留期**：`pruneCompletedBackgroundJobs` 删除 completed 超过 `BACKGROUND_JOB_RETENTION_MS`（10 分钟）的 job（`backgroundJobs.cjs:220-228`）。
6. **作用域隔离**：`getScopedJob` 强制 job.chatSessionId 与调用者一致（L378-390）；`scopedSessionIds` 静态作用域另查（L400-403, 419-423）。worker 版（`aiExec.cjs`）逻辑相同，另维护 `activeSessionJobs`（每会话最多一个 job）与 `workerBackgroundJobs`（主进程侧镜像，poll 到 completed 即删，`mcpServerBridge.cjs:1689-1722`）。
7. **会话执行锁**：`reserveSessionExecution` / `releaseSessionExecution`（`backgroundJobs.cjs:307-324`）保证同一终端会话同一时刻只有一个 exec 或 job；`beginChatExecution`（`mcpServerBridge.cjs` 层）保证同一 chat 会话串行。

---

## 6. SSH 场景：shell 探测 + exec channel 兜底

### 6.1 远程 shell 探测（`sessionShellKind.cjs`）—— 防止"往 PowerShell 里敲 bash 包装"

- **Unix**（L82-89）：`exec sh -c 'SH="$(getent passwd "$(id -un)" ...)"; printf "__NETCATTY_SHELL_KIND__:%s\n" "$SH"'`，用独立 SSH exec channel 静默跑，输出带 `__NETCATTY_SHELL_KIND__:` 前缀的登录 shell 绝对路径，解析后映射为 posix/fish/powershell/cmd（`classifyLocalShellType(path, "linux")`）。
- **Windows OpenSSH**（L111-131）：`cmd.exe /d /s /c "reg query HKLM\SOFTWARE\OpenSSH /v DefaultShell 2>&1 & if errorlevel 1 (reg query HKLM\SOFTWARE\OpenSSH >nul 2>&1 & if not errorlevel 1 echo __NETCATTY_NO_DEFAULT_SHELL__)"`——读取 DefaultShell 注册表值判断默认是 powershell 还是 cmd；键可读但无值 → 文档默认 cmd；键不可读（ACL 拒绝）→ 不分类（防误钉 cmd）。
- **软提示而非硬钉**：结果只存 `session._loginShellKind`，**不改 `session.shellKind`**（L227-233）——因为登录 shell ≠ 当前交互 shell（用户可能嵌套）。
- **探测时机**：`ensureSessionShellKind`（L322-382）在 AI exec/start 前调用，已确认种类短路；并发共享 `_shellKindProbePromise`；失败不钉死（可重试）；探测窗口用 pending marker 支持取消（`ensureSessionShellKindForExec`，L398-441）。
- **活体 prompt 覆盖**（`resolveEffectiveShellKind`, `ptyExecHelpers.cjs:152-179`）：仅当 base kind 是 `""`/`"unknown"` 时，`PS ...>` → powershell、`C:\...>` → cmd、`user@host:...$`（且 hint 为 powershell/cmd，即 WSL 嵌套）→ posix；**已确认的 kind 永不覆盖**（防恶意远端伪造 `PS ...>` 行欺骗，issue #841，测试 `ptyExec.test.cjs:191-211`）。
- **探测通道**：优先 `session.conn`（ssh2），其次 `session.sshClient`、mosh/et 的 stats 连接（L182-194）；都通过 `boundedSshExec.cjs` 的 `executeBoundedSshCommand` 执行（open 15s / run 10min / 输出 64KB 上限，超限即中止）。

### 6.2 exec channel 兜底（`ptyExec.cjs:execViaChannel`, L636-825）

何时启用：session 有 `sshClient`（有 `.exec()`）但 **PTY 流不可写**（`execHandlers.cjs:171-181`：先试 interactive PTY，用户可见；不可写才 fallback）。关键点：

- **对用户不可见**：独立 ssh2 exec channel，不经过交互 PTY。
- **完成判定**：不靠 marker，靠 ssh2 `execStream.on("close", code)` —— **close 事件的 code 参数即远程命令退出码**（`ptyExec.cjs:784-791`）。`code == null`（SSH 断开/信号）→ "Command terminated unexpectedly"。
- **pending 取消标记**：`sshClient.exec` 回调可能长时间不回来（channel-open 阻塞），这段时间内取消必须有效——所以先同步注册 `__NCMCP_CH_PENDING_...__` 取消 latch，取消时 `invalidateSshTransport(sshClient)` 直接废掉传输层（ssh2 的 channel-open 请求不可取消，唯一干净的做法是关闭物理连接），回调回来后发现已取消就立刻关掉刚开出的 stream（L648-718，测试 `ptyExec.test.cjs:460-546`）。
- **边界**：open 超时 = timeoutMs（默认 60s，超时也 invalidate transport）；运行期输出上限 `maxOutputBytes`（默认 1MB），超限 `finish` + `terminateExecStream`（L739-763）。
- **退出码为 null 的处理**：`finish` 中 `ok: exitCode === 0 || exitCode === null`；工具层把 null 显示为成功但语义上是"未知"。

### 6.3 与 Vale 的对应关系

Vale 的"SSH 会话用不可见 exec channel 判断完成"对应 Netcatty 的 `execViaChannel`。Vale 若需要：PTY 注入失败 → 退到 `sshClient.exec("echo __VALE_MARKER_E:$?")` 式的探测/完成确认通道，注意 ssh2 的 close code 语义与 channel-open 不可取消问题（Netcatty 用 invalidateSshTransport 解决）。

---

## 7. 工具层配置与超时（`mcpServerBridge.cjs`）

- `commandTimeoutMs` 默认 **60s**，最大 `MAX_COMMAND_TIMEOUT_SECONDS = 24*60*60`（L117, 508），MCP 会话可调。
- MCP `terminal.execute` 强制 `enforceWallTimeout: true`（L1609）——注释明确："MCP callers have terminal_start as a fallback for long commands, so enforce a hard wall-clock timeout here to match the MCP budget"（`execHandlers.cjs:156-158`）。
- 后台 job 超时 `DEFAULT_BACKGROUND_JOB_TIMEOUT_MS = 60*60*1000`（1h），poll 建议间隔 30s，输出窗口 256KB（`aiExec.cjs:16-19`）。
- 工具描述（`toolInputs.cjs:379-384` + catalog description）明确告知模型：terminal_execute 只用于 ~60s 内命令；命令在可见终端的**隔离子 shell** 中运行，`cd`/`export`/`set` 不跨调用持久——Vale 报告里也应对模型做同样提示。

---

## 8. 对 Vale 修复"PowerShell 5.1 + ConPTY marker 失效"的移植建议（研究结论，非代码）

Vale 当前用 OSC 133:D shell 注入，在 Windows PowerShell 5.1 + ConPTY 下失效。Netcatty 方案的对应结论：

1. **改用"键入包装命令"而非 OSC 序列**：`<清行前缀> + 单行包装命令 + \r\n`，完成判定靠原始文本 `<marker>_E:<code>`。这绕开了 ConPTY/PSReadLine 对 OSC 序列的处理差异。注意 PowerShell 分支**必须 `\r\n` 结尾**（`ptyExecHelpers.cjs:216`），POSIX 用 `\n`。
2. **PowerShell 退出码捕获范式**：`$LASTEXITCODE=$null; try { Invoke-Expression $cmd; $rc = if ($LASTEXITCODE -ne $null) {$LASTEXITCODE} elseif ($?) {0} else {1} } catch { $rc = 1 }` —— 覆盖原生 exe / cmdlet / 终止性错误三种情形。
3. **shell 种类判定三层**：本地按可执行路径静态分类；远程（Windows OpenSSH）用不可见 exec channel 跑 `reg query HKLM\SOFTWARE\OpenSSH /v DefaultShell`；未确认时用活体 prompt 覆盖（`PS ...>` → powershell）。这直接解决"不知道对面是 PowerShell 还是 bash 就注入错包装"的根因。
4. **启动超时必须有**：等不到 `_S` 就按超时失败（Vale 的"永远等不到 marker"会变成"30s/60s 后明确报错"），且对 chatty PTY 不能靠无输出超时兜底。
5. **防误判**：start 确认前要求 `_E:` 行首边界；marker 带 128 位随机；剥 marker 只剥本 job 的。
6. **prompt 兜底**（可选第二完成信号）：维护 `lastIdlePrompt`（滚动尾部匹配 `PS ...>`/`C:\...>`/`user@host...$`），等 marker 期间检测到 idle prompt 稳定 250ms 也判完成——但这是"软"信号，Netcatty 把它排在 marker 之后。
7. **exec channel 兜底**：PTY 不可写时用 ssh2 exec channel，`close(code)` 即退出码；注意 channel-open 阻塞期的取消要用"废传输"而非等回调。

## 9. 参考文件清单（raw 路径，均取自 main 分支）

- `electron/bridges/ai/ptyExec.cjs`
- `electron/bridges/ai/ptyExecHelpers.cjs`
- `electron/bridges/ai/ptyExec.test.cjs`
- `electron/bridges/ai/shellUtils.cjs`
- `electron/bridges/ai/sessionShellKind.cjs`
- `electron/bridges/mcpServerBridge/execHandlers.cjs`
- `electron/bridges/mcpServerBridge/backgroundJobs.cjs`
- `electron/bridges/mcpServerBridge.cjs`
- `electron/bridges/boundedSshExec.cjs`
- `electron/terminalWorker/aiExec.cjs`
- `electron/capabilities/catalog/terminal.cjs`
- `electron/capabilities/catalog/index.cjs`
- `electron/capabilities/codegen/mcpToolRegistry.cjs`
- `electron/capabilities/schemas/toolInputs.cjs`
- `electron/mcp/netcatty-mcp-server.cjs`

仓库：https://github.com/binaricat/Netcatty （默认分支 `main`）

> 备注：本文引用的行号以拉取时 main HEAD 为准；源码随时间演进，行号可能漂移，但文件路径与机制稳定。
