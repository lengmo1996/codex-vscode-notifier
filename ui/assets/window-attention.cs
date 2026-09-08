using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class CodexWindowAttention : IDisposable {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr param);
    delegate bool EnumCallback(IntPtr handle, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetProp(IntPtr handle, string name, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetProp(IntPtr handle, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr RemoveProp(IntPtr handle, string name);
    [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FlashInfo info);
    [StructLayout(LayoutKind.Sequential)] struct FlashInfo {
        public uint Size; public IntPtr Window; public uint Flags; public uint Count; public uint Timeout;
    }
    // The inherited methods must keep their COM vtable order.
    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")] class TaskbarList { }
    [ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ITaskbarList3 {
        void HrInit(); void AddTab(IntPtr window); void DeleteTab(IntPtr window);
        void ActivateTab(IntPtr window); void SetActiveAlt(IntPtr window);
        void MarkFullscreenWindow(IntPtr window, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
        void SetProgressValue(IntPtr window, ulong completed, ulong total);
        void SetProgressState(IntPtr window, uint state);
    }
    sealed class Binding {
        public IntPtr Handle; public uint Pid; public string Executable; public string Property; public bool Attention;
    }
    readonly Dictionary<string, Binding> bindings = new Dictionary<string, Binding>();
    ITaskbarList3 taskbar;
    readonly bool testing;
    public CodexWindowAttention() : this(false) { }
    CodexWindowAttention(bool test) { testing = test; }
    ITaskbarList3 Taskbar {
        get {
            if (taskbar == null) {
                var created = (ITaskbarList3)new TaskbarList();
                try { created.HrInit(); taskbar = created; }
                catch { Marshal.FinalReleaseComObject(created); throw; }
            }
            return taskbar;
        }
    }
    static string Text(IntPtr handle) { var text = new StringBuilder(32768); GetWindowText(handle, text, text.Capacity); return text.ToString(); }
    bool Identity(IntPtr handle, uint pid, string executable) {
        if (!IsWindow(handle)) return false;
        uint actual; GetWindowThreadProcessId(handle, out actual);
        if (actual != pid) return false;
        var name = new StringBuilder(256); GetClassName(handle, name, name.Capacity);
        if (testing) {
            if (pid != (uint)Process.GetCurrentProcess().Id || !name.ToString().StartsWith("WindowsForms10.")) return false;
        } else if (name.ToString() != "Chrome_WidgetWin_1") return false;
        try { using (var process = Process.GetProcessById((int)pid)) return String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }
    bool Valid(Binding binding) {
        return Identity(binding.Handle, binding.Pid, binding.Executable) && GetProp(binding.Handle, binding.Property) == new IntPtr(1);
    }
    static void Flash(IntPtr handle, bool enabled) {
        var info = new FlashInfo { Size = (uint)Marshal.SizeOf(typeof(FlashInfo)), Window = handle,
            Flags = enabled ? 14U : 0U, Count = enabled ? UInt32.MaxValue : 0U, Timeout = 0 };
        // The BOOL result reports the previous active state, not success/failure.
        FlashWindowEx(ref info);
    }
    public object Bind(string id, string marker, uint pid, string executable) {
        Guid parsed;
        if (!Guid.TryParse(id, out parsed) || marker != "[CodexNotifier:" + id + "]" || pid == 0) throw new Exception("Invalid window binding");
        var basename = Path.GetFileName(executable);
        if (!testing && !String.Equals(basename, "Code.exe", StringComparison.OrdinalIgnoreCase) &&
            !String.Equals(basename, "Code - Insiders.exe", StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsupported VS Code executable");
        var matches = new List<IntPtr>();
        EnumWindows((handle, unused) => {
            if (Text(handle).Contains(marker) && Identity(handle, pid, executable)) matches.Add(handle);
            return true;
        }, IntPtr.Zero);
        if (matches.Count != 1) { Release(id); return new {bound = false, matches = matches.Count}; }
        Release(id);
        var binding = new Binding {Handle = matches[0], Pid = pid, Executable = executable, Property = "CodexNotifier." + id};
        if (!SetProp(binding.Handle, binding.Property, new IntPtr(1))) throw new Exception("Could not lease the VS Code window handle");
        bindings[id] = binding;
        return new {bound = true};
    }
    public object Update(string id, int count, bool decision, bool flash) {
        Binding binding;
        if (!bindings.TryGetValue(id, out binding) || !Valid(binding)) {
            bindings.Remove(id); return new {bound = false};
        }
        if (count < 0 || count > 200) throw new Exception("Invalid unread count");
        if (count > 0) {
            Taskbar.SetProgressValue(binding.Handle, 100, 100);
            Taskbar.SetProgressState(binding.Handle, decision ? 4U : 8U);
            binding.Attention = true;
            if (flash) Flash(binding.Handle, true);
        } else if (binding.Attention) {
            try { Taskbar.SetProgressState(binding.Handle, 0); binding.Attention = false; }
            finally { Flash(binding.Handle, false); }
        }
        return new {bound = true, count = count, color = count == 0 ? "none" : decision ? "red" : "yellow", title = Text(binding.Handle)};
    }
    public object Release(string id) {
        Binding binding;
        if (bindings.TryGetValue(id, out binding)) {
            try {
                if (Valid(binding)) {
                    try { if (binding.Attention) Taskbar.SetProgressState(binding.Handle, 0); }
                    finally {
                        if (binding.Attention) Flash(binding.Handle, false);
                        RemoveProp(binding.Handle, binding.Property);
                    }
                }
            } finally { bindings.Remove(id); }
        }
        return new {released = true};
    }
    public void Dispose() {
        foreach (var id in new List<string>(bindings.Keys)) { try { Release(id); } catch { } }
        if (taskbar != null) { Marshal.FinalReleaseComObject(taskbar); taskbar = null; }
    }
    public static void Run() {
        var serializer = new JavaScriptSerializer();
        using (var engine = new CodexWindowAttention()) {
            string line;
            while ((line = Console.ReadLine()) != null) {
                string requestId = "";
                try {
                    if (line.Length > 65536) throw new Exception("Request too large");
                    var data = serializer.Deserialize<Dictionary<string, object>>(line);
                    requestId = Convert.ToString(data["requestId"]);
                    var id = Convert.ToString(data["id"]);
                    var op = Convert.ToString(data["op"]);
                    object result;
                    if (op == "bind") result = engine.Bind(id, Convert.ToString(data["marker"]), Convert.ToUInt32(data["pid"]), Convert.ToString(data["executable"]));
                    else if (op == "update") result = engine.Update(id, Convert.ToInt32(data["count"]), Convert.ToBoolean(data["needsDecision"]), Convert.ToBoolean(data["flash"]));
                    else if (op == "release") result = engine.Release(id);
                    else throw new Exception("Unknown operation");
                    Console.WriteLine(serializer.Serialize(new {requestId = requestId, result = result}));
                } catch (Exception error) { Console.WriteLine(serializer.Serialize(new {requestId = requestId, error = error.Message})); }
                Console.Out.Flush();
            }
        }
    }
    public static void SelfTest() {
        var id = Guid.NewGuid().ToString(); var marker = "[CodexNotifier:" + id + "]";
        var process = Process.GetCurrentProcess();
        using (var a = new Form()) using (var b = new Form()) using (var engine = new CodexWindowAttention(true)) {
            a.Text = marker; b.Text = "Codex Notifier Native Test - control";
            var ha = a.Handle; var hb = b.Handle;
            engine.Bind(id, marker, (uint)process.Id, process.MainModule.FileName);
            if (!engine.bindings.ContainsKey(id) || engine.bindings[id].Handle != ha) throw new Exception("Exact native window binding failed");
            engine.Update(id, 1, false, true); engine.Update(id, 2, true, false); engine.Update(id, 0, false, false);
            if (GetProp(hb, "CodexNotifier." + id) != IntPtr.Zero) throw new Exception("Control window was changed");
            engine.Release(id);
            if (GetProp(ha, "CodexNotifier." + id) != IntPtr.Zero) throw new Exception("Lease was not removed");
            b.Text = marker;
            engine.Bind(id, marker, (uint)process.Id, process.MainModule.FileName);
            if (engine.bindings.ContainsKey(id)) throw new Exception("Ambiguous title must not bind");
            b.Text = "control";
            engine.Bind(id, marker, (uint)process.Id, process.MainModule.FileName);
            RemoveProp(ha, "CodexNotifier." + id);
            engine.Update(id, 1, false, false);
            if (engine.bindings.ContainsKey(id)) throw new Exception("Stale handle lease must not be used");
            Console.WriteLine("PASS exact HWND binding, native yellow/red/reset calls, control-window isolation, ambiguous-title rejection, lease cleanup and stale-handle rejection");
        }
    }
}
