@echo off
REM Vale Command one-click Windows installer.
REM Double-click this file (it self-elevates to Administrator). It downloads
REM and runs the latest vale-command-setup.ps1 from command.saisi.online, which installs
REM vale-command as a service, sets up the Cloudflare tunnel, and prints your
REM token + Claude Code MCP config.
setlocal
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo Vale Command installer - downloading and running setup...
echo If a browser opens for Cloudflare authorization, click Authorize, then return here.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://command.saisi.online/vale-command/vale-command-setup.ps1 | iex"
echo.
echo Done. Scroll up for your token and Claude Code config.
pause
