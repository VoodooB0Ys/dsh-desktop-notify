param(
  # Restart DeepSeek Harness after the checks. Code changes (lib/*.js) are only
  # picked up on restart - hot reload re-runs apply() but Node's ESM cache keeps
  # serving the old module (verified 2026-10-01).
  [switch]$Restart
)

# Layout on this machine (since 2026-10-02):
#
#   dev folder   <this repo>                       git source of truth, NOT loaded by DSH
#   installed    %USERPROFILE%\.dsh\plugins\dsh-desktop-notify
#                GitHub clone (gh repo clone), the junction target the profile loads
#
# Updating the installation:  git -C %USERPROFILE%\.dsh\plugins\dsh-desktop-notify pull
# then restart the harness. This script checks the wiring and optionally restarts.

$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$installed = Join-Path $env:USERPROFILE '.dsh\plugins\dsh-desktop-notify'
$junction = Join-Path $profileDir 'node_modules\dsh-desktop-notify'
$ok = $true

# 1. profile dependency points at the installed clone
$pkg = Get-Content -Raw (Join-Path $profileDir 'package.json')
if ($pkg -match 'dsh-desktop-notify"\s*:\s*"link:[^"]*plugins/dsh-desktop-notify"') {
  Write-Host 'ok   profile dependency -> plugins clone'
} else {
  Write-Warning 'profile dependency does not point at the plugins clone'
  $ok = $false
}

# 2. junction target
$target = (Get-Item -LiteralPath $junction -Force).Target
if (-not $target) {
  # PS 5.1 does not always populate .Target for junctions; fall back to dir output
  $dirLine = cmd /c "dir ""$profileDir\node_modules"" | findstr /i desktop-notify"
  if ($dirLine -match '\[(.+)\]\s*$') { $target = @($Matches[1]) }
}
if ($target -and ($target | Where-Object { $_ -ieq $installed })) {
  Write-Host 'ok   junction -> plugins clone'
} else {
  Write-Warning "junction target is '$($target -join ',')', expected '$installed'"
  $ok = $false
}

# 3. installed clone is on latest main
$ErrorActionPreference = 'Continue'
git -C $installed fetch origin main 2>&1 | Out-Null
$behind = git -C $installed rev-list --count main..origin/main 2>&1
$ErrorActionPreference = 'Stop'
if ("$behind" -eq '0') {
  Write-Host 'ok   installed clone is up to date with origin/main'
} else {
  Write-Warning "installed clone is $behind commit(s) behind origin/main - run: git -C `"$installed`" pull"
  $ok = $false
}

if (-not $ok) { exit 1 }
Write-Host 'wiring OK.'

if (-not $Restart) {
  Write-Host 'run with -Restart to restart DeepSeek Harness (needed after lib/*.js changes).'
  exit 0
}

Write-Host 'restarting DeepSeek Harness...'
$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
$main = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($main) {
  Write-Host ("closing main window (pid {0})..." -f $main.Id)
  [void]$main.CloseMainWindow()
  Start-Sleep -Seconds 8
}
$left = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($left) {
  Write-Host ("force-stopping remaining processes: " + ($left.Id -join ','))
  $left | Stop-Process -Force
  Start-Sleep -Seconds 2
}
Start-Sleep -Milliseconds 500
Start-Process -FilePath 'D:\DSH\DeepSeek Harness.exe'
Write-Host 'relaunched. Check ~/.dsh/dsh-desktop-notify.log for a fresh "plugin loaded" line.'
