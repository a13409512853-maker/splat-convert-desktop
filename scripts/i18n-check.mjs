#!/usr/bin/env node
/**
 * i18n Locale Diff & Code Coverage Checker for Splat Convert Desktop
 *
 * Usage:
 *   node scripts/i18n-check.mjs
 *   node scripts/i18n-check.mjs --export-missing en-US
 *   node scripts/i18n-check.mjs --scan-code
 *   node scripts/i18n-check.mjs --strict
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOCALES_DIR = path.join(ROOT, "locales");
const BASE_LANG = "zh-CN";

function flatten(obj, prefix = "", out = {}) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "_meta") continue;
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      out[full] = v;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, full, out);
    }
  }
  return out;
}

function extractPlaceholders(str) {
  const set = new Set();
  const re = /\{([a-zA-Z0-9_]+)\}/g;
  let m;
  while ((m = re.exec(str))) set.add(m[1]);
  return [...set].sort();
}

function collectSourceFiles(dir, exts, skipDirs = new Set()) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      results.push(...collectSourceFiles(full, exts, skipDirs));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

function scanCodeReferences(baseKeys) {
  const skip = new Set(["vendor", "luts", "icons", "node_modules", ".cache", "dist", "webview"]);
  const files = [
    ...collectSourceFiles(path.join(ROOT, "windows"), [".cs"], skip),
    ...collectSourceFiles(path.join(ROOT, "windows", "editor"), [".js", ".mjs", ".html"], skip),
    ...collectSourceFiles(path.join(ROOT, "app"), [".js", ".cjs", ".html"], skip),
  ];

  const usedKeys = new Set();
  const missingInBase = new Map(); // key -> Set<file:line>

  // Match static string literal keys in I18n.T("..."), I18n.F("..."), t("..."), data-i18n*="..."
  const patterns = [
    /\bI18n\.(?:T|F)\(\s*"([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)"/g,
    /\bt\(\s*['"]([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)['"]/g,
    /\bdata-i18n(?:-[a-z]+)?=["']([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)["']/g,
  ];

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const key = m[1];
          usedKeys.add(key);
          if (!Object.prototype.hasOwnProperty.call(baseKeys, key)) {
            if (!missingInBase.has(key)) missingInBase.set(key, []);
            missingInBase.get(key).push(`${rel}:${idx + 1}`);
          }
        }
      }
    });
  }

  return { filesScanned: files.length, usedKeys, missingInBase };
}

function main() {
  const args = process.argv.slice(2);
  const scanCode = args.includes("--scan-code");
  const strict = args.includes("--strict");
  const exportIdx = args.indexOf("--export-missing");
  const exportLang = exportIdx >= 0 ? args[exportIdx + 1] : null;

  const baseFile = path.join(LOCALES_DIR, `${BASE_LANG}.json`);
  if (!fs.existsSync(baseFile)) {
    console.error(`[ERROR] Base locale file not found: ${baseFile}`);
    process.exit(1);
  }

  const baseRaw = JSON.parse(fs.readFileSync(baseFile, "utf8").replace(/^\uFEFF/, ""));
  const baseFlat = flatten(baseRaw);
  const baseKeys = Object.keys(baseFlat);

  const localeFiles = fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json") && f !== `${BASE_LANG}.json`)
    .sort();

  console.log(`=== Splat Convert Desktop i18n Diff Check ===`);
  console.log(`Base locale : ${BASE_LANG}.json (${baseKeys.length} keys)`);
  console.log(`Target packs: ${localeFiles.map((f) => f.replace(/\.json$/, "")).join(", ") || "(none)"}\n`);

  let hasIssues = false;

  for (const file of localeFiles) {
    const code = file.replace(/\.json$/, "");
    const raw = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), "utf8").replace(/^\uFEFF/, ""));
    const flat = flatten(raw);

    const missing = [];
    const empty = [];
    const placeholderMismatches = [];

    for (const k of baseKeys) {
      if (!Object.prototype.hasOwnProperty.call(flat, k)) {
        missing.push(k);
      } else if (!flat[k].trim()) {
        empty.push(k);
      } else {
        const bp = extractPlaceholders(baseFlat[k]);
        const tp = extractPlaceholders(flat[k]);
        if (bp.join(",") !== tp.join(",")) {
          placeholderMismatches.push({ key: k, expected: bp, actual: tp });
        }
      }
    }

    const extra = Object.keys(flat).filter((k) => !Object.prototype.hasOwnProperty.call(baseFlat, k));
    const covered = baseKeys.length - missing.length - empty.length;
    const pct = baseKeys.length ? ((covered / baseKeys.length) * 100).toFixed(1) : "100.0";

    const ok = missing.length === 0 && empty.length === 0 && extra.length === 0 && placeholderMismatches.length === 0;
    console.log(
      `[${ok ? "PASS" : "DIFF"}] ${code.padEnd(8)} coverage=${pct}% (${covered}/${baseKeys.length}) | missing=${missing.length} | empty=${empty.length} | extra=${extra.length} | placeholderErr=${placeholderMismatches.length}`,
    );

    if (!ok) hasIssues = true;

    if (missing.length > 0 && exportLang !== code) {
      console.log(`  Missing keys in ${code} (with zh-CN source):`);
      for (const k of missing.slice(0, 40)) {
        console.log(`    - ${k}: ${JSON.stringify(baseFlat[k])}`);
      }
      if (missing.length > 40) console.log(`    ... and ${missing.length - 40} more (use --export-missing ${code} to dump JSON)`);
    }
    if (empty.length > 0) {
      console.log(`  Empty translations in ${code}:`);
      for (const k of empty.slice(0, 20)) console.log(`    - ${k} (zh-CN: ${JSON.stringify(baseFlat[k])})`);
    }
    if (extra.length > 0) {
      console.log(`  Obsolete/extra keys in ${code} (not in ${BASE_LANG}):`);
      for (const k of extra.slice(0, 30)) console.log(`    - ${k}`);
    }
    if (placeholderMismatches.length > 0) {
      console.log(`  Placeholder mismatches in ${code}:`);
      for (const pm of placeholderMismatches.slice(0, 20)) {
        console.log(`    - ${pm.key}: expected {${pm.expected.join(", ")}} got {${pm.actual.join(", ")}}`);
      }
    }

    if (exportLang === code) {
      const exportObj = {};
      for (const k of [...missing, ...empty]) exportObj[k] = baseFlat[k];
      console.log(`\n--- AI Translation Payload for ${code} (${Object.keys(exportObj).length} keys) ---`);
      console.log(JSON.stringify(exportObj, null, 2));
      console.log(`--- End Payload ---\n`);
    }
  }

  if (scanCode) {
    const scan = scanCodeReferences(baseFlat);
    console.log(`\n=== Static Code Key Scan (${scan.filesScanned} files, ${scan.usedKeys.size} referenced keys) ===`);
    if (scan.missingInBase.size > 0) {
      hasIssues = true;
      console.log(`[FAIL] ${scan.missingInBase.size} key(s) referenced in code are MISSING from ${BASE_LANG}.json:`);
      for (const [k, locs] of scan.missingInBase.entries()) {
        console.log(`  - ${k}  (${locs.slice(0, 3).join(", ")})`);
      }
    } else {
      console.log(`[PASS] Every statically referenced i18n key exists in ${BASE_LANG}.json!`);
    }
  }

  if (hasIssues && (strict || !exportLang)) {
    process.exitCode = 1;
  } else if (!hasIssues) {
    console.log(`\nALL LOCALES 100% SYNCHRONIZED WITH ${BASE_LANG}.json!`);
  }
}

main();
