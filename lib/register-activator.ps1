param(
  [string]$Aumid = 'DeepSeekHarness.DesktopNotify',
  [string]$Clsid = '{D7A1F0B2-3C4D-4E5F-9A0B-1C2D3E4F5A6B}'
)

# ASCII-only on purpose.
#
# Registers the COM local server half of the notification identity:
#   HKCU\Software\Classes\CLSID\{clsid}\LocalServer32  -> the activator EXE
#   HKCU\Software\Classes\AppUserModelId\<AUMID>       -> CustomActivator = {clsid}
# Windows launches the EXE and calls INotificationActivationCallback.Activate
# when the user clicks a toast owned by that AUMID.

$ErrorActionPreference = 'Stop'

$exe = Join-Path $PSScriptRoot 'dsh-notify-activator.exe'
if (-not (Test-Path -LiteralPath $exe)) { Write-Output 'activator-exe-missing'; exit 2 }

$clsidKey = "HKCU:\Software\Classes\CLSID\$Clsid"
New-Item -Path $clsidKey -Force | Out-Null
New-ItemProperty -Path $clsidKey -Name '(Default)' -Value 'DSH desktop notification activator' -PropertyType String -Force | Out-Null
$server = Join-Path $clsidKey 'LocalServer32'
New-Item -Path $server -Force | Out-Null
New-ItemProperty -Path $server -Name '(Default)' -Value ('"' + $exe + '"') -PropertyType String -Force | Out-Null

$aumidKey = "HKCU:\Software\Classes\AppUserModelId\$Aumid"
New-Item -Path $aumidKey -Force | Out-Null
New-ItemProperty -Path $aumidKey -Name 'DisplayName' -Value 'DeepSeek Harness' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $aumidKey -Name 'CustomActivator' -Value $Clsid -PropertyType String -Force | Out-Null

$ls = (Get-ItemProperty $server).'(default)'
$ca = (Get-ItemProperty $aumidKey).CustomActivator
Write-Output ('LocalServer32 = ' + $ls)
Write-Output ('CustomActivator = ' + $ca)
if ($ca -ne $Clsid) { Write-Output 'verify-failed'; exit 3 }
Write-Output 'activator-registered'
