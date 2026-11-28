using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

sealed class EditorManifestFile {
    public string path { get; set; }
    public long size { get; set; }
    public string sha256 { get; set; }
}

sealed class EditorManifest {
    public int schemaVersion { get; set; }
    public string editorKind { get; set; }
    public string version { get; set; }
    public string entry { get; set; }
    public string assetsHash { get; set; }
    public string assetsSha256 { get; set; }
    public int fileCount { get; set; }
    public EditorManifestFile[] files { get; set; }
}

// Manifest-driven offline asset extractor.
// - Always reads embedded `editor.manifest.json` (never guesses by scanning leftover folders like `resplat/`).
// - Isolates extracted runtime folder & WebView2 cache folder by `version + assetsHash` so upgrading over
//   a 3.2.2 directory NEVER loads stale ReSplat PCUI scripts or stale WebView2 HTTP caches!
static class EditorAssets {
    static readonly Assembly assembly = typeof(EditorAssets).Assembly;
    static EditorManifest cachedManifest;
    static string cachedRawManifest;

    internal static string GetRawManifestJson() {
        if (cachedRawManifest != null) return cachedRawManifest;
        using (var src = assembly.GetManifestResourceStream("editor.manifest.json")) {
            if (src == null) throw new InvalidDataException("Missing embedded editor.manifest.json resource.");
            using (var sr = new StreamReader(src, Encoding.UTF8)) {
                cachedRawManifest = sr.ReadToEnd();
                return cachedRawManifest;
            }
        }
    }

    internal static EditorManifest Manifest {
        get {
            if (cachedManifest == null) {
                string raw = GetRawManifestJson();
                var m = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.Deserialize<EditorManifest>(raw);
                if (m == null || String.IsNullOrWhiteSpace(m.entry) || String.IsNullOrWhiteSpace(m.assetsHash) || m.files == null || m.files.Length == 0) {
                    throw new InvalidDataException("Invalid embedded editor.manifest.json.");
                }
                cachedManifest = m;
            }
            return cachedManifest;
        }
    }

    internal static string Version { get { return Manifest.version ?? "3.2.3"; } }
    internal static string EditorKind { get { return Manifest.editorKind ?? "native-owned"; } }
    internal static string Entry { get { return Manifest.entry.Replace('\\', '/').TrimStart('/'); } }
    internal static string AssetsHash { get { return Manifest.assetsHash; } }

    // Isolated by version + content fingerprint (NEVER collides with 3.2.2's editor-<mvid>/resplat!)
    internal static string Folder {
        get { return Path.Combine(PortablePaths.RuntimeDir, "editor-" + Version + "-" + AssetsHash); }
    }

    // Isolated WebView2 profile per assetsHash so upgrading over 3.2.2's data/cache/webview NEVER serves stale cache
    // and NEVER deletes or mutates user's existing 3.2.2 cache!
    internal static string WebViewCacheDir {
        get { return Path.Combine(PortablePaths.CacheDir, "webview-" + Version + "-" + AssetsHash); }
    }

    internal static void Bind() {
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) => {
            string n = new AssemblyName(e.Name).Name;
            if (n != "Microsoft.Web.WebView2.Core" && n != "Microsoft.Web.WebView2.WinForms") return null;
            using (var src = assembly.GetManifestResourceStream("webview." + n + ".dll"))
            using (var ms = new MemoryStream()) {
                src.CopyTo(ms);
                return Assembly.Load(ms.ToArray());
            }
        };
    }

    static bool FileMatchesManifest(string path, long expectedSize, string expectedSha256) {
        if (!File.Exists(path)) return false;
        try {
            var fi = new FileInfo(path);
            if (expectedSize >= 0 && fi.Length != expectedSize) return false;
            if (String.IsNullOrEmpty(expectedSha256)) return true;
            using (var sha = SHA256.Create())
            using (var fs = File.OpenRead(path)) {
                string actual = BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "").ToLowerInvariant();
                return String.Equals(actual, expectedSha256, StringComparison.OrdinalIgnoreCase);
            }
        } catch {
            return false;
        }
    }

    static void ExtractResourceAtomic(string resourceKey, string dst) {
        Directory.CreateDirectory(Path.GetDirectoryName(dst));
        string tmp = dst + "." + Guid.NewGuid().ToString("N");
        try {
            using (var src = assembly.GetManifestResourceStream(resourceKey)) {
                if (src == null) throw new FileNotFoundException("Missing embedded editor asset: " + resourceKey);
                using (var f = File.Create(tmp)) src.CopyTo(f);
            }
            if (File.Exists(dst)) {
                try { File.Replace(tmp, dst, null); } catch (IOException) { if (!File.Exists(dst)) throw; }
            } else {
                try { File.Move(tmp, dst); } catch (IOException) { if (!File.Exists(dst)) throw; }
            }
        } finally {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
    }

    internal static string Ensure() {
        lock (assembly) {
            var m = Manifest;
            string dir = Folder;
            Directory.CreateDirectory(dir);

            foreach (var f in m.files) {
                string rel = (f.path ?? "").Replace('\\', '/').TrimStart('/');
                if (String.IsNullOrEmpty(rel)) continue;
                string dst = Path.Combine(dir, rel.Replace('/', Path.DirectorySeparatorChar));
                if (FileMatchesManifest(dst, f.size, f.sha256)) continue;
                ExtractResourceAtomic("editor." + rel, dst);
            }

            string manifestDst = Path.Combine(dir, "editor.manifest.json");
            if (!File.Exists(manifestDst)) {
                ExtractResourceAtomic("editor.manifest.json", manifestDst);
            }

            foreach (string key in new[] { "webview.WebView2Loader.dll", "webview.LICENSE.txt" }) {
                string rel = key.Substring(key.IndexOf('.') + 1);
                string dst = Path.Combine(dir, rel);
                if (!File.Exists(dst)) ExtractResourceAtomic(key, dst);
            }

            string entryFull = Path.Combine(dir, Entry.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(entryFull)) {
                throw new FileNotFoundException("Manifest entry missing after extraction: " + entryFull);
            }
            return dir;
        }
    }

    internal static int Worker(string mode, string input, string output, string arg, string runtime, string tmp, CancellationToken token, long budget) {
        int ignoredTotal, ignoredLoaded;
        return WorkerWithProgress(mode, input, output, arg, runtime, tmp, token, budget, null, out ignoredTotal, out ignoredLoaded);
    }

    internal static int WorkerWithProgress(string mode, string input, string output, string arg, string runtime, string tmp, CancellationToken token, long budget, Action<int> onProgress, out int totalPoints, out int loadedPoints) {
        totalPoints = 0;
        loadedPoints = 0;
        string script = Path.Combine(Ensure(), "worker.mjs");
        var psi = new ProcessStartInfo(Path.Combine(runtime, "node.exe"), String.Join(" ", new[] { script, mode, input, output, arg, runtime }.Select(Converter.Quote))) {
            WorkingDirectory = runtime,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            StandardErrorEncoding = Encoding.UTF8
        };
        PortablePaths.ApplyChildEnvironment(psi, tmp);
        psi.EnvironmentVariables["SPLAT_EDITOR_BUDGET"] = budget.ToString(CultureInfo.InvariantCulture);
        token.ThrowIfCancellationRequested();

        var errBuf = new StringBuilder();
        int parsedTotal = 0;
        int parsedLoaded = 0;
        using (var p = Process.Start(psi))
        using (token.Register(() => { try { p.Kill(); } catch (InvalidOperationException) { } })) {
            string line;
            while ((line = p.StandardError.ReadLine()) != null) {
                if (line.StartsWith("PROGRESS:")) {
                    int pct;
                    if (Int32.TryParse(line.Substring(9).Trim(), out pct) && onProgress != null) onProgress(pct);
                } else if (line.StartsWith("TOTAL_POINTS:")) {
                    Int32.TryParse(line.Substring(13).Trim(), out parsedTotal);
                } else if (line.StartsWith("LOADED_POINTS:")) {
                    Int32.TryParse(line.Substring(14).Trim(), out parsedLoaded);
                } else {
                    errBuf.AppendLine(line);
                }
            }
            p.WaitForExit();
            token.ThrowIfCancellationRequested();
            totalPoints = parsedTotal;
            loadedPoints = parsedLoaded > 0 ? parsedLoaded : parsedTotal;
            if (p.ExitCode != 0 && !(mode == "probe" && p.ExitCode == 2)) {
                string error = errBuf.ToString();
                throw new IOException(error.Length > 3500 ? error.Substring(error.Length - 3500) : error);
            }
            return p.ExitCode;
        }
    }
}

// Native-Owned 3D Gaussian Editor Host (v3.2.3):
// - Strictly manifest-driven default entry (always opens our own 3.2.1/3.2.3 UI, NEVER guesses resplat/)
// - Strictly read-only source input; Overwrite Save returns lightweight non-destructive recipe (v3 or preserved v4)
// - Zero-copy SGC3 binary transport via https://session.splat.invalid/cloud-*.bin + real-time PROGRESS streaming
// - Live 1Hz Windows Task Manager GB telemetry feed
// - Crash-safe Save As using Main Window encoder settings (merged / per-object / per-group)
// - Auto-downgrade & zero-loss recovery on WebView2 ProcessFailed / WebGL context lost / main-thread hang
sealed class SceneEditorDialog : Form {
    static bool loaderConfigured;
    readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(17, 20, 25) };
    readonly Label note = new Label {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        BackColor = Color.FromArgb(17, 20, 25),
        ForeColor = Color.FromArgb(226, 232, 240),
        Text = I18n.T("app.editorHost.initNote")
    };
    readonly CancellationTokenSource stop = new CancellationTokenSource();
    readonly System.Windows.Forms.Timer perfTimer = new System.Windows.Forms.Timer { Interval = 1000 };
    readonly ResourceMonitor localMonitor = new ResourceMonitor();
    readonly JavaScriptSerializer serializer = SceneRecipe.CreateSerializer();

    readonly string input, previous, predecodedSgc3Path;
    readonly EncoderSettingsSnapshot encoderPreset;
    readonly long budget;
    readonly string sessionDir;
    readonly string sessionHash;
    readonly bool smokeNoActivate;
    int currentCap;
    string lastTelemetryText = "GPU --%  -- GB/ --GB     |    CPU --%   -- GB/ --GB";
    TaskCompletionSource<bool> cloudLoadedTcs = new TaskCompletionSource<bool>();

    internal string Recipe;
    internal string LoadedEntryUrl { get; private set; }
    internal string ExtractedAssetsDir { get; private set; }
    internal string ActiveWebViewCacheDir { get; private set; }
    internal double LastDecodeSec { get; private set; }

    const string EditorOrigin = "https://editor.splat.invalid/";
    const string SessionOrigin = "https://session.splat.invalid/";
    const string ModelsOrigin = "https://models.splat.invalid/";

    protected override bool ShowWithoutActivation {
        get { return smokeNoActivate; }
    }

    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        Theme.ApplyEditorDarkChrome(this);
    }

    internal SceneEditorDialog(Form owner, string path, ResourceSnapshot res, string existing)
        : this(owner, path, res, existing, null, false, null) { }

    internal SceneEditorDialog(Form owner, string path, ResourceSnapshot res, string existing, EncoderSettingsSnapshot preset)
        : this(owner, path, res, existing, preset, false, null) { }

    internal SceneEditorDialog(Form owner, string path, ResourceSnapshot res, string existing, EncoderSettingsSnapshot preset, bool smokeMode)
        : this(owner, path, res, existing, preset, smokeMode, null) { }

    internal SceneEditorDialog(Form owner, string path, ResourceSnapshot res, string existing, EncoderSettingsSnapshot preset, bool smokeMode, string predecodedSgc3) {
        input = Path.GetFullPath(path);
        previous = existing;
        predecodedSgc3Path = predecodedSgc3;
        encoderPreset = preset ?? new EncoderSettingsSnapshot { Format = Converter.Formats[0] };
        smokeNoActivate = smokeMode;
        sessionHash = ComputeShortHash(input);
        sessionDir = Path.Combine(PortablePaths.TmpDir, "preview-" + Guid.NewGuid().ToString("N"));

        Text = I18n.F("app.editorHost.windowTitle", "name", Path.GetFileName(input));
        BackColor = Color.FromArgb(17, 20, 25);
        ForeColor = Color.FromArgb(226, 232, 240);
        Icon = owner != null ? owner.Icon : SystemIcons.Application;
        if (smokeMode) {
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-3200, 0);
            ShowInTaskbar = false;
            ClientSize = new Size(1520, 900);
        } else {
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(1380, 860);
        }
        MinimumSize = new Size(960, 620);

        budget = res == null || res.TotalMemory <= 0
            ? (2048L << 20)
            : (long)Math.Min(8192L << 20, Math.Min(res.AvailableMemory, res.CommitAvailable > 0 ? res.CommitAvailable : res.AvailableMemory) * 0.55);
        // 0 = 100% lossless full load (SGC3 compact binary + WebGL2 RGBA32F/RGBA16F/RGBA8 supports 15M-35M+ splats!)
        currentCap = budget < (256L << 20) ? 250000 : 0;
        if (res != null) lastTelemetryText = FormatTelemetry(res);

        Controls.Add(view);
        Controls.Add(note);
        I18n.LanguageChanged += OnHostLanguageChanged;
        Shown += (s, e) => Start(null);
        FormClosing += (s, e) => {
            I18n.LanguageChanged -= OnHostLanguageChanged;
            perfTimer.Stop();
            perfTimer.Dispose();
            localMonitor.Dispose();
            stop.Cancel();
            cloudLoadedTcs.TrySetCanceled();
            try {
                if (Directory.Exists(sessionDir)) Directory.Delete(sessionDir, true);
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        };
    }

    void OnHostLanguageChanged() {
        if (IsDisposed) return;
        Action apply = () => {
            if (IsDisposed) return;
            Text = I18n.F("app.editorHost.windowTitle", "name", Path.GetFileName(input));
            note.Text = I18n.T("app.editorHost.initNote");
            PushJson(new {
                type = "setLanguage",
                lang = I18n.Language,
                dict = I18n.ExportFlatDict(I18n.Language),
                fallback = I18n.ExportFlatDict(I18n.DefaultCode),
                availableFormats = Converter.Formats.Select(f => new { suffix = f.Suffix, name = f.Name }).ToArray(),
                models = ModelManager.BuildModelsPayload(ModelsOrigin)
            });
        };
        try {
            if (InvokeRequired) BeginInvoke(apply);
            else apply();
        } catch { }
    }

    static string ComputeShortHash(string text) {
        using (var sha = SHA256.Create()) {
            byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(text.ToLowerInvariant()));
            var sb = new StringBuilder(16);
            for (int i = 0; i < 8; i++) sb.Append(h[i].ToString("x2"));
            return sb.ToString();
        }
    }

    internal static string ComputeSourceFingerprint(string filePath) {
        try {
            var fi = new FileInfo(filePath);
            if (fi.Length <= (32L << 20)) {
                using (var sha = SHA256.Create())
                using (var fs = File.OpenRead(filePath)) {
                    return BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "").ToLowerInvariant();
                }
            }
            return SplatInspector.QuickFingerprint(filePath) ?? "";
        } catch {
            return "";
        }
    }

    string RecoveryFilePath {
        get { return Path.Combine(PortablePaths.RecoveryDir, "journal-" + sessionHash + ".json"); }
    }

    static object BuildTelemetryData(ResourceSnapshot r) {
        if (r == null) return null;
        var gpu = r.Gpus.OrderByDescending(g => g.Usage ?? -1).FirstOrDefault();
        return new {
            cpuPct = r.Cpu.HasValue ? (double?)Math.Round(r.Cpu.Value, 1) : null,
            cpuName = r.CpuName ?? "",
            ramUsedGb = r.TotalMemory > 0 ? (double?)Math.Round((r.TotalMemory - r.AvailableMemory) / 1073741824d, 2) : null,
            ramTotalGb = r.TotalMemory > 0 ? (double?)Math.Round(r.TotalMemory / 1073741824d, 1) : null,
            commitAvailGb = r.CommitAvailable >= 0 ? (double?)Math.Round(r.CommitAvailable / 1073741824d, 1) : null,
            appRamMb = r.AppRamBytes > 0 ? (double?)Math.Round(r.AppRamBytes / 1048576d, 0) : null,
            gpuName = gpu != null ? (gpu.Name ?? "") : "",
            gpuPct = gpu != null && gpu.Usage.HasValue ? (double?)Math.Round(gpu.Usage.Value, 1) : null,
            vramUsedGb = gpu != null && gpu.MemoryUsed.HasValue ? (double?)Math.Round(gpu.MemoryUsed.Value / 1073741824d, 2) : null,
            vramTotalGb = gpu != null && gpu.MemoryTotal > 0 ? (double?)Math.Round(gpu.MemoryTotal / 1073741824d, 1) : null,
            gpuSharedGb = gpu != null && gpu.SharedMemoryUsed.HasValue ? (double?)Math.Round(gpu.SharedMemoryUsed.Value / 1073741824d, 2) : null,
            gpuTempC = gpu != null ? gpu.TemperatureC : null,
            gpuPowerW = gpu != null ? gpu.PowerWatts : null
        };
    }

    static string FormatTelemetry(ResourceSnapshot r) {
        if (r == null) return "GPU --%  -- GB/ --GB     |    CPU --%   -- GB/ --GB";
        var gpu = r.Gpus.OrderByDescending(g => g.Usage ?? -1).FirstOrDefault();
        string gpuPct = gpu != null && gpu.Usage.HasValue ? gpu.Usage.Value.ToString("0", CultureInfo.InvariantCulture) + "%" : "--%";
        string vramUsed = gpu != null && gpu.MemoryUsed.HasValue ? (gpu.MemoryUsed.Value / 1073741824d).ToString("0.0", CultureInfo.InvariantCulture) : "--";
        string vramTotal = gpu != null && gpu.MemoryTotal > 0 ? (gpu.MemoryTotal / 1073741824d).ToString("0.#", CultureInfo.InvariantCulture) : "--";
        string cpuPct = r.Cpu.HasValue ? r.Cpu.Value.ToString("0", CultureInfo.InvariantCulture) + "%" : "--%";
        string ramUsed = r.TotalMemory > 0 ? ((r.TotalMemory - r.AvailableMemory) / 1073741824d).ToString("0.0", CultureInfo.InvariantCulture) : "--";
        string ramTotal = r.TotalMemory > 0 ? (r.TotalMemory / 1073741824d).ToString("0.#", CultureInfo.InvariantCulture) : "--";
        return "GPU " + gpuPct + "  " + vramUsed + " GB/ " + vramTotal + "GB     |    CPU " + cpuPct + "   " + ramUsed + " GB/ " + ramTotal + "GB";
    }

    internal string LastPushError { get; private set; }
    internal int PushSentCount { get; private set; }

    void PushJson(object payload) {
        if (IsDisposed) return;
        string json;
        try { json = serializer.Serialize(payload); } catch (Exception ex) { LastPushError = "ser:" + ex.Message; return; }
        Action send = () => {
            if (IsDisposed) return;
            try {
                var core = view.CoreWebView2;
                if (core != null) { core.PostWebMessageAsJson(json); PushSentCount++; }
                else LastPushError = "core-null";
            } catch (Exception ex) { LastPushError = "post:" + ex.Message; }
        };
        try {
            if (InvokeRequired) BeginInvoke(send);
            else send();
        } catch (Exception ex) { LastPushError = "invoke:" + ex.Message; }
    }

    void ShowFatalNote(string text) {
        cloudLoadedTcs.TrySetException(new IOException(text));
        Action apply = () => {
            if (IsDisposed) return;
            PushJson(new { type = "loadError", message = text });
            view.Visible = false;
            note.Visible = true;
            note.Text = text;
            note.BringToFront();
        };
        try {
            if (InvokeRequired) BeginInvoke(apply);
            else apply();
        } catch { }
    }

    object BuildTooltipPayload() {
        return new {
            delayMs = TooltipConfig.HoverDelayMs,
            maxHistorySteps = TooltipConfig.EditorMaxHistorySteps,
            regions = new {
                toolbar = TooltipConfig.ShowEditorToolbarTips,
                scene = TooltipConfig.ShowEditorSceneTips,
                color = TooltipConfig.ShowEditorColorTips,
                modals = TooltipConfig.ShowEditorModalTips
            }
        };
    }

    object BuildSam2Status() {
        string dir = PortablePaths.Sam2ModelsDir;
        string enc = Path.Combine(dir, "sam2_hiera_tiny.encoder.onnx");
        string dec = Path.Combine(dir, "sam2_hiera_tiny.decoder.onnx");
        string ort = Path.Combine(dir, "ort.webgpu.min.mjs");
        bool hasEnc = File.Exists(enc);
        bool hasDec = File.Exists(dec);
        bool hasOrt = File.Exists(ort);
        return new {
            available = hasEnc && hasDec && hasOrt,
            hasEncoder = hasEnc,
            hasDecoder = hasDec,
            hasOrtRuntime = hasOrt,
            modelsDir = dir,
            encoderUrl = ModelsOrigin + "sam2/sam2_hiera_tiny.encoder.onnx",
            decoderUrl = ModelsOrigin + "sam2/sam2_hiera_tiny.decoder.onnx",
            ortUrl = ModelsOrigin + "sam2/ort.webgpu.min.mjs",
            wasmBaseUrl = ModelsOrigin + "sam2/"
        };
    }

    static bool IsAllowedEditorEntryUri(string uri) {
        if (String.IsNullOrEmpty(uri)) return false;
        string expectedPrefix = EditorOrigin + EditorAssets.Entry;
        if (String.Equals(uri, expectedPrefix, StringComparison.OrdinalIgnoreCase)) return true;
        return uri.StartsWith(expectedPrefix + "?", StringComparison.OrdinalIgnoreCase);
    }

    async void Start(object crashRecoveryInfo) {
        try {
            if (SynchronizationContext.Current == null) {
                SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
            }
            if (budget < (96L << 20)) throw new IOException(I18n.T("app.editorHost.lowMemory"));
            var token = stop.Token;
            Directory.CreateDirectory(sessionDir);
            Directory.CreateDirectory(PortablePaths.Sam2ModelsDir);
            Directory.CreateDirectory(PortablePaths.RecoveryDir);

            string baseDir = await Task.Run(() => EditorAssets.Ensure());
            ExtractedAssetsDir = baseDir;
            ActiveWebViewCacheDir = EditorAssets.WebViewCacheDir;
            token.ThrowIfCancellationRequested();
            if (!loaderConfigured) { CoreWebView2Environment.SetLoaderDllFolderPath(baseDir); loaderConfigured = true; }

            if (view.CoreWebView2 == null) {
                string fixedDir = Path.Combine(PortablePaths.RuntimeDir, "WebView2");
                Directory.CreateDirectory(ActiveWebViewCacheDir);
                var env = await CoreWebView2Environment.CreateAsync(
                    Directory.Exists(fixedDir) ? fixedDir : null,
                    ActiveWebViewCacheDir,
                    new CoreWebView2EnvironmentOptions("--disable-background-networking --disable-component-update --disable-breakpad"));
                token.ThrowIfCancellationRequested();
                await view.EnsureCoreWebView2Async(env);
                token.ThrowIfCancellationRequested();

                var core = view.CoreWebView2;
                // Strictly map editor.splat.invalid to manifest-declared native-owned directory (NEVER scans for resplat/)!
                core.SetVirtualHostNameToFolderMapping("editor.splat.invalid", baseDir, CoreWebView2HostResourceAccessKind.Allow);
                core.SetVirtualHostNameToFolderMapping("session.splat.invalid", sessionDir, CoreWebView2HostResourceAccessKind.Allow);
                core.SetVirtualHostNameToFolderMapping("models.splat.invalid", PortablePaths.ModelsDir, CoreWebView2HostResourceAccessKind.Allow);
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.NavigationStarting += (s, e) => { if (!IsAllowedEditorEntryUri(e.Uri)) e.Cancel = true; };
                core.NewWindowRequested += (s, e) => e.Handled = true;
                core.ProcessFailed += OnWebViewProcessFailed;
                core.WebMessageReceived += OnWebMessageReceived;

                perfTimer.Tick += (s, e) => {
                    Task.Run(() => {
                        try {
                            var snap = localMonitor.Sample();
                            string txt = FormatTelemetry(snap);
                            lastTelemetryText = txt;
                            PushJson(new { type = "telemetry", text = txt, data = BuildTelemetryData(snap) });
                        } catch { }
                    });
                };
                perfTimer.Start();
            }

            await NavigateAndLoadCloud(currentCap, crashRecoveryInfo);
        } catch (OperationCanceledException) {
        } catch (Exception e) {
            if (!IsDisposed && !stop.IsCancellationRequested) {
                ShowFatalNote(I18n.F("app.editorHost.previewUnavailable", "error", e.Message));
            }
        }
    }

    async Task NavigateAndLoadCloud(int capToLoad, object crashRecoveryInfo) {
        var token = stop.Token;
        if (!IsDisposed) { view.Visible = true; note.Visible = false; }
        var core = view.CoreWebView2;
        if (core == null) throw new IOException(I18n.T("app.editorHost.webviewNotReady"));
        var readyTcs = new TaskCompletionSource<bool>();
        EventHandler<CoreWebView2WebMessageReceivedEventArgs> readyHook = null;
        readyHook = (s, e) => {
            if (!IsAllowedEditorEntryUri(e.Source)) return;
            string msg = e.TryGetWebMessageAsString();
            if (msg == "ready") {
                readyTcs.TrySetResult(true);
            } else if (msg.StartsWith("error:")) {
                readyTcs.TrySetException(new IOException(msg.Substring(6)));
            }
        };
        core.WebMessageReceived += readyHook;
        try {
            string entryUrl = EditorOrigin + EditorAssets.Entry + "?assetsHash=" + Uri.EscapeDataString(EditorAssets.AssetsHash);
            LoadedEntryUrl = entryUrl;
            core.Navigate(entryUrl);
            using (token.Register(() => readyTcs.TrySetCanceled())) {
                if (await Task.WhenAny(readyTcs.Task, Task.Delay(25000, token)) != readyTcs.Task)
                    throw new IOException(I18n.T("app.editorHost.initTimeout"));
                await readyTcs.Task;
            }
        } finally {
            core.WebMessageReceived -= readyHook;
        }

        // Push active locale dictionary immediately so loading shimmer & initial UI reflect Main UI language
        PushJson(new {
            type = "setLanguage",
            lang = I18n.Language,
            dict = I18n.ExportFlatDict(I18n.Language),
            fallback = I18n.ExportFlatDict(I18n.DefaultCode)
        });

        // Stream SGC3 sampling progress directly to the shimmer loading indicator (no spinner ring)
        PushJson(new { type = "progress", percent = 2, stage = I18n.T("app.editorHost.stageBootWorker") });

        string cloudBinName = "cloud-" + capToLoad + "-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".bin";
        string cloudBinPath = Path.Combine(sessionDir, cloudBinName);
        int totalPoints = 0;
        int loadedPoints = 0;
        string sourceFp = "";

        await Task.Run(() => {
            var swDec = Stopwatch.StartNew();
            sourceFp = ComputeSourceFingerprint(input);
            if (!String.IsNullOrEmpty(predecodedSgc3Path) && File.Exists(predecodedSgc3Path)) {
                File.Copy(predecodedSgc3Path, cloudBinPath, true);
                using (var fs = File.OpenRead(cloudBinPath))
                using (var br = new BinaryReader(fs)) {
                    byte[] magic = br.ReadBytes(4);
                    uint ver = br.ReadUInt32();
                    uint tot = br.ReadUInt32();
                    uint used = br.ReadUInt32();
                    if (magic.Length == 4 && magic[0] == 'S' && magic[1] == 'G' && magic[2] == 'C' && magic[3] == '3' && ver == 3) {
                        totalPoints = (int)tot;
                        loadedPoints = (int)used;
                    }
                }
                LastDecodeSec = 0.0;
            } else {
                string runtime = EngineManager.EnsureActiveRuntime(token);
                string capArg = capToLoad <= 0 ? "full" : capToLoad.ToString(CultureInfo.InvariantCulture);
                EditorAssets.WorkerWithProgress(
                    "sample", input, cloudBinPath, capArg, runtime, sessionDir, token, budget,
                    pct => {
                        int mapped = Math.Max(3, Math.Min(92, (int)Math.Round(pct * 0.90) + 2));
                        string stageText = pct < 12 ? I18n.T("app.editorHost.stageOpenAsset")
                            : pct < 88 ? I18n.T("app.editorHost.stageDecode")
                            : I18n.T("app.editorHost.stageBuildSgc3");
                        PushJson(new { type = "progress", percent = mapped, stage = stageText });
                    },
                    out totalPoints, out loadedPoints);
                LastDecodeSec = Math.Round(swDec.Elapsed.TotalSeconds, 3);
            }
        });
        token.ThrowIfCancellationRequested();

        string savedJournal = null;
        if (crashRecoveryInfo != null && File.Exists(RecoveryFilePath)) {
            try { savedJournal = File.ReadAllText(RecoveryFilePath, Encoding.UTF8); } catch { }
        }

        PushJson(new {
            type = "init",
            cloudUrl = SessionOrigin + Uri.EscapeDataString(cloudBinName),
            fileName = Path.GetFileName(input),
            assetId = "asset-" + sessionHash,
            sourceSha256 = sourceFp,
            totalPoints = totalPoints,
            loadedPoints = loadedPoints,
            recipe = previous,
            sessionKey = sessionHash,
            editorKind = EditorAssets.EditorKind,
            editorEntry = EditorAssets.Entry,
            assetsHash = EditorAssets.AssetsHash,
            appVersion = EditorAssets.Version,
            lang = I18n.Language,
            i18nDict = I18n.ExportFlatDict(I18n.Language),
            i18nFallback = I18n.ExportFlatDict(I18n.DefaultCode),
            telemetry = lastTelemetryText,
            telemetryData = BuildTelemetryData(localMonitor.Sample()),
            tooltipConfig = BuildTooltipPayload(),
            encoderPreset = encoderPreset.ToWebSummary(),
            availableFormats = Converter.Formats.Select(f => new { suffix = f.Suffix, name = f.Name }).ToArray(),
            sam2 = BuildSam2Status(),
            models = ModelManager.BuildModelsPayload(ModelsOrigin),
            crashRecovery = crashRecoveryInfo,
            recoveryJournal = savedJournal
        });

        note.Visible = false;
        if (!smokeNoActivate) view.Focus();
        cloudLoadedTcs.TrySetResult(true);
    }

    async void OnWebViewProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e) {
        if (IsDisposed || stop.IsCancellationRequested) return;
        string telemetryAtCrash = lastTelemetryText;
        int nextCap = currentCap == 0 ? 500000 : Math.Max(50000, currentCap / 2);
        currentCap = nextCap;
        var recoveryPayload = new {
            reason = I18n.F("app.editorHost.processFailed", "kind", e.ProcessFailedKind),
            telemetry = telemetryAtCrash,
            downgradedCap = nextCap
        };
        try {
            await Task.Delay(300);
            if (!IsDisposed && !stop.IsCancellationRequested) {
                if (InvokeRequired) {
                    BeginInvoke(new Action(async () => {
                        try { await NavigateAndLoadCloud(nextCap, recoveryPayload); }
                        catch (Exception ex2) { ShowFatalNote(I18n.F("app.editorHost.recoveryFailed", "error", ex2.Message)); }
                    }));
                } else {
                    await NavigateAndLoadCloud(nextCap, recoveryPayload);
                }
            }
        } catch (Exception ex) {
            ShowFatalNote(I18n.F("app.editorHost.recoveryFailed", "error", ex.Message));
        }
    }

    void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
        if (!IsAllowedEditorEntryUri(e.Source)) return;
        string msg = e.TryGetWebMessageAsString();
        if (String.IsNullOrEmpty(msg) || msg == "ready" || msg.StartsWith("error:")) return;

        if (msg == "cancel") {
            Close();
        } else if (msg.StartsWith("apply:")) {
            Recipe = msg.Substring(6);
            try { if (File.Exists(RecoveryFilePath)) File.Delete(RecoveryFilePath); } catch { }
            DialogResult = DialogResult.OK;
            Close();
        } else if (msg.StartsWith("checkpoint:")) {
            string journalJson = msg.Substring(11);
            Task.Run(() => {
                try { PortablePaths.AtomicWriteText(RecoveryFilePath, journalJson); } catch { }
            });
        } else if (msg.StartsWith("reloadLowDensity:") || msg.StartsWith("enterSafeModeReload:")) {
            int colon = msg.IndexOf(':');
            HandleReloadSafeMode(msg.Substring(colon + 1));
        } else if (msg.StartsWith("exportImage:")) {
            HandleExportImage(msg.Substring(12));
        } else if (msg.StartsWith("saveAs:")) {
            HandleSaveAs(msg.Substring(7));
        } else if (msg == "sam2Check") {
            PushJson(new { type = "sam2Status", sam2 = BuildSam2Status() });
        } else if (msg == "sam2Import") {
            HandleSam2Import();
        } else if (msg == "modelsStatus") {
            PushJson(new { type = "modelsStatus", models = ModelManager.BuildModelsPayload(ModelsOrigin) });
        } else if (msg == "ensureBundledModels") {
            Task.Run(() => {
                string err;
                bool ok = ModelManager.EnsureBundledExtracted(out err);
                PushJson(new {
                    type = "bundledModelsReady",
                    ok = ok,
                    error = err,
                    models = ModelManager.BuildModelsPayload(ModelsOrigin)
                });
            });
        } else if (msg.StartsWith("modelDownload:")) {
            string mid = msg.Substring(14).Trim();
            Task.Run(async () => {
                PushJson(new { type = "modelsStatus", models = ModelManager.BuildModelsPayload(ModelsOrigin) });
                var res = await ModelManager.DownloadModelAsync(mid, (pct, stage) => {
                    PushJson(new { type = "modelDownloadProgress", modelId = mid, percent = pct, stage = stage });
                });
                PushJson(new {
                    type = "modelDownloadDone",
                    modelId = mid,
                    ok = res.Item1,
                    message = res.Item2,
                    models = ModelManager.BuildModelsPayload(ModelsOrigin)
                });
            });
        } else if (msg.StartsWith("modelCancelDownload:")) {
            ModelManager.CancelDownload(msg.Substring(20).Trim());
        } else if (msg.StartsWith("modelSelect:")) {
            string mid = msg.Substring(12).Trim();
            var spec = ModelManager.FindSpec(mid);
            if (spec != null && spec.Category == "semantic") {
                PortablePaths.SaveSettings(s => { s.ActiveSemanticModel = spec.Id; });
            }
            PushJson(new { type = "modelsStatus", models = ModelManager.BuildModelsPayload(ModelsOrigin) });
        }
    }

    async void HandleReloadSafeMode(string json) {
        try {
            var dict = serializer.Deserialize<Dictionary<string, object>>(json) ?? new Dictionary<string, object>();
            string reason = dict.ContainsKey("reason") ? Convert.ToString(dict["reason"], CultureInfo.InvariantCulture) : I18n.T("app.editorHost.safeModeDefaultReason");
            string telemetry = dict.ContainsKey("telemetry") ? Convert.ToString(dict["telemetry"], CultureInfo.InvariantCulture) : lastTelemetryText;

            // Never silently downsample points; recreate WebGL2 cleanly and enter Centers-Mode Low-Perf Safe Mode!
            var recoveryPayload = new {
                reason = reason,
                telemetry = telemetry,
                safeMode = true
            };
            await NavigateAndLoadCloud(currentCap, recoveryPayload);
        } catch (Exception ex) {
            PushJson(new { type = "toast", level = "error", message = I18n.F("app.editorHost.safeModeReloadFailed", "error", ex.Message) });
        }
    }

    void HandleSam2Import() {
        try {
            using (var ofd = new OpenFileDialog {
                Title = I18n.T("app.editorHost.sam2ImportTitle"),
                Multiselect = true,
                Filter = I18n.T("app.editorHost.sam2ImportFilter")
            }) {
                if (ofd.ShowDialog(this) != DialogResult.OK) return;
                Directory.CreateDirectory(PortablePaths.Sam2ModelsDir);
                int copied = 0;
                foreach (string f in ofd.FileNames) {
                    string dst = Path.Combine(PortablePaths.Sam2ModelsDir, Path.GetFileName(f));
                    File.Copy(f, dst, true);
                    copied++;
                }
                PushJson(new { type = "sam2Status", sam2 = BuildSam2Status(), message = I18n.F("app.editorHost.sam2Imported", "count", copied) });
            }
        } catch (Exception ex) {
            PushJson(new { type = "toast", level = "error", message = I18n.F("app.editorHost.sam2ImportFailed", "error", ex.Message) });
        }
    }

    void HandleExportImage(string json) {
        try {
            var dict = serializer.Deserialize<Dictionary<string, object>>(json);
            string base64 = dict.ContainsKey("base64") ? (dict["base64"] as string) : null;
            if (String.IsNullOrEmpty(base64) && dict.ContainsKey("dataUrl")) {
                string du = dict["dataUrl"] as string;
                int comma = du == null ? -1 : du.IndexOf(',');
                base64 = comma >= 0 ? du.Substring(comma + 1) : du;
            }
            if (String.IsNullOrEmpty(base64)) return;
            byte[] bytes = Convert.FromBase64String(base64);
            using (var sfd = new SaveFileDialog {
                Filter = I18n.T("app.editorHost.exportImageFilter"),
                FileName = Path.GetFileNameWithoutExtension(input) + "-view.png"
            }) {
                if (sfd.ShowDialog(this) == DialogResult.OK) {
                    File.WriteAllBytes(sfd.FileName, bytes);
                    PushJson(new { type = "exportImageResult", ok = true, path = sfd.FileName });
                } else {
                    PushJson(new { type = "exportImageResult", ok = false, message = I18n.T("app.editorHost.exportImageCanceled") });
                }
            }
        } catch (Exception ex) {
            PushJson(new { type = "exportImageResult", ok = false, message = ex.Message });
            MessageBox.Show(this, I18n.F("app.editorHost.exportImageFailed", "error", ex.Message), I18n.T("app.editorHost.exportImageTitle"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    async void HandleSaveAs(string json) {
        string outDir = null;
        using (var fbd = new FolderBrowserDialog { Description = I18n.T("app.editorHost.saveAsFolderDesc") }) {
            if (fbd.ShowDialog(this) != DialogResult.OK) {
                PushJson(new { type = "saveAsResult", ok = false, canceled = true, message = I18n.T("app.editorHost.saveAsCanceledFolder") });
                return;
            }
            outDir = fbd.SelectedPath;
        }

        try {
            var payload = serializer.Deserialize<Dictionary<string, object>>(json);
            string formatSuffix = payload.ContainsKey("format") ? (payload["format"] as string) : null;
            if (String.IsNullOrEmpty(formatSuffix)) formatSuffix = encoderPreset.Format != null ? encoderPreset.Format.Suffix : ".ply";
            bool useMainEncoderParams = !payload.ContainsKey("useMainParams") || Convert.ToBoolean(payload["useMainParams"], CultureInfo.InvariantCulture);

            var jobsObj = payload.ContainsKey("jobs") ? (payload["jobs"] as ArrayList) : null;
            if (jobsObj == null || jobsObj.Count == 0) {
                PushJson(new { type = "saveAsResult", ok = false, message = I18n.T("app.editorHost.saveAsNoObjects") });
                return;
            }

            if (payload.ContainsKey("checkpoint") && payload["checkpoint"] != null) {
                try { PortablePaths.AtomicWriteText(RecoveryFilePath, serializer.Serialize(payload["checkpoint"])); } catch { }
            }

            string baseName = Path.GetFileNameWithoutExtension(input);
            var fmt = Converter.Formats.FirstOrDefault(f => String.Equals(f.Suffix, formatSuffix, StringComparison.OrdinalIgnoreCase)) ?? Converter.Formats[0];
            var exported = new List<string>();
            var token = stop.Token;

            await Task.Run(() => {
                using (var conv = new Converter()) {
                    PushJson(new { type = "saveAsProgress", percent = 5, detail = I18n.T("app.editorHost.saveAsInitEngine") });
                    conv.Prepare(token);

                    for (int i = 0; i < jobsObj.Count; i++) {
                        token.ThrowIfCancellationRequested();
                        var item = jobsObj[i] as Dictionary<string, object>;
                        string itemName = (item != null && item.ContainsKey("name") ? item["name"] as string : null) ?? ("part_" + (i + 1));
                        string safeName = String.Join("_", itemName.Split(Path.GetInvalidFileNameChars()));
                        if (String.IsNullOrWhiteSpace(safeName)) safeName = "part_" + (i + 1);

                        string recipeJson = serializer.Serialize(item["recipe"]);
                        string recipeStored = SceneRecipe.StoreIfLarge(recipeJson);
                        string fileName = jobsObj.Count == 1
                            ? (baseName + "_edited" + fmt.Suffix)
                            : (baseName + "_" + safeName + fmt.Suffix);
                        string outFile = Path.Combine(outDir, fileName);
                        if (String.Equals(Path.GetFullPath(outFile), input, StringComparison.OrdinalIgnoreCase)) {
                            outFile = Path.Combine(outDir, baseName + "_edited_" + DateTime.Now.ToString("HHmmss") + fmt.Suffix);
                        }

                        var inp = new InputFile(input);
                        inp.Ops.Add(new Op { Step = Step.Scene, Value = recipeStored, Enabled = true });
                        var job = new Job {
                            Output = outFile,
                            Format = fmt,
                            Overwrite = true,
                            BatchMode = false,
                            AdaptiveDecimate = useMainEncoderParams ? encoderPreset.AdaptiveDecimate : false,
                            Keep = useMainEncoderParams ? encoderPreset.Keep : 100,
                            Iterations = useMainEncoderParams ? encoderPreset.Iterations : 10,
                            Effort = useMainEncoderParams ? encoderPreset.Effort : -1,
                            Workers = useMainEncoderParams ? encoderPreset.Workers : 4,
                            VoxelSize = encoderPreset.VoxelSize,
                            Opacity = encoderPreset.Opacity,
                            Device = useMainEncoderParams ? encoderPreset.Device : "auto",
                            SogVersion = encoderPreset.SogVersion,
                            ShColorError = encoderPreset.ShColorError,
                            SpzVersion = encoderPreset.SpzVersion,
                            PlyLogitOpacity = encoderPreset.PlyLogitOpacity,
                            HtmlUnbundled = encoderPreset.HtmlUnbundled,
                            VoxelExternalFill = encoderPreset.VoxelExternalFill,
                            VoxelFloorFill = encoderPreset.VoxelFloorFill,
                            VoxelCarve = encoderPreset.VoxelCarve,
                            SeedPos = encoderPreset.SeedPos,
                            CollisionMesh = encoderPreset.CollisionMesh,
                            TargetMaxBytes = useMainEncoderParams ? encoderPreset.TargetMaxBytes : 0,
                            MinKeepPct = encoderPreset.MinKeepPct,
                            MaxAttempts = encoderPreset.MaxAttempts
                        };
                        job.Inputs.Add(inp);
                        if (useMainEncoderParams && encoderPreset.OutputOps != null) {
                            foreach (var op in encoderPreset.OutputOps) {
                                if (op.Enabled && (op.Step.Flag == "--filter-nan" || op.Step.Flag == "--filter-harmonics"))
                                    job.Ops.Add(new Op { Step = op.Step, Value = op.Value, Enabled = true });
                            }
                        }

                        int jobIdx = i;
                        int jobTotal = jobsObj.Count;
                        conv.ConvertSingleWithTargetSize(
                            job, token,
                            st => PushJson(new { type = "saveAsProgress", percent = (int)Math.Round(((jobIdx + 0.1) / jobTotal) * 100), detail = "[" + (jobIdx + 1) + "/" + jobTotal + "] " + itemName + " · " + I18n.T(st) }),
                            l => { },
                            pi => {
                                double overall = ((jobIdx + Math.Max(0, Math.Min(100, pi.Percent)) / 100.0) / jobTotal) * 100.0;
                                PushJson(new { type = "saveAsProgress", percent = (int)Math.Round(overall), detail = "[" + (jobIdx + 1) + "/" + jobTotal + "] " + itemName + " · " + Math.Round(pi.Percent) + "%" });
                            });
                        exported.Add(Path.GetFileName(outFile));
                    }
                }
            });

            PushJson(new {
                type = "saveAsResult",
                ok = true,
                outDir = outDir,
                files = exported.ToArray(),
                message = I18n.F("app.editorHost.saveAsSuccess", "count", exported.Count, "dir", outDir)
            });
        } catch (OperationCanceledException) {
            PushJson(new { type = "saveAsResult", ok = false, canceled = true, message = I18n.T("app.editorHost.saveAsCanceled") });
        } catch (Exception ex) {
            PushJson(new { type = "saveAsResult", ok = false, message = I18n.F("app.editorHost.saveAsFailed", "error", ex.Message) });
        }
    }

    // Non-activating real packaged-EXE WebView2 desktop smoke runner (never steals user focus or touches mouse/keyboard!)
    // Exercises the genuine EXE launch chain: unpack manifest -> load WebView2 -> verify native 3.2.1 UI ->
    // box-select + delete -> Overwrite Save (recipe only!) -> close -> reopen with saved recipe -> export PLY!
    internal static int RunDesktopSmokeCli(string[] args) {
        string inputPath = Path.GetFullPath(args[1]);
        string outDir = Path.GetFullPath(args[2]);
        string initialRecipePath = args.Length >= 4 ? Path.GetFullPath(args[3]) : null;
        Directory.CreateDirectory(outDir);
        string reportPath = Path.Combine(outDir, "desktop-smoke-report.json");
        var report = new Dictionary<string, object>();
        var json = SceneRecipe.CreateSerializer();

        try {
            I18n.Restore();
            Theme.Restore();
            TooltipConfig.Load();

            string writeErr;
            if (!PortablePaths.EnsureWritable(out writeErr)) throw new IOException(writeErr);
            string existingRecipe = (initialRecipePath != null && File.Exists(initialRecipePath))
                ? File.ReadAllText(initialRecipePath, Encoding.UTF8)
                : null;

            string sourceShaBefore = ComputeSourceFingerprint(inputPath);
            report["exePath"] = Assembly.GetExecutingAssembly().Location;
            report["portableDataDir"] = PortablePaths.DataDir;
            report["inputPath"] = inputPath;
            report["sourceShaBefore"] = sourceShaBefore;
            report["manifestVersion"] = EditorAssets.Version;
            report["manifestEditorKind"] = EditorAssets.EditorKind;
            report["manifestEntry"] = EditorAssets.Entry;
            report["manifestAssetsHash"] = EditorAssets.AssetsHash;
            report["legacyResplatExistsInRuntime"] = Directory.GetDirectories(
                Directory.Exists(PortablePaths.RuntimeDir) ? PortablePaths.RuntimeDir : PortablePaths.DataDir,
                "resplat", SearchOption.AllDirectories).Length > 0;

            // Session 1: Open asset -> verify native UI -> box-select -> soft-delete -> Overwrite Save (recipe) -> close
            string savedRecipe = null;
            Dictionary<string, object> s1 = RunSmokeSession(inputPath, existingRecipe, true, outDir, "session1", out savedRecipe);
            report["session1"] = s1;
            if (String.IsNullOrWhiteSpace(savedRecipe)) throw new IOException("Session 1 did not produce a saved recipe.");
            string recipeOutPath = Path.Combine(outDir, "saved-recipe.json");
            File.WriteAllText(recipeOutPath, savedRecipe, new UTF8Encoding(false));
            report["savedRecipePath"] = recipeOutPath;
            report["savedRecipeBytes"] = new FileInfo(recipeOutPath).Length;

            // Session 2: Close & Reopen with saved recipe -> verify deleted count & UI persisted accurately!
            string ignoredRecipe2;
            Dictionary<string, object> s2 = RunSmokeSession(inputPath, savedRecipe, false, outDir, "session2", out ignoredRecipe2);
            report["session2"] = s2;

            // Step 3: Export lossless PLY via real Converter + verify point count & source immutability
            string outPly = Path.Combine(outDir, "smoke-exported.ply");
            using (var conv = new Converter()) {
                conv.Prepare(CancellationToken.None);
                var inp = new InputFile(inputPath);
                inp.Ops.Add(new Op { Step = Step.Scene, Value = SceneRecipe.StoreIfLarge(savedRecipe), Enabled = true });
                var job = new Job {
                    Output = outPly,
                    Format = Converter.Formats.First(f => f.Suffix == ".ply"),
                    Overwrite = true,
                    BatchMode = false,
                    Keep = 100,
                    Device = "cpu",
                    Workers = 2
                };
                job.Inputs.Add(inp);
                var rep = conv.ConvertSingle(job, CancellationToken.None, s => { }, l => { }, p => { });
                report["exportPassed"] = rep.Passed;
                report["exportMessage"] = rep.Message;
                report["exportBytes"] = rep.ActualBytes;
                report["exportedPoints"] = rep.VerifiedSplatCount;
                report["exportedPlyPath"] = outPly;
                if (!rep.Passed) throw new IOException("Export verification failed: " + rep.Message);
            }

            string sourceShaAfter = ComputeSourceFingerprint(inputPath);
            report["sourceShaAfter"] = sourceShaAfter;
            report["sourceUnchanged"] = String.Equals(sourceShaBefore, sourceShaAfter, StringComparison.OrdinalIgnoreCase);

            int totalPts = Convert.ToInt32(s1["totalPoints"], CultureInfo.InvariantCulture);
            int delAfterEdit = Convert.ToInt32(s1["deletedAfterEdit"], CultureInfo.InvariantCulture);
            int delAfterReopen = Convert.ToInt32(s2["deletedOnOpen"], CultureInfo.InvariantCulture);
            long exportedPts = Convert.ToInt64(report["exportedPoints"], CultureInfo.InvariantCulture);

            if (delAfterEdit <= 0) throw new IOException("Expected box-select + delete to remove > 0 points.");
            if (delAfterReopen != delAfterEdit) throw new IOException("Reopen deleted count mismatch: " + delAfterReopen + " != " + delAfterEdit);
            if (exportedPts != totalPts - delAfterEdit) throw new IOException("Exported point count mismatch: " + exportedPts + " != " + (totalPts - delAfterEdit));
            if (!(bool)report["sourceUnchanged"]) throw new IOException("Source asset SHA-256 changed!");

            report["passed"] = true;
            File.WriteAllText(reportPath, json.Serialize(report), new UTF8Encoding(false));
            return 0;
        } catch (Exception ex) {
            report["passed"] = false;
            report["error"] = ex.ToString();
            try { File.WriteAllText(reportPath, json.Serialize(report), new UTF8Encoding(false)); } catch { }
            return 1;
        }
    }

    static Dictionary<string, object> RunSmokeSession(string inputPath, string existingRecipe, bool doEditAndSave, string outDir, string tag, out string savedRecipe) {
        savedRecipe = null;
        var res = new Dictionary<string, object>();
        var json = SceneRecipe.CreateSerializer();

        using (var dlg = new SceneEditorDialog(null, inputPath, null, existingRecipe, null, true)) {
            dlg.Show();
            var sw = Stopwatch.StartNew();
            while (!dlg.cloudLoadedTcs.Task.IsCompleted && sw.ElapsedMilliseconds < 90000) {
                Application.DoEvents();
                Thread.Sleep(20);
            }
            if (!dlg.cloudLoadedTcs.Task.IsCompleted) throw new TimeoutException(tag + ": SceneEditorDialog load timeout.");
            if (dlg.cloudLoadedTcs.Task.IsFaulted) throw dlg.cloudLoadedTcs.Task.Exception.InnerException;

            // Wait until WebGL2 cloud finishes mounting & rendering
            string readyRaw = null;
            string lastDiag = "";
            while (sw.ElapsedMilliseconds < 90000) {
                string r = EvalScriptBlocking(dlg.view, "(function(){var a=window.__SPLAT_EDITOR__; if(!a) return 'NO_API'; var st=a.getState(); return st && st.totalPoints>0 ? JSON.stringify({boot:a.getHostBootInfo(),state:st,stats:a.getCloudStats(),hasLeftRail:!!document.getElementById('left-rail'),hasTopMenus:!!document.getElementById('menu-advanced'),hasPcui:!!document.querySelector('.pcui-container,.pcui-overlay,#menu-bar-options'),hasSpinner:!!document.querySelector('.loading-spinner')}) : ('WAIT:' + JSON.stringify({tp:st?st.totalPoints:-1,stage:(document.getElementById('loading-stage')||{}).textContent||'',toast:(document.getElementById('toast-container')||{}).textContent||''}));})()");
                string un = UnwrapJsString(r);
                if (!String.IsNullOrEmpty(un) && un.StartsWith("{")) { readyRaw = un; break; }
                lastDiag = un ?? r;
                Application.DoEvents();
                Thread.Sleep(40);
            }
            if (String.IsNullOrEmpty(readyRaw)) throw new TimeoutException(tag + ": __SPLAT_EDITOR__ did not mount cloud. diag=" + lastDiag + " pushSent=" + dlg.PushSentCount + " pushErr=" + dlg.LastPushError + " note=" + dlg.note.Text);

            var info = json.Deserialize<Dictionary<string, object>>(readyRaw);
            var boot = info["boot"] as Dictionary<string, object>;
            var state = info["state"] as Dictionary<string, object>;
            var stats = info["stats"] as Dictionary<string, object>;

            bool hasLeftRail = Convert.ToBoolean(info["hasLeftRail"], CultureInfo.InvariantCulture);
            bool hasTopMenus = Convert.ToBoolean(info["hasTopMenus"], CultureInfo.InvariantCulture);
            bool hasPcui = Convert.ToBoolean(info["hasPcui"], CultureInfo.InvariantCulture);
            if (!hasLeftRail || !hasTopMenus || hasPcui) {
                throw new IOException(tag + ": Wrong UI loaded! hasLeftRail=" + hasLeftRail + " hasTopMenus=" + hasTopMenus + " hasPcui=" + hasPcui);
            }

            // Let 3 animation frames settle before capturing real WebView2 PNG preview
            for (int k = 0; k < 12; k++) { Application.DoEvents(); Thread.Sleep(25); }
            string shotPath = Path.Combine(outDir, "desktop_" + tag + ".png");
            CaptureWebViewPngBlocking(dlg.view, shotPath);

            res["loadedEntryUrl"] = dlg.LoadedEntryUrl;
            res["extractedAssetsDir"] = dlg.ExtractedAssetsDir;
            res["webviewCacheDir"] = dlg.ActiveWebViewCacheDir;
            res["boot"] = boot;
            res["hasLeftRail"] = hasLeftRail;
            res["hasTopMenus"] = hasTopMenus;
            res["hasPcui"] = hasPcui;
            res["hasSpinner"] = info["hasSpinner"];
            res["tooltipDelayMs"] = state["tooltipDelayMs"];
            res["displayMode"] = state["displayMode"];
            res["totalPoints"] = stats["n"];
            res["deletedOnOpen"] = stats["deleted"];
            res["screenshotPath"] = shotPath;
            res["loadElapsedMs"] = sw.ElapsedMilliseconds;

            if (doEditAndSave) {
                string editRaw = EvalScriptBlocking(dlg.view, "(function(){try{var a=window.__SPLAT_EDITOR__; a.triggerBoxSelect(-0.5, -0.5, 0.5, 0.5, 'replace'); var sel=a.getCloudStats().selected; a.softDeleteSelected(); var afterDel=a.getCloudStats().deleted; a.undo(); var afterUndo=a.getCloudStats().deleted; a.redo(); var afterRedo=a.getCloudStats().deleted; return JSON.stringify({ok:true, selected:sel, deletedAfterEdit:afterDel, deletedAfterUndo:afterUndo, deletedAfterRedo:afterRedo});}catch(e){return JSON.stringify({ok:false, error:String(e && (e.stack || e.message || e))});}})()");
                string editUnwrapped = UnwrapJsString(editRaw);
                if (String.IsNullOrEmpty(editUnwrapped)) throw new IOException(tag + ": edit script returned empty (" + editRaw + ")");
                var editDict = json.Deserialize<Dictionary<string, object>>(editUnwrapped);
                if (!Convert.ToBoolean(editDict["ok"], CultureInfo.InvariantCulture))
                    throw new IOException(tag + ": JS edit error: " + Convert.ToString(editDict["error"], CultureInfo.InvariantCulture));
                res["selectedCount"] = editDict["selected"];
                res["deletedAfterEdit"] = editDict["deletedAfterEdit"];
                res["deletedAfterUndo"] = editDict["deletedAfterUndo"];
                res["deletedAfterRedo"] = editDict["deletedAfterRedo"];

                // Trigger real Overwrite Save (posts "apply:<recipe>" which closes dlg asynchronously!)
                dlg.view.CoreWebView2.ExecuteScriptAsync("window.__SPLAT_EDITOR__.confirmOverwriteSaveNow()");
                var waitSave = Stopwatch.StartNew();
                while (dlg.Visible && waitSave.ElapsedMilliseconds < 15000) {
                    Application.DoEvents();
                    Thread.Sleep(20);
                }
                savedRecipe = dlg.Recipe;
            } else {
                dlg.Close();
            }
        }
        return res;
    }

    static string EvalScriptBlocking(WebView2 web, string script) {
        var task = web.CoreWebView2.ExecuteScriptAsync(script);
        var sw = Stopwatch.StartNew();
        while (!task.IsCompleted && sw.ElapsedMilliseconds < 20000) {
            Application.DoEvents();
            Thread.Sleep(10);
        }
        if (!task.IsCompleted) throw new TimeoutException("ExecuteScriptAsync timeout");
        return task.Result;
    }

    static string UnwrapJsString(string jsonEncodedString) {
        return new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.Deserialize<string>(jsonEncodedString);
    }

    static void CaptureWebViewPngBlocking(WebView2 web, string outPng) {
        using (var fs = File.Create(outPng)) {
            var task = web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
            var sw = Stopwatch.StartNew();
            while (!task.IsCompleted && sw.ElapsedMilliseconds < 15000) {
                Application.DoEvents();
                Thread.Sleep(15);
            }
            if (!task.IsCompleted) throw new TimeoutException("CapturePreviewAsync timeout");
        }
    }

    internal static Dictionary<string, object> VerifyRecipeReopenInWebView2(string inputPath, string recipeJson, string outDir) {
        string ignored;
        return RunSmokeSession(inputPath, recipeJson, false, outDir, "webview2_reopen", out ignored);
    }

    // Same-host real WinForms+WebView2 desktop benchmark worker (1520x900, 100% points, fixed +Y-up 360-deg trajectory).
    internal static Dictionary<string, object> RunWebView2BenchRun(
        string inputPath, string predecodedSgc3Path, int frameCount, int runIndex, string cacheCond, double externalDecodeSec)
    {
        var result = new Dictionary<string, object>();
        var json = SceneRecipe.CreateSerializer();
        var swTotal = Stopwatch.StartNew();

        using (var dlg = new SceneEditorDialog(null, inputPath, null, null, null, true, predecodedSgc3Path)) {
            dlg.Show();
            var swLoad = Stopwatch.StartNew();
            while (!dlg.cloudLoadedTcs.Task.IsCompleted && swLoad.ElapsedMilliseconds < 240000) {
                Application.DoEvents();
                Thread.Sleep(20);
            }
            if (!dlg.cloudLoadedTcs.Task.IsCompleted) throw new TimeoutException("WebView2 bench load timeout.");
            if (dlg.cloudLoadedTcs.Task.IsFaulted) throw dlg.cloudLoadedTcs.Task.Exception.InnerException;

            var swMount = Stopwatch.StartNew();
            string readyRaw = null;
            while (swLoad.ElapsedMilliseconds < 240000) {
                string r = EvalScriptBlocking(dlg.view, "(function(){var a=window.__SPLAT_EDITOR__; if(!a) return 'null'; var st=a.getState(); return st && st.totalPoints>0 ? JSON.stringify({state:st,perf:a.getPerfStats(),boot:a.getHostBootInfo()}) : 'null';})()");
                if (!String.IsNullOrEmpty(r) && r != "null" && r != "\"null\"") { readyRaw = UnwrapJsString(r); break; }
                Application.DoEvents();
                Thread.Sleep(40);
            }
            if (String.IsNullOrEmpty(readyRaw)) throw new TimeoutException("WebView2 bench cloud mount timeout.");
            double mountSec = Math.Round(swMount.Elapsed.TotalSeconds, 3);
            double decodeSec = externalDecodeSec > 0 ? Math.Round(externalDecodeSec, 3) : dlg.LastDecodeSec;

            // Settle 4 frames
            for (int k = 0; k < 15; k++) { Application.DoEvents(); Thread.Sleep(30); }

            var initInfo = json.Deserialize<Dictionary<string, object>>(readyRaw);
            var initPerf = initInfo["perf"] as Dictionary<string, object>;
            var initBoot = initInfo["boot"] as Dictionary<string, object>;
            var tgtArr = initPerf["cameraTarget"] as ArrayList;
            double cx = tgtArr != null && tgtArr.Count >= 3 ? Convert.ToDouble(tgtArr[0], CultureInfo.InvariantCulture) : 0.0;
            double cy = tgtArr != null && tgtArr.Count >= 3 ? Convert.ToDouble(tgtArr[1], CultureInfo.InvariantCulture) : 0.0;
            double cz = tgtArr != null && tgtArr.Count >= 3 ? Convert.ToDouble(tgtArr[2], CultureInfo.InvariantCulture) : 0.0;
            double radius = Math.Max(0.5, Convert.ToDouble(initPerf["sceneRadius"], CultureInfo.InvariantCulture));
            double orbitDist = Math.Max(1.0, radius * 2.2);

            // Run identical 120-frame +Y-up 360-deg orbit pass in Splat AND Centers mode via async JS benchmark harness
            string benchJsTemplate = @"(function(mode, frames, cx, cy, cz, dist){
  window.__BENCH_DONE__ = null;
  (async function(){
    try {
      var api = window.__SPLAT_EDITOR__;
      api.setDisplayMode(mode);
      await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });
      for (var w = 0; w < 4; w++) {
        var wa = (w / 4.0) * 0.2;
        api.setCameraPose([cx + Math.cos(wa)*dist, cy + 0.25*dist, cz + Math.sin(wa)*dist], [cx, cy, cz]);
        await new Promise(function(r){ requestAnimationFrame(r); });
      }
      var frameMs = [], sortMs = [], rasterMs = [], waitMs = [];
      var prevSortCount = api.getPerfStats().sortCompletedCount || 0;
      var prevT = performance.now();
      for (var i = 0; i < frames; i++) {
        var ang = (i / frames) * Math.PI * 2.0;
        var elev = 0.25 + 0.12 * Math.sin(ang);
        var px = cx + Math.cos(ang) * Math.cos(elev) * dist;
        var py = cy + Math.sin(elev) * dist;
        var pz = cz + Math.sin(ang) * Math.cos(elev) * dist;
        var tSet0 = performance.now();
        api.setCameraPose([px, py, pz], [cx, cy, cz]);
        var tSetEnd = performance.now();
        await new Promise(function(r){ requestAnimationFrame(r); });
        var now = performance.now();
        var dt = now - prevT;
        prevT = now;
        var pf = api.getPerfStats();
        var rMs = pf.lastRenderCostMs || (tSetEnd - tSet0);
        var sCount = pf.sortCompletedCount || 0;
        var sMs = (sCount > prevSortCount) ? ((pf.lastSortMs || 0) + (pf.lastSortUploadMs || 0)) : 0;
        prevSortCount = sCount;
        var wMs = Math.max(0, dt - rMs);
        frameMs.push(Number(dt.toFixed(2)));
        sortMs.push(Number(sMs.toFixed(2)));
        rasterMs.push(Number(rMs.toFixed(2)));
        waitMs.push(Number(wMs.toFixed(2)));
      }
      var endPf = api.getPerfStats();
      var gl = document.getElementById('canvas').getContext('webgl2');
      window.__BENCH_DONE__ = JSON.stringify({
        ok: true,
        frameMs: frameMs,
        sortMs: sortMs,
        rasterMs: rasterMs,
        waitMs: waitMs,
        drawnInstances: endPf.drawnInstances,
        totalPoints: endPf.totalPoints,
        glErr: gl ? gl.getError() : -1
      });
    } catch (e) {
      window.__BENCH_DONE__ = JSON.stringify({ ok: false, error: String(e && (e.stack || e.message || e)) });
    }
  })();
  return 'started';
})";

            Func<string, Dictionary<string, object>> runOrbit = modeName => {
                string invoke = string.Format(
                    CultureInfo.InvariantCulture,
                    "({0})('{1}', {2}, {3:R}, {4:R}, {5:R}, {6:R})",
                    benchJsTemplate, modeName, frameCount, cx, cy, cz, orbitDist);
                EvalScriptBlocking(dlg.view, invoke);
                var swPass = Stopwatch.StartNew();
                string doneRaw = null;
                while (swPass.ElapsedMilliseconds < 360000) {
                    string poll = EvalScriptBlocking(dlg.view, "window.__BENCH_DONE__ || ''");
                    string un = UnwrapJsString(poll);
                    if (!String.IsNullOrEmpty(un)) { doneRaw = un; break; }
                    Application.DoEvents();
                    Thread.Sleep(25);
                }
                if (String.IsNullOrEmpty(doneRaw)) throw new TimeoutException("WebView2 orbit pass timeout: " + modeName);
                var d = json.Deserialize<Dictionary<string, object>>(doneRaw);
                if (!Convert.ToBoolean(d["ok"], CultureInfo.InvariantCulture))
                    throw new IOException("WebView2 orbit error: " + Convert.ToString(d["error"], CultureInfo.InvariantCulture));
                return d;
            };

            var splatRaw = runOrbit("splat");
            int? vramPeakSplat = NativeViewportDialog.QueryNvidiaVramMiB();
            double? rssPeak = NativeViewportDialog.QueryProcessTreeRssMiB(Process.GetCurrentProcess().Id);
            var centersRaw = runOrbit("centers");
            int? vramPeakCenters = NativeViewportDialog.QueryNvidiaVramMiB();

            // Gesture latencies: box-select, soft-delete, undo-delete, undo-select
            string gestJs = @"(function(){
  window.__GEST_DONE__ = null;
  (async function(){
    try {
      var api = window.__SPLAT_EDITOR__;
      api.setDisplayMode('splat');
      await new Promise(function(r){ requestAnimationFrame(r); });
      if (api.resetSyncTelemetry) api.resetSyncTelemetry();
      var t0 = performance.now();
      api.triggerBoxSelect(-0.24, -0.24, 0.24, 0.24, 'replace');
      await new Promise(function(r){ requestAnimationFrame(r); });
      var boxMs = Number((performance.now() - t0).toFixed(2));
      var selCount = api.getCloudStats().selected;
      var t1 = performance.now();
      api.softDeleteSelected();
      await new Promise(function(r){ requestAnimationFrame(r); });
      var delMs = Number((performance.now() - t1).toFixed(2));
      var t2 = performance.now();
      api.undo();
      await new Promise(function(r){ requestAnimationFrame(r); });
      var undoDelMs = Number((performance.now() - t2).toFixed(2));
      var t3 = performance.now();
      api.undo();
      await new Promise(function(r){ requestAnimationFrame(r); });
      var undoSelMs = Number((performance.now() - t3).toFixed(2));
      window.__GEST_DONE__ = JSON.stringify({
        ok: true,
        boxSelectMs: boxMs,
        softDeleteMs: delMs,
        undoDeleteMs: undoDelMs,
        undoSelectMs: undoSelMs,
        selectedCount: selCount,
        syncTelemetry: api.getSyncTelemetry ? api.getSyncTelemetry() : null
      });
    } catch (e) {
      window.__GEST_DONE__ = JSON.stringify({ ok: false, error: String(e && (e.stack || e.message || e)) });
    }
  })();
  return 'started';
})()";
            EvalScriptBlocking(dlg.view, gestJs);
            var swG = Stopwatch.StartNew();
            string gestRaw = null;
            while (swG.ElapsedMilliseconds < 60000) {
                string poll = EvalScriptBlocking(dlg.view, "window.__GEST_DONE__ || ''");
                string un = UnwrapJsString(poll);
                if (!String.IsNullOrEmpty(un)) { gestRaw = un; break; }
                Application.DoEvents();
                Thread.Sleep(25);
            }
            var gest = String.IsNullOrEmpty(gestRaw)
                ? new Dictionary<string, object>()
                : json.Deserialize<Dictionary<string, object>>(gestRaw);

            result["backend"] = "webview2-webgl2";
            result["hostMode"] = "real-desktop-winforms-webview2";
            result["run"] = runIndex;
            result["cacheCondition"] = cacheCond;
            result["resolution"] = "1520x900";
            result["shDegree"] = 0;
            result["downsampleMode"] = "none (100% full points)";
            result["sortBackend"] = "cpu-webworker-16bit-counting";
            result["frames"] = frameCount;
            result["cameraTarget"] = new double[] { cx, cy, cz };
            result["orbitDistance"] = Math.Round(orbitDist, 4);
            result["decodeSec"] = decodeSec;
            result["mountSec"] = mountSec;
            result["firstEditableSec"] = Math.Round(decodeSec + mountSec, 3);
            result["fullSplat"] = NativeViewportDialog.SummarizeBenchPass(splatRaw);
            result["centersMode"] = NativeViewportDialog.SummarizeBenchPass(centersRaw);
            result["gestures"] = gest;
            result["processTreeRssPeakMiB"] = rssPeak;
            result["vramPeakMiB"] = Math.Max(vramPeakSplat ?? 0, vramPeakCenters ?? 0);
            result["boot"] = initBoot;
            result["totalWallSec"] = Math.Round(swTotal.Elapsed.TotalSeconds, 3);

            dlg.Close();
        }
        return result;
    }
}
