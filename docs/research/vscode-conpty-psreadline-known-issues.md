# VS Code Integrated Terminal — Known Issues: Windows ConPTY & PowerShell PSReadLine

Research notes for an architecture report. All issues below were fetched and verified
from GitHub (issue bodies + maintainer comments). Issue numbers are real; nothing is invented.

---

## ConPTY output ordering/loss issues

### microsoft/vscode #146450 — Terminal "loses" entered command when its output is exact terminal height
- **Status:** Closed (2022-04-01), labelled `upstream`, `terminal-conpty`, `windows`. Not fixed in VS Code — redirected upstream.
- **Symptom:** When a command's output is exactly tall enough to push the prompt to the topmost line, the previous command line disappears from scrollback when you scroll up (output appears to "merge" across commands).
- **Root cause (as stated by maintainer Tyriar):** "almost certainly it's related to conpty which we wouldn't be able to do anything about anyway" — the issue originates from an upstream component (ConPTY), not VS Code code.
- **Resolution/workaround:** Closed as upstream; user reproduced it in Windows Terminal and filed microsoft/terminal #12805. VS Code's guidance is that ConPTY bugs should be reported to microsoft/terminal, and that a fix may arrive in a later Windows build.
- **Source:** https://github.com/microsoft/vscode/issues/146450 (comment https://github.com/microsoft/vscode/issues/146450#issuecomment-1085708891)

### microsoft/terminal #12805 — Previous command disappears from the terminal output when it fills the current terminal height
- **Status:** Closed 2023-08-09 (root cause found: PSReadLine). Milestone "Backlog".
- **Symptom:** Same as #146450, reproduced in Windows Terminal: the previously executed command line vanishes from scrollback when the new output fills the viewport.
- **Root cause (as stated by maintainer zadjii-msft):** "we think this might be a known issue in older versions of PsReadline: PowerShell/PSReadLine#724". The reporter confirmed it went away after installing PSReadLine 2.2.6 side-by-side. So what looks like "ConPTY dropping output" was actually PSReadLine's broken `CSI S` scroll-buffer handling in older versions.
- **Resolution:** Updating/removing PSReadLine fixed it; not a ConPTY buffer-loss bug per se.
- **Source:** https://github.com/microsoft/terminal/issues/12805 (comments https://github.com/microsoft/terminal/issues/12805#issuecomment-1672179454, https://github.com/microsoft/terminal/issues/12805#issuecomment-1672202169)

### microsoft/terminal #4116 — ConPTY pass-through sequences are being truncated
- **Status:** Closed 2020-01-08, fixed in Terminal v0.8 (milestone "Terminal v0.8"), `Resolution-Fix-Committed`, `Severity-Blocking`, P1.
- **Symptom:** Unrecognized VT sequences passed through ConPTY got truncated; the missing final character left the VT state machine "waiting for a final character", eating the following text (`printf "\e[?999h 12345 Hello World"` rendered only `ello World`).
- **Root cause (maintainer j4james):** a regression from PR #3956 — the `_run` calculation in the VT state machine was off by 1 for pass-through; more broadly, ConPTY's "pass-through" concept is dangerous because conhost and the client can go out of sync.
- **Resolution:** Fix committed for the next release; maintainer miniksa acknowledged the regression. This is a concrete example of ConPTY corrupting/truncating output.
- **Source:** https://github.com/microsoft/terminal/issues/4116 (comment https://github.com/microsoft/terminal/issues/4116#issuecomment-570930151)

### microsoft/vscode #45693 — Windows terminal issues caused by winpty (meta-issue)
- **Status:** Closed 2018-12-21 (resolved by replacing winpty with ConPTY).
- **Symptom:** Meta-issue listing winpty-era output corruption: "Output being dropped for some programs" (#42847), "Resizing the terminal will duplicate lines (and generally corrupt the current viewport)" (#26375), "Lines are duplicated when viewport is narrow" (#47088), "Characters get stuck in viewport in wrong spot in PowerShell" (this issue), colors/escape issues, sub-shell (ghci/python) problems.
- **Root cause (maintainer Tyriar):** winpty was unmaintained and had numerous emulation bugs; the fix was to adopt Microsoft's official ConPTY backend. "ConPTY support is landing in the next Insiders build… this is expected to fix many bugs in the terminal on Windows as we're adopting Microsoft's official pty API."
- **Resolution/workaround:** ConPTY became the backend; on older Windows builds (17692+, then 18309+ required) users could opt out via `"terminal.integrated.windowsEnableConpty": false`. winpty remained for older builds with bugs unresolved.
- **Source:** https://github.com/microsoft/vscode/issues/45693 (comments https://github.com/microsoft/vscode/issues/45693#issuecomment-449495252, https://github.com/microsoft/vscode/issues/45693#issuecomment-456937675)

### microsoft/vscode #132715 — Vscode's terminal can't display non-english letters correctly (characters duplicated)
- **Status:** Closed 2021-10-19, labelled `upstream` + `terminal-conpty`; listed in the VS Code wiki "Terminal Issues" as a **long-standing known issue** ("Non-English characters duplicated on Windows").
- **Symptom:** When echoing non-ASCII text (Chinese, Japanese) in PowerShell on Windows 7 (winpty era), each character appears duplicated.
- **Root cause (maintainer meganrogge):** "looks like it is displaying them, but when echoed each character is duplicated" — i.e. double-echo/rendering; closed as upstream ConPTY/winpty-related, not fixable in VS Code.
- **Resolution:** Closed as upstream; reproduce in Windows Terminal and report to microsoft/terminal.
- **Source:** https://github.com/microsoft/vscode/issues/132715 (comments https://github.com/microsoft/vscode/issues/132715#issuecomment-927996878, https://github.com/microsoft/vscode/issues/132715#issuecomment-947012133)

---

## PSReadLine interaction issues

### microsoft/vscode #142161 — enableShellIntegration breaks PowerShell PSReadLine module in terminal
- **Status:** Closed 2022-02-04, milestone "February 2022", labels `bug`, `verified`, `insiders-released`, `terminal-shell-integration`.
- **Symptom:** With `terminal.integrated.enableShellIntegration: true`, PSReadLine history predictions (ListView style) stopped showing in pwsh 7.2; the reporter's PSReadLine-based prompt behaved differently.
- **Root cause:** VS Code's shell integration script (shellIntegration.ps1) hooks `PSConsoleHostReadLine`, which conflicts with PSReadLine's own rendering/prediction. A contributor suggested emitting the command-executed sequence (`ESC]133;C`) directly via `[Console]::Write` instead of `Write-Host`.
- **Resolution:** Fixed in Insiders (label `insiders-released`), milestone Feb 2022; Tyriar had to revert an earlier attempt (PR #142211) and a corrected fix shipped. The fix was to write the shell-integration marker directly to the console rather than through PSReadLine's `Write-Host`, so PSReadLine UI (predictions) is no longer disrupted.
- **Source:** https://github.com/microsoft/vscode/issues/142161 (comments https://github.com/microsoft/vscode/issues/142161#issuecomment-1030120390, https://github.com/microsoft/vscode/issues/142161#issuecomment-1030356182, https://github.com/microsoft/vscode/issues/142161#issuecomment-1051116738)

### microsoft/vscode #144215 — Shell Integration without PSReadLine in PowerShell
- **Status:** Closed 2022-03-02, milestone "March 2022", `bug`, `verified`, `insiders-released`, `accessibility`, `terminal-shell-integration`.
- **Symptom:** When PSReadLine is disabled (e.g. PowerShell detects a screen reader via the "Blind Access" registry flag), shell integration causes "the prompt gets printed over and over and over again without any way to interrupt it".
- **Root cause (maintainer Tyriar):** shellIntegration.ps1 relies on PSReadLine's `PSConsoleHostReadLine` hook; without PSReadLine, the prompt re-render loop breaks and re-emits the prompt infinitely. Workaround: disable shell integration.
- **Resolution:** Fixed for March 2022 — Tyriar: "we can just avoid this all together if PSReadLine is not loaded since on Windows we end up sending the whole command line anyway" (skip shell-integration readline hooks when PSReadLine isn't loaded).
- **Source:** https://github.com/microsoft/vscode/issues/144215 (comments https://github.com/microsoft/vscode/issues/144215#issuecomment-1057181408, https://github.com/microsoft/vscode/issues/144215#issuecomment-1057182444)

### microsoft/vscode #236841 — Shell Integration Script for Powershell 7 Terminals (shellIntegration.ps1) is adding junk data into the console after typing more than one character
- **Status:** Closed 2025-01-08 as `*duplicate`.
- **Symptom:** Typing more than one character in a PowerShell 7 terminal polluted the terminal with "a bunch of random grayed out code"; only occurred in non-default shell-integration terminals.
- **Root cause:** The reporter suspected shellIntegration.ps1's interaction with PSReadLine (the script "is doing a lot of interaction with it"). Closed as duplicate (of the main shell-integration/PSReadLine tracking issue).
- **Resolution:** Closed as duplicate — no separate fix.
- **Source:** https://github.com/microsoft/vscode/issues/236841

### PowerShell/PSReadLine #724 — Using CSI # S to scroll screen buffer is incorrect and can lead to data loss
- **Status:** Closed 2018-11-05 (fixed in PSReadLine).
- **Symptom:** PSReadLine emits `CSI 1 S` (scroll-up) to move the prompt to the bottom of the screen; doing so "can destroy the user's scrollback buffer" and forces expensive full-buffer repaints over VT links (ssh/pty).
- **Root cause (DHowett-MSFT, Windows Console team):** PSReadLine's viewport-scroll hack is incorrect and destructive to scrollback. This is the upstream bug that microsoft/terminal #12805 was ultimately attributed to — i.e. PSReadLine *causing* what looks like ConPTY output loss.
- **Resolution:** Fixed in PSReadLine (closed 2018); users with old PSReadLine versions should update (≥2.2.6 confirmed to resolve #12805).
- **Source:** https://github.com/PowerShell/PSReadLine/issues/724

---

## VS Code mitigations & documented limitations

### `terminal.integrated.windowsEnableConpty` — introduced, then removed
- **History:** Introduced around VS Code 1.30-era (2018) as the opt-out for the then-new ConPTY backend on Windows: `"terminal.integrated.windowsEnableConpty": false` restored winpty. Maintainer Tyriar announced ConPTY as default in Insiders and provided this opt-out in comment on #45693 (2018-12-21). Later (2019) the required Windows build was raised from 17692+ to 18309+ because ConPTY "was not stable on 17692".
- **Current state:** The setting is **completely removed** from VS Code's current settings schema. Verified against `main` (2026): `src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts` contains only `terminal.integrated.windowsUseConptyDll` ("Whether to use the conpty.dll (v1.25.260303002) shipped with VS Code, instead of the one bundled with Windows"), and `src/vs/workbench/contrib/terminal/common/terminal.ts`/`platform/terminal/common/terminal.ts` show only `windowsUseConptyDll` in `ITerminalProcessOptions` — ConPTY is now the only Windows backend; winpty is gone (node-pty removed winpty support, microsoft/node-pty #842).
- **Sources:**
  - https://github.com/microsoft/vscode/issues/45693#issuecomment-449495252 (introduction + opt-out)
  - https://github.com/microsoft/vscode/issues/45693#issuecomment-456937675 (build 18309+ requirement)
  - https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts (current schema; no windowsEnableConpty)
  - https://github.com/microsoft/node-pty/issues/842 (winpty removal)

### VS Code wiki: "Terminal Issues" — official known-issues & ConPTY-consumption policy
- The VS Code wiki page (github.com/microsoft/vscode/wiki/Terminal-Issues) is the official list of long-standing terminal known issues and documents how VS Code consumes ConPTY:
  - Long-standing known issues include #45693 (winpty/ConPTY emulation), #43169, #35901, xterm.js #1059, and #132715 (non-English chars duplicated on Windows).
  - "Why did you close my issue?": ConPTY is a dependency built by the Windows Terminal team and shipped as part of Windows; VS Code closes ConPTY-related issues as upstream, even if they don't reproduce in Windows Terminal, because "it's most likely fixed in a later version of Windows".
  - winpty is deprecated and not improved; "the fix for problems in winpty is to move to the maintained official Microsoft backend conpty".
  - Provides a debugging tool (ConsoleMonitor.exe) to inspect the actual buffer maintained by ConPTY during sync issues.
- **Source:** https://github.com/microsoft/vscode/wiki/Terminal-Issues (raw: https://raw.githubusercontent.com/wiki/microsoft/vscode/Terminal-Issues.md)

### ConPTY documented limitations (microsoft/terminal, primary sources)
- **"In-process ConPTY" design doc (issue #13000)** — the terminal team's own statement of ConPTY's architectural limitations (author Leonard Hecker, 2024):
  - "ConPTY runs outside the hosting terminal which leads to an **unsolvable issue**: The buffer contents between ConPTY and the terminal can go out of sync."
  - Causes: terminal and ConPTY may implement escape sequences/text processing/reflow (resize) differently; resizing is asynchronous with possible concurrent text output; scrollback text may be uncovered that ConPTY doesn't know about.
  - "VT input from the shell or other clients will be given 1:1 to the hosting terminal, **which will resolve our ordering and buffering issues**" — i.e. the current architecture has known ordering/buffering issues that the redesign (in-process ConPTY) is meant to fix.
  - Some Console API features (e.g. LVB gridlines) have no VT equivalent and cannot be represented through ConPTY output at all.
  - Source: https://github.com/microsoft/terminal/blob/main/doc/specs/%2313000%20-%20In-process%20ConPTY.md
- **Resize quirk (#16911 "Document the resize quirk for ConPTY")** — closed 2024-08-01:
  - On `ResizePseudoConsole` growing the buffer, ConPTY re-emits the reflowed buffer and **overwrites current terminal content**; the undocumented `PSEUDOCONSOLE_RESIZE_QUIRK` flag suppresses that output and was confirmed working in the latest ConPTY.dll. Maintainer zadjii-msft: the quirk "is expecting the hosting terminal application to be able to reflow their own buffer in the same way conpty does" — no one else had tried it.
  - Source: https://github.com/microsoft/terminal/issues/16911 (comments https://github.com/microsoft/terminal/issues/16911#issuecomment-2014824295, https://github.com/microsoft/terminal/issues/16911#issuecomment-2024042366)
- **ConPTY pass-through truncation (#4116)** — see above; also demonstrates that ConPTY's VT pass-through can corrupt output when conhost and client disagree.
- **ConPTY cursor desync after pass-through of unrecognized VT sequences (#19926)** — mentioned in search results (microsoft/terminal, open); confirms ongoing "desync" class of bugs, but I did not fetch its body, so treat as a pointer only.

---

## URL list (all used)

- https://github.com/microsoft/vscode/issues/146450
- https://github.com/microsoft/vscode/issues/146450#issuecomment-1085708891
- https://github.com/microsoft/terminal/issues/12805
- https://github.com/microsoft/terminal/issues/12805#issuecomment-1672179454
- https://github.com/microsoft/terminal/issues/12805#issuecomment-1672202169
- https://github.com/microsoft/terminal/issues/4116
- https://github.com/microsoft/terminal/issues/4116#issuecomment-570930151
- https://github.com/microsoft/vscode/issues/45693
- https://github.com/microsoft/vscode/issues/45693#issuecomment-449495252
- https://github.com/microsoft/vscode/issues/45693#issuecomment-456937675
- https://github.com/microsoft/vscode/issues/132715
- https://github.com/microsoft/vscode/issues/132715#issuecomment-927996878
- https://github.com/microsoft/vscode/issues/132715#issuecomment-947012133
- https://github.com/microsoft/vscode/issues/142161
- https://github.com/microsoft/vscode/issues/142161#issuecomment-1030120390
- https://github.com/microsoft/vscode/issues/142161#issuecomment-1030356182
- https://github.com/microsoft/vscode/issues/142161#issuecomment-1051116738
- https://github.com/microsoft/vscode/issues/144215
- https://github.com/microsoft/vscode/issues/144215#issuecomment-1057181408
- https://github.com/microsoft/vscode/issues/144215#issuecomment-1057182444
- https://github.com/microsoft/vscode/issues/236841
- https://github.com/PowerShell/PSReadLine/issues/724
- https://github.com/microsoft/vscode/wiki/Terminal-Issues
- https://raw.githubusercontent.com/wiki/microsoft/vscode/Terminal-Issues.md
- https://github.com/microsoft/terminal/blob/main/doc/specs/%2313000%20-%20In-process%20ConPTY.md
- https://github.com/microsoft/terminal/issues/16911
- https://github.com/microsoft/terminal/issues/16911#issuecomment-2014824295
- https://github.com/microsoft/terminal/issues/16911#issuecomment-2024042366
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/terminal.ts
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/terminal.ts
- https://github.com/microsoft/node-pty/issues/216
- https://github.com/microsoft/node-pty/issues/842
- https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_66.md
- https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_67.md
- https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_61.md
- https://github.com/microsoft/terminal/discussions/16472 (mentioned in search; not fetched in full)
- https://github.com/microsoft/terminal/issues/19926 (mentioned in search; not fetched in full)
