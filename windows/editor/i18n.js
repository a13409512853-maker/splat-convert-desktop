/**
 * @module i18n
 * @description Lightweight zero-dependency i18n runtime for the WebView2 3D Gaussian Editor.
 * - Source of Truth & strict fallback: Simplified Chinese (`zh-CN`).
 * - Supports nested JSON dictionaries flattened to semantic dot-keys (e.g. `editor.menu.file.title`).
 * - Supports `{var}` placeholder interpolation without string concatenation.
 * - Supports instant hot-switching pushed from C# Host (`setLanguage`) or loaded from `./locales/<code>.json`.
 * - NEVER exposes raw keys when `zh-CN` has a valid translation.
 */

const DEFAULT_LANG = "zh-CN";

const LEGACY_CODE_MAP = Object.freeze({
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  en: "en-US",
  "en-us": "en-US",
  "en-gb": "en-US",
  ja: "ja-JP",
  "ja-jp": "ja-JP",
  ko: "ko-KR",
  "ko-kr": "ko-KR",
  de: "de-DE",
  "de-de": "de-DE",
  fr: "fr-FR",
  "fr-fr": "fr-FR",
  es: "es-ES",
  "es-es": "es-ES",
});

let currentLang = DEFAULT_LANG;
let fallbackDict = {}; // Always zh-CN flat dictionary
let activeDict = {};   // Active language flat dictionary
const listeners = new Set();

export function normalizeLangCode(code) {
  if (!code || typeof code !== "string") return DEFAULT_LANG;
  const trimmed = code.trim();
  if (!trimmed) return DEFAULT_LANG;
  const lower = trimmed.toLowerCase().replace(/_/g, "-");
  if (LEGACY_CODE_MAP[lower]) return LEGACY_CODE_MAP[lower];
  // Preserve explicit BCP-47 tag (e.g., pt-BR, ru-RU, zh-TW) for external community locale drops!
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})+$/i.test(trimmed)) {
    const parts = trimmed.replace(/_/g, "-").split("-");
    return parts[0].toLowerCase() + "-" + parts.slice(1).map((p) => (p.length === 2 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1).toLowerCase())).join("-");
  }
  const prefix = lower.split("-")[0];
  if (LEGACY_CODE_MAP[prefix]) return LEGACY_CODE_MAP[prefix];
  return trimmed;
}

export function flattenDict(obj, prefix = "", out = {}) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "_meta") continue;
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      out[full] = v;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      flattenDict(v, full, out);
    }
  }
  return out;
}

async function fetchLocaleJson(code) {
  const candidates = [
    `./locales/${encodeURIComponent(code)}.json`,
    `../../locales/${encodeURIComponent(code)}.json`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // try next path
    }
  }
  return null;
}

function interpolate(template, vars) {
  if (!vars || typeof template !== "string") return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null) {
      return String(vars[name]);
    }
    return match;
  });
}

/**
 * Translate semantic dot-key with optional `{var}` interpolation and strict `zh-CN` fallback.
 */
export function t(key, vars = null) {
  if (!key) return "";
  const activeVal = activeDict[key];
  let raw = typeof activeVal === "string" && activeVal.trim().length > 0 ? activeVal : "";
  if (!raw) {
    const fbVal = fallbackDict[key];
    if (typeof fbVal === "string" && fbVal.trim().length > 0) raw = fbVal;
  }
  if (!raw) raw = key;
  return vars ? interpolate(raw, vars) : raw;
}

export function getLanguage() {
  return currentLang;
}

export function isCjkLanguage() {
  return currentLang.startsWith("zh") || currentLang.startsWith("ja") || currentLang.startsWith("ko");
}

export function onLanguageChange(fn) {
  if (typeof fn === "function") listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Apply translations cleanly to all static declarative DOM attributes:
 * - `data-i18n`: sets textContent (preserving child `<kbd>` if present via `data-i18n-preserve-kbd` or first text node)
 * - `data-i18n-html`: sets innerHTML (only for trusted static rich labels with `<strong>`)
 * - `data-i18n-title`: sets `title`
 * - `data-i18n-aria`: sets `aria-label`
 * - `data-i18n-placeholder`: sets `placeholder`
 */
export function applyDomTranslations(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  document.documentElement.lang = currentLang;

  for (const el of root.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    if (!key) continue;
    const translated = t(key);
    const kbd = el.querySelector(":scope > kbd");
    if (kbd && el.children.length === 1) {
      // Preserve trailing <kbd> shortcut badge inside menu buttons!
      el.textContent = translated;
      el.appendChild(kbd);
    } else {
      el.textContent = translated;
    }
  }
  for (const el of root.querySelectorAll("[data-i18n-html]")) {
    const key = el.getAttribute("data-i18n-html");
    if (key) el.innerHTML = t(key);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.setAttribute("title", t(key));
  }
  for (const el of root.querySelectorAll("[data-i18n-aria]")) {
    const key = el.getAttribute("data-i18n-aria");
    if (key) el.setAttribute("aria-label", t(key));
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.setAttribute("placeholder", t(key));
  }
}

function notifyAll() {
  applyDomTranslations(document);
  for (const fn of listeners) {
    try {
      fn(currentLang);
    } catch (err) {
      console.warn("[i18n] listener error:", err);
    }
  }
}

/**
 * Initialize i18n at editor startup (loads zh-CN fallback + active language).
 */
export async function initI18n(initialLang = null, inlinePayload = null) {
  const urlLang = new URLSearchParams(window.location.search).get("lang");
  const navLang = typeof navigator !== "undefined" ? navigator.language : DEFAULT_LANG;
  const code = normalizeLangCode(initialLang || urlLang || navLang || DEFAULT_LANG);

  if (inlinePayload && inlinePayload.fallback) {
    fallbackDict = flattenDict(inlinePayload.fallback);
  } else if (Object.keys(fallbackDict).length === 0) {
    const fbJson = await fetchLocaleJson(DEFAULT_LANG);
    if (fbJson) fallbackDict = flattenDict(fbJson);
  }

  return setLanguage(code, inlinePayload?.dict || null, inlinePayload?.fallback || null);
}

/**
 * Hot-switch active language at runtime (zero reload, updates DOM + all subscribed controllers!).
 */
export async function setLanguage(code, inlineDict = null, inlineFallback = null) {
  const norm = normalizeLangCode(code);
  if (inlineFallback) {
    fallbackDict = flattenDict(inlineFallback);
  } else if (Object.keys(fallbackDict).length === 0) {
    const fbJson = await fetchLocaleJson(DEFAULT_LANG);
    if (fbJson) fallbackDict = flattenDict(fbJson);
  }

  if (inlineDict) {
    activeDict = flattenDict(inlineDict);
  } else if (norm === DEFAULT_LANG) {
    activeDict = { ...fallbackDict };
  } else {
    const json = await fetchLocaleJson(norm);
    activeDict = json ? flattenDict(json) : { ...fallbackDict };
  }

  currentLang = norm;
  notifyAll();
  return currentLang;
}
