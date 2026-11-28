using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class CliInterface {
    [DllImport("kernel32.dll")] static extern bool AttachConsole(int dwProcessId);

    internal static bool IsCliInvocation(string[] args) {
        if (args == null || args.Length == 0) return false;
        string cmd = args[0].ToLowerInvariant();
        return cmd == "--help" || cmd == "-h" || cmd == "inspect" || cmd == "plan" || cmd == "run" || cmd == "verify";
    }

    internal static int Execute(string[] args) {
        try { AttachConsole(-1); } catch { }
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        var json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };

        try {
            string cmd = args[0].ToLowerInvariant();
            if (cmd == "--help" || cmd == "-h") {
                // Strictly read-only: never loads engine, never writes any file!
                Console.WriteLine(CapabilityManifest.ToHelpJson());
                return 0;
            }
            if (cmd == "inspect") {
                string input = GetArg(args, "--input");
                if (String.IsNullOrWhiteSpace(input)) return EmitError(json, 2, "invalid-args", "Missing --input <path>");
                var res = SplatInspector.InspectLight(PortablePaths.ResolvePortableOrAbsolute(input));
                if (args.Contains("--deep") && res.Readable) {
                    using (var conv = new Converter()) {
                        res.InspectionDepth = "deep";
                        string rawStats = conv.RunInfoStats(res.Path, CancellationToken.None);
                        Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "inspection", res }, { "engineStats", rawStats } }));
                        return 0;
                    }
                }
                Console.WriteLine(json.Serialize(res));
                return res.Readable ? 0 : 2;
            }
            if (cmd == "plan") {
                string jobPath = GetArg(args, "--job");
                if (String.IsNullOrWhiteSpace(jobPath)) return EmitError(json, 2, "invalid-args", "Missing --job <job.json>");
                string writeErr;
                if (!PortablePaths.EnsureWritable(out writeErr)) return EmitError(json, 7, "not-writable", writeErr);
                var doc = TaskPlanner.LoadManifest(PortablePaths.ResolvePortableOrAbsolute(jobPath));
                var plan = TaskPlanner.Plan(doc);
                Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "plan", plan }, { "tasks", doc.Tasks } }));
                return plan.Ready ? 0 : 3;
            }
            if (cmd == "run") {
                string jobPath = GetArg(args, "--job");
                if (String.IsNullOrWhiteSpace(jobPath)) return EmitError(json, 2, "invalid-args", "Missing --job <job.json>");
                string writeErr;
                if (!PortablePaths.EnsureWritable(out writeErr)) return EmitError(json, 7, "not-writable", writeErr);
                var doc = TaskPlanner.LoadManifest(PortablePaths.ResolvePortableOrAbsolute(jobPath));
                string expectedDigest = doc.PlanDigest;
                var plan = TaskPlanner.Plan(doc);
                if (!plan.Ready) {
                    Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "event", "plan_rejected" }, { "plan", plan } }));
                    return 3;
                }
                if (!String.IsNullOrEmpty(expectedDigest) && expectedDigest != plan.PlanDigest && !args.Contains("--resume")) {
                    Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "event", "plan_stale" }, { "expected", expectedDigest }, { "actual", plan.PlanDigest } }));
                    return 3;
                }
                using (var conv = new Converter()) {
                    int code = TaskRunner.Run(doc, conv, CancellationToken.None,
                        msg => Console.Error.WriteLine(msg),
                        (task, p) => Console.WriteLine(json.Serialize(new Dictionary<string, object> {
                            { "event", "progress" }, { "taskId", task.TaskId }, { "stage", p.StageKey }, { "percent", Math.Round(p.Percent, 1) }
                        })));
                    Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "event", "complete" }, { "exitCode", code }, { "jobId", doc.JobId }, { "tasks", doc.Tasks } }));
                    return code;
                }
            }
            if (cmd == "verify") {
                string jobPath = GetArg(args, "--job");
                if (String.IsNullOrWhiteSpace(jobPath)) return EmitError(json, 2, "invalid-args", "Missing --job <job.json>");
                var doc = TaskPlanner.LoadManifest(PortablePaths.ResolvePortableOrAbsolute(jobPath));
                var reports = new List<object>();
                bool allOk = true;
                foreach (var t in doc.Tasks) {
                    var rep = ExportVerifier.Verify(t.ResolvedOutput, t.FormatSuffix);
                    if (!rep.Passed) allOk = false;
                    reports.Add(new Dictionary<string, object> { { "taskId", t.TaskId }, { "output", t.ResolvedOutput }, { "report", rep } });
                }
                Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "passed", allOk }, { "reports", reports } }));
                return allOk ? 0 : 6;
            }
            return EmitError(json, 2, "unknown-command", "Unknown command: " + cmd);
        } catch (UnauthorizedAccessException ex) {
            return EmitError(json, 7, "portable-access-denied", ex.Message);
        } catch (Exception ex) {
            return EmitError(json, 2, "error", ex.Message);
        }
    }

    static string GetArg(string[] args, string flag) {
        for (int i = 0; i < args.Length - 1; i++) {
            if (String.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        }
        return null;
    }

    static int EmitError(JavaScriptSerializer json, int code, string errCode, string msg) {
        Console.Error.WriteLine(json.Serialize(new Dictionary<string, object> { { "error", errCode }, { "message", msg }, { "exitCode", code } }));
        return code;
    }
}
