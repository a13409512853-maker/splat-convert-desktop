using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

sealed class SogLayerBreakdown {
    public string Category; // positions | geometry | sh0 | shN | blind | meta | overhead | other
    public long UncompressedBytes;
    public long CompressedBytes;
    public int EntryCount;
}

sealed class FormatCompatibility {
    public string TargetFormat;
    public string Attribute;
    public string Status; // preserved | converted | clamped | dropped | unknown
    public string Reason;
}

sealed class InspectionResult {
    public string Path;
    public string Format;
    public string FormatVersion;
    public bool IsGaussian = true;
    public bool Readable;
    public string Error;
    public long FileBytes;
    public long SplatCount;
    public int ShBands;            // Supports 0..4!
    public int LodLevels = 1;
    public bool Antialiased;
    public bool Is2DGS;
    public bool HasOpacityLinear;
    public bool HasBlindData;
    public List<string> ExtraColumns = new List<string>();
    public List<SogLayerBreakdown> SogBreakdown = new List<SogLayerBreakdown>();
    public List<FormatCompatibility> Compatibility = new List<FormatCompatibility>();
    public string InspectionDepth = "light"; // light | deep
    public string Fingerprint;
    public string FingerprintAlgo = "quick-sha256";
}

static class SplatInspector {
    internal static string QuickFingerprint(string path) {
        try {
            var fi = new FileInfo(path);
            if (!fi.Exists) return "";
            using (var sha = SHA256.Create())
            using (var fs = File.OpenRead(path)) {
                byte[] head = new byte[Math.Min(65536, fi.Length)];
                int hRead = fs.Read(head, 0, head.Length);
                sha.TransformBlock(head, 0, hRead, null, 0);
                if (fi.Length > 65536) {
                    fs.Seek(Math.Max(0, fi.Length - 65536), SeekOrigin.Begin);
                    byte[] tail = new byte[Math.Min(65536, fi.Length - 65536)];
                    int tRead = fs.Read(tail, 0, tail.Length);
                    sha.TransformBlock(tail, 0, tRead, null, 0);
                }
                byte[] meta = Encoding.UTF8.GetBytes(fi.Length.ToString(CultureInfo.InvariantCulture) + "|" + fi.LastWriteTimeUtc.Ticks);
                sha.TransformFinalBlock(meta, 0, meta.Length);
                return BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
            }
        } catch { return ""; }
    }

    internal static InspectionResult InspectLight(string path) {
        var res = new InspectionResult { Path = path, InspectionDepth = "light" };
        try {
            if (!File.Exists(path)) { res.Error = "File not found"; return res; }
            var fi = new FileInfo(path);
            res.FileBytes = fi.Length;
            res.Fingerprint = QuickFingerprint(path);
            string ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
            res.Format = ext.TrimStart('.');

            if (ext == ".ply") InspectPly(path, res);
            else if (ext == ".sog") InspectSog(path, res);
            else if (ext == ".spz") InspectSpz(path, res);
            else if (ext == ".splat") InspectSplat(path, res);
            else if (ext == ".glb") InspectGlb(path, res);
            else if (ext == ".ksplat" || ext == ".lcc" || ext == ".lcc2") {
                res.Readable = fi.Length > 0;
                res.FormatVersion = "container";
            } else {
                res.Error = "Unsupported format: " + ext;
            }

            if (res.Readable) BuildCompatibilityMatrix(res);
        } catch (Exception ex) {
            res.Readable = false;
            res.Error = ex.Message;
        }
        return res;
    }

    static void InspectPly(string path, InspectionResult res) {
        using (var fs = File.OpenRead(path)) {
            byte[] buf = new byte[(int)Math.Min(1048576, fs.Length)];
            int read = fs.Read(buf, 0, buf.Length);
            string text = Encoding.ASCII.GetString(buf, 0, read);
            int end = text.IndexOf("end_header", StringComparison.Ordinal);
            if (end < 0) { res.Error = "Missing PLY end_header"; return; }

            using (var sr = new StringReader(text.Substring(0, end) + "end_header\n")) {
                if ((sr.ReadLine() ?? "").Trim() != "ply") { res.Error = "Invalid PLY magic"; return; }
                bool inVertex = false, hasScale0 = false, hasScale2 = false, hasOpacity = false, hasRot = false, compressed = false;
                int restCount = 0;
                string line;
                var stdCols = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
                    "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "opacity_linear",
                    "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
                    "packed_position", "packed_rotation", "packed_scale", "packed_color"
                };
                while ((line = sr.ReadLine()) != null) {
                    string t = line.Trim();
                    if (t.StartsWith("comment ", StringComparison.OrdinalIgnoreCase)) {
                        if (t.IndexOf("SplatRenderMode: mip", StringComparison.OrdinalIgnoreCase) >= 0 || t.IndexOf("anti_aliasing=1", StringComparison.OrdinalIgnoreCase) >= 0) res.Antialiased = true;
                        if (t.IndexOf("SplatRenderMode: 2dgs", StringComparison.OrdinalIgnoreCase) >= 0) res.Is2DGS = true;
                        continue;
                    }
                    var parts = t.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 3 && parts[0] == "element") {
                        inVertex = parts[1] == "vertex";
                        if (inVertex) Int64.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out res.SplatCount);
                    } else if (inVertex && parts.Length >= 3 && parts[0] == "property") {
                        string col = parts[2];
                        if (col == "packed_position") compressed = true;
                        else if (col == "scale_0") hasScale0 = true;
                        else if (col == "scale_2") hasScale2 = true;
                        else if (col == "opacity") hasOpacity = true;
                        else if (col == "opacity_linear") { hasOpacity = true; res.HasOpacityLinear = true; }
                        else if (col == "rot_0") hasRot = true;
                        else if (col.StartsWith("f_rest_", StringComparison.OrdinalIgnoreCase)) restCount++;
                        else if (!stdCols.Contains(col)) res.ExtraColumns.Add(col);
                    }
                }
                res.Format = compressed ? "compressed.ply" : "ply";
                res.FormatVersion = compressed ? "playcanvas-compressed" : "binary-1.0";
                if (!compressed && !(hasScale0 && hasOpacity && hasRot)) res.IsGaussian = false;
                if (hasScale0 && !hasScale2) res.Is2DGS = true;
                // Full 0..4 SH band support! (band 1 = 9, band 2 = 24, band 3 = 45, band 4 = 72)
                res.ShBands = restCount >= 72 ? 4 : restCount >= 45 ? 3 : restCount >= 24 ? 2 : restCount >= 9 ? 1 : 0;
                res.Readable = res.SplatCount > 0;
                if (!res.Readable) res.Error = "PLY vertex count is 0";
            }
        }
    }

    static void InspectSog(string path, InspectionResult res) {
        using (var fs = File.OpenRead(path))
        using (var zip = new ZipArchive(fs, ZipArchiveMode.Read)) {
            var metaEntry = zip.GetEntry("meta.json");
            if (metaEntry == null) { res.Error = "Missing meta.json in SOG archive"; return; }
            using (var sr = new StreamReader(metaEntry.Open(), Encoding.UTF8)) {
                var json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(sr.ReadToEnd());
                if (json == null || !json.ContainsKey("count")) { res.Error = "Invalid meta.json in SOG"; return; }
                res.SplatCount = Convert.ToInt64(json["count"], CultureInfo.InvariantCulture);
                object verObj;
                res.FormatVersion = json.TryGetValue("version", out verObj) ? "v" + Convert.ToString(verObj, CultureInfo.InvariantCulture) : "v2";
                object modelObj;
                if (json.TryGetValue("model", out modelObj)) {
                    string m = Convert.ToString(modelObj, CultureInfo.InvariantCulture);
                    if (m == "antialiased") res.Antialiased = true;
                    if (m == "2dgs") res.Is2DGS = true;
                }
                object shObj;
                if (json.TryGetValue("shN", out shObj) && shObj is Dictionary<string, object>) {
                    var sh = (Dictionary<string, object>)shObj;
                    object bObj;
                    if (sh.TryGetValue("bands", out bObj)) res.ShBands = Math.Max(0, Math.Min(4, Convert.ToInt32(bObj, CultureInfo.InvariantCulture)));
                }
                if (json.ContainsKey("blind")) res.HasBlindData = true;
            }

            // Reconcile every ZIP entry into exact byte breakdown (never double-counting container overhead)
            var buckets = new Dictionary<string, SogLayerBreakdown>();
            long totalCompressed = 0;
            foreach (var entry in zip.Entries) {
                string name = entry.Name.ToLowerInvariant();
                string cat = "other";
                if (name == "meta.json") cat = "meta";
                else if (name.Contains("means")) cat = "positions";
                else if (name.Contains("scale") || name.Contains("quat") || name.Contains("rot")) cat = "geometry";
                else if (name.Contains("sh0")) cat = "sh0";
                else if (name.Contains("shn") || name.Contains("sh_")) cat = "shN";
                else if (name.Contains("blind")) { cat = "blind"; res.HasBlindData = true; }

                SogLayerBreakdown b;
                if (!buckets.TryGetValue(cat, out b)) { b = new SogLayerBreakdown { Category = cat }; buckets[cat] = b; }
                b.UncompressedBytes += entry.Length;
                b.CompressedBytes += entry.CompressedLength;
                b.EntryCount++;
                totalCompressed += entry.CompressedLength;
            }
            long overhead = Math.Max(0, res.FileBytes - totalCompressed);
            if (overhead > 0) buckets["overhead"] = new SogLayerBreakdown { Category = "overhead", UncompressedBytes = overhead, CompressedBytes = overhead, EntryCount = 0 };
            res.SogBreakdown.AddRange(buckets.Values.OrderByDescending(x => x.CompressedBytes));
            res.Readable = res.SplatCount > 0;
        }
    }

    static void InspectSpz(string path, InspectionResult res) {
        using (var fs = File.OpenRead(path)) {
            var hdr = new byte[16];
            int rawRead = fs.Read(hdr, 0, 16);
            if (rawRead < 16) { res.Error = "Truncated SPZ header"; return; }
            if (hdr[0] == 0x1F && hdr[1] == 0x8B) {
                // SPZ v2/v3: GZip-wrapped NGSP header
                fs.Position = 0;
                using (var gz = new GZipStream(fs, CompressionMode.Decompress)) {
                    int n = gz.Read(hdr, 0, 16);
                    if (n < 16) { res.Error = "Truncated gzipped SPZ header"; return; }
                }
            }
            uint magic = BitConverter.ToUInt32(hdr, 0);
            if (magic != 0x5053474Eu) { res.Error = "Invalid SPZ magic"; return; }
            uint ver = BitConverter.ToUInt32(hdr, 4);
            uint numPoints = BitConverter.ToUInt32(hdr, 8);
            byte shDegree = hdr[12];
            byte flags = hdr[14];
            res.Format = "spz";
            res.FormatVersion = "v" + ver;
            res.SplatCount = numPoints;
            res.ShBands = Math.Max(0, Math.Min(4, (int)shDegree));
            res.Antialiased = (flags & 1) != 0;
            res.Readable = numPoints > 0;
        }
    }

    static void InspectSplat(string path, InspectionResult res) {
        res.Format = "splat";
        res.FormatVersion = "antimatter15-32B";
        res.SplatCount = res.FileBytes / 32;
        res.ShBands = 0;
        res.Readable = res.FileBytes > 0 && res.FileBytes % 32 == 0;
        if (!res.Readable) res.Error = "SPLAT byte length is not a multiple of 32";
    }

    static void InspectGlb(string path, InspectionResult res) {
        using (var fs = File.OpenRead(path)) {
            var hdr = new byte[12];
            if (fs.Read(hdr, 0, 12) < 12 || BitConverter.ToUInt32(hdr, 0) != 0x46546C67u) {
                res.Error = "Invalid GLB header"; return;
            }
            res.Format = "glb";
            res.FormatVersion = "glTF-" + BitConverter.ToUInt32(hdr, 4);
            res.Readable = true;
        }
    }

    static void BuildCompatibilityMatrix(InspectionResult res) {
        // SOG v3
        res.Compatibility.Add(Compat(".sog", "SH Bands (" + res.ShBands + ")", "preserved", I18n.T("app.inspector.compatSogSh")));
        if (res.Is2DGS) res.Compatibility.Add(Compat(".sog", "2DGS Tag", "preserved", I18n.T("app.inspector.compatSog2dgs")));
        if (res.HasBlindData) res.Compatibility.Add(Compat(".sog", "Blind Data", "preserved", I18n.T("app.inspector.compatSogBlind")));
        // SPZ
        res.Compatibility.Add(Compat(".spz", "SH Bands (" + res.ShBands + ")", res.ShBands > 3 ? "clamped" : "preserved", I18n.T(res.ShBands > 3 ? "app.inspector.compatSpzShClamped" : "app.inspector.compatSpzShOk")));
        if (res.Is2DGS) res.Compatibility.Add(Compat(".spz", "2DGS Tag", "dropped", I18n.T("app.inspector.compatSpz2dgs")));
        if (res.HasBlindData) res.Compatibility.Add(Compat(".spz", "Blind Data", "dropped", I18n.T("app.inspector.compatSpzBlind")));
        // PLY
        res.Compatibility.Add(Compat(".ply", "SH Bands (" + res.ShBands + ")", "preserved", I18n.T("app.inspector.compatPlySh")));
        if (res.HasOpacityLinear) res.Compatibility.Add(Compat(".ply", "Opacity > 1", "converted", I18n.T("app.inspector.compatPlyOpacity")));
        // Compressed PLY
        res.Compatibility.Add(Compat(".compressed.ply", "Precision", "converted", I18n.T("app.inspector.compatCompressed")));
        // Voxel
        res.Compatibility.Add(Compat(".voxel.zip", "Appearance / SH", "dropped", I18n.T("app.inspector.compatVoxel")));
    }

    static FormatCompatibility Compat(string fmt, string attr, string status, string reason) {
        return new FormatCompatibility { TargetFormat = fmt, Attribute = attr, Status = status, Reason = reason };
    }
}
