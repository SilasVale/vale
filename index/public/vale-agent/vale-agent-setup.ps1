# vale-agent-setup.ps1 - full headless install on a Windows machine:
#   - downloads vale-agent.exe and vale-tray.exe from the download origin
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
    [string]$Base = "https://agent.saisi.online", # download Worker; binaries remain under /vale-agent/
    [string]$AgentDomain = "agent.saisi.online",
    [string]$ConsoleUrl = "https://ai.saisi.online",
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
    $oldEAPt = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $list = & $cloudflared tunnel list --name $Name 2>&1 | Out-String
    $ErrorActionPreference = $oldEAPt
    if ($list -match '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})') { return $Matches[1] }
    return $null
}

Require-Admin

# Auto-assign the subdomain when not given. Reuse the existing install's
# hostname if there is one, else pick the next free dN by DNS probe. The
# CLOUDFLARED CONFIG is the ground truth for a re-install (a buggy earlier run
# can write a stale value into vale-agent.hostname, as happened with d2).
$hostFile = Join-Path $InstallDir "vale-agent.hostname"
$Base = $Base.TrimEnd('/')
$AgentDomain = $AgentDomain.Trim().TrimEnd('/')
$ConsoleUrl = $ConsoleUrl.Trim().TrimEnd('/')
$versionEndpoint = "$Base/api/version"
# round-116: ensure the install dir EXISTS before any Set-Content — a
# re-install targeting a directory that was never created (or was cleaned
# up) aborted at the very first write with "未能找到路径 ... 的一部分".
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
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
            $cand = "d$n.$AgentDomain"
            if (-not (Resolve-DnsName $cand -ErrorAction SilentlyContinue)) {
                $Hostname = $cand
                break
            }
        }
        if (-not $Hostname) { $Hostname = "d1.$AgentDomain" }
    }
    Set-Content -Path $hostFile -Value $Hostname
}
# Domain migration (0.8.6): the device subdomain moved from
# *.command.saisi.online to *.agent.saisi.online. If the detected hostname is
# still on the old domain, rewrite it to the new one so the tunnel ingress and
# the hostname file both use the new domain. (The DNS CNAME for the new
# subdomain is added by the operator; this only rewrites the config side.)
if ($Hostname -match '\.command\.[^.]+(?:\.[^.]+)+$') {
    $legacyDomain = $Hostname -replace '^.*?\.command\.', ''
    Write-Host "  migrating legacy hostname: $Hostname"
    $Hostname = $Hostname -replace '\.command\.[^.]+(?:\.[^.]+)+$', ".$AgentDomain"
    Set-Content -Path $hostFile -Value $Hostname
}
# Console URL for the tray app ("打开控制台") — the console hostname is a
# worker var set at deploy time, so it is written here, not hardcoded in the exe.
Set-Content -Path (Join-Path $InstallDir "vale-agent.console") -Value "$ConsoleUrl/"
Set-Content -Path (Join-Path $InstallDir "vale-agent.version") -Value $versionEndpoint


Write-Host "=== Vale Command one-click install ($Hostname) ==="

# 1. Binary + config/token
$exe = Join-Path $InstallDir "vale-agent.exe"
$cfg = Join-Path $InstallDir "config.yaml"
Write-Host "`n[1/7] vale-agent binary"
# Re-download every run so fixes to the binary take effect, and kill any stray
# instance first so the exe file is not locked by a running process. This
# includes the legacy 0.8.x vale-command.exe: it holds port 18080 and would
# keep the OLD server serving the device after this install.
Get-Process vale-agent -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process vale-command -ErrorAction SilentlyContinue | Stop-Process -Force
# round-138/139/140: kill ONLY the bundled playwright node (command-line
# anchored on the bundle path — Get-Process node would kill every Node
# process; -ErrorAction SilentlyContinue so a CIM failure degrades to a
# no-op instead of aborting setup under EAP=Stop).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*\playwright\node.exe*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Legacy 0.8.x autostart: the ValeCommand service + tasks. The SCM starts the
# service before the ValeAgent boot task at every restart and wins the port,
# so the new server dies on bind. The boot task below is the canonical
# autostart — drop the service and the old tasks.
# NOTE: these items usually don't exist, and schtasks/sc.exe print an error
# on a missing item. Under $ErrorActionPreference=Stop, PS 5.1 turns that
# into a TERMINATING NativeCommandError EVEN with 2>$null (proven on d1:
# 'schtasks /End /TN ValeCommand 2>$null' aborted the script at [1/7]). The
# only reliable combo is scoping EAP to Continue around the calls (stderr
# discarded via 2>$null, no error record) and checking $LASTEXITCODE where
# a real failure matters.
$oldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    sc.exe stop ValeCommand 2>$null
    sc.exe delete ValeCommand 2>$null
    schtasks /End /TN ValeCommand 2>$null
    schtasks /Delete /TN ValeCommand /F 2>$null
    schtasks /End /TN ValeCommandTray 2>$null
    schtasks /Delete /TN ValeCommandTray /F 2>$null
    sc.exe delete ValeAgent 2>$null   # remove any old broken service
} finally {
    $ErrorActionPreference = $oldEAP
}
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
# Phase 3: playwright-mcp runtime (node.exe + dist/cli.js + node_modules).
# The NSIS installer bundles vale-playwright.zip for fresh installs; the
# script path downloads it on updates. PlaywrightManager spawns
# $InstallDir\playwright\ on the Plugins page Start. The bundle is ~30MB —
# over the download site's 25MiB Workers-Assets cap — so it sits NEXT TO the
# installer: /api/version geo-routes the installer URL (GitHub Releases
# worldwide, v.saisi.online for CN), and the bundle lives in the same
# directory. Derive the bundle URL from the manifest so this path follows
# the same routing; fall back to the mirror if the manifest is unreachable.
$pwUrl = "$Base/dl/vale-playwright.zip"
try {
    $manifest = Invoke-RestMethod $versionEndpoint
    if ($manifest.download) { $pwUrl = (Split-Path $manifest.download -Parent) + "/vale-playwright.zip" }
} catch { Write-Host "  (manifest unreachable — using default bundle URL)" }
$pwZip = Join-Path $InstallDir "vale-playwright.zip"
if (-not $SkipDownload) { Download-File $pwUrl $pwZip -Force }
$pwDir = Join-Path $InstallDir "playwright"
if (Test-Path $pwZip) {
    Remove-Item $pwDir -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $pwZip -DestinationPath $InstallDir -Force
    Write-Host "    playwright runtime -> $pwDir"
}
if (-not (Test-Path $cfg)) {
    Write-Host "  bootstrapping config + auth token"
    & $exe --init $cfg
}
# Serve on a high port: dev tools (e.g. VS Code port-forwarding) commonly squat
# the 127.0.0.1:3000/3001 loopback range, which would intercept the tunnel's
# origin connection and break the panel. 18080 is well out of that range.
# ANCHORED port rewrite: the old unanchored -replace corrupted any port
# starting with 3000/3001 (e.g. 30000 → 180800, u16 overflow) — the config
# got quarantined and the device token regenerated, 401-ing every client.
(Get-Content $cfg) -replace '^port: 3000$','port: 18080' -replace '^port: 3001$','port: 18080' | Set-Content $cfg
# Loopback bind (security): the server is reached ONLY via the cloudflared
# tunnel (ingress 127.0.0.2:18080) or locally on the device. A 0.0.0.0 bind
# exposed the whole API to the LAN and the /panel/ Host gate (which must
# accept Host: dN.agent... for the tunnel) is spoofable — LAN RCE as SYSTEM.
# Match the on-disk format EXACTLY: the embedded config.yaml writes
# `host: "0.0.0.0"` (quoted), so the anchor must allow optional quotes —
# the old `^host: 0\.0\.0\.0$` matched nothing and legacy devices stayed
# bound to 0.0.0.0 after install (round-53).
(Get-Content $cfg) -replace '^host: "?0\.0\.0\.0"?$','host: "127.0.0.2"' | Set-Content $cfg

# 2. cloudflared
Write-Host "`n[2/7] cloudflared"
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "  installing via winget..."
    # Same PS 5.1 stderr trap as the legacy cleanup: winget writes to stderr
    # on failure, which would abort under EAP=Stop — scope to Continue and
    # check the exit code.
    $oldEAP3 = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements 2>$null
    $ErrorActionPreference = $oldEAP3
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
            $resp = Invoke-RestMethod -Uri "$ConsoleUrl/api/install/tunnel-token" `
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
    $oldEAPl = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $cloudflared tunnel login
    $code = $LASTEXITCODE
    $ErrorActionPreference = $oldEAPl
    if ($code -ne 0) { throw "cloudflared tunnel login failed (exit $code)" }
}

# Authoritative hostname: prefer reusing the lowest-numbered existing
# vale-agent-dN tunnel (the original device). A buggy earlier run can leave a
# stale d2 in the config/hostname files; the tunnel list is the ground truth.
# EAP=Continue guard: cloudflared logs its version WRN to stderr, which PS 5.1
# turns into a terminating NativeCommandError under EAP=Stop — the whole setup
# aborted at [3/7] (d1, live: "your version X is outdated" killed the install
# before the tunnel config, boot task and agent start ever ran). Scope EAP to
# Continue like the winget/route-dns calls; a real failure still aborts via
# the $LASTEXITCODE check below.
$oldEAP4 = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$tunnels = & $cloudflared tunnel list 2>&1 | Out-String
$ErrorActionPreference = $oldEAP4
$ns = [regex]::Matches($tunnels, "vale-agent-d(\d+)") | ForEach-Object { [int]$_.Groups[1].Value }
if ($ns.Count -gt 0) {
    $lowest = ($ns | Measure-Object -Minimum).Minimum
    $Hostname = "d$lowest.$AgentDomain"
    Set-Content -Path $hostFile -Value $Hostname
}
# Console URL for the tray app ("打开控制台") — the console hostname is a
# worker var set at deploy time, so it is written here, not hardcoded in the exe.
Set-Content -Path (Join-Path $InstallDir "vale-agent.console") -Value "$ConsoleUrl/"
Set-Content -Path (Join-Path $InstallDir "vale-agent.version") -Value $versionEndpoint

Write-Host "  hostname: $Hostname"

# 4. Create tunnel + DNS route (per-device tunnel, idempotent).
# Each device machine gets its own tunnel named after its subdomain
# (vale-agent-d1, vale-agent-d2, ...) so machines never share a tunnel.
$tunnelName = "vale-agent-" + ($Hostname -split '\.')[0]
Write-Host "`n[4/7] tunnel create + DNS route ($tunnelName)"
$tunnelId = Get-TunnelId $cloudflared $tunnelName
if (-not $tunnelId) {
    $oldEAPc = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $created = & $cloudflared tunnel create $tunnelName 2>&1 | Out-String
    $ErrorActionPreference = $oldEAPc
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
$oldEAPr = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $cloudflared tunnel route dns $tunnelName $Hostname
$rc = $LASTEXITCODE
$ErrorActionPreference = $oldEAPr
if ($rc -ne 0) {
    throw "tunnel route dns failed (exit $rc)"
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
$action = New-ScheduledTaskAction -Execute $exe -Argument "`"$cfg`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
# ExecutionTimeLimit 0 = never kill the task. Default is 72h — the server
# (and the tray below) would silently stop after 3 days until a reboot.
# round-116: restart on failure — a crashed agent (panic, OOM kill) used to
# leave the device dark until reboot; the SCM restarts it (3 tries, 1 min
# apart). ExecutionTimeLimit 0 = never kill the task.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "ValeAgent" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if (-not (Get-ScheduledTask -TaskName "ValeAgent" -ErrorAction SilentlyContinue)) {
    throw "failed to register scheduled task ValeAgent"
}
Start-ScheduledTask -TaskName "ValeAgent" | Out-Null
Start-Sleep -Seconds 2

# Verify the agent actually listens on 18080 (a raw TCP probe is faster and
# cannot hang like PS 5.1's Invoke-WebRequest; the tunnel can lag behind, so
# probe locally). The boot task's agent also writes startup.log next to its
# exe — on failure print it here so the install output carries the diagnosis.
$agentOk = $false
for ($i = 0; $i -lt 10; $i++) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect("127.0.0.1", 18080, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(2000) -and $c.Connected) { $agentOk = $true }
    } catch { }
    $c.Close()
    if ($agentOk) { break }
    Write-Host "  (probe $($i+1)/10: agent not up yet...)"
    Start-Sleep -Seconds 2
}
if ($agentOk) {
    Write-Host "  OK: vale-agent serving on 127.0.0.1:18080"
} else {
    Write-Warning "  NOT serving on 18080 yet — vale-agent startup log:"
    $sl = Join-Path $InstallDir "startup.log"
    if (Test-Path $sl) { Get-Content $sl } else { Write-Warning "  (no startup.log at $sl)" }
}

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
$oldEAPk = $ErrorActionPreference
$ErrorActionPreference = "Continue"
# 2>$null, NOT 2>&1: cloudflared writes INF logs to stderr (version notice,
# "Installing cloudflared Windows service") — 2>&1 mixed them into stdout and
# the token came out polluted ("illegal base64 data at input byte 182", live
# on d1). With EAP=Continue (round-66) stderr no longer aborts, so discard it
# and take ONLY the clean stdout token.
$tunnelToken = (& $cloudflared tunnel token $tunnelName 2>$null | Out-String).Trim()
$tk = $LASTEXITCODE
$ErrorActionPreference = $oldEAPk
if ($tk -ne 0) { throw "cloudflared tunnel token failed: $tunnelToken" }
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
    # NOTE: `2>&1 | Out-Null` would still surface a NativeCommandError from
    # stderr under PS 5.1 — every benign-failure command here must use 2>$null
    # (errors land on stderr and are then checked via $LASTEXITCODE).
    # NEVER use `2>NUL` here: in PS 5.1 that makes Out-File write a FILE named
    # NUL ("要求 FileStream 打开一个不是文件的设备") and aborts the script —
    # the round-38 interactive-install failure. 2>$null is the only safe form.
    & $cloudflared service uninstall 2>$null
    for ($i = 0; $i -lt 10; $i++) {
        sc.exe query Cloudflared 2>$null
        if ($LASTEXITCODE -ne 0) { break }   # already gone
        taskkill /F /IM cloudflared.exe 2>$null
        sc.exe delete Cloudflared 2>$null
        Start-Sleep -Seconds 1
    }
    sc.exe query Cloudflared 2>$null
    if ($LASTEXITCODE -eq 0) { throw "Cloudflared service still exists - remove it manually (taskkill /F /IM cloudflared.exe; sc delete Cloudflared) then re-run." }
    # Leftover EventLog key from a previous install makes cloudflared fail the
    # event-logger registration and exit 1 even though the service installed
    # fine. Delete it first so the reinstall is clean.
    reg delete "HKLM\SYSTEM\CurrentControlSet\Services\EventLog\Application\Cloudflared" /f 2>$null
    & $cloudflared service install $tunnelToken
} finally {
    $ErrorActionPreference = $oldEAP
}
if ($LASTEXITCODE -ne 0) { throw "cloudflared service install failed (exit $LASTEXITCODE)" }
$oldEAP2 = $ErrorActionPreference
$ErrorActionPreference = "Continue"
sc.exe start Cloudflared 2>$null
$scCode = $LASTEXITCODE
# 1056 = ERROR_SERVICE_ALREADY_RUNNING. cloudflared's `service install`
# auto-starts the service, so a redundant start is a benign no-op — treat it
# as success, not a failure (this used to abort a fully successful install).
if ($scCode -ne 0 -and $scCode -ne 1056) { throw "cloudflared service failed to start (exit $scCode)" }
# round-116: failure auto-restart — a crashed cloudflared (memory leak,
# network blip, process killed) used to take the device OFFLINE until a
# human restarted the service. Configure the SCM to restart it (5s / 10s /
# 30s backoff, counter resets after 24h). Idempotent.
sc.exe failure Cloudflared reset= 86400 actions= restart/5000/restart/10000/restart/30000 2>$null
$ErrorActionPreference = $oldEAP2

Start-Sleep -Seconds 2
# 1.0 renamed auth_token → device_token; both may appear depending on the
# install that wrote config.yaml. Match either.
$token = (Select-String -Path $cfg -Pattern "auth_token:|device_token:" | Select-Object -First 1).Line

Write-Host "`n=== DONE ==="
Write-Host "Device: https://$Hostname/     (status page; API + MCP need the token)"
Write-Host "MCP   : https://$Hostname/mcp"
Write-Host "Token : $token"
Write-Host ""
Write-Host "Claude Code config:"
Write-Host "  { `"mcpServers`": { `"vale-agent`": { `"type`": `"http`", `"url`": `"https://$Hostname/mcp`", `"headers`": { `"Authorization`": `"Bearer <token>`" } } } }"
Write-Host ""
Write-Host "Give it ~10 seconds for the tunnel to come up, then connect Claude Code to the MCP URL (or open the console at $ConsoleUrl/)."

# Write a result file the NSIS installer's finish page reads to show the token.
# Strip surrounding quotes: a quoted line (device_token: "<hex>") captured
# the literal quotes before, so the registered/printed token diverged from
# the real one and every MCP/panel client 401'd.
if ($token -match 'token:\s*"?([^"\s]+)"?') { $tokenVal = $Matches[1] } else { $tokenVal = "" }
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
    Write-Host "`n[8/8] registering with Vale console ($ConsoleUrl)"
    $regName = ($Hostname -split '\.')[0]
    $regBody = @{ key = $env:VALE_REG_KEY; name = $regName; hostname = $Hostname; token = $tokenVal } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "$ConsoleUrl/api/register" -Method Post `
            -ContentType "application/json" -Body $regBody | Out-Null
        Write-Host "  registered $regName -> console (hostname/token auto-configured)."
    } catch {
        $respDetail = $_.ErrorDetails.Message
        Write-Warning "  auto-register failed: $($_.Exception.Message)"
        if ($respDetail) { Write-Warning "  server said: $respDetail" }
        Write-Warning "  Add this device manually in the console: name=$regName host=$Hostname token=$tokenVal"
    }
    # The registration key is single-use — never leave it on disk where any
    # local user could read it and mint Cloudflare API tokens.
    if ($regKeyFile -and (Test-Path $regKeyFile)) { Remove-Item $regKeyFile -Force }
}
