# VS Code 集成终端架构研究报告（ITerminalService / xterm.js / node-pty / shell integration / ConPTY）

> 研究方法：直接研读 `microsoft/vscode@main`（commit `9eebd94676ab26b20daef16ee15aabdf7556001b`，2026-08-31）源码 `src/vs/workbench/contrib/terminal` + `src/vs/platform/terminal` + `src/vs/workbench/api`（sparse clone 实读，行号可追溯），配合官方文档（code.visualstudio.com/docs/terminal/shell-integration）、GitHub issues 与 microsoft/terminal 官方说明。本文所有结论均可在标注的源码行号/链接处复核。
> 姊妹篇：ConPTY/PSReadLine 已知问题的完整 issue 引文清单见 `docs/research/vscode-conpty-psreadline-known-issues.md`。

---

## 1. ITerminalService / ITerminalInstance 架构：1 实例 = 1 xterm = 1 pty

### 1.1 类层次与职责

| 类 | 文件 | 职责 |
|---|---|---|
| `TerminalService` (implements `ITerminalService`) | `browser/terminalService.ts` | 全局终端服务：创建实例、管理 tab/group、`createTerminal()` 入口、`instances` 枚举、`getInstanceFromId()` |
| `TerminalGroupService` + `TerminalGroup` | `browser/terminalGroupService.ts` / `browser/terminalGroup.ts` | 每个 tab 一个 group；group 内维护 `terminalInstances[]`（split pane 列表），用 `SplitView` 布局 |
| `TerminalInstanceService` | `browser/terminalInstanceService.ts` | 实例工厂：`createInstance(shellLaunchConfig, location)` —— 唯一的 `TerminalInstance` 创建点 |
| `TerminalInstance` (implements `ITerminalInstance`) | `browser/terminalInstance.ts`（2990 行） | **一个终端 = 一个实例**。私有字段：`_processManager`、`xterm?`（XtermTerminal 包装）、`_wrapperElement`、`_container` |
| `XtermTerminal` | `browser/xterm/xtermTerminal.ts` | 对原始 `@xterm/xterm` `Terminal` 的包装（`raw` 字段），负责加载 addons（ShellIntegrationAddon、DecorationAddon、MarkNavigationAddon、LineDataEventAddon、Search/Clipboard/Unicode11 等） |
| `TerminalProcessManager` | `browser/terminalProcessManager.ts`（904 行） | 实例侧进程管理：创建/relaunch/attach 进程，`SeamlessRelaunchDataFilter` + `AckDataBufferer` |
| `LocalPty` / `RemotePty` (extends `BasePty`) | `electron-browser/localPty.ts` / `browser/remotePty.ts` | 渲染进程侧的进程句柄（RPC 代理到 pty host / 远程扩展宿主） |
| `TerminalProcess` | `platform/terminal/node/terminalProcess.ts`（674 行） | **pty host 侧**：真正持有 node-pty 的 `IPty`，`spawn()`、`onData`、流控、kill/spawn 节流 |
| `PtyService` + `PersistentTerminalProcess` | `platform/terminal/node/ptyService.ts` | pty host（独立进程）内：进程注册表 `_ptys: Map<id, PersistentTerminalProcess>`，数据缓冲（5ms）、序列化/重放、孤儿检测 |
| `XtermSerializer` | `platform/terminal/node/ptyService.ts` | pty host 内的**无头 xterm.js 实例**（`@xterm/headless` + ShellIntegrationAddon），用于断线重连时把缓冲序列化（replay） |

### 1.2 实例生命周期（constructor → process → dispose）

1. `TerminalService.createTerminal()` → 决定 location（Panel 的 group / Editor）→ `TerminalInstanceService.createInstance()`。
2. `TerminalInstance` 构造（terminalInstance.ts:420 起）：分配 `instanceId`、创建 `_processManager`（:544）、`_xtermReadyPromise = this._createXterm()`（:548）。
3. `_createXterm()`（:805 起）：`importAMDNodeModule('@xterm/xterm')` 懒加载 xterm.js 构造函数（模块级单例，:110），`createInstance(XtermTerminal, …)`，随后把 xterm 与 process manager 接线（:882-908）：
   - `_processManager.onProcessData(e => this._onProcessData(e))` —— **输出入口**
   - `xterm.raw.onData(data => this._handleOnData(data))` —— **输入出口**；`onBinary → processBinary`
   - `onProcessReady` 时按需注册 ConPTY 的 DA1 应答 handler、设置 `windowsPty` 选项、`reflowCursorLine`
4. `_createProcess()`（:1610）→ `_processManager.createProcess(shellLaunchConfig, cols, rows)` → 最终在 pty host 里 `node-pty spawn()`（terminalProcess.ts:316）。
5. `attachToElement(container)`（:1066）把实例的 `_wrapperElement` 挂到某个 DOM（pane 或 editor），`_open()`（:1100）里才真正 `xterm.attachToElement` 建 DOM。

**结论：每个终端实例恰好一个 xterm.js 实例、一个 node-pty 进程（1:1:1）。** 全部渲染/缓冲/命令检测都在这一个 xterm 上做；pty host 里的 `XtermSerializer` 是第二份"影子缓冲"（headless xterm），只服务于重连序列化，不参与渲染。

---

## 2. 数据流：生产者/消费者模型

### 2.1 输出链路（pty → 屏幕），自上而下

```
node-pty ptyProcess.onData(data)                          platform/terminal/node/terminalProcess.ts:323
  └─ TerminalProcess._onProcessData.fire(data)
       └─ PersistentTerminalProcess: TerminalDataBufferer（5ms 合并，保序 join）   ptyService.ts:819 / terminalDataBuffering.ts
            └─ PtyService._onProcessData（RPC: pty host → renderer，MessagePort）  ptyService.ts:126,352
                 └─ LocalPty.handleData → BasePty._onProcessData.fire               basePty.ts:63
                      └─ TerminalProcessManager._dataFilter
                         (SeamlessRelaunchDataFilter.onProcessData)                terminalProcessManager.ts:169
                           ├─ _onBeforeProcessData.fire（扩展可改写 data！）        terminalProcessManager.ts:172
                           └─ _onProcessData.fire(IProcessDataEvent)
                                └─ TerminalInstance._onProcessData(ev)             terminalInstance.ts:882,1669
                                     ├─ 按 OSC 633 C/D 正则切分（保命令边界）
                                     └─ _writeProcessData(data) → xterm.raw.write(data, cb)  :1700
                                          └─ cb（xterm 解析完成后）:
                                               _processManager.acknowledgeDataEvent(len)（流控 ack）
                                               this._onData.fire(data)（→ 扩展宿主 onDidWriteTerminalData，5ms 缓冲）
```

关键点：

- **生产者：每终端恰好 1 个**（pty 进程的 onData）。node-pty 的 `onData` 事件顺序即内核管道顺序，VS Code 全程**单线程事件循环转发，不做任何并行/重排**。
- **消费者：多个**，但都挂在同一条顺序链上：
  1. `xterm.write()` 渲染（主消费者，唯一"画面"）；
  2. `instance.onData` → `mainThreadTerminalService` 的 `TerminalDataEventTracker`（5ms 缓冲，`TerminalDataBufferer`）→ 扩展宿主 `$acceptTerminalProcessData` → 扩展 API `onDidWriteTerminalData`（mainThreadTerminalService.ts:502，extHostTerminalService.ts:576）；
  3. `LineDataEventAddon.onLineData`（onLineFeed 时按"整行"派发，任务系统/quick fix 用；Windows 下额外监听 CSI H 光标移动强制刷行，lineDataEventAddon.ts:58）；
  4. `_onBeforeProcessData`（扩展可在写入前修改数据）；
  5. pty host 的 `XtermSerializer`（影子 xterm，实时记录用于重连 replay）。

### 2.2 输入链路（键盘 → pty）

```
xterm.raw.onData(data)                                        terminalInstance.ts:883
  └─ _handleOnData(data) → _processManager.write(data)        :676
       ├─ ptyProcessReady 未就绪 → _preLaunchInputQueue 排队   terminalProcessManager.ts:663（就绪后 flush :390）
       ├─ _dataFilter.disableSeamlessRelaunch()（有输入即禁用无缝重启）  :653
       └─ LocalPty.input(data) → PtyService.input(id,data) → pty.input(data) → node-pty write()
```

另有程序化输入路径 `sendText()`（:1396，runCommand/扩展用）：统一 `\n→\r`、追加 `\r`、可选 bracketed paste 包裹（`\x1b[200~…\x1b[201~`）、可选先发 `\x03`(Ctrl+C) 清空输入行。扩展写入（Pseudoterminal）走 `processBinary`。

**输入生产者：1 个（xterm 的 onData + 扩展 API 的 sendText）；消费端唯一（pty 的 write）。** 输入不会与输出竞争：xterm.js 的 onData 与 write 在同一线程，天然串行。

---

## 3. 输出顺序：不排队去重，靠"单写队列 + 解析回调 + 流控 ack"

### 3.1 顺序保证机制

1. **xterm.js 自带 write 队列**：`xterm.write(data, cb)` 是顺序 FIFO，cb 在**该段数据被解析完成后**触发。VS Code 把 ack 挂在 cb 里（terminalInstance.ts:1703-1708），所以"ack = 已渲染"。
2. **无去重、无重排**：数据只在 `TerminalDataBufferer` 里做 5ms 时间窗合并（数组 push + `join('')`，严格保序，terminalDataBuffering.ts:38-63），纯粹为减少 IPC 消息数。
3. **`_onProcessData` 的 OSC 633 切分**（terminalInstance.ts:1669-1698）：xterm.js 目前只有 `onWriteParsed`（整批写完才触发），没有"单个 data 事件解析完"的钩子，所以 VS Code 在写入前用正则 `/(?<seq>\x1b\][16]33;(?:C|D(?:;\d+)?)\x07)/g` 把每个事件按 `633;C` / `633;D[;code]`（兼容 133）切段、按序逐段 `write`。目的是让扩展看到的每次 `onDidWriteTerminalData` 都是"完整命令输出"的规整边界（注释原文："Ensure events are split by SI command execute and command finished sequence…xterm.js does not currently have a listener for when individual data events are parsed"）。
4. **`trackCommit` / `writePromise`**（basePty.ts:99）：replay 时每个事件 `await e.writePromise` 串行等 xterm 解析完再发下一条，重连回放严格有序（basePty.ts:90-116）。
5. **流控是"暂停"不是"丢"**：见下。

### 3.2 流控（背压，防止对端洪水/丢数据）

`FlowControlConstants`（platform/terminal/common/terminal.ts:876-897）：

- 高水位 `HighWatermarkChars = 100000`：pty host 里未 ack 字符数超限 → `ptyProcess.pause()`（terminalProcess.ts:326-330）。
- 低水位 `LowWatermarkChars = 5000`：`acknowledgeDataEvent` 后未 ack 数回落到 5000 以下 → `resume()`。
- `CharCountAckSize = 5000`：渲染进程侧 `AckDataBufferer` 攒够 5000 字符才发一次 ack（terminalProcessManager.ts:742-757）。

即：**渲染跟不上时 pty 被暂停（不丢字节），跟上后恢复** —— 这是"不丢输出"的根本保障，尤其对 ConPTY（其内部缓冲有限）。

### 3.3 跨进程重启的顺序（SeamlessRelaunchDataFilter）

`terminalProcessManager.ts:775-901`：`restart`/`relaunch` 时新旧进程输出各用一个 `TerminalRecorder` 记录（新终端首 10s、swap 等待最长 3s）；swap 时若内容不同，先发 `\x1bc`（RIS 全清）再在同一帧写新进程数据（:870-871，注释："Fire full reset (RIS) followed by the new data so the update happens in the same frame"）；**一旦用户输入过，`disableSeamlessRelaunch()` 立即停用**（有输入 = 用户已经看到旧内容，不能清屏）。

---

## 4. 多视图：split pane 不是"同一终端的多个视图"，是"多个独立终端"

### 4.1 事实

- `TerminalGroup.split()`（terminalGroup.ts:526）→ `_terminalInstanceService.createInstance(shellLaunchConfig, …)` —— **每个 split pane 都是全新 TerminalInstance：新 xterm、新 pty 进程**（与父 pane 共享 cwd/profile 等启动配置，仅此而已）。`SplitPaneContainer._addChild`（:132）把新实例 `attachToElement` 到自己的 pane DOM。
- 同一个实例的 DOM（`_wrapperElement`）**只能存在于一处**：`attachToElement`/`detachFromElement`（terminalInstance.ts:1061-1093）在 panel 与 editor 之间**搬移**同一份 DOM（"The container changed, reattach"），`xterm.raw.open()` 重挂。实例 `target` 是单值（Panel | Editor），不存在"同一 buffer 双份渲染"。
- 因此**没有"输出广播到多视图"的机制** —— 输出只写进唯一一个 xterm；"广播"只发生在消费者层面：扩展宿主通过 `instance.onData`（缓冲后）拿到同一份数据的副本（extHost `onDidWriteTerminalData`），pty host 影子 xterm 拿到副本做序列化。这些是数据扇出（fan-out），不是渲染广播。

### 4.2 若你想要"1 个 pty 对多个视图"的对照物

VS Code 模型是 **复制进程，不复制视图**；真正"单 pty 多渲染"的参考是 tmux 的 `display-panes`/synchronize 或 wezterm 的 pane 复用——但 VS Code 明确选择 1:1:1，换来的是：每个 pane 独立的滚动缓冲/查找/装饰/缩放，无需任何多视图同步逻辑。这也是"多视图广播"问题在 VS Code 架构里**被设计掉了**：答案 = 没有共享视图，只有独立实例。

---

## 5. Shell Integration：OSC 633 的注入机制（重点）

### 5.1 注入方式：改 shell 启动参数 + 环境变量（不往 pty 写脚本）

`getShellIntegrationInjection()`（`platform/terminal/node/terminalEnvironment.ts:53-280`）在 pty host 侧、spawn 之前执行，返回 `{ type:'injection', newArgs, envMixin, filesToCopy? }`：

| Shell | 替换后的启动参数 | 额外动作 |
|---|---|---|
| bash | `--init-file <vscode>/shellIntegration-bash.sh` | login 时 `VSCODE_SHELL_LOGIN=1`，脚本自己 source 用户 rc/profile |
| fish | `--init-command 'source "<vscode>/shellIntegration.fish"'`（login 加 `-l`） | — |
| pwsh | `-noexit -command '. "<vscode>/shellIntegration.ps1"'`（Windows：`try { . "…\shellIntegration.ps1" } catch {}` 吞掉执行策略错误） | — |
| zsh | 参数保持 `-i`/`-il` | 把 `shellIntegration-rc.zsh/.zprofile/.zshenv/.zlogin` 拷进临时 `ZDOTDIR=<tmp>/${user}-vscode-zsh`（sticky bit 0o1700），rc 脚本再 source 用户真实 `.zshrc`（并修 `HISTFILE`） |

环境变量 mixin：`VSCODE_INJECTION=1`、`VSCODE_NONCE`（随机值，信任锚点）、`VSCODE_STABLE`、`VSCODE_SHELL_ENV_REPORTING`、`VSCODE_A11Y_MODE`（Windows pwsh）、`VSCODE_PATH_PREFIX`、`VSCODE_ENV_REPLACE/PREPEND/APPEND`。脚本内再设 `VSCODE_SHELL_INTEGRATION=1` 防重入。

### 5.2 脚本挂的钩子（每 shell 一种"命令前后"机制）

- **bash**：改写 `PS1`/`PS2` 为 `\[A 序列\]原PS1\[B 序列\]`（continuation 用 F/G）；`PROMPT_COMMAND=__vsc_prompt_cmd`（保存 `$?` → precmd 逻辑，发 D + Cwd）；preexec 用 `trap … DEBUG`（兼容已有 DEBUG trap 与 bash-preexec），命令取 `history 1`（HISTCONTROL 抑制重复时退化为 `$BASH_COMMAND`）。
- **zsh**：`add-zsh-hook precmd/preexec`；`PS1/RPROMPT` 用 `%{…%}` 包裹 A/B、H/I。
- **fish**：`--on-event fish_preexec`（E+C）、`fish_postexec`（D $status）、`fish_prompt`（Cwd）、`fish_cancel`（E "" C D）；包装 `fish_prompt`/`fish_mode_prompt` 注入 A/B。
- **pwsh**：整体替换 `function Global:Prompt`（发 D/A/Cwd/EnvJson/B，exit code 取 `$FakeCode = [int]!$global:?`）；PSReadLine 已加载时再包装 `PSConsoleHostReadLine`（发 E+命令+nonce、C）——**这正是与 PSReadLine 冲突的根源，见 §7**。另把 `Ctrl+Space→F12,a`、`Alt+Space→F12,b`、`Shift+Enter→F12,c`、`Shift+End→F12,d` 映射成 VS Code 能识别的键。

### 5.3 OSC 633 序列全集（VS Code 侧解析：`shellIntegrationAddon.ts` + `terminalEscapeSequences.ts`）

| 序列 | 含义 | 用途 |
|---|---|---|
| `633;A` | 提示符开始（基于 FinalTerm 133;A） | 标记行起点 |
| `633;B` | 提示符结束/命令开始 | 命令输入区起点 |
| `633;C` | 命令即将执行 | "pre-execution" |
| `633;D[;exitcode]` | 命令结束（空 = 未执行命令，如空回车/^C） | **完成检测 + 退出码** |
| `633;E;<cmd>[;nonce]` | 显式上报命令全文 | **命令行的可靠来源**（见 5.5） |
| `633;F` / `633;G` | continuation 提示符起/止 | 多行命令 |
| `633;H` / `633;I` | 右提示符起/止 | 右提示符 |
| `633;P;Prop=Value` | 属性：`Cwd`、`IsWindows`、`HasRichCommandDetection`、`PromptType`、`Prompt`、`ContinuationPrompt`、`Task` | 环境/平台上报 |
| `633;SetMark[;Id=…][;Hidden]` | 滚动条标记 | 缓冲区标记 |
| `633;EnvJson` / `EnvSingle*` | 环境变量上报（带 nonce） | env 同步 |

同一 addon 还**消费**（兼容输入）：`133;A/B/C/D`（FinalTerm）、`1337;CurrentDir=…`/`1337;SetMark`（iTerm2）、`OSC 7;…`（file:// cwd）、`OSC 9;9;…`（ConEmu cwd）——但官方文档注明 133 是"degraded experience"，且**无 nonce 的 cwd 一律按不可信处理**（shellIntegrationAddon.ts:583-590、683-686）。

### 5.4 如何检测"shell integration 生效"与 shell 类型

- **无版本握手序列**（不存在 `ShellIntegrationVersion`）：addon 只要收到任意一条 633 序列就把状态置为 `ShellIntegrationStatus.VSCode`（收到 133 则为 `FinalTerm`）；10 秒内没产生 CommandDetection/CwdDetection capability 则记 telemetry 失败（shellIntegrationAddon.ts:439-464）。
- **信任模型 = nonce**：脚本启动时从 `VSCODE_NONCE` 取出随机串，之后每条 `E`/`Cwd`/env 序列都带 nonce；addon 比对 `arg1 === this._nonce` 才标记"可信"（setCommandLine(commandLine, isTrusted)、updateCwd(value, isTrusted)）。注释原文："This helps ensure no malicious command injection has occurred."（防任何程序输出伪造 OSC 633 冒充 shell）。
- **能力分级**：`P;HasRichCommandDetection=True` 表示"序列会按 A,B,E,C,D 的理想顺序出现"（官方文档原文），pwsh 只在 PSReadLine 加载时才发它。
- **shell 类型**：由 `path.basename(executable)` + 参数形态（login/implied）判定（terminalEnvironment.ts:84,346-371）；shell 内再上报 `PromptType=starship|oh-my-posh|p10k|…`。
- 超时：`terminal.integrated.shellIntegration.timeout`（默认注入后 5000ms）判定失败。

### 5.5 命令完成与"当前位置"检测（重点）

- **完成**：`D` 序列。bash/zsh 在 precmd（下一个提示符渲染时）发出 `633;D`（空命令）或 `633;D;$?`；fish 在 `fish_postexec` 发 `D $status`；pwsh 在 Prompt 里比对 `Get-History` 的 LastHistoryId 变化。
- **位置**：VS Code **不向终端查询光标**（无 CPR 轮询），完全依赖序列在缓冲中的落点：A 必须在一行开头、B 在提示符后、C 在输出前、D 在输出结束后的下一行。xterm 的 `registerMarker` 在序列解析瞬间打标记（commandDetectionCapability.ts:296-431）。
- **Windows 例外（ConPTY 位置不可信）**：`P;IsWindows=True` 触发 `WindowsPtyHeuristics`（commandDetectionCapability.ts:596-929）——这是一套为 ConPTY 定制的启发式：
  - 命令开始时**轮询扫描下方最多 5 行**找提示符特征来修正 commandStart marker（`_tryAdjustCommandStartMarker`，:737）；
  - 监听**光标移动事件**收集 `commandMarkers`，用首尾 marker 修正 start/executed（:792-799, :899-916）；
  - resize 后等待 ConPTY 重绘、按行内容移位修正 marker（:626-686，含直接 fire xterm 内部 `onDeleteEmitter` 的 HACK）；
  - 命令结束后在 buffer 里**逐字符扫描匹配命令文本**定位 executed marker（`postHandleCommandFinished`，:844-897）。
- **E 序列为什么存在**（addon 注释原文，关键）："This helps workaround performance and reliability problems with parsing out the command, such as **conpty not guaranteeing the position of the sequence** or the shell not guaranteeing that the entire command is even visible." —— 即 Windows 上光靠 A/B/C 猜命令行不可靠，E 直接携带"shell 亲口说的命令全文"，配 nonce 校验。

### 5.6 为什么用 OSC 633 而不是 133（权威引文）

`shellIntegrationAddon.ts`（终稿提交 [9e26868 / PR #157571 "Finalize VS Code shell integration sequences in code"](https://github.com/microsoft/vscode/commit/9e2686820b4a8f4226e710a6a970a9702cde12d8)）：

> "VS Code-specific shell integration sequences. Some of these are based on more common alternatives like those pioneered in FinalTerm. **The decision to move to entirely custom sequences was to try to improve reliability and prevent the possibility of applications confusing the terminal.** If multiple shell integration scripts run, VS Code will prioritize the VS Code-specific ones."
> "It's recommended that authors of shell integration scripts use the common sequences (eg. 133) when building general purpose scripts and the VS Code-specific (633) when targeting only VS Code or when there are no other alternatives."

数字来源（同文件注释）："derived from the least significant digit of 'VSC' when encoded in hex ('VSC' = 0x56, 0x53, 0x43)"。即：633 是 VS Code 私有协议，避免与 iTerm2(1337)/FinalTerm(133) 的既有脚本互相干扰（例如 powerlevel10k 同时装了两套）；133/1337 仅作为**兼容输入**被消费。

### 5.7 注入失败时的降级

`getShellIntegrationInjection` 返回类型化失败原因（`ShellIntegrationInjectionFailureReason`）：设置禁用 / 无 executable / feature terminal / `ignoreShellIntegration` / Windows < 18309（"Shell integration requires Windows 10 build 18309+ (ConPTY support)"）/ 参数不支持 / zsh 临时目录失败 / shell 不支持。**cmd.exe 至今无官方注入**（一个未合并的草案 PR [microsoft/vscode#251061](https://github.com/microsoft/vscode/pull/251061) 用 `PROMPT` 变量方案做过尝试）；文档建议的兜底是手动安装脚本（`code --locate-shell-integration-path`）。

---

## 6. Windows ConPTY 的处理与已知问题

### 6.1 VS Code 侧用法（node-pty 选项）

`platform/terminal/node/terminalProcess.ts:159-172`：

```ts
const useConpty = process.platform === 'win32' && getWindowsBuildNumberSync() >= 18309;
const useConptyDll = useConpty && this._options.windowsUseConptyDll;
this._ptyOptions = { name, cwd, env, cols, rows, useConpty, useConptyDll,
  conptyInheritCursor: useConpty && !!shellLaunchConfig.initialText };
```

- `conptyInheritCursor`：让 ConPTY 启动时不整屏重绘（reconnect/恢复场景需要）。
- **`windowsUseConptyDll` 设置**（terminalConfiguration.ts:485）：*"Whether to use the conpty.dll (v1.25.260303002) shipped with VS Code, instead of the one bundled with Windows."* —— VS Code 自 1.100+ 起**自带 conpty.dll**，规避 Windows 系统自带 ConPTY 的 bug；旧设置 `terminal.integrated.windowsEnableConpty` 已从配置 schema 中**移除**（winpty 支持也已在 v1.109 移除，node-pty#842，"Cannot launch conpty" 错误消息里明确提示）。
- ConPTY 相关的渲染侧适配（terminalInstance.ts:889-908）：
  - **DA1 应答**：conpty 1.22+ 会等待 DA1 响应，不回应会长时间卡启动 → 注册 `CSI c` handler 回 `\x1b[?61;4c`（引用 microsoft/terminal `adaptDispatch.cpp#L1471-L1495`）；
  - `reflowCursorLine`（仅 conpty + conpty.dll）：修复 reflow 丢提示符（[vscode#274372](https://github.com/microsoft/vscode/issues/274372)）。

### 6.2 启动/退出/重连的工程化缓解

- **kill→spawn 节流 250ms**（terminalProcess.ts:45-60，注释列了 [vscode#71966](https://github.com/microsoft/vscode/issues/71966)、[#117956](https://github.com/microsoft/vscode/issues/117956)、[#121336](https://github.com/microsoft/vscode/issues/121336)）：conpty 下快速 kill+spawn 会挂起 pty host（conhost 应跑在独立线程，node-pty#415）。
- **退出前 250ms 数据排空**（`DataFlushTimeout`，:26-43）：既补 node-pty#72（退出丢尾数据），又避免"进程还在输出时 kill 导致 conhost flush 挂起 pty host"（#71966）。
- **重连 replay**（ptyService.ts:858-885、264-310）：进程恢复时用 `conptyInheritCursor` + 先回放序列化缓冲；ConPTY v1.22+ 的 passthrough 模式下 `GetConsoleCursorInfo` 由 conpty 自己应答会把光标拉回缓冲顶部，所以恢复后补 `\r\n×(rows-1) + \x1b[H` 强制清视口（:267-279）；"inherit cursor 选项会发 DSR CPR，终端未挂接时 conhost 会挂起"（microsoft/terminal#11213）。
- 延迟 resize（Git Bash 0x0 尺寸）与 `DelayedResizer`（:173-184）。

### 6.3 已知问题与官方定性（详见 `vscode-conpty-psreadline-known-issues.md`）

| 问题 | 定性 | 结果 |
|---|---|---|
| [vscode#146450](https://github.com/microsoft/vscode/issues/146450) / [terminal#12805](https://github.com/microsoft/terminal/issues/12805)：输出恰好铺满屏高时"丢失"上一条命令 | 上游根因是 PSReadLine 的 `CSI 1 S` 滚动实现（[PSReadLine#724](https://github.com/PowerShell/PSReadLine/issues/724)） | 升级 PSReadLine 2.2.6+ 修复；非 ConPTY 丢缓冲 |
| [terminal#4116](https://github.com/microsoft/terminal/issues/4116)：ConPTY passthrough 序列被截断 | VT 状态机 `_run` off-by-one（PR #3956 回归） | Terminal v0.8 修复 |
| [terminal#16911](https://github.com/microsoft/terminal/issues/16911)：resize 时 ConPTY 重发 reflow 后缓冲覆盖内容 | 重排怪癖 | `PSEUDOCONSOLE_RESIZE_QUIRK` 抑制 |
| [vscode#132715](https://github.com/microsoft/vscode/issues/132715)：非英文字符在 Windows 上重复 | winpty/ConPTY 模拟问题 | 转 upstream |
| **In-process ConPTY 设计文档** [terminal#13000](https://github.com/microsoft/terminal/blob/main/doc/specs/%2313000%20-%20In-process%20ConPTY.md) | 官方承认：ConPTY 跨进程设计存在 *"an unsolvable issue: The buffer contents between ConPTY and the terminal can go out of sync"*（转义/文本处理/reflow 差异、resize 与输出并发），重构后 *"will resolve our ordering and buffering issues"* | 架构层面的输出顺序问题在 Windows 上**无解**，只能缓解 |

**关键结论：ConPTY 的输出顺序/丢失问题绝大多数被官方定性为 upstream（Windows 组件），VS Code 的应对是：(a) 自带 conpty.dll 绕过系统 bug；(b) 流控暂停不丢字节；(c) shell integration 不依赖 ConPTY 的序列位置（E 序列 + WindowsPtyHeuristics）；(d) 把剩余问题转交 microsoft/terminal。**

---

## 7. 关键教训（VS Code 终端团队踩过的坑）

### 7.1 输出顺序 / ConPTY

1. **永远不要信任 ConPTY 的缓冲位置**：序列可能错位、reflow 后命令移位、resize 重绘会覆盖内容 → 用 E 序列显式传命令、用启发式修正 marker，而不是解析屏幕。
2. **背压必须"暂停"而非"丢"**：100k 字符高水位 pause / 5k 低水位 resume + ack，保证对端洪水时零丢失（也保护共享 IPC 通道，注释原文："not flooding the connection is the important thing as it's shared with other core functionality"）。
3. **退出时序是坑**：node-pty#72 丢尾数据、conhost flush 挂起（#71966）→ 250ms 排空 + kill/spawn 250ms 节流。
4. **ConPTY 版本差异巨大**（1.22 passthrough、DA1 等待、reflow）：用 `processTraits.windowsPty` 在运行时探测并按版本/后端启用 workaround（DA1 应答、reflowCursorLine、恢复消息）。
5. **快速重启会闪屏/清屏** → SeamlessRelaunchDataFilter 记录对比新旧输出，仅内容不同才 RIS+重写，用户输入过则放弃。

### 7.2 PSReadLine / PowerShell

- [vscode#142161](https://github.com/microsoft/vscode/issues/142161)：早期 `shellIntegration.ps1` 用 `Write-Host` 写 `ESC]133;C` 序列，破坏 PSReadLine 预测（predictions）→ 改用 `[Console]::Write` 直接写控制台修复。
- [vscode#144215](https://github.com/microsoft/vscode/issues/144215)：无 PSReadLine 时提示符无限重绘 → 用 `HasPSReadLine` 门控 readline 钩子，未加载就不包 `PSConsoleHostReadLine`（Windows 反正有 E 序列提供命令全文）。
- Windows 10 上 E 序列的 nonce 偶尔会被 echo 到终端 → 特意省略 nonce（shellIntegration.ps1:223-227）。
- a11y 模式下换装自带 PSReadLine 2.4.x，但**明确跳过 Windows PowerShell 5.1**（"removing the built-in PSReadLine 2.0.0 … can cause input handling issues (e.g. repeated Enter key presses)"）。
- 与 shell 插件生态的摩擦：PROMPT_COMMAND 格式不合规会破坏注入；starship/oh-my-posh/p10k 有专门分支；插件可主动 unset `VSCODE_SHELL_INTEGRATION`。

### 7.3 通用

- **单一写路径 + 解析回调驱动 ack** 是顺序与流控的统一答案；任何"多线程写入渲染器"的设计都会引入乱序。
- 注入类功能**改启动参数 + 环境变量**（而非往 pty 里塞文本）最可靠：不污染用户可见输出、可被 `ignoreShellIntegration` 关闭、脚本可防重入。
- 信任锚点（nonce）放进协议本身，防任何输出冒充系统消息——这对 agent 型终端（AI 读终端输出）尤其重要。

---

## 8. 对自研终端模拟器的启示（简）

1. **模型选择**：VS Code 的 1:1:1（实例:xterm:pty）换掉"多视图广播"问题；若 Vale 需要单 pty 多视图，参考 xterm.js 的"多 terminal 实例 + 共享 pty 的伪视图"并无先例，更稳妥的是复制实例或把"视图"定义为同一实例的多个 DOM 渲染器（xterm.js 本身支持一个 buffer 多渲染器的能力有限，需自行评估）。
2. **顺序**：单线程 write 队列 + 每段解析完成的回调 + ack 驱动的流控暂停，是可直接照搬的黄金组合。
3. **shell integration**：633 协议与 nonce 机制是现成最佳实践（自家终端可直接消费 OSC 633；若与 VS Code 并存，注意 133 兼容输入与"多脚本并存时优先 633"的约定）；Windows 上必须配套 IsWindows 启发式。
4. **ConPTY**：自带 conpty.dll、按运行时探测启用 workaround、把残余问题交给 upstream，是成本最低的 Windows 策略。

---

## 主要来源

- 源码（vscode main @ 9eebd946）：`src/vs/workbench/contrib/terminal/{browser,common,electron-browser}/`、`src/vs/platform/terminal/{common,node}/`、`src/vs/workbench/api/{browser,common}/`（文中行号均指该 commit）
- 官方文档：<https://code.visualstudio.com/docs/terminal/shell-integration>（原始 markdown：`microsoft/vscode-docs` 仓库）
- Shell integration epic：[microsoft/vscode#133084](https://github.com/microsoft/vscode/issues/133084)；序列终稿：[commit 9e26868 / PR #157571](https://github.com/microsoft/vscode/commit/9e2686820b4a8f4226e710a6a970a9702cde12d8)
- 已知问题清单（含全部引文）：`docs/research/vscode-conpty-psreadline-known-issues.md`；[VS Code wiki Terminal Issues](https://github.com/microsoft/vscode/wiki/Terminal-Issues)；[In-process ConPTY 设计文档 #13000](https://github.com/microsoft/terminal/blob/main/doc/specs/%2313000%20-%20In-process%20ConPTY.md)
