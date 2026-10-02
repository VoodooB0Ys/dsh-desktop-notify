// DshNotifyProbe - foreground verdict for dsh-desktop-notify.
//
// The host spawns this instead of a PowerShell probe: a compiled exe answers in
// ~80ms where a fresh PowerShell (Add-Type P/Invoke compile) costs ~700ms.
//
// Prints "fullscreen=<0|1> present=<0|1>" on stdout and exits with a bitmask so
// the host never needs to parse text:
//   0 = normal foreground (not fullscreen, not DSH)
//   1 = foreground covers its monitor and is not maximized  (toast gets suppressed)
//   2 = foreground belongs to the DSH executable            (user is at the app)
//   3 = both
// Any failure exits 4; the host must fail open (treat as 0 = notify).
//
// Rebuild (same toolchain as the activator):
//   & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -nologo -optimize+ `
//     -platform:x64 -out:lib\dsh-notify-probe.exe lib\activator\DshNotifyProbe.cs

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class DshNotifyProbe
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            // argv[1] = the DSH executable base name ("DeepSeek Harness.exe").
            // Absent means the caller does not care about presence.
            string dshExe = args.Length > 1 ? args[1] : null;

            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero)
            {
                // No foreground (lock screen, another desktop) = nobody is looking.
                Console.Out.Write("fullscreen=0 present=0");
                return 0;
            }

            int verdict = 0;

            var rect = new RECT();
            if (GetWindowRect(fg, out rect))
            {
                var mi = new MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (GetMonitorInfo(MonitorFromWindow(fg, 2), ref mi))
                {
                    int fullW = mi.rcMonitor.Right - mi.rcMonitor.Left;
                    int fullH = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
                    bool covers = (rect.Right - rect.Left) >= (fullW - 2)
                               && (rect.Bottom - rect.Top) >= (fullH - 2);
                    // A maximized window also covers the monitor when the taskbar
                    // auto-hides; true fullscreen (video / F11 / exclusive) never
                    // carries the maximized state. Same discriminator as the card.
                    if (covers && !IsZoomed(fg)) verdict |= 1;
                }
            }

            if (dshExe != null)
            {
                uint pid;
                GetWindowThreadProcessId(fg, out pid);
                try
                {
                    var proc = Process.GetProcessById((int)pid);
                    string exe = null;
                    try { exe = System.IO.Path.GetFileName(proc.MainModule.FileName); }
                    catch { exe = proc.ProcessName + ".exe"; }
                    if (string.Equals(exe, dshExe, StringComparison.OrdinalIgnoreCase)) verdict |= 2;
                }
                catch
                {
                    // Foreground process vanished or is protected: not present.
                }
            }

            Console.Out.Write("fullscreen=" + ((verdict & 1) != 0 ? 1 : 0)
                            + " present=" + ((verdict & 2) != 0 ? 1 : 0));
            return verdict;
        }
        catch
        {
            try { Console.Error.WriteLine("probe failed"); } catch { }
            return 4;
        }
    }
}
