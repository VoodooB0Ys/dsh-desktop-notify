param(
  [Parameter(Mandatory = $true)][string]$TitleFile,
  [Parameter(Mandatory = $true)][string]$BodyFile,
  [string]$Kind = 'completion',
  [int]$Seconds = 15,
  [string]$Accent = '#3B82F6',
  [string]$Sound = '0',
  [string]$SessionId = '',
  [string]$OnlyWhenFullscreen = '0',
  [string]$Aumid = 'DeepSeekHarness.DesktopNotify'
)

# ASCII-only on purpose (PowerShell 5.1 reads UTF-8 scripts as ANSI).
#
# Topmost notification-styled card. Why it exists: Windows suppresses system
# toast banners while a fullscreen app is in the foreground, and a suppressed
# toast is never replayed - it only ends up in the notification center. A window
# we own is not subject to that, so this is the only channel that stays visible
# over a fullscreen video.
#
# Exit codes: 30 = card was shown (host uses this as "foreground is fullscreen"),
# 0 = skipped (not fullscreen / nothing to do), 1 = failed.
#
# Deliberately notification-like, not app-like: no taskbar entry, never takes
# focus, sits bottom-right above the taskbar, leaves on its own after -Seconds
# (0 = stays until clicked or closed), and clicking it opens the conversation.

$ErrorActionPreference = 'Continue'

$title = ''
$body = ''
try { $title = (Get-Content -LiteralPath $TitleFile -Raw -Encoding UTF8).Trim() } catch { }
try { $body = (Get-Content -LiteralPath $BodyFile -Raw -Encoding UTF8).Trim() } catch { }
if ([string]::IsNullOrWhiteSpace($title)) { $title = 'DeepSeek Harness' }

$base = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($base)) { $base = $env:HOME }
$dshDir = Join-Path $base '.dsh'
$handoff = Join-Path $dshDir 'dsh-desktop-notify.activate'
$trace = Join-Path $dshDir 'dsh-desktop-notify.activate.log'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Trace {
  param([string]$Line)
  try { [System.IO.File]::AppendAllText($trace, (Get-Date).ToString('s') + ' ' + $Line + "`n", $utf8) } catch { }
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshCard {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
"@

function Raise-DshWindow {
  try {
    $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($null -eq $proc) { Write-Trace 'card raise: no window'; return }
    $h = $proc.MainWindowHandle

    # Minimized: restore + foreground (the only case SW_RESTORE is safe to use -
    # on a snapped window it would yank it out of the layout).
    if ([DshCard]::IsIconic($h)) {
      [void][DshCard]::ShowWindow($h, 9)
      $fg = [DshCard]::GetForegroundWindow()
      $pid2 = 0
      $fgThread = [DshCard]::GetWindowThreadProcessId($fg, [ref]$pid2)
      $me = [DshCard]::GetCurrentThreadId()
      [void][DshCard]::AttachThreadInput($fgThread, $me, $true)
      [void][DshCard]::SetForegroundWindow($h)
      [void][DshCard]::BringWindowToTop($h)
      [void][DshCard]::AttachThreadInput($fgThread, $me, $false)
      Write-Trace 'card raise ok (restored from minimized)'
      return
    }

    # Visible but covered: bring to the top AT ITS CURRENT SIZE - z-order only,
    # no restore, no resize, no topmost. Snap layouts survive.
    if ([DshCard]::GetForegroundWindow() -eq $h) {
      Write-Trace 'card raise: already foreground'
      return
    }
    $fg = [DshCard]::GetForegroundWindow()
    $pid2 = 0
    $fgThread = [DshCard]::GetWindowThreadProcessId($fg, [ref]$pid2)
    $me = [DshCard]::GetCurrentThreadId()
    [void][DshCard]::AttachThreadInput($fgThread, $me, $true)
    [void][DshCard]::SetForegroundWindow($h)
    [void][DshCard]::BringWindowToTop($h)
    [void][DshCard]::AttachThreadInput($fgThread, $me, $false)
    Write-Trace 'card raise ok (brought to front, size untouched)'
  } catch { Write-Trace ('card raise failed: ' + $_.Exception.Message) }
}

function Test-FullscreenForeground {
  try {
    $fg = [DshCard]::GetForegroundWindow()
    if ($fg -eq [IntPtr]::Zero) { return $false }
    $rect = New-Object DshCard+RECT
    if (-not [DshCard]::GetWindowRect($fg, [ref]$rect)) { return $false }
    $mon = [DshCard]::MonitorFromWindow($fg, 2)
    $mi = New-Object DshCard+MONITORINFO
    $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
    if (-not [DshCard]::GetMonitorInfo($mon, [ref]$mi)) { return $false }
    $fullW = $mi.rcMonitor.Right - $mi.rcMonitor.Left
    $fullH = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if (($w -lt ($fullW - 2)) -or ($h -lt ($fullH - 2))) { return $false }
    # Covering the monitor is not enough: with an auto-hiding taskbar a MAXIMIZED
    # window's rect equals the whole screen, which would falsely read as fullscreen
    # and duplicate the banner. Maximized windows carry WS_MAXIMIZE (IsZoomed);
    # true fullscreen (video / F11 / exclusive) does not.
    if ([DshCard]::IsZoomed($fg)) { return $false }
    return $true
  } catch { return $false }
}

function Open-Conversation {
  param([string]$Id)
  if ([string]::IsNullOrWhiteSpace($Id)) { return }
  try {
    if (-not (Test-Path -LiteralPath $dshDir)) { New-Item -ItemType Directory -Path $dshDir -Force | Out-Null }
    [System.IO.File]::AppendAllText($handoff, $Id.Trim() + "`n", $utf8)
    Write-Trace ('card clicked session=' + $Id)
  } catch { }
}

if ($OnlyWhenFullscreen -eq '1' -and -not (Test-FullscreenForeground)) {
  Write-Trace 'card skipped: foreground is not fullscreen'
  # 0 = nothing shown; the host answers with a toast instead
  exit 0
}

if ($Sound -eq '1') {
  try {
    switch ($Kind) {
      'approval' { [System.Media.SystemSounds]::Exclamation.Play() }
      'question' { [System.Media.SystemSounds]::Exclamation.Play() }
      'failure' { [System.Media.SystemSounds]::Hand.Play() }
      'aborted' { [System.Media.SystemSounds]::Hand.Play() }
      default { [System.Media.SystemSounds]::Asterisk.Play() }
    }
  } catch { }
}

try {
  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase

  $accentColor = [System.Windows.Media.ColorConverter]::ConvertFromString($Accent)

  $window = New-Object System.Windows.Window
  $window.WindowStyle = [System.Windows.WindowStyle]::None
  $window.AllowsTransparency = $true
  $window.Background = [System.Windows.Media.Brushes]::Transparent
  $window.Topmost = $true
  $window.ShowInTaskbar = $false
  $window.ShowActivated = $false
  $window.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $window.Width = 400
  $window.SizeToContent = [System.Windows.SizeToContent]::Height
  $window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
  $window.Title = 'DeepSeek Harness'

  $card = New-Object System.Windows.Controls.Border
  $card.CornerRadius = New-Object System.Windows.CornerRadius(8)
  $card.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(250, 32, 32, 36))
  $card.BorderThickness = New-Object System.Windows.Thickness(1)
  $card.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(60, 255, 255, 255))
  $card.Padding = New-Object System.Windows.Thickness(14)

  $grid = New-Object System.Windows.Controls.Grid
  $col0 = New-Object System.Windows.Controls.ColumnDefinition
  $col1 = New-Object System.Windows.Controls.ColumnDefinition
  $col0.Width = New-Object System.Windows.GridLength(3)
  $col1.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
  [void]$grid.ColumnDefinitions.Add($col0)
  [void]$grid.ColumnDefinitions.Add($col1)

  $stripe = New-Object System.Windows.Controls.Border
  $stripe.Width = 3
  $stripe.CornerRadius = New-Object System.Windows.CornerRadius(2)
  $stripe.Background = New-Object System.Windows.Media.SolidColorBrush $accentColor
  $stripe.Margin = New-Object System.Windows.Thickness(0, 1, 0, 1)
  [System.Windows.Controls.Grid]::SetColumn($stripe, 0)
  [void]$grid.Children.Add($stripe)

  $stack = New-Object System.Windows.Controls.StackPanel
  $stack.Margin = New-Object System.Windows.Thickness(12, 0, 0, 0)
  [System.Windows.Controls.Grid]::SetColumn($stack, 1)

  $app = New-Object System.Windows.Controls.TextBlock
  $app.Text = 'DeepSeek Harness'
  $app.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(150, 155, 162))
  $app.FontSize = 11

  $head = New-Object System.Windows.Controls.TextBlock
  $head.Text = $title
  $head.Foreground = [System.Windows.Media.Brushes]::White
  $head.FontSize = 15
  $head.FontWeight = [System.Windows.FontWeights]::SemiBold
  $head.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $head.Margin = New-Object System.Windows.Thickness(0, 3, 0, 0)

  $bodyText = New-Object System.Windows.Controls.TextBlock
  $bodyText.Text = $body
  $bodyText.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(214, 216, 220))
  $bodyText.FontSize = 12
  $bodyText.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $bodyText.Margin = New-Object System.Windows.Thickness(0, 5, 0, 0)

  [void]$stack.Children.Add($app)
  [void]$stack.Children.Add($head)
  [void]$stack.Children.Add($bodyText)
  [void]$grid.Children.Add($stack)
  $card.Child = $grid
  $window.Content = $card

  $window.Add_Loaded({
      $area = [System.Windows.SystemParameters]::WorkArea
      $window.Left = [Math]::Max($area.Left, $area.Right - $window.ActualWidth - 18)
      $window.Top = [Math]::Max($area.Top, $area.Bottom - $window.ActualHeight - 18)
    })

  $window.Add_MouseLeftButtonDown({
      Open-Conversation $SessionId
      Raise-DshWindow
      $window.Close()
    })

  if ($Seconds -gt 0) {
    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromSeconds([Math]::Max(3, $Seconds))
    $timer.Add_Tick({ $timer.Stop(); $window.Close() })
    $timer.Start()
  }

  Write-Trace ('card shown kind=' + $Kind + ' seconds=' + $Seconds + ' session=' + $SessionId)
  [void]$window.ShowDialog()
  # 30 = shown. The host treats this as "the foreground really is fullscreen" and
  # skips the toast for this event - one reminder, one popup (PRD A2).
  exit 30
} catch {
  [Console]::Error.WriteLine('card failed: ' + $_.Exception.Message)
  exit 1
}
