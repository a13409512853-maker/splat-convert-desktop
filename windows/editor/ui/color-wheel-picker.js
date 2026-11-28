/**
 * @module ui/color-wheel-picker
 * @description Reusable Hue-Ring + Inscribed SV-Square Color Picker Panel (3.2.3-rc12):
 * - Crisp high-DPI 360-degree Hue Wheel + inscribed Saturation/Value square (matching desktop pro creative apps)
 * - Built-in Eyedropper hook (samples live colors directly from the 3D viewport / Gaussian cloud)
 * - Scrubbable R / G / B numeric inputs + Hex input + live preview swatch
 * - Persistent Recent Colors strip (localStorage MRU, up to 10 swatches)
 * - Anchors upward cleanly above bottom toolbars (or auto-flips if near top edge)
 * - Designed as a self-contained reusable component for Plane Inpaint L0 and any future color-picking workflows.
 */
import { t } from "../i18n.js";

const RECENT_STORAGE_KEY = "splat_editor_recent_colors_v1";
const MAX_RECENT_COLORS = 10;
const DEFAULT_RECENT_COLORS = [
  "#e2e8f0",
  "#94a3b8",
  "#475569",
  "#1e293b",
  "#f59e0b",
  "#ef4444",
  "#22c55e",
  "#38bdf8",
];

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function rgb255ToHsv(r, g, b) {
  const rn = clamp01(r / 255);
  const gn = clamp01(g / 255);
  const bn = clamp01(b / 255);
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  const s = max <= 1e-6 ? 0 : d / max;
  return [h, s, max];
}

export function hsvToRgb255(h, s, v) {
  const hh = ((h % 1) + 1) % 1;
  const ss = clamp01(s);
  const vv = clamp01(v);
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = vv * (1 - ss);
  const q = vv * (1 - f * ss);
  const tt = vv * (1 - (1 - f) * ss);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = vv; g = tt; b = p; break;
    case 1: r = q; g = vv; b = p; break;
    case 2: r = p; g = vv; b = tt; break;
    case 3: r = p; g = q; b = vv; break;
    case 4: r = tt; g = p; b = vv; break;
    case 5: r = vv; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function rgb255ToHex(r, g, b) {
  const to2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase();
}

export function hexToRgb255(hex) {
  if (typeof hex !== "string") return null;
  let s = hex.trim().replace(/^#/, "");
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function loadRecentColors() {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.filter((x) => typeof x === "string" && hexToRgb255(x)).slice(0, MAX_RECENT_COLORS);
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_RECENT_COLORS.slice();
}

function saveRecentColors(list) {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENT_COLORS)));
  } catch {
    /* ignore */
  }
}

export class ColorWheelPicker {
  constructor() {
    this.el = null;
    this.canvas = null;
    this.ctx = null;
    this.wheelCanvas = null; // cached static hue ring offscreen buffer
    this.size = 196;
    this.outerR = 92;
    this.innerR = 74;
    // Inscribed square inside inner circle (half-side = innerR / sqrt(2) with slight margin)
    this.sqHalf = Math.floor((this.innerR - 4) * Math.SQRT1_2);

    this.hsv = [0.56, 0.72, 0.88];
    this.recent = loadRecentColors();
    this.isOpen = false;
    this.eyedropperActive = false;
    this._anchorEl = null;
    this._onChange = null;
    this._onCommit = null;
    this._onRequestEyedropper = null;
    this._dragMode = null; // "hue" | "sv"

    this._buildDom();
    this._bindGlobalDismiss();
  }

  _buildDom() {
    const root = document.createElement("div");
    root.className = "color-wheel-popover hidden";
    root.id = "reusable-color-wheel-picker";
    root.addEventListener("pointerdown", (e) => e.stopPropagation());

    // Header: title + live preview swatch + Eyedropper button
    const head = document.createElement("div");
    head.className = "cw-head";

    const titleEl = document.createElement("span");
    titleEl.className = "cw-title";
    titleEl.textContent = t("editor.colorWheel.title");
    this._titleEl = titleEl;

    const headRight = document.createElement("div");
    headRight.className = "cw-head-right";

    const preview = document.createElement("span");
    preview.className = "cw-preview-swatch";
    this._previewEl = preview;

    const eyeBtn = document.createElement("button");
    eyeBtn.type = "button";
    eyeBtn.className = "cw-eye-btn";
    eyeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg><span class="cw-eye-lbl"></span>`;
    eyeBtn.querySelector(".cw-eye-lbl").textContent = t("editor.colorWheel.eyedropper");
    eyeBtn.onclick = (e) => {
      e.stopPropagation();
      if (typeof this._onRequestEyedropper === "function") {
        this._onRequestEyedropper(!this.eyedropperActive);
      }
    };
    this._eyeBtn = eyeBtn;

    headRight.append(preview, eyeBtn);
    head.append(titleEl, headRight);

    // Canvas: Hue Ring + Inscribed SV Square
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "cw-canvas-wrap";
    const canvas = document.createElement("canvas");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(this.size * dpr);
    canvas.height = Math.round(this.size * dpr);
    canvas.style.width = `${this.size}px`;
    canvas.style.height = `${this.size}px`;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.scale(dpr, dpr);
    this._buildStaticRingCache();

    canvas.addEventListener("pointerdown", (e) => this._onCanvasPointerDown(e));
    window.addEventListener("pointermove", (e) => this._onWindowPointerMove(e));
    window.addEventListener("pointerup", () => this._onWindowPointerUp());
    canvasWrap.appendChild(canvas);

    // Hex + RGB Scrubbable Inputs
    const inputsRow = document.createElement("div");
    inputsRow.className = "cw-inputs-row";

    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.className = "cw-hex-input";
    hexInput.maxLength = 7;
    hexInput.spellcheck = false;
    hexInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const rgb = hexToRgb255(hexInput.value);
        if (rgb) this.setRgb255(rgb, { emitChange: true, emitCommit: true, recordRecent: true });
      }
    });
    hexInput.addEventListener("change", () => {
      const rgb = hexToRgb255(hexInput.value);
      if (rgb) this.setRgb255(rgb, { emitChange: true, emitCommit: true, recordRecent: true });
      else this._syncInputs();
    });
    this._hexInput = hexInput;
    inputsRow.appendChild(hexInput);

    this._rgbInputs = [];
    for (const [idx, ch] of [[0, "R"], [1, "G"], [2, "B"]]) {
      const lbl = document.createElement("label");
      lbl.className = "cw-rgb-field";
      lbl.innerHTML = `<span>${ch}</span><input type="number" min="0" max="255" step="1" value="0" />`;
      const inp = lbl.querySelector("input");
      inp.addEventListener("keydown", (e) => e.stopPropagation());
      inp.addEventListener("input", () => {
        const cur = this.getRgb255();
        cur[idx] = Math.max(0, Math.min(255, Math.round(Number(inp.value) || 0)));
        this.setRgb255(cur, { emitChange: true, emitCommit: false, recordRecent: false, skipRgbSync: true });
      });
      inp.addEventListener("change", () => {
        const cur = this.getRgb255();
        cur[idx] = Math.max(0, Math.min(255, Math.round(Number(inp.value) || 0)));
        this.setRgb255(cur, { emitChange: true, emitCommit: true, recordRecent: true });
      });
      this._rgbInputs.push(inp);
      inputsRow.appendChild(lbl);
    }

    // Recent Colors Section
    const recentWrap = document.createElement("div");
    recentWrap.className = "cw-recent-wrap";
    const recentLbl = document.createElement("div");
    recentLbl.className = "cw-recent-lbl";
    recentLbl.textContent = t("editor.colorWheel.recent");
    this._recentLbl = recentLbl;

    const recentGrid = document.createElement("div");
    recentGrid.className = "cw-recent-grid";
    this._recentGrid = recentGrid;

    recentWrap.append(recentLbl, recentGrid);

    root.append(head, canvasWrap, inputsRow, recentWrap);
    document.body.appendChild(root);
    this.el = root;
    this._renderRecent();
    this._redraw();
    this._syncInputs();
  }

  _buildStaticRingCache() {
    const c = document.createElement("canvas");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(this.size * dpr);
    c.height = Math.round(this.size * dpr);
    const ctx = c.getContext("2d");
    const cx = c.width * 0.5;
    const cy = c.height * 0.5;
    const oR = this.outerR * dpr;
    const iR = this.innerR * dpr;

    const img = ctx.createImageData(c.width, c.height);
    const d = img.data;
    for (let y = 0; y < c.height; y++) {
      const dy = y + 0.5 - cy;
      for (let x = 0; x < c.width; x++) {
        const dx = x + 0.5 - cx;
        const r = Math.hypot(dx, dy);
        if (r < iR - 1.2 || r > oR + 1.2) continue;
        // Smooth 1.2px anti-aliased edge coverage
        const covIn = clamp01((r - (iR - 1.0)) / 1.4);
        const covOut = clamp01(((oR + 1.0) - r) / 1.4);
        const cov = covIn * covOut;
        if (cov <= 0) continue;
        // 0 deg at top-right/red -> standard clockwise hue ring matching desktop color wheels
        const ang = Math.atan2(dy, dx);
        const hue = ((ang / (Math.PI * 2)) + 1.25) % 1;
        const [rr, gg, bb] = hsvToRgb255(hue, 1, 1);
        const off = (y * c.width + x) * 4;
        d[off] = rr;
        d[off + 1] = gg;
        d[off + 2] = bb;
        d[off + 3] = Math.round(cov * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    this.wheelCanvas = c;
  }

  _bindGlobalDismiss() {
    document.addEventListener("pointerdown", (e) => {
      if (!this.isOpen) return;
      if (this.eyedropperActive) return; // keep open while user samples from 3D viewport!
      if (this.el.contains(e.target)) return;
      if (this._anchorEl && this._anchorEl.contains(e.target)) return;
      this.close();
    });
  }

  refreshLanguage() {
    if (this._titleEl) this._titleEl.textContent = t("editor.colorWheel.title");
    if (this._eyeBtn) {
      const lbl = this._eyeBtn.querySelector(".cw-eye-lbl");
      if (lbl) lbl.textContent = t("editor.colorWheel.eyedropper");
    }
    if (this._recentLbl) this._recentLbl.textContent = t("editor.colorWheel.recent");
  }

  setEyedropperActive(active) {
    this.eyedropperActive = !!active;
    this._eyeBtn?.classList.toggle("active", this.eyedropperActive);
  }

  getRgb255() {
    return hsvToRgb255(this.hsv[0], this.hsv[1], this.hsv[2]);
  }

  getHex() {
    const [r, g, b] = this.getRgb255();
    return rgb255ToHex(r, g, b);
  }

  recordRecent(hexOrRgb) {
    const hex = Array.isArray(hexOrRgb)
      ? rgb255ToHex(hexOrRgb[0], hexOrRgb[1], hexOrRgb[2])
      : String(hexOrRgb || "").toUpperCase();
    if (!hexToRgb255(hex)) return;
    this.recent = [hex, ...this.recent.filter((c) => c.toUpperCase() !== hex)].slice(0, MAX_RECENT_COLORS);
    saveRecentColors(this.recent);
    this._renderRecent();
  }

  setRgb255(rgb, { emitChange = false, emitCommit = false, recordRecent = false, skipRgbSync = false } = {}) {
    if (!Array.isArray(rgb) || rgb.length < 3) return;
    const prevHue = this.hsv[0];
    const nextHsv = rgb255ToHsv(rgb[0], rgb[1], rgb[2]);
    // Preserve previous hue when color is achromatic (white/gray/black) so hue handle doesn't jump to 0
    if (nextHsv[1] < 1e-4) nextHsv[0] = prevHue;
    this.hsv = nextHsv;
    this._redraw();
    this._syncInputs(skipRgbSync);
    const outRgb = this.getRgb255();
    const outHex = rgb255ToHex(outRgb[0], outRgb[1], outRgb[2]);
    if (recordRecent) this.recordRecent(outHex);
    if (emitChange && typeof this._onChange === "function") this._onChange(outRgb, outHex);
    if (emitCommit && typeof this._onCommit === "function") this._onCommit(outRgb, outHex);
  }

  open({ anchorEl, rgb255, placement = "top", onChange = null, onCommit = null, onRequestEyedropper = null } = {}) {
    this._anchorEl = anchorEl || null;
    this._onChange = onChange;
    this._onCommit = onCommit;
    this._onRequestEyedropper = onRequestEyedropper;
    this.refreshLanguage();
    if (Array.isArray(rgb255) && rgb255.length >= 3) {
      this.setRgb255(rgb255, { emitChange: false, emitCommit: false, recordRecent: false });
    }
    this.isOpen = true;
    this.el.classList.remove("hidden");
    this.reposition(placement);
  }

  reposition(placement = "top") {
    if (!this.isOpen || !this.el) return;
    const pw = this.el.offsetWidth || 236;
    const ph = this.el.offsetHeight || 326;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 720;

    let x = (vw - pw) * 0.5;
    let y = vh - ph - 120;
    if (this._anchorEl && this._anchorEl.isConnected) {
      const r = this._anchorEl.getBoundingClientRect();
      const bar = this._anchorEl.closest(".context-bar");
      const barRect = bar ? bar.getBoundingClientRect() : r;
      x = r.left + r.width * 0.5 - pw * 0.5;
      if (placement === "top") {
        y = barRect.top - ph - 10;
        if (y < 10) y = barRect.bottom + 10;
      } else {
        y = barRect.bottom + 10;
        if (y + ph > vh - 10) y = barRect.top - ph - 10;
      }
    }
    x = Math.max(10, Math.min(vw - pw - 10, x));
    y = Math.max(10, Math.min(vh - ph - 10, y));
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this._dragMode = null;
    if (this.eyedropperActive && typeof this._onRequestEyedropper === "function") {
      this._onRequestEyedropper(false);
    }
    this.setEyedropperActive(false);
    this.el.classList.add("hidden");
  }

  _updateFromClientPos(clientX, clientY, mode) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / Math.max(1, r.width)) * this.size;
    const y = ((clientY - r.top) / Math.max(1, r.height)) * this.size;
    const cx = this.size * 0.5;
    const cy = this.size * 0.5;

    if (mode === "hue") {
      const ang = Math.atan2(y - cy, x - cx);
      this.hsv[0] = ((ang / (Math.PI * 2)) + 1.25) % 1;
    } else if (mode === "sv") {
      const x0 = cx - this.sqHalf;
      const y0 = cy - this.sqHalf;
      const side = this.sqHalf * 2;
      this.hsv[1] = clamp01((x - x0) / side);
      this.hsv[2] = clamp01(1 - (y - y0) / side);
    }
    this._redraw();
    this._syncInputs();
    const rgb = this.getRgb255();
    const hex = rgb255ToHex(rgb[0], rgb[1], rgb[2]);
    if (typeof this._onChange === "function") this._onChange(rgb, hex);
  }

  _onCanvasPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * this.size;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * this.size;
    const cx = this.size * 0.5;
    const cy = this.size * 0.5;
    const dist = Math.hypot(x - cx, y - cy);

    if (dist >= this.innerR - 3 && dist <= this.outerR + 6) {
      this._dragMode = "hue";
    } else if (Math.abs(x - cx) <= this.sqHalf + 6 && Math.abs(y - cy) <= this.sqHalf + 6) {
      this._dragMode = "sv";
    } else {
      return;
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    this._updateFromClientPos(e.clientX, e.clientY, this._dragMode);
  }

  _onWindowPointerMove(e) {
    if (!this._dragMode) return;
    e.preventDefault();
    this._updateFromClientPos(e.clientX, e.clientY, this._dragMode);
  }

  _onWindowPointerUp() {
    if (!this._dragMode) return;
    this._dragMode = null;
    const rgb = this.getRgb255();
    const hex = rgb255ToHex(rgb[0], rgb[1], rgb[2]);
    this.recordRecent(hex);
    if (typeof this._onCommit === "function") this._onCommit(rgb, hex);
  }

  _redraw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const S = this.size;
    const cx = S * 0.5;
    const cy = S * 0.5;

    ctx.clearRect(0, 0, S, S);
    // 1. Static Hue Ring
    if (this.wheelCanvas) {
      ctx.drawImage(this.wheelCanvas, 0, 0, S, S);
    }

    // 2. Inscribed SV Square for current Hue
    const x0 = cx - this.sqHalf;
    const y0 = cy - this.sqHalf;
    const side = this.sqHalf * 2;
    const [hr, hg, hb] = hsvToRgb255(this.hsv[0], 1, 1);

    ctx.save();
    ctx.fillStyle = `rgb(${hr},${hg},${hb})`;
    ctx.fillRect(x0, y0, side, side);

    const whiteGrad = ctx.createLinearGradient(x0, y0, x0 + side, y0);
    whiteGrad.addColorStop(0, "rgba(255,255,255,1)");
    whiteGrad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = whiteGrad;
    ctx.fillRect(x0, y0, side, side);

    const blackGrad = ctx.createLinearGradient(x0, y0, x0, y0 + side);
    blackGrad.addColorStop(0, "rgba(0,0,0,0)");
    blackGrad.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = blackGrad;
    ctx.fillRect(x0, y0, side, side);

    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, side - 1, side - 1);
    ctx.restore();

    // 3. Hue Ring Handle
    const hAng = (this.hsv[0] - 0.25) * Math.PI * 2;
    const midR = (this.innerR + this.outerR) * 0.5;
    const hx = cx + Math.cos(hAng) * midR;
    const hy = cy + Math.sin(hAng) * midR;
    this._drawHandle(ctx, hx, hy, 6.2);

    // 4. SV Square Handle
    const sx = x0 + clamp01(this.hsv[1]) * side;
    const sy = y0 + (1 - clamp01(this.hsv[2])) * side;
    this._drawHandle(ctx, sx, sy, 6.2);
  }

  _drawHandle(ctx, x, y, radius) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.72)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }

  _syncInputs(skipRgb = false) {
    const rgb = this.getRgb255();
    const hex = rgb255ToHex(rgb[0], rgb[1], rgb[2]);
    if (this._previewEl) this._previewEl.style.background = hex;
    if (this._hexInput && document.activeElement !== this._hexInput) {
      this._hexInput.value = hex;
    }
    if (!skipRgb && this._rgbInputs) {
      for (let i = 0; i < 3; i++) {
        if (document.activeElement !== this._rgbInputs[i]) {
          this._rgbInputs[i].value = String(rgb[i]);
        }
      }
    }
  }

  _renderRecent() {
    if (!this._recentGrid) return;
    this._recentGrid.innerHTML = "";
    for (const hex of this.recent) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cw-recent-swatch";
      btn.style.background = hex;
      btn.title = hex;
      btn.dataset.colorHex = hex;
      btn.onclick = (e) => {
        e.stopPropagation();
        const rgb = hexToRgb255(hex);
        if (rgb) this.setRgb255(rgb, { emitChange: true, emitCommit: true, recordRecent: true });
      };
      this._recentGrid.appendChild(btn);
    }
  }
}
