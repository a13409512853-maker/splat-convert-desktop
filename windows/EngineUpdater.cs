using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

sealed class EngineMirror {
    public readonly string Id, NameKey, MetadataUrl;
    public string Name { get { return I18n.T(NameKey); } }
    public EngineMirror(string id, string nameKey, string metadataUrl) {
        Id = id; NameKey = nameKey; MetadataUrl = metadataUrl;
    }
}

sealed class EngineCheckResult {
    public string MirrorName, LatestVersion, TarballUrl, Integrity, Error;
    public long LatencyMs;
    public bool Success { get { return Error == null && !String.IsNullOrWhiteSpace(LatestVersion); } }
}

static class EngineManager {
    internal const string BundledVersion = "3.12.0";
    internal static readonly EngineMirror[] Mirrors = {
        new EngineMirror("npmmirror", "app.engine.mirrorNpmmirror", "https://registry.npmmirror.com/@playcanvas/splat-transform/latest"),
        new EngineMirror("tencent", "app.engine.mirrorTencent", "https://mirrors.cloud.tencent.com/npm/@playcanvas/splat-transform/latest"),
        new EngineMirror("huawei", "app.engine.mirrorHuawei", "https://repo.huaweicloud.com/repository/npm/@playcanvas/splat-transform/latest"),
        new EngineMirror("npmjs", "app.engine.mirrorNpmjs", "https://registry.npmjs.org/@playcanvas/splat-transform/latest")
    };

    static readonly object Sync = new object();

    static EngineManager() {
        try {
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072 | (SecurityProtocolType)768;
        } catch (NotSupportedException) { }
    }

    internal static string RootDir {
        get { return PortablePaths.EngineDir; }
    }

    internal static string BundledDir {
        get { return PortablePaths.BundledEngineDir; }
    }

    internal static string PointerFile {
        get { return PortablePaths.ActiveEngineFile; }
    }

    internal static string ActiveVersion {
        get {
            string dir = ResolveActiveDir();
            if (dir == null) return BundledVersion;
            return ReadPackageVersion(dir) ?? BundledVersion;
        }
    }

    internal static bool IsUsingBundled {
        get {
            string dir = ResolveActiveDir();
            return dir == null || String.Equals(Path.GetFullPath(dir), Path.GetFullPath(BundledDir), StringComparison.OrdinalIgnoreCase);
        }
    }

    internal static string EnsureActiveRuntime(CancellationToken token) {
        lock (Sync) {
            EnsureBundledExtracted(token);
            string active = ResolveActiveDir();
            if (active != null && IsValidRuntime(active)) return active;
            WritePointer("bundled");
            return BundledDir;
        }
    }

    static string ResolveActiveDir() {
        try {
            if (File.Exists(PointerFile)) {
                string rawPtr = File.ReadAllText(PointerFile, Encoding.UTF8).Trim(); string rel = rawPtr; if (rawPtr.StartsWith("{")) { var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(rawPtr); object pv; if (d != null && d.TryGetValue("path", out pv)) rel = Convert.ToString(pv, CultureInfo.InvariantCulture); }
                if (!String.IsNullOrWhiteSpace(rel)) {
                    string full = Path.GetFullPath(Path.Combine(RootDir, rel));
                    if (full.StartsWith(Path.GetFullPath(RootDir) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && IsValidRuntime(full))
                        return full;
                }
            }
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
        return IsValidRuntime(BundledDir) ? BundledDir : null;
    }

    static bool IsValidRuntime(string dir) {
        if (String.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir)) return false;
        return File.Exists(Path.Combine(dir, "node.exe"))
            && File.Exists(Path.Combine(dir, @"node_modules\@playcanvas\splat-transform\bin\cli.mjs"));
    }

    static string ReadPackageVersion(string dir) {
        try {
            string pkg = Path.Combine(dir, @"node_modules\@playcanvas\splat-transform\package.json");
            if (!File.Exists(pkg)) return null;
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(pkg, Encoding.UTF8));
            object ver;
            return data != null && data.TryGetValue("version", out ver) ? Convert.ToString(ver, CultureInfo.InvariantCulture) : null;
        } catch { return null; }
    }

    static void EnsureBundledExtracted(CancellationToken token) {
        string marker = Path.Combine(BundledDir, ".ready");
        if (File.Exists(marker) && IsValidRuntime(BundledDir)) return;
        Directory.CreateDirectory(RootDir);
        string staging = Path.Combine(RootDir, ".extract-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("engine.zip")) {
                if (s == null) throw new InvalidDataException("Missing embedded engine.zip resource.");
                using (var zip = new ZipArchive(s, ZipArchiveMode.Read)) {
                    foreach (var entry in zip.Entries) {
                        token.ThrowIfCancellationRequested();
                        if (String.IsNullOrEmpty(entry.Name)) continue;
                        string dest = Path.GetFullPath(Path.Combine(staging, entry.FullName));
                        if (!dest.StartsWith(Path.GetFullPath(staging) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidDataException("Invalid entry path in embedded engine archive.");
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        using (Stream source = entry.Open())
                        using (var output = new FileStream(dest, FileMode.Create, FileAccess.Write))
                            source.CopyTo(output);
                    }
                }
            }
            File.WriteAllText(Path.Combine(staging, ".ready"), BundledVersion, Encoding.UTF8);
            if (Directory.Exists(BundledDir)) SafeDeleteDir(BundledDir);
            Directory.Move(staging, BundledDir);
        } catch {
            SafeDeleteDir(staging);
            throw;
        }
    }

    internal static EngineCheckResult CheckMirror(EngineMirror mirror, int timeoutMs) {
        var result = new EngineCheckResult { MirrorName = mirror.Name };
        var sw = Stopwatch.StartNew();
        try {
            var req = (HttpWebRequest)WebRequest.Create(mirror.MetadataUrl);
            req.Method = "GET";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.UserAgent = "SplatConvertDesktop/3.2.2";
            req.Accept = "application/json";
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var stream = resp.GetResponseStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8)) {
                string body = reader.ReadToEnd();
                sw.Stop();
                result.LatencyMs = sw.ElapsedMilliseconds;
                var json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                if (json == null || !json.ContainsKey("version")) { result.Error = "Invalid registry metadata"; return result; }
                result.LatestVersion = Convert.ToString(json["version"], CultureInfo.InvariantCulture);
                object distObj;
                if (json.TryGetValue("dist", out distObj) && distObj is Dictionary<string, object>) {
                    var dist = (Dictionary<string, object>)distObj;
                    object tar, integ;
                    if (dist.TryGetValue("tarball", out tar)) result.TarballUrl = Convert.ToString(tar, CultureInfo.InvariantCulture);
                    if (dist.TryGetValue("integrity", out integ)) result.Integrity = Convert.ToString(integ, CultureInfo.InvariantCulture);
                }
                if (String.IsNullOrWhiteSpace(result.TarballUrl)) result.Error = "Missing tarball URL";
            }
        } catch (Exception ex) {
            sw.Stop();
            result.LatencyMs = sw.ElapsedMilliseconds;
            result.Error = ex.Message;
        }
        return result;
    }

    internal static EngineCheckResult CheckBestMirror(string preferredId) {
        IEnumerable<EngineMirror> ordered = Mirrors;
        if (!String.IsNullOrWhiteSpace(preferredId)) {
            ordered = Mirrors.OrderBy(m => m.Id == preferredId ? 0 : 1);
        }
        EngineCheckResult last = null;
        foreach (var mirror in ordered) {
            var res = CheckMirror(mirror, 8000);
            if (res.Success) return res;
            last = res;
        }
        return last ?? new EngineCheckResult { Error = I18n.T("app.engine.allMirrorsUnreachable") };
    }

    internal static string PullUpdate(EngineCheckResult meta, CancellationToken token, Action<string> log) {
        if (meta == null || !meta.Success) throw new InvalidOperationException("No valid update metadata.");
        log(I18n.T("app.engine.prepRuntime"));
        EnsureBundledExtracted(token);

        string versionsDir = Path.Combine(RootDir, "versions");
        Directory.CreateDirectory(versionsDir);
        string staging = Path.Combine(versionsDir, ".stage-" + meta.LatestVersion + "-" + Guid.NewGuid().ToString("N"));
        string targetDir = Path.Combine(versionsDir, meta.LatestVersion);
        string tgzPath = Path.Combine(RootDir, ".download-" + Guid.NewGuid().ToString("N") + ".tgz");

        try {
            log(I18n.F("app.engine.downloading", "mirror", meta.MirrorName, "version", meta.LatestVersion));
            DownloadFile(meta.TarballUrl, tgzPath, token);

            if (!String.IsNullOrWhiteSpace(meta.Integrity) && meta.Integrity.StartsWith("sha512-", StringComparison.OrdinalIgnoreCase)) {
                log(I18n.T("app.engine.verifyingSha"));
                string expected = meta.Integrity.Substring(7).Trim();
                string actual = ComputeSha512Base64(tgzPath);
                if (!String.Equals(expected, actual, StringComparison.Ordinal))
                    throw new InvalidDataException(I18n.T("app.engine.shaMismatch"));
            }

            log(I18n.T("app.engine.assemblingDir"));
            CopyDirectory(BundledDir, staging, token);
            string pkgDir = Path.Combine(staging, @"node_modules\@playcanvas\splat-transform");
            SafeDeleteDir(pkgDir);
            Directory.CreateDirectory(pkgDir);

            log(I18n.T("app.engine.extractingPkg"));
            ExtractTgz(tgzPath, pkgDir, token);

            log(I18n.T("app.engine.selfChecking"));
            string verified = VerifyEngineVersion(staging, token);
            log(I18n.F("app.engine.selfCheckOk", "version", verified));

            lock (Sync) {
                if (Directory.Exists(targetDir)) SafeDeleteDir(targetDir);
                Directory.Move(staging, targetDir);
                WritePointer(Path.Combine("versions", meta.LatestVersion));
            }
            return verified;
        } catch {
            SafeDeleteDir(staging);
            throw;
        } finally {
            try { if (File.Exists(tgzPath)) File.Delete(tgzPath); } catch (IOException) { }
        }
    }

    internal static void RollbackToBundled(CancellationToken token) {
        lock (Sync) {
            EnsureBundledExtracted(token);
            WritePointer("bundled");
        }
    }

    static void WritePointer(string relativeDir) {
        Directory.CreateDirectory(RootDir);
        string tmp = PointerFile + ".tmp";
        File.WriteAllText(tmp, new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "schemaVersion", 1 }, { "path", relativeDir }, { "updatedAt", DateTime.UtcNow.ToString("O") } }), Encoding.UTF8);
        if (File.Exists(PointerFile)) File.Replace(tmp, PointerFile, null);
        else File.Move(tmp, PointerFile);
    }

    static void DownloadFile(string url, string dest, CancellationToken token) {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "GET";
        req.Timeout = 30000;
        req.ReadWriteTimeout = 30000;
        req.UserAgent = "SplatConvertDesktop/3.2.1";
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var input = resp.GetResponseStream())
        using (var output = new FileStream(dest, FileMode.Create, FileAccess.Write)) {
            var buf = new byte[65536];
            int n;
            while ((n = input.Read(buf, 0, buf.Length)) > 0) {
                token.ThrowIfCancellationRequested();
                output.Write(buf, 0, n);
            }
        }
    }

    static string ComputeSha512Base64(string path) {
        using (var sha = SHA512.Create())
        using (var fs = File.OpenRead(path))
            return Convert.ToBase64String(sha.ComputeHash(fs));
    }

    static string VerifyEngineVersion(string runtimeDir, CancellationToken token) {
        string node = Path.Combine(runtimeDir, "node.exe");
        string cli = Path.Combine(runtimeDir, @"node_modules\@playcanvas\splat-transform\bin\cli.mjs");
        var psi = new ProcessStartInfo(node, "\"" + cli + "\" --version") {
            WorkingDirectory = runtimeDir, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        PortablePaths.ApplyChildEnvironment(psi, Path.Combine(PortablePaths.TmpDir, "engine-check")); using (var p = Process.Start(psi)) {
            string stdout = p.StandardOutput.ReadToEnd();
            string stderr = p.StandardError.ReadToEnd();
            p.WaitForExit(15000);
            token.ThrowIfCancellationRequested();
            if (!p.HasExited) { try { p.Kill(); } catch { } throw new TimeoutException(I18n.T("app.engine.selfCheckTimeout")); }
            if (p.ExitCode != 0) throw new InvalidOperationException(I18n.F("app.engine.selfCheckFailed", "error", stderr));
            string ver = stdout.Trim();
            return String.IsNullOrWhiteSpace(ver) ? (ReadPackageVersion(runtimeDir) ?? "unknown") : ver;
        }
    }

    static void CopyDirectory(string sourceDir, string destDir, CancellationToken token) {
        Directory.CreateDirectory(destDir);
        foreach (string file in Directory.GetFiles(sourceDir)) {
            token.ThrowIfCancellationRequested();
            string name = Path.GetFileName(file);
            if (name == ".ready") continue;
            File.Copy(file, Path.Combine(destDir, name), true);
        }
        foreach (string dir in Directory.GetDirectories(sourceDir)) {
            token.ThrowIfCancellationRequested();
            CopyDirectory(dir, Path.Combine(destDir, Path.GetFileName(dir)), token);
        }
    }

    static void ExtractTgz(string tgzPath, string destDir, CancellationToken token) {
        string rootFull = Path.GetFullPath(destDir);
        using (var fs = File.OpenRead(tgzPath))
        using (var gz = new GZipStream(fs, CompressionMode.Decompress)) {
            var header = new byte[512];
            string pendingLongName = null;
            while (true) {
                token.ThrowIfCancellationRequested();
                if (!ReadExact(gz, header, 512)) break;
                bool allZero = true;
                for (int i = 0; i < 512; i++) { if (header[i] != 0) { allZero = false; break; } }
                if (allZero) break;

                string name = ReadTarString(header, 0, 100);
                string prefix = ReadTarString(header, 345, 155);
                if (!String.IsNullOrEmpty(prefix)) name = prefix + "/" + name;
                if (pendingLongName != null) { name = pendingLongName; pendingLongName = null; }

                long size = ReadTarOctal(header, 124, 12);
                byte typeFlag = header[156];

                if (typeFlag == (byte)'L') {
                    var nameBytes = new byte[size];
                    if (!ReadExact(gz, nameBytes, (int)size)) break;
                    pendingLongName = Encoding.UTF8.GetString(nameBytes).TrimEnd('\0', '\r', '\n');
                    SkipTarPadding(gz, size);
                    continue;
                }

                string rel = name.Replace('\\', '/').TrimStart('/');
                if (rel.StartsWith("package/", StringComparison.OrdinalIgnoreCase)) rel = rel.Substring(8);

                if (typeFlag == (byte)'5' || rel.EndsWith("/")) {
                    if (!String.IsNullOrWhiteSpace(rel)) {
                        string dirPath = Path.GetFullPath(Path.Combine(rootFull, rel.Replace('/', Path.DirectorySeparatorChar)));
                        if (dirPath.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) Directory.CreateDirectory(dirPath);
                    }
                    SkipTarData(gz, size);
                } else if (typeFlag == 0 || typeFlag == (byte)'0') {
                    if (!String.IsNullOrWhiteSpace(rel)) {
                        string outPath = Path.GetFullPath(Path.Combine(rootFull, rel.Replace('/', Path.DirectorySeparatorChar)));
                        if (!outPath.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidDataException("Unsafe tar path: " + rel);
                        Directory.CreateDirectory(Path.GetDirectoryName(outPath));
                        using (var outFile = new FileStream(outPath, FileMode.Create, FileAccess.Write)) {
                            CopyExact(gz, outFile, size, token);
                        }
                        SkipTarPadding(gz, size);
                    } else {
                        SkipTarData(gz, size);
                    }
                } else {
                    SkipTarData(gz, size);
                }
            }
        }
    }

    static bool ReadExact(Stream s, byte[] buf, int count) {
        int offset = 0;
        while (offset < count) {
            int n = s.Read(buf, offset, count - offset);
            if (n <= 0) return false;
            offset += n;
        }
        return true;
    }

    static void CopyExact(Stream src, Stream dst, long count, CancellationToken token) {
        var buf = new byte[32768];
        long left = count;
        while (left > 0) {
            token.ThrowIfCancellationRequested();
            int toRead = (int)Math.Min(buf.Length, left);
            int n = src.Read(buf, 0, toRead);
            if (n <= 0) throw new EndOfStreamException("Unexpected end of tar stream.");
            dst.Write(buf, 0, n);
            left -= n;
        }
    }

    static void SkipTarPadding(Stream s, long size) {
        long pad = (512 - (size % 512)) % 512;
        if (pad > 0) { var skip = new byte[pad]; ReadExact(s, skip, (int)pad); }
    }

    static void SkipTarData(Stream s, long size) {
        long total = size + ((512 - (size % 512)) % 512);
        var buf = new byte[4096];
        while (total > 0) {
            int n = s.Read(buf, 0, (int)Math.Min(buf.Length, total));
            if (n <= 0) break;
            total -= n;
        }
    }

    static string ReadTarString(byte[] buf, int offset, int length) {
        int end = offset;
        int limit = offset + length;
        while (end < limit && buf[end] != 0) end++;
        return Encoding.UTF8.GetString(buf, offset, end - offset).Trim();
    }

    static long ReadTarOctal(byte[] buf, int offset, int length) {
        string s = ReadTarString(buf, offset, length).Trim();
        if (String.IsNullOrEmpty(s)) return 0;
        long val = 0;
        foreach (char c in s) {
            if (c >= '0' && c <= '7') val = (val << 3) + (c - '0');
        }
        return val;
    }

    static void SafeDeleteDir(string path) {
        if (String.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
        try { Directory.Delete(path, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
