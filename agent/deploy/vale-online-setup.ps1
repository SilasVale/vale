#Requires -Version 5.1
<#
  Vale Agent 在线安装引导脚本（NSIS 安装包内嵌调用，也可手动运行）。
  只做最小引导，真正的安装复用 npm 通道本身：
    Node（复用现有的，缺失才下载便携版）→ npm i -g  pinned tgz →
    vale setup → Electron → 桌面任务/快捷方式。
  更新通道不变：装完之后一律 `vale update`。

  参数：
    -InstallDir  安装目录（默认 C:\Program Files\Vale）
    -ValeVersion 钉死的版本号（必填，如 1.2.306）
    -CdnBase    安装源（默认 https://agent.saisi.online）
    -RegKey     可选：网关注册码（自动登记设备）
    -Tunnel     可选：tunnel 主机名（vale setup --tunnel）
    -ResultFile 安装结果回执（NSIS 完成页读取）
    -LocalTgz   可选：自带 tgz 路径（自包含安装包内嵌，优先用它，免下载）
    -ResultFile 安装结果回执（NSIS 完成页读取）
#>
param(
  [string]$InstallDir = "C:\Program Files\Vale",
  [Parameter(Mandatory = $true)][string]$ValeVersion,
  [string]$CdnBase = "https://agent.saisi.online",
  [string]$RegKey = "",
  [string]$Tunnel = "",
  [string]$ResultFile = "",
  [string]$DataDir = (Join-Path $env:ProgramData "Vale"),
  [string]$LocalTgz = ""
)

$ErrorActionPreference = "Stop"
$ElectronVersion = "33.4.11"
$NodeFloorMajor = 18

function Say([string]$m) { Write-Host "[vale-setup] $m" }

# --- admin 自检（NSIS 本来就要提权；手动跑脚本时给一句人话） ---
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "[vale-setup] 需要管理员权限：请右键“以管理员身份运行”。"
  exit 3
}
if (-not [Environment]::Is64BitOperatingSystem) {
  Write-Host "[vale-setup] 仅支持 64 位 Windows。"
  exit 3
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "etc") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "components") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "scripts") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "logs") | Out-Null
try { Start-Transcript -Path (Join-Path $DataDir "logs\installer.log") -Append | Out-Null } catch { }

function Download-File([string]$url, [string]$dest, [string]$what) {
  # 主源一次 + 备用源一次；调用方决定失败是否致命。
  $mirrors = @($url)
  if ($url -like "https://nodejs.org/*") { $mirrors += $url -replace "https://nodejs.org", "https://npmmirror.com/mirrors/node" }
  if ($url -like "https://registry.npmjs.org/*") { $mirrors += $url -replace "https://registry.npmjs.org", "https://registry.npmmirror.com" }
  foreach ($u in $mirrors) {
    try {
      Say "下载 $what ..."
      Invoke-WebRequest -Uri $u -OutFile $dest -UseBasicParsing -TimeoutSec 120
      if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) { return $true }
    } catch { Say "$what 下载失败（$u）：$($_.Exception.Message)" }
  }
  return $false
}

# --- 1. Node：复用现有的，版本太旧或缺失才装便携版 ---
# Layout v2: portable node lives at components\node.
$NodeDir = Join-Path $InstallDir "components\node"
$nodeExe = ""
try {
  $found = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($found) {
    $v = (& $found --version) 2>$null
    if ($v -match "v(\d+)\.") {
      if ([int]$Matches[1] -ge $NodeFloorMajor) { $nodeExe = $found; Say "复用系统 Node $v ($found)" }
      else { Say "系统 Node $v 太旧（要 >= v$NodeFloorMajor），装便携版" }
    }
  }
} catch { }
if (-not $nodeExe) {
  # 解析最新 LTS（nodejs.org 主，npmmirror 备；都挂则本机无网，直接结束）
  $lts = ""
  foreach ($idx in @("https://nodejs.org/dist/index.json", "https://npmmirror.com/mirrors/node/index.json")) {
    try { $lts = (Invoke-RestMethod -Uri $idx -UseBasicParsing -TimeoutSec 30 | Where-Object { $_.lts } | Select-Object -First 1).version; if ($lts) { break } } catch { }
  }
  if (-not $lts) { Write-Host "[vale-setup] 拿不到 Node 版本列表（网络不通？），退出。"; exit 5 }
  Say "最新 LTS Node $lts"
  $zip = Join-Path $env:TEMP "vale-node.zip"
  $zipUrl = "https://nodejs.org/dist/$lts/node-$lts-win-x64.zip"
  if (-not (Download-File $zipUrl $zip "Node $lts")) { Write-Host "[vale-setup] Node 下载失败，退出。"; exit 5 }
  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  Expand-Archive -Force -Path $zip -DestinationPath (Join-Path $InstallDir "components")
  Move-Item (Join-Path $InstallDir "components\node-$lts-win-x64") $NodeDir -Force
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
  $nodeExe = Join-Path $NodeDir "node.exe"
  Say "便携 Node 就绪：$nodeExe"
}
$nodeBinDir = Split-Path $nodeExe -Parent
# Layout v2: the npm global prefix lives at components\npm-global (was tools\).
$NpmGlobal = Join-Path $InstallDir "components\npm-global"
# 本机 PATH（新进程生效；vale setup 的 where node 也能找到它）
try {
  $mp = [Environment]::GetEnvironmentVariable("Path", "Machine")
  foreach ($p in @($nodeBinDir, $NpmGlobal)) {
    if ($mp -notlike "*$p*") { $mp = "$mp;$p" }
  }
  [Environment]::SetEnvironmentVariable("Path", $mp, "Machine")
} catch { Say "写 Machine PATH 失败（继续，当前会话 PATH 已就绪）" }
$env:Path = "$nodeBinDir;$NpmGlobal;$env:Path"
$npmCmd = Join-Path $nodeBinDir "npm.cmd"
if (-not (Test-Path $npmCmd)) { Write-Host "[vale-setup] 找不到 npm.cmd（$nodeBinDir），退出。"; exit 5 }

# --- 2. npm 装 pinned 的 vale-agent（这就是以后的更新通道） ---
# 自包含安装包优先用内嵌 tgz（LocalTgz，NSIS 打包时 File 进去）——无网络、
# 被 prune 的老版本照样能装；手动跑脚本时缺省走 CDN 下载（原逻辑不变）。
$tgz = "$CdnBase/vale-agent/vale-agent-$ValeVersion.tgz"
$tgzSource = "cdn"
if ($LocalTgz -and (Test-Path $LocalTgz)) {
  $tgz = $LocalTgz
  $tgzSource = "bundled"
  Say "使用自带安装包 $ValeVersion（免下载）..."
} else {
  if ($LocalTgz) { Say "自带包缺失（$LocalTgz），回退 CDN 下载..." }
  Say "安装 vale-agent $ValeVersion ..."
}
& $npmCmd install -g --prefix $NpmGlobal $tgz
if ($LASTEXITCODE -ne 0) { Write-Host "[vale-setup] npm 安装失败，退出。"; exit 6 }
$valeCmd = Join-Path $NpmGlobal "vale.cmd"
if (-not (Test-Path $valeCmd)) { Write-Host "[vale-setup] vale.cmd 没生成，退出。"; exit 6 }

# --- 3. cloudflared：能带上就带上（setup 会 stage 进 tools/）；失败不致命 ---
try {
  $pkgDir = Join-Path $NpmGlobal "node_modules\vale-agent"
  $cfDest = Join-Path $pkgDir "cloudflared.exe"
  if (-not (Test-Path $cfDest)) {
    if (Download-File "$CdnBase/vale-agent/cloudflared.exe" $cfDest "cloudflared") { Say "cloudflared 已随包" }
    else { Say "cloudflared 跳过（以后用 tunnel 时 agent 会自己拉）" }
  }
} catch { Say "cloudflared 跳过：$($_.Exception.Message)" }

# --- 4. vale setup（目录/注册表/任务/防火墙/注册全是它做） ---
$env:VALE_AGENT_DIR = $InstallDir
$setupArgs = @("setup")
if ($RegKey) { $setupArgs += @("--reg-key", $RegKey) }
if ($Tunnel) { $setupArgs += @("--tunnel", $Tunnel) }
Say "运行 vale setup ..."
& $valeCmd @setupArgs
if ($LASTEXITCODE -ne 0) { Write-Host "[vale-setup] vale setup 失败，退出。"; exit 7 }

# --- 5. Electron（桌面壳二进制；主源=我们的 CDN，备源=npm；失败只告警） ---
# Layout v2: the shell lives at components\vale-desktop-electron.
# The shell is launched as `electron .` from node_modules\electron\dist.
$shellDir = Join-Path $InstallDir "components\vale-desktop-electron"
$distDir = Join-Path $shellDir "node_modules\electron\dist"
$electronExe = Join-Path $distDir "electron.exe"
$electronOk = Test-Path $electronExe
# PRIMARY: pull the win32-x64 dist zip from our own CDN (index worker proxies
# it from GitHub). npmjs/npmmirror are unreachable on many device boxes — that
# is exactly why fresh installs shipped a desktop shell with no Electron.
if (-not $electronOk) {
  New-Item -ItemType Directory -Force -Path $distDir | Out-Null
  $zip = Join-Path $env:TEMP "vale-electron-win32-x64.zip"
  Say "下载 Electron $ElectronVersion（约 115MB，走我们的 CDN）..."
  $got = $false
  try {
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri "$CdnBase/vale-agent/electron-win32-x64.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 900
    if ((Test-Path $zip) -and ((Get-Item $zip).Length -gt 1MB)) { $got = $true }
  } catch { Say "Electron CDN 下载失败：$($_.Exception.Message)" }
  if ($got) {
    try {
      $tmpx = Join-Path $env:TEMP "vale-electron-x"
      if (Test-Path $tmpx) { Remove-Item -Recurse -Force $tmpx }
      Expand-Archive -Force -Path $zip -DestinationPath $tmpx
      # The zip root holds electron.exe + *.dll + resources\ + locales\ —
      # copy its CONTENTS into dist\ (so dist\electron.exe exists).
      Copy-Item -Path (Join-Path $tmpx "*") -Destination $distDir -Recurse -Force
      Remove-Item -Recurse -Force $tmpx -ErrorAction SilentlyContinue
      Remove-Item -Force $zip -ErrorAction SilentlyContinue
    } catch { Say "Electron 解压失败：$($_.Exception.Message)" }
  }
  $electronOk = Test-Path $electronExe
}
# FALLBACK: npm (only works where the registry is reachable). Needs the shell
# package.json (now written by `vale setup`); kept for boxes that can reach
# npm but where the CDN zip somehow failed.
if (-not $electronOk -and (Test-Path (Join-Path $shellDir "package.json"))) {
  Push-Location $shellDir
  try {
    Say "回退：npm 安装 Electron $ElectronVersion ..."
    & $npmCmd install --no-save "electron@$ElectronVersion" 2>&1 | Select-Object -Last 2
    if (-not (Test-Path "node_modules\electron\dist\electron.exe")) {
      $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
      & $npmCmd install --no-save "electron@$ElectronVersion" --registry=https://registry.npmmirror.com 2>&1 | Select-Object -Last 2
    }
  } catch { Say "Electron 安装异常：$($_.Exception.Message)" }
  Pop-Location
  $electronOk = Test-Path $electronExe
}
if ($electronOk) { Say "Electron 就绪" } else { Say "警告：Electron 没装上（桌面壳跑不起来，agent 本体不受影响；可稍后手动 npm 装）" }

# --- 6. ValeDesktop 登录任务（没有才建；形态抄 update 流的 hardened 版） ---
# Layout v2: supervisor scripts live in scripts\. The three launcher files
# are written UNCONDITIONALLY (idempotent refresh on re-run — the old code
# only wrote them inside the create-task branch, so a repair run left stale
# or missing launchers): start-desktop.ps1 (electron entry), the guarded
# ensure-desktop.ps1 pulse, and its console-less VBS wrapper.
try {
  $sdPath = Join-Path $InstallDir "scripts\start-desktop.ps1"
  $sdLines = @(
    ("`$dir = '" + $shellDir.Replace("'","''") + "'"),
    'Set-Location $dir',
    '& "$dir\node_modules\electron\dist\electron.exe" .'
  )
  Set-Content -Path $sdPath -Value $sdLines -Encoding ASCII
  $en1 = Join-Path $InstallDir "scripts\ensure-desktop.ps1"
  $vb1 = Join-Path $InstallDir "scripts\desktop-pulse.vbs"
  Set-Content -Path $en1 -Value ('if (Get-Process electron -ErrorAction SilentlyContinue) { exit }; & powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir "scripts\start-desktop.ps1") + '"') -Force
  Set-Content -Path $vb1 -Value ('CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & "' + (Join-Path $InstallDir "scripts\ensure-desktop.ps1") + '" & Chr(34), 0, False') -Force
  if ($null -eq (Get-ScheduledTask -TaskName "ValeDesktop" -ErrorAction SilentlyContinue)) {
    $da = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vb1 + '"') -WorkingDirectory $InstallDir
    $dt1 = New-ScheduledTaskTrigger -AtLogOn
    $dw1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 5)
    Register-ScheduledTask ValeDesktop -Action $da -Trigger @($dt1, $dw1) -Force | Out-Null
    Say "ValeDesktop 登录任务已创建"
  }
  Start-ScheduledTask -TaskName "ValeDesktop" -ErrorAction SilentlyContinue
} catch { Say "ValeDesktop 任务跳过（行 $($_.InvocationInfo.ScriptLineNumber)）：$($_.Exception.Message)" }

# --- 7. 桌面快捷方式（公共桌面 + 当前用户桌面；目标早已不是那个删掉的旧壳） ---
try {
  $ws = New-Object -ComObject WScript.Shell
  $ico = Join-Path $shellDir "icon.ico"
  foreach ($desk in @([Environment]::GetFolderPath("CommonDesktopDirectory"), [Environment]::GetFolderPath("Desktop"))) {
    if (-not $desk) { continue }
    $lnk = Join-Path $desk "Vale.lnk"
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $s.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir "scripts\start-desktop.ps1") + '"'
    $s.WorkingDirectory = $shellDir
    if (Test-Path $ico) { $s.IconLocation = "$ico,0" }
    $s.Save()
  }
  Say "桌面快捷方式就绪"
} catch { Say "快捷方式跳过：$($_.Exception.Message)" }

# --- 8. 回执（NSIS 完成页读这个；绝不写 token） ---
# Layout v2: config in etc\, receipt in DataDir\logs\.
$port = "18080"
try { $p = Select-String -Path (Join-Path $InstallDir "etc\config.yaml") -Pattern "^\s*port:\s*(\d+)" | Select-Object -First 1; if ($p -and $p.Matches.Groups[1].Value) { $port = $p.Matches.Groups[1].Value } } catch { }
$lines = @(
  "DONE Vale Agent $ValeVersion 安装完成",
  "面板： http://127.0.0.1:$port/desktop/",
  "目录： $InstallDir",
  ("桌面壳 Electron：" + ($(if ($electronOk) { "就绪" } else { "未装上（见上方警告）" })))
)
if (-not $ResultFile) { $ResultFile = Join-Path $DataDir "logs\install-result.txt" }
$lines | Set-Content -Path $ResultFile -Encoding UTF8
$lines | ForEach-Object { Say $_ }
# 自包含包的内嵌 tgz 用完即删（~6MB 死重；重跑安装包会重新解压出来）。
# 只删"自带的那一份"（LocalTgz 指向的文件），不动用户手里的东西。
if (($tgzSource -eq "bundled") -and $LocalTgz) {
  try { Remove-Item -Force -ErrorAction Stop $LocalTgz; Say "内嵌安装包已清理" } catch { Say "内嵌安装包清理跳过（不影响使用）" }
}
try { Stop-Transcript | Out-Null } catch { }
exit 0
