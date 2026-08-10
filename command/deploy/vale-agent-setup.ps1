# vale-agent-setup.ps1 - full headless install on a Windows machine:
#   - downloads vale-agent.exe (from this same origin)
#   - bootstraps config.yaml + auth token
#   - installs cloudflared, authenticates to Cloudflare, creates the tunnel,
#     routes a subdomain
#   - registers both Windows services (vale-agent + cloudflared)
#   - prints the token and Claude Code MCP config
#
# Run on the Windows machine as Administrator (interactive browser auth):
#   irm https://agent.saisi.online/vale-agent/vale-agent-setup.ps1 | iex
#
# OR with a Cloudflare API token (no browser popup). The token only needs
# Tunnel:Edit + Zone:DNS:Edit; it's used transiently at setup, never stored:
#   $env:CLOUDFLARE_API_TOKEN = "cfat_..."
#   irm https://agent.saisi.online/vale-agent/vale-agent-setup.ps1 | iex
#
param(
    [string]$Hostname = "",   # empty = auto-assign the next free dN subdomain
    [string]$InstallDir = "C:\vale-agent",
    [string]$Base = "https://agent.saisi.online",
    [switch]$SkipDownload   # set when the NSIS installer bundles the exe
)

$ErrorActionPreference = "Stop"

function Require-Admin {
    $id  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this as Administrator (right-click PowerShell -> Run as administrator)."
    }
}

function Download-File($Url, $Dest, [switch]$Force) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Dest -Parent) | Out-Null
    if ($Force -or -not (Test-Path $Dest)) {
        Write-Host "  downloading $Url"
        Invoke-WebRequest -Uri $Url -OutFile $Dest
    } else {
        Write-Host "  already present: $Dest"
    }
}

function Get-TunnelId($cloudflared, $Name) {
    $list = & $cloudflared tunnel list --name $Name 2>&1 | Out-String
    if ($list -match '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})') { return $Matches[1] }
    return $null
}

Require-Admin

# Auto-assign the subdomain when not given. Reuse the existing install's
# hostname if there is one, else pick the next free dN by DNS probe. The
# CLOUDFLARED CONFIG is the ground truth for a re-install (a buggy earlier run
# can write a stale value into vale-agent.hostname, as happened with d2).
$hostFile = Join-Path $InstallDir "vale-agent.hostname"
if (-not $Hostname) {
    # 1. The existing working setup's subdomain (cloudflared config ingress).
    $cfCfg = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
    if (Test-Path $cfCfg) {
        $m = Select-String -Path $cfCfg -Pattern "hostname:\s*([^\s]+)" | Select-Object -First 1
        if ($m) { $Hostname = $m.Matches[0].Groups[1].Value }
    }
    # 2. Previously saved hostname (newer installs).
    if (-not $Hostname -and (Test-Path $hostFile)) {
        $Hostname = (Get-Content $hostFile -Raw).Trim()
    }
    # 3. DNS probe for the next free dN (fresh install).
    if (-not $Hostname) {
        for ($n = 1; $n -lt 50; $n++) {
            $cand = "d$n.agent.saisi.online"
            if (-not (Resolve-DnsName $cand -ErrorAction SilentlyContinue)) {
                $Hostname = $cand
                break
            }
        }
        if (-not $Hostname) { $Hostname = "d1.agent.saisi.online" }
    }
    Set-Content -Path $hostFile -Value $Hostname
}
# Domain migration (0.8.6): the device subdomain moved from
# *.command.saisi.online to *.agent.saisi.online. If the detected hostname is
# still on the old domain, rewrite it to the new one so the tunnel ingress and
# the hostname file both use the new domain. (The DNS CNAME for the new
# subdomain is added by the operator; this only rewrites the config side.)
if ($Hostname -match '\.command\.saisi\.online$') {
    Write-Host "  migrating hostname: $Hostname → $($Hostname -replace '\.command\.saisi\.online$','.agent.saisi.online')"
    $Hostname = $Hostname -replace '\.command\.saisi\.online$', '.agent.saisi.online'
    Set-Content -Path $hostFile -Value $Hostname
}
# Console URL for the tray app ("打开控制台") — the console hostname is a
# worker var set at deploy time, so it is written here, not hardcoded in the exe.
Set-Content -Path (Join-Path $InstallDir "vale-agent.console") -Value "https://ai.saisi.online/"


Write-Host "=== Vale Command one-click install ($Hostname) ==="

# 1. Binary + config/token
$exe = Join-Path $InstallDir "vale-agent.exe"
$cfg = Join-Path $InstallDir "config.yaml"
Write-Host "`n[1/7] vale-agent binary"
# Re-download every run so fixes to the binary take effect, and kill any stray
# instance first so the exe file is not locked by a running process.
Get-Process vale-agent -ErrorAction SilentlyContinue | Stop-Process -Force
if (-not $SkipDownload) { Download-File "$Base/vale-agent/vale-agent.exe" $exe -Force }
# Tray app: re-download on updates too. The NSIS installer bundles it for fresh
# installs, but the script path must fetch it so an update also refreshes the
# tray (and its scheduled-task registration below). Kill strays first — a
# running exe locks the file.
$trayExe = Join-Path $InstallDir "vale-tray.exe"
Get-Process vale-tray -ErrorAction SilentlyContinue | Stop-Process -Force
if (-not $SkipDownload) { Download-File "$Base/vale-agent/vale-tray.exe" $trayExe -Force }
# Browser extension: extract vale-browser-control.zip into $INSTDIR\extension\
# so Chrome's "Load unpacked" points at the same install dir (updated together
# with the binaries on every install/upgrade). The NSIS installer bundles the
# zip for fresh installs; the script path re-downloads it on updates.
Write-Host "  browser extension -> $InstallDir\extension"
$extZip = Join-Path $InstallDir "vale-browser-control.zip"
if (-not $SkipDownload) { Download-File "$Base/vale-agent/vale-browser-control.zip" $extZip -Force }
$extDir = Join-Path $InstallDir "extension"
if (Test-Path $extZip) {
    Remove-Item $extDir -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $extZip -DestinationPath $extDir -Force
    Write-Host "    extracted to $extDir (Load unpacked this dir)"
}
if (-not (Test-Path $cfg)) {
    Write-Host "  bootstrapping config + auth token"
    & $exe --init $cfg
}
# Serve on a high port: dev tools (e.g. VS Code port-forwarding) commonly squat
# the 127.0.0.1:3000/3001 loopback range, which would intercept the tunnel's
# origin connection and break the panel. 18080 is well out of that range.
(Get-Content $cfg) -replace 'port: 3000','port: 18080' -replace 'port: 3001','port: 18080' | Set-Content $cfg

# 2. cloudflared
Write-Host "`n[2/7] cloudflared"
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "  installing via winget..."
    winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget install cloudflared failed (exit $LASTEXITCODE)" }
    # winget registers cloudflared in the registry PATH, but THIS session's
    # $env:PATH is a snapshot from process start. Rebuild it from the registry
    # so Get-Command works without requiring a new shell.
    $env:PATH = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) {
    # Fallbacks if the PATH refresh did not surface it (winget links shim / Program Files).
    foreach ($c in @("$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe",
                     "$env:ProgramFiles\cloudflared\cloudflared.exe",
                     "$env:ProgramFiles(x86)\cloudflared\cloudflared.exe")) {
        if (Test-Path $c) { $cloudflared = $c; break }
    }
}
if (-not $cloudflared) { throw "cloudflared was installed but is not on PATH - open a new PowerShell and re-run this installer." }
Write-Host "  cloudflared at: $cloudflared"

# 3. Cloudflare auth - API token (no browser) or interactive login.
Write-Host "`n[3/7] Cloudflare auth"
$apiToken = $env:CLOUDFLARE_API_TOKEN
if (-not $apiToken) {
    # Fetch the account-level tunnel API token from the Vale console when a
    # registration key is present (stored in the Vale console under
    # Devices -> Cloudflare tunnel credential),
    # so a fresh install needs no browser login and no token pasted by hand.
    $regKey = $env:VALE_REG_KEY
    if (-not $regKey -and (Test-Path (Join-Path $InstallDir "regkey.txt"))) {
        $regKey = (Get-Content (Join-Path $InstallDir "regkey.txt") -Raw).Trim()
    }
    if ($regKey) {
        try {
            $resp = Invoke-RestMethod -Uri "https://ai.saisi.online/api/install/tunnel-token" `
                -Method Post -ContentType "application/json" `
                -Body (@{ key = $regKey } | ConvertTo-Json)
            if ($resp.apiToken) {
                $apiToken = $resp.apiToken
                Write-Host "  using Cloudflare API token from Vale console."
            }
        } catch {
            Write-Host "  (could not fetch CF token from console: $($_.Exception.Message))"
        }
    }
    if ($apiToken) { $env:CLOUDFLARE_API_TOKEN = $apiToken }
}
if ($apiToken) {
    Write-Host "  no browser login needed (API token)."
} elseif (Test-Path (Join-Path $env:USERPROFILE ".cloudflared\cert.pem")) {
    Write-Host "  already logged in - skipping browser auth."
} else {
    Write-Host "  >>> A browser will open for Cloudflare authorization - click Authorize, then come back."
    & $cloudflared tunnel login
    if ($LASTEXITCODE -ne 0) { throw "cloudflared tunnel login failed (exit $LASTEXITCODE)" }
}

# Authoritative hostname: prefer reusing the lowest-numbered existing
# vale-agent-dN tunnel (the original device). A buggy earlier run can leave a
# stale d2 in the config/hostname files; the tunnel list is the ground truth.
$tunnels = & $cloudflared tunnel list 2>&1 | Out-String
$ns = [regex]::Matches($tunnels, "vale-agent-d(\d+)") | ForEach-Object { [int]$_.Groups[1].Value }
if ($ns.Count -gt 0) {
    $lowest = ($ns | Measure-Object -Minimum).Minimum
    $Hostname = "d$lowest.agent.saisi.online"
    Set-Content -Path $hostFile -Value $Hostname
}
# Console URL for the tray app ("打开控制台") — the console hostname is a
# worker var set at deploy time, so it is written here, not hardcoded in the exe.
Set-Content -Path (Join-Path $InstallDir "vale-agent.console") -Value "https://ai.saisi.online/"

Write-Host "  hostname: $Hostname"

# 4. Create tunnel + DNS route (per-device tunnel, idempotent).
# Each device machine gets its own tunnel named after its subdomain
# (vale-agent-d1, vale-agent-d2, ...) so machines never share a tunnel.
$tunnelName = "vale-agent-" + ($Hostname -split '\.')[0]
Write-Host "`n[4/7] tunnel create + DNS route ($tunnelName)"
$tunnelId = Get-TunnelId $cloudflared $tunnelName
if (-not $tunnelId) {
    $created = & $cloudflared tunnel create $tunnelName 2>&1 | Out-String
    Write-Host "  $($created.Trim())"
    $tunnelId = Get-TunnelId $cloudflared $tunnelName
    if (-not $tunnelId) { throw "could not create tunnel; output: $created" }
}
Write-Host "  tunnel id: $tunnelId"
# Route DNS - --overwrite so a pre-existing CNAME (from a previous install or
# an operator-added record) is REPLACED by a real tunnel route. Without it,
# cloudflared fails with 1003 when the hostname already has a record, and the
# old "already exists - route in place" fallback was wrong: a bare CNAME is
# NOT a tunnel route, so the tunnel 530'd with error 1033 (no route).
& $cloudflared tunnel route dns $tunnelName $Hostname --overwrite
if ($LASTEXITCODE -ne 0) {
    throw "tunnel route dns failed (exit $LASTEXITCODE)"
}

# 5. Tunnel config
Write-Host "`n[5/7] tunnel config"
$cfDir = Join-Path $env:USERPROFILE ".cloudflared"
New-Item -ItemType Directory -Force -Path $cfDir | Out-Null
$cfCfg = Join-Path $cfDir "config.yml"
@"
tunnel: $tunnelId
credentials-file: $cfDir\$tunnelId.json
ingress:
  - hostname: $Hostname
    service: http://127.0.0.2:18080
  - service: http_status:404
"@ | Set-Content -Path $cfCfg -Encoding ascii
Write-Host "  wrote $cfCfg"
# The cloudflared service runs as SYSTEM, which looks for ~/.cloudflared/config.yml
# in systemprofile and would never see the file above. Copy config + credentials
# there so the service uses the right tunnel and ingress.
$sysCfDir = Join-Path $env:SystemRoot "System32\config\systemprofile\.cloudflared"
New-Item -ItemType Directory -Force -Path $sysCfDir | Out-Null
Copy-Item $cfCfg (Join-Path $sysCfDir "config.yml") -Force
Copy-Item (Join-Path $cfDir "$tunnelId.json") (Join-Path $sysCfDir "$tunnelId.json") -Force -ErrorAction SilentlyContinue

# 6. vale-agent as an auto-start scheduled task.
# A Windows service requires the process to speak the SCM protocol; vale-agent
# is a plain console binary, so a service shows RUNNING while its server thread
# never binds. A boot scheduled task launches it exactly like a manual run
# (which works) - same auto-start, no service-protocol requirements.
Write-Host "`n[6/7] vale-agent boot task"
Stop-ScheduledTask -TaskName "ValeAgent" -ErrorAction SilentlyContinue | Out-Null
Unregister-ScheduledTask -TaskName "ValeAgent" -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
sc.exe delete ValeAgent 2>&1 | Out-Null   # remove any old broken service
$action = New-ScheduledTaskAction -Execute $exe -Argument "`"$cfg`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
# ExecutionTimeLimit 0 = never kill the task. Default is 72h — the server
# (and the tray below) would silently stop after 3 days until a reboot.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName "ValeAgent" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if (-not (Get-ScheduledTask -TaskName "ValeAgent" -ErrorAction SilentlyContinue)) {
    throw "failed to register scheduled task ValeAgent"
}
Start-ScheduledTask -TaskName "ValeAgent" | Out-Null
Start-Sleep -Seconds 2

# Tray app: register an at-logon task so the tray icon appears for the logged-in
# user (highest privileges so it can start/stop the SYSTEM ValeAgent task).
$trayExe = Join-Path $InstallDir "vale-tray.exe"
if (Test-Path $trayExe) {
    Unregister-ScheduledTask -TaskName "ValeAgentTray" -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
    $trayAction = New-ScheduledTaskAction -Execute $trayExe
    $trayTrigger = New-ScheduledTaskTrigger -AtLogOn
    $trayPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
    # Same unlimited ExecutionTimeLimit as the ValeAgent task — a tray app
    # must never be killed by the default 72h task limit.
    Register-ScheduledTask -TaskName "ValeAgentTray" -Action $trayAction -Trigger $trayTrigger -Principal $trayPrincipal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName "ValeAgentTray" | Out-Null
}

# 7. cloudflared as a service - bake the tunnel token into the service so it
#    connects regardless of the service's user profile. A config-file-based
#    install runs the service as SYSTEM, which looks in systemprofile for
#    ~/.cloudflared/config.yml and never sees the one we wrote to the
#    Administrator profile (connector stays up but never connects).
Write-Host "`n[7/7] cloudflared service"
$tunnelToken = (& $cloudflared tunnel token $tunnelName 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "cloudflared tunnel token failed: $tunnelToken" }
# cloudflared writes its INF logs to stderr, which Windows PowerShell 5.1 turns
# into terminating NativeCommandErrors under $ErrorActionPreference=Stop (even
# with 2>$null). Scope EAP to Continue around the cloudflared calls and rely on
# explicit exit-code checks instead.
$oldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    # cloudflared logs to stderr, which PS 5.1 turns into terminating errors
    # under EAP=Stop; scope to Continue and check exit codes explicitly.
    # Remove any existing Cloudflared service: cloudflared uninstall first, then
    # force-kill the connector process (a hung cloudflared.exe keeps the service
    # from stopping, so sc delete alone can never remove it) and delete.
    & $cloudflared service uninstall 2>&1 | Out-Null
    for ($i = 0; $i -lt 10; $i++) {
        sc.exe query Cloudflared 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { break }   # already gone
        taskkill /F /IM cloudflared.exe 2>&1 | Out-Null
        sc.exe delete Cloudflared 2>&1 | Out-Null
        Start-Sleep -Seconds 1
    }
    sc.exe query Cloudflared 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { throw "Cloudflared service still exists - remove it manually (taskkill /F /IM cloudflared.exe; sc delete Cloudflared) then re-run." }
    # Leftover EventLog key from a previous install makes cloudflared fail the
    # event-logger registration and exit 1 even though the service installed
    # fine. Delete it first so the reinstall is clean.
    reg delete "HKLM\SYSTEM\CurrentControlSet\Services\EventLog\Application\Cloudflared" /f 2>&1 | Out-Null
    & $cloudflared service install $tunnelToken
} finally {
    $ErrorActionPreference = $oldEAP
}
if ($LASTEXITCODE -ne 0) { throw "cloudflared service install failed (exit $LASTEXITCODE)" }
sc.exe start Cloudflared 2>&1 | Out-Null

Start-Sleep -Seconds 2
$token = (Select-String -Path $cfg -Pattern "auth_token:").Line

Write-Host "`n=== DONE ==="
Write-Host "Device: https://$Hostname/     (status page; API + MCP need the token)"
Write-Host "MCP   : https://$Hostname/mcp"
Write-Host "Token : $token"
Write-Host ""
Write-Host "Claude Code config:"
Write-Host "  { `"mcpServers`": { `"vale-agent`": { `"type`": `"http`", `"url`": `"https://$Hostname/mcp`", `"headers`": { `"Authorization`": `"Bearer <token>`" } } } }"
Write-Host ""
Write-Host "Give it ~10 seconds for the tunnel to come up, then connect Claude Code to the MCP URL (or open the console at https://ai.saisi.online/)."

# Write a result file the NSIS installer's finish page reads to show the token.
$tokenVal = ($token -split "auth_token:\s*")[1]
@"
TOKEN=$tokenVal
MCP=https://$Hostname/mcp
HOSTNAME=$Hostname
"@ | Set-Content -Path (Join-Path $InstallDir "install-result.txt") -Encoding ascii

# 8. Auto-register with the Vale console when a registration key is provided.
# The key comes from ai.saisi.online -> Devices -> Generate key, set as
# $env:VALE_REG_KEY before install (run-setup.bat reads it from regkey.txt when
# the key was entered in the NSIS installer). Registers {name, hostname, token}
# so the device appears in the console without copying the token by hand.
if (-not $env:VALE_REG_KEY) {
    $regKeyFile = Join-Path $InstallDir "regkey.txt"
    if (Test-Path $regKeyFile) { $env:VALE_REG_KEY = (Get-Content $regKeyFile -Raw).Trim() }
}
if ($env:VALE_REG_KEY) {
    Write-Host "`n[8/8] registering with Vale console (ai.saisi.online)"
    $regName = ($Hostname -split '\.')[0]
    $regBody = @{ key = $env:VALE_REG_KEY; name = $regName; hostname = $Hostname; token = $tokenVal } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "https://ai.saisi.online/api/register" -Method Post `
            -ContentType "application/json" -Body $regBody | Out-Null
        Write-Host "  registered $regName -> console (hostname/token auto-configured)."
    } catch {
        Write-Warning "  auto-register failed: $($_.Exception.Message)"
        Write-Warning "  Add this device manually in the console: name=$regName host=$Hostname token (above)."
    }
}
