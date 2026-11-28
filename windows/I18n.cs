using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

sealed class LocalePack {
    internal string Code;
    internal string LegacyCode;
    internal string Name;
    internal string NativeName;
    internal int Order;
    internal Dictionary<string, string> Dict;
}

static class I18n {
    internal const string DefaultCode = "zh-CN";
    static readonly Regex PlaceholderRx = new Regex(@"\{([a-zA-Z0-9_]+)\}", RegexOptions.Compiled);
    static readonly Dictionary<string, string> LegacyAliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
        { "zh", "zh-CN" }, { "zh-cn", "zh-CN" }, { "zh-hans", "zh-CN" },
        { "en", "en-US" }, { "en-us", "en-US" }, { "en-gb", "en-US" },
        { "ja", "ja-JP" }, { "ja-jp", "ja-JP" },
        { "ko", "ko-KR" }, { "ko-kr", "ko-KR" },
        { "de", "de-DE" }, { "de-de", "de-DE" },
        { "fr", "fr-FR" }, { "fr-fr", "fr-FR" },
        { "es", "es-ES" }, { "es-es", "es-ES" },
    };

    static readonly List<LocalePack> Packs = LoadAllPacks();
    static readonly Dictionary<string, LocalePack> PackByCode = BuildCodeIndex(Packs);
    static string currentLanguage = DetectSystemLanguage();

    internal static event Action LanguageChanged;

    internal static string[] Codes { get { return Packs.Select(p => p.Code).ToArray(); } }
    internal static string[] Names { get { return Packs.Select(p => p.NativeName).ToArray(); } }

    internal static string Language {
        get { return currentLanguage; }
        set { SetLanguage(value, false); }
    }

    internal static bool IsZh {
        get { return currentLanguage.StartsWith("zh", StringComparison.OrdinalIgnoreCase); }
    }

    static Dictionary<string, LocalePack> BuildCodeIndex(List<LocalePack> list) {
        var map = new Dictionary<string, LocalePack>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in list) map[p.Code] = p;
        return map;
    }

    static List<LocalePack> LoadAllPacks() {
        var byCode = new Dictionary<string, LocalePack>(StringComparer.OrdinalIgnoreCase);
        var asm = Assembly.GetExecutingAssembly();

        // 1. Auto-discover ALL embedded locales.*.json resources compiled into EXE
        foreach (string resName in asm.GetManifestResourceNames().OrderBy(x => x, StringComparer.OrdinalIgnoreCase)) {
            if (!resName.StartsWith("locales.", StringComparison.OrdinalIgnoreCase) || !resName.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) continue;
            string fileCode = resName.Substring("locales.".Length, resName.Length - "locales.".Length - ".json".Length);
            try {
                using (var stream = asm.GetManifestResourceStream(resName))
                using (var reader = new StreamReader(stream, Encoding.UTF8)) {
                    var pack = ParsePack(reader.ReadToEnd(), fileCode);
                    if (pack != null) byCode[pack.Code] = pack;
                }
            } catch { }
        }

        // 2. Runtime external auto-discovery: community contributors can drop *.json directly into data/locales/ without recompiling!
        string[] externalDirs = new[] {
            PortablePaths.LocalesDir,
            Path.Combine(PortablePaths.RootDir, "locales"),
        };
        foreach (string dir in externalDirs) {
            if (!Directory.Exists(dir)) continue;
            try {
                foreach (string file in Directory.GetFiles(dir, "*.json").OrderBy(x => x, StringComparer.OrdinalIgnoreCase)) {
                    string fileCode = Path.GetFileNameWithoutExtension(file);
                    try {
                        string raw = File.ReadAllText(file, Encoding.UTF8);
                        var pack = ParsePack(raw, fileCode);
                        if (pack == null) continue;
                        LocalePack existing;
                        if (byCode.TryGetValue(pack.Code, out existing)) {
                            // Merge external overrides on top of embedded dictionary
                            foreach (var kv in pack.Dict) existing.Dict[kv.Key] = kv.Value;
                            if (!String.IsNullOrWhiteSpace(pack.NativeName)) existing.NativeName = pack.NativeName;
                            if (!String.IsNullOrWhiteSpace(pack.Name)) existing.Name = pack.Name;
                        } else {
                            byCode[pack.Code] = pack;
                        }
                    } catch { }
                }
            } catch { }
        }

        if (!byCode.ContainsKey(DefaultCode)) {
            byCode[DefaultCode] = new LocalePack {
                Code = DefaultCode, LegacyCode = "zh", Name = "Chinese (Simplified)", NativeName = "简体中文", Order = 1,
                Dict = new Dictionary<string, string>(StringComparer.Ordinal),
            };
        }

        return byCode.Values
            .OrderBy(p => p.Order)
            .ThenBy(p => p.Code, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    static LocalePack ParsePack(string rawJson, string fallbackCode) {
        if (String.IsNullOrWhiteSpace(rawJson)) return null;
        if (rawJson.Length > 0 && rawJson[0] == '\uFEFF') rawJson = rawJson.Substring(1);
        var ser = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        var root = ser.DeserializeObject(rawJson) as Dictionary<string, object>;
        if (root == null) return null;

        string code = fallbackCode;
        string legacy = fallbackCode.Split('-')[0].ToLowerInvariant();
        string name = fallbackCode;
        string nativeName = fallbackCode;
        int order = 999;

        object metaObj;
        if (root.TryGetValue("_meta", out metaObj)) {
            var meta = metaObj as Dictionary<string, object>;
            if (meta != null) {
                if (meta.ContainsKey("code") && meta["code"] != null) code = meta["code"].ToString().Trim();
                if (meta.ContainsKey("legacyCode") && meta["legacyCode"] != null) legacy = meta["legacyCode"].ToString().Trim();
                if (meta.ContainsKey("name") && meta["name"] != null) name = meta["name"].ToString().Trim();
                if (meta.ContainsKey("nativeName") && meta["nativeName"] != null) nativeName = meta["nativeName"].ToString().Trim();
                if (meta.ContainsKey("order") && meta["order"] != null) {
                    int o;
                    if (Int32.TryParse(meta["order"].ToString(), out o)) order = o;
                }
            }
        }

        var flat = new Dictionary<string, string>(StringComparer.Ordinal);
        Flatten(root, "", flat);
        return new LocalePack {
            Code = code,
            LegacyCode = legacy,
            Name = String.IsNullOrWhiteSpace(name) ? code : name,
            NativeName = String.IsNullOrWhiteSpace(nativeName) ? (String.IsNullOrWhiteSpace(name) ? code : name) : nativeName,
            Order = order,
            Dict = flat,
        };
    }

    static void Flatten(Dictionary<string, object> obj, string prefix, Dictionary<string, string> output) {
        foreach (var kv in obj) {
            if (kv.Key == "_meta") continue;
            string full = String.IsNullOrEmpty(prefix) ? kv.Key : (prefix + "." + kv.Key);
            var child = kv.Value as Dictionary<string, object>;
            if (child != null) {
                Flatten(child, full, output);
            } else if (kv.Value is string) {
                output[full] = (string)kv.Value;
            }
        }
    }

    internal static string NormalizeCode(string raw) {
        if (String.IsNullOrWhiteSpace(raw)) return DefaultCode;
        string trimmed = raw.Trim().Replace('_', '-');
        if (PackByCode.ContainsKey(trimmed)) return PackByCode[trimmed].Code;
        string alias;
        if (LegacyAliases.TryGetValue(trimmed, out alias) && PackByCode.ContainsKey(alias)) return PackByCode[alias].Code;
        string prefix = trimmed.Split('-')[0];
        foreach (var p in Packs) {
            if (String.Equals(p.LegacyCode, prefix, StringComparison.OrdinalIgnoreCase)
                || p.Code.StartsWith(prefix + "-", StringComparison.OrdinalIgnoreCase)) {
                return p.Code;
            }
        }
        return DefaultCode;
    }

    static string DetectSystemLanguage() {
        try {
            string full = CultureInfo.CurrentUICulture.Name;
            if (!String.IsNullOrWhiteSpace(full)) {
                if (PackByCode.ContainsKey(full)) return PackByCode[full].Code;
                string alias;
                if (LegacyAliases.TryGetValue(full, out alias) && PackByCode.ContainsKey(alias)) return PackByCode[alias].Code;
            }
            string two = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName;
            if (!String.IsNullOrWhiteSpace(two)) {
                foreach (var p in Packs) {
                    if (String.Equals(p.LegacyCode, two, StringComparison.OrdinalIgnoreCase)) return p.Code;
                }
            }
        } catch { }
        return DefaultCode;
    }

    internal static void SetLanguage(string code, bool save = true) {
        string norm = NormalizeCode(code);
        bool changed = !String.Equals(currentLanguage, norm, StringComparison.OrdinalIgnoreCase);
        currentLanguage = norm;
        if (save) Save();
        if (changed) {
            var ev = LanguageChanged;
            if (ev != null) ev();
        }
    }

    internal static string T(string key) {
        if (String.IsNullOrEmpty(key)) return "";
        LocalePack active;
        string val;
        if (PackByCode.TryGetValue(currentLanguage, out active) && active.Dict.TryGetValue(key, out val) && !String.IsNullOrWhiteSpace(val)) {
            return val;
        }
        LocalePack fallback;
        if (PackByCode.TryGetValue(DefaultCode, out fallback) && fallback.Dict.TryGetValue(key, out val) && !String.IsNullOrWhiteSpace(val)) {
            return val;
        }
        return key;
    }

    internal static string F(string key, params object[] kvPairs) {
        string template = T(key);
        if (kvPairs == null || kvPairs.Length < 2) return template;
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i + 1 < kvPairs.Length; i += 2) {
            if (kvPairs[i] != null) map[kvPairs[i].ToString()] = kvPairs[i + 1] != null ? kvPairs[i + 1].ToString() : "";
        }
        return PlaceholderRx.Replace(template, m => {
            string v;
            return map.TryGetValue(m.Groups[1].Value, out v) ? v : m.Value;
        });
    }

    internal static Dictionary<string, string> ExportFlatDict(string code) {
        string norm = NormalizeCode(code);
        LocalePack pack;
        if (PackByCode.TryGetValue(norm, out pack)) return new Dictionary<string, string>(pack.Dict);
        return new Dictionary<string, string>();
    }

    internal static string[] MissingKeys() {
        LocalePack basePack;
        if (!PackByCode.TryGetValue(DefaultCode, out basePack)) return new string[0];
        var missing = new List<string>();
        foreach (var k in basePack.Dict.Keys) {
            foreach (var p in Packs) {
                string v;
                if (!p.Dict.TryGetValue(k, out v) || String.IsNullOrWhiteSpace(v)) {
                    missing.Add(p.Code + ":" + k);
                }
            }
        }
        return missing.ToArray();
    }

    internal static void Restore() {
        var s = PortablePaths.LoadSettings();
        if (!String.IsNullOrWhiteSpace(s.Language)) {
            currentLanguage = NormalizeCode(s.Language);
        } else {
            currentLanguage = DetectSystemLanguage();
        }
    }

    internal static void Save() {
        PortablePaths.SaveSettings(s => { s.Language = currentLanguage; });
    }
}
