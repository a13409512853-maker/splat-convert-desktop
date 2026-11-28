using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

// M03: Unified Built-in Model Self-Healing Extractor + Global Multi-Mirror Smart Downloader
// Spec: UI与模块化工程设计规范.md §5.1 & 模块设计思路与架构档案.md M03
// - Bundled SAM 2.1 Hiera Tiny (FP16) + ORT WebGPU/WASM embedded inside EXE (`bundled_models.zip`),
//   extracted lazily on demand with full SHA-256 verification & self-healing if `data/models/` is deleted.
// - All online downloadable models expose a single Download button in UI; backend automatically
//   prioritizes CN mirrors (hf-mirror.com) when UI language is Chinese (zh-*), and International
//   mirrors (huggingface.co) for other languages, with fast connectivity probe & automatic failover.

sealed class ModelFileSpec {
    internal string LocalRelPath; // relative to PortablePaths.ModelsDir, e.g. "sam21_tiny_fp16/vision_encoder_fp16.onnx"
    internal string HfRepoPath;   // e.g. "onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/vision_encoder_fp16.onnx"
    internal long ExpectedBytes;
    internal string Sha256;
}

sealed class ManagedModelSpec {
    internal string Id;
    internal string Category;     // "semantic" | "inpaint"
    internal string Schema;       // "sam21-hf" | "mobilesam" | "lama"
    internal string DisplayNameKey;
    internal string ShortBadgeKey;
    internal string TooltipKey;
    internal bool Bundled;
    internal int ApproxSizeMb;
    internal ModelFileSpec[] Files;
    internal string DisplayName { get { return I18n.T(DisplayNameKey); } }
    internal string ShortBadge { get { return I18n.T(ShortBadgeKey); } }
    internal string Tooltip { get { return I18n.T(TooltipKey); } }
}

static class ModelManager {
    static readonly object ExtractLock = new object();
    static readonly ConcurrentDictionary<string, CancellationTokenSource> ActiveDownloads =
        new ConcurrentDictionary<string, CancellationTokenSource>(StringComparer.OrdinalIgnoreCase);

    static readonly string[] CnMirrors = { "https://hf-mirror.com/", "https://huggingface.co/" };
    static readonly string[] IntlMirrors = { "https://huggingface.co/", "https://hf-mirror.com/" };

    internal static readonly ModelFileSpec[] OrtFiles = {
        new ModelFileSpec {
            LocalRelPath = "ort/ort.webgpu.min.mjs",
            ExpectedBytes = 66348,
            Sha256 = "08272eb8dadd249a0eaa53e19f4e5b5d01bc8a121240719db29093cfb776bc27"
        },
        new ModelFileSpec {
            LocalRelPath = "ort/ort-wasm-simd-threaded.asyncify.mjs",
            ExpectedBytes = 51407,
            Sha256 = "5d25483158d53d8f34d0e9c06a654d56c8dca4ebdf370ea0982ef11315a00e0e"
        },
        new ModelFileSpec {
            LocalRelPath = "ort/ort-wasm-simd-threaded.asyncify.wasm",
            ExpectedBytes = 25749873,
            Sha256 = "503d17cb7411b79781b9fad1cf0978f03cf06b050c7d399c730e914f473bf549"
        }
    };

    internal static readonly ManagedModelSpec[] Catalog = {
        new ManagedModelSpec {
            Id = "sam21-tiny-fp16",
            Category = "semantic",
            Schema = "sam21-hf",
            DisplayNameKey = "app.models.sam21TinyName",
            ShortBadgeKey = "app.models.sam21TinyBadge",
            TooltipKey = "app.models.sam21TinyTooltip",
            Bundled = true,
            ApproxSizeMb = 74,
            Files = new[] {
                new ModelFileSpec {
                    LocalRelPath = "sam21_tiny_fp16/vision_encoder_fp16.onnx",
                    HfRepoPath = "onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/vision_encoder_fp16.onnx",
                    ExpectedBytes = 314925,
                    Sha256 = "7773e79d589dada8e1e630cc7eb18b17b2c5b4faeb1eaab5ebf9df618ecbd50a"
                },
                new ModelFileSpec {
                    LocalRelPath = "sam21_tiny_fp16/vision_encoder_fp16.onnx_data",
                    HfRepoPath = "onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/vision_encoder_fp16.onnx_data",
                    ExpectedBytes = 67005504,
                    Sha256 = "a4dd3759e9b6a476d991fb3493787992e78777e51462695e1bede71ae258103e"
                },
                new ModelFileSpec {
                    LocalRelPath = "sam21_tiny_fp16/prompt_encoder_mask_decoder_fp16.onnx",
                    HfRepoPath = "onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder_fp16.onnx",
                    ExpectedBytes = 229799,
                    Sha256 = "00ac7200451f246e8307aa1a1648113f47dc45625738406403a0e6b86c69fc55"
                },
                new ModelFileSpec {
                    LocalRelPath = "sam21_tiny_fp16/prompt_encoder_mask_decoder_fp16.onnx_data",
                    HfRepoPath = "onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder_fp16.onnx_data",
                    ExpectedBytes = 10454016,
                    Sha256 = "027b457a53f5bd76bb401c59555448451d04b4eab6d2f6a6758406b40133ee2c"
                }
            }
        },
        new ManagedModelSpec {
            Id = "mobilesam",
            Category = "semantic",
            Schema = "mobilesam",
            DisplayNameKey = "app.models.mobileSamName",
            ShortBadgeKey = "app.models.mobileSamBadge",
            TooltipKey = "app.models.mobileSamTooltip",
            Bundled = false,
            ApproxSizeMb = 43,
            Files = new[] {
                new ModelFileSpec {
                    LocalRelPath = "mobilesam/mobile_sam_image_encoder.onnx",
                    HfRepoPath = "Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx",
                    ExpectedBytes = 28154266,
                    Sha256 = "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749"
                },
                new ModelFileSpec {
                    LocalRelPath = "mobilesam/sam_mask_decoder_multi.onnx",
                    HfRepoPath = "Acly/MobileSAM/resolve/main/sam_mask_decoder_multi.onnx",
                    ExpectedBytes = 16494085,
                    Sha256 = "8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe"
                }
            }
        },
        new ManagedModelSpec {
            Id = "sam21-small-fp16",
            Category = "semantic",
            Schema = "sam21-hf",
            DisplayNameKey = "app.models.sam21SmallName",
            ShortBadgeKey = "app.models.sam21SmallBadge",
            TooltipKey = "app.models.sam21SmallTooltip",
            Bundled = false,
            ApproxSizeMb = 88,
            Files = new[] {
                new ModelFileSpec {
                    LocalRelPath = "sam21_small_fp16/vision_encoder_fp16.onnx",
                    HfRepoPath = "onnx-community/sam2.1-hiera-small-ONNX/resolve/main/onnx/vision_encoder_fp16.onnx",
                    ExpectedBytes = 0,
                    Sha256 = "f236074c31a7ba9d1e00362e8c29cb95bf9dcdd61e208048493902878d9dc4db"
                },
                new ModelFileSpec {
                    LocalRelPath = "sam21_small_fp16/vision_encoder_fp16.onnx_data",
                    HfRepoPath = "onnx-community/sam2.1-hiera-small-ONNX/resolve/main/onnx/vision_encoder_fp16.onnx_data",
                    ExpectedBytes = 0,
                    Sha256 = "557e013522bace72a6b8441f66747f1c4b2a237d1e3c86f84dba86b6d814ec1f"
                },
                new ModelFileSpec {
                    LocalRelPath = "sam21_small_fp16/prompt_encoder_mask_decoder_fp16.onnx",
                    HfRepoPath = "onnx-community/sam2.1-hiera-small-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder_fp16.onnx",
                    ExpectedBytes = 0,
                    Sha256 = "b36b0f515864220402b18054e37f236e7ef33486a7716fb45d0df17c64332392"
                },
                new ModelFileSpec {
                    LocalRelPath = "sam21_small_fp16/prompt_encoder_mask_decoder_fp16.onnx_data",
                    HfRepoPath = "onnx-community/sam2.1-hiera-small-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder_fp16.onnx_data",
                    ExpectedBytes = 0,
                    Sha256 = "33fc89eb7fb87fd638c7232a5bb6f8a1743bd4eee1a4aadca88a141f5b35945f"
                }
            }
        },
        new ManagedModelSpec {
            Id = "lama-fp32",
            Category = "inpaint",
            Schema = "lama",
            DisplayNameKey = "app.models.lamaName",
            ShortBadgeKey = "app.models.lamaBadge",
            TooltipKey = "app.models.lamaTooltip",
            Bundled = false,
            ApproxSizeMb = 198,
            Files = new[] {
                new ModelFileSpec {
                    LocalRelPath = "lama/lama_fp32.onnx",
                    HfRepoPath = "Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
                    ExpectedBytes = 0,
                    Sha256 = "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6"
                }
            }
        }
    };

    static ModelManager() {
        try {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288 | SecurityProtocolType.Tls12;
        } catch {
            try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; } catch { }
        }
        ServicePointManager.DefaultConnectionLimit = 8;
    }

    internal static ManagedModelSpec FindSpec(string modelId) {
        return Catalog.FirstOrDefault(m => String.Equals(m.Id, modelId, StringComparison.OrdinalIgnoreCase));
    }

    static string FullPathOf(string relPath) {
        return PortablePaths.ResolveStrictlyInside(PortablePaths.ModelsDir, relPath.Replace('/', Path.DirectorySeparatorChar));
    }

    static bool FileIsValid(ModelFileSpec spec, bool verifyHash) {
        string full = FullPathOf(spec.LocalRelPath);
        if (!File.Exists(full)) return false;
        try {
            var fi = new FileInfo(full);
            if (fi.Length <= 0) return false;
            if (spec.ExpectedBytes > 0 && fi.Length != spec.ExpectedBytes) return false;
            if (!verifyHash || String.IsNullOrEmpty(spec.Sha256)) return true;
            return String.Equals(ComputeSha256(full), spec.Sha256, StringComparison.OrdinalIgnoreCase);
        } catch {
            return false;
        }
    }

    internal static string ComputeSha256(string path) {
        using (var sha = SHA256.Create())
        using (var fs = File.OpenRead(path)) {
            return BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "").ToLowerInvariant();
        }
    }

    internal static bool IsOrtReady() {
        return OrtFiles.All(f => FileIsValid(f, false));
    }

    internal static bool IsModelInstalled(ManagedModelSpec spec) {
        if (spec == null) return false;
        return spec.Files.All(f => FileIsValid(f, false));
    }

    internal static bool HasEmbeddedBundle() {
        var asm = typeof(ModelManager).Assembly;
        return asm.GetManifestResourceInfo("bundled_models.zip") != null;
    }

    // Lazily extracts bundled ORT WebGPU/WASM + SAM 2.1 Hiera Tiny FP16 into data/models/ with self-healing
    internal static bool EnsureBundledExtracted(out string error) {
        error = null;
        lock (ExtractLock) {
            try {
                var bundledModel = FindSpec("sam21-tiny-fp16");
                if (IsOrtReady() && IsModelInstalled(bundledModel)) return true;

                Directory.CreateDirectory(PortablePaths.ModelsDir);
                var asm = typeof(ModelManager).Assembly;
                using (var stream = asm.GetManifestResourceStream("bundled_models.zip")) {
                    if (stream == null) {
                        error = I18n.T("app.models.missingBundle");
                        return false;
                    }
                    using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
                        foreach (var entry in zip.Entries) {
                            if (String.IsNullOrEmpty(entry.Name)) continue;
                            string rel = entry.FullName.Replace('\\', '/').TrimStart('/');
                            string dst = FullPathOf(rel);
                            if (File.Exists(dst) && new FileInfo(dst).Length == entry.Length && entry.Length > 0) {
                                continue;
                            }
                            Directory.CreateDirectory(Path.GetDirectoryName(dst));
                            string tmp = dst + "." + Guid.NewGuid().ToString("N") + ".part";
                            try {
                                using (var src = entry.Open())
                                using (var fs = File.Create(tmp)) {
                                    src.CopyTo(fs);
                                }
                                if (File.Exists(dst)) File.Replace(tmp, dst, null);
                                else File.Move(tmp, dst);
                            } finally {
                                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                            }
                        }
                    }
                }

                // Verify integrity of extracted bundled model & ORT
                foreach (var f in OrtFiles.Concat(bundledModel.Files)) {
                    if (!FileIsValid(f, true)) {
                        error = I18n.F("app.models.integrityFailed", "path", f.LocalRelPath);
                        return false;
                    }
                }
                return true;
            } catch (Exception ex) {
                error = I18n.F("app.models.extractFailed", "error", ex.Message);
                return false;
            }
        }
    }

    internal static bool IsChinesePreferred() {
        try {
            string lang = PortablePaths.LoadSettings().Language;
            if (String.IsNullOrWhiteSpace(lang)) lang = I18n.Language;
            if (String.IsNullOrWhiteSpace(lang)) lang = CultureInfo.CurrentUICulture.Name;
            return lang.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
        } catch {
            return true;
        }
    }

    internal static string[] GetOrderedMirrors() {
        return IsChinesePreferred() ? CnMirrors : IntlMirrors;
    }

    static bool ProbeUrlReachable(string url, CancellationToken ct) {
        try {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "HEAD";
            req.Timeout = 4500;
            req.ReadWriteTimeout = 4500;
            req.AllowAutoRedirect = true;
            req.UserAgent = "SplatConvertDesktop/1.9.0";
            using (ct.Register(() => { try { req.Abort(); } catch { } }))
            using (var resp = (HttpWebResponse)req.GetResponse()) {
                int code = (int)resp.StatusCode;
                return code >= 200 && code < 400;
            }
        } catch {
            return false;
        }
    }

    static void DownloadSingleFileFromUrl(string url, string dstPath, string expectedSha256, long baseDownloaded, long approxTotal, Action<int, string> onProgress, CancellationToken ct) {
        Directory.CreateDirectory(Path.GetDirectoryName(dstPath));
        string partPath = dstPath + "." + Guid.NewGuid().ToString("N") + ".part";
        try {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = 15000;
            req.ReadWriteTimeout = 30000;
            req.AllowAutoRedirect = true;
            req.UserAgent = "SplatConvertDesktop/1.9.0";

            using (ct.Register(() => { try { req.Abort(); } catch { } }))
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var src = resp.GetResponseStream())
            using (var fs = new FileStream(partPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536)) {
                long contentLen = resp.ContentLength > 0 ? resp.ContentLength : 0;
                long totalEst = Math.Max(approxTotal, baseDownloaded + contentLen);
                byte[] buf = new byte[65536];
                long fileDone = 0;
                int lastPct = -1;
                int read;
                while ((read = src.Read(buf, 0, buf.Length)) > 0) {
                    ct.ThrowIfCancellationRequested();
                    fs.Write(buf, 0, read);
                    fileDone += read;
                    if (totalEst > 0) {
                        int pct = Math.Max(1, Math.Min(98, (int)Math.Round((baseDownloaded + fileDone) * 98d / totalEst)));
                        if (pct != lastPct) {
                            lastPct = pct;
                            double doneMb = (baseDownloaded + fileDone) / 1048576d;
                            double totMb = totalEst / 1048576d;
                            onProgress(pct, I18n.F("app.models.downloadingMb", "done", doneMb.ToString("0.1", CultureInfo.InvariantCulture), "total", totMb.ToString("0.1", CultureInfo.InvariantCulture)));
                        }
                    }
                }
                fs.Flush(true);
            }

            ct.ThrowIfCancellationRequested();
            if (!String.IsNullOrEmpty(expectedSha256)) {
                onProgress(99, I18n.T("app.models.verifyingSha256"));
                string actual = ComputeSha256(partPath);
                if (!String.Equals(actual, expectedSha256, StringComparison.OrdinalIgnoreCase)) {
                    throw new IOException(I18n.T("app.models.sha256Mismatch"));
                }
            }
            if (File.Exists(dstPath)) File.Replace(partPath, dstPath, null);
            else File.Move(partPath, dstPath);
        } finally {
            try { if (File.Exists(partPath)) File.Delete(partPath); } catch { }
        }
    }

    internal static void CancelDownload(string modelId) {
        CancellationTokenSource cts;
        if (ActiveDownloads.TryGetValue(modelId ?? "", out cts)) {
            try { cts.Cancel(); } catch { }
        }
    }

    internal static Task<Tuple<bool, string>> DownloadModelAsync(string modelId, Action<int, string> onProgress) {
        var spec = FindSpec(modelId);
        if (spec == null) return Task.FromResult(Tuple.Create(false, I18n.F("app.models.unknownModel", "id", modelId)));
        if (IsModelInstalled(spec)) return Task.FromResult(Tuple.Create(true, I18n.T("app.models.alreadyReady")));

        var cts = new CancellationTokenSource();
        if (!ActiveDownloads.TryAdd(spec.Id, cts)) {
            cts.Dispose();
            return Task.FromResult(Tuple.Create(false, I18n.T("app.models.alreadyDownloading")));
        }

        return Task.Run(() => {
            try {
                var ct = cts.Token;
                string[] mirrors = GetOrderedMirrors();
                long approxTotalBytes = Math.Max(1L, spec.ApproxSizeMb * 1048576L);
                onProgress(1, I18n.T("app.models.probingMirrors"));

                // Choose first reachable mirror by language priority, falling back seamlessly
                var orderedMirrors = new List<string>();
                string probePath = spec.Files[0].HfRepoPath;
                foreach (string m in mirrors) {
                    ct.ThrowIfCancellationRequested();
                    if (ProbeUrlReachable(m + probePath, ct)) orderedMirrors.Add(m);
                }
                // Even if HEAD probe was blocked by a proxy, keep full mirror list for GET failover!
                foreach (string m in mirrors) {
                    if (!orderedMirrors.Contains(m)) orderedMirrors.Add(m);
                }

                long doneBefore = 0;
                for (int fi = 0; fi < spec.Files.Length; fi++) {
                    ct.ThrowIfCancellationRequested();
                    var f = spec.Files[fi];
                    string dst = FullPathOf(f.LocalRelPath);
                    if (FileIsValid(f, true)) {
                        doneBefore += new FileInfo(dst).Length;
                        continue;
                    }

                    Exception lastErr = null;
                    bool fileOk = false;
                    for (int mi = 0; mi < orderedMirrors.Count; mi++) {
                        ct.ThrowIfCancellationRequested();
                        string url = orderedMirrors[mi] + f.HfRepoPath;
                        try {
                            if (mi > 0) onProgress(Math.Max(2, (int)Math.Round(doneBefore * 95d / approxTotalBytes)), I18n.T("app.models.switchingBackupMirror"));
                            DownloadSingleFileFromUrl(url, dst, f.Sha256, doneBefore, approxTotalBytes, onProgress, ct);
                            doneBefore += new FileInfo(dst).Length;
                            fileOk = true;
                            break;
                        } catch (OperationCanceledException) {
                            throw;
                        } catch (Exception ex) {
                            lastErr = ex;
                        }
                    }
                    if (!fileOk) {
                        throw new IOException(I18n.F("app.models.allMirrorsFailed", "error", lastErr != null ? lastErr.Message : I18n.T("app.models.networkError")));
                    }
                }

                // Also ensure ORT runtime is extracted so newly downloaded models can execute immediately!
                string ortErr;
                EnsureBundledExtracted(out ortErr);

                onProgress(100, I18n.T("app.models.downloadVerified"));
                return Tuple.Create(true, I18n.F("app.models.downloadedModel", "name", spec.DisplayName));
            } catch (OperationCanceledException) {
                return Tuple.Create(false, I18n.T("app.models.downloadCanceled"));
            } catch (Exception ex) {
                return Tuple.Create(false, I18n.F("app.models.downloadFailed", "error", ex.Message));
            } finally {
                CancellationTokenSource removed;
                ActiveDownloads.TryRemove(spec.Id, out removed);
                if (removed != null) removed.Dispose();
            }
        });
    }

    internal static object BuildModelsPayload(string modelsOrigin) {
        string activeSemantic = PortablePaths.LoadSettings().ActiveSemanticModel;
        if (String.IsNullOrWhiteSpace(activeSemantic) || FindSpec(activeSemantic) == null) {
            activeSemantic = "sam21-tiny-fp16";
        }
        bool ortReady = IsOrtReady();
        var items = Catalog.Select(spec => {
            bool installed = IsModelInstalled(spec);
            bool downloading = ActiveDownloads.ContainsKey(spec.Id);
            var filesMap = new Dictionary<string, string>();
            foreach (var f in spec.Files) {
                string key = Path.GetFileName(f.LocalRelPath);
                filesMap[key] = modelsOrigin + f.LocalRelPath;
            }
            return new {
                id = spec.Id,
                category = spec.Category,
                schema = spec.Schema,
                displayName = spec.DisplayName,
                shortBadge = spec.ShortBadge,
                tooltip = spec.Tooltip,
                bundled = spec.Bundled,
                hasEmbeddedBundle = spec.Bundled && HasEmbeddedBundle(),
                installed = installed,
                downloading = downloading,
                approxSizeMb = spec.ApproxSizeMb,
                files = filesMap
            };
        }).ToArray();

        return new {
            activeSemanticModel = activeSemantic,
            ortReady = ortReady,
            ortUrl = modelsOrigin + "ort/ort.webgpu.min.mjs",
            wasmBaseUrl = modelsOrigin + "ort/",
            preferredRegion = IsChinesePreferred() ? "cn" : "intl",
            models = items
        };
    }
}
