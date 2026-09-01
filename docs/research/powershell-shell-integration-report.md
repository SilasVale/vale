# PowerShell 5.1 + ConPTY：命令完成检测——三个核心问题研究报告（最终版）

> 研究日期：2026-09-01。本报告只回答三个核心问题，不展开其他细节。
> 证据来源：PowerShell/PSReadLine/VS Code/Windows Terminal 源码（存于 `docs/research/_src/`：`ConsoleHost.cs`、`ConsoleHostUserInterface.cs`、`ReadLine.cs`、`Render.cs`、`vscode_shellIntegration.ps1`、`vscode_shellIntegrationAddon.ts`、`wt_terminal.cpp`）+ 官方文档 + 本仓库既有 Netcatty 调研（`netcatty-terminal-execute-marker-report.md`）。完整机制版见 `docs/research/powershell-prompt-detection-conpty.md`。

---

## Q1. PowerShell 5.1 的 Prompt 函数在 PSReadLine 卸载后是否还被 ConsoleHost 调用？（我们实测卸载后无 OSC 133 marker 输出）

**答：机制上，ConsoleHost 一定还会调用 `prompt` 函数——卸载 PSReadLine 不影响 prompt 的求值路径。但"无 OSC 133 marker 输出"是真实且可解释的现象，两者不矛盾。**

### 1.1 机制：ConsoleHost 每轮读命令前必调 prompt（源码证据）

`ConsoleHost.cs` 顶层输入循环 `InputLoop.Run()`（2548-2610 行）每轮：

```csharp
prompt ??= EvaluatePrompt();                 // ← 每次读命令前执行 prompt 函数
ui.Write(prompt);                            // ← 把返回值写入控制台
line = ui.ReadLineWithTabCompletion(_exec);  // ← 之后才读输入
```

`EvaluatePrompt()`（2913-2922 行）：

```csharp
string promptString = _promptExec.ExecuteCommandAndGetResultAsString("prompt", out _);
if (string.IsNullOrEmpty(promptString))
{
    promptString = ConsoleHostStrings.DefaultPrompt;   // ← "PS>"
}
```

PSReadLine 只接管"读行"：`ConsoleHostUserInterface.cs` 的 `TryInvokeUserDefinedReadLine()`（2187-2228 行）探测到 `PSConsoleHostReadLine` 函数就调用它（该函数由 `PSReadLine.psm1` 定义）；`Remove-Module PSReadLine` 后该函数消失 → 回退内置 `ReadConsole` 读行。**prompt 的求值/打印在 ConsoleHost 侧，与 PSReadLine 无关，卸载后照常每轮调用。**

### 1.2 为什么实测"卸载后无 OSC 133 marker 输出"——三种必查原因

1. **注入的 prompt 函数没有把 marker 放进返回值，或返回值非字符串**（最可能）。`EvaluatePrompt()` 取 `prompt` 命令的**第一个输出对象的字符串**；若我们的函数是：
   ```powershell
   function global:Prompt { Write-Host "`e]133;D`a"; return "PS> " }
   ```
   表面看 return 了 `"PS> "`（非空，不会回退），**但 `Write-Host` 的输出根本不在返回值里**——marker 是在 `prompt` 函数体执行期间被直接写到控制台的，而不是作为提示符字符串的一部分。ConsoleHost 把 `"PS> "` 写屏后，PSReadLine（若还在）会用自己的渲染器重绘提示符（清行/重画），把先前 `Write-Host` 打出的 marker **清掉**；PSReadLine 卸载后虽无重绘，但 marker 与提示符字节流分离，**ConPTY 缓冲/滚动路径下位置错乱或被吞**。**只要 marker 不在 `return` 的字符串里，就不可靠。**
2. **注入时机**：提示符已显示后才注入 → 当前轮不重绘，必须等下一次回车后的 `EvaluatePrompt()` 才生效。若测试流程"注入后立即读输出"，等不到 marker 是正常的。
3. **prompt 被覆盖**：`$PROFILE`/oh-my-posh/posh-git/VS Code 扩展在注入后重新定义 `prompt`（大小写不敏感），覆盖我们的 global 版本。

### 1.3 关键结论（对 Q1 的最终回答）

- **函数被调用：是**（卸载前后都调用，与 PSReadLine 无关）。
- **marker 没输出：因为我们的注入方式把 marker 放在了返回值之外**（Write-Host 旁路），而不是"prompt 没被调用"。
- **验证方法**：注入后手动执行 `prompt` 看返回值是否含 marker；或在 `prompt` 里 `Write-Output "###MARKER###"`（返回字符串的一部分）而不是 `Write-Host`。

---

## Q2. VS Code 的 shellIntegration.ps1 覆盖 Global:Prompt + return $Result 为什么有效？我们注入的 Write-Host 版为什么无效？

**答：核心差异 = marker 是否在 `prompt` 的返回值里。**

### 2.1 VS Code 的做法（`_src/vscode_shellIntegration.ps1`，290 行，已完整解码）

```powershell
$Global:__VSCodeState.OriginalPrompt = $function:Prompt   # 1. 存原函数

function Global:Prompt() {
    $FakeCode = [int]!$global:?                            # 2. 先取 $?（函数体内任何命令会破坏它）
    $LastHistoryEntry = Get-History -Count 1
    $Result = ""
    $Result += "$([char]0x1b)]633;D;$FakeCode`a"           # 3. 命令完成 + 退出码（OSC 633;D）
    $Result += "$([char]0x1b)]633;A`a"                     # 4. 提示符开始（OSC 633;A）
    $Result += "$([char]0x1b)]633;P;Cwd=...`a"             # 5. CWD 属性
    if ($FakeCode -ne 0) { Write-Error "failure" -ea ignore }  # 6. 恢复 $? 语义
    $Result += $Global:__VSCodeState.OriginalPrompt.Invoke()   # 7. 调用原用户提示符
    $Result += "$([char]0x1b)]633;B`a"                     # 8. 提示符结束（OSC 633;B）
    return $Result                                         # 9. 全部拼进返回值
}
```

### 2.2 为什么有效

1. **返回值是非空字符串** → ConsoleHost `EvaluatePrompt()` 不回退、PSReadLine `GetPrompt()` 不回退（两个求值点都执行 `prompt`，都拿到完整字符串）。
2. **marker 是提示符字符串的一部分** → 无论提示符由 ConsoleHost（`ui.Write(prompt)`）还是 PSReadLine 渲染器（`console.Write(newPrompt)`）写出，marker 字节都随之出流。PSReadLine 的增量重绘只 diff 这个字符串，OSC 序列作为文本被写出（行数对齐后不丢字节）。
3. **命令执行边界（`633;E` 命令行 / `633;C` 开始执行）由包装的 `PSConsoleHostReadLine` 发出**，用 `[Console]::Write` 直写（不用 `Write-Host`，因为它插入换行破坏 PSReadLine 重绘——vscode#142161 的教训）。
4. **`$FakeCode = [int]!$global:?` 先取值再恢复**：`prompt` 体内任何命令都会改写 `$?`，所以开头取、用 `Write-Error -ea ignore` 恢复后再调原 prompt，保证原提示符看到的 `$?` 正确。

### 2.3 我们注入的 Write-Host 版为什么无效

```powershell
function global:Prompt { Write-Host "`e]133;D`a"; return "PS> " }
```

- `Write-Host` 的输出**不进返回值**，直接写控制台 → 与提示符渲染路径脱节：
  - PSReadLine 在：`prompt` 被求值两次（ConsoleHost + PSReadLine `GetPrompt`），PSReadLine 渲染器清行重绘会把 `Write-Host` 打的 marker 擦掉/错位（重绘 diff 不包含它）。
  - PSReadLine 卸载：无重绘，但 marker 独立于提示符字节流，ConPTY 渲染/滚动路径下位置不保证，且与"提示符字符串"无关联，消费端无法稳定配对。
- 若 `return` 的是 `$null`/空（常见笔误），ConsoleHost 和 PSReadLine **双双回退 `PS>`**，marker 完全丢失。
- **一句话：VS Code 有效 = marker 进 `return` 字符串（与提示符同生共死）；我们无效 = marker 走 Write-Host 旁路（在渲染路径之外）。**

---

## Q3. Netcatty"命令包装" vs VS Code"Prompt 注入"，ConPTY PowerShell 5.1 下哪个更可靠？

**答：Netcatty 方案显著更可靠，是 Vale 应采用的完成检测主路径。** 对比（细节见 `netcatty-terminal-execute-marker-report.md`）：

| 维度 | Netcatty（包装命令 + 纯文本 marker） | VS Code（OSC 633 + Prompt 注入） |
|---|---|---|
| 完成信号 | 键入 `& { Write-Output '<marker>_S'; ...; Write-Output '<marker>_E:<rc>' }\r\n`，**原始字节流纯文本行匹配** | `prompt` 返回值里嵌 `ESC]633;D;<code>`，消费端做 **OSC 序列解析** |
| 依赖链 | 只依赖"PTY 键入 → 命令执行 → 文本回显"。**不碰 prompt、不依赖任何控制序列被识别** | 依赖整条链：注入生效 → prompt 被调用 → 返回值含 marker → OSC 被 ConPTY 透传 → 不被重绘/重排破坏（Q1/Q2 已证明这条链处处是坑） |
| ConPTY 行为 | 文本行是 conhost 渲染核心职责，**必然原样透传** | ConPTY 输出是渲染后的 VT 流，OSC 透传历史上有截断/错位 bug（microsoft/terminal #4116）；VS Code 文档明说 ConPTY 下 "sequences may be misplaced"（`IsWindows`/`HasRichCommandDetection` 属性就是为此加的容错） |
| 注入失效风险 | 无（不修改 prompt，用户 profile/oh-my-posh/posh-git 随便覆盖 prompt 都不影响） | 高（prompt 被覆盖、注入时机、Write-Host 不返回值、LanguageMode——我们踩的坑全在这） |
| 退出码准确性 | **高**：`$LASTEXITCODE=$null` 清空 → `Invoke-Expression` → `if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }` + `catch { rc=1 }`，**区分原生 exe 退出码与 cmdlet 成败**（原生 exe 失败不抛异常、`$?` 可能仍为 true 的坑被绕开） | **低**：`[int]!$global:?` 只反映引擎 `$?`；WT 教程需 `$Error[0].InvocationInfo.HistoryId` 判别，复杂脆弱 |
| 幂等/可重试 | 每次独立 128 位随机 marker，重试零串扰 | 全局状态机（LastHistoryId/IsInExecution），一次失败影响后续 |
| 已知代价 | 命令包进脚本块（子 shell 语义：`cd`/环境变量不跨命令持久）；需行首边界防回声误判；`\r\n` 结尾必需；需无输出超时兜底（默认 60s） | 无此代价，但可靠性代价更大 |

**Netcatty 在 ConPTY/PS5.1 下成立的三个关键细节**：
1. **纯文本 marker 走普通文本回显路径**，ConPTY 必然透传文本——对"OSC 被吞"类失效根本免疫。
2. **`\r\n` 结尾**（源码显式）——PS5.1/ConPTY 下回车换行缺一不可。
3. **防回声误判**：end marker 在 start 确认前要求**行首边界**（`findEndMarker`），确认后允许 inline；跨 chunk 用 carry 拼接；用 `Write-Output`（成功输出流、纯文本行）而非 `Write-Host`。

**结论（对 Vale 的最终建议）**：
- **主路径**：Netcatty 式"键入包装命令 + 唯一纯文本 marker + `$LASTEXITCODE` 判别"——可靠、零注入依赖、退出码准确、可重试。
- **可选增强**：OSC 133/633 Prompt 注入只用于"用户可见的 shell integration 标记"（WT/VS Code 风格），**绝不作为完成检测的依赖**；若要解析 OSC，消费端必须跨 chunk 累积、容忍重绘碎片与位置偏移。
- **兜底**：无输出超时（60s）+ 可选 prompt 形态文本匹配（`PS ...>` 仅作第二完成信号）。

---

## 主要来源

- PowerShell 源码：`ConsoleHost.cs`（`InputLoop.Run` 2548-2610、`EvaluatePrompt` 2913-2922）、`ConsoleHostUserInterface.cs`（`TryInvokeUserDefinedReadLine` 2187-2228）——`docs/research/_src/`
- PSReadLine 源码：`ReadLine.cs`（`GetPrompt` 1117-1181、`InvokePrompt` 1062-1116）、`PSReadLine.psm1`——`docs/research/_src/`
- VS Code：`shellIntegration.ps1`（main 完整解码）、`shellIntegrationAddon.ts`（OSC 解析）、[官方文档](https://code.visualstudio.com/docs/terminal/shell-integration)（633 序列 + ConPTY 位置不保证）
- 官方文档：[about_Prompts (5.1)](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_prompts?view=powershell-5.1)（必须返回对象）、[Creating a Pseudoconsole session](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)（ConPTY 输出 = 渲染后 VT 流）、[WT Shell Integration 教程](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)（133 序列 + prompt 注入示例）
- Issue：vscode#142161（`[Console]::Write` 替代 `Write-Host`）、vscode#144215（无 PSReadLine 时不包装读行）、PSReadLine#468（prompt 双求值）、microsoft/terminal #4116（ConPTY pass-through 截断）
- Netcatty：`netcatty-terminal-execute-marker-report.md`（`ptyExecHelpers.cjs buildWrappedCommand` PowerShell 包装源码 + `findEndMarker` 逻辑）
