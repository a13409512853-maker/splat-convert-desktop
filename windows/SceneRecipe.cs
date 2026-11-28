using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

sealed class EncoderSettingsSnapshot {
    public Format Format;
    public bool AdaptiveDecimate = true;
    public int Keep = 100;
    public int Iterations = 10;
    public int Effort = -1;
    public int Workers = 4;
    public string VoxelSize = "0.05";
    public string Opacity = "0.1";
    public string Device = "auto";
    public int SogVersion = 3;
    public double? ShColorError;
    public int SpzVersion = 4;
    public bool PlyLogitOpacity;
    public bool HtmlUnbundled;
    public bool VoxelExternalFill;
    public bool VoxelFloorFill;
    public bool VoxelCarve;
    public string SeedPos = "0,0,0";
    public string CollisionMesh = "";
    public long TargetMaxBytes;
    public int MinKeepPct = 20;
    public int MaxAttempts = 3;
    public List<Op> OutputOps = new List<Op>();

    internal object ToWebSummary() {
        return new {
            formatSuffix = Format != null ? Format.Suffix : ".ply",
            formatName = Format != null ? Format.Name : "PLY",
            keep = Keep,
            adaptiveDecimate = AdaptiveDecimate,
            iterations = Iterations,
            effort = Effort,
            workers = Workers,
            device = Device,
            sogVersion = SogVersion,
            spzVersion = SpzVersion,
            plyLogitOpacity = PlyLogitOpacity,
            htmlUnbundled = HtmlUnbundled
        };
    }
}

sealed class SceneRecipe {
    public int version { get; set; }
    public string coordSystem { get; set; }
    public object[] rules { get; set; }
    public int[] deletedIndices { get; set; }
    public int[] keepIndices { get; set; }
    public object[] bakedColors { get; set; }
    public object[] deletedRanges { get; set; }
    public object[] objects { get; set; }
    public object[] groups { get; set; }
    public object volumes { get; set; }
    public int[] exportObjectIds { get; set; }
    public double[] translation { get; set; }
    public double[] rotation { get; set; }
    public double scale { get; set; }

    internal static JavaScriptSerializer CreateSerializer() {
        return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 256 };
    }

    internal static string ResolveRawJson(string opValue) {
        if (String.IsNullOrEmpty(opValue)) return null;
        if (opValue.StartsWith("@file:", StringComparison.Ordinal)) {
            string relOrFull = opValue.Substring(6).Trim();
            string resolved = PortablePaths.ResolveStrictlyInside(PortablePaths.TmpDir, relOrFull);
            return File.ReadAllText(resolved, Encoding.UTF8);
        }
        return opValue;
    }

    internal static string StoreIfLarge(string rawJson) {
        if (String.IsNullOrEmpty(rawJson) || rawJson.Length < 131072) return rawJson;
        Directory.CreateDirectory(PortablePaths.RecipesDir);
        string path = Path.Combine(PortablePaths.RecipesDir, "recipe-" + Guid.NewGuid().ToString("N") + ".json");
        PortablePaths.AtomicWriteText(path, rawJson);
        return "@file:" + path;
    }

    internal static SceneRecipe Parse(string opValue, out string resolvedJson) {
        resolvedJson = ResolveRawJson(opValue);
        if (String.IsNullOrWhiteSpace(resolvedJson)) throw new InvalidDataException(I18n.T("app.sceneRecipe.invalid"));
        var recipe = CreateSerializer().Deserialize<SceneRecipe>(resolvedJson);
        if (recipe == null) throw new InvalidDataException(I18n.T("app.sceneRecipe.invalid"));
        recipe.Check();
        return recipe;
    }

    internal bool IsV3() {
        return version == 3 || version == 4;
    }

    internal bool HasFilterPayload() {
        if (version == 3 || version == 4) return true;
        return (rules != null && rules.Length > 0)
            || (deletedIndices != null && deletedIndices.Length > 0)
            || (keepIndices != null && keepIndices.Length > 0)
            || (bakedColors != null && bakedColors.Length > 0)
            || (deletedRanges != null && deletedRanges.Length > 0);
    }

    internal void Check() {
        if (version == 4) return;
        if (version == 3) {
            if (objects == null || objects.Length == 0)
                throw new InvalidDataException(I18n.T("app.sceneRecipe.missingObjects"));
            return;
        }
        if ((version != 1 && version != 2) || rules == null || rules.Length > 256 || !Triple(translation) || !Triple(rotation) || !(scale > 0) || Double.IsInfinity(scale))
            throw new InvalidDataException(I18n.T("app.sceneRecipe.invalid"));
    }

    static bool Triple(double[] a) { return a != null && a.Length == 3 && a.All(n => !Double.IsNaN(n) && !Double.IsInfinity(n)); }
    static string F(double v) { return v.ToString("R", CultureInfo.InvariantCulture); }

    internal void AppendTransform(List<string> args) {
        if (version == 3 || version == 4) return; // v3/v4 apply exact 4x4 + SH rotation directly inside worker.mjs
        if (Math.Abs(scale - 1d) > 1e-6) args.AddRange(new[] { "--scale", F(scale) });
        if (rotation != null && rotation.Any(n => Math.Abs(n) > 1e-6)) args.AddRange(new[] { "--rotate", String.Join(",", rotation.Select(F)) });
        if (translation != null && translation.Any(n => Math.Abs(n) > 1e-6)) args.AddRange(new[] { "--translate", String.Join(",", translation.Select(F)) });
    }
}
