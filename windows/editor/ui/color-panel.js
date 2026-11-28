/**
 * @module ui/color-panel
 * @description Photoshop Camera Raw / Lightroom-grade Color Grading Panel Controller:
 * - Interactive 5-zone RGB/Luma Histogram (hover highlight + horizontal drag adjusts Blacks/Shadows/Exposure/Highlights/Whites)
 * - Input Levels 3-Triangle Strip (Black / Midtone Gamma / White) + Dual-Thumb Output Levels Bar (0..255)
 * - Center-aligned symmetric sliders with bi-directional fills + inline click-to-edit numeric readouts
 * - Collapsible "亮" (with Transparency at bottom) & "颜色" (WB presets + WB eyedropper + Temp/Tint/Vibrance/Sat) with Eye toggles
 * - "HSL混色器" with Lightroom Targeted Eyedropper (click/drag on 3D scene to live-adjust Hue/Sat/Light + Tolerance & Color Range + Range visualization) + 8-Band HSL
 * - Collapsible 3D LUT presets
 */
import {
  HSL_BANDS,
  WHITE_BALANCE_PRESETS,
  HISTOGRAM_ZONES,
  cloneGrade,
  gradesEqual,
  drawHistogram,
  findNearestHslBand,
} from "../color-grade.js";
import { t } from "../i18n.js";

const SVG_EYE_ON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>`;
const SVG_EYE_OFF = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a13 13 0 0 1-1.7 2.7"/><path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;
const SVG_EYEDROPPER = `<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m18.5 3.5 2 2a1.8 1.8 0 0 1 0 2.6l-2.3 2.3-4.6-4.6 2.3-2.3a1.8 1.8 0 0 1 2.6 0Z"/><path d="m14.8 7.2-8.4 8.4a2.2 2.2 0 0 0-.6 1.2L5 20l3.2-.8c.4-.1.9-.3 1.2-.6l8.4-8.4"/></svg>`;

const LIGHT_SLIDERS = [
  { key: "exposure", get label() { return t("editor.color.sliders.exposure"); }, uiMin: -2.0, uiMax: 2.0, uiStep: 0.01, uiDef: 0.0, toUi: (g) => g.exposure, fromUi: (g, v) => { g.exposure = v; }, fmt: (v) => (v > 0.004 ? "+" : "") + v.toFixed(2), parse: (s) => parseFloat(s) },
  { key: "contrast", get label() { return t("editor.color.sliders.contrast"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (g) => Math.round(((g.contrast ?? 1) - 1) / 0.008), fromUi: (g, v) => { g.contrast = 1 + v * 0.008; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
  { key: "highlights", get label() { return t("editor.color.sliders.highlights"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (g) => Math.round((g.highlights || 0) * 100), fromUi: (g, v) => { g.highlights = v / 100; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
  { key: "shadows", get label() { return t("editor.color.sliders.shadows"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (g) => Math.round((g.shadows || 0) * 100), fromUi: (g, v) => { g.shadows = v / 100; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
  { key: "whites", get label() { return t("editor.color.sliders.whites"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (g) => Math.round((g.whites || 0) * 100), fromUi: (g, v) => { g.whites = v / 100; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
  { key: "blacks", get label() { return t("editor.color.sliders.blacks"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (g) => Math.round((g.blacks || 0) * 100), fromUi: (g, v) => { g.blacks = v / 100; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
  { key: "transparency", get label() { return t("editor.color.sliders.transparency"); }, uiMin: 0, uiMax: 200, uiStep: 1, uiDef: 100, toUi: (g) => Math.round((g.transparency ?? 1) * 100), fromUi: (g, v) => { g.transparency = v / 100; }, fmt: (v) => Math.round(v) + "%", parse: (s) => parseFloat(String(s).replace("%", "")) },
];

const COLOR_SLIDERS = [
  { key: "temperature", get label() { return t("editor.color.sliders.temperature"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, grad: "linear-gradient(90deg, #3b82f6 0%, #717c8c 50%, #f59e0b 100%)", toUi: (g) => Math.round((g.temperature || 0) * 200), fromUi: (g, v) => { g.temperature = v / 200; g.wbPreset = "custom"; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
  { key: "tintShift", get label() { return t("editor.color.sliders.tintShift"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, grad: "linear-gradient(90deg, #22c55e 0%, #717c8c 50%, #ec4899 100%)", toUi: (g) => Math.round((g.tintShift || 0) * 200), fromUi: (g, v) => { g.tintShift = v / 200; g.wbPreset = "custom"; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
  { key: "vibrance", get label() { return t("editor.color.sliders.vibrance"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, grad: "linear-gradient(90deg, #4b5563 0%, #64748b 50%, #f97316 100%)", toUi: (g) => Math.round((g.vibrance || 0) * 100), fromUi: (g, v) => { g.vibrance = v / 100; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
  { key: "saturation", get label() { return t("editor.color.sliders.saturation"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, grad: "linear-gradient(90deg, #4b5563 0%, #64748b 50%, #ef4444 100%)", toUi: (g) => Math.round(((g.saturation ?? 1) - 1) * 100), fromUi: (g, v) => { g.saturation = 1 + v / 100; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class ColorPanelController {
  constructor({
    getGrade,
    getCloud,
    getActiveObjectIds,
    getLutRgba,
    onChange,
    onCommit,
    onTogglePickMode,
    getPickMode,
  }) {
    this.getGrade = getGrade;
    this.getCloud = getCloud;
    this.getActiveObjectIds = getActiveObjectIds;
    this.getLutRgba = getLutRgba;
    this.onChange = onChange;
    this.onCommit = onCommit || null;
    this.onTogglePickMode = onTogglePickMode;
    this.getPickMode = getPickMode;

    this.activeHslBand = 0;
    this.hslTargetChannel = "sat"; // "hue" | "sat" | "light" (used by Lightroom TAT screen drag!)
    this.hoveredZoneId = null;
    this.draggingZone = null;

    this._sliderBindings = new Map();
    this._hslBandBindings = {};
    this._pointColorBindings = {};
    this._eyeBtns = {};

    this._buildAll();
  }

  _emitCommit(beforeGrade, detailLabel = "") {
    if (!beforeGrade || !this.onCommit) return;
    const afterGrade = cloneGrade(this.getGrade());
    if (!gradesEqual(beforeGrade, afterGrade)) {
      this.onCommit(beforeGrade, afterGrade, detailLabel);
    }
  }

  _buildAll() {
    this._setupHistogramInteraction();
    this._setupInputLevels();
    this._setupOutputLevels();
    this._setupSectionEyeToggles();
    this._buildSliderList("color-light-sliders", LIGHT_SLIDERS);
    this._buildWbControls();
    this._buildSliderList("color-tone-sliders", COLOR_SLIDERS);
    this._buildHslMixer();
    this.syncUI();
  }

  /**
   * Create a single PS/Lightroom-style center-aligned slider row with:
   * - Label (double-click to reset to default)
   * - Center-tick track + bi-directional fill (or custom gradient)
   * - Click-to-edit inline numeric readout (typing applies live immediately; click outside hides box!)
   */
  _createCenterSliderRow(spec, onValueSet) {
    const row = document.createElement("div");
    row.className = "cr-slider-row";

    const lbl = document.createElement("span");
    lbl.className = "cr-lbl";
    lbl.textContent = spec.label;
    lbl.title = t("editor.color.dblClickReset");

    const trackWrap = document.createElement("div");
    trackWrap.className = "cr-track-wrap";
    if (spec.grad) trackWrap.style.setProperty("--cr-track-bg", spec.grad);

    const fill = document.createElement("div");
    fill.className = "cr-track-fill";

    const midTick = document.createElement("div");
    midTick.className = "cr-mid-tick";

    const inp = document.createElement("input");
    inp.type = "range";
    inp.className = "cr-range";
    inp.min = String(spec.uiMin);
    inp.max = String(spec.uiMax);
    inp.step = String(spec.uiStep);
    inp.value = String(spec.uiDef);

    trackWrap.append(fill, midTick, inp);

    // Inline click-to-edit value box
    const valWrap = document.createElement("div");
    valWrap.className = "cr-val-wrap";

    const valText = document.createElement("span");
    valText.className = "cr-val-text";
    valText.textContent = spec.fmt(spec.uiDef);
    valText.title = t("editor.color.clickEditVal");

    const valInput = document.createElement("input");
    valInput.type = "text";
    valInput.className = "cr-val-input hidden";
    valInput.inputMode = "decimal";

    valWrap.append(valText, valInput);
    row.append(lbl, trackWrap, valWrap);

    const updateVisual = (uiVal) => {
      const clamped = clamp(uiVal, spec.uiMin, spec.uiMax);
      inp.value = String(clamped);
      valText.textContent = spec.fmt(clamped);
      const pct = ((clamped - spec.uiMin) / Math.max(1e-6, spec.uiMax - spec.uiMin)) * 100;
      const defPct = ((spec.uiDef - spec.uiMin) / Math.max(1e-6, spec.uiMax - spec.uiMin)) * 100;
      if (spec.grad) {
        fill.style.display = "none";
      } else {
        fill.style.display = "block";
        const left = Math.min(pct, defPct);
        const width = Math.abs(pct - defPct);
        fill.style.left = `${left.toFixed(2)}%`;
        fill.style.width = `${width.toFixed(2)}%`;
      }
      valText.classList.toggle("modified", Math.abs(clamped - spec.uiDef) > spec.uiStep * 0.4);
    };

    const applyUiVal = (rawVal) => {
      const clamped = clamp(rawVal, spec.uiMin, spec.uiMax);
      onValueSet(clamped);
      updateVisual(clamped);
      this.onChange();
    };

    let dragBefore = null;
    const commitDrag = () => {
      if (!dragBefore) return;
      const before = dragBefore;
      dragBefore = null;
      this._emitCommit(before, spec.label);
    };
    inp.addEventListener("pointerdown", (e) => {
      if (e.button === 0) dragBefore = cloneGrade(this.getGrade());
    });
    inp.addEventListener("pointerup", commitDrag);
    inp.addEventListener("pointercancel", commitDrag);
    inp.addEventListener("input", () => {
      if (!dragBefore) dragBefore = cloneGrade(this.getGrade());
      applyUiVal(Number(inp.value));
    });
    inp.addEventListener("change", commitDrag);

    const resetToDefault = () => {
      const before = cloneGrade(this.getGrade());
      dragBefore = null;
      applyUiVal(spec.uiDef);
      this._emitCommit(before, spec.label);
    };
    inp.addEventListener("dblclick", resetToDefault);
    lbl.addEventListener("dblclick", resetToDefault);

    // Click numeric text -> show inline editable input; live-apply on input; hide on blur/click-outside/Enter!
    let editBefore = null;
    const openEditor = () => {
      editBefore = cloneGrade(this.getGrade());
      valText.classList.add("hidden");
      valInput.classList.remove("hidden");
      const cur = Number(inp.value);
      valInput.value = spec.uiStep < 1 ? cur.toFixed(2) : String(Math.round(cur));
      valInput.focus();
      valInput.select();
    };
    const closeEditor = () => {
      if (valInput.classList.contains("hidden")) return;
      const parsed = spec.parse(valInput.value);
      if (Number.isFinite(parsed)) {
        applyUiVal(parsed);
      }
      valInput.classList.add("hidden");
      valText.classList.remove("hidden");
      const before = editBefore;
      editBefore = null;
      this._emitCommit(before, spec.label);
    };

    valText.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor();
    });
    valInput.addEventListener("input", () => {
      const parsed = spec.parse(valInput.value);
      if (Number.isFinite(parsed)) {
        const clamped = clamp(parsed, spec.uiMin, spec.uiMax);
        onValueSet(clamped);
        // Update slider & fill without stealing input focus/caret
        inp.value = String(clamped);
        valText.textContent = spec.fmt(clamped);
        const pct = ((clamped - spec.uiMin) / Math.max(1e-6, spec.uiMax - spec.uiMin)) * 100;
        const defPct = ((spec.uiDef - spec.uiMin) / Math.max(1e-6, spec.uiMax - spec.uiMin)) * 100;
        if (!spec.grad) {
          fill.style.left = `${Math.min(pct, defPct).toFixed(2)}%`;
          fill.style.width = `${Math.abs(pct - defPct).toFixed(2)}%`;
        }
        this.onChange();
      }
    });
    valInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        closeEditor();
      }
    });
    valInput.addEventListener("blur", closeEditor);

    return { row, lbl, inp, valText, valInput, updateVisual, spec };
  }

  _buildSliderList(containerId, specs) {
    const root = document.getElementById(containerId);
    if (!root) return;
    root.innerHTML = "";
    for (const spec of specs) {
      const binding = this._createCenterSliderRow(spec, (v) => {
        spec.fromUi(this.getGrade(), v);
        if (spec.key === "temperature" || spec.key === "tintShift") {
          const sel = document.getElementById("color-wb-preset");
          if (sel) sel.value = "custom";
        }
      });
      this._sliderBindings.set(spec.key, binding);
      root.appendChild(binding.row);
    }
  }

  _setupSectionEyeToggles() {
    for (const [btnId, prop] of [
      ["btn-eye-light", "lightEnabled"],
      ["btn-eye-color", "colorEnabled"],
      ["btn-eye-hsl", "hslEnabled"],
      ["btn-eye-lut", "lutEnabled"],
    ]) {
      const btn = document.getElementById(btnId);
      if (!btn) continue;
      this._eyeBtns[prop] = btn;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const before = cloneGrade(this.getGrade());
        const g = this.getGrade();
        g[prop] = g[prop] === false;
        this._syncEyeButtons();
        this.onChange();
        this._emitCommit(before, prop);
      });
    }
  }

  _syncEyeButtons() {
    const g = this.getGrade();
    for (const [prop, btn] of Object.entries(this._eyeBtns)) {
      const on = g[prop] !== false;
      btn.innerHTML = on ? SVG_EYE_ON : SVG_EYE_OFF;
      btn.classList.toggle("off", !on);
      btn.closest(".cr-section")?.classList.toggle("section-muted", !on);
    }
  }

  _buildWbControls() {
    const sel = document.getElementById("color-wb-preset");
    if (sel) {
      sel.innerHTML = "";
      for (const p of WHITE_BALANCE_PRESETS) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.label;
        sel.appendChild(opt);
      }
      const customOpt = document.createElement("option");
      customOpt.value = "custom";
      customOpt.textContent = t("editor.color.wbCustom");
      sel.appendChild(customOpt);

      sel.addEventListener("change", () => {
        const before = cloneGrade(this.getGrade());
        const g = this.getGrade();
        g.wbPreset = sel.value;
        const p = WHITE_BALANCE_PRESETS.find((x) => x.id === sel.value);
        if (p) {
          g.temperature = p.temp;
          g.tintShift = p.tintShift;
          this.syncUI();
          this.onChange();
          this._emitCommit(before, p.label);
        }
      });
    }

    const wbBtn = document.getElementById("btn-wb-eyedropper");
    if (wbBtn) {
      wbBtn.innerHTML = SVG_EYEDROPPER;
      wbBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onTogglePickMode?.("wb");
      });
    }
  }

  // Interactive 5-Zone Lightroom Histogram (hover shows zone; horizontal LEFT/RIGHT drag adjusts parameter!)
  _setupHistogramInteraction() {
    const canvas = document.getElementById("histogram-canvas");
    const badge = document.getElementById("hist-zone-badge");
    if (!canvas) return;

    const getZoneAtClientX = (clientX) => {
      const r = canvas.getBoundingClientRect();
      const nx = clamp((clientX - r.left) / Math.max(1, r.width), 0, 0.9999);
      return HISTOGRAM_ZONES.find((z) => nx >= z.start && nx < z.end) || HISTOGRAM_ZONES[2];
    };

    const updateZoneBadge = (zone) => {
      if (!badge) return;
      if (!zone) {
        badge.classList.add("hidden");
        return;
      }
      const b = this._sliderBindings.get(zone.key);
      const valStr = b ? b.spec.fmt(b.spec.toUi(this.getGrade())) : "";
      badge.textContent = `${zone.label} ${valStr}  ◀ ▶`;
      badge.classList.remove("hidden");
    };

    canvas.addEventListener("pointermove", (e) => {
      if (this.draggingZone) {
        const { zone, startX, startVal } = this.draggingZone;
        const r = canvas.getBoundingClientRect();
        const dxNorm = (e.clientX - startX) / Math.max(80, r.width * 0.65);
        const nextVal = clamp(startVal + dxNorm * zone.sens, zone.min, zone.max);
        const g = this.getGrade();
        g[zone.key] = zone.key === "exposure" ? Number(nextVal.toFixed(2)) : Math.round(nextVal * 100) / 100;
        this.syncUI();
        this.onChange();
        updateZoneBadge(zone);
        return;
      }
      const z = getZoneAtClientX(e.clientX);
      if (z.id !== this.hoveredZoneId) {
        this.hoveredZoneId = z.id;
        this.redrawHistogram();
      }
      updateZoneBadge(z);
    });

    canvas.addEventListener("pointerleave", () => {
      if (this.draggingZone) return;
      this.hoveredZoneId = null;
      updateZoneBadge(null);
      this.redrawHistogram();
    });

    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const zone = getZoneAtClientX(e.clientX);
      this.hoveredZoneId = zone.id;
      this.draggingZone = {
        zone,
        startX: e.clientX,
        startVal: Number(this.getGrade()[zone.key]) || 0,
        beforeGrade: cloneGrade(this.getGrade()),
      };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      canvas.classList.add("dragging");
      updateZoneBadge(zone);
      this.redrawHistogram();
    });

    const endDrag = () => {
      if (!this.draggingZone) return;
      const { beforeGrade, zone } = this.draggingZone;
      this.draggingZone = null;
      canvas.classList.remove("dragging");
      this._emitCommit(beforeGrade, zone.label);
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    canvas.addEventListener("dblclick", (e) => {
      const before = cloneGrade(this.getGrade());
      const zone = getZoneAtClientX(e.clientX);
      this.getGrade()[zone.key] = 0;
      this.syncUI();
      this.onChange();
      updateZoneBadge(zone);
      this._emitCommit(before, zone.label);
    });
  }

  // Input Levels 3-Triangle Row (Black / Midtone Gamma / White, matching PS Fig 2!)
  _setupInputLevels() {
    const track = document.getElementById("levels-input-track");
    const hBlack = document.getElementById("lvl-in-black");
    const hMid = document.getElementById("lvl-in-mid");
    const hWhite = document.getElementById("lvl-in-white");
    if (!track || !hBlack || !hMid || !hWhite) return;

    let activeDrag = null;
    let dragBefore = null;
    const onMove = (e) => {
      if (!activeDrag) return;
      const r = track.getBoundingClientRect();
      const t = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
      const g = this.getGrade();
      if (activeDrag === "black") {
        g.blackPoint = clamp(t, 0, Math.max(0, (g.whitePoint ?? 1) - 0.02));
      } else if (activeDrag === "white") {
        g.whitePoint = clamp(t, Math.min(0.98, (g.blackPoint || 0) + 0.02), 1);
      } else if (activeDrag === "mid") {
        const bp = g.blackPoint || 0;
        const wp = g.whitePoint ?? 1;
        const rel = clamp((t - bp) / Math.max(0.02, wp - bp), 0.04, 0.96);
        // rel = 0.5 -> gamma = 1.0; moving mid triangle LEFT brightens (gamma > 1), RIGHT darkens (gamma < 1) just like Photoshop!
        const exp = (0.5 - rel) * 3.6;
        g.gamma = clamp(Math.pow(2, exp), 0.25, 4.0);
      }
      this._syncLevelsUI();
      this.onChange();
    };
    const endDrag = () => {
      if (!activeDrag) return;
      const before = dragBefore;
      activeDrag = null;
      dragBefore = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      this._emitCommit(before, "levels-in");
    };

    for (const [el, kind] of [[hBlack, "black"], [hMid, "mid"], [hWhite, "white"]]) {
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        activeDrag = kind;
        dragBefore = cloneGrade(this.getGrade());
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", endDrag);
      });
    }

    track.addEventListener("dblclick", () => {
      const before = cloneGrade(this.getGrade());
      const g = this.getGrade();
      g.blackPoint = 0;
      g.gamma = 1;
      g.whitePoint = 1;
      this._syncLevelsUI();
      this.onChange();
      this._emitCommit(before, "levels-in");
    });
  }

  // Output Levels Dual-Thumb Slider (OutBlack 0 .. OutWhite 255)
  _setupOutputLevels() {
    const track = document.getElementById("levels-output-track");
    const hLo = document.getElementById("lvl-out-black");
    const hHi = document.getElementById("lvl-out-white");
    if (!track || !hLo || !hHi) return;

    let activeDrag = null;
    let dragBefore = null;
    const onMove = (e) => {
      if (!activeDrag) return;
      const r = track.getBoundingClientRect();
      const t = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
      const g = this.getGrade();
      if (activeDrag === "lo") {
        g.outBlack = clamp(t, 0, Math.max(0, (g.outWhite ?? 1) - 0.01));
      } else {
        g.outWhite = clamp(t, Math.min(0.99, (g.outBlack || 0) + 0.01), 1);
      }
      this._syncLevelsUI();
      this.onChange();
    };
    const endDrag = () => {
      if (!activeDrag) return;
      const before = dragBefore;
      activeDrag = null;
      dragBefore = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      this._emitCommit(before, "levels-out");
    };

    for (const [el, kind] of [[hLo, "lo"], [hHi, "hi"]]) {
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        activeDrag = kind;
        dragBefore = cloneGrade(this.getGrade());
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", endDrag);
      });
    }

    track.addEventListener("dblclick", () => {
      const before = cloneGrade(this.getGrade());
      const g = this.getGrade();
      g.outBlack = 0;
      g.outWhite = 1;
      this._syncLevelsUI();
      this.onChange();
      this._emitCommit(before, "levels-out");
    });
  }

  _syncLevelsUI() {
    const g = this.getGrade();
    const bp = clamp(g.blackPoint || 0, 0, 0.98);
    const wp = clamp(g.whitePoint ?? 1, bp + 0.02, 1);
    const gamma = clamp(g.gamma ?? 1, 0.25, 4.0);
    // Inverse of exp = (0.5 - rel) * 3.6
    const rel = clamp(0.5 - Math.log2(gamma) / 3.6, 0.04, 0.96);
    const midPos = bp + rel * (wp - bp);

    const hBlack = document.getElementById("lvl-in-black");
    const hMid = document.getElementById("lvl-in-mid");
    const hWhite = document.getElementById("lvl-in-white");
    if (hBlack) hBlack.style.left = `${(bp * 100).toFixed(2)}%`;
    if (hMid) hMid.style.left = `${(midPos * 100).toFixed(2)}%`;
    if (hWhite) hWhite.style.left = `${(wp * 100).toFixed(2)}%`;

    const rInB = document.getElementById("lvl-in-black-val");
    const rInM = document.getElementById("lvl-in-mid-val");
    const rInW = document.getElementById("lvl-in-white-val");
    if (rInB) rInB.textContent = String(Math.round(bp * 255));
    if (rInM) rInM.textContent = gamma.toFixed(2);
    if (rInW) rInW.textContent = String(Math.round(wp * 255));

    const ob = clamp(g.outBlack || 0, 0, 0.99);
    const ow = clamp(g.outWhite ?? 1, ob + 0.01, 1);
    const hLo = document.getElementById("lvl-out-black");
    const hHi = document.getElementById("lvl-out-white");
    const outFill = document.getElementById("lvl-out-active-range");
    if (hLo) hLo.style.left = `${(ob * 100).toFixed(2)}%`;
    if (hHi) hHi.style.left = `${(ow * 100).toFixed(2)}%`;
    if (outFill) {
      outFill.style.left = `${(ob * 100).toFixed(2)}%`;
      outFill.style.width = `${((ow - ob) * 100).toFixed(2)}%`;
    }
    const rOutB = document.getElementById("lvl-out-black-val");
    const rOutW = document.getElementById("lvl-out-white-val");
    if (rOutB) rOutB.textContent = String(Math.round(ob * 255));
    if (rOutW) rOutW.textContent = String(Math.round(ow * 255));
  }

  _buildHslMixer() {
    // 1. Lightroom Targeted Eyedropper + Channel Switch (色相/饱和度/明度)
    const eyeBtn = document.getElementById("btn-hsl-eyedropper");
    if (eyeBtn) {
      eyeBtn.innerHTML = `${SVG_EYEDROPPER}<span>${t("editor.color.hslEyedropper")}</span>`;
      eyeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onTogglePickMode?.("hsl");
      });
    }

    document.querySelectorAll("[data-hsl-chan]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.hslTargetChannel = btn.dataset.hslChan;
        document.querySelectorAll("[data-hsl-chan]").forEach((b) =>
          b.classList.toggle("active", b.dataset.hslChan === this.hslTargetChannel),
        );
      });
    });

    const visChk = document.getElementById("chk-hsl-vis-range");
    if (visChk) {
      visChk.addEventListener("change", () => {
        const before = cloneGrade(this.getGrade());
        const pc = this.getGrade().pointColor;
        if (pc) {
          pc.visualizeRange = visChk.checked;
          this.onChange();
          this._emitCommit(before, "hsl-range");
        }
      });
    }

    const clearPcBtn = document.getElementById("btn-hsl-pc-clear");
    if (clearPcBtn) {
      clearPcBtn.addEventListener("click", () => {
        const before = cloneGrade(this.getGrade());
        const pc = this.getGrade().pointColor;
        if (pc) {
          pc.enabled = false;
          pc.hue = 0;
          pc.sat = 0;
          pc.light = 0;
          pc.visualizeRange = false;
          this.syncUI();
          this.onChange();
          this._emitCommit(before, "hsl-clear");
        }
      });
    }

    // Point-Color range controls (容差 / 颜色范围 + 吸取色 色相/饱和度/明度)
    const pcRoot = document.getElementById("hsl-point-color-sliders");
    if (pcRoot) {
      pcRoot.innerHTML = "";
      const pcSpecs = [
        { key: "tolerance", get label() { return t("editor.color.sliders.tolerance"); }, uiMin: 5, uiMax: 100, uiStep: 1, uiDef: 34, toUi: (pc) => Math.round((pc.tolerance ?? 0.24) * 140), fromUi: (pc, v) => { pc.tolerance = clamp(v / 140, 0.04, 0.72); pc.enabled = true; }, fmt: (v) => String(Math.round(v)), parse: (s) => parseFloat(s) },
        { key: "colorRange", get label() { return t("editor.color.sliders.colorRange"); }, uiMin: 5, uiMax: 100, uiStep: 1, uiDef: 52, toUi: (pc) => Math.round((pc.colorRange ?? 0.52) * 100), fromUi: (pc, v) => { pc.colorRange = clamp(v / 100, 0.05, 1.0); pc.enabled = true; }, fmt: (v) => String(Math.round(v)), parse: (s) => parseFloat(s) },
        { key: "hue", get label() { return t("editor.color.sliders.pcHue"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (pc) => Math.round((pc.hue || 0) * 200), fromUi: (pc, v) => { pc.hue = v / 200; pc.enabled = true; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
        { key: "sat", get label() { return t("editor.color.sliders.pcSat"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (pc) => Math.round((pc.sat || 0) * 100), fromUi: (pc, v) => { pc.sat = v / 100; pc.enabled = true; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
        { key: "light", get label() { return t("editor.color.sliders.pcLight"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (pc) => Math.round((pc.light || 0) * 100), fromUi: (pc, v) => { pc.light = v / 100; pc.enabled = true; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
      ];
      for (const sp of pcSpecs) {
        const b = this._createCenterSliderRow(sp, (v) => sp.fromUi(this.getGrade().pointColor, v));
        this._pointColorBindings[sp.key] = b;
        pcRoot.appendChild(b.row);
      }
    }

    // 2. 8-Band HSL color dots + center-aligned sliders
    const bandsBar = document.getElementById("hsl-bands-bar");
    if (bandsBar) {
      bandsBar.innerHTML = "";
      HSL_BANDS.forEach((b, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "hsl-band-btn" + (idx === 0 ? " active" : "");
        btn.textContent = b.label;
        btn.style.borderBottom = `2px solid ${b.color}`;
        btn.onclick = () => {
          this.activeHslBand = idx;
          for (const el of bandsBar.children) el.classList.remove("active");
          btn.classList.add("active");
          this._syncHslUI();
        };
        bandsBar.appendChild(btn);
      });
    }

    const bandRoot = document.getElementById("hsl-band-sliders");
    if (bandRoot) {
      bandRoot.innerHTML = "";
      const bandSpecs = [
        { key: "h", get label() { return t("editor.color.sliders.hue"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (g) => Math.round((g.hslHue[this.activeHslBand] || 0) * 200), fromUi: (g, v) => { g.hslHue[this.activeHslBand] = v / 200; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
        { key: "s", get label() { return t("editor.color.sliders.saturation"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (g) => Math.round((g.hslSat[this.activeHslBand] || 0) * 100), fromUi: (g, v) => { g.hslSat[this.activeHslBand] = v / 100; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
        { key: "l", get label() { return t("editor.color.sliders.light"); }, uiMin: -100, uiMax: 100, uiStep: 1, uiDef: 0, toUi: (g) => Math.round((g.hslLight[this.activeHslBand] || 0) * 100), fromUi: (g, v) => { g.hslLight[this.activeHslBand] = v / 100; }, fmt: (v) => (v > 0 ? "+" : "") + Math.round(v), parse: (s) => parseFloat(s) },
      ];
      for (const sp of bandSpecs) {
        const b = this._createCenterSliderRow(sp, (v) => sp.fromUi(this.getGrade(), v));
        this._hslBandBindings[sp.key] = b;
        bandRoot.appendChild(b.row);
      }
    }
  }

  selectHslBandForHue(hue01) {
    const idx = findNearestHslBand(hue01);
    this.activeHslBand = idx;
    const bandsBar = document.getElementById("hsl-bands-bar");
    if (bandsBar) {
      [...bandsBar.children].forEach((el, i) => el.classList.toggle("active", i === idx));
    }
    this._syncHslUI();
    return HSL_BANDS[idx];
  }

  _syncHslUI() {
    const g = this.getGrade();
    for (const b of Object.values(this._hslBandBindings)) {
      b.updateVisual(b.spec.toUi(g));
    }
    const pc = g.pointColor;
    const pcWrap = document.getElementById("hsl-pc-box");
    const swatch = document.getElementById("hsl-pc-swatch");
    const visChk = document.getElementById("chk-hsl-vis-range");
    if (pc && swatch) {
      const r = Math.round(clamp(pc.targetRgb[0], 0, 1) * 255);
      const gr = Math.round(clamp(pc.targetRgb[1], 0, 1) * 255);
      const bl = Math.round(clamp(pc.targetRgb[2], 0, 1) * 255);
      swatch.style.background = `rgb(${r},${gr},${bl})`;
      swatch.classList.toggle("has-color", !!pc.enabled);
    }
    if (pc && pcWrap) {
      pcWrap.classList.toggle("active", !!pc.enabled);
    }
    if (pc && visChk) {
      visChk.checked = !!pc.visualizeRange;
    }
    if (pc) {
      for (const b of Object.values(this._pointColorBindings)) {
        b.updateVisual(b.spec.toUi(pc));
      }
    }
  }

  syncPickModeButtons() {
    const mode = this.getPickMode?.() || null;
    document.getElementById("btn-wb-eyedropper")?.classList.toggle("active", mode === "wb");
    document.getElementById("btn-hsl-eyedropper")?.classList.toggle("active", mode === "hsl");
  }

  syncUI() {
    const g = this.getGrade();
    for (const binding of this._sliderBindings.values()) {
      binding.updateVisual(binding.spec.toUi(g));
    }
    const wbSel = document.getElementById("color-wb-preset");
    if (wbSel) wbSel.value = g.wbPreset || "asis";

    const lutSel = document.getElementById("lut-select");
    const lutInt = document.getElementById("lut-intensity");
    const lutVal = document.getElementById("lut-intensity-v");
    if (lutSel) lutSel.value = g.lutName || "";
    if (lutInt) lutInt.value = String(g.lutIntensity ?? 1);
    if (lutVal) lutVal.textContent = `${Math.round((g.lutIntensity ?? 1) * 100)}%`;

    this._syncLevelsUI();
    this._syncHslUI();
    this._syncEyeButtons();
    this.syncPickModeButtons();
  }

  refreshLanguage() {
    const refreshRow = (b) => {
      if (!b) return;
      if (b.lbl) {
        b.lbl.textContent = b.spec.label;
        b.lbl.title = t("editor.color.dblClickReset");
      }
      if (b.valText) b.valText.title = t("editor.color.clickEditVal");
    };
    for (const b of this._sliderBindings.values()) refreshRow(b);
    for (const b of Object.values(this._pointColorBindings)) refreshRow(b);
    for (const b of Object.values(this._hslBandBindings)) refreshRow(b);

    const wbSel = document.getElementById("color-wb-preset");
    if (wbSel) {
      const cur = wbSel.value;
      wbSel.innerHTML = "";
      for (const p of WHITE_BALANCE_PRESETS) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.label;
        wbSel.appendChild(opt);
      }
      const customOpt = document.createElement("option");
      customOpt.value = "custom";
      customOpt.textContent = t("editor.color.wbCustom");
      wbSel.appendChild(customOpt);
      wbSel.value = cur || "asis";
    }

    const eyeBtn = document.getElementById("btn-hsl-eyedropper");
    if (eyeBtn) {
      eyeBtn.innerHTML = `${SVG_EYEDROPPER}<span>${t("editor.color.hslEyedropper")}</span>`;
    }

    const bandsBar = document.getElementById("hsl-bands-bar");
    if (bandsBar) {
      [...bandsBar.children].forEach((btn, idx) => {
        if (HSL_BANDS[idx]) btn.textContent = HSL_BANDS[idx].label;
      });
    }
    this.syncUI();
  }

  redrawHistogram() {
    const canvas = document.getElementById("histogram-canvas");
    const cloud = this.getCloud();
    if (!canvas || !cloud) return;
    drawHistogram(
      canvas,
      cloud,
      this.getGrade(),
      this.getActiveObjectIds(),
      this.getLutRgba(),
      this.hoveredZoneId,
    );
  }
}
