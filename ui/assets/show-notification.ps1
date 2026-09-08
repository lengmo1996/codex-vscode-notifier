param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$notifierSource = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class CodexNotifierHost {
    // WinForms' ShowBalloonTip does not expose NIIF_NOSOUND. This small
    // notification-area wrapper uses that documented flag so sound is opt-in.
    private sealed class NativeIcon : NativeWindow, IDisposable {
        private const uint AddIcon = 0;
        private const uint ModifyIcon = 1;
        private const uint DeleteIcon = 2;
        private const uint SetVersion = 4;
        private const uint CallbackMessage = 0x8001;
        private const uint Version4 = 4;
        private const uint InfoIcon = 0x01;
        private const uint NoSystemSound = 0x10;
        private const uint BalloonHide = 0x0403;
        private const uint BalloonTimeout = 0x0404;
        private const uint BalloonClick = 0x0405;
        private const uint IconSelect = 0x0400;
        private const uint IconKeySelect = 0x0401;
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct IconData {
            public uint cbSize;
            public IntPtr hWnd;
            public uint uID;
            public uint uFlags;
            public uint uCallbackMessage;
            public IntPtr hIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
            public uint dwState;
            public uint dwStateMask;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
            public uint uTimeoutOrVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
            public uint dwInfoFlags;
            public Guid guidItem;
            public IntPtr hBalloonIcon;
        }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "Shell_NotifyIconW")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShellNotifyIcon(uint message, ref IconData data);
        private sealed class Notice {
            public IconData Data;
            public string Id;
        }
        private uint visibleId;
        private readonly Dictionary<uint, Notice> notices = new Dictionary<uint, Notice>();
        private uint nextIconId = 0;
        public NativeIcon() {
            CreateHandle(new CreateParams());
        }
        private uint NextIconId() {
            // Version 4 callbacks carry the icon ID in a 16-bit field.
            nextIconId = nextIconId == 65535 ? 1 : nextIconId + 1;
            return nextIconId;
        }
        private void Remove(uint iconId) {
            Notice notice;
            if (!notices.TryGetValue(iconId, out notice)) return;
            if (visibleId == iconId) visibleId = 0;
            // Clear the map first: deletion can cause another callback.
            notices.Remove(iconId);
            var old = notice.Data;
            ShellNotifyIcon(DeleteIcon, ref old);
        }
        public void Show(string id, string title, string body, string appName) {
            var data = new IconData();
            data.cbSize = (uint)Marshal.SizeOf(typeof(IconData));
            data.hWnd = Handle;
            // A fresh native identity prevents a late click on an older
            // balloon from being incorrectly attributed to a newer batch.
            data.uID = NextIconId();
            data.uFlags = 1 | 2 | 4;
            data.uCallbackMessage = CallbackMessage;
            data.hIcon = SystemIcons.Information.Handle;
            data.szTip = String.IsNullOrEmpty(appName) ? "Codex" : appName.Substring(0, Math.Min(127, appName.Length));
            data.szInfo = "";
            data.szInfoTitle = "";
            if (!ShellNotifyIcon(AddIcon, ref data)) throw new Exception("Windows could not create the notification icon");
            try {
                data.uTimeoutOrVersion = Version4;
                if (!ShellNotifyIcon(SetVersion, ref data)) throw new Exception("Windows could not configure notification callbacks");
                data.uFlags = 0x10;
                data.szInfoTitle = title.Length > 63 ? title.Substring(0, 63) : title;
                data.szInfo = body.Length > 255 ? body.Substring(0, 255) : body;
                // Always suppress the Shell's sound. Explicit sound is played
                // separately only when this request's sound value is true.
                data.dwInfoFlags = InfoIcon | NoSystemSound;
                notices[data.uID] = new Notice { Data = data, Id = id };
                if (!ShellNotifyIcon(ModifyIcon, ref data)) throw new Exception("Windows rejected the notification");
            } catch {
                notices.Remove(data.uID);
                ShellNotifyIcon(DeleteIcon, ref data);
                throw;
            }
            // Keep one tray icon. A sound-only request never reaches this
            // method and cannot change the identity of a visible balloon.
            // A synchronous Shell dismissal may already have removed this
            // notice; in that case keep any previously visible notification.
            if (notices.ContainsKey(data.uID)) {
                if (visibleId != 0) Remove(visibleId);
                visibleId = data.uID;
            }
        }
        protected override void WndProc(ref Message message) {
            if (message.Msg == CallbackMessage) {
                uint callback = unchecked((uint)message.LParam.ToInt64());
                uint code = callback & 0xffff;
                uint iconId = (callback >> 16) & 0xffff;
                Notice notice;
                if (notices.TryGetValue(iconId, out notice)) {
                    if (code == BalloonClick || code == IconSelect || code == IconKeySelect) {
                        // Clear before emitting so duplicate Shell callbacks
                        // cannot navigate twice. Clicking never plays a sound.
                        Remove(iconId);
                        Console.WriteLine("CLICK " + notice.Id);
                        Console.Out.Flush();
                    } else if (code == BalloonHide || code == BalloonTimeout) {
                        Remove(iconId);
                    }
                }
            }
            base.WndProc(ref message);
        }
        public void Dispose() {
            foreach (uint iconId in new List<uint>(notices.Keys)) Remove(iconId);
            DestroyHandle();
        }
    }
    public static void Run() {
        var pending = new ConcurrentQueue<string>();
        var reader = new Thread(() => {
            string line;
            while ((line = Console.ReadLine()) != null) {
                if (line.Length <= 65536 && pending.Count < 32) pending.Enqueue(line);
            }
            pending.Enqueue("__END__");
        });
        reader.IsBackground = true;
        reader.Start();
        var context = new ApplicationContext();
        var icon = new NativeIcon();
        var timer = new System.Windows.Forms.Timer();
        timer.Interval = 100;
        timer.Tick += (sender, args) => {
            string line;
            if (!pending.TryDequeue(out line)) return;
            if (line == "__END__") { context.ExitThread(); return; }
            string id = "unknown";
            try {
                var serializer = new JavaScriptSerializer();
                var data = serializer.Deserialize<Dictionary<string, object>>(line);
                var requestId = Convert.ToString(data["id"]);
                var title = Convert.ToString(data["title"]);
                var body = Convert.ToString(data["body"]);
                if (String.IsNullOrEmpty(requestId) || requestId.Length > 128) throw new Exception("Invalid notification ID");
                foreach (char character in requestId) {
                    if (Char.IsControl(character) || Char.IsWhiteSpace(character)) throw new Exception("Invalid notification ID");
                }
                id = requestId;
                if (!data.ContainsKey("desktop") || !(data["desktop"] is bool) || (bool)data["desktop"]) {
                    icon.Show(id, title, body, data.ContainsKey("appName") ? Convert.ToString(data["appName"]) : "Codex");
                }
                if (data.ContainsKey("sound") && data["sound"] is bool && (bool)data["sound"]) {
                    System.Media.SystemSounds.Exclamation.Play();
                }
                Console.WriteLine("SHOWN " + id);
                Console.Out.Flush();
            } catch (Exception ex) {
                Console.WriteLine("ERROR " + id + " " + ex.Message.Replace("\r", " ").Replace("\n", " "));
                Console.Out.Flush();
            }
        };
        timer.Start();
        try { Application.Run(context); }
        finally { timer.Dispose(); icon.Dispose(); context.Dispose(); }
    }
}
'@
Add-Type -TypeDefinition $notifierSource -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
if ($CheckOnly) { Write-Output 'Notification helper compiled successfully'; exit 0 }
[CodexNotifierHost]::Run()
