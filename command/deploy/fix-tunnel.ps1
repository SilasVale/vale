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
$newTunnel = Get-TunnelId $cloudflared $tunnelName
if (-not $newTunnel) {
    Write-Host "!! tunnel $tunnelName not found — create it (cloudflared tunnel create $tunnelName)"
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

# Restart cloudflared so the new config takes effect
sc.exe stop cloudflared 2>$null | Out-Null
Start-Sleep -Seconds 2
sc.exe start cloudflared 2>$null | Out-Null
Write-Host "  cloudflared restarted (tunnel $tunnelName → $newTunnel, hostname $hostname)"
