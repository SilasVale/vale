@echo off
REM Vale Command post-install setup launcher (run by the NSIS installer).
REM Runs the full setup in this visible console window.
set "VC_DIR=%~dp0"
if "%VC_DIR:~-1%"=="\" set "VC_DIR=%VC_DIR:~0,-1%"
echo Vale Command setup starting...
echo If a browser opens for Cloudflare authorization, click Authorize, then return here.
echo.
REM Pass the registration key (if entered in the installer) to the setup script.
if exist "%VC_DIR%\regkey.txt" (
  set /p VALE_REG_KEY=<"%VC_DIR%\regkey.txt"
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%VC_DIR%\vale-command-setup.ps1" -InstallDir "%VC_DIR%" -SkipDownload
echo.
echo Setup finished. Scroll up for your token, then close this window.
pause
