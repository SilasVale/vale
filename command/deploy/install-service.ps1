# install-service.ps1 - register vale-command headless as a Windows service.
#
# Usage (PowerShell, as Administrator):
#   .\deploy\install-service.ps1 -InstallDir "C:\vale-command"
#
# Generates/updates config.yaml on first run (auth token auto-created), then
# registers a `ValeCommand` auto-start service via `sc create` and starts it.

param(
    [string]$InstallDir = "C:\vale-command",
    [string]$ConfigPath = "C:\vale-command\config.yaml",
    [string]$ServiceName = "ValeCommand"
)

$ErrorActionPreference = "Stop"

$exe = Join-Path $InstallDir "vale-command.exe"
if (-not (Test-Path $exe)) {
    throw "Not found: $exe - build it first (see deploy/README.md)."
}

# 1. Generate config.yaml on first run so the auth token exists before the
#    service starts (`--init` bootstraps config+token and exits without
#    starting the server).
if (-not (Test-Path $ConfigPath)) {
    Write-Host "No config at $ConfigPath - bootstrapping config + token ..."
    & $exe --init $ConfigPath
    if (-not (Test-Path $ConfigPath)) {
        throw "Failed to bootstrap config.yaml"
    }
}

# 2. Register as an auto-start service (sc create with quoted binPath+arg).
$binPath = "`"$exe`" `"$ConfigPath`""
$existing = sc.exe query $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Service '$ServiceName' already exists - deleting to reconfigure..."
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Milliseconds 500
}

Write-Host "Creating service '$ServiceName' -> $binPath"
sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "Vale Command (headless MCP server)"
if ($LASTEXITCODE -ne 0) {
    throw "sc create failed (exit $LASTEXITCODE) - run as Administrator."
}
sc.exe description $ServiceName "Vale Command - remote device MCP server + web panel (serial / terminal / browser)" | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

Write-Host "Starting '$ServiceName'..."
sc.exe start $ServiceName | Out-Null

Start-Sleep -Seconds 2
$token = Select-String -Path $ConfigPath -Pattern "auth_token:" | ForEach-Object { $_.Line }
Write-Host ""
Write-Host "Service '$ServiceName' is running."
Write-Host "Token: $token"
Write-Host "Panel: http://127.0.0.1:18080/   MCP: http://127.0.0.1:18080/mcp"
Write-Host "Next: expose via Cloudflare Tunnel (see deploy/README.md)."
