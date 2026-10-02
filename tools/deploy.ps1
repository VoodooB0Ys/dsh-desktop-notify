param(
  # Restart DeepSeek Harness after the sync. Code changes (lib/*.js) are only
  # picked up on restart - hot reload re-runs apply() but Node's ESM cache
  # keeps serving the old module (verified 2026-10-01).
  [switch]$Restart
)

# Sync the workspace copy of dsh-desktop-notify to the live directory that the
# DeepSeek Harness desktop profile actually loads. The profile resolves
# "dsh-desktop-notify" through a junction to ~/.dsh/my-dsh/dsh-desktop-notify,
# so editing the workspace repo alone never changes runtime behavior.
#
# The workspace repo is the single source of truth; the live copy is generated.

$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $PSScriptRoot
$target = Join-Path $env:USERPROFILE '.dsh\my-dsh\dsh-desktop-notify'

if (-not (Test-Path -LiteralPath $target)) {
  Write-Error "live directory not found: $target"
  exit 1
}

# Remember the exe path while the app is still running, so the restart can
# relaunch exactly the installation that was in use.
$exes = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path } |
  Select-Object -ExpandProperty Path -Unique)
$exePath = if ($exes.Count -gt 0) { $exes[0] } else { 'D:\DSH\DeepSeek Harness.exe' }

Write-Host "source: $source"
Write-Host "target: $target"

robocopy (Join-Path $source 'lib') (Join-Path $target 'lib') /E /NJH /NJS /NDL /NFL /NP | Out-Null
$rc = $LASTEXITCODE
# robocopy exit codes 0-7 are success (1 = files copied, 3 = copied + extras...)
if ($rc -ge 8) {
  Write-Error "robocopy failed with exit code $rc"
  exit 1
}
Write-Host "lib/ synced (robocopy exit $rc)"

foreach ($name in @('cordis.patch.yml', 'package.json', 'README.md', 'README.en.md')) {
  $file = Join-Path $source $name
  if (Test-Path -LiteralPath $file) {
    Copy-Item -LiteralPath $file -Destination (Join-Path $target $name) -Force
    Write-Host "copied  $name"
  }
}

if (-not $Restart) {
  Write-Host 'done. NOTE: lib code changes require a Harness restart to take effect (use -Restart).'
  exit 0
}

Write-Host "restarting DeepSeek Harness ($exePath)..."
# Electron's child processes have no window and refuse a graceful taskkill, and the
# app parks itself in the tray when its window closes - so: close the main window,
# give it a moment, then force-stop whatever is left (state is persisted to disk
# continuously, so this loses nothing but in-memory UI state).
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
Start-Process -FilePath $exePath
Write-Host 'relaunched. Give it ~20s to boot, then check ~/.dsh/dsh-desktop-notify.log for a fresh "plugin loaded" line.'
