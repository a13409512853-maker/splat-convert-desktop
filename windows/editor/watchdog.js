// Hang / WebGL Context-Lost Auto-Downgrade & Zero-Loss Recovery Watchdog (Section IV.2 & X).
// Intelligently pauses during intentional native dialogs or cloud loading to avoid false positives.
import { t } from "./i18n.js";

export class HangWatchdog {
  constructor({ canvas, onDowngradeRecover, getTelemetrySnapshot }) {
    this.canvas = canvas;
    this.onDowngradeRecover = onDowngradeRecover;
    this.getTelemetrySnapshot = getTelemetrySnapshot;
    this._lastBeat = performance.now();
    this._timer = null;
    this._triggered = false;
    this._paused = false;
    this.hangThresholdMs = 5000;

    if (canvas) {
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.triggerDowngrade(t("editor.watchdog.contextLost"));
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this._lastBeat = performance.now();
    });
  }

  setPaused(paused) {
    this._paused = !!paused;
    this._lastBeat = performance.now();
  }

  reset() {
    this._triggered = false;
    this._lastBeat = performance.now();
  }

  start() {
    this.stop();
    this._lastBeat = performance.now();
    this._triggered = false;
    const step = () => {
      const now = performance.now();
      const gap = now - this._lastBeat;
      this._lastBeat = now;
      if (!this._paused && !document.hidden && gap > this.hangThresholdMs && !this._triggered) {
        this.triggerDowngrade(t("editor.watchdog.mainThreadHang", { sec: (gap / 1000).toFixed(1) }));
      }
      this._timer = window.setTimeout(step, 1000);
    };
    this._timer = window.setTimeout(step, 1000);
  }

  stop() {
    if (this._timer) {
      window.clearTimeout(this._timer);
      this._timer = null;
    }
  }

  triggerDowngrade(reason) {
    if (this._triggered) return;
    this._triggered = true;
    const telemetry =
      typeof this.getTelemetrySnapshot === "function"
        ? this.getTelemetrySnapshot()
        : t("editor.watchdog.noTelemetry");
    if (typeof this.onDowngradeRecover === "function") {
      this.onDowngradeRecover({ reason, telemetry });
    }
  }
}
