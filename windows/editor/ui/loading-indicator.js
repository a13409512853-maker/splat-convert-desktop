/**
 * @module ui/loading-indicator
 * @description Animated non-freezing loading overlay controller with live motion feedback
 * and automatic >10s Estimated Time Remaining (ETA) calculation.
 *
 * Design Contract:
 * - Always renders continuous subtle visual motion (progress bar shimmer + pulsing status dot,
 *   no spinner ring) while visible so users immediately know decoding/uploading is active.
 * - After 10 seconds elapsed without completion, reveals a calm secondary ETA line
 *   computed from smoothed progress rate (or elapsed time fallback).
 * - Exposes a clean, decoupled interface for future TypeScript/Tauri migration.
 */

/**
 * @typedef {Object} LoadingIndicatorOptions
 * @property {HTMLElement} overlayEl   - Root modal overlay element (#loading-overlay)
 * @property {HTMLElement} titleEl     - Primary title text (#loading-title)
 * @property {HTMLElement} stageEl     - Current pipeline stage text (#loading-stage)
 * @property {HTMLElement} pctEl       - Numeric percentage readout (#loading-pct)
 * @property {HTMLElement} barFillEl   - Animated fill bar (#loading-bar-fill)
 * @property {HTMLElement} etaEl       - Secondary >10s ETA readout (#loading-eta)
 * @property {number} [etaThresholdMs=10000] - Elapsed threshold before showing ETA
 */

import { t } from "../i18n.js";

export class LoadingIndicatorController {
  /** @param {LoadingIndicatorOptions} opts */
  constructor(opts) {
    this._overlay = opts.overlayEl;
    this._title = opts.titleEl;
    this._stage = opts.stageEl;
    this._pct = opts.pctEl;
    this._barFill = opts.barFillEl;
    this._eta = opts.etaEl;
    this._etaThresholdMs = opts.etaThresholdMs ?? 10000;

    this._visible = false;
    this._startMs = 0;
    this._progress = 0;
    this._lastAdvMs = 0;
    this._lastAdvPct = 0;
    this._smoothedRate = 0; // pct per second
    this._timer = null;
  }

  /**
   * Show or hide the loading overlay and update progress state.
   * @param {boolean} visible
   * @param {string} [stageText]
   * @param {number|null} [percent]
   * @param {string} [titleText]
   */
  update(visible, stageText = "", percent = null, titleText = "") {
    if (!this._overlay) return;
    const now = performance.now();

    if (visible && !this._visible) {
      this._visible = true;
      this._startMs = now;
      this._lastAdvMs = now;
      this._lastAdvPct = 0;
      this._smoothedRate = 0;
      this._progress = 0;
      this._overlay.classList.remove("hidden", "is-error");
      if (this._title) this._title.textContent = titleText || t("editor.loading.title");
      if (this._eta) {
        this._eta.textContent = "";
        this._eta.classList.add("hidden");
      }
      this._startTicker();
    } else if (!visible && this._visible) {
      this._visible = false;
      this._overlay.classList.add("hidden");
      this._overlay.classList.remove("is-error");
      this._stopTicker();
      return;
    }

    if (!visible) return;
    if (titleText && this._title) this._title.textContent = titleText;
    if (stageText && this._stage) this._stage.textContent = stageText;

    if (typeof percent === "number" && Number.isFinite(percent)) {
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      if (p > this._progress) {
        const dtSec = Math.max(0.15, (now - this._lastAdvMs) / 1000);
        const instantRate = (p - this._lastAdvPct) / dtSec;
        this._smoothedRate =
          this._smoothedRate > 0
            ? this._smoothedRate * 0.65 + instantRate * 0.35
            : instantRate;
        this._lastAdvMs = now;
        this._lastAdvPct = p;
      }
      this._progress = p;
      if (this._barFill) this._barFill.style.width = `${p}%`;
      if (this._pct) this._pct.textContent = `${p}%`;
    }

    this._renderEta(now);
  }

  /**
   * Display a clear visible error state instead of freezing on a stale percentage.
   * @param {string} message
   */
  showError(message) {
    if (!this._overlay) return;
    this._stopTicker();
    this._visible = true;
    this._overlay.classList.remove("hidden");
    this._overlay.classList.add("is-error");
    if (this._title) this._title.textContent = t("editor.loading.interrupted");
    if (this._stage) this._stage.textContent = message || t("editor.loading.readError");
    if (this._eta) {
      this._eta.textContent = t("editor.loading.errorHint");
      this._eta.classList.remove("hidden");
    }
  }

  _startTicker() {
    this._stopTicker();
    this._timer = window.setInterval(() => {
      if (!this._visible) return;
      this._renderEta(performance.now());
    }, 500);
  }

  _stopTicker() {
    if (this._timer) {
      window.clearInterval(this._timer);
      this._timer = null;
    }
  }

  _renderEta(now) {
    if (!this._eta || !this._visible) return;
    const elapsedMs = now - this._startMs;
    if (elapsedMs < this._etaThresholdMs) {
      this._eta.classList.add("hidden");
      return;
    }
    this._eta.classList.remove("hidden");
    const elapsedSec = Math.round(elapsedMs / 1000);
    const remainPct = Math.max(0, 100 - this._progress);

    // Estimate remaining seconds from either overall average speed or recent smoothed rate
    const avgRate = this._progress > 4 ? this._progress / Math.max(1, elapsedMs / 1000) : 0;
    const effectiveRate =
      this._smoothedRate > 0.05 && avgRate > 0.05
        ? avgRate * 0.6 + this._smoothedRate * 0.4
        : avgRate || this._smoothedRate;

    if (effectiveRate > 0.05 && remainPct > 0) {
      const estSec = Math.max(1, Math.min(600, Math.round(remainPct / effectiveRate)));
      const etaFmt = estSec >= 60
        ? t("editor.loading.etaMinSec", { min: Math.floor(estSec / 60), sec: estSec % 60 })
        : t("editor.loading.etaSec", { sec: estSec });
      this._eta.textContent = t("editor.loading.etaRemaining", { elapsed: elapsedSec, eta: etaFmt });
    } else {
      this._eta.textContent = t("editor.loading.etaProcessing", { elapsed: elapsedSec });
    }
  }

  dispose() {
    this._stopTicker();
  }
}
