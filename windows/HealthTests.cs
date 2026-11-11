using System;
using System.IO;
using System.Linq;

static class HealthTests {
    public static void Run(string folder, Action<string> log) {
        var memory = Diagnostics.Classify(new IOException("RangeError: Array buffer allocation failed\n at gatherSogLayers (cli.mjs:41448:20)"), "auto");
        Check(memory.Code == "memory", "user allocation failure is classified as memory");
        Check(Diagnostics.Classify(new IOException("GPU device lost: out of memory"), "auto").Code == "gpu-memory", "GPU OOM is distinct");
        Check(Diagnostics.Classify(new IOException("ENOSPC: no space left on device"), "auto").Code == "disk", "disk full");
        Check(Diagnostics.Classify(new UnauthorizedAccessException(), "cpu").Code == "access", "permission error");
        Check(Diagnostics.Classify(new IOException("unrecognized exception"), "cpu").Code == "unknown", "unknown stays unknown");
        var estimate = Budget.FromCounts(34900000, 3, 4, false);
        Check(Math.Abs(estimate.BaseBytes - 8236400000d) < 1, "34.9M SH3 base bytes match engine allocations");
        var abundant = new ResourceSnapshot { TotalMemory = 64e9, AvailableMemory = 50e9, CommitAvailable = 60e9, Sampled = DateTime.UtcNow };
        Check(!Budget.Assess(estimate, abundant, "cpu").Any(), "large scene does not warn on ample RAM");
        var low = new ResourceSnapshot { TotalMemory = 16e9, AvailableMemory = 4e9, CommitAvailable = 5e9, Sampled = DateTime.UtcNow };
        Check(Budget.Assess(estimate, low, "cpu").Contains("ram"), "low available RAM warns");
        abundant.CommitAvailable = 1e9;
        Check(Budget.Assess(estimate, abundant, "cpu").Contains("commit"), "commit limit warns even with free RAM");
        abundant.CommitAvailable = 0;
        Check(Budget.Assess(estimate, abundant, "cpu").Contains("commit"), "exhausted commit is not treated as unknown");
        abundant.CommitAvailable = 60e9; abundant.Cpu = 100;
        Check(!Budget.Assess(estimate, abundant, "cpu").Any(), "busy CPU alone never warns");
        abundant.Sampled = DateTime.UtcNow.AddMinutes(-2); abundant.AvailableMemory = 1e6;
        Check(!Budget.Assess(estimate, abundant, "cpu").Any(), "stale metrics do not warn");
        Check(!Budget.Assess(estimate, new ResourceSnapshot(), "auto").Any(), "unknown values do not mean low resources");
        var source = Path.Combine(folder, "header-only.ply");
        File.WriteAllText(source, "ply\nformat binary_little_endian 1.0\nelement vertex 34900000\nproperty float x\n" + String.Join("\n", Enumerable.Range(0,45).Select(i=>"property float f_rest_"+i)) + "\nend_header\n");
        var job = new Job { Format = Converter.Formats[0], Keep = 100 };
        job.Inputs.Add(new InputFile(source));
        var full = Budget.Estimate(job);
        Check(full != null && full.Count == 34900000 && full.Bands == 3, "bounded PLY header reader");
        job.Ops.Add(new Op { Step = Step.All[4], Value = "1" });
        var reduced = Budget.Estimate(job);
        Check(reduced.Bands == 1 && reduced.BaseBytes < full.BaseBytes, "harmonic setting affects preflight");
        job.Keep = 50;
        Check(Budget.Estimate(job).ReductionBytes > 0, "decimation input memory is not ignored");
        job.Format = Converter.Formats[1]; job.Keep = 100;
        Check(Budget.Estimate(job) == null, "streaming PLY not estimated as full SOG");
        foreach (string lang in I18n.Codes) {
            I18n.Language = lang;
            Check(I18n.MissingKeys().Length == 0, "complete locale " + lang);
        }
        I18n.Language = "zh";
        log("PASS resource policy, metadata estimate, allocation error classification and all language catalogs");
    }
    static void Check(bool condition, string message) { if (!condition) throw new Exception("FAIL " + message); }
}
