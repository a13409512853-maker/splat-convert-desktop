/**
 * @module ui/perf-hud
 * @description Configurable bottom-right live hardware & rendering performance HUD (M02).
 *
 * Design Contract:
 * - Default enabled fields: Live FPS + GPU % / VRAM + CPU % / RAM.
 * - All fields are user-toggleable inside Top Menu -> 高级选项 -> 性能监控显示设置 (3rd-level menu)
 *   and persisted in localStorage.
 * - Tracks real rendered frame rate via a rolling window; preserves last active FPS cleanly when
 *   the demand-driven RAF loop sleeps on idle frames (never flickers misleadingly to 0 FPS).
 */

import { t } from "../i18n.js";

const STORAGE_KEY = "splat_perf_hud_fields_v1";

export const PERF_HUD_FIELDS = Object.freeze([
  { id: "fps",         get label() { return t("editor.perfHud.fps.label"); },         defaultOn: true,  get desc() { return t("editor.perfHud.fps.desc"); } },
  { id: "frameMs",     get label() { return t("editor.perfHud.frameMs.label"); },     defaultOn: false, get desc() { return t("editor.perfHud.frameMs.desc"); } },
  { id: "gpuUsage",    get label() { return t("editor.perfHud.gpuUsage.label"); },    defaultOn: true,  get desc() { return t("editor.perfHud.gpuUsage.desc"); } },
  { id: "vram",        get label() { return t("editor.perfHud.vram.label"); },        defaultOn: true,  get desc() { return t("editor.perfHud.vram.desc"); } },
  { id: "gpuShared",   get label() { return t("editor.perfHud.gpuShared.label"); },   defaultOn: false, get desc() { return t("editor.perfHud.gpuShared.desc"); } },
  { id: "gpuTemp",     get label() { return t("editor.perfHud.gpuTemp.label"); },     defaultOn: false, get desc() { return t("editor.perfHud.gpuTemp.desc"); } },
  { id: "gpuPower",    get label() { return t("editor.perfHud.gpuPower.label"); },    defaultOn: false, get desc() { return t("editor.perfHud.gpuPower.desc"); } },
  { id: "gpuName",     get label() { return t("editor.perfHud.gpuName.label"); },     defaultOn: false, get desc() { return t("editor.perfHud.gpuName.desc"); } },
  { id: "cpuUsage",    get label() { return t("editor.perfHud.cpuUsage.label"); },    defaultOn: true,  get desc() { return t("editor.perfHud.cpuUsage.desc"); } },
  { id: "ram",         get label() { return t("editor.perfHud.ram.label"); },         defaultOn: true,  get desc() { return t("editor.perfHud.ram.desc"); } },
  { id: "appRam",      get label() { return t("editor.perfHud.appRam.label"); },      defaultOn: false, get desc() { return t("editor.perfHud.appRam.desc"); } },
  { id: "commit",      get label() { return t("editor.perfHud.commit.label"); },      defaultOn: false, get desc() { return t("editor.perfHud.commit.desc"); } },
  { id: "scenePoints", get label() { return t("editor.perfHud.scenePoints.label"); }, defaultOn: false, get desc() { return t("editor.perfHud.scenePoints.desc"); } },
]);

export class PerfHudController {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.el
   * @param {() => { activePoints: number, totalPoints: number, displayMode: string }} opts.getSceneInfo
   */
  constructor({ el, getSceneInfo }) {
    this.el = el;
    this.getSceneInfo = getSceneInfo;
    this.enabled = this._loadPrefs();

    this._rawFallbackText = "GPU --%  -- GB/ --GB  |  CPU --%  -- GB/ --GB";
    this._hw = null; // structured telemetryData from C# Health.cs

    // Rolling FPS window
    this._frameTimes = [];
    this._lastFrameTs = 0;
    this._fps = 60;
    this._frameMs = 0;
    this._lastPaintTs = 0;
  }

  _loadPrefs() {
    const defaults = {};
    for (const f of PERF_HUD_FIELDS) defaults[f.id] = f.defaultOn;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") {
        for (const f of PERF_HUD_FIELDS) {
          if (typeof saved[f.id] === "boolean") defaults[f.id] = saved[f.id];
        }
      }
    } catch { /* ignore */ }
    return defaults;
  }

  _savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.enabled));
    } catch { /* ignore */ }
  }

  setFieldEnabled(id, on) {
    if (!(id in this.enabled)) return;
    this.enabled[id] = !!on;
    this._savePrefs();
    this._syncCheckboxes();
    this.render(true);
  }

  _syncCheckboxes() {
    if (!this._menuContainer) return;
    this._menuContainer.querySelectorAll("input[data-perf-field]").forEach((el) => {
      el.checked = !!this.enabled[el.dataset.perfField];
    });
  }

  resetDefaults() {
    for (const f of PERF_HUD_FIELDS) this.enabled[f.id] = f.defaultOn;
    this._savePrefs();
    this._syncCheckboxes();
    this.render(true);
  }

  getEnabledFields() {
    return { ...this.enabled };
  }

  /**
   * Record a real rendered viewport frame to update live FPS & frame time.
   * @param {number} frameCostMs
   */
  recordFrame(frameCostMs) {
    const now = performance.now();
    this._frameMs = this._frameMs > 0 ? this._frameMs * 0.7 + frameCostMs * 0.3 : frameCostMs;
    if (this._lastFrameTs > 0) {
      const dt = now - this._lastFrameTs;
      // Only treat consecutive active frames (<450ms apart) as continuous cadence;
      // single wake-up frames after idle sleep estimate from render cost instead of 1/idleTime!
      if (dt > 1 && dt < 450) {
        this._frameTimes.push(now);
        const cutoff = now - 750;
        while (this._frameTimes.length > 0 && this._frameTimes[0] < cutoff) {
          this._frameTimes.shift();
        }
        if (this._frameTimes.length >= 2) {
          const span = this._frameTimes[this._frameTimes.length - 1] - this._frameTimes[0];
          if (span > 20) {
            const inst = ((this._frameTimes.length - 1) * 1000) / span;
            this._fps = Math.max(1, Math.min(240, this._fps * 0.55 + inst * 0.45));
          }
        }
      } else if (dt >= 450) {
        this._frameTimes.length = 0;
        this._frameTimes.push(now);
        const est = frameCostMs > 0.2 ? Math.min(60, 1000 / Math.max(16.6, frameCostMs)) : 60;
        this._fps = Math.max(1, Math.min(240, this._fps * 0.6 + est * 0.4));
      }
    }
    this._lastFrameTs = now;
    if (now - this._lastPaintTs >= 180) {
      this.render(false);
    }
  }

  updateHardware(data, fallbackText = null) {
    if (fallbackText) this._rawFallbackText = fallbackText;
    if (data && typeof data === "object") this._hw = data;
    this.render(true);
  }

  getFps() {
    return Math.round(this._fps);
  }

  formatText() {
    const e = this.enabled;
    const hw = this._hw;
    const parts = [];

    // 1. FPS / Frame Time
    const renderSegs = [];
    if (e.fps) renderSegs.push(`${Math.round(this._fps)} FPS`);
    if (e.frameMs) renderSegs.push(`${this._frameMs.toFixed(1)} ms`);
    if (renderSegs.length) parts.push(renderSegs.join(" · "));

    // 2. GPU block
    const gpuSegs = [];
    if (e.gpuName && hw?.gpuName) {
      const shortName = hw.gpuName.replace(/NVIDIA GeForce /i, "").replace(/AMD Radeon /i, "").trim();
      gpuSegs.push(shortName);
    }
    if (e.gpuUsage) {
      const pct = hw && typeof hw.gpuPct === "number" ? `${Math.round(hw.gpuPct)}%` : "--%";
      gpuSegs.push(`GPU ${pct}`);
    }
    if (e.vram) {
      const used = hw && typeof hw.vramUsedGb === "number" ? hw.vramUsedGb.toFixed(1) : "--";
      const tot = hw && typeof hw.vramTotalGb === "number" ? hw.vramTotalGb.toFixed(1) : "--";
      gpuSegs.push(e.gpuUsage ? `${used}/${tot} GB` : `VRAM ${used}/${tot} GB`);
    }
    if (e.gpuShared && hw && typeof hw.gpuSharedGb === "number") {
      gpuSegs.push(t("editor.perfHud.sharedVram", { gb: hw.gpuSharedGb.toFixed(1) }));
    }
    if (e.gpuTemp) {
      gpuSegs.push(hw && typeof hw.gpuTempC === "number" ? `${Math.round(hw.gpuTempC)}°C` : "--°C");
    }
    if (e.gpuPower) {
      gpuSegs.push(hw && typeof hw.gpuPowerW === "number" ? `${Math.round(hw.gpuPowerW)}W` : "--W");
    }
    if (gpuSegs.length) parts.push(gpuSegs.join(" "));

    // 3. CPU / Memory block
    const cpuSegs = [];
    if (e.cpuUsage) {
      const pct = hw && typeof hw.cpuPct === "number" ? `${Math.round(hw.cpuPct)}%` : "--%";
      cpuSegs.push(`CPU ${pct}`);
    }
    if (e.ram) {
      const used = hw && typeof hw.ramUsedGb === "number" ? hw.ramUsedGb.toFixed(1) : "--";
      const tot = hw && typeof hw.ramTotalGb === "number" ? hw.ramTotalGb.toFixed(1) : "--";
      cpuSegs.push(e.cpuUsage ? `${used}/${tot} GB` : `RAM ${used}/${tot} GB`);
    }
    if (e.appRam) {
      const mb = hw && typeof hw.appRamMb === "number" ? `${Math.round(hw.appRamMb)} MB` : "-- MB";
      cpuSegs.push(t("editor.perfHud.appRamFmt", { mb }));
    }
    if (e.commit) {
      const cm = hw && typeof hw.commitAvailGb === "number" ? `${hw.commitAvailGb.toFixed(1)} GB` : "-- GB";
      cpuSegs.push(t("editor.perfHud.commitFmt", { gb: cm }));
    }
    if (cpuSegs.length) parts.push(cpuSegs.join(" "));

    // 4. Scene points / mode
    if (e.scenePoints && typeof this.getSceneInfo === "function") {
      const info = this.getSceneInfo();
      const modeMap = {
        splat: t("editor.displayModes.splatShort"),
        centers: t("editor.displayModes.centersShort"),
        rings: t("editor.displayModes.ringsShort"),
      };
      const pts = info.activePoints >= 1e6
        ? `${(info.activePoints / 1e6).toFixed(2)}M`
        : info.activePoints >= 1e3
          ? `${(info.activePoints / 1e3).toFixed(1)}K`
          : String(info.activePoints || 0);
      parts.push(t("editor.perfHud.pointsFmt", { mode: modeMap[info.displayMode] || info.displayMode, pts }));
    }

    if (parts.length === 0) return "";
    return parts.join("   |   ");
  }

  render(force = false) {
    if (!this.el) return;
    const now = performance.now();
    if (!force && now - this._lastPaintTs < 180) return;
    this._lastPaintTs = now;
    const txt = this.formatText();
    this.el.classList.toggle("hidden", !txt);
    if (txt) this.el.textContent = txt;
  }

  /**
   * Populate the 3rd-level menu checkboxes inside 高级选项 -> 性能监控显示设置.
   * @param {HTMLElement} container
   * @param {(el: HTMLElement, tip: object) => void} [bindTipFn]
   */
  mountSettingsMenu(container, bindTipFn = null) {
    if (!container) return;
    this._menuContainer = container;
    this._bindTipFn = bindTipFn;
    container.innerHTML = "";
    for (const f of PERF_HUD_FIELDS) {
      const lbl = document.createElement("label");
      lbl.className = "menu-check-item compact";
      lbl.innerHTML = `<input type="checkbox" data-perf-field="${f.id}" ${this.enabled[f.id] ? "checked" : ""} /><span class="menu-check-text"><strong>${f.label}</strong></span>`;
      const cb = lbl.querySelector("input");
      cb.addEventListener("change", () => this.setFieldEnabled(f.id, cb.checked));
      if (bindTipFn) bindTipFn(lbl, { title: f.label, tip: f.desc, region: "toolbar" });
      container.appendChild(lbl);
    }
    const sep = document.createElement("div");
    sep.className = "menu-sep";
    const rst = document.createElement("button");
    rst.type = "button";
    rst.className = "submenu-action-btn";
    rst.textContent = t("editor.perfHud.resetDefaults");
    rst.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.resetDefaults();
      container.querySelectorAll("input[data-perf-field]").forEach((el) => {
        el.checked = !!this.enabled[el.dataset.perfField];
      });
    });
    container.append(sep, rst);
  }

  refreshLanguage() {
    if (this._menuContainer) {
      this.mountSettingsMenu(this._menuContainer, this._bindTipFn);
    }
    this.render(true);
  }
}
