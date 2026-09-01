# PowerShell 5.1 + ConPTY：可靠检测"命令完成/提示符出现"——机制研究与正确注入方案

> 研究日期：2026-09-01（对应 PowerShell master / PSReadLine master / VS Code main 源码快照）。
> 目标：回答两个核心问题——**(1) 为什么我们注入的 `function global:Prompt { Write-Host ...; return "PS> " }` 在 PSReadLine 卸载后不生效？(2) 正确可靠的"检测命令完成"注入方案是什么？**
> 方法：所有结论均回溯到一手来源——PowerShell/PSReadLine/VS Code/Windows Terminal 的**源码**与**官方文档**；源码文件已保留在 `docs/research/_src/`（`ConsoleHost.cs`、`ConsoleHostUserInterface.cs`、`ReadLine.cs`、`Render.cs`、`vscode_shellIntegration.ps1`、`vscode_shellIntegrationAddon.ts`、`wt_terminal.cpp`）。
> 相关既有笔记：`vscode-conpty-psreadline-known-issues.md`（ConPTY/PSReadLine 已知坑）、`ai-agent-command-execution-research.md`（各 agent 的完成检测横向对比）、`vscode-terminal-architecture.md`。

---

## TL;DR（结论速览）

1. **`Prompt` 函数机制本身是可靠的，我们的注入失效不是"PSReadLine 卸载导致 Prompt 不调用"**——恰恰相反：
   - `Prompt` 由 **ConsoleHost 顶层输入循环**（`InputLoop.Run()`）每次读命令前调用（`ConsoleHost.cs` `EvaluatePrompt()`），**与 PSReadLine 无关**；PSReadLine 只是接管了"读行"（`PSConsoleHostReadLine`），提示符的求值/打印始终在 ConsoleHost 侧。
   - **真正的原因（按概率排序）**：
     - **(a) `Prompt` 必须返回字符串，返回 `$null`/空/非字符串 → 回退默认 `PS>`**（`about_Prompts` + `ConsoleHost.cs` 2913-2922 行 + PSReadLine `GetPrompt()` 1178-1180 行双重证实）。`Write-Host` 不产生输出对象，若我们的函数没有 `return "PS> "` 之外的**返回值路径**，就会回退。
     - **(b) `function global:Prompt {...}` 的注入时机**：注入发生在"提示符已经显示之后"（例如启动参数 `-Command` 或已进入交互循环后再注入），**当前这一轮提示符不会重绘**；必须等下一次回车后的 `EvaluatePrompt()` 才会用新函数。若注入后没有再按回车（或注入发生在 Enter 之前），看不到效果。
     - **(c) 作用域被覆盖**：`$PROFILE` / 第三方（oh-my-posh、posh-git、Starship、VS Code PowerShell 扩展）在注入**之后**又定义了 `prompt`（大小写不敏感），覆盖了我们的 global 函数。
     - **(d) 语言模式限制**：若 `$ExecutionContext.SessionState.LanguageMode` 不是 `FullLanguage`（如 ConstrainedLanguage），函数注入/调用会被限制（VS Code 脚本明确对此做了 early-return）。
     - **(e) PSReadLine 开着时的"增量重绘碎片"**：提示符文本里若含 OSC/控制序列且换行数估算错误（`-ExtraPromptLineCount`），PSReadLine 重绘会把我们的 marker 拆散/吞掉——但这只影响"看到的效果"，不影响"函数被调用"这一事实。
2. **`Set-PSReadLineOption -PromptText` 不是钩子**——它只是"解析错误时把提示符的某个后缀染红"的**纯视觉配置**（`Set-PSReadLineOption.md` 官方参数说明 + `ReadLine.cs` 840-895 行源码）。`AddToHistoryHandler` 是"是否把命令写入历史"的过滤器，**在命令执行前**回调，**不能**用于检测"命令完成"。**PSReadLine 没有"提示符前执行脚本"的钩子**；它提供的机制是 `InvokePrompt()`（PSReadLine 自己重绘提示符，内部仍然调用 `prompt` 函数）。
3. **VS Code 的 PowerShell shell integration 为什么有效**：
   - 它注入的 `shellIntegration.ps1` **整体替换 `prompt` 函数**（`function Global:Prompt()`），在函数体内按顺序拼出 `OSC 633 ; D ; <exitcode>`（命令完成）→ `OSC 633 ; A`（提示符开始）→ `P;Cwd=...` → **调用保存的原 `prompt`** → `OSC 633 ; B`（提示符结束），最后 `return $Result`。
   - 它**把 marker 放进 prompt 的返回值里**（即放进 `ui.Write(prompt)` 写出的字节流），**而不是**用 `Write-Host` 打印——这是它没踩到"Write-Host 不返回值"坑的关键。`return` 值同时满足 ConsoleHost 的 `EvaluatePrompt()`（非空字符串）和 PSReadLine 的 `GetPrompt()`。
   - 它还**包装 `PSConsoleHostReadLine`**（仅当 PSReadLine 加载时）来发 `OSC 633 ; E`（命令行）+ `OSC 633 ; C`（命令开始执行），且用 `[Console]::Write` 直写（避免 `Write-Host` 的换行污染 PSReadLine 重绘——见 vscode#142161）。
   - "VS Code 有效而我们的 Prompt 无效"的直接差异 = **VS Code 的 prompt 返回完整字符串**（marker + 原提示符拼接），**我们的 prompt 用 Write-Host 打印 marker 后 return 一个空格/空**（若 return 的是空，ConsoleHost 直接回退 `PS>`，marker 丢失）。
4. **正确的注入方案（结论）**：**替换（而非追加）`prompt` 函数，返回一个包含 marker 的字符串**，格式照抄 VS Code / Windows Terminal 官方 profile 示例：
   - `return "`e]133;D;$exitCode`a`e]133;A`a...你的提示符...`e]133;B`a"`（FTCS 133，跨终端通用），或 `OSC 633 ; ...`（VS Code 专属）。
   - 保留原 `prompt` 的链式调用（`$__OriginalPrompt = $function:Prompt` 后 `$__OriginalPrompt.Invoke()`），避免踩掉用户/oh-my-posh 的提示符。
   - 注入点：**`$PROFILE`（CurrentUserCurrentHost）或进程启动时**（`-Command ". <script>; ..."` 或 `-EncodedCommand`），并确保注入后触发一次 `prompt` 求值（例如注入脚本末尾主动 `& prompt > $null` 或直接依赖"注入后必有回车"）。
   - **不依赖 PSReadLine 的加载状态**：marker 由 `prompt` 返回值携带，PSReadLine 在不在都生效。
5. **ConPTY 输出流层面的检测**：ConPTY 输出管道传的是 **"图形呈现信息"（渲染后的文本 + VT 序列）**，不是程序的原始 stdout（官方 ConPTY 文档）。因此：
   - 检测 `OSC 133/633 ; D` marker = 最可靠（shell 注入语义明确、带退出码）；
   - 检测 `PS C:\...>` 正则 = 可行但脆弱（自定义提示符、多行提示符、非英文、ConPTY 重绘碎片都会破坏它）；VS Code 文档明确说 Windows 上"没有 shell integration 时 CWD 只能靠 regex 猜"，且 ConPTY 下"序列在缓冲中的位置不保证正确"（`IsWindows` 属性 + `HasRichCommandDetection` 的由来）。
   - **Windows Terminal 的 `autoMarkPrompts` 是终端侧的"每次 Enter 都当新提示符"启发式**（`Terminal.cpp` 745-769 行），不是 shell 信号；对"检测完成"无帮助。

---

## 1. PowerShell 5.1 的 `Prompt` 函数到底怎么被调用

### 1.1 调用链（源码级）

`ConsoleHost.cs` 顶层输入循环 `InputLoop.Run()`（≈2548-2610 行）每轮：

```csharp
string prompt = null;
...
// Then output the prompt
if (_parent.InDebugMode) { prompt = EvaluateDebugPrompt(); }
prompt ??= EvaluatePrompt();          // ← 每次读命令前调用 prompt 函数
...
ui.Write(prompt);                     // ← 把返回值写入控制台
line = ui.ReadLineWithTabCompletion(_exec);  // ← 然后才读输入
```

`EvaluatePrompt()`（2913-2922 行）：

```csharp
string promptString = _promptExec.ExecuteCommandAndGetResultAsString("prompt", out _);
if (string.IsNullOrEmpty(promptString))
{
    promptString = ConsoleHostStrings.DefaultPrompt;   // ← "PS> "
}
```

**关键事实**：
- `prompt` 是一个**命令**（函数），每次要显示提示符时由引擎执行，取**第一个输出对象的字符串形式**。
- **返回空/`$null` → 回退 `PS>`**。`about_Prompts` 官方文档原话："The default prompt appears only when the Prompt function generates an error **or does not return an object**"，并给出 `Write-Host` 例子（必须 `return " "` 否则回退）。
- 提示符**先写完再读输入**；`PSConsoleHostReadLine`（若存在）只影响"读输入"，不影响"求值/打印提示符"。

### 1.2 PSReadLine 加载/卸载对 `Prompt` 的影响

- **加载 PSReadLine 时**：`PSReadLine.psm1` 定义 `function PSConsoleHostReadLine { ... [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($host.Runspace, $ExecutionContext, $lastRunStatus) }`。ConsoleHost 的 `ReadLineWithTabCompletion()` → `TryInvokeUserDefinedReadLine()`（`ConsoleHostUserInterface.cs` 2187-2228 行）发现存在 `PSConsoleHostReadLine` 函数，就调用它。PSReadLine 的 `ReadLine()` → `InputLoop()` → `InvokePrompt()` → `GetPrompt()`，**里面又调一次 `prompt` 函数**（`ReadLine.cs` 1117-1181 行）——即 PSReadLine 场景下 `prompt` 会被**求值两次**（ConsoleHost 一次 + PSReadLine 一次；PSReadLine 用自己的渲染器画提示符）。这解释了 PSReadLine#468 "Prompt Double Execution"。
  - PSReadLine 的 `GetPrompt()` 同样有回退：`if (string.IsNullOrEmpty(newPrompt)) newPrompt = "PS>";`（1178-1180 行）。**所以"Write-Host + 无 return"在 PSReadLine 下同样回退 `PS>`**——这不是卸载 PSReadLine 后才出现的行为。
- **卸载 PSReadLine（`Remove-Module PSReadLine`）后**：`PSConsoleHostReadLine` 函数消失 → `TryInvokeUserDefinedReadLine` 返回 false → 走内置 `ReadLine()`（`ReadConsole`）。**`prompt` 的求值路径不受影响**（仍是 `EvaluatePrompt()`）。**因此"卸载 PSReadLine 后 Prompt 不生效"的说法不成立**——如果注入的函数正确 return 字符串，卸载前后都应该生效。
- **真正与 PSReadLine 相关的坑**：PSReadLine 开着时，提示符由 PSReadLine 的渲染器画（增量重绘、`PromptText` 染色、`ContinuationPrompt`），**marker 若放在提示符字符串里会经过 PSReadLine 的重绘逻辑**；若提示符换行数与 `-ExtraPromptLineCount` 不符，会看到碎片。但 marker 字节仍会出现在输出流中（PSReadLine 通过 `console.Write(newPrompt)` 写出）。**增量重绘的"碎片"主要是视觉/解析层面的，不是"函数没被调用"层面的**。

### 1.3 "PSReadLine 卸载后 Prompt 不生效"的其他候选解释

1. **注入脚本自身把 `prompt` 弄坏了**：例如注入的是 `function global:Prompt { Write-Host "..."; }`（无 return）→ 永远回退 `PS>`。这是**最可能**的根因（与文档示例完全吻合）。
2. **注入时机**：`powershell.exe -Command "注入..."` 场景下，`-Command` 执行完才进交互循环；若注入的脚本**在函数定义后立即被 `-Command` 的剩余逻辑覆盖**（如后续又执行了别的 profile/脚本重定义 prompt），或注入后进程直接退出，就看不到。
3. **作用域**：`global:` 限定符正确；但若另有 `$PROFILE` 在注入后定义 `function prompt`（大小写不敏感），后者覆盖前者。
4. **执行策略 / LanguageMode**：`ConstrainedLanguage` 下 `function` 定义可能被拒或函数体受限（VS Code 脚本对 `LanguageMode -ne FullLanguage` 直接 return）。
5. **ConPTY 侧**：注入的 marker 若用 `Write-Host "`e]133;D`a"` 打印，**它不在 prompt 返回值里**，会被 PSReadLine 重绘/ConPTY 缓冲搞乱或与"提示符行"分离；且 `Write-Host` 自带换行语义（除非 `-NoNewline`），会把 marker 推到错误的位置。

---

## 2. PSReadLine 的钩子盘点：`Set-PSReadLineOption` 有没有"提示符前执行脚本"？

**结论：没有。** 逐参数核实（官方 `Set-PSReadLineOption.md` + `ReadLine.cs`/`Cmdlets.cs` 源码）：

| 参数 | 真实作用 | 能否用于检测"命令完成" |
|---|---|---|
| `-PromptText` | 纯视觉：解析错误时把提示符**尾部子串染红**（默认 `"> "`；可给两段：正常段 + 错误段替代段）。`ReadLine.cs` 840-895 行：仅在 `_options.PromptText == null` 时分析 `prompt` 函数 AST（要求"纯"函数，无 CommandAst）来推断尾部；`Render.cs` 671-724 行据此翻转颜色。**不执行任何脚本**。 | ❌ 不是钩子 |
| `-AddToHistoryHandler` | `Func[string,Object]`：**命令执行前**（PSReadLine 把行加入历史时）回调，返回 `MemoryAndFile/MemoryOnly/SkipAdding/$true/$false` 决定是否入历史。**在 Enter 后、命令真正执行前**触发。 | ❌ 时机在"执行前"，且无法得知退出码 |
| `-CommandValidationHandler` | `Action[CommandAst]`：仅 `ValidateAndAcceptLine` 按键调用，用于校验/改写命令。 | ❌ |
| `-ViModeChangeHandler` | 仅 Vi 模式切换时调用。 | ❌ |
| `-ExtraPromptLineCount` | 提示符跨多行时预留的行数，避免重绘错位。 | 辅助（避免 marker 被重绘切碎），非检测 |
| `-ContinuationPrompt` | 多行输入的续行提示符文本。 | ❌ |
| `Set-PSReadLineKeyHandler` | 按键绑定（可绑定 `Enter` 等）。理论上可绑定 Enter 后执行脚本，但**拿不到命令退出码**，且会干扰正常 AcceptLine。 | 边缘可行、不推荐 |

**PSReadLine 提供的"重画提示符"机制是 `InvokePrompt()`**（`ReadLine.cs` 1062-1116 行）：清掉旧提示符 → `GetPrompt()`（内部执行 `prompt` 函数）→ `console.Write(newPrompt)` → `Render()`。**它没有公开的"每次提示符前运行回调"注册点**——要 hook 提示符，唯一官方机制就是**定义/替换 `prompt` 函数**。

---

## 3. VS Code 的 PowerShell shell integration 怎么实现（源码级）

### 3.1 注入方式

- VS Code 终端启动时设置 `env['TERM_PROGRAM'] = 'vscode'`（`terminalEnvironment.ts` 63 行），并通过启动参数/env 让 `shellIntegration.ps1` 在会话初始化时执行（自动注入；手动安装则往 `$PROFILE` 加 `if ($env:TERM_PROGRAM -eq "vscode") { . "$(code --locate-shell-integration-path pwsh)" }`）。
- 脚本本体：`src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1`（已解码存于 `docs/research/_src/vscode_shellIntegration.ps1`，290 行）。

### 3.2 核心机制：替换 `prompt`，marker 全部放进返回值

```powershell
$Global:__VSCodeState.OriginalPrompt = $function:Prompt   # 存原函数

function Global:Prompt() {
    $FakeCode = [int]!$global:?                            # 上次命令成败
    $LastHistoryEntry = Get-History -Count 1
    $Result = ""
    # 命令完成 → OSC 633 ; D [; <exitcode>]
    if ($Global:__VSCodeState.LastHistoryId -ne -1 -and (...)) {
        $Result += "$([char]0x1b)]633;D;$FakeCode`a"        # 或 D 无参数（空回车/ctrl+c）
    }
    # 提示符开始 → OSC 633 ; A
    $Result += "$([char]0x1b)]633;A`a"
    # CWD → OSC 633 ; P;Cwd=<escaped>
    $Result += if ($pwd.Provider.Name -eq 'FileSystem') { "$([char]0x1b)]633;P;Cwd=$(__VSCode-Escape-Value $pwd.ProviderPath)`a" }
    # 调用原 prompt（用户提示符原样保留在 marker 之间）
    $OriginalPrompt += $Global:__VSCodeState.OriginalPrompt.Invoke()
    $Result += $OriginalPrompt
    # 提示符结束/命令开始 → OSC 633 ; B
    $Result += "$([char]0x1b)]633;B`a"
    return $Result                                          # ← 关键：全部拼进返回值
}
```

- **为什么有效**：返回值是**非空字符串**（含 `PS> ` 原提示符 + marker），ConsoleHost `EvaluatePrompt()` 与 PSReadLine `GetPrompt()` 都接受 → 原提示符照常显示，marker 作为提示符字节流的一部分被写出。**没有任何 `Write-Host`**。
- 退出码语义：`$FakeCode = [int]!$global:?`（`$?` 取反转 int：成功→0，失败→1）——注意它反映的是 **PowerShell 错误状态**（`$?`），不是 `$LASTEXITCODE`；`D` 无参数表示"没有执行命令"（空回车/ctrl+c），`D;0`/`D;1` 表示命令完成。终端侧 `handleCommandFinished(exitCode)`：`exitCode === undefined` → 无命令；`0` → 成功；非 0 → 失败。

### 3.3 命令执行边界的补充：包装 `PSConsoleHostReadLine`（仅 PSReadLine 在时）

```powershell
$Global:__VSCodeState.OriginalPSConsoleHostReadLine = $function:PSConsoleHostReadLine
function Global:PSConsoleHostReadLine {
    $CommandLine = $Global:__VSCodeState.OriginalPSConsoleHostReadLine.Invoke()  # 读行（阻塞）
    $Global:__VSCodeState.IsInExecution = $true
    $Result = "$([char]0x1b)]633;E;" + $(__VSCode-Escape-Value $CommandLine) + "`a"  # 命令行
    $Result += "$([char]0x1b)]633;C`a"                                             # 开始执行
    [Console]::Write($Result)    # ← 直写 Console，避开 Write-Host 的换行
    $CommandLine
}
```

- **为什么用 `[Console]::Write` 而不是 `Write-Host`**：历史教训 vscode#142161——用 `Write-Host` 会破坏 PSReadLine 的预测/重绘 UI；直接写 `Console` 绕开宿主 UI 层。**这也印证：marker 的输出要走"返回字符串"或"`[Console]::Write`"，不要走 `Write-Host`。**
- **PSReadLine 不在时**：脚本不发 `E`/`C`（`HasPSReadLine = false`），仅靠 `prompt` 返回值里的 `A/B/D`——文档称此时为 "Basic" 质量（命令位置能定位，但无退出码/命令行），且明确说"没有 PSReadLine 时 shell integration 仍能工作，靠命令行序列兜底"（vscode#144215 修复：无 PSReadLine 时不包装读行，避免无限重绘）。

### 3.4 终端侧解析（VS Code `shellIntegrationAddon.ts`，已解码存 `_src/`）

- 注册 xterm OSC handler：`633`（VS Code 专属）、`133`（Final Term/FTCS）、`1337`（iTerm2）、`7`（CWD URI）、`9`（ConEmu/WT CWD）。
- `A`→`handlePromptStart()`；`B`→`handleCommandStart()`；`C`→`handleCommandExecuted()`；`D [;code]`→`handleCommandFinished(code)`；`E;cmd[;nonce]`→`setCommandLine`（带 nonce 校验防伪造）；`P;Prop=Value`→属性（`Cwd`/`IsWindows`/`HasRichCommandDetection`/`Prompt`/`PromptType`/`ContinuationPrompt`/`Task`）。
- **ConPTY 注意事项**：脚本发送 `P;IsWindows=True`（5.1 恒为 true），VS Code 据此启用"序列位置可能不准"的额外启发（`CommandDetectionCapability` 里 `isWindowsPty`），并在 `HasRichCommandDetection` 为 true 时信任 `A,B,E,C,D` 的精确顺序。**这直接说明：ConPTY 下 marker 的字节可能被重排/重绘，消费端必须有容错。**

---

## 4. PowerShell profile 注入的标准做法

- **`$PROFILE`（CurrentUserCurrentHost）**：`$HOME\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`（5.1）；`$PROFILE.CurrentUserAllHosts` = `$HOME\Documents\WindowsPowerShell\Profile.ps1`（对所有宿主生效，更适合"我们的 agent 注入"——但注意 VS Code 等宿主有各自 profile 文件，`Profile.ps1` 对它们也生效）。执行顺序：AllUsersAllHosts → AllUsersCurrentHost → CurrentUserAllHosts → CurrentUserCurrentHost（`about_Profiles`）。
- **执行策略**：默认 `Restricted` 会阻止 profile 运行（`about_Profiles` "Profiles and execution policy"）；agent 启动 `powershell.exe` 应带 `-ExecutionPolicy Bypass` 或确保 profile 可执行。
- **启动参数注入**：`powershell.exe -NoExit -Command ". 'C:\path\vale-init.ps1'"`（`-NoExit` 保持交互；`-Command` 后进交互循环时 prompt 会被求值）或 `-EncodedCommand`（避免引号转义地狱）。`-NoProfile` 会跳过用户 profile（干净但丢失用户环境）。
- **`-ExtraPromptLineCount`**：仅当提示符跨多行且 PSReadLine 开着时用于避免重绘错位；与"检测完成"无直接关系。
- **`AddToHistoryHandler`/`PromptText`**：见 §2，均不是完成检测钩子。
- **PSReadLine 卸载**：`Remove-Module PSReadLine` 会移除 `PSConsoleHostReadLine` 函数 → ConsoleHost 回退内置 `ReadConsole` 读行（输入能力降级：无历史、无补全，但对"提示符检测"无影响）。**不推荐**用"卸载 PSReadLine"来修 prompt——根因在 prompt 函数本身。

---

## 5. ConPTY 输出流层面检测的替代方案

### 5.1 ConPTY 的输出是什么（官方定义）

微软官方《Creating a Pseudoconsole session》：宿主从输出管道读到的是 **"graphical presentation information"（图形呈现信息）**，文档原文：

> "the hosting application can ... drain the read end of the output pipe ... **decode the text and virtual terminal sequence information**, and present that to the screen."

即：**ConPTY 输出 = conhost 渲染后的 VT/文本流**（Console API 调用被 VtEngine 翻译成 VT），**不是**程序的原始 stdout 字节。后果：
- 程序输出经过 conhost 缓冲/重绘/滚动，**可能与原始字节不同、顺序不同**（例如 PSReadLine 用 `CSI S` 滚动、全行重绘）；
- 但从**内容**上讲，可见文本与 marker（OSC）都会出现在流里——OSC 序列作为"不可见控制序列"被 VtEngine 透传（ConPTY pass-through 的已知问题见 `vscode-conpty-psreadline-known-issues.md`：历史上有截断 bug #4116）。
- 因此：**marker 检测（OSC 133/633）在 ConPTY 下可行**，但要容忍：marker 可能被重绘序列打断（增量重绘）、位置可能偏移（VS Code 文档 "the positioning of the shell integration sequences are not guaranteed to be correct"）、pass-through 偶尔吞字节。

### 5.2 方案对比

| 方案 | 可靠性 | 说明 |
|---|---|---|
| **A. shell 注入 + `prompt` 返回值携带 OSC 133/633 ; D**（推荐） | ★★★★★ | 语义明确（带退出码）、跨终端（133 是 FTCS 标准，WT/VS Code/iTerm2/kitty 都认）、不受提示符文本影响；消费端只需在输出流里找 `ESC ] 133 ; D [; <code>] (BEL|ESC \\)`。 |
| **B. 输出流正则 `PS C:\...>`** | ★★ | VS Code 文档明说 Windows 上无 shell integration 时 CWD 只能靠 regex（"not possible to get on Windows without trying to detect the prompt through regex"）；对自定义/多行/非英文提示符、ConPTY 重绘碎片极其脆弱；只能判定"大概回到提示符"，无退出码。可作为 A 缺失时的兜底。 |
| **C. 终端侧 Enter 启发式（WT `autoMarkPrompts`）** | ★★（对"完成检测"几乎无用） | `Terminal.cpp` 745-769：**每次 Enter 都当作新提示符起点**（`StartOutput()` + `ManuallyMarkRowAsPrompt`），纯粹是 UI 标记启发式，不知道命令是否真的结束。 |
| **D. 独立子进程 + waitpid（Claude Code/Codex/OpenHands 主流）** | ★★★★★（但改变了交互模型） | 见 `ai-agent-command-execution-research.md`：每次命令新起进程等退出码，天然精确；代价是没有持久 shell 状态。若 Vale 的 `terminal_execute` 场景允许，这是最稳的。 |
| **E. 双 sentinel / 唯一 marker 回显**（Netcatty 式） | ★★★★ | 注入 `echo __DONE_<nonce>__` 后等回显；但 ConPTY 回显可能被 PSReadLine 吞（输入回显属于 conhost 渲染路径），且污染输出。Netcatty 用的正是"唯一 marker + exit code 检测"（`netcatty-terminal-execute-marker-report.md`）。 |

### 5.3 业界做法

- **VS Code**：`shellIntegration.ps1` + `shellIntegrationAddon.ts`（见 §3）。
- **Windows Terminal**：官方教程让用户在 `$PROFILE` 放**返回 OSC 133 字符串的 `prompt` 函数**（`e]133;D;code`a + `e]133;A`a + `e]9;9;"cwd"`a + 提示符 + `e]133;B`a），并开 `"autoMarkPrompts": true`、`"showMarksOnScrollbar": true`（教程正文 + `profile-advanced.md`）。`autoMarkPrompts` 的 Enter 启发式是**给没做 shell 注入的用户**的降级方案（源码注释 GH#1527）。
- **oh-my-posh**：`init pwsh` 生成一个返回带 marker 字符串的 `prompt`（并在 `$PROFILE` 顶部执行）；WT 教程专门演示了"stash 原 prompt → 包一层 marker → 调回原 prompt"的写法（`$Global:__OriginalPrompt.Invoke()`）。
- **wtmux（Rust 终端复用器）**：声称"PowerShell 7 和 Windows PowerShell 5 在 `TERM_PROGRAM=vscode` 时自动发射 OSC 633"——这实际指的是**用户 profile 里已有的 VS Code 集成脚本**（或 VS Code PowerShell 扩展），**不是** PowerShell 引擎内置；我核对了 PowerShell/PSReadLine 源码，**没有**发现引擎内置的 633 发射逻辑（仅有 PowerShellEditorServices 的注释引用）。**结论：不要依赖"引擎自动发 633"，必须自己注入。**

---

## 6. 给 Vale 的具体建议（研究结论，不写代码）

1. **注入脚本只做一件事：替换 `prompt` 为"返回 marker 字符串"的版本**，结构照抄 VS Code/WT 官方示例：
   - 存原函数 → 新 `prompt` 内：`D`（带退出码，用 `$?` 或 `$LASTEXITCODE` 的判别逻辑）→ `A` → `P;Cwd=` → 原 prompt → `B` → `return` 拼接串。
   - 用 `[char]0x1b` 拼 ESC（5.1 没有 `` `e `` 转义），BEL（`[char]7`）做 ST。
   - **绝不用 `Write-Host` 发 marker**（要么进返回值，要么 `[Console]::Write`）。
   - 兼容 PSReadLine 开/关：marker 在返回值里，两种情况都出流。
2. **注入时机/入口**：优先 `$PROFILE.CurrentUserAllHosts` 或进程启动参数（`-NoExit -Command ". <script>"` / `-EncodedCommand`）；**注入后要能保证下一轮 prompt 求值发生**（`-Command` 结束后自然进入交互循环；`-NoExit` 保证不退出）。若担心第三方覆盖，注入脚本应放在 profile 链**最后**（CurrentUserCurrentHost）或启动参数里（启动参数晚于所有 profile）。
3. **消费端（Rust agent）**：在 ConPTY 输出流上做**流式 OSC 解析器**，匹配 `ESC ] 133 ; D (; <code>)? (BEL|ESC \\)`（以及兼容 `633`），把 `D` 视为"命令完成"事件；`D` 无参数 = 空回车/ctrl+c（不当作命令完成，或当作"取消"）。**不要**用正则去匹配提示符文本；正则只作降级兜底。
4. **退出码语义**：PowerShell 的"上条命令失败"有两个信号——`$?`（引擎错误状态）与 `$LASTEXITCODE`（原生程序退出码）。VS Code 用 `$?`（`[int]!$global:?`），WT 教程用 `$?` + `Get-History`/`$Error[0].InvocationInfo.HistoryId` 判别（区分"PS 报错"与"原生程序退出码"）。若要精确的 `$LASTEXITCODE`，需在 `prompt` 里读取它（注意 `prompt` 执行时 `$?` 还是上条命令的，`$LASTEXITCODE` 亦然——任何在 prompt 里跑的命令都会破坏它们，所以 VS Code 用 `$FakeCode = [int]!$global:?` 先取再恢复）。
5. **PSReadLine 开着时**：marker 随提示符重绘可能被拆成多段（增量重绘 diff），消费端解析器要**跨 chunk 累积 OSC 参数**再判定（直到遇到 BEL/ST 才算完整）；`-ExtraPromptLineCount` 设为提示符实际行数可减少重绘碎片。
6. **兜底**：同时保留"输出静默超时 + Enter 后新输出"启发式与独立子进程路径（参考 `ai-agent-command-execution-research.md` 的横向对比），但以 OSC D 为主信号。

---

## 7. 主要来源

**官方文档**
- [about_Prompts (PowerShell 5.1)](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_prompts?view=powershell-5.1)（"must return an object"、"Write-Host ... includes a Return statement. Without it, PowerShell uses the default prompt"）
- [about_Profiles (PowerShell 5.1)](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_profiles?view=powershell-5.1)（profile 路径/顺序/执行策略）
- [Set-PSReadLineOption (PSReadLine)](https://learn.microsoft.com/en-us/powershell/module/psreadline/set-psreadlineoption?view=powershell-7.4)（`-PromptText` 纯视觉、"The default value is `> `"、`-AddToHistoryHandler` 语义）
- [VS Code: Terminal Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration)（`OSC 633 ; A/B/C/D/E/P` 序列定义、"Windows uses ConPTY ... the pty handles rendering specially in such a way that the shell integration sequences ... may be misplaced"）
- [Windows Terminal: Shell Integration 教程](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)（pwsh `prompt` 注入完整示例、133 序列、`autoMarkPrompts` 配置）
- [Windows Terminal: profile-advanced（autoMarkPrompts/showMarksOnScrollbar）](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-advanced)
- [Microsoft Learn: Creating a Pseudoconsole session](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)（"decode the text and virtual terminal sequence information"——ConPTY 输出是渲染后 VT 流）

**源码（已下载至 `docs/research/_src/`）**
- `ConsoleHost.cs`（PowerShell master）：`InputLoop.Run()`、`EvaluatePrompt()` 2913-2922、`ReadLineWithTabCompletion` 2614
- `ConsoleHostUserInterface.cs`：`TryInvokeUserDefinedReadLine` 2187-2228（`PSConsoleHostReadLine` 探测）
- `PSReadLine/ReadLine.cs`：`GetPrompt()` 1117-1181（内部调 `prompt`、空→`PS>`）、`InvokePrompt()` 1062-1116、`PromptText` 分析 840-895
- `PSReadLine/PSReadLine.psm1`：`PSConsoleHostReadLine` 定义
- `vscode shellIntegration.ps1`（main，290 行，完整解码）
- `vscode shellIntegrationAddon.ts`（main，OSC 解析/能力注册）
- `vscode terminalEnvironment.ts`（`TERM_PROGRAM='vscode'` 注入，63 行）
- `microsoft/terminal Terminal.cpp`（`autoMarkPrompts` Enter 启发式 745-769）
- `microsoft/terminal doc/specs/#13000 - In-process ConPTY.md`（ConPTY 与终端缓冲可能不同步的架构性说明）

**Issue / 社区**
- [PowerShell/PSReadLine#468 — Prompt Double Execution](https://github.com/PowerShell/PSReadLine/issues/468)（PSReadLine 场景 prompt 求值两次）
- [microsoft/vscode#142161 — enableShellIntegration breaks PSReadLine](https://github.com/microsoft/vscode/issues/142161)（`[Console]::Write` 替代 `Write-Host` 的历史）
- [microsoft/vscode#144215 — Shell Integration without PSReadLine](https://github.com/microsoft/vscode/issues/144215)（无 PSReadLine 时不包装读行）
- [microsoft/vscode#73254344 — "←]633;P;IsWindows=True" 提问](https://stackoverflow.com/questions/73254344/vs-code-powershell-%e2%86%90633piswindows-true)（社区对 633 流的观察）
- [oh-my-posh#3795 — Final Term command marks](https://github.com/JanDeDobbeleer/oh-my-posh/issues/3795)（FTCS 133 序列被 WT/VS Code/kitty 支持的佐证）
- [wtmux README](https://github.com/fukuyori/wtmux)（"PowerShell 自动发射 OSC 633 当 TERM_PROGRAM=vscode"——已核实为 profile 注入产物而非引擎内置）

---

## 附：已核实的源码关键行

```
ConsoleHost.cs 2569-2601:  prompt = EvaluatePrompt(); ui.Write(prompt); line = ui.ReadLineWithTabCompletion(_exec);
ConsoleHost.cs 2913-2922:  ExecuteCommandAndGetResultAsString("prompt"); if IsNullOrEmpty → DefaultPrompt "PS>"
ConsoleHostUserInterface.cs 2187:  private const string CustomReadlineCommand = "PSConsoleHostReadLine";
ConsoleHostUserInterface.cs 2193-2228:  TryInvokeUserDefinedReadLine: GetCommands("PSConsoleHostReadLine", Function|Cmdlet) → Invoke()
PSReadLine.psm1:  function PSConsoleHostReadLine { ... [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine(...) }
ReadLine.cs 1117-1181:  GetPrompt(): ps.AddCommand("prompt"); ps.Invoke<string>(); if IsNullOrEmpty → "PS>"
ReadLine.cs 1062-1116:  InvokePrompt(): GetPrompt() → console.Write(newPrompt) → Render()
ReadLine.cs 840-895:  PromptText 自动推断（仅当 prompt 函数 AST 是"纯"表达式）
vscode shellIntegration.ps1 106-165:  function Global:Prompt { ... $Result += ESC]633;D;...; ESC]633;A; P;Cwd=...; 原 prompt; ESC]633;B; return $Result }
vscode shellIntegration.ps1 214-238:  function Global:PSConsoleHostReadLine { 原读行; ESC]633;E;cmd; ESC]633;C; [Console]::Write($Result) }
vscode shellIntegrationAddon.ts:  registerOscHandler(633/133/1337/7/9); A→handlePromptStart; B→handleCommandStart; C→handleCommandExecuted; D→handleCommandFinished(exitCode)
Terminal.cpp 745-769:  if (_autoMarkPrompts && _mainBuffer && !_inAltBuffer()) { StartOutput(); ManuallyMarkRowAsPrompt(cursor.y); }
```
