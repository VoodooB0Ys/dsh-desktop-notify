using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// dsh-desktop-notify toast activator.
//
// Compiled as /target:winexe on purpose: a console subsystem EXE would show a
// black window every time Windows launches it for a toast click.
//
// Why this EXE exists: Windows does not deliver a toast click of an unpackaged
// Win32 app to a registered URI protocol handler, and a PowerShell host cannot
// receive WinRT Activated events at all. The documented mechanism for desktop
// apps is a COM local server implementing INotificationActivationCallback,
// registered as the AUMID's CustomActivator. Windows launches this EXE on
// click, calls Activate, and hands us the toast's launch string.

[ComImport, Guid("53E31837-6600-4A81-9395-75CFFE746F94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface INotificationActivationCallback
{
    void Activate([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
                  [MarshalAs(UnmanagedType.LPWStr)] string invokedArgs,
                  IntPtr data, uint count);
}

[ComImport, Guid("00000001-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IClassFactory
{
    void CreateInstance(IntPtr outer, ref Guid riid, out IntPtr instance);
    void LockServer(bool lockServer);
}

[ComVisible(true)]
[Guid("D7A1F0B2-3C4D-4E5F-9A0B-1C2D3E4F5A6B")]
[ClassInterface(ClassInterfaceType.None)]
public class NotifyActivator : INotificationActivationCallback
{
    const string Scheme = "dsh-desktop-notify:";

    public void Activate(string appUserModelId, string invokedArgs, IntPtr data, uint count)
    {
        string args = (invokedArgs ?? "").Trim();
        // The toast carries either a bare session id or scheme:sessionId.
        if (args.StartsWith(Scheme, StringComparison.OrdinalIgnoreCase))
            args = args.Substring(Scheme.Length).Trim();
        Trace("com-activate aumid=" + appUserModelId + " session=[" + args + "]");
        try
        {
            if (args.Length > 0)
            {
                string dir = UserDshDir();
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "dsh-desktop-notify.activate"),
                                   args + Environment.NewLine, new UTF8Encoding(false));
            }
        }
        catch (Exception ex) { Trace("handoff failed: " + ex.Message); }
        Raise();
        Program.Finish();
    }

    static string UserDshDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
    }

    public static void Trace(string line)
    {
        try
        {
            string dir = UserDshDir();
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "dsh-desktop-notify.activate.log"),
                               DateTime.Now.ToString("s") + " " + line + Environment.NewLine,
                               new UTF8Encoding(false));
        }
        catch { }
    }

    // Raise policy: minimized -> restore + foreground (the only case SW_RESTORE
    // is safe - on a snapped window it would yank it out of the layout); visible
    // but covered -> bring to the top AT ITS CURRENT SIZE (z-order only, no
    // resize, no topmost, snap layouts survive); already foreground -> nothing.
    // The conversation switch itself is done by the client half via the handoff
    // file.
    public static void Raise()
    {
        try
        {
            Process[] procs = Process.GetProcessesByName("DeepSeek Harness");
            foreach (Process p in procs)
            {
                IntPtr h = p.MainWindowHandle;
                if (h == IntPtr.Zero) continue;
                if (IsIconic(h))
                {
                    ShowWindow(h, 9);
                    ForceForeground(h);
                    Trace("raise ok (restored from minimized) hwnd=" + h.ToInt64());
                    return;
                }
                if (GetForegroundWindow() == h)
                {
                    Trace("raise: already foreground");
                    return;
                }
                ForceForeground(h);
                Trace("raise ok (brought to front, size untouched) hwnd=" + h.ToInt64());
                return;
            }
            Trace("raise: no window found");
        }
        catch (Exception ex) { Trace("raise failed: " + ex.Message); }
    }

    static void ForceForeground(IntPtr h)
    {
        IntPtr fg = GetForegroundWindow();
        uint pid;
        uint fgThread = GetWindowThreadProcessId(fg, out pid);
        uint me = GetCurrentThreadId();
        AttachThreadInput(fgThread, me, true);
        SetForegroundWindow(h);
        BringWindowToTop(h);
        AttachThreadInput(fgThread, me, false);
    }

    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
}

[ComVisible(true)]
[Guid("D7A1F0B2-3C4D-4E5F-9A0B-1C2D3E4F5A6C")]
public class NotifyActivatorFactory : IClassFactory
{
    public void CreateInstance(IntPtr outer, ref Guid riid, out IntPtr instance)
    {
        var obj = new NotifyActivator();
        instance = Marshal.GetComInterfaceForObject(obj, typeof(INotificationActivationCallback));
    }
    public void LockServer(bool lockServer) { }
}

static class Program
{
    static readonly Guid Clsid = new Guid("D7A1F0B2-3C4D-4E5F-9A0B-1C2D3E4F5A6B");
    static uint cookie;
    static bool finished;

    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, uint coinit);
    [DllImport("ole32.dll")] static extern int CoRegisterClassObject(ref Guid clsid, [MarshalAs(UnmanagedType.Interface)] object factory, uint context, uint flags, out uint reg);
    [DllImport("ole32.dll")] static extern int CoRevokeClassObject(uint reg);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int code);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    public static void Finish() { finished = true; }

    [STAThread]
    static int Main(string[] args)
    {
        CoInitializeEx(IntPtr.Zero, 2); // STA
        var factory = new NotifyActivatorFactory();
        Guid clsid = Clsid;
        int hr = CoRegisterClassObject(ref clsid, factory, 4 /*CLSCTX_LOCAL_SERVER*/, 1 /*REGCLS_MULTIPLEUSE*/, out cookie);
        if (hr != 0)
        {
            NotifyActivator.Trace("CoRegisterClassObject failed hr=0x" + hr.ToString("X"));
            return 1;
        }
        NotifyActivator.Trace("activator server started");

        // An STA local server must pump its message queue for COM to marshal the
        // incoming Activate call onto this thread. PeekMessage (not a blocking
        // GetMessage) so the deadline is always honoured and the process exits
        // even when no click ever arrives.
        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
        while (!finished && DateTime.UtcNow < deadline)
        {
            MSG msg;
            bool had = false;
            while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1 /*PM_REMOVE*/))
            {
                had = true;
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            if (!had) Thread.Sleep(50);
        }
        CoRevokeClassObject(cookie);
        return 0;
    }
}
