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
[assembly: AssemblyVersion("2.0.0.0")]

sealed class Format {
    public readonly string Suffix;
    public string Name {
        get {
            if (Suffix == ".sog") return I18n.T("sog");
            if (Suffix == ".ply") return I18n.T("ply");
            if (Suffix == ".compressed.ply") return I18n.T("compressed");
            if (Suffix == ".spz") return I18n.T("spz");
            if (Suffix == ".csv") return I18n.T("csv");
            if (Suffix == ".html") return I18n.T("html");
            return I18n.T("voxelFormat");
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
            if (Flag == "--translate") return I18n.T("translate");
            if (Flag == "--rotate") return I18n.T("rotate");
            if (Flag == "--scale") return I18n.T("scale");
            if (Flag == "--filter-nan") return I18n.T("nan");
            if (Flag == "--filter-harmonics") return I18n.T("harmonics");
            if (Flag == "--filter-box") return I18n.T("box");
            if (Flag == "--filter-sphere") return I18n.T("sphere");
            if (Flag == "--filter-floaters") return I18n.T("floaters");
            return I18n.T("cluster");
        }
    }
    public string Fields {
        get {
            if (Flag == "--filter-nan") return "";
            if (Flag == "--scale") return I18n.T("factor");
            if (Flag == "--filter-harmonics") return I18n.T("band");
            if (Flag == "--filter-box") return String.Join(",", new[] { "X", "Y", "Z" }.Select(a => I18n.T("min") + " " + a).Concat(new[] { "X", "Y", "Z" }.Select(a => I18n.T("max") + " " + a)));
            if (Flag == "--filter-sphere") return "X,Y,Z," + I18n.T("radius");
            if (Flag == "--filter-floaters") return I18n.T("floaterParams");
            if (Flag == "--filter-cluster") return I18n.T("clusterParams");
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
    public static readonly Step[] All = {
        new Step("平移", "--translate", "X,Y,Z", "0,0,0"),
        new Step("旋转（度）", "--rotate", "X,Y,Z", "0,0,0"),
        new Step("等比缩放", "--scale", "倍率", "1"),
        new Step("移除无效点（NaN / Inf）", "--filter-nan", "", ""),
        new Step("球谐阶数上限", "--filter-harmonics", "阶数", "3"),
        new Step("包围盒筛选", "--filter-box", "最小 X,最小 Y,最小 Z,最大 X,最大 Y,最大 Z", "-10,-10,-10,10,10,10"),
        new Step("球形范围筛选", "--filter-sphere", "中心 X,中心 Y,中心 Z,半径", "0,0,0,10"),
        new Step("去除空中飞点（Filter Floaters）", "--filter-floaters", "体素大小,透明度,最小贡献", "0.05,0.1,0.004"),
        new Step("保留连通主体（Filter Cluster）", "--filter-cluster", "网格精度,透明度,最小贡献", "1.0,0.999,0.1")
    };
}

sealed class Op {
    public Step Step;
    public string Value;
    public bool Enabled = true;
    public override string ToString() { return (Enabled ? "✓ " : "○ ") + Step.Name + (String.IsNullOrEmpty(Value) ? "" : "    " + Value); }
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
    public bool NeedsGpu {
        get {
            return (Format != null && (Format.Sog || Format.Voxel))
                || Ops.Any(o => o.Enabled && o.Step.RequiresGpu)
                || Inputs.Any(i => i.Ops.Any(o => o.Enabled && o.Step.RequiresGpu));
        }
    }
}

sealed class Converter : IDisposable {
    public static readonly Format[] Formats = {
        new Format("SOG  /  SuperSplat 优化包", ".sog"),
        new Format("PLY  /  标准格式", ".ply"),
        new Format("压缩 PLY", ".compressed.ply"),
        new Format("SPZ  /  Niantic 压缩格式", ".spz"),
        new Format("CSV  /  表格数据", ".csv"),
        new Format("HTML  /  内嵌查看器", ".html"),
        new Format("体素 ZIP  /  碰撞数据", ".voxel.zip")
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

    void Prepare(CancellationToken token) {
        runtime = EngineManager.EnsureActiveRuntime(token);
    }

    public void Convert(Job job, CancellationToken token, Action<string> status, Action<string> log) {
        Convert(job, token, status, log, null);
    }

    public void Convert(Job job, CancellationToken token, Action<string> status, Action<string> log, Action<ProgressInfo> progress) {
        token.ThrowIfCancellationRequested();
        if (job.Inputs.Count == 0 || job.Inputs.Any(i => !Supported(i.Path)))
            throw new InvalidDataException(I18n.T("inputAdvice"));
        var missing = job.Inputs.FirstOrDefault(i => !File.Exists(i.Path));
        if (missing != null) throw new FileNotFoundException(I18n.T("inputAdvice"), missing.Path);

        var totalWatch = Stopwatch.StartNew();
        status("preparing");
        ReportProgress(progress, "preparing", "", 1, totalWatch.Elapsed.TotalSeconds, null, 1, job.BatchMode ? job.Inputs.Count : 1);
        Prepare(token);

        if (job.BatchMode) {
            string outDir = Path.GetFullPath(String.IsNullOrWhiteSpace(job.OutputDirectory) ? Path.GetDirectoryName(job.Output) : job.OutputDirectory);
            Directory.CreateDirectory(outDir);
            int totalFiles = job.Inputs.Count;
            for (int idx = 0; idx < totalFiles; idx++) {
                token.ThrowIfCancellationRequested();
                var single = new Job {
                    Format = job.Format,
                    Overwrite = job.Overwrite,
                    BatchMode = false,
                    AdaptiveDecimate = job.AdaptiveDecimate,
                    Keep = job.Keep,
                    Iterations = job.Iterations,
                    Effort = job.Effort,
                    Workers = job.Workers,
                    Device = job.Device,
                    VoxelSize = job.VoxelSize,
                    Opacity = job.Opacity,
                    Output = Path.Combine(outDir, Stem(job.Inputs[idx].Path) + job.Format.Suffix)
                };
                if (String.Equals(Path.GetFullPath(single.Output), Path.GetFullPath(job.Inputs[idx].Path), StringComparison.OrdinalIgnoreCase))
                    single.Output = Path.Combine(outDir, Stem(job.Inputs[idx].Path) + "-converted" + job.Format.Suffix);
                single.Inputs.Add(job.Inputs[idx]);
                single.Ops.AddRange(job.Ops);
                log("[" + (idx + 1) + "/" + totalFiles + "] " + Path.GetFileName(job.Inputs[idx].Path) + " -> " + Path.GetFileName(single.Output));
                int currentIdx = idx;
                ConvertSingle(single, token, status, log, p => {
                    double overall = ((currentIdx + (p.Percent / 100d)) / totalFiles) * 100d;
                    double elapsed = totalWatch.Elapsed.TotalSeconds;
                    double? eta = overall >= 2.5 ? (double?)Math.Max(0, elapsed * (100d - overall) / overall) : null;
                    ReportProgress(progress, p.StageKey, Path.GetFileName(job.Inputs[currentIdx].Path) + (String.IsNullOrEmpty(p.Detail) ? "" : " · " + p.Detail),
                        overall, elapsed, eta, currentIdx + 1, totalFiles);
                });
            }
            ReportProgress(progress, "done", "", 100, totalWatch.Elapsed.TotalSeconds, 0, totalFiles, totalFiles);
            return;
        }

        ConvertSingle(job, token, status, log, p => {
            double elapsed = totalWatch.Elapsed.TotalSeconds;
            double? eta = p.Percent >= 3.0 ? (double?)Math.Max(0, elapsed * (100d - p.Percent) / p.Percent) : null;
            ReportProgress(progress, p.StageKey, p.Detail, p.Percent, elapsed, eta, 1, 1);
        });
        ReportProgress(progress, "done", "", 100, totalWatch.Elapsed.TotalSeconds, 0, 1, 1);
    }

    void ConvertSingle(Job job, CancellationToken token, Action<string> status, Action<string> log, Action<ProgressInfo> progress) {
        string output = Path.GetFullPath(job.Output);
        if (!output.EndsWith(job.Format.Suffix, StringComparison.OrdinalIgnoreCase)) throw new IOException("输出扩展名不正确。");
        if (job.Inputs.Any(x => String.Equals(Path.GetFullPath(x.Path), output, StringComparison.OrdinalIgnoreCase)))
            throw new IOException("不能将输出写回源文件，请另选文件名。");
        if (File.Exists(output) && !job.Overwrite) throw new IOException("输出已存在，请确认覆盖或另选文件名。");
        string parent = Path.GetDirectoryName(output);
        if (!Directory.Exists(parent)) throw new DirectoryNotFoundException(I18n.T("accessAdvice"));

        string staging = Path.Combine(parent, ".splat-convert-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try {
            var args = new List<string>();
            foreach (InputFile file in job.Inputs) {
                args.Add(file.Path);
                foreach (Op op in file.Ops) op.Append(args);
            }
            bool trim = job.Keep < 100;
            bool separate = trim && job.Format.Suffix != ".ply";
            string reduced = Path.Combine(staging, "reduced.ply");
            string tempOutput = Path.Combine(staging, Path.GetFileName(output));
            string engineOutput = job.Format.Voxel ? tempOutput.Substring(0, tempOutput.Length - 4) + ".json" : tempOutput;
            args.Add(separate ? reduced : engineOutput);
            foreach (Op op in job.Ops) op.Append(args);
            if (trim) {
                string decimateFlag = job.AdaptiveDecimate ? "--decimate-adaptive" : "--decimate";
                args.AddRange(new[] { decimateFlag, job.Keep.ToString(CultureInfo.InvariantCulture) + "%", "--scratch-dir", staging });
            }
            if (separate) {
                status("reducing");
                Run(args, job, token, log, (stage, pct) => ReportProgress(progress, "reducing", stage, pct * 0.48, 0, null, 1, 1));
                status("encoding");
                Run(new List<string> { reduced, engineOutput }, job, token, log, (stage, pct) => ReportProgress(progress, "encoding", stage, 48 + pct * (job.Format.Voxel ? 0.44 : 0.50), 0, null, 1, 1));
            } else {
                status("converting");
                double span = job.Format.Voxel ? 92d : 98d;
                Run(args, job, token, log, (stage, pct) => ReportProgress(progress, "converting", stage, pct * span / 100d, 0, null, 1, 1));
            }
            if (job.Format.Voxel) {
                status("packing");
                ReportProgress(progress, "packing", "ZIP", 94, 0, null, 1, 1);
                using (var stream = new FileStream(tempOutput, FileMode.CreateNew))
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Create)) {
                    foreach (string file in new[] { engineOutput, Path.ChangeExtension(engineOutput, ".bin") }) {
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
            if (!File.Exists(tempOutput) || new FileInfo(tempOutput).Length == 0) throw new IOException("引擎未生成有效输出。");
            if (File.Exists(output) && job.Overwrite) File.Replace(tempOutput, output, null);
            else File.Move(tempOutput, output);
        } finally {
            Clean(staging);
            if (Directory.Exists(staging)) log(I18n.T("cleanup") + " " + staging);
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

    void Run(List<string> args, Job job, CancellationToken token, Action<string> log, Action<string, double> onBar) {
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
        }
        if (job.Format.Voxel) all.AddRange(new[] { "--voxel-size", job.VoxelSize, "--voxel-opacity", job.Opacity });
        all.AddRange(args);

        var start = new ProcessStartInfo(Path.Combine(runtime, "node.exe"), String.Join(" ", all.Select(Quote))) {
            WorkingDirectory = runtime, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardError = true, RedirectStandardOutput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        start.EnvironmentVariables.Remove("NODE_OPTIONS");
        start.EnvironmentVariables.Remove("NODE_PATH");
        start.EnvironmentVariables["NO_COLOR"] = "1";

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
                                    if (!String.IsNullOrEmpty(label)) activeStage = label;
                                }
                                double pct = Math.Min(96, (barsCompleted / (double)Math.Max(1, expectedBars)) * 96d);
                                if (onBar != null) onBar(activeStage, pct);
                            }
                            emitLine(full);
                        } else {
                            lineBuf.Append(ch);
                            lock (parseLock) {
                                if (!inBar && ch == '[' && lineBuf.ToString().Contains("▸")) {
                                    inBar = true;
                                    barTicks = 0;
                                    string cur = lineBuf.ToString();
                                    int p = cur.IndexOf('▸');
                                    int b = cur.IndexOf('[');
                                    if (p >= 0 && b > p) activeStage = cur.Substring(p + 1, b - p - 1).Trim();
                                } else if (inBar && ch == '#') {
                                    barTicks = Math.Min(30, barTicks + 1);
                                    double barFrac = barTicks / 30d;
                                    if (barsCompleted >= expectedBars) expectedBars = barsCompleted + 1;
                                    double pct = Math.Min(98, ((barsCompleted + barFrac) / (double)expectedBars) * 96d);
                                    if (onBar != null) onBar(activeStage, pct);
                                } else if (inBar && ch == ']') {
                                    inBar = false;
                                    barsCompleted++;
                                    barTicks = 0;
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
            using (token.Register(() => { try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { } })) {
                var tOut = new Thread(() => pump(process.StandardOutput)) { IsBackground = true };
                var tErr = new Thread(() => pump(process.StandardError)) { IsBackground = true };
                tOut.Start();
                tErr.Start();
                process.WaitForExit();
                tOut.Join(3000);
                tErr.Join(3000);
            }
            token.ThrowIfCancellationRequested();
            if (process.ExitCode != 0) throw new IOException("引擎退出（" + process.ExitCode + "）。\n" + String.Join("\n", tail));
        }
    }

    static string Quote(string arg) {
        return "\"" + Regex.Replace(arg, "(\\\\*)(\"|$)", m =>
            new string('\\', m.Groups[1].Length * 2 + (m.Groups[2].Length == 0 ? 0 : 1)) + m.Groups[2].Value) + "\"";
    }

    static void Clean(string path) {
        if (path == null) return;
        try { Directory.Delete(path, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    public void Dispose() { }
}
