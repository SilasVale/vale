# build-windows.ps1 - build the headless vale-command binary on Windows.
#
# Usage:  .\deploy\build-windows.ps1            (debug)
#         .\deploy\build-windows.ps1 -Release    (release)
#
# Output: target\debug\vale-command.exe  or  target\release\vale-command.exe

param([switch]$Release)

$feature = "terminal,browser"   # serial/SSH/PTY + headless Edge/Chrome.
# Drop `browser` if you only need serial/terminal:  $feature = "terminal"

$config = if ($Release) { "--release" } else { "" }
$args = @("build", "--features", $feature) + @($config) + @("--bin", "vale-command")

Write-Host "cargo $($args -join ' ')"
cargo @args

$out = if ($Release) { "target\release\vale-command.exe" } else { "target\debug\vale-command.exe" }
if (Test-Path $out) {
    Write-Host "Built: $out"
} else {
    Write-Host "Build finished but $out not found." -ForegroundColor Yellow
}
