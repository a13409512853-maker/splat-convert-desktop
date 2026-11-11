using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Web.Script.Serialization;

static class I18n {
    internal static readonly string[] Codes = { "zh", "en", "ja", "ko", "de", "fr", "es" };
    internal static readonly string[] Names = { "简体中文", "English", "日本語", "한국어", "Deutsch", "Français", "Español" };
    static readonly Dictionary<string, string[]> Catalog = Load();
    internal static string Language = DefaultLanguage();
    static string DefaultLanguage() {
        string code = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName;
        return Codes.Contains(code) ? code : "en";
    }
    static Dictionary<string, string[]> Load() {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("locales.json"))
        using (var reader = new StreamReader(stream)) return new JavaScriptSerializer().Deserialize<Dictionary<string, string[]>>(reader.ReadToEnd());
    }
    internal static string T(string key) {
        string[] values;
        if (!Catalog.TryGetValue(key, out values)) return key;
        int index = Array.IndexOf(Codes, Language);
        return values[index < 0 ? 1 : index];
    }
    internal static string[] MissingKeys() { return Catalog.Where(kv=>kv.Value.Length != Codes.Length || kv.Value.Any(String.IsNullOrWhiteSpace)).Select(kv=>kv.Key).ToArray(); }
    internal static string StatePath { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SplatConvertDesktop", "language.txt"); } }
    internal static void Restore() { try { string l = File.ReadAllText(StatePath).Trim(); if (Codes.Contains(l)) Language = l; } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    internal static void Save() { try { Directory.CreateDirectory(Path.GetDirectoryName(StatePath)); File.WriteAllText(StatePath, Language); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
}
