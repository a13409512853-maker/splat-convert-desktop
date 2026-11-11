using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;

[assembly: AssemblyTitle("SuperSplat Convert Desktop")]
[assembly: AssemblyProduct("SuperSplat Convert Desktop")]
[assembly: AssemblyVersion("1.1.0.0")]

sealed class Format {
    public readonly string Name, Suffix;
    public Format(string name, string suffix) { Name = name; Suffix = suffix; }
    public override string ToString() { return Name; }
    public bool Sog { get { return Suffix == ".sog" || Suffix == ".html"; } }
    public bool Voxel { get { return Suffix == ".voxel.zip"; } }
}

sealed class Step {
    public readonly string Name, Flag, Fields, Defaults;
    public Step(string name, string flag, string fields, string defaults) {
        Name = name; Flag = flag; Fields = fields; Defaults = defaults;
    }
    public override string ToString() { return Name; }
    public static readonly Step[] All = {
        new Step("平移", "--translate", "X,Y,Z", "0,0,0"),
        new Step("旋转（度）", "--rotate", "X,Y,Z", "0,0,0"),
        new Step("等比缩放", "--scale", "倍率", "1"),
        new Step("移除无效点（NaN / Inf）", "--filter-nan", "", ""),
        new Step("球谐阶数上限", "--filter-harmonics", "阶数", "3"),
        new Step("包围盒筛选", "--filter-box", "最小 X,最小 Y,最小 Z,最大 X,最大 Y,最大 Z", "-10,-10,-10,10,10,10"),
        new Step("球形范围筛选", "--filter-sphere", "中心 X,中心 Y,中心 Z,半径", "0,0,0,10")
    };
}

sealed class Op {
    public Step Step;
    public string Value;
    public override string ToString() { return Step.Name + (Value == "" ? "" : "    " + Value); }
    public void Append(List<string> args) {
        args.Add(Step.Flag);
        if (Value != "") args.Add(Value);
    }
}

sealed class InputFile {
    public readonly string Path;
    public readonly List<Op> Ops = new List<Op>();
    public InputFile(string path) { Path = path; }
}

sealed class Job {
    public readonly List<InputFile> Inputs = new List<InputFile>();
    public readonly List<Op> Ops = new List<Op>();
    public string Output;
    public Format Format;
    public bool Overwrite;
    public int Keep = 100, Iterations = 10, Effort = -1, Workers = 4;
    public string Device = "auto", VoxelSize = "0.05", Opacity = "0.1";
}

sealed class Converter : IDisposable {
    public static readonly Format[] Formats = {
        new Format("SOG  /  SuperSplat 优化包", ".sog"),
        new Format("PLY  /  标准格式", ".ply"),
        new Format("压缩 PLY", ".compressed.ply"),
        new Format("CSV  /  表格数据", ".csv"),
        new Format("HTML  /  内嵌查看器", ".html"),
        new Format("体素 ZIP  /  碰撞数据", ".voxel.zip")
    };
    string runtime;
    public static bool Supported(string path) {
        return new[] { ".ply", ".sog", ".ksplat", ".splat", ".spz" }.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);
    }
    public static string Stem(string path) {
        string n = Path.GetFileName(path);
        if (n.EndsWith(".compressed.ply", StringComparison.OrdinalIgnoreCase)) return n.Substring(0, n.Length - 15);
        return Path.GetFileNameWithoutExtension(n);
    }
    void Prepare(CancellationToken token) {
        if (runtime != null) return;
        string folder = Path.Combine(Path.GetTempPath(), "SplatConvert-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("engine.zip"))
            using (var zip = new ZipArchive(s, ZipArchiveMode.Read)) {
                foreach (var entry in zip.Entries) {
                    token.ThrowIfCancellationRequested();
                    string dest = Path.GetFullPath(Path.Combine(folder, entry.FullName));
                    if (!dest.StartsWith(folder + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("内置引擎包路径无效。");
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    using (Stream source = entry.Open())
                    using (var output = new FileStream(dest, FileMode.CreateNew, FileAccess.Write)) source.CopyTo(output);
                }
            }
            runtime = folder;
        } catch { Clean(folder); throw; }
    }

    public void Convert(Job job, CancellationToken token, Action<string> status, Action<string> log) {
        token.ThrowIfCancellationRequested();
        if (job.Inputs.Count == 0 || job.Inputs.Any(i => !Supported(i.Path) || !File.Exists(i.Path)))
            throw new IOException("源文件不存在或格式不受支持。");
        string output = Path.GetFullPath(job.Output);
        if (!output.EndsWith(job.Format.Suffix, StringComparison.OrdinalIgnoreCase)) throw new IOException("输出扩展名不正确。");
        if (job.Inputs.Any(x => String.Equals(Path.GetFullPath(x.Path), output, StringComparison.OrdinalIgnoreCase)))
            throw new IOException("不能将输出写回源文件，请另选文件名。");
        if (File.Exists(output) && !job.Overwrite) throw new IOException("输出已存在，请确认覆盖或另选文件名。");
        string parent = Path.GetDirectoryName(output);
        if (!Directory.Exists(parent)) throw new DirectoryNotFoundException("输出目录不存在。");
        status("准备本地转换引擎…");
        Prepare(token);
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
                args.AddRange(new[] { "--decimate", job.Keep.ToString(CultureInfo.InvariantCulture) + "%", "--scratch-dir", staging });
            }
            if (separate) {
                status("阶段 1 / 2：精简高斯点…");
                Run(args, job, token, log);
                status("阶段 2 / 2：编码输出…");
                Run(new List<string> { reduced, engineOutput }, job, token, log);
            } else {
                status("正在转换…");
                Run(args, job, token, log);
            }
            if (job.Format.Voxel) {
                status("正在打包体素文件…");
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
        } finally { Clean(staging); }
    }

    void Run(List<string> args, Job job, CancellationToken token, Action<string> log) {
        token.ThrowIfCancellationRequested();
        string script = Path.Combine(runtime, @"node_modules\@playcanvas\splat-transform\bin\cli.mjs");
        var all = new List<string> { script, "--no-tty", "--memory", "--max-workers", job.Workers.ToString(CultureInfo.InvariantCulture) };
        if (job.Device == "cpu" || (job.Format.Voxel && args.Any(a => a == "--decimate") && !args.Any(a => a.EndsWith(".voxel.json", StringComparison.OrdinalIgnoreCase))))
            all.AddRange(new[] { "--gpu", "cpu" });
        else if (job.Device == "vulkan") all.AddRange(new[] { "--gpu-backend", "vulkan" });
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
            DataReceivedEventHandler report = (sender, e) => {
                if (String.IsNullOrWhiteSpace(e.Data)) return;
                lock (tail) { tail.Enqueue(e.Data); if (tail.Count > 5) tail.Dequeue(); }
                log(e.Data);
            };
            process.OutputDataReceived += report;
            process.ErrorDataReceived += report;
            process.Start();
            using (token.Register(() => { try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { } })) {
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
            }
            token.ThrowIfCancellationRequested();
            if (process.ExitCode != 0) throw new IOException("引擎退出（" + process.ExitCode + "）。\n" + String.Join("\n", tail));
        }
    }
    static string Quote(string arg) {
        return "\"" + System.Text.RegularExpressions.Regex.Replace(arg, "(\\\\*)(\"|$)", m =>
            new string('\\', m.Groups[1].Length * 2 + (m.Groups[2].Length == 0 ? 0 : 1)) + m.Groups[2].Value) + "\"";
    }
    static void Clean(string path) {
        if (path == null) return;
        try { Directory.Delete(path, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
    public void Dispose() { Clean(runtime); }
}
