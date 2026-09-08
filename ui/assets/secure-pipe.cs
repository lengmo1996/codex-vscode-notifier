using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// The public pipe is created with its final DACL. Never publish a permissive
// pipe and attempt to repair it later. Standard streams are inherited privately
// from the broker; application authentication is handled above this transport.
public static class CodexSecurePipe {
  [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes {
    public int Length; public IntPtr Descriptor; public int Inherit;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string value, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafePipeHandle CreateNamedPipe(string name, uint mode, uint pipeMode, uint maxInstances, uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes attributes);
  [StructLayout(LayoutKind.Sequential)] private struct FileInformation {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
  private static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
  private static readonly object OutputLock = new object();
  private static readonly object ClientsLock = new object();
  private static readonly Dictionary<string, NamedPipeServerStream> Clients = new Dictionary<string, NamedPipeServerStream>();
  private static volatile bool Closed;
  private static NamedPipeServerStream Waiting;
  private static int Sequence;

  private static void NoLink(string path) {
    if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("IPC storage must not be a reparse point");
  }
  private static void CheckAncestors(string path) {
    for (string current = Path.GetFullPath(path); !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
      if (Directory.Exists(current) || File.Exists(current)) NoLink(current);
      if (current == Path.GetPathRoot(current)) break;
    }
  }
  private static void CheckFile(string file) {
    NoLink(file);
    if (!User.Equals(File.GetAccessControl(file).GetOwner(typeof(SecurityIdentifier))))
      throw new UnauthorizedAccessException("IPC cache owner is not the current user");
    using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      FileInformation information;
      if (!GetFileInformationByHandle(stream.SafeFileHandle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (information.Links != 1) throw new IOException("IPC cache must not have hard links");
    }
  }
  private static void Preflight(string directory, bool credentials) {
    if (!Directory.Exists(directory)) return;
    NoLink(directory);
    if (!User.Equals(Directory.GetAccessControl(directory).GetOwner(typeof(SecurityIdentifier))))
      throw new UnauthorizedAccessException("IPC storage owner is not the current user");
    foreach (string file in Directory.GetFiles(directory)) {
      string name = Path.GetFileName(file);
      bool allowed = credentials ? Regex.IsMatch(name, @"^(identity\.dpapi|[a-f0-9]{32}\.tmp)$") :
        Regex.IsMatch(name, @"^(broker-state(-v[2-5])?\.json(\.\d+\.[a-f0-9]{12}\.tmp)?|broker-token|broker-privacy\.json(\.tmp-[a-f0-9-]+)?)$");
      if (!allowed) throw new IOException("Unexpected file in dedicated notification storage: " + name);
      CheckFile(file);
    }
    foreach (string child in Directory.GetDirectories(directory)) {
      if (credentials || Path.GetFileName(child) != "ipc-security-v1") throw new IOException("Unexpected directory in dedicated notification storage");
      Preflight(child, true);
    }
  }
  private static void Validate(FileSystemSecurity acl) {
    if (!User.Equals(acl.GetOwner(typeof(SecurityIdentifier)))) throw new UnauthorizedAccessException("IPC storage owner is not the current user");
    if (!acl.AreAccessRulesProtected) throw new UnauthorizedAccessException("IPC storage permissions are inherited");
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.AccessControlType == AccessControlType.Allow && !User.Equals(rule.IdentityReference))
        throw new UnauthorizedAccessException("IPC storage grants another identity access");
    }
  }
  private static bool IsPrivate(FileSystemSecurity acl) {
    try { Validate(acl); return true; } catch (UnauthorizedAccessException) { return false; }
  }
  private static void ProtectDirectory(string directory, DirectorySecurity security) {
    NoLink(directory);
    if (!User.Equals(Directory.GetAccessControl(directory).GetOwner(typeof(SecurityIdentifier))))
      throw new UnauthorizedAccessException("IPC storage owner is not the current user");
    if (!IsPrivate(Directory.GetAccessControl(directory))) {
    var directoryAcl = Directory.GetAccessControl(directory, AccessControlSections.Access);
    directoryAcl.SetAccessRuleProtection(true, false);
    foreach (FileSystemAccessRule rule in directoryAcl.GetAccessRules(true, false, typeof(SecurityIdentifier))) directoryAcl.RemoveAccessRuleSpecific(rule);
    directoryAcl.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl,
      InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    Directory.SetAccessControl(directory, directoryAcl);
    Validate(Directory.GetAccessControl(directory));
    }
    foreach (string file in Directory.GetFiles(directory)) {
      CheckFile(file);
      if (IsPrivate(File.GetAccessControl(file))) continue;
      var fileSecurity = File.GetAccessControl(file, AccessControlSections.Access); fileSecurity.SetAccessRuleProtection(true, false);
      foreach (FileSystemAccessRule rule in fileSecurity.GetAccessRules(true, false, typeof(SecurityIdentifier))) fileSecurity.RemoveAccessRuleSpecific(rule);
      fileSecurity.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl, AccessControlType.Allow));
      File.SetAccessControl(file, fileSecurity); Validate(File.GetAccessControl(file));
    }
    foreach (string child in Directory.GetDirectories(directory)) ProtectDirectory(child, security);
  }
  public static string ReadKey(string storage) {
    if (!Path.IsPathRooted(storage)) throw new IOException("IPC storage must be absolute");
    string normalized = Path.GetFullPath(storage).ToUpperInvariant();
    string digest; using (var hash = SHA256.Create()) digest = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(normalized))).Replace("-", "");
    var security = new MutexSecurity(); security.SetAccessRuleProtection(true, false);
    security.AddAccessRule(new MutexAccessRule(User, MutexRights.FullControl, AccessControlType.Allow));
    bool created, acquired = false;
    using (var mutex = new Mutex(false, @"Local\CodexNotifierIdentity-" + User.Value + "-" + digest, out created, security)) {
      try {
        try { acquired = mutex.WaitOne(20000); } catch (AbandonedMutexException) { acquired = true; }
        if (!acquired) throw new IOException("IPC identity initialization timed out");
        return ReadIdentity(storage);
      } finally { if (acquired) mutex.ReleaseMutex(); }
    }
  }
  private static string ReadIdentity(string storage) {
    if (!Path.IsPathRooted(storage)) throw new IOException("IPC storage must be absolute");
    storage = Path.GetFullPath(storage);
    CheckAncestors(storage); Preflight(storage, false);
    string directory = Path.Combine(storage, "ipc-security-v1");
    var security = new DirectorySecurity();
    security.SetOwner(User);
    security.SetAccessRuleProtection(true, false);
    security.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl,
      InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    Directory.CreateDirectory(storage, security);
    ProtectDirectory(storage, security);
    Directory.CreateDirectory(directory, security);
    NoLink(directory);
    Validate(Directory.GetAccessControl(directory));
    string file = Path.Combine(directory, "identity.dpapi");
    if (!File.Exists(file)) {
      byte[] identity;
      using (RSA rootKey = new RSACng(2048))
      using (RSA key = new RSACng(2048)) {
        var rootRequest = new CertificateRequest("CN=Codex Notifier Root " + Guid.NewGuid().ToString("N"), rootKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        rootRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        using (X509Certificate2 root = rootRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-2), DateTimeOffset.UtcNow.AddYears(11))) {
        var request = new CertificateRequest("CN=Codex Notifier " + Guid.NewGuid().ToString("N"), key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        var usages = new OidCollection(); usages.Add(new Oid("1.3.6.1.5.5.7.3.1")); usages.Add(new Oid("1.3.6.1.5.5.7.3.2"));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(usages, false));
        byte[] serial = new byte[16]; using (var random = RandomNumberGenerator.Create()) random.GetBytes(serial);
        using (X509Certificate2 signed = request.Create(root, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(10), serial))
        using (X509Certificate2 certificate = signed.CopyWithPrivateKey(key))
        using (X509Certificate2 publicRoot = new X509Certificate2(root.Export(X509ContentType.Cert)))
          identity = new X509Certificate2Collection {certificate, publicRoot}.Export(X509ContentType.Pfx, "");
        }
      }
      byte[] protectedKey = ProtectedData.Protect(identity, Encoding.UTF8.GetBytes("codex-notifier-ipc-v1"), DataProtectionScope.CurrentUser);
      string temporary = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".tmp");
      try {
        var fileSecurity = new FileSecurity(); fileSecurity.SetOwner(User); fileSecurity.SetAccessRuleProtection(true, false);
        fileSecurity.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl, AccessControlType.Allow));
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, fileSecurity)) {
          stream.Write(protectedKey, 0, protectedKey.Length); stream.Flush(true);
        }
        try { File.Move(temporary, file); } catch (IOException) { if (!File.Exists(file)) throw; }
      } finally { if (File.Exists(temporary)) File.Delete(temporary); Array.Clear(identity, 0, identity.Length); }
    }
    CheckFile(file); Validate(File.GetAccessControl(file));
    byte[] encrypted = File.ReadAllBytes(file);
    if (encrypted.Length > 16384) throw new IOException("Invalid IPC key file");
    byte[] result = ProtectedData.Unprotect(encrypted, Encoding.UTF8.GetBytes("codex-notifier-ipc-v1"), DataProtectionScope.CurrentUser);
    var certificates = new X509Certificate2Collection(); certificates.Import(result, "", X509KeyStorageFlags.EphemeralKeySet);
    X509Certificate2 leaf = null, authority = null;
    foreach (X509Certificate2 certificate in certificates) {
      if (certificate.HasPrivateKey) leaf = certificate;
      else if (certificate.Subject == certificate.Issuer) authority = certificate;
    }
    try {
      if (leaf == null || authority == null || leaf.NotAfter.ToUniversalTime() <= DateTime.UtcNow)
        throw new IOException("Invalid or expired IPC identity");
      return new JavaScriptSerializer().Serialize(new {pfx = Convert.ToBase64String(result), cert = Convert.ToBase64String(leaf.Export(X509ContentType.Cert)), ca = Convert.ToBase64String(authority.Export(X509ContentType.Cert))});
    } finally { foreach (X509Certificate2 certificate in certificates) certificate.Dispose(); }
  }
  private static void Emit(object value) {
    lock (OutputLock) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); }
  }
  private static NamedPipeServerStream Create(string name, bool first) {
    IntPtr descriptor; uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor("O:" + User.Value + "D:P(A;;GA;;;" + User.Value + ")", 1, out descriptor, out size))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var attributes = new SecurityAttributes {Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, Inherit = 0};
      // DUPLEX; FIRST_PIPE_INSTANCE reserves the name; REJECT_REMOTE_CLIENTS
      // keeps even a same-account network logon off this local channel.
      SafePipeHandle handle = CreateNamedPipe(name, 3u | 0x40000000u | (first ? 0x00080000u : 0u), 0x00000008u, 255, 65536, 65536, 0, ref attributes);
      if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
      return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
    } finally { LocalFree(descriptor); }
  }
  private static void Drop(string id) {
    NamedPipeServerStream stream;
    lock (ClientsLock) { if (!Clients.TryGetValue(id, out stream)) return; Clients.Remove(id); }
    stream.Dispose();
    if (!Closed) Emit(new {type = "close", id = id});
  }
  private static void ReadClient(string id, NamedPipeServerStream stream) {
    try {
      byte[] buffer = new byte[16384]; int count;
      while (!Closed && (count = stream.Read(buffer, 0, buffer.Length)) > 0)
        Emit(new {type = "data", id = id, data = Convert.ToBase64String(buffer, 0, count)});
    } catch (IOException) {} catch (ObjectDisposedException) {}
    finally { Drop(id); }
  }
  private static void Accept(string name) {
    try {
      while (!Closed) {
        NamedPipeServerStream connected = Waiting;
        connected.WaitForConnection();
        // Reserve the next instance before exposing or releasing this one.
        Waiting = Create(name, false);
        string id = Interlocked.Increment(ref Sequence).ToString();
        lock (ClientsLock) { if (Clients.Count >= 64) { connected.Dispose(); continue; } Clients.Add(id, connected); }
        Emit(new {type = "connection", id = id});
        new Thread(() => ReadClient(id, connected)) {IsBackground = true}.Start();
      }
    } catch (Exception error) {
      if (!Closed) { Emit(new {type = "error", error = error.Message}); Shutdown(); }
    }
  }
  private static void Shutdown() {
    Closed = true;
    if (Waiting != null) Waiting.Dispose();
    lock (ClientsLock) { foreach (var stream in Clients.Values) stream.Dispose(); Clients.Clear(); }
  }
  public static void Run(string name) {
    if (String.IsNullOrEmpty(name) || !name.StartsWith(@"\\.\pipe\codex-notifier-", StringComparison.Ordinal) || name.Length > 240)
      throw new IOException("Invalid local IPC pipe name");
    try { Waiting = Create(name, true); }
    catch (Win32Exception error) { Emit(new {type = "error", code = error.NativeErrorCode == 5 || error.NativeErrorCode == 231 ? "EADDRINUSE" : "EACCES", error = error.Message}); return; }
    Emit(new {type = "ready"});
    new Thread(() => Accept(name)) {IsBackground = true}.Start();
    try {
      string line;
      while (!Closed && (line = Console.ReadLine()) != null) {
        if (line.Length > 6000000) throw new IOException("IPC relay command too large");
        var message = new JavaScriptSerializer {MaxJsonLength = 6000000}.Deserialize<Dictionary<string, object>>(line);
        string id = (string)message["id"], type = (string)message["type"];
        if (type == "close") { Drop(id); continue; }
        if (type != "write") throw new IOException("Invalid IPC relay command");
        NamedPipeServerStream stream;
        lock (ClientsLock) { if (!Clients.TryGetValue(id, out stream)) continue; }
        byte[] bytes = Convert.FromBase64String((string)message["data"]);
        string writeId = (string)message["writeId"];
        ThreadPool.QueueUserWorkItem(delegate {
          try { stream.Write(bytes, 0, bytes.Length); if (!Closed) Emit(new {type = "written", id = id, writeId = writeId}); }
          catch (IOException) { Drop(id); } catch (ObjectDisposedException) { Drop(id); }
        });
      }
    } finally { Shutdown(); }
  }
}
