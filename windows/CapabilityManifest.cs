using System;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;

sealed class CapabilityItem {
    public string Id, Flag, ShortFlag, Category, ValueType, DefaultValue, Range, Status, SafetyLevel;
    public bool Repeatable, Ordered, HasReason;
    public string[] ApplicableFormats;

    public string Label { get { return I18n.T("app.capability." + Id + ".label"); } }
    public string Desc { get { return I18n.T("app.capability." + Id + ".desc"); } }
    public string Reason { get { return HasReason ? I18n.T("app.capability." + Id + ".reason") : null; } }
}

static class CapabilityManifest {
    internal const string EngineTargetVersion = "3.12.0";
    internal const int SchemaVersion = 1;

    // Complete registry of @playcanvas/splat-transform 3.12.0 CLI capabilities.
    // Every flag is explicitly marked: implemented | not-supported-with-reason | pending.
    internal static readonly CapabilityItem[] All = {
        // Transform actions
        Item("translate", "--translate", "-t", "transform", "vec3", "0,0,0", "x,y,z", true, true, "implemented", "safe", null, false),
        Item("rotate", "--rotate", "-r", "transform", "vec3", "0,0,0", "deg x,y,z", true, true, "implemented", "safe", null, false),
        Item("scale", "--scale", "-s", "transform", "number", "1", "> 0", true, true, "implemented", "safe", null, false),
        Item("morton", "--morton-order", "-m", "transform", "bool", "false", "flag", false, true, "implemented", "safe", null, false),

        // Filter actions
        Item("filter_nan", "--filter-nan", "-N", "filter", "bool", "true", "flag", false, true, "implemented", "safe", null, false),
        Item("filter_sh", "--filter-harmonics", "-H", "filter", "int", "4", "0..4", false, true, "implemented", "safe", null, false),
        Item("filter_box", "--filter-box", "-B", "filter", "box6", "-10,-10,-10,10,10,10", "minX..maxZ", true, true, "implemented", "safe", null, false),
        Item("filter_sphere", "--filter-sphere", "-S", "filter", "sphere4", "0,0,0,10", "x,y,z,r>0", true, true, "implemented", "safe", null, false),
        Item("filter_value", "--filter-value", "-V", "filter", "expr", "opacity,gt,0.1", "col,cmp,val", true, true, "implemented", "safe", null, false),
        Item("filter_floaters", "--filter-floaters", "-F", "filter", "vec3?", "0.05,0.1,0.004", "size,op,min", false, true, "implemented", "safe", null, false),
        Item("filter_cluster", "--filter-cluster", "-C", "filter", "vec3?", "1.0,0.999,0.1", "res,op,min", false, true, "implemented", "safe", null, false),

        // Decimation
        Item("decimate_uniform", "--decimate", "-d", "decimate", "percent|count", "100%", "1%..100%", false, true, "implemented", "safe", null, false),
        Item("decimate_adaptive", "--decimate-adaptive", "", "decimate", "percent|count", "100%", "1%..100%", false, true, "implemented", "safe", null, false),
        Item("scratch_dir", "--scratch-dir", "", "decimate", "path", "data/tmp", "managed", false, false, "implemented", "safe", null, false),

        // SOG & HTML options
        Item("sh_iterations", "--sh-iterations", "-i", "sog", "int", "10", "1..100", false, false, "implemented", "safe", new[] { ".sog", ".html" }, false),
        Item("sh_color_error", "--sh-color-error", "", "sog", "number", "5", "0.5..30", false, false, "implemented", "safe", new[] { ".sog", ".html" }, false),
        Item("sh_palette_size", "--sh-palette-size", "", "sog", "int", "0", "0..262144", false, false, "implemented", "safe", new[] { ".sog", ".html" }, false),
        Item("sog_version", "--sog-version", "", "sog", "enum", "3", "2|3", false, false, "implemented", "safe", new[] { ".sog", ".html" }, false),
        Item("webp_effort", "--webp-effort", "", "sog", "int", "-1", "-1..9", false, false, "implemented", "safe", new[] { ".sog", ".html", ".webp" }, false),
        Item("html_unbundled", "--unbundled", "", "html", "bool", "false", "flag", false, false, "implemented", "safe", new[] { ".html" }, false),
        Item("viewer_settings", "--viewer-settings", "", "html", "file", "", "json", false, false, "implemented", "safe", new[] { ".html" }, false),

        // SPZ & PLY options
        Item("spz_version", "--spz-version", "", "spz", "enum", "4", "3|4", false, false, "implemented", "safe", new[] { ".spz" }, false),
        Item("ply_logit", "--ply-logit-opacity", "", "ply", "bool", "false", "flag", false, false, "implemented", "safe", new[] { ".ply" }, false),

        // Voxel & Collision
        Item("voxel_size", "--voxel-size", "", "voxel", "number", "0.05", "0.005..2.0", false, false, "implemented", "safe", new[] { ".voxel.zip" }, false),
        Item("voxel_opacity", "--voxel-opacity", "", "voxel", "number", "0.1", "0..1", false, false, "implemented", "safe", new[] { ".voxel.zip" }, false),
        Item("voxel_ext_fill", "--voxel-external-fill", "", "voxel", "bool", "false", "flag", false, false, "implemented", "safe", new[] { ".voxel.zip" }, false),
        Item("voxel_floor_fill", "--voxel-floor-fill", "", "voxel", "bool", "false", "flag", false, false, "implemented", "safe", new[] { ".voxel.zip" }, false),
        Item("voxel_carve", "--voxel-carve", "", "voxel", "bool", "false", "flag", false, false, "implemented", "safe", new[] { ".voxel.zip" }, false),
        Item("seed_pos", "--seed-pos", "", "voxel", "vec3", "0,0,0", "x,y,z", false, false, "implemented", "safe", new[] { ".voxel.zip" }, false),
        Item("collision_mesh", "--collision-mesh", "", "voxel", "enum", "none", "none|smooth|faces", false, false, "implemented", "safe", new[] { ".voxel.zip" }, false),

        // LOD / Streamed SOG
        Item("lod_select", "--select-lod", "-L", "lod", "list", "", "0,1,...", false, false, "implemented", "safe", null, false),
        Item("lod_chunk", "--lod-chunk-count", "", "lod", "int", "512", "16..4096", false, false, "implemented", "safe", new[] { "lod-meta.json" }, false),

        // Hardware & Diagnostics
        Item("gpu", "--gpu", "-g", "gpu", "enum", "auto", "auto|cpu|index", false, false, "implemented", "safe", null, false),
        Item("gpu_backend", "--gpu-backend", "", "gpu", "enum", "default", "default|vulkan|d3d12", false, false, "implemented", "safe", null, false),
        Item("max_workers", "--max-workers", "", "gpu", "int", "4", "0..16", false, false, "implemented", "safe", null, false),
        Item("info_stats", "--info / --stats", "", "diagnostics", "json", "json", "readonly", false, false, "implemented", "safe", null, false),

        // Explicitly gated / not-supported-with-reason items (100% accounted for!)
        Item("mjs_generator", ".mjs generator", "-p", "security", "script", "", "disabled", false, false, "not-supported-with-reason", "requires-auth", null, true),
        Item("remote_url", "Remote URL Input", "", "security", "url", "", "disabled", false, false, "not-supported-with-reason", "requires-auth", null, true),
        Item("camera_render", "--camera-track / .webp", "", "render", "render", "", "pending", false, false, "pending", "safe", new[] { ".webp" }, true)
    };

    static CapabilityItem Item(string id, string flag, string shortFlag, string cat, string vtype, string def, string range, bool rep, bool ord, string status, string safety, string[] fmts, bool hasReason) {
        return new CapabilityItem {
            Id = id, Flag = flag, ShortFlag = shortFlag, Category = cat, ValueType = vtype, DefaultValue = def, Range = range,
            Repeatable = rep, Ordered = ord, Status = status, SafetyLevel = safety, ApplicableFormats = fmts, HasReason = hasReason
        };
    }

    internal static IEnumerable<CapabilityItem> Search(string query, string formatSuffix) {
        string q = (query ?? "").Trim().ToLowerInvariant();
        foreach (var item in All) {
            if (!String.IsNullOrEmpty(q)) {
                bool hit = (item.Flag ?? "").ToLowerInvariant().Contains(q)
                    || (item.ShortFlag ?? "").ToLowerInvariant().Contains(q)
                    || (item.Label ?? "").ToLowerInvariant().Contains(q)
                    || (item.Desc ?? "").ToLowerInvariant().Contains(q)
                    || (item.Category ?? "").ToLowerInvariant().Contains(q);
                if (!hit) continue;
            }
            yield return item;
        }
    }

    internal static bool IsApplicable(CapabilityItem item, string formatSuffix) {
        if (item.ApplicableFormats == null || item.ApplicableFormats.Length == 0 || String.IsNullOrEmpty(formatSuffix)) return true;
        return item.ApplicableFormats.Any(f => String.Equals(f, formatSuffix, StringComparison.OrdinalIgnoreCase));
    }

    internal static string ToHelpJson() {
        var doc = new Dictionary<string, object> {
            { "app", "Splat Convert Desktop" },
            { "version", "1.9.0" },
            { "schemaVersion", SchemaVersion },
            { "bundledEngineVersion", EngineTargetVersion },
            { "portableMode", true },
            { "coordSystem", "z-up" },
            { "sceneEditor", new { inputOp="--scene-edit", version=3, value="JSON string (v1/v2/v3) or @file:<path>: non-destructive +Z-up multi-object/SH-bake/delete/volume recipe.", scope="First input operation. Never modifies original source files on disk.", modes=new[]{"replace","add","subtract","intersect"}, shapes=new[]{"box","ellipsoid","cylinder","plane","rect","ellipse","lasso","poly","brush"} } },
            { "commands", new object[] {
                new Dictionary<string, object> { { "name", "--help --json" }, { "mode", "readonly" }, { "desc", "Output embedded capability & CLI contract schema without loading engine or writing files." } },
                new Dictionary<string, object> { { "name", "inspect --input <path> [--deep]" }, { "mode", "readonly" }, { "desc", "Inspect splat container, 0-4 SH bands, SOG layer breakdown, and format compatibility matrix." } },
                new Dictionary<string, object> { { "name", "plan --job <job.json>" }, { "mode", "readonly" }, { "desc", "Validate job, check conflicts/budgets, and output immutable planDigest." } },
                new Dictionary<string, object> { { "name", "run --job <job.json> [--resume]" }, { "mode", "execute" }, { "desc", "Execute confirmed job plan with resumable manifest and post-export verification." } },
                new Dictionary<string, object> { { "name", "verify --job <job.json>" }, { "mode", "readonly" }, { "desc", "Re-read and verify all generated outputs of a job manifest." } }
            } },
            { "exitCodes", new Dictionary<string, int> {
                { "success", 0 }, { "invalidArgs", 2 }, { "preflightRejected", 3 }, { "partialFailure", 4 },
                { "canceled", 5 }, { "verificationFailed", 6 }, { "portableDirNotWritable", 7 }
            } },
            { "capabilities", All }
        };
        return new JavaScriptSerializer().Serialize(doc);
    }
}
