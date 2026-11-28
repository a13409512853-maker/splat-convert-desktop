using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;

sealed class PortableSettings {
    public int SchemaVersion = 3;
    public string Language = "";
    public string Theme = "dark";
    public bool BatchMode = true;
    public int PresetIndex = 2;
    public bool EnableDiagnosticLogs = false;
    public string DefaultOutputDir = "";

    // Global Delayed Tooltip System (single shared delay constant + per-region veteran switches)
    public int TooltipHoverDelayMs = 500;
    public bool TipRegionInput = true;
    public bool TipRegionPipeline = true;
    public bool TipRegionOutput = true;
    public bool TipRegionDialog = true;
    public bool TipRegionEditorToolbar = true;
    public bool TipRegionEditorScene = true;
    public bool TipRegionEditorColor = true;
    public bool TipRegionEditorModal = true;

    // 3D Editor History Limit (default 50 steps) & AI Model Selection
    public int EditorMaxHistorySteps = 50;
    public string ActiveSemanticModel = "sam21-tiny-fp16";

    // Persisted Advanced Options
    public int AdvSogVersion = 3;
    public double AdvShColorError = -1;
    public int AdvSpzVersion = 4;
    public bool AdvPlyLogitOpacity = false;
    public bool AdvHtmlUnbundled = false;
    public bool AdvVoxelExternalFill = false;
    public bool AdvVoxelFloorFill = false;
    public bool AdvVoxelCarve = false;
    public string AdvSeedPos = "0,0,0";
    public string AdvCollisionMesh = "";
    public long AdvTargetMaxBytes = 0;
    public int AdvMinKeepPct = 20;
}

static class PortablePaths {
    static readonly object SettingsSync = new object();
    static string cachedRoot;

    // Strictly derived from Assembly.Location (EXE actual directory), NEVER CurrentDirectory!
    internal static string RootDir {
        get {
            if (cachedRoot == null) {
                string loc = Assembly.GetExecutingAssembly().Location;
                if (String.IsNullOrWhiteSpace(loc)) loc = AppDomain.CurrentDomain.BaseDirectory;
                cachedRoot = Path.GetFullPath(Path.GetDirectoryName(loc));
            }
            return cachedRoot;
        }
    }

    internal static string DataDir { get { return Path.Combine(RootDir, "data"); } }
    internal static string ConfigDir { get { return Path.Combine(DataDir, "config"); } }
    internal static string LocalesDir { get { return Path.Combine(DataDir, "locales"); } }
    internal static string SettingsFile { get { return Path.Combine(ConfigDir, "settings.json"); } }
    internal static string EngineDir { get { return Path.Combine(DataDir, "engine"); } }
    internal static string BundledEngineDir { get { return Path.Combine(EngineDir, "bundled"); } }
    internal static string ActiveEngineFile { get { return Path.Combine(EngineDir, "active.json"); } }
    internal static string JobsDir { get { return Path.Combine(DataDir, "jobs"); } }
    internal static string CacheDir { get { return Path.Combine(DataDir, "cache"); } }
    internal static string TmpDir { get { return Path.Combine(DataDir, "tmp"); } }
    internal static string RecipesDir { get { return Path.Combine(TmpDir, "recipes"); } }
    internal static string RecoveryDir { get { return Path.Combine(TmpDir, "recovery"); } }
    internal static string ModelsDir { get { return Path.Combine(DataDir, "models"); } }
    internal static string OrtRuntimeDir { get { return Path.Combine(ModelsDir, "ort"); } }
    internal static string Sam2ModelsDir { get { return Path.Combine(ModelsDir, "sam2"); } }
    internal static string LogsDir { get { return Path.Combine(DataDir, "logs"); } }
    internal static string RuntimeDir { get { return Path.Combine(DataDir, "runtime"); } }
    internal static string StarMarkerFile { get { return Path.Combine(ConfigDir, "star-prompt-v3.marker"); } }

    // Verifies the portable directory is writable without ever falling back to AppData/LocalAppData/TEMP.
    internal static bool EnsureWritable(out string error) {
        error = null;
        try {
            Directory.CreateDirectory(DataDir);
            string probe = Path.Combine(DataDir, ".write-probe-" + Guid.NewGuid().ToString("N"));
            using (var fs = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                fs.WriteByte(1);
                fs.Flush(true);
            }
            File.Delete(probe);
            return true;
        } catch (Exception ex) {
            error = I18n.F("app.portable.notWritable", "dir", DataDir, "error", ex.Message);
            return false;
        }
    }

    // Normalizes path and verifies it stays strictly inside allowedRoot (blocks .. traversal and reparse point escapes).
    internal static string ResolveStrictlyInside(string allowedRoot, string relativeOrFull) {
        if (String.IsNullOrWhiteSpace(allowedRoot) || String.IsNullOrWhiteSpace(relativeOrFull))
            throw new UnauthorizedAccessException(I18n.T("app.portable.emptyPath"));
        string rootFull = Path.GetFullPath(allowedRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string candidate = Path.IsPathRooted(relativeOrFull)
            ? Path.GetFullPath(relativeOrFull)
            : Path.GetFullPath(Path.Combine(rootFull, relativeOrFull));
        if (!String.Equals(candidate, rootFull, StringComparison.OrdinalIgnoreCase)
            && !candidate.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException(I18n.F("app.portable.outsideRoot", "path", candidate));
        CheckNoReparseEscape(rootFull, candidate);
        return candidate;
    }

    static void CheckNoReparseEscape(string rootFull, string candidate) {
        string cur = candidate;
        while (!String.IsNullOrEmpty(cur) && cur.Length >= rootFull.Length) {
            if (Directory.Exists(cur) || File.Exists(cur)) {
                var attrs = File.GetAttributes(cur);
                if ((attrs & FileAttributes.ReparsePoint) == FileAttributes.ReparsePoint)
                    throw new UnauthorizedAccessException(I18n.F("app.portable.reparseBlocked", "path", cur));
            }
            if (String.Equals(cur, rootFull, StringComparison.OrdinalIgnoreCase)) break;
            cur = Path.GetDirectoryName(cur);
        }
    }

    // Safe scoped cleanup: ONLY allows deleting subdirectories strictly inside data/{jobs,tmp,cache,logs}.
    internal static void SafeDeleteManagedSubdir(string managedParent, string targetDir) {
        if (String.IsNullOrWhiteSpace(targetDir)) return;
        string parentFull = Path.GetFullPath(managedParent).TrimEnd(Path.DirectorySeparatorChar);
        string dataFull = Path.GetFullPath(DataDir).TrimEnd(Path.DirectorySeparatorChar);
        if (!parentFull.StartsWith(dataFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException(I18n.T("app.portable.onlyManagedCleanup"));
        string resolved = ResolveStrictlyInside(parentFull, targetDir);
        if (String.Equals(resolved, parentFull, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException(I18n.T("app.portable.deleteParentDenied"));
        try { if (Directory.Exists(resolved)) Directory.Delete(resolved, true); }
        catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    internal static string MakeRelativeIfInsideRoot(string fullPath) {
        if (String.IsNullOrWhiteSpace(fullPath)) return "";
        string rootFull = RootDir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string target = Path.GetFullPath(fullPath);
        if (target.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
            return target.Substring(rootFull.Length);
        return target;
    }

    internal static string ResolvePortableOrAbsolute(string storedPath) {
        if (String.IsNullOrWhiteSpace(storedPath)) return "";
        if (Path.IsPathRooted(storedPath)) return Path.GetFullPath(storedPath);
        return Path.GetFullPath(Path.Combine(RootDir, storedPath));
    }

    // Redirects all child-process temp/cache/profile environment variables strictly into data/runtime/
    internal static void ApplyChildEnvironment(System.Diagnostics.ProcessStartInfo psi, string jobTmpDir) {
        string runtime = RuntimeDir;
        string tmp = String.IsNullOrWhiteSpace(jobTmpDir) ? Path.Combine(TmpDir, "proc") : jobTmpDir;
        Directory.CreateDirectory(runtime);
        Directory.CreateDirectory(tmp);
        psi.EnvironmentVariables.Remove("NODE_OPTIONS");
        psi.EnvironmentVariables.Remove("NODE_PATH");
        psi.EnvironmentVariables["NO_COLOR"] = "1";
        psi.EnvironmentVariables["TEMP"] = tmp;
        psi.EnvironmentVariables["TMP"] = tmp;
        psi.EnvironmentVariables["TMPDIR"] = tmp;
        psi.EnvironmentVariables["USERPROFILE"] = runtime;
        psi.EnvironmentVariables["HOME"] = runtime;
        psi.EnvironmentVariables["APPDATA"] = runtime;
        psi.EnvironmentVariables["LOCALAPPDATA"] = runtime;
        psi.EnvironmentVariables["XDG_CACHE_HOME"] = CacheDir;
        psi.EnvironmentVariables["XDG_CONFIG_HOME"] = ConfigDir;
        psi.EnvironmentVariables["NODE_COMPILE_CACHE"] = Path.Combine(CacheDir, "node-compile");
    }

    internal static void AtomicWriteText(string path, string content) {
        string resolved = ResolveStrictlyInside(DataDir, path);
        string dir = Path.GetDirectoryName(resolved);
        Directory.CreateDirectory(dir);
        string tmp = Path.Combine(dir, "." + Path.GetFileName(resolved) + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try {
            using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var sw = new StreamWriter(fs, new UTF8Encoding(false))) {
                sw.Write(content);
                sw.Flush();
                fs.Flush(true);
            }
            if (File.Exists(resolved)) File.Replace(tmp, resolved, null);
            else File.Move(tmp, resolved);
        } finally {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
    }

    // Reads settings from data/config/settings.json without creating files on read!
    internal static PortableSettings LoadSettings() {
        lock (SettingsSync) {
            try {
                if (File.Exists(SettingsFile)) {
                    string raw = File.ReadAllText(SettingsFile, Encoding.UTF8);
                    var s = new JavaScriptSerializer().Deserialize<PortableSettings>(raw);
                    if (s != null) {
                        if (s.SchemaVersion < 3 && s.TooltipHoverDelayMs == 700) s.TooltipHoverDelayMs = 500;
                        return s;
                    }
                }
            } catch (IOException) { } catch (UnauthorizedAccessException) { } catch (ArgumentException) { }
            return new PortableSettings();
        }
    }

    internal static void SaveSettings(Action<PortableSettings> mutate) {
        lock (SettingsSync) {
            string err;
            if (!EnsureWritable(out err)) return;
            var s = LoadSettings();
            mutate(s);
            s.SchemaVersion = 3;
            AtomicWriteText(SettingsFile, new JavaScriptSerializer().Serialize(s));
        }
    }
}
