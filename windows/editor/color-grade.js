// Shared ReSplat / Camera-Raw / Lightroom-compatible Color Grading engine:
// Exact bit-consistent math between WebGL2 Fragment/Vertex preview AND CPU SH DC / SH1-3 baking.
// Includes:
// - Input Levels (Black / Midtone Gamma / White) + Dual-Thumb Output Levels (OutBlack / OutWhite)
// - Light section: Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Transparency
// - Color section: White Balance (Presets + Eyedropper), Temperature, Tint (Green<->Magenta), Vibrance, Saturation
// - HSL Mixer: 8-Band HSL + Lightroom Point Color Targeted Eyedropper (Tolerance + Color Range + Range Visualization)
// - 16^3 3D LUT + Interactive 5-Zone RGB/Luma Histogram

import { t } from "./i18n.js";

export const SH_C0 = 0.28209479177387814;

export const HSL_BANDS = Object.freeze([
  { id: "red", get label() { return t("editor.color.hslBands.red"); }, color: "#ef4444", center: 0, halfWidth: 20 },
  { id: "orange", get label() { return t("editor.color.hslBands.orange"); }, color: "#f97316", center: 30, halfWidth: 20 },
  { id: "yellow", get label() { return t("editor.color.hslBands.yellow"); }, color: "#eab308", center: 60, halfWidth: 20 },
  { id: "green", get label() { return t("editor.color.hslBands.green"); }, color: "#22c55e", center: 120, halfWidth: 25 },
  { id: "aqua", get label() { return t("editor.color.hslBands.aqua"); }, color: "#06b6d4", center: 165, halfWidth: 20 },
  { id: "blue", get label() { return t("editor.color.hslBands.blue"); }, color: "#3b82f6", center: 220, halfWidth: 25 },
  { id: "purple", get label() { return t("editor.color.hslBands.purple"); }, color: "#8b5cf6", center: 275, halfWidth: 20 },
  { id: "magenta", get label() { return t("editor.color.hslBands.magenta"); }, color: "#ec4899", center: 315, halfWidth: 20 },
]);

export const WHITE_BALANCE_PRESETS = Object.freeze([
  { id: "asis", get label() { return t("editor.color.wbPresets.asis"); }, temp: 0.0, tintShift: 0.0 },
  { id: "daylight", get label() { return t("editor.color.wbPresets.daylight"); }, temp: 0.06, tintShift: 0.02 },
  { id: "cloudy", get label() { return t("editor.color.wbPresets.cloudy"); }, temp: 0.16, tintShift: 0.04 },
  { id: "shade", get label() { return t("editor.color.wbPresets.shade"); }, temp: 0.26, tintShift: 0.05 },
  { id: "tungsten", get label() { return t("editor.color.wbPresets.tungsten"); }, temp: -0.26, tintShift: -0.02 },
  { id: "fluorescent", get label() { return t("editor.color.wbPresets.fluorescent"); }, temp: -0.10, tintShift: 0.16 },
]);

export const HISTOGRAM_ZONES = Object.freeze([
  { id: "blacks", get label() { return t("editor.color.histZones.blacks"); }, start: 0.0, end: 0.16, key: "blacks", min: -1, max: 1, sens: 1.4 },
  { id: "shadows", get label() { return t("editor.color.histZones.shadows"); }, start: 0.16, end: 0.38, key: "shadows", min: -1, max: 1, sens: 1.4 },
  { id: "exposure", get label() { return t("editor.color.histZones.exposure"); }, start: 0.38, end: 0.64, key: "exposure", min: -2, max: 2, sens: 2.2 },
  { id: "highlights", get label() { return t("editor.color.histZones.highlights"); }, start: 0.64, end: 0.84, key: "highlights", min: -1, max: 1, sens: 1.4 },
  { id: "whites", get label() { return t("editor.color.histZones.whites"); }, start: 0.84, end: 1.0, key: "whites", min: -1, max: 1, sens: 1.4 },
]);

export const HSL_CENTERS_NORM = new Float32Array(HSL_BANDS.map((b) => b.center / 360));
export const HSL_HALF_WIDTHS_NORM = new Float32Array(HSL_BANDS.map((b) => b.halfWidth / 360));

export function createDefaultPointColor() {
  return {
    enabled: false,
    targetRgb: [0.5, 0.5, 0.5],
    targetHsl: [0.0, 0.5, 0.5],
    tolerance: 0.24,   // 0.04 .. 0.70 (hue tolerance)
    colorRange: 0.52,  // 0.05 .. 1.00 (sat/lum feather & range)
    hue: 0.0,          // -0.5 .. 0.5
    sat: 0.0,          // -1.0 .. 1.0
    light: 0.0,        // -1.0 .. 1.0
    visualizeRange: false,
  };
}

export function createDefaultGrade() {
  return {
    // Levels (Histogram bottom handles)
    blackPoint: 0.0,    // 0.0 .. 0.98 (Input black level)
    whitePoint: 1.0,    // 0.02 .. 1.0 (Input white level)
    gamma: 1.0,         // 0.25 .. 4.0 (Input midtone gamma)
    outBlack: 0.0,      // 0.0 .. 1.0 (Output black level)
    outWhite: 1.0,      // 0.0 .. 1.0 (Output white level)

    // Section visibility switches (PS Camera Raw eye toggles)
    lightEnabled: true,
    colorEnabled: true,
    hslEnabled: true,
    lutEnabled: true,

    // Light ("亮")
    exposure: 0.0,      // -2.0 .. 2.0 EV
    brightness: 0.0,    // Legacy compat only (removed from UI)
    contrast: 1.0,      // 0.2 .. 1.8 (UI -100 .. +100, center=1.0)
    highlights: 0.0,    // -1.0 .. 1.0 (UI -100 .. +100)
    shadows: 0.0,       // -1.0 .. 1.0 (UI -100 .. +100)
    whites: 0.0,        // -1.0 .. 1.0 (UI -100 .. +100)
    blacks: 0.0,        // -1.0 .. 1.0 (UI -100 .. +100)
    transparency: 1.0,  // 0.0 .. 2.0 (UI 0% .. 200%, center=100%)

    // Color ("颜色")
    wbPreset: "asis",
    temperature: 0.0,   // -0.5 .. 0.5 (UI -100 .. +100)
    tintShift: 0.0,     // -0.5 .. 0.5 (UI -100 .. +100, Green <-> Magenta)
    tint: [1.0, 1.0, 1.0], // Legacy RGB tint compat
    vibrance: 0.0,      // -1.0 .. 1.0 (UI -100 .. +100)
    saturation: 1.0,    // 0.0 .. 2.0 (UI -100 .. +100, center=1.0)

    // HSL Mixer ("HSL混色器")
    hslHue: [0, 0, 0, 0, 0, 0, 0, 0],
    hslSat: [0, 0, 0, 0, 0, 0, 0, 0],
    hslLight: [0, 0, 0, 0, 0, 0, 0, 0],
    pointColor: createDefaultPointColor(),

    // 3D LUT
    lutName: "",
    lutIntensity: 1.0,
  };
}

export function cloneGrade(g) {
  const pc = g && g.pointColor ? g.pointColor : createDefaultPointColor();
  return {
    blackPoint: Number(g?.blackPoint) || 0,
    whitePoint: g?.whitePoint != null ? Number(g.whitePoint) : 1,
    gamma: g?.gamma != null ? Number(g.gamma) : 1,
    outBlack: Number(g?.outBlack) || 0,
    outWhite: g?.outWhite != null ? Number(g.outWhite) : 1,

    lightEnabled: g?.lightEnabled !== false,
    colorEnabled: g?.colorEnabled !== false,
    hslEnabled: g?.hslEnabled !== false,
    lutEnabled: g?.lutEnabled !== false,

    exposure: Number(g?.exposure) || 0,
    brightness: Number(g?.brightness) || 0,
    contrast: g?.contrast != null ? Number(g.contrast) : 1,
    highlights: Number(g?.highlights) || 0,
    shadows: Number(g?.shadows) || 0,
    whites: Number(g?.whites) || 0,
    blacks: Number(g?.blacks) || 0,
    transparency: g?.transparency != null ? Number(g.transparency) : 1,

    wbPreset: String(g?.wbPreset || "asis"),
    temperature: Number(g?.temperature) || 0,
    tintShift: Number(g?.tintShift) || 0,
    tint: Array.isArray(g?.tint)
      ? [Number(g.tint[0]) || 1, Number(g.tint[1]) || 1, Number(g.tint[2]) || 1]
      : [1, 1, 1],
    vibrance: Number(g?.vibrance) || 0,
    saturation: g?.saturation != null ? Number(g.saturation) : 1,

    hslHue: Array.from(g?.hslHue || [0, 0, 0, 0, 0, 0, 0, 0]),
    hslSat: Array.from(g?.hslSat || [0, 0, 0, 0, 0, 0, 0, 0]),
    hslLight: Array.from(g?.hslLight || [0, 0, 0, 0, 0, 0, 0, 0]),
    pointColor: {
      enabled: !!pc.enabled,
      targetRgb: Array.isArray(pc.targetRgb) ? [Number(pc.targetRgb[0]) || 0.5, Number(pc.targetRgb[1]) || 0.5, Number(pc.targetRgb[2]) || 0.5] : [0.5, 0.5, 0.5],
      targetHsl: Array.isArray(pc.targetHsl) ? [Number(pc.targetHsl[0]) || 0, Number(pc.targetHsl[1]) || 0.5, Number(pc.targetHsl[2]) || 0.5] : [0, 0.5, 0.5],
      tolerance: pc.tolerance != null ? Number(pc.tolerance) : 0.24,
      colorRange: pc.colorRange != null ? Number(pc.colorRange) : 0.52,
      hue: Number(pc.hue) || 0,
      sat: Number(pc.sat) || 0,
      light: Number(pc.light) || 0,
      visualizeRange: !!pc.visualizeRange,
    },

    lutName: String(g?.lutName || ""),
    lutIntensity: g?.lutIntensity != null ? Number(g.lutIntensity) : 1,
  };
}

/**
 * Resolve effective grade parameters respecting per-section eye toggles.
 * (Used consistently by GPU uniform upload, CPU SH baker, and Histogram.)
 */
export function resolveEffectiveGrade(g, { forBake = false } = {}) {
  const lightOn = g.lightEnabled !== false;
  const colorOn = g.colorEnabled !== false;
  const hslOn = g.hslEnabled !== false;
  const lutOn = g.lutEnabled !== false;
  const pcRaw = g.pointColor || createDefaultPointColor();
  const pcHasShift =
    Math.abs(pcRaw.hue || 0) > 1e-4 ||
    Math.abs(pcRaw.sat || 0) > 1e-4 ||
    Math.abs(pcRaw.light || 0) > 1e-4 ||
    (!forBake && !!pcRaw.visualizeRange);

  return {
    blackPoint: Number(g.blackPoint) || 0,
    whitePoint: g.whitePoint != null ? Number(g.whitePoint) : 1,
    gamma: g.gamma != null ? Number(g.gamma) : 1,
    outBlack: Number(g.outBlack) || 0,
    outWhite: g.outWhite != null ? Number(g.outWhite) : 1,

    exposure: lightOn ? (Number(g.exposure) || 0) : 0,
    brightness: lightOn ? (Number(g.brightness) || 0) : 0,
    contrast: lightOn && g.contrast != null ? Number(g.contrast) : 1,
    highlights: lightOn ? (Number(g.highlights) || 0) : 0,
    shadows: lightOn ? (Number(g.shadows) || 0) : 0,
    whites: lightOn ? (Number(g.whites) || 0) : 0,
    blacks: lightOn ? (Number(g.blacks) || 0) : 0,
    transparency: lightOn && g.transparency != null ? Number(g.transparency) : 1,

    temperature: colorOn ? (Number(g.temperature) || 0) : 0,
    tintShift: colorOn ? (Number(g.tintShift) || 0) : 0,
    tint: colorOn && Array.isArray(g.tint) ? g.tint : [1, 1, 1],
    vibrance: colorOn ? (Number(g.vibrance) || 0) : 0,
    saturation: colorOn && g.saturation != null ? Number(g.saturation) : 1,

    hslHue: hslOn && Array.isArray(g.hslHue) ? g.hslHue : [0, 0, 0, 0, 0, 0, 0, 0],
    hslSat: hslOn && Array.isArray(g.hslSat) ? g.hslSat : [0, 0, 0, 0, 0, 0, 0, 0],
    hslLight: hslOn && Array.isArray(g.hslLight) ? g.hslLight : [0, 0, 0, 0, 0, 0, 0, 0],
    pointColorActive: hslOn && !!pcRaw.enabled && pcHasShift,
    pointColor: {
      targetHsl: pcRaw.targetHsl || [0, 0.5, 0.5],
      tolerance: Math.max(0.03, Math.min(0.85, Number(pcRaw.tolerance ?? 0.24))),
      colorRange: Math.max(0.05, Math.min(1.0, Number(pcRaw.colorRange ?? 0.52))),
      hue: Number(pcRaw.hue) || 0,
      sat: Number(pcRaw.sat) || 0,
      light: Number(pcRaw.light) || 0,
      visualizeRange: !forBake && hslOn && !!pcRaw.enabled && !!pcRaw.visualizeRange,
    },

    lutName: lutOn ? String(g.lutName || "") : "",
    lutIntensity: lutOn && g.lutName && g.lutName !== "默认.png" ? (g.lutIntensity ?? 1) : 0,
  };
}

export function isGradeModified(g, { forBake = false } = {}) {
  if (!g) return false;
  const e = resolveEffectiveGrade(g, { forBake });
  if (
    Math.abs(e.exposure) > 1e-4 ||
    Math.abs(e.brightness) > 1e-4 ||
    Math.abs(e.contrast - 1) > 1e-4 ||
    Math.abs(e.blackPoint) > 1e-4 ||
    Math.abs(e.whitePoint - 1) > 1e-4 ||
    Math.abs(e.outBlack) > 1e-4 ||
    Math.abs(e.outWhite - 1) > 1e-4 ||
    Math.abs(e.highlights) > 1e-4 ||
    Math.abs(e.shadows) > 1e-4 ||
    Math.abs(e.whites) > 1e-4 ||
    Math.abs(e.blacks) > 1e-4 ||
    Math.abs(e.saturation - 1) > 1e-4 ||
    Math.abs(e.vibrance) > 1e-4 ||
    Math.abs(e.temperature) > 1e-4 ||
    Math.abs(e.tintShift) > 1e-4 ||
    Math.abs(e.gamma - 1) > 1e-4 ||
    Math.abs(e.transparency - 1) > 1e-4 ||
    Math.abs((e.tint[0] ?? 1) - 1) > 1e-4 ||
    Math.abs((e.tint[1] ?? 1) - 1) > 1e-4 ||
    Math.abs((e.tint[2] ?? 1) - 1) > 1e-4 ||
    e.pointColorActive ||
    (e.lutName && e.lutName !== "默认.png" && e.lutIntensity > 1e-4)
  ) {
    return true;
  }
  for (let i = 0; i < 8; i++) {
    if (
      Math.abs(e.hslHue[i] || 0) > 1e-4 ||
      Math.abs(e.hslSat[i] || 0) > 1e-4 ||
      Math.abs(e.hslLight[i] || 0) > 1e-4
    ) {
      return true;
    }
  }
  return false;
}

export function gradesEqual(a, b) {
  if (!a || !b) return a === b;
  const numEq = (x, y) => Math.abs((Number(x) || 0) - (Number(y) || 0)) < 1e-4;
  if (
    !numEq(a.blackPoint, b.blackPoint) ||
    !numEq(a.whitePoint, b.whitePoint) ||
    !numEq(a.gamma, b.gamma) ||
    !numEq(a.outBlack, b.outBlack) ||
    !numEq(a.outWhite, b.outWhite) ||
    (a.lightEnabled !== false) !== (b.lightEnabled !== false) ||
    (a.colorEnabled !== false) !== (b.colorEnabled !== false) ||
    (a.hslEnabled !== false) !== (b.hslEnabled !== false) ||
    (a.lutEnabled !== false) !== (b.lutEnabled !== false) ||
    !numEq(a.exposure, b.exposure) ||
    !numEq(a.brightness, b.brightness) ||
    !numEq(a.contrast, b.contrast) ||
    !numEq(a.highlights, b.highlights) ||
    !numEq(a.shadows, b.shadows) ||
    !numEq(a.whites, b.whites) ||
    !numEq(a.blacks, b.blacks) ||
    !numEq(a.transparency, b.transparency) ||
    String(a.wbPreset || "asis") !== String(b.wbPreset || "asis") ||
    !numEq(a.temperature, b.temperature) ||
    !numEq(a.tintShift, b.tintShift) ||
    !numEq(a.vibrance, b.vibrance) ||
    !numEq(a.saturation, b.saturation) ||
    String(a.lutName || "") !== String(b.lutName || "") ||
    !numEq(a.lutIntensity, b.lutIntensity)
  ) {
    return false;
  }
  for (let i = 0; i < 8; i++) {
    if (
      !numEq(a.hslHue?.[i], b.hslHue?.[i]) ||
      !numEq(a.hslSat?.[i], b.hslSat?.[i]) ||
      !numEq(a.hslLight?.[i], b.hslLight?.[i])
    ) {
      return false;
    }
  }
  const pa = a.pointColor || createDefaultPointColor();
  const pb = b.pointColor || createDefaultPointColor();
  if (
    !!pa.enabled !== !!pb.enabled ||
    !!pa.visualizeRange !== !!pb.visualizeRange ||
    !numEq(pa.tolerance, pb.tolerance) ||
    !numEq(pa.colorRange, pb.colorRange) ||
    !numEq(pa.hue, pb.hue) ||
    !numEq(pa.sat, pb.sat) ||
    !numEq(pa.light, pb.light)
  ) {
    return false;
  }
  for (let k = 0; k < 3; k++) {
    if (!numEq(pa.targetRgb?.[k], pb.targetRgb?.[k]) || !numEq(pa.targetHsl?.[k], pb.targetHsl?.[k])) {
      return false;
    }
  }
  return true;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep01 = (t) => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

export function rgb2hsl(r, g, b) {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const l = (maxc + minc) * 0.5;
  const d = maxc - minc;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l < 0.5 ? d / (maxc + minc) : d / (2 - maxc - minc);
    if (maxc === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (maxc === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 0.16666667;
  }
  return [h, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 0.16666667) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 0.66666667) return p + (q - p) * (0.66666667 - t) * 6;
  return p;
}

export function hsl2rgb(h, s, l) {
  if (s < 1e-6) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 0.33333333),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 0.33333333),
  ];
}

/**
 * Compute White Balance temperature (-0.5..0.5) and tintShift (-0.5..0.5)
 * that neutralize a sampled gray/white RGB triple [0..1].
 */
export function computeWhiteBalanceFromRgb(r, g, b) {
  const mr = Math.max(0.02, r);
  const mg = Math.max(0.02, g);
  const mb = Math.max(0.02, b);
  // Goal: mr*(1+temp) ≈ mb*(1-temp) -> temp = (mb - mr) / (mb + mr)
  const temp = Math.max(-0.5, Math.min(0.5, (mb - mr) / Math.max(0.04, mb + mr)));
  const avgRB = 0.5 * (mr * (1 + temp) + mb * (1 - temp));
  // Goal: mg*(1 - 0.45*tintShift) ≈ avgRB*(1 + 0.22*tintShift)
  const denom = 0.45 * mg + 0.22 * avgRB;
  const tintShift = Math.max(-0.5, Math.min(0.5, denom > 1e-4 ? (mg - avgRB) / denom : 0));
  return { temperature: temp, tintShift };
}

/**
 * Find closest 8-band HSL index for a normalized hue [0..1].
 */
export function findNearestHslBand(hue01) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 8; i++) {
    let d = Math.abs(hue01 - HSL_CENTERS_NORM[i]);
    d = Math.min(d, 1 - d);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Trilinear sample on a 16x16x16 LUT packed as 256x16 RGBA Uint8Array (ReSplat layout)
export function sampleLutCPU(lutRgba, r, g, b) {
  const sr = clamp01(r) * 15;
  const sg = clamp01(g) * 15;
  const sb = clamp01(b) * 15;
  const r0 = Math.floor(sr), r1 = Math.min(15, r0 + 1), fr = sr - r0;
  const g0 = Math.floor(sg), g1 = Math.min(15, g0 + 1), fg = sg - g0;
  const b0 = Math.floor(sb), b1 = Math.min(15, b0 + 1), fb = sb - b0;

  const fetch = (ri, gi, bi) => {
    const x = bi * 16 + ri;
    const idx = (gi * 256 + x) * 4;
    return [lutRgba[idx] / 255, lutRgba[idx + 1] / 255, lutRgba[idx + 2] / 255];
  };

  const lerp3 = (a, b3, t) => [
    a[0] + (b3[0] - a[0]) * t,
    a[1] + (b3[1] - a[1]) * t,
    a[2] + (b3[2] - a[2]) * t,
  ];

  const c000 = fetch(r0, g0, b0), c100 = fetch(r1, g0, b0);
  const c010 = fetch(r0, g1, b0), c110 = fetch(r1, g1, b0);
  const c001 = fetch(r0, g0, b1), c101 = fetch(r1, g0, b1);
  const c011 = fetch(r0, g1, b1), c111 = fetch(r1, g1, b1);

  const c00 = lerp3(c000, c100, fr);
  const c10 = lerp3(c010, c110, fr);
  const c01 = lerp3(c001, c101, fr);
  const c11 = lerp3(c011, c111, fr);
  const c0 = lerp3(c00, c10, fg);
  const c1 = lerp3(c01, c11, fg);
  return lerp3(c0, c1, fb);
}

/**
 * Exact unified color grading pipeline (matches WebGL2 shader operation-for-operation):
 * 1. Exposure + Input Levels (Black/White Point) + Temperature + TintShift + Legacy Tint + Brightness
 * 2. Contrast
 * 3. Shadows / Highlights / Blacks / Whites smooth tonal shaping
 * 4. Vibrance (smart low-sat boost) + Global Saturation (Rec.601 luma)
 * 5. Input Midtone Gamma
 * 6. 8-Band HSL Mixer + Lightroom Point-Color Targeted Range
 * 7. Optional 16^3 3D LUT trilinear mix
 * 8. Output Levels remap [outBlack .. outWhite]
 * 9. Opacity multiplier
 */
export function applyColorGradeCPU(r, g, b, alpha, grade, lutRgba = null, { forBake = false } = {}) {
  const e = resolveEffectiveGrade(grade, { forBake });

  const expGain = Math.pow(2.0, e.exposure);
  const bp = e.blackPoint;
  const wp = e.whitePoint;
  const invSpan = 1.0 / Math.max(0.001, wp - bp);
  const tint = e.tint;
  const temp = e.temperature;
  const ts = e.tintShift;

  const tintR = tint[0] * (1 + ts * 0.22);
  const tintG = tint[1] * (1 - ts * 0.45);
  const tintB = tint[2] * (1 + ts * 0.22);

  const sr = expGain * invSpan * tintR * (1 + temp);
  const sg = expGain * invSpan * tintG;
  const sb = expGain * invSpan * tintB * (1 - temp);

  let cr = (r - bp) * sr + e.brightness;
  let cg = (g - bp) * sg + e.brightness;
  let cb = (b - bp) * sb + e.brightness;

  cr = (cr - 0.5) * e.contrast + 0.5;
  cg = (cg - 0.5) * e.contrast + 0.5;
  cb = (cb - 0.5) * e.contrast + 0.5;

  // Shadows, Highlights, Blacks & Whites smooth tonal curves
  if (
    Math.abs(e.shadows) > 1e-4 ||
    Math.abs(e.highlights) > 1e-4 ||
    Math.abs(e.blacks) > 1e-4 ||
    Math.abs(e.whites) > 1e-4
  ) {
    const lum = clamp01(cr * 0.299 + cg * 0.587 + cb * 0.114);
    const invL = 1.0 - lum;
    const shW = invL * invL;
    const hiW = lum * lum;
    const blW = shW * invL;
    const whW = hiW * lum;
    const delta =
      e.shadows * 0.34 * shW +
      e.highlights * 0.34 * hiW +
      e.blacks * 0.28 * blW +
      e.whites * 0.28 * whW;
    cr += delta;
    cg += delta;
    cb += delta;
  }

  // Vibrance (boosts less-saturated colors while protecting already saturated / skin tones)
  if (Math.abs(e.vibrance) > 1e-4) {
    const cMax = Math.max(cr, cg, cb);
    const cMin = Math.min(cr, cg, cb);
    const curSat = clamp01(cMax - cMin);
    const greyV = cr * 0.299 + cg * 0.587 + cb * 0.114;
    const vibGain = 1.0 + e.vibrance * (1.0 - curSat) * 0.85;
    cr = greyV + (cr - greyV) * vibGain;
    cg = greyV + (cg - greyV) * vibGain;
    cb = greyV + (cb - greyV) * vibGain;
  }

  // Global Saturation
  const grey = cr * 0.299 + cg * 0.587 + cb * 0.114;
  cr = clamp01(grey + (cr - grey) * e.saturation);
  cg = clamp01(grey + (cg - grey) * e.saturation);
  cb = clamp01(grey + (cb - grey) * e.saturation);

  // Input Midtone Gamma
  if (Math.abs(e.gamma - 1) > 1e-3) {
    const invG = 1.0 / Math.max(0.1, e.gamma);
    cr = Math.pow(Math.max(cr, 1e-4), invG);
    cg = Math.pow(Math.max(cg, 1e-4), invG);
    cb = Math.pow(Math.max(cb, 1e-4), invG);
  }

  // 8-Band HSL Mixer
  let hasHsl = false;
  for (let i = 0; i < 8; i++) {
    if (e.hslHue[i] !== 0 || e.hslSat[i] !== 0 || e.hslLight[i] !== 0) {
      hasHsl = true;
      break;
    }
  }
  if (hasHsl) {
    const [h0, s0, l0] = rgb2hsl(cr, cg, cb);
    let tw = 0, shSum = 0, ssSum = 0, slSum = 0;
    for (let i = 0; i < 8; i++) {
      let d = Math.abs(h0 - HSL_CENTERS_NORM[i]);
      d = Math.min(d, 1 - d);
      const hw = HSL_HALF_WIDTHS_NORM[i];
      if (d < hw) {
        const t = 1 - d / hw;
        const w = t * t * (3 - 2 * t);
        tw += w;
        shSum += w * e.hslHue[i];
        ssSum += w * e.hslSat[i];
        slSum += w * e.hslLight[i];
      }
    }
    if (tw > 1e-4) {
      const invW = 1 / tw;
      const nh = (((h0 + shSum * invW) % 1) + 1) % 1;
      const ns = clamp01(s0 + ssSum * invW);
      const nl = clamp01(l0 + slSum * invW);
      [cr, cg, cb] = hsl2rgb(nh, ns, nl);
    }
  }

  // Lightroom Point-Color Targeted Eyedropper Range
  if (e.pointColorActive) {
    const pc = e.pointColor;
    const [h0, s0, l0] = rgb2hsl(cr, cg, cb);
    let dh = Math.abs(h0 - pc.targetHsl[0]);
    dh = Math.min(dh, 1 - dh);
    const hw = Math.max(0.015, pc.tolerance * 0.36);
    const wh = smoothstep01(1 - dh / hw);

    const satTol = 0.14 + pc.colorRange * 0.86;
    const ds = Math.abs(s0 - pc.targetHsl[1]);
    const ws = smoothstep01(1 - Math.max(0, ds - satTol * 0.32) / (satTol * 0.68 + 1e-4));

    const lumTol = 0.18 + pc.colorRange * 0.82;
    const dl = Math.abs(l0 - pc.targetHsl[2]);
    const wl = smoothstep01(1 - Math.max(0, dl - lumTol * 0.32) / (lumTol * 0.68 + 1e-4));

    const wpPc = wh * ws * wl;
    if (pc.visualizeRange) {
      const lumVis = (cr * 0.299 + cg * 0.587 + cb * 0.114) * 0.45;
      cr = lumVis + (cr - lumVis) * wpPc;
      cg = lumVis + (cg - lumVis) * wpPc;
      cb = lumVis + (cb - lumVis) * wpPc;
    } else if (wpPc > 1e-4) {
      const nh = (((h0 + pc.hue * wpPc) % 1) + 1) % 1;
      const ns = clamp01(s0 + pc.sat * wpPc);
      const nl = clamp01(l0 + pc.light * wpPc);
      [cr, cg, cb] = hsl2rgb(nh, ns, nl);
    }
  }

  // 16^3 3D LUT
  if (lutRgba && e.lutIntensity > 1e-4) {
    const [lr, lg, lb] = sampleLutCPU(lutRgba, cr, cg, cb);
    const k = clamp01(e.lutIntensity);
    cr = cr + (lr - cr) * k;
    cg = cg + (lg - cg) * k;
    cb = cb + (lb - cb) * k;
  }

  // Output Levels remap [outBlack .. outWhite]
  if (Math.abs(e.outBlack) > 1e-4 || Math.abs(e.outWhite - 1) > 1e-4) {
    const ob = e.outBlack;
    const spanOut = e.outWhite - ob;
    cr = ob + clamp01(cr) * spanOut;
    cg = ob + clamp01(cg) * spanOut;
    cb = ob + clamp01(cb) * spanOut;
  }

  return [clamp01(cr), clamp01(cg), clamp01(cb), clamp01(alpha * e.transparency)];
}

/**
 * Linear scale + saturation color grading for higher-order SH coefficients (f_rest_0..44).
 * Zero DC offset, zero nonlinear distortion — preserves specular directionality cleanly!
 */
export function applyColorGradeSHBandCPU(r, g, b, grade) {
  const e = resolveEffectiveGrade(grade, { forBake: true });
  const expGain = Math.pow(2.0, e.exposure);
  const invSpan = 1.0 / Math.max(0.001, e.whitePoint - e.blackPoint);
  const outSpan = e.outWhite - e.outBlack;
  const tintR = e.tint[0] * (1 + e.tintShift * 0.22);
  const tintG = e.tint[1] * (1 - e.tintShift * 0.45);
  const tintB = e.tint[2] * (1 + e.tintShift * 0.22);

  const cr = r * expGain * invSpan * outSpan * e.contrast * tintR * (1 + e.temperature);
  const cg = g * expGain * invSpan * outSpan * e.contrast * tintG;
  const cb = b * expGain * invSpan * outSpan * e.contrast * tintB * (1 - e.temperature);
  const grey = cr * 0.299 + cg * 0.587 + cb * 0.114;
  return [
    grey + (cr - grey) * e.saturation,
    grey + (cg - grey) * e.saturation,
    grey + (cb - grey) * e.saturation,
  ];
}

/**
 * Real-time RGB + Luminance Histogram renderer with optional interactive 5-zone hover highlight.
 */
export function drawHistogram(
  canvas,
  cloud,
  grade,
  activeObjectIds = null,
  lutRgba = null,
  hoveredZoneId = null,
) {
  if (!canvas || !cloud) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#101216";
  ctx.fillRect(0, 0, w, h);

  // Highlight hovered Lightroom tonal zone subtly BEHIND histogram curves!
  if (hoveredZoneId) {
    const z = HISTOGRAM_ZONES.find((item) => item.id === hoveredZoneId);
    if (z) {
      const x0 = z.start * w;
      const zw = (z.end - z.start) * w;
      ctx.fillStyle = "rgba(249, 115, 22, 0.14)";
      ctx.fillRect(x0, 0, zw, h);
      ctx.strokeStyle = "rgba(249, 115, 22, 0.42)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, 0.5, Math.max(1, zw - 1), h - 1);
    }
  }

  // Subtle vertical zone boundary guides
  ctx.strokeStyle = "rgba(255,255,255,0.055)";
  ctx.lineWidth = 1;
  for (let i = 1; i < HISTOGRAM_ZONES.length; i++) {
    const gx = Math.round(HISTOGRAM_ZONES[i].start * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, h);
    ctx.stroke();
  }

  const bins = 64;
  const rHist = new Uint32Array(bins);
  const gHist = new Uint32Array(bins);
  const bHist = new Uint32Array(bins);
  const lHist = new Uint32Array(bins);

  const n = cloud.n;
  const step = Math.max(1, Math.floor(n / 28000));
  const useGrade = isGradeModified(grade);
  let hasSel = false;
  for (let i = 0; i < n; i++) {
    if (!(cloud.flags[i] & 2) && (cloud.flags[i] & 1)) {
      hasSel = true;
      break;
    }
  }

  let maxBin = 1;
  let clippedHi = 0;
  let clippedLo = 0;
  let sampled = 0;
  for (let i = 0; i < n; i += step) {
    if (cloud.flags[i] & 6) continue;
    if (hasSel && !(cloud.flags[i] & 1)) continue;
    if (!hasSel && activeObjectIds && activeObjectIds.size > 0 && !activeObjectIds.has(cloud.objectIds[i])) continue;

    const i4 = i * 4;
    let r = cloud.rgba[i4] / 255;
    let g = cloud.rgba[i4 + 1] / 255;
    let b = cloud.rgba[i4 + 2] / 255;
    if (useGrade) {
      [r, g, b] = applyColorGradeCPU(r, g, b, 1, grade, lutRgba);
    }
    sampled++;
    if (r >= 0.99 || g >= 0.99 || b >= 0.99) clippedHi++;
    if (r <= 0.01 && g <= 0.01 && b <= 0.01) clippedLo++;

    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const br = Math.min(bins - 1, Math.max(0, (r * bins) | 0));
    const bg = Math.min(bins - 1, Math.max(0, (g * bins) | 0));
    const bb = Math.min(bins - 1, Math.max(0, (b * bins) | 0));
    const bl = Math.min(bins - 1, Math.max(0, (l * bins) | 0));
    if (++rHist[br] > maxBin) maxBin = rHist[br];
    if (++gHist[bg] > maxBin) maxBin = gHist[bg];
    if (++bHist[bb] > maxBin) maxBin = bHist[bb];
    if (++lHist[bl] > maxBin) maxBin = lHist[bl];
  }

  const drawChannel = (arr, fillStyle, strokeStyle) => {
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < bins; i++) {
      const x = (i / (bins - 1)) * w;
      const y = h - (arr[i] / maxBin) * (h - 8);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  };

  ctx.globalCompositeOperation = "lighter";
  drawChannel(rHist, "rgba(239,68,68,0.24)", "rgba(239,68,68,0.88)");
  drawChannel(gHist, "rgba(34,197,94,0.24)", "rgba(34,197,94,0.88)");
  drawChannel(bHist, "rgba(59,130,246,0.24)", "rgba(59,130,246,0.88)");
  ctx.globalCompositeOperation = "source-over";
  drawChannel(lHist, "rgba(226,232,240,0.08)", "rgba(241,245,249,0.72)");

  // Subtle clipping badges for shadow/highlight overexposure feedback
  if (sampled > 0) {
    if (clippedLo / sampled > 0.03) {
      ctx.fillStyle = "#38bdf8";
      ctx.fillRect(3, 3, 5, 5);
    }
    if (clippedHi / sampled > 0.03) {
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(w - 8, 3, 5, 5);
    }
  }
}
