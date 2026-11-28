'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LANG = 'zh-CN';
const LEGACY_MAP = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-US',
  ja: 'ja-JP',
  'ja-jp': 'ja-JP',
  ko: 'ko-KR',
  'ko-kr': 'ko-KR',
  de: 'de-DE',
  'de-de': 'de-DE',
  fr: 'fr-FR',
  'fr-fr': 'fr-FR',
  es: 'es-ES',
  'es-es': 'es-ES',
};

function flattenDict(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_meta') continue;
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[full] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) flattenDict(v, full, out);
  }
  return out;
}

function findLocaleDirs() {
  const dirs = [];
  const candidates = [
    path.resolve(__dirname, '../locales'),
    path.resolve(__dirname, './locales'),
  ];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'locales'));
  }
  for (const d of candidates) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory() && !dirs.includes(d)) {
      dirs.push(d);
    }
  }
  return dirs;
}

function loadAllLocales() {
  const byCode = new Map();
  for (const dir of findLocaleDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const file of entries.sort()) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, ''));
        const meta = raw._meta || {};
        const code = meta.code || file.replace(/\.json$/i, '');
        const flat = flattenDict(raw);
        byCode.set(code, {
          code,
          legacyCode: meta.legacyCode || code.split('-')[0].toLowerCase(),
          name: meta.name || code,
          nativeName: meta.nativeName || meta.name || code,
          order: typeof meta.order === 'number' ? meta.order : 999,
          dict: flat,
        });
      } catch {
        // Ignore malformed external JSON safely
      }
    }
  }
  return [...byCode.values()].sort((a, b) => a.order - b.order || a.code.localeCompare(b.code));
}

const locales = loadAllLocales();
const localeMap = new Map(locales.map((l) => [l.code, l]));
const codes = locales.map((l) => l.code);
const fallbackDict = localeMap.get(DEFAULT_LANG)?.dict || {};

function normalizeLanguage(input) {
  if (!input || typeof input !== 'string') return DEFAULT_LANG;
  const trimmed = input.trim();
  if (localeMap.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase().replace(/_/g, '-');
  if (LEGACY_MAP[lower] && localeMap.has(LEGACY_MAP[lower])) return LEGACY_MAP[lower];
  const prefix = lower.split('-')[0];
  for (const loc of locales) {
    if (loc.code.toLowerCase() === lower || loc.legacyCode.toLowerCase() === prefix) return loc.code;
  }
  return DEFAULT_LANG;
}

function interpolate(str, vars) {
  if (!vars || typeof str !== 'string') return str;
  return str.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

function translate(language, key, vars = null) {
  const code = normalizeLanguage(language);
  const dict = localeMap.get(code)?.dict || fallbackDict;
  let val = dict[key];
  if (typeof val !== 'string' || !val.trim()) val = fallbackDict[key];
  if (typeof val !== 'string' || !val.trim()) val = key;
  return vars ? interpolate(val, vars) : val;
}

function getCatalogForRenderer() {
  const dicts = {};
  for (const l of locales) dicts[l.code] = l.dict;
  return {
    defaultLang: DEFAULT_LANG,
    languages: locales.map(({ code, legacyCode, name, nativeName }) => ({ code, legacyCode, name, nativeName })),
    dicts,
  };
}

module.exports = {
  DEFAULT_LANG,
  locales,
  codes,
  fallbackDict,
  normalizeLanguage,
  translate,
  getCatalogForRenderer,
};
