Unicode true
!include "MUI2.nsh"

; Brand icon (unified Vale V mark, 2026-08-12)
Icon "vale-agent.ico"
UninstallIcon "vale-agent.ico"
!include "nsDialogs.nsh"

Name "Vale Agent"
OutFile "ValeAgent-Setup.exe"
RequestExecutionLevel admin
InstallDir "C:\vale-agent"

Var RESULT_TEXT
Var REGKEY
Var REGKEY_INPUT

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY

; Registration key page: optional. From ai.saisi.online → 设备管理 → 生成注册码.
; If filled, the setup script auto-registers the device (no token copy-paste).
; NOTE: NSIS skips ALL pages — MUI ones and these custom ones — when the
; installer runs silently (/S), so the custom pages below need no IfSilent
; guards; their callbacks never run in silent mode.
Page custom regKeyPage regKeyPageLeave
Function regKeyPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 36u "注册码（可选）：到 ai.saisi.online 控制台 → 设备管理 → 生成注册码。$\r$\n填了它，装完自动登记设备，无需手动抄 token；留空则之后手动添加。"
  Pop $0
  ; Single-line input (ES_AUTOHSCROLL): a registration key is one token, and a
  ; pasted multi-line value would break the env-var handoff in run-setup.bat.
  ${NSD_CreateText} 0 40u 100% 22u ""
  Pop $REGKEY_INPUT
  ${NSD_AddStyle} $REGKEY_INPUT ${ES_AUTOHSCROLL}
  ${NSD_SetText} $REGKEY_INPUT "$REGKEY"
  nsDialogs::Show
FunctionEnd
Function regKeyPageLeave
  ${NSD_GetText} $REGKEY_INPUT $REGKEY
FunctionEnd

!insertmacro MUI_PAGE_INSTFILES

; Wait page: the setup runs in its own window; the user can continue or cancel
; at any time (Cancel button stays live on this message-loop page).
Page custom waitPage
Function waitPage
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 60u "配置程序已在独立窗口运行（可能弹出 Cloudflare 授权）。$\r$\n看到窗口里出现 DONE 后，点 [下一步] 查看结果。$\r$\n可随时点 [取消] 退出。"
  Pop $0
  nsDialogs::Show
FunctionEnd

; Finish page: show result (token + panel)
Page custom finishPage
Function finishPage
  ; Read the result file written by the setup script (if the setup finished).
  StrCpy $RESULT_TEXT "配置尚未完成。请稍后在面板查看，或重新运行安装程序。"
  ${If} ${FileExists} "$INSTDIR\install-result.txt"
    StrCpy $RESULT_TEXT ""
    FileOpen $4 "$INSTDIR\install-result.txt" r
    ${If} $4 != ""
      ClearErrors
      FileRead $4 $5
      StrCpy $RESULT_TEXT "$RESULT_TEXT$5$\r$\n"
      FileRead $4 $5
      StrCpy $RESULT_TEXT "$RESULT_TEXT$5$\r$\n"
      FileRead $4 $5
      StrCpy $RESULT_TEXT "$RESULT_TEXT$5"
      FileClose $4
    ${EndIf}
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 200u "$RESULT_TEXT"
  Pop $0
  nsDialogs::Show
FunctionEnd

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install" SEC01
  SetOutPath "$INSTDIR"

  ; 1. Copy the new binaries to .new temp names FIRST — before any process is
  ;    killed. A copy that fails (disk full, AV scanning the fresh file,
  ;    locked dest) aborts here while the OLD install keeps running, so an
  ;    interrupted upgrade leaves the device online, not offline. A running
  ;    exe cannot be overwritten, hence the temp name + swap below.
  File "/oname=vale-agent.exe.new" "vale-agent.exe"
  File "/oname=vale-tray.exe.new" "vale-tray.exe"
  ; Support files — safe to write directly (never locked by a process).
  File "vale-agent-setup.ps1"
  File "run-setup.bat"
  File "fix-tunnel.ps1"
  ; Browser extension zip — extracted to $INSTDIR\extension\ by the setup
  ; script so the terminal panel loads from the same install dir (Load
  ; unpacked → $INSTDIR\extension). Updated together with the binaries on
  ; every install/upgrade.
  File "vale-browser-control.zip"

  ; 2. NOW stop every vale binary. A running instance locks its exe AND holds
  ;    port 18080, so the restarted boot task cannot bind. This includes the
  ;    legacy 0.8.x vale-command.exe: an upgrade that leaves it running
  ;    silently keeps the OLD server serving the device while the new one
  ;    dies on bind. Vale-tray is killed in silent mode too — the tray that
  ;    launched this installer exits right after starting it, and a fresh
  ;    tray is relaunched below once the copy is done.
  nsExec::ExecToLog 'taskkill /F /IM vale-agent.exe'
  nsExec::ExecToLog 'taskkill /F /IM vale-command.exe'
  nsExec::ExecToLog 'taskkill /F /IM vale-tray.exe'
  nsExec::ExecToLog 'schtasks /End /TN ValeAgent'
  nsExec::ExecToLog 'schtasks /End /TN ValeAgentTray'
  ; Legacy 0.8.x autostart leftovers. The ValeCommand service (sc create from
  ; the old installer) is started by the SCM BEFORE the ValeAgent boot task
  ; at every restart, grabs port 18080, and the new server then fails to
  ; bind — the device keeps serving the old version. The boot task is the
  ; canonical autostart since 1.0; drop the service and the old tasks.
  nsExec::ExecToLog 'sc stop ValeCommand'
  nsExec::ExecToLog 'sc delete ValeCommand'
  nsExec::ExecToLog 'schtasks /End /TN ValeCommand'
  nsExec::ExecToLog 'schtasks /Delete /TN ValeCommand /F'
  nsExec::ExecToLog 'schtasks /End /TN ValeCommandTray'
  nsExec::ExecToLog 'schtasks /Delete /TN ValeCommandTray /F'
  Sleep 1000

  ; 3. Swap the new binaries in (old ones were killed above, so Delete/Rename
  ;    cannot hit a locked file). Rename fails if the target exists, hence
  ;    Delete first. A failed swap must NOT exit 0 — the tray/tools would
  ;    report 'install ok' while the device runs the OLD binary (or none).
  Delete "$INSTDIR\vale-agent.exe"
  Rename "$INSTDIR\vale-agent.exe.new" "$INSTDIR\vale-agent.exe"
  IfErrors 0 +2
  SetErrorLevel 3
  Delete "$INSTDIR\vale-tray.exe"
  Rename "$INSTDIR\vale-tray.exe.new" "$INSTDIR\vale-tray.exe"
  IfErrors 0 +2
  SetErrorLevel 3

  ; Persist the registration key so run-setup.bat can pass it to the setup
  ; script ($env:VALE_REG_KEY). Empty when the user left the field blank.
  ${If} $REGKEY != ""
    FileOpen $6 "$INSTDIR\regkey.txt" w
    FileWrite $6 "$REGKEY"
    FileClose $6
  ${Else}
    Delete "$INSTDIR\regkey.txt"
  ${EndIf}

  ; Launch the setup in its OWN visible console window (run-setup.bat) so the
  ; user can watch progress and the Cloudflare browser auth. Non-blocking - the
  ; installer returns to an interactive page immediately (cancel always works).
  ; Fresh installs only: an upgrade must NOT re-run the setup script — it would
  ; re-auth / re-register a device that is already configured.
  ${IfNot} ${Silent}
    DetailPrint "正在启动 Vale Agent 配置窗口（独立窗口显示进度，可能弹出 Cloudflare 授权）..."
    Exec '"$INSTDIR\run-setup.bat"'
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Silent mode = auto-upgrade from the tray: the launching tray has already
  ; exited, so bring a fresh tray back. schtasks /Run triggers the at-logon
  ; ValeAgentTray task, restoring the exact previous environment (interactive
  ; session, elevated as before). If that task is missing (tray was started
  ; manually), start the exe directly.
  ${If} ${Silent}
    ; The setup script extracts the bundled browser-extension zip, but silent
    ; upgrades skip it (run-setup.bat runs only on fresh installs) — extract
    ; here so $INSTDIR\extension\ stays fresh on every update.
    nsExec::ExecToLog 'powershell -NoProfile -Command "Remove-Item -Recurse -Force \"$INSTDIR\extension\" -ErrorAction SilentlyContinue; Expand-Archive -Force -Path \"$INSTDIR\vale-browser-control.zip\" -DestinationPath \"$INSTDIR\extension\""'
    ; Domain migration (0.8.6): rewrite a *.command.saisi.online tunnel ingress
    ; to *.agent.saisi.online in both cloudflared configs (user + systemprofile),
    ; update the hostname file, restart the cloudflared service. Idempotent —
    ; a config already on agent is untouched.
    ; Repair the cloudflared tunnel config after the domain migration — the
    ; bundled fix-tunnel.ps1 rewrites a legacy vale-command-dN tunnel +
    ; *.command.saisi.online ingress to vale-agent-dN + *.agent.saisi.online
    ; (user + systemprofile configs), fixes config.yaml name, restarts
    ; cloudflared. Idempotent; safe on fresh installs.
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\fix-tunnel.ps1"'
    ; Restart the server. Do NOT schtasks /Run here: a task registered for an
    ; older install dir (a silent /D= upgrade) would boot the OLD binaries
    ; and hold the port forever. Delete the task and start the new exe
    ; directly — its startup self-heal re-registers the ValeAgent boot task
    ; pointing at THIS dir (with the unlimited ExecutionTimeLimit).
    nsExec::ExecToLog 'schtasks /End /TN ValeAgent'
    nsExec::ExecToLog 'schtasks /Delete /TN ValeAgent /F'
    Exec '"$INSTDIR\vale-agent.exe" "$INSTDIR\config.yaml"'
    ; Tray: keep the registered ValeAgentTray task (it carries the user
    ; principal; a missing task falls back to starting the exe directly).
    nsExec::ExecToLog 'schtasks /Query /TN ValeAgentTray'
    Pop $0
    ${If} $0 != 0
      Exec '"$INSTDIR\vale-tray.exe"'
    ${Else}
      nsExec::ExecToLog 'schtasks /Run /TN ValeAgentTray'
    ${EndIf}
  ${EndIf}
SectionEnd

Section "Uninstall"
  ; Stop and remove the scheduled tasks + cloudflared service (best effort)
  nsExec::ExecToLog 'schtasks /End /TN ValeAgentTray'
  nsExec::ExecToLog 'schtasks /Delete /TN ValeAgentTray /F'
  nsExec::ExecToLog 'schtasks /End /TN ValeAgent'
  nsExec::ExecToLog 'schtasks /Delete /TN ValeAgent /F'
  nsExec::ExecToLog 'sc stop Cloudflared'
  nsExec::ExecToLog 'sc delete Cloudflared'
  Delete "$INSTDIR\vale-agent.exe"
  Delete "$INSTDIR\vale-agent-setup.ps1"
  Delete "$INSTDIR\run-setup.bat"
  Delete "$INSTDIR\vale-tray.exe"
  Delete "$INSTDIR\vale-agent.hostname"
  Delete "$INSTDIR\install-result.txt"
  Delete "$INSTDIR\regkey.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
