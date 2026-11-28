using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

#pragma warning disable 0649
sealed class JobOpDto {
    public string Flag;
    public string Value;
    public bool Enabled = true;
}

sealed class JobInputDto {
    public string Id;
    public string StoredPath;
    public bool AuthorizedExternal;
    public long SizeBytes;
    public string Fingerprint;
    public string FingerprintAlgo = "quick-sha256";
    public List<JobOpDto> Ops = new List<JobOpDto>();
}

sealed class OutputProfileDto {
    public string Id = "default";
    public string Name = "Default";
    public string FormatSuffix = ".sog";
    public string OutputPath = "";
    public string OutputDirectory = "";
    public int Keep = 100;
    public bool AdaptiveDecimate = true;
    public int Iterations = 10;
    public int Effort = -1;
    public int Workers = 4;
    public string Device = "auto";
    public string VoxelSize = "0.05";
    public string Opacity = "0.1";
    public int SogVersion = 3;
    public int SpzVersion = 4;
    public bool PlyLogitOpacity;
    public long TargetMaxBytes;
    public int MinKeepPct = 20;
    public int MinShBand = 0;
    public int MaxAttempts = 3;
    public List<JobOpDto> Ops = new List<JobOpDto>();
}
#pragma warning restore 0649

sealed class SubTaskRecord {
    public string TaskId;
    public string ProfileId;
    public string InputId;
    public string ResolvedInput;
    public string InputFingerprint;
    public string ResolvedOutput;
    public string FormatSuffix;
    public string Status = "queued"; // queued|running|verifying|succeeded|failed|canceled|interrupted|skipped
    public int AttemptCount;
    public long ActualOutputBytes;
    public string VerificationLevel = "";
    public bool VerificationPassed;
    public string ErrorCode = "";
    public string ErrorMessage = "";
    public string UpdatedUtc = "";
}

sealed class PlanSummary {
    public bool Ready;
    public string PlanDigest;
    public int TotalTasks;
    public long MaxSingleTaskRamBytes;
    public long TotalOutputDiskBytes;
    public long PeakTempDiskBytes;
    public List<string> Conflicts = new List<string>();
    public List<string> MissingInputs = new List<string>();
    public List<string> Warnings = new List<string>();
}

sealed class JobDocument {
    public int SchemaVersion = 1;
    public string JobId = "";
    public string EngineVersion = EngineManager.BundledVersion;
    public string Mode = "batch"; // batch | merge | matrix
    public string ConflictPolicy = "reject"; // reject | overwrite
    public string PlanDigest = "";
    public string CreatedUtc = "";
    public string UpdatedUtc = "";
    public List<JobInputDto> Inputs = new List<JobInputDto>();
    public List<OutputProfileDto> Profiles = new List<OutputProfileDto>();
    public List<SubTaskRecord> Tasks = new List<SubTaskRecord>();
}

static class TaskPlanner {
    internal static string ManifestPath(string jobId) {
        return PortablePaths.ResolveStrictlyInside(PortablePaths.JobsDir, Path.Combine(jobId, "manifest.json"));
    }

    internal static void SaveManifest(JobDocument doc) {
        if (String.IsNullOrWhiteSpace(doc.JobId)) doc.JobId = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6);
        doc.UpdatedUtc = DateTime.UtcNow.ToString("O");
        if (String.IsNullOrWhiteSpace(doc.CreatedUtc)) doc.CreatedUtc = doc.UpdatedUtc;
        PortablePaths.AtomicWriteText(ManifestPath(doc.JobId), new JavaScriptSerializer().Serialize(doc));
    }

    internal static JobDocument LoadManifest(string path) {
        string raw = File.ReadAllText(path, Encoding.UTF8);
        var doc = new JavaScriptSerializer().Deserialize<JobDocument>(raw);
        if (doc == null) throw new InvalidDataException("Invalid job JSON: " + path);
        return doc;
    }

    internal static List<JobDocument> ListSavedJobs() {
        var list = new List<JobDocument>();
        if (!Directory.Exists(PortablePaths.JobsDir)) return list;
        foreach (string dir in Directory.GetDirectories(PortablePaths.JobsDir)) {
            string mf = Path.Combine(dir, "manifest.json");
            if (!File.Exists(mf)) continue;
            try { list.Add(LoadManifest(mf)); } catch { }
        }
        return list.OrderByDescending(j => j.UpdatedUtc).ToList();
    }

    internal static PlanSummary Plan(JobDocument doc) {
        var summary = new PlanSummary();
        string writeErr;
        if (!PortablePaths.EnsureWritable(out writeErr)) {
            summary.Conflicts.Add(writeErr);
            return summary;
        }
        if (doc.Inputs == null || doc.Inputs.Count == 0) summary.Conflicts.Add("No input files specified.");
        if (doc.Profiles == null || doc.Profiles.Count == 0) summary.Conflicts.Add("No output profile specified.");
        if (summary.Conflicts.Count > 0) return summary;

        var existingByKey = new Dictionary<string, SubTaskRecord>();
        if (doc.Tasks != null) {
            foreach (var t in doc.Tasks) existingByKey[t.TaskId] = t;
        }
        var plannedTasks = new List<SubTaskRecord>();
        var outputPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var inp in doc.Inputs) {
            string resolved = PortablePaths.ResolvePortableOrAbsolute(inp.StoredPath);
            if (!File.Exists(resolved)) {
                summary.MissingInputs.Add(I18n.F("app.jobs.missingInput", "path", inp.StoredPath));
            } else {
                var fi = new FileInfo(resolved);
                inp.SizeBytes = fi.Length;
                inp.Fingerprint = SplatInspector.QuickFingerprint(resolved);
            }
        }

        foreach (var profile in doc.Profiles) {
            var fmt = Converter.Formats.FirstOrDefault(f => String.Equals(f.Suffix, profile.FormatSuffix, StringComparison.OrdinalIgnoreCase)) ?? Converter.Formats[0];
            if (doc.Mode == "merge") {
                string outPath = PortablePaths.ResolvePortableOrAbsolute(profile.OutputPath);
                AddPlannedTask(doc, profile, fmt, null, outPath, existingByKey, plannedTasks, outputPaths, summary);
            } else {
                string outDir = PortablePaths.ResolvePortableOrAbsolute(String.IsNullOrWhiteSpace(profile.OutputDirectory) ? Path.GetDirectoryName(profile.OutputPath) : profile.OutputDirectory);
                foreach (var inp in doc.Inputs) {
                    string resolvedIn = PortablePaths.ResolvePortableOrAbsolute(inp.StoredPath);
                    string stem = Converter.Stem(resolvedIn);
                    string suffixTag = doc.Profiles.Count > 1 ? "-" + profile.Id : "";
                    string outPath = Path.Combine(outDir, stem + suffixTag + fmt.Suffix);
                    if (String.Equals(outPath, resolvedIn, StringComparison.OrdinalIgnoreCase))
                        outPath = Path.Combine(outDir, stem + suffixTag + "-converted" + fmt.Suffix);
                    AddPlannedTask(doc, profile, fmt, inp, outPath, existingByKey, plannedTasks, outputPaths, summary);
                }
            }
        }

        doc.Tasks = plannedTasks;
        summary.TotalTasks = plannedTasks.Count;
        summary.PlanDigest = ComputeDigest(doc);
        doc.PlanDigest = summary.PlanDigest;
        summary.Ready = summary.Conflicts.Count == 0 && summary.MissingInputs.Count == 0;
        return summary;
    }

    static void AddPlannedTask(JobDocument doc, OutputProfileDto profile, Format fmt, JobInputDto inp, string outPath,
        Dictionary<string, SubTaskRecord> existing, List<SubTaskRecord> list, HashSet<string> seenOut, PlanSummary summary) {
        string tid = profile.Id + "::" + (inp == null ? "merged" : inp.Id);
        if (!seenOut.Add(outPath)) summary.Conflicts.Add(I18n.F("app.jobs.conflictDuplicate", "path", outPath));
        if (File.Exists(outPath) && doc.ConflictPolicy != "overwrite")
            summary.Conflicts.Add(I18n.F("app.jobs.conflictExists", "path", outPath));

        // Per-task RAM budget (take MAX across tasks, never sum batch inputs!)
        var tmpJob = ToConverterJob(doc, profile, fmt, inp, outPath);
        var est = Budget.Estimate(tmpJob);
        if (est != null) {
            long peak = (long)est.HighBytes;
            if (peak > summary.MaxSingleTaskRamBytes) summary.MaxSingleTaskRamBytes = peak;
            long tempDisk = (long)(est.ReductionBytes > 0 ? est.ReductionBytes * 1.2 : est.BaseBytes * 0.5);
            if (tempDisk > summary.PeakTempDiskBytes) summary.PeakTempDiskBytes = tempDisk;
        }
        var outEst = Budget.EstimateOutputBytes(tmpJob.Inputs, fmt, profile.Keep, null, profile.Effort);
        if (outEst != null) summary.TotalOutputDiskBytes += outEst[1];

        SubTaskRecord prev;
        bool canReuse = existing.TryGetValue(tid, out prev) && prev.Status == "succeeded" && doc.PlanDigest==ComputeDigest(doc)
            && (inp == null || prev.InputFingerprint == inp.Fingerprint)
            && File.Exists(outPath);

        list.Add(new SubTaskRecord {
            TaskId = tid, ProfileId = profile.Id, InputId = inp == null ? "merged" : inp.Id,
            ResolvedInput = inp == null ? "merged" : PortablePaths.ResolvePortableOrAbsolute(inp.StoredPath),
            InputFingerprint = inp == null ? "" : inp.Fingerprint,
            ResolvedOutput = outPath, FormatSuffix = fmt.Suffix,
            Status = canReuse ? "skipped" : "queued",
            AttemptCount = prev != null ? prev.AttemptCount : 0,
            ActualOutputBytes = canReuse ? prev.ActualOutputBytes : 0,
            VerificationPassed = canReuse && prev.VerificationPassed
        });
    }

    internal static Job ToConverterJob(JobDocument doc, OutputProfileDto profile, Format fmt, JobInputDto singleInput, string outPath) {
        var j = new Job {
            Output = outPath, Format = fmt, Overwrite = doc.ConflictPolicy == "overwrite", BatchMode = false,
            AdaptiveDecimate = profile.AdaptiveDecimate, Keep = profile.Keep, Iterations = profile.Iterations,
            Effort = profile.Effort, Workers = profile.Workers, Device = profile.Device,
            VoxelSize = profile.VoxelSize, Opacity = profile.Opacity, SogVersion = profile.SogVersion,
            SpzVersion = profile.SpzVersion, PlyLogitOpacity = profile.PlyLogitOpacity,
            TargetMaxBytes = profile.TargetMaxBytes, MinKeepPct = profile.MinKeepPct, MinShBand = profile.MinShBand, MaxAttempts = profile.MaxAttempts
        };
        if (singleInput != null) {
            var inf = new InputFile(PortablePaths.ResolvePortableOrAbsolute(singleInput.StoredPath));
            foreach (var op in singleInput.Ops) AddDtoOp(inf.Ops, op);
            j.Inputs.Add(inf);
        } else {
            foreach (var inp in doc.Inputs) {
                var inf = new InputFile(PortablePaths.ResolvePortableOrAbsolute(inp.StoredPath));
                foreach (var op in inp.Ops) AddDtoOp(inf.Ops, op);
                j.Inputs.Add(inf);
            }
        }
        foreach (var op in profile.Ops) AddDtoOp(j.Ops, op);
        return j;
    }

    static void AddDtoOp(List<Op> dest, JobOpDto dto) {
        var step = dto.Flag==Step.Scene.Flag ? Step.Scene : Step.All.FirstOrDefault(s => s.Flag == dto.Flag);
        if (step != null) dest.Add(new Op { Step = step, Value = dto.Value ?? "", Enabled = dto.Enabled });
    }

    static string ComputeDigest(JobDocument doc) {
        var sb = new StringBuilder();
        sb.Append(doc.EngineVersion).Append('|').Append(doc.Mode).Append('|').Append(doc.ConflictPolicy);
        var json=new JavaScriptSerializer();
        foreach (var i in doc.Inputs) sb.Append('|').Append(i.StoredPath).Append(':').Append(i.Fingerprint).Append(':').Append(json.Serialize(i.Ops));
        foreach (var p in doc.Profiles) sb.Append('|').Append(json.Serialize(p));
        using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()))).Replace("-", "").ToLowerInvariant().Substring(0, 16);
    }
}

static class TaskRunner {
    // Runs planned sub-tasks sequentially (concurrency = 1), atomically saving manifest on every transition.
    internal static int Run(JobDocument doc, Converter converter, CancellationToken token, Action<string> log, Action<SubTaskRecord, ProgressInfo> onProgress) {
        int failed = 0;
        converter.Prepare(token);
        doc.EngineVersion = EngineManager.ActiveVersion;
        TaskPlanner.SaveManifest(doc);

        // Frozen snapshot common-bake cache: multiple output formats sharing the same input & recipe
        // reuse ONE common baked PLY instead of re-baking the source point cloud per format!
        var sharedBakeCache = new Dictionary<string, string>(StringComparer.Ordinal);
        string sharedBakeDir = Path.Combine(PortablePaths.TmpDir, "shared-bakes-" + Guid.NewGuid().ToString("N").Substring(0, 10));

        try {
        for (int idx = 0; idx < doc.Tasks.Count; idx++) {
            var task = doc.Tasks[idx];
            if (task.Status == "skipped" || task.Status == "succeeded") continue;
            if (token.IsCancellationRequested) {
                task.Status = "canceled"; task.UpdatedUtc = DateTime.UtcNow.ToString("O");
                TaskPlanner.SaveManifest(doc);
                return 5;
            }
            var profile = doc.Profiles.First(p => p.Id == task.ProfileId);
            var fmt = Converter.Formats.First(f => String.Equals(f.Suffix, task.FormatSuffix, StringComparison.OrdinalIgnoreCase));
            var singleInp = doc.Mode == "merge" ? null : doc.Inputs.FirstOrDefault(i => i.Id == task.InputId);
            var job = TaskPlanner.ToConverterJob(doc, profile, fmt, singleInp, task.ResolvedOutput);
            Directory.CreateDirectory(Path.GetDirectoryName(task.ResolvedOutput));

            task.Status = "running";
            task.AttemptCount++;
            task.ErrorCode = ""; task.ErrorMessage = "";
            task.UpdatedUtc = DateTime.UtcNow.ToString("O");
            TaskPlanner.SaveManifest(doc);

            try {
                var rep = converter.ConvertSingleWithTargetSize(job, token, s => {
                    if (s == "verifying") { task.Status = "verifying"; TaskPlanner.SaveManifest(doc); }
                }, log, p => {
                    if (onProgress != null) onProgress(task, p);
                }, sharedBakeCache, sharedBakeDir);
                task.ActualOutputBytes = rep.ActualBytes;
                task.VerificationLevel = rep.Level;
                task.VerificationPassed = rep.Passed;
                task.Status = rep.Passed ? "succeeded" : "failed";
                if (!rep.Passed) { task.ErrorCode = "verify-failed"; task.ErrorMessage = rep.Message; failed++; }
            } catch (OperationCanceledException) {
                task.Status = "canceled";
                task.UpdatedUtc = DateTime.UtcNow.ToString("O");
                TaskPlanner.SaveManifest(doc);
                return 5;
            } catch (Exception ex) {
                var diag = Diagnostics.Classify(ex, job.Device);
                task.Status = "failed";
                task.ErrorCode = diag.Code;
                task.ErrorMessage = ex.Message;
                failed++;
                log("[FAILED] " + task.TaskId + ": " + ex.Message);
            }
            task.UpdatedUtc = DateTime.UtcNow.ToString("O");
            TaskPlanner.SaveManifest(doc);
        }
        return failed == 0 ? 0 : 4;
        } finally {
            PortablePaths.SafeDeleteManagedSubdir(PortablePaths.TmpDir, sharedBakeDir);
        }
    }
}
