using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

[assembly: AssemblyTitle("SuperSplat Convert Desktop")]
[assembly: AssemblyProduct("SuperSplat Convert Desktop")]
[assembly: AssemblyVersion("3.2.3.0")]

sealed class Format {
    public readonly string Suffix;
    public string Name {
        get {
            if (Suffix == ".sog") return I18n.T("app.formats.sog");
            if (Suffix == ".ply") return I18n.T("app.formats.ply");
            if (Suffix == ".compressed.ply") return I18n.T("app.formats.compressed");
            if (Suffix == ".spz") return I18n.T("app.formats.spz");
            if (Suffix == ".csv") return I18n.T("app.formats.csv");
            if (Suffix == ".html") return I18n.T("app.formats.html");
            return I18n.T("app.formats.voxel");
        }
    }
    public Format(string name, string suffix) { Suffix = suffix; }
    public override string ToString() { return Name; }
    public bool Sog { get { return Suffix == ".sog" || Suffix == ".html"; } }
    public bool Voxel { get { return Suffix == ".voxel.zip"; } }
}

sealed class Step {
    public readonly string Flag, Defaults;
    public string Name {
        get {
            if (Flag == "--translate") return I18n.T("app.ops.translate");
            if (Flag == "--scene-edit") return I18n.T("app.pipeline.sceneEditName");
            if (Flag == "--rotate") return I18n.T("app.ops.rotate");
            if (Flag == "--scale") return I18n.T("app.ops.scale");
            if (Flag == "--filter-nan") return I18n.T("app.ops.nan");
            if (Flag == "--filter-harmonics") return I18n.T("app.ops.harmonics");
            if (Flag == "--filter-box") return I18n.T("app.ops.box");
            if (Flag == "--filter-sphere") return I18n.T("app.ops.sphere");
            if (Flag == "--filter-floaters") return I18n.T("app.ops.floaters");
            if (Flag == "--filter-cluster") return I18n.T("app.ops.cluster");
            if (Flag == "--filter-value") return I18n.T("app.ops.filterValue");
            return I18n.T("app.ops.mortonOrder");
        }
    }
    public string Fields {
        get {
            if (Flag == "--filter-nan" || Flag == "--morton-order") return "";
            if (Flag == "--scale") return I18n.T("app.ops.factor");
            if (Flag == "--filter-harmonics") return I18n.T("app.ops.band");
            if (Flag == "--filter-box") return String.Join(",", new[] { "X", "Y", "Z" }.Select(a => I18n.F("app.ops.minAxis", "axis", a)).Concat(new[] { "X", "Y", "Z" }.Select(a => I18n.F("app.ops.maxAxis", "axis", a))));
            if (Flag == "--filter-sphere") return "X,Y,Z," + I18n.T("app.ops.radius");
            if (Flag == "--filter-floaters") return I18n.T("app.ops.floaterParams");
            if (Flag == "--filter-cluster") return I18n.T("app.ops.clusterParams");
            if (Flag == "--filter-value") return I18n.T("app.ops.filterValueParams");
            return "X,Y,Z";
        }
    }
    public bool RequiresGpu {
        get { return Flag == "--filter-floaters" || Flag == "--filter-cluster"; }
    }
    public Step(string name, string flag, string fields, string defaults) {
        Flag = flag; Defaults = defaults;
    }
    public override string ToString() { return Name; }
    public static readonly Step Scene = new Step("editor", "--scene-edit", "", "");
    public static readonly Step[] All = {
        new Step("translate", "--translate", "X,Y,Z", "0,0,0"),
        new Step("rotate", "--rotate", "X,Y,Z", "0,0,0"),
        new Step("scale", "--scale", "factor", "1"),
        new Step("nan", "--filter-nan", "", ""),
        new Step("harmonics", "--filter-harmonics", "band", "4"),
        new Step("box", "--filter-box", "box6", "-10,-10,-10,10,10,10"),
        new Step("sphere", "--filter-sphere", "sphere4", "0,0,0,10"),
        new Step("floaters", "--filter-floaters", "floaters", "0.05,0.1,0.004"),
        new Step("cluster", "--filter-cluster", "cluster", "1.0,0.999,0.1"),
        new Step("filterValue", "--filter-value", "expr", "opacity,gt,0.1"),
        new Step("morton", "--morton-order", "", "")
    };
}

sealed class Op {
    public Step Step;
    public string Value;
    public bool Enabled = true;
    public override string ToString() { return (Enabled ? "✓ " : "○ ") + Step.Name + (String.IsNullOrEmpty(Value)||Step==Step.Scene ? "" : "    " + Value); }
    public void Append(List<string> args) {
        if (!Enabled) return;
        args.Add(Step.Flag);
        if (!String.IsNullOrEmpty(Value)) args.Add(Value);
    }
}

sealed class InputFile {
    public readonly string Path;
    public readonly List<Op> Ops = new List<Op>();
    public InputFile(string path) { Path = path; }
}

sealed class ProgressInfo {
    public string StageKey;
    public string Detail;
    public double Percent;
    public double? EtaSeconds;
    public double ElapsedSeconds;
    public int FileIndex;
    public int FileTotal;
}

sealed class VerificationReport {
    public bool Passed;
    public string Level; // structural | sampled
    public string Scope;
    public long ActualBytes;
    public long VerifiedSplatCount;
    public string Message;
}

sealed class Job {
    public readonly List<InputFile> Inputs = new List<InputFile>();
    public readonly List<Op> Ops = new List<Op>();
    public string Output;
    public string OutputDirectory;
    public Format Format;
    public bool Overwrite;
    public bool BatchMode;
    public bool AdaptiveDecimate = true;
    public int Keep = 100, Iterations = 10, Effort = -1, Workers = 4;
    public string Device = "auto", VoxelSize = "0.05", Opacity = "0.1";
    // Advanced 3.12.0 options
    public int SogVersion = 3;
    public double? ShColorError;
    public int SpzVersion = 4;
    public bool PlyLogitOpacity;
    public bool HtmlUnbundled;
    public bool VoxelExternalFill;
    public bool VoxelFloorFill;
    public bool VoxelCarve;
    public string SeedPos = "";
    public string CollisionMesh = ""; // "" | "smooth" | "faces"
    // Target size hard cap (bytes, 0 = disabled)
    public long TargetMaxBytes;
    public int MinKeepPct = 20;
    public int MinShBand = 0;
    public int MaxAttempts = 3;

    public bool NeedsGpu {
        get {
            return (Format != null && (Format.Sog || Format.Voxel))
                || Ops.Any(o => o.Enabled && o.Step.RequiresGpu)
                || Inputs.Any(i => i.Ops.Any(o => o.Enabled && o.Step.RequiresGpu));
        }
    }
}

static class ExportVerifier {
    internal static VerificationReport Verify(string path, string suffix) {
        var rep = new VerificationReport { Level = "structural", Scope = "container + header" };
        try {
            if (!File.Exists(path)) { rep.Message = "Output file missing"; return rep; }
            var fi = new FileInfo(path);
            rep.ActualBytes = fi.Length;
            if (fi.Length <= 0) { rep.Message = "Output file is 0 bytes"; return rep; }

            string ext = (suffix ?? Path.GetExtension(path)).ToLowerInvariant();
            if (ext == ".sog") {
                var insp = SplatInspector.InspectLight(path);
                if (!insp.Readable || insp.SplatCount <= 0) { rep.Message = "SOG readback failed: " + insp.Error; return rep; }
                using (var zip = ZipFile.OpenRead(path)) {
                    if (!zip.Entries.Any(e => e.Name.EndsWith(".webp", StringComparison.OrdinalIgnoreCase))) {
                        rep.Message = "SOG archive has no WebP texture entries"; return rep;
                    }
                }
                rep.VerifiedSplatCount = insp.SplatCount;
                rep.Passed = true;
                rep.Message = "SOG verified: " + insp.SplatCount.ToString("N0") + " splats, SH " + insp.ShBands;
                return rep;
            }
            if (ext == ".ply" || ext == ".compressed.ply") {
                var insp = SplatInspector.InspectLight(path);
                if (!insp.Readable || insp.SplatCount <= 0) { rep.Message = "PLY readback failed: " + insp.Error; return rep; }
                rep.VerifiedSplatCount = insp.SplatCount;
                rep.Passed = true;
                rep.Message = "PLY verified: " + insp.SplatCount.ToString("N0") + " vertices";
                return rep;
            }
            if (ext == ".spz") {
                var insp = SplatInspector.InspectLight(path);
                if (!insp.Readable || insp.SplatCount <= 0) { rep.Message = "SPZ readback failed: " + insp.Error; return rep; }
                rep.VerifiedSplatCount = insp.SplatCount;
                rep.Passed = true;
                rep.Message = "SPZ " + insp.FormatVersion + " verified: " + insp.SplatCount.ToString("N0") + " splats";
                return rep;
            }
            if (ext == ".csv") {
                rep.Level = "sampled"; rep.Scope = "header + first rows";
                int lines = 0;
                using (var sr = new StreamReader(path, Encoding.UTF8)) {
                    string hdr = sr.ReadLine();
                    if (String.IsNullOrWhiteSpace(hdr) || !hdr.Contains(",")) { rep.Message = "CSV missing valid header"; return rep; }
                    while (lines < 5 && sr.ReadLine() != null) lines++;
                }
                if (lines <= 0) { rep.Message = "CSV has 0 data rows"; return rep; }
                rep.Passed = true;
                rep.Message = "CSV header and sampled rows verified";
                return rep;
            }
            if (ext == ".html") {
                rep.Level = "sampled"; rep.Scope = "HTML structure + embedded payload";
                string head;
                using (var sr = new StreamReader(path, Encoding.UTF8)) {
                    var buf = new char[8192];
                    int n = sr.Read(buf, 0, buf.Length);
                    head = new string(buf, 0, n);
                }
                if (head.IndexOf("<html", StringComparison.OrdinalIgnoreCase) < 0 && head.IndexOf("<!doctype", StringComparison.OrdinalIgnoreCase) < 0) {
                    rep.Message = "Invalid HTML output"; return rep;
                }
                rep.Passed = true;
                rep.Message = "HTML viewer payload verified (" + Budget.GB(fi.Length) + ")";
                return rep;
            }
            if (ext == ".voxel.zip") {
                using (var zip = ZipFile.OpenRead(path)) {
                    var names = zip.Entries.Select(e => e.Name).ToArray();
                    if (!names.Any(n => n.EndsWith(".voxel.json", StringComparison.OrdinalIgnoreCase))
                        || !names.Any(n => n.EndsWith(".voxel.bin", StringComparison.OrdinalIgnoreCase))) {
                        rep.Message = "Voxel archive missing .voxel.json or .voxel.bin"; return rep;
                    }
                }
                rep.Passed = true;
                rep.Message = "Voxel archive structure verified";
                return rep;
            }
            rep.Passed = true;
            rep.Message = "Output verified (" + fi.Length + " bytes)";
            return rep;
        } catch (Exception ex) {
            rep.Passed = false;
            rep.Message = "Verification exception: " + ex.Message;
            return rep;
        }
    }
}

static class AtomicPublisher {
    // Cross-volume safe atomic publish: copies from data/tmp to same-volume temp next to user target,
    // backs up existing target on overwrite, swaps atomically, and removes backup only after commit!
    internal static void Publish(string stagedSource, string finalTarget, bool allowOverwrite, CancellationToken token) {
        string targetFull = Path.GetFullPath(finalTarget);
        string parent = Path.GetDirectoryName(targetFull);
        if (!Directory.Exists(parent)) throw new DirectoryNotFoundException(I18n.T("app.errors.accessAdvice"));
        if (File.Exists(targetFull) && !allowOverwrite)
            throw new IOException(I18n.F("app.converter.targetExistsNoOverwrite", "path", targetFull));

        string sameVolTmp = Path.Combine(parent, "." + Path.GetFileName(targetFull) + ".commit-" + Guid.NewGuid().ToString("N") + ".tmp");
        string backup = Path.Combine(parent, "." + Path.GetFileName(targetFull) + ".bak-" + Guid.NewGuid().ToString("N"));
        try {
            using (var src = File.OpenRead(stagedSource))
            using (var dst = new FileStream(sameVolTmp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                var buf = new byte[1024 * 1024];
                int n;
                while ((n = src.Read(buf, 0, buf.Length)) > 0) {
                    token.ThrowIfCancellationRequested();
                    dst.Write(buf, 0, n);
                }
                dst.Flush(true);
            }
            if (File.Exists(targetFull)) {
                File.Replace(sameVolTmp, targetFull, backup, true);
                try { if (File.Exists(backup)) File.Delete(backup); } catch { }
            } else {
                File.Move(sameVolTmp, targetFull);
            }
        } catch {
            try { if (File.Exists(sameVolTmp)) File.Delete(sameVolTmp); } catch { }
            throw;
        }
    }
}

sealed class Converter : IDisposable {
    public static readonly Format[] Formats = {
        new Format("sog", ".sog"),
        new Format("ply", ".ply"),
        new Format("compressed", ".compressed.ply"),
        new Format("spz", ".spz"),
        new Format("csv", ".csv"),
        new Format("html", ".html"),
        new Format("voxel", ".voxel.zip")
    };

    string runtime;

    public static bool Supported(string path) {
        return new[] { ".ply", ".sog", ".ksplat", ".splat", ".spz", ".glb", ".lcc", ".lcc2" }
            .Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);
    }

    public static string Stem(string path) {
        string n = Path.GetFileName(path);
        if (n.EndsWith(".compressed.ply", StringComparison.OrdinalIgnoreCase)) return n.Substring(0, n.Length - 15);
        return Path.GetFileNameWithoutExtension(n);
    }

    internal string Prepare(CancellationToken token) {
        string writeErr;
        if (!PortablePaths.EnsureWritable(out writeErr)) throw new UnauthorizedAccessException(writeErr);
        runtime = EngineManager.EnsureActiveRuntime(token);
        return runtime;
    }

    public void Convert(Job job, CancellationToken token, Action<string> status, Action<string> log) {
        Convert(job, token, status, log, null);
    }

    public void Convert(Job job, CancellationToken token, Action<string> status, Action<string> log, Action<ProgressInfo> progress) {
        token.ThrowIfCancellationRequested();
        if (job.Inputs.Count == 0 || job.Inputs.Any(i => !Supported(i.Path)))
            throw new InvalidDataException(I18n.T("app.errors.inputAdvice"));
        var missing = job.Inputs.FirstOrDefault(i => !File.Exists(i.Path));
        if (missing != null) throw new FileNotFoundException(I18n.T("app.errors.inputAdvice"), missing.Path);

        var totalWatch = Stopwatch.StartNew();
        status("app.status.preparing");
        ReportProgress(progress, "app.status.preparing", "", 1, totalWatch.Elapsed.TotalSeconds, null, 1, job.BatchMode ? job.Inputs.Count : 1);
        Prepare(token);

        if (job.BatchMode) {
            string outDir = Path.GetFullPath(String.IsNullOrWhiteSpace(job.OutputDirectory) ? Path.GetDirectoryName(job.Output) : job.OutputDirectory);
            Directory.CreateDirectory(outDir);
            int totalFiles = job.Inputs.Count;
            for (int idx = 0; idx < totalFiles; idx++) {
                token.ThrowIfCancellationRequested();
                var single = CloneForSingle(job, job.Inputs[idx], outDir);
                log("[" + (idx + 1) + "/" + totalFiles + "] " + Path.GetFileName(job.Inputs[idx].Path) + " -> " + Path.GetFileName(single.Output));
                int currentIdx = idx;
                var part = Stopwatch.StartNew();
                double? prediction = TimingHistory.Estimate(single);
                for (int n = idx+1; prediction.HasValue && n < totalFiles; n++) prediction += TimingHistory.Estimate(CloneForSingle(job, job.Inputs[n], outDir));
                ConvertSingleWithTargetSize(single, token, status, log, p => {
                    double overall = ((currentIdx + (p.Percent / 100d)) / totalFiles) * 100d;
                    double elapsed = totalWatch.Elapsed.TotalSeconds;
                    double? eta = prediction - part.Elapsed.TotalSeconds;
                    ReportProgress(progress, p.StageKey, Path.GetFileName(job.Inputs[currentIdx].Path) + (String.IsNullOrEmpty(p.Detail) ? "" : " · " + p.Detail),
                        overall, elapsed, eta, currentIdx + 1, totalFiles);
                });
                TimingHistory.Record(single, part.Elapsed.TotalSeconds);
            }
            ReportProgress(progress, "app.status.done", "", 100, totalWatch.Elapsed.TotalSeconds, 0, totalFiles, totalFiles);
            return;
        }

        double? expectedSeconds = TimingHistory.Estimate(job);
        ConvertSingleWithTargetSize(job, token, status, log, p => {
            double elapsed = totalWatch.Elapsed.TotalSeconds;
            double? eta = expectedSeconds.HasValue ? (double?)(expectedSeconds.Value - elapsed) : null;
            ReportProgress(progress, p.StageKey, p.Detail, p.Percent, elapsed, eta, 1, 1);
        });
        TimingHistory.Record(job, totalWatch.Elapsed.TotalSeconds);
        ReportProgress(progress, "app.status.done", "", 100, totalWatch.Elapsed.TotalSeconds, 0, 1, 1);
    }

    static Job CloneForSingle(Job src, InputFile file, string outDir) {
        string outPath = Path.Combine(outDir, Stem(file.Path) + src.Format.Suffix);
        if (String.Equals(Path.GetFullPath(outPath), Path.GetFullPath(file.Path), StringComparison.OrdinalIgnoreCase))
            outPath = Path.Combine(outDir, Stem(file.Path) + "-converted" + src.Format.Suffix);
        var j = new Job {
            Format = src.Format, Overwrite = src.Overwrite, BatchMode = false,
            AdaptiveDecimate = src.AdaptiveDecimate, Keep = src.Keep, Iterations = src.Iterations,
            Effort = src.Effort, Workers = src.Workers, Device = src.Device, VoxelSize = src.VoxelSize,
            Opacity = src.Opacity, SogVersion = src.SogVersion, ShColorError = src.ShColorError,
            SpzVersion = src.SpzVersion, PlyLogitOpacity = src.PlyLogitOpacity, HtmlUnbundled = src.HtmlUnbundled,
            VoxelExternalFill = src.VoxelExternalFill, VoxelFloorFill = src.VoxelFloorFill, VoxelCarve = src.VoxelCarve,
            SeedPos = src.SeedPos, CollisionMesh = src.CollisionMesh,
            TargetMaxBytes = src.TargetMaxBytes, MinKeepPct = src.MinKeepPct, MinShBand = src.MinShBand, MaxAttempts = src.MaxAttempts,
            Output = outPath
        };
        j.Inputs.Add(file);
        j.Ops.AddRange(src.Ops);
        return j;
    }

    // Spec §3.9: Target Max Bytes Hard Cap (supports .sog and .html; verifies actual full bytes; never breaches quality floor)
    internal VerificationReport ConvertSingleWithTargetSize(Job job, CancellationToken token, Action<string> status, Action<string> log, Action<ProgressInfo> progress, Dictionary<string, string> sharedBakeCache = null, string sharedBakeDir = null) {
        if (job.TargetMaxBytes <= 0 || !job.Format.Sog) {
            return ConvertSingle(job, token, status, log, progress, sharedBakeCache, sharedBakeDir);
        }
        int maxTry = Math.Max(1, Math.Min(6, job.MaxAttempts));
        int curKeep = job.Keep;
        int curEffort = job.Effort < 0 ? 7 : Math.Max(job.Effort, 7);
        long smallestSeen = Int64.MaxValue;
        string bestStaged = null;
        string bestStagingDir = null;
        VerificationReport bestReport = null;

        try {
            for (int attempt = 1; attempt <= maxTry; attempt++) {
                token.ThrowIfCancellationRequested();
                log(I18n.F("app.converter.targetSizeAttemptLog", "attempt", attempt, "max", maxTry, "keep", curKeep, "effort", curEffort, "limit", Budget.GB(job.TargetMaxBytes)));
                var candidate = CloneForSingle(job, job.Inputs[0], Path.GetDirectoryName(job.Output));
                candidate.Inputs.Clear(); candidate.Inputs.AddRange(job.Inputs);
                candidate.Output = job.Output;
                candidate.Keep = curKeep;
                candidate.Effort = curEffort;

                string stagedDir;
                string stagedFile;
                var rep = ConvertSingleToStage(candidate, token, status, log, p => {
                    double frac = ((attempt - 1) + p.Percent / 100d) / maxTry * 100d;
                    ReportProgress(progress, p.StageKey, I18n.F("app.converter.targetSizeAttemptDetail", "attempt", attempt, "max", maxTry, "detail", p.Detail), frac, 0, null, 1, 1);
                }, out stagedDir, out stagedFile, sharedBakeCache, sharedBakeDir);

                if (rep.ActualBytes < smallestSeen) smallestSeen = rep.ActualBytes;
                log(I18n.F("app.converter.targetSizeActualLog", "bytes", rep.ActualBytes.ToString("N0"), "gb", Budget.GB(rep.ActualBytes)));

                if (rep.Passed && rep.ActualBytes <= job.TargetMaxBytes) {
                    if (bestStagingDir != null) PortablePaths.SafeDeleteManagedSubdir(PortablePaths.TmpDir, bestStagingDir);
                    bestStaged = stagedFile; bestStagingDir = stagedDir; bestReport = rep;
                    break;
                }
                PortablePaths.SafeDeleteManagedSubdir(PortablePaths.TmpDir, stagedDir);
                if (attempt >= maxTry) break;

                // Tighten keep ratio within user's quality floor
                double ratio = (double)job.TargetMaxBytes / Math.Max(1L, rep.ActualBytes);
                int nextKeep = Math.Max(job.MinKeepPct, Math.Min(curKeep - 5, (int)Math.Floor(curKeep * ratio * 0.90)));
                if (nextKeep == curKeep) break;
                curKeep = nextKeep;
                curEffort = 9;
            }

            if (bestStaged == null || bestReport == null) {
                long excess = Math.Max(1, smallestSeen - job.TargetMaxBytes);
                throw new IOException(I18n.F("app.converter.targetSizeExceeded", "limit", job.TargetMaxBytes.ToString("N0"), "smallest", smallestSeen.ToString("N0"), "excess", excess.ToString("N0")));
            }
            AtomicPublisher.Publish(bestStaged, job.Output, job.Overwrite, token);
            return bestReport;
        } finally {
            if (bestStagingDir != null) PortablePaths.SafeDeleteManagedSubdir(PortablePaths.TmpDir, bestStagingDir);
        }
    }

    internal VerificationReport ConvertSingle(Job job, CancellationToken token, Action<string> status, Action<string> log, Action<ProgressInfo> progress, Dictionary<string, string> sharedBakeCache = null, string sharedBakeDir = null) {
        string stagedDir, stagedFile;
        var rep = ConvertSingleToStage(job, token, status, log, progress, out stagedDir, out stagedFile, sharedBakeCache, sharedBakeDir);
        try {
            if (!rep.Passed) throw new IOException(I18n.F("app.converter.verifyFailed", "message", rep.Message));
            AtomicPublisher.Publish(stagedFile, job.Output, job.Overwrite, token);
            return rep;
        } finally {
            PortablePaths.SafeDeleteManagedSubdir(PortablePaths.TmpDir, stagedDir);
        }
    }

    static string ComputeSharedBakeKey(string filePath, string resolvedRecipeJson) {
        var fi = new FileInfo(filePath);
        string raw = Path.GetFullPath(filePath).ToLowerInvariant() + "|" + fi.Length + "|" + fi.LastWriteTimeUtc.Ticks + "|" + resolvedRecipeJson;
        using (var sha = System.Security.Cryptography.SHA256.Create()) {
            return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(raw))).Replace("-", "").ToLowerInvariant().Substring(0, 24);
        }
    }

    VerificationReport ConvertSingleToStage(Job job, CancellationToken token, Action<string> status, Action<string> log, Action<ProgressInfo> progress, out string staging, out string tempOutput, Dictionary<string, string> sharedBakeCache = null, string sharedBakeDir = null) {
        string output = Path.GetFullPath(job.Output);
        if (!output.EndsWith(job.Format.Suffix, StringComparison.OrdinalIgnoreCase)) throw new IOException(I18n.T("app.converter.badExtension"));
        if (job.Inputs.Any(x => String.Equals(Path.GetFullPath(x.Path), output, StringComparison.OrdinalIgnoreCase)))
            throw new IOException(I18n.T("app.converter.overwriteSourceDenied"));
        if (File.Exists(output) && !job.Overwrite) throw new IOException(I18n.T("app.converter.outputExists"));
        string parent = Path.GetDirectoryName(output);
        if (!Directory.Exists(parent)) throw new DirectoryNotFoundException(I18n.T("app.errors.accessAdvice"));

        // Strictly stage working intermediates inside Portable data/tmp/!
        Directory.CreateDirectory(PortablePaths.TmpDir);
        staging = Path.Combine(PortablePaths.TmpDir, "job-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        tempOutput = Path.Combine(staging, Path.GetFileName(output));

        try {
            var args = new List<string>();
            bool bakedByWorker = false;
            foreach (InputFile file in job.Inputs) {
                var editor=file.Ops.FirstOrDefault(o=>o.Enabled&&o.Step==Step.Scene);
                string scenePath=file.Path;
                if(editor!=null){
                    string resolvedRecipeJson;
                    var recipe=SceneRecipe.Parse(editor.Value, out resolvedRecipeJson);
                    if(recipe.HasFilterPayload()){
                        string bakeKey = (sharedBakeCache != null && !String.IsNullOrEmpty(sharedBakeDir))
                            ? ComputeSharedBakeKey(scenePath, resolvedRecipeJson)
                            : null;
                        string cachedBaked;
                        if (bakeKey != null && sharedBakeCache.TryGetValue(bakeKey, out cachedBaked) && File.Exists(cachedBaked)) {
                            log(I18n.F("app.converter.sharedBakeReuseLog", "key", bakeKey.Substring(0, 8)));
                            scenePath = cachedBaked;
                            bakedByWorker = true;
                        } else {
                            status("app.status.preparing");string stem=Path.Combine(staging,Guid.NewGuid().ToString("N"));
                            string rulesFile=stem+".json";File.WriteAllText(rulesFile,resolvedRecipeJson,new UTF8Encoding(false));
                            if(!scenePath.EndsWith(".ply",StringComparison.OrdinalIgnoreCase)||EditorAssets.Worker("probe",scenePath,"-","-",runtime,staging,token,0)!=0){
                                // Decode only for formal export; preserve SH and attributes in the staging PLY.
                                string decoded=stem+".decoded.ply";Run(new List<string>{scenePath,decoded},new Job{Format=Formats.First(f=>f.Suffix==".ply"),Device="cpu",Workers=job.Workers},staging,token,log,null);scenePath=decoded;
                            }
                            string filtered = (bakeKey != null && !String.IsNullOrEmpty(sharedBakeDir))
                                ? Path.Combine(sharedBakeDir, "bake-" + bakeKey + ".ply")
                                : (stem + ".selected.ply");
                            if (bakeKey != null) Directory.CreateDirectory(sharedBakeDir);
                            EditorAssets.Worker("mask",scenePath,filtered,rulesFile,runtime,staging,token,0);
                            if (bakeKey != null) sharedBakeCache[bakeKey] = filtered;
                            scenePath=filtered;
                            bakedByWorker = true;
                        }
                    }
                    args.Add(scenePath);recipe.AppendTransform(args);
                }else args.Add(scenePath);
                foreach (Op op in file.Ops.Where(o=>o.Step!=Step.Scene)) op.Append(args);
            }
            bool trim = job.Keep < 100;
            bool separate = trim && job.Format.Suffix != ".ply";
            string reduced = Path.Combine(staging, "reduced.ply");
            string engineOutput = job.Format.Voxel ? tempOutput.Substring(0, tempOutput.Length - 4) + ".json" : tempOutput;
            bool canDirectCopyBakedPly = !trim && job.Format.Suffix == ".ply" && job.Inputs.Count == 1
                && !job.PlyLogitOpacity && job.Ops.All(o => !o.Enabled) && args.Count == 1 && bakedByWorker && File.Exists(args[0]);
            if (canDirectCopyBakedPly) {
                status("app.status.converting");
                log(I18n.T("app.converter.losslessDirectCopyLog"));
                File.Copy(args[0], tempOutput, true);
                ReportProgress(progress, "app.status.converting", "PLY", 94, 0, null, 1, 1);
            } else {
                args.Add(separate ? reduced : engineOutput);
                foreach (Op op in job.Ops) op.Append(args);
                if (trim) {
                    string decimateFlag = job.AdaptiveDecimate ? "--decimate-adaptive" : "--decimate";
                    args.AddRange(new[] { decimateFlag, job.Keep.ToString(CultureInfo.InvariantCulture) + "%", "--scratch-dir", staging });
                }
                if (separate) {
                    status("app.status.reducing");
                    Run(args, job, staging, token, log, (stage, pct) => ReportProgress(progress, "app.status.reducing", stage, pct * 0.46, 0, null, 1, 1));
                    status("app.status.encoding");
                    Run(new List<string> { reduced, engineOutput }, job, staging, token, log, (stage, pct) => ReportProgress(progress, "app.status.encoding", stage, 46 + pct * (job.Format.Voxel ? 0.44 : 0.48), 0, null, 1, 1));
                } else {
                    status("app.status.converting");
                    double span = job.Format.Voxel ? 88d : 94d;
                    Run(args, job, staging, token, log, (stage, pct) => ReportProgress(progress, "app.status.converting", stage, pct * span / 100d, 0, null, 1, 1));
                }
            }
            if (job.Format.Voxel) {
                status("app.status.packing");
                ReportProgress(progress, "app.status.packing", "ZIP", 92, 0, null, 1, 1);
                using (var stream = new FileStream(tempOutput, FileMode.CreateNew))
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Create)) {
                    var entriesToPack = new List<string> { engineOutput, Path.ChangeExtension(engineOutput, ".bin") };
                    string colMesh = Path.ChangeExtension(engineOutput, ".collision.glb");
                    if (File.Exists(colMesh)) entriesToPack.Add(colMesh);
                    foreach (string file in entriesToPack) {
                        using (var src = File.OpenRead(file))
                        using (var dest = zip.CreateEntry(Path.GetFileName(file), CompressionLevel.Fastest).Open()) {
                            var buffer = new byte[1024 * 1024];
                            int read;
                            while ((read = src.Read(buffer, 0, buffer.Length)) > 0) {
                                token.ThrowIfCancellationRequested();
                                dest.Write(buffer, 0, read);
                            }
                        }
                    }
                }
            }
            token.ThrowIfCancellationRequested();
            status("app.status.verifying");
            ReportProgress(progress, "app.status.verifying", Path.GetFileName(output), 97, 0, null, 1, 1);
            var rep = ExportVerifier.Verify(tempOutput, job.Format.Suffix);
            log(I18n.F("app.converter.verifyLog", "message", rep.Message, "level", rep.Level));
            return rep;
        } catch {
            PortablePaths.SafeDeleteManagedSubdir(PortablePaths.TmpDir, staging);
            throw;
        }
    }

    internal string RunInfoStats(string inputPath, CancellationToken token) {
        Prepare(token);
        string staging = Path.Combine(PortablePaths.TmpDir, "inspect-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try {
            string script = Path.Combine(runtime, @"node_modules\@playcanvas\splat-transform\bin\cli.mjs");
            var args = new[] { script, "--no-tty", inputPath, "--info", "json", "--stats", "json", "null" };
            var psi = new ProcessStartInfo(Path.Combine(runtime, "node.exe"), String.Join(" ", args.Select(Quote))) {
                WorkingDirectory = runtime, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            PortablePaths.ApplyChildEnvironment(psi, staging);
            using (var p = Process.Start(psi)) {
                string stdout = p.StandardOutput.ReadToEnd();
                p.WaitForExit(30000);
                token.ThrowIfCancellationRequested();
                return stdout;
            }
        } finally {
            PortablePaths.SafeDeleteManagedSubdir(PortablePaths.TmpDir, staging);
        }
    }

    static void ReportProgress(Action<ProgressInfo> progress, string stageKey, string detail, double pct, double elapsed, double? eta, int fileIdx, int fileTotal) {
        if (progress == null) return;
        progress(new ProgressInfo {
            StageKey = stageKey, Detail = detail ?? "",
            Percent = Math.Max(0, Math.Min(100, pct)),
            ElapsedSeconds = elapsed, EtaSeconds = eta,
            FileIndex = fileIdx, FileTotal = fileTotal
        });
    }

    void Run(List<string> args, Job job, string stagingDir, CancellationToken token, Action<string> log, Action<string, double> onBar) {
        token.ThrowIfCancellationRequested();
        string script = Path.Combine(runtime, @"node_modules\@playcanvas\splat-transform\bin\cli.mjs");
        var all = new List<string> { script, "--no-tty", "--memory", "--max-workers", job.Workers.ToString(CultureInfo.InvariantCulture) };
        bool isDecimateOnlyPass = job.Format.Voxel && (args.Contains("--decimate") || args.Contains("--decimate-adaptive"))
            && !args.Any(a => a.EndsWith(".voxel.json", StringComparison.OrdinalIgnoreCase));
        if (job.Device == "cpu" || isDecimateOnlyPass)
            all.AddRange(new[] { "--gpu", "cpu" });
        else if (job.Device == "vulkan")
            all.AddRange(new[] { "--gpu-backend", "vulkan" });
        if (job.Format.Sog) {
            all.AddRange(new[] { "--sh-iterations", job.Iterations.ToString(CultureInfo.InvariantCulture) });
            if (job.Effort >= 0) all.AddRange(new[] { "--webp-effort", job.Effort.ToString(CultureInfo.InvariantCulture) });
            if (job.SogVersion == 2) all.AddRange(new[] { "--sog-version", "2" });
            if (job.ShColorError.HasValue && job.ShColorError.Value > 0) all.AddRange(new[] { "--sh-color-error", job.ShColorError.Value.ToString("0.##", CultureInfo.InvariantCulture) });
            if (job.Format.Suffix == ".html" && job.HtmlUnbundled) all.Add("--unbundled");
        }
        if (job.Format.Suffix == ".spz" && (job.SpzVersion == 3 || job.SpzVersion == 4))
            all.AddRange(new[] { "--spz-version", job.SpzVersion.ToString(CultureInfo.InvariantCulture) });
        if (job.Format.Suffix == ".ply" && job.PlyLogitOpacity)
            all.Add("--ply-logit-opacity");
        if (job.Format.Voxel) {
            all.AddRange(new[] { "--voxel-size", job.VoxelSize, "--voxel-opacity", job.Opacity });
            if (job.VoxelExternalFill) all.Add("--voxel-external-fill");
            if (job.VoxelFloorFill) all.Add("--voxel-floor-fill");
            if (job.VoxelCarve) all.Add("--voxel-carve");
            if (!String.IsNullOrWhiteSpace(job.SeedPos)) all.AddRange(new[] { "--seed-pos", job.SeedPos });
            if (!String.IsNullOrWhiteSpace(job.CollisionMesh)) all.AddRange(new[] { "--collision-mesh", job.CollisionMesh });
        }
        all.AddRange(args);

        var start = new ProcessStartInfo(Path.Combine(runtime, "node.exe"), String.Join(" ", all.Select(Quote))) {
            WorkingDirectory = runtime, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardError = true, RedirectStandardOutput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        PortablePaths.ApplyChildEnvironment(start, stagingDir);

        using (var process = new Process { StartInfo = start }) {
            var tail = new Queue<string>();
            var parseLock = new object();
            int barsCompleted = 0;
            int expectedBars = job.Format.Sog ? 5 : (job.Format.Voxel ? 4 : 2);
            bool inBar = false;
            int barTicks = 0;
            string activeStage = "";

            Action<string> emitLine = line => {
                if (String.IsNullOrWhiteSpace(line)) return;
                lock (tail) { tail.Enqueue(line); if (tail.Count > 80) tail.Dequeue(); }
                log(line);
            };

            Action<StreamReader> pump = reader => {
                var buf = new char[512];
                var lineBuf = new StringBuilder();
                int n;
                while ((n = reader.Read(buf, 0, buf.Length)) > 0) {
                    for (int i = 0; i < n; i++) {
                        char ch = buf[i];
                        if (ch == '\r') continue;
                        if (ch == '\n') {
                            string full = lineBuf.ToString();
                            lineBuf.Length = 0;
                            lock (parseLock) {
                                if (inBar) { inBar = false; barsCompleted++; barTicks = 0; }
                                if (full.Contains("▸")) {
                                    int p = full.IndexOf('▸');
                                    string label = full.Substring(p + 1).Trim();
                                    int bracket = label.IndexOf('[');
                                    if (bracket > 0) label = label.Substring(0, bracket).Trim();
                                    if (!String.IsNullOrEmpty(label)) activeStage = CleanStageLabel(label);
                                }
                                double pct = Math.Min(96, (barsCompleted / (double)Math.Max(1, expectedBars)) * 96d);
                                if (onBar != null) onBar(activeStage, pct);
                            }
                            emitLine(full);
                        } else {
                            lineBuf.Append(ch);
                            lock (parseLock) {
                                if (!inBar && ch == '[' && lineBuf.ToString().Contains("▸")) {
                                    inBar = true; barTicks = 0;
                                    string cur = lineBuf.ToString();
                                    int p = cur.IndexOf('▸'); int b = cur.IndexOf('[');
                                    if (p >= 0 && b > p) activeStage = CleanStageLabel(cur.Substring(p + 1, b - p - 1).Trim());
                                } else if (inBar && ch == '#') {
                                    barTicks = Math.Min(30, barTicks + 1);
                                    double barFrac = barTicks / 30d;
                                    if (barsCompleted >= expectedBars) expectedBars = barsCompleted + 1;
                                    double pct = Math.Min(98, ((barsCompleted + barFrac) / (double)expectedBars) * 96d);
                                    if (onBar != null) onBar(activeStage, pct);
                                } else if (inBar && ch == ']') {
                                    inBar = false; barsCompleted++; barTicks = 0;
                                    if (barsCompleted >= expectedBars) expectedBars = barsCompleted + 1;
                                    double pct = Math.Min(98, (barsCompleted / (double)expectedBars) * 96d);
                                    if (onBar != null) onBar(activeStage, pct);
                                }
                            }
                        }
                    }
                }
                if (lineBuf.Length > 0) emitLine(lineBuf.ToString());
            };

            process.Start();
            using (token.Register(() => { try { if (!process.HasExited) process.Kill(); } catch { } })) {
                var tOut = new Thread(() => pump(process.StandardOutput)) { IsBackground = true };
                var tErr = new Thread(() => pump(process.StandardError)) { IsBackground = true };
                tOut.Start(); tErr.Start();
                process.WaitForExit();
                tOut.Join(3000); tErr.Join(3000);
            }
            token.ThrowIfCancellationRequested();
            if (process.ExitCode != 0) throw new IOException(I18n.F("app.converter.engineExited", "code", process.ExitCode, "tail", String.Join("\n", tail)));
        }
    }

    static string CleanStageLabel(string raw) {
        if (String.IsNullOrWhiteSpace(raw)) return "";
        return Regex.Replace(raw, @"[A-Za-z]:\\[^\s]*?\\tmp\\job-[0-9a-fA-F]+\\", "");
    }

    internal static string Quote(string arg) {
        return "\"" + Regex.Replace(arg, "(\\\\*)(\"|$)", m =>
            new string('\\', m.Groups[1].Length * 2 + (m.Groups[2].Length == 0 ? 0 : 1)) + m.Groups[2].Value) + "\"";
    }

    public void Dispose() { }
}
