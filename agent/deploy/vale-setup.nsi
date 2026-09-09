; Vale Agent 在线安装包（NSIS 3.x, Unicode）。
; 由 scripts/build-installer.sh 编译：
;   makensis /DVALE_VERSION=1.2.N /DVALE_CDN=https://agent.saisi.online vale-setup.nsi
; 只做最小外壳：中文向导 + 管理员提权 + 卸载器；真正的安装由内嵌的
; vale-online-setup.ps1 完成（Node 引导 → npm 通道 → vale setup）。
; 更新通道不变：装完一律 `vale update`。
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
!include "StrFunc.nsh"
${StrRep}

!ifndef VALE_VERSION
  !define VALE_VERSION "0.0.0-dev"
!endif
!ifndef VALE_CDN
  !define VALE_CDN "https://agent.saisi.online"
!endif

Name "Vale Agent ${VALE_VERSION}"
OutFile "ValeAgent-Setup-${VALE_VERSION}.exe"
InstallDir "$PROGRAMFILES\Vale"
RequestExecutionLevel admin

Icon "vale-agent.ico"
UninstallIcon "vale-agent.ico"

; 品牌头图（scripts/render-installer-art.py 生成，日出主题）
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "res\header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "res\welcome.bmp"
!define MUI_ABORTWARNING

Var REGKEY
Var REGKEY_INPUT
Var RESULT_TEXT

; StrFunc 函数落子（全局作用域；卸载节用 Un 变体）
${UnStrRep}

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY

; 注册码（可选）：控制台 → 设备管理 → 生成注册码。填了自动登记设备。
Page custom regKeyPage regKeyPageLeave
Function regKeyPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 40u "注册码（可选）：到控制台 → 设备管理 → 生成注册码。$\r$\n填了它，装完自动登记设备；留空则纯本地安装，以后随时登记。"
  Pop $0
  ${NSD_CreateText} 0 44u 100% 22u ""
  Pop $REGKEY_INPUT
  ${NSD_AddStyle} $REGKEY_INPUT ${ES_AUTOHSCROLL}
  nsDialogs::Show
FunctionEnd
Function regKeyPageLeave
  ${NSD_GetText} $REGKEY_INPUT $REGKEY
FunctionEnd

!insertmacro MUI_PAGE_INSTFILES

; 完成页：读引导脚本写的回执（绝不含 token）
Page custom finishPage
Function finishPage
  StrCpy $RESULT_TEXT "安装程序已退出。请用 vale status 查看状态，或重新运行安装。"
  ${If} ${FileExists} "$INSTDIR\install-result.txt"
    StrCpy $RESULT_TEXT ""
    FileOpen $4 "$INSTDIR\install-result.txt" r
    ${If} $4 != ""
      ${Do}
        ClearErrors
        FileRead $4 $5
        ${If} ${Errors}
          ${Break}
        ${EndIf}
        StrCpy $RESULT_TEXT "$RESULT_TEXT$5$\r$\n"
      ${Loop}
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
  ; 引导脚本 + 版本钉死（装 pinned tgz，不装 latest，保证可复现）
  File "vale-online-setup.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\vale-online-setup.ps1" -InstallDir "$INSTDIR" -ValeVersion "${VALE_VERSION}" -CdnBase "${VALE_CDN}" -RegKey "$REGKEY" -ResultFile "$INSTDIR\install-result.txt"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "安装失败（步骤退出码 $0）。$\r$\n看 $INSTDIR\installer.log 找原因，修好后重跑安装包即可（幂等）。"
    Abort
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ValeAgent" "DisplayName" "Vale Agent ${VALE_VERSION}"
  WriteRegStr HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ValeAgent" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ValeAgent" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ValeAgent" "DisplayVersion" "${VALE_VERSION}"
  WriteRegStr HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ValeAgent" "Publisher" "Vale"
  WriteRegDWORD HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ValeAgent" "NoModify" 1
  WriteRegDWORD HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ValeAgent" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; 正主：vale uninstall（停任务、杀进程、删程序目录+注册表；数据默认保留）
  ${If} ${FileExists} "$INSTDIR\tools\npm-global\vale.cmd"
    nsExec::ExecToLog 'cmd /c "set VALE_AGENT_DIR=$INSTDIR && "$INSTDIR\tools\npm-global\vale.cmd" uninstall"'
  ${Else}
    nsExec::ExecToLog 'cmd /c "schtasks /End /TN ValeAgent 2>NUL & schtasks /Delete /TN ValeAgent /F 2>NUL & schtasks /End /TN ValeDesktop 2>NUL & schtasks /Delete /TN ValeDesktop /F 2>NUL & taskkill /F /IM vale-agent.exe 2>NUL & taskkill /F /IM electron.exe 2>NUL"'
    nsExec::ExecToLog 'cmd /c "rmdir /s /q "$INSTDIR" 2>NUL & reg delete HKLM\SOFTWARE\Vale\Agent /f 2>NUL"'
  ${EndIf}
  ; 快捷方式（安装时写了公共桌面 + 当前用户桌面）
  SetShellVarContext all
  Delete "$DESKTOP\Vale.lnk"
  SetShellVarContext current
  Delete "$DESKTOP\Vale.lnk"
  ; 清掉安装时加的 Machine PATH（便携 node + npm-global；系统自带的 node 不动）
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${UnStrRep} $0 $0 "$INSTDIR\tools\node;" ""
  ${UnStrRep} $0 $0 ";$INSTDIR\tools\node" ""
  ${UnStrRep} $0 $0 "$INSTDIR\tools\npm-global;" ""
  ${UnStrRep} $0 $0 ";$INSTDIR\tools\npm-global" ""
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" $0
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ValeAgent"
SectionEnd
