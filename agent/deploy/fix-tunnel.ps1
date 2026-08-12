# fix-tunnel.ps1 — repair the cloudflared tunnel config after a Vale Agent
# migration. The old install used a tunnel named vale-command-dN with the
# *.command.saisi.online hostname; the new install created vale-agent-dN with
# *.agent.saisi.online. If the running cloudflared config still references the
# old tunnel or hostname, rewrite both (user + systemprofile copies) to the
# new tunnel + hostname and restart the cloudflared service.
#
# Idempotent: a config already on the new tunnel/hostname is untouched.
$ErrorActionPreference = "Stop"

function Get-TunnelId($cloudflared, $Name) {
    $list = & $cloudflared tunnel list --name $Name 2>&1 | Out-String
    if ($list -match '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})') { return $Matches[1] }
    return $null
}

# Find the new agent tunnel (vale-agent-dN) by DNS probe of the device hostname.
$hostFile = "C:\vale-agent\vale-agent.hostname"
if (-not (Test-Path $hostFile)) { $hostFile = "D:\vale-command\vale-agent.hostname" }
if (-not (Test-Path $hostFile)) { $hostFile = "D:\vale-agent\vale-agent.hostname" }
$hostname = ""
if (Test-Path $hostFile) { $hostname = (Get-Content $hostFile -Raw).Trim() }
if (-not $hostname) { $hostname = "d1.agent.saisi.online" }
$tunnelName = "vale-agent-" + ($hostname -split '\.')[0]

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { Write-Host "!! cloudflared not found"; exit 1 }
# Find the agent tunnel by NAME, not by the first UUID in `tunnel list` — the
# legacy vale-command-dN tunnels still exist and Get-TunnelId's regex could
# match one of them, writing the OLD tunnel into the config.
$list = & $cloudflared tunnel list 2>&1 | Out-String
$newTunnel = ""
if ($list -match "([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})\s+$([regex]::Escape($tunnelName))\s") {
    $newTunnel = $Matches[1]
}
if (-not $newTunnel) {
    Write-Host "!! tunnel $tunnelName not found in tunnel list — create it (cloudflared tunnel create $tunnelName)"
    exit 1
}

$files = @(
    (Join-Path $env:USERPROFILE ".cloudflared\config.yml"),
    (Join-Path $env:SystemRoot "System32\config\systemprofile\.cloudflared\config.yml"),
    $hostFile
)
foreach ($f in $files) {
    if (-not (Test-Path $f)) { continue }
    $c = Get-Content $f -Raw
    $changed = $false
    # Old tunnel ID (vale-command-dN) → new agent tunnel ID
    if ($c -match 'tunnel:\s*[0-9a-fA-F-]{36}' -and $c -notmatch [regex]::Escape($newTunnel)) {
        $c = $c -replace 'tunnel:\s*[0-9a-fA-F-]{36}', "tunnel: $newTunnel"
        $changed = $true
    }
    # Old command hostname → agent hostname
    if ($c -match '\.command\.saisi\.online') {
        $c = $c -replace '\.command\.saisi\.online', '.agent.saisi.online'
        $changed = $true
    }
    if ($changed) {
        Set-Content $f $c -Encoding ascii
        Write-Host "  fixed: $f"
    }
    # Diagnostic log — written next to the install dir so it can be fetched
    # via the panel/API instead of asking the user to read files.
    $logDir = Split-Path $hostFile -Parent
    if ($logDir) {
        $log = Join-Path $logDir "fix-tunnel.log"
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') file=$f changed=$changed newTunnel=$newTunnel hostname=$hostname" |
            Out-File -FilePath $log -Append -Encoding utf8
    }
}

# Also clean up legacy names in vale-agent's config.yaml: `name` should be
# vale-agent (not vale-command). The token field is NOT touched — the new
# install already writes device_token, and rewriting a legacy auth_token could
# clobber the fresh token.
$cfgCandidates = @(
    (Join-Path $env:USERPROFILE ".vale-agent\config.yaml"),
    "C:\vale-agent\config.yaml",
    "C:\vale-command\config.yaml",
    "D:\vale-command\config.yaml",
    "D:\vale-agent\config.yaml"
)
foreach ($cfg in $cfgCandidates) {
    if (-not (Test-Path $cfg)) { continue }
    $c = Get-Content $cfg -Raw
    if ($c -match 'name:\s*vale-command') {
        $c = $c -replace 'name:\s*vale-command', 'name: vale-agent'
        Set-Content $cfg $c -Encoding ascii
        Write-Host "  fixed config: $cfg"
    }
}

# Ensure the tunnel has a real DNS route for the hostname (a bare CNAME is not
# a route — without this the tunnel 530s with error 1033). --overwrite replaces
# any pre-existing record with a proper tunnel route.
# NOTE: cloudflared logs its INF lines to stderr, which PS 5.1 turns into a
# terminating NativeCommandError under EAP=Stop even with 2>&1 — scope EAP to
# Continue and rely on the exit code, so a benign 'already configured' message
# cannot abort the script BEFORE the cloudflared restart below.
$oldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $cloudflared tunnel route dns $tunnelName $hostname 2>$null
$routeCode = $LASTEXITCODE
$ErrorActionPreference = $oldEAP
if ($routeCode -ne 0) {
    Write-Host "  !! route dns failed (exit $routeCode) — add the Public Hostname in the dashboard"
} else {
    Write-Host "  route dns ok: $hostname → $tunnelName"
}

# Restart cloudflared so the new config takes effect
$oldEAP2 = $ErrorActionPreference
$ErrorActionPreference = "Continue"
sc.exe stop cloudflared 2>$null | Out-Null
Start-Sleep -Seconds 2
sc.exe start cloudflared 2>$null | Out-Null
$ErrorActionPreference = $oldEAP2
Write-Host "  cloudflared restarted (tunnel $tunnelName → $newTunnel, hostname $hostname)"
