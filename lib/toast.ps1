param(
  [Parameter(Mandatory = $true)][string]$TitleFile,
  [Parameter(Mandatory = $true)][string]$BodyFile,
  [string]$Kind = 'completion',
  [string]$Sound = '1',
  [string]$Scenario = '',
  [string]$Urgent = '0',
  [string]$SessionId = '',
  [string]$Aumid = 'DeepSeekHarness.DesktopNotify',
  [string]$IconPath = ''
)

# ASCII-only on purpose: the host passes Chinese title/body through UTF-8 temp
# files, because PowerShell 5.1 would read a UTF-8 script as ANSI.
#
# Click-to-open: when a session id is supplied the toast declares
#   activationType="foreground" launch="<sessionId>"
# and this script registers the COM activator referenced below.
# Clicking the toast runs the COM activator above, which hands the host the
# conversation to open and relaunches the app to raise its window.
#
# The toast's own audio is ALWAYS silent: the OS reminder/alarm sounds are long
# and looping, so we play a short SystemSounds cue ourselves via -Sound.
#
# Exit codes: 0 = toast with scenario, 4 = minimal toast, 5 = balloon, 1 = failed.

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Scenario)) {
  if ($Urgent -eq '1') { $Scenario = 'reminder' } else { $Scenario = 'plain' }
}

$title = (Get-Content -LiteralPath $TitleFile -Raw -Encoding UTF8).Trim()
$body = (Get-Content -LiteralPath $BodyFile -Raw -Encoding UTF8).Trim()
if ([string]::IsNullOrWhiteSpace($title)) { $title = 'DeepSeek Harness' }


function Register-Aumid {
  param([string]$Id, [string]$Icon)
  try {
    $key = "HKCU:\Software\Classes\AppUserModelId\$Id"
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name 'DisplayName' -Value 'DeepSeek Harness' -PropertyType String -Force | Out-Null
    if (-not [string]::IsNullOrWhiteSpace($Icon) -and (Test-Path -LiteralPath $Icon)) {
      New-ItemProperty -Path $key -Name 'IconUri' -Value $Icon -PropertyType String -Force | Out-Null
    }
  } catch {
    # Silent failure once cost us the toast header name: the key existed with only
    # CustomActivator on it and Windows showed a fallback title. Say it out loud.
    [Console]::Error.WriteLine('aumid register failed: ' + $_.Exception.Message)
  }
}

function Register-Activation {
  try {
    # A URI-protocol registration used to live here. Windows never routed
    # toast clicks to it for unpackaged apps (verified by trace), so only the
    # COM activator half remains - that is what Windows actually uses.
    $exe = Join-Path $PSScriptRoot 'dsh-notify-activator.exe'
    if (Test-Path -LiteralPath $exe) {
      $clsid = '{D7A1F0B2-3C4D-4E5F-9A0B-1C2D3E4F5A6B}'
      $clsidKey = "HKCU:\Software\Classes\CLSID\$clsid"
      New-Item -Path $clsidKey -Force | Out-Null
      New-ItemProperty -Path $clsidKey -Name '(Default)' -Value 'DSH desktop notification activator' -PropertyType String -Force | Out-Null
      $server = Join-Path $clsidKey 'LocalServer32'
      New-Item -Path $server -Force | Out-Null
      New-ItemProperty -Path $server -Name '(Default)' -Value ('"' + $exe + '"') -PropertyType String -Force | Out-Null
    $aumidKey = "HKCU:\Software\Classes\AppUserModelId\$Aumid"
    New-Item -Path $aumidKey -Force | Out-Null
    # Belt and braces: this path demonstrably works (CustomActivator survives),
    # so make sure the display name exists even if Register-Aumid ever fails.
    New-ItemProperty -Path $aumidKey -Name 'DisplayName' -Value 'DeepSeek Harness' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $aumidKey -Name 'CustomActivator' -Value $clsid -PropertyType String -Force | Out-Null
    }
  } catch { }
}

function Play-Sound {
  param([string]$K)
  try {
    switch ($K) {
      'approval' { [System.Media.SystemSounds]::Exclamation.Play() }
      'question' { [System.Media.SystemSounds]::Exclamation.Play() }
      'failure' { [System.Media.SystemSounds]::Hand.Play() }
      'aborted' { [System.Media.SystemSounds]::Hand.Play() }
      default { [System.Media.SystemSounds]::Asterisk.Play() }
    }
  } catch { }
}

function Show-Toast {
  param([string]$XmlText)
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($XmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show($toast)
}

function Show-Balloon {
  param([string]$T, [string]$B)
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Visible = $true
  $icon.ShowBalloonTip(10000, $T, $B, [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Sleep -Seconds 6
  $icon.Dispose()
}

Register-Aumid $Aumid $IconPath

$activation = ''
if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
  Register-Activation
  $launch = [System.Security.SecurityElement]::Escape($SessionId)
  $activation = ' activationType="foreground" launch="' + $launch + '"'
}

if ($Sound -eq '1') { Play-Sound $Kind }

$t = [System.Security.SecurityElement]::Escape($title)
$b = [System.Security.SecurityElement]::Escape($body)

switch ($Scenario) {
  'reminder' { $attrs = ' scenario="reminder" duration="long"' }
  'alarm'    { $attrs = ' scenario="alarm" duration="long"' }
  'urgent'   { $attrs = ' scenario="urgent" duration="long"' }
  default    { $attrs = ' duration="short"' }
}

$rich = @"
<toast$attrs$activation>
  <visual>
    <binding template="ToastGeneric">
      <text>$t</text>
      <text>$b</text>
    </binding>
  </visual>
  <audio silent="true"/>
</toast>
"@

$plain = @"
<toast$activation>
  <visual>
    <binding template="ToastGeneric">
      <text>$t</text>
      <text>$b</text>
    </binding>
  </visual>
  <audio silent="true"/>
</toast>
"@

try {
  Show-Toast $rich
  exit 0
} catch {
  [Console]::Error.WriteLine('rich toast failed: ' + $_.Exception.Message)
}
try {
  Show-Toast $plain
  exit 4
} catch {
  [Console]::Error.WriteLine('plain toast failed: ' + $_.Exception.Message)
}
try {
  Show-Balloon $title $body
  exit 5
} catch {
  [Console]::Error.WriteLine('balloon failed: ' + $_.Exception.Message)
  exit 1
}
