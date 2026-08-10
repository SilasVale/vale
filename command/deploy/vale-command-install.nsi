Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"

Name "Vale Command"
OutFile "ValeCommand-Setup.exe"
RequestExecutionLevel admin
InstallDir "C:\vale-command"

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
  ; Stop any running vale-command first, otherwise its exe is locked and
  ; copying the new binaries fails with "cannot open file for writing"
  ; (the re-install case). The setup script also kills it, but that runs
  ; after this copy step.
  ; In silent mode (auto-upgrade from the tray) vale-tray.exe is NOT killed:
  ; the tray that launched this installer exits itself right after starting
  ; it, and a fresh tray is relaunched below once the copy is done.
  nsExec::ExecToLog 'taskkill /F /IM vale-command.exe'
  nsExec::ExecToLog 'schtasks /End /TN ValeCommand'
  ${IfNot} ${Silent}
    nsExec::ExecToLog 'taskkill /F /IM vale-tray.exe'
    nsExec::ExecToLog 'schtasks /End /TN ValeCommandTray'
  ${EndIf}
  Sleep 1000

  SetOutPath "$INSTDIR"

  ; Copy app + setup script + launcher + tray
  File "/oname=vale-command.exe" "vale-command.exe"
  File "vale-command-setup.ps1"
  File "run-setup.bat"
  File "vale-tray.exe"
  ; Browser extension zip — extracted to $INSTDIR\extension\ by the setup
  ; script so the terminal panel loads from the same install dir (Load
  ; unpacked → $INSTDIR\extension). Updated together with the binaries on
  ; every install/upgrade.
  File "vale-browser-control.zip"

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
    DetailPrint "正在启动 Vale Command 配置窗口（独立窗口显示进度，可能弹出 Cloudflare 授权）..."
    Exec '"$INSTDIR\run-setup.bat"'
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Silent mode = auto-upgrade from the tray: the launching tray has already
  ; exited, so bring a fresh tray back. schtasks /Run triggers the at-logon
  ; ValeCommandTray task, restoring the exact previous environment (interactive
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
    nsExec::ExecToLog 'powershell -NoProfile -Command "$old='\''.command.saisi.online'\''; $new='\''.agent.saisi.online'\''; $files=@(\"$env:USERPROFILE\.cloudflared\config.yml\",\"$env:WINDIR\System32\config\systemprofile\.cloudflared\config.yml\",\"$INSTDIR\vale-command.hostname\"); foreach($f in $files){ if(Test-Path $f){ $c=Get-Content $f -Raw; if($c -match [regex]::Escape($old)){ Set-Content $f ($c -replace [regex]::Escape($old),$new) -Encoding ascii; Write-Host \"migrated $f\" } } }; sc.exe stop cloudflared 2>$null | Out-Null; sc.exe start cloudflared 2>$null | Out-Null"'
    nsExec::ExecToLog 'schtasks /Query /TN ValeCommandTray'
    Pop $0
    ${If} $0 != 0
      Exec '"$INSTDIR\vale-tray.exe"'
    ${Else}
      nsExec::ExecToLog 'schtasks /Run /TN ValeCommandTray'
    ${EndIf}
  ${EndIf}
SectionEnd

Section "Uninstall"
  ; Stop and remove the scheduled tasks + cloudflared service (best effort)
  nsExec::ExecToLog 'schtasks /End /TN ValeCommandTray'
  nsExec::ExecToLog 'schtasks /Delete /TN ValeCommandTray /F'
  nsExec::ExecToLog 'schtasks /End /TN ValeCommand'
  nsExec::ExecToLog 'schtasks /Delete /TN ValeCommand /F'
  nsExec::ExecToLog 'sc stop Cloudflared'
  nsExec::ExecToLog 'sc delete Cloudflared'
  Delete "$INSTDIR\vale-command.exe"
  Delete "$INSTDIR\vale-command-setup.ps1"
  Delete "$INSTDIR\run-setup.bat"
  Delete "$INSTDIR\vale-tray.exe"
  Delete "$INSTDIR\vale-command.hostname"
  Delete "$INSTDIR\install-result.txt"
  Delete "$INSTDIR\regkey.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
