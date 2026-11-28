/**
 * @module measure/measure-manager
 * @description Complete 3DGS Smart Measurement Suite Orchestrator (rc9):
 * - Non-destructive global scale calibration (m / cm / mm) with recipe persistence & Undo/Redo
 * - Unified Smart Measuring Pen (2-pt distance/ΔH/slope -> >=3-pt polyline -> closed Area / Heap Volume)
 * - Anti-floater solid-surface GPU picking & normal-aligned 3D circular ring cursor
 * - One-click Smart Edge Snapping (single Undo step via global HistoryManager)
 * - Manual interactive 3D overrides: soft-selection vertex drag, base plane vertical drag + presets
 *   (fit / lowest / horizontal / 3-point), peak height pole drag + anti-floater toggle
 * - 4 non-destructive GPU Heap Temporary Views (Standard / Translucent / Height Heatmap / Mesh Compare)
 *   with automatic restore to Standard on exit / Esc
 * - Freely draggable floating result card with unit switch, 1-click copy, and multi-result Pinning
 */
import * as T from "three";
import { SolidSurfacePicker, SurfaceRingCursor } from "./surface-picker.js";
import {
  UNIT_CONFIG,
  formatLength,
  formatArea,
  formatVolume,
  computeTwoPointMetrics,
  computePolylineMetrics,
  computePolygonAreaAndVolume,
  smartSnapPolygonToEdges,
  applySoftVertexDrag,
} from "./geometry-engine.js";
import { MeasureCardUI } from "./measure-card-ui.js";
import { t } from "../i18n.js";

// Tunable GPU visualization parameters (adjustable per user feedback!)
export const DEFAULT_TRANSLUCENT_ALPHA = 0.30;
export const DEFAULT_GRID_GHOST_ALPHA = 0.06;

const START_CLOSE_PX = 14;
const SVG_NS = "http://www.w3.org/2000/svg";

const VIZ_MODES = [
  { id: 0, get label() { return t("editor.measure.vizStandard.label"); }, get tip() { return t("editor.measure.vizStandard.tip"); } },
  { id: 1, get label() { return t("editor.measure.vizTranslucent.label"); }, get tip() { return t("editor.measure.vizTranslucent.tip"); } },
  { id: 2, get label() { return t("editor.measure.vizHeatmap.label"); }, get tip() { return t("editor.measure.vizHeatmap.tip"); } },
  { id: 3, get label() { return t("editor.measure.vizGrid.label"); }, get tip() { return t("editor.measure.vizGrid.tip"); } },
];

const BASE_MODES = [
  { id: "fit", get label() { return t("editor.measure.baseFit"); } },
  { id: "lowest", get label() { return t("editor.measure.baseLowest"); } },
  { id: "horizontal", get label() { return t("editor.measure.baseHorizontal"); } },
  { id: "threePoint", get label() { return t("editor.measure.baseThreePoint"); } },
];

function cloneVecArray(arr) {
  return Array.isArray(arr) ? arr.map((v) => v.clone()) : [];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class MeasureManager {
  constructor({
    scene,
    stage,
    overlaySvg,
    floatingCardEl,
    scaleCardEl,
    getCloud,
    getRenderer,
    getCamera,
    getDisplayMode,
    history,
    requestRender,
    setStatus,
    onContextBarRefresh,
    showCursorHintPill,
    hideCursorHintPill,
  }) {
    this.scene = scene;
    this.stage = stage;
    this.overlaySvg = overlaySvg;
    this.floatingCardEl = floatingCardEl;
    this.scaleCardEl = scaleCardEl;
    this.getCloud = getCloud;
    this.getRenderer = getRenderer;
    this.getCamera = getCamera;
    this.getDisplayMode = getDisplayMode;
    this.history = history;
    this.requestRender = requestRender;
    this.setStatus = setStatus;
    this.onContextBarRefresh = onContextBarRefresh;
    this.showCursorHintPill = showCursorHintPill;
    this.hideCursorHintPill = hideCursorHintPill;

    // Non-destructive global scale factor (1 raw unit * factor = meters)
    this.scale = { factor: 1.0, unit: "m", calibrated: false };
    this.translucentAlpha = DEFAULT_TRANSLUCENT_ALPHA;
    this.gridGhostAlpha = DEFAULT_GRID_GHOST_ALPHA;

    // Anti-floater GPU surface picker & normal-aligned cursor
    this.picker = new SolidSurfacePicker();
    this.surfaceCursor = new SurfaceRingCursor();

    // Scale Calibration tool transient state
    this.scaleCalibPoints = [];

    // Active Smart Measuring Pen state
    this.points = [];
    this.closed = false;
    this.subMode = "area"; // "area" | "volume"
    this.snapped = false;
    this.basePlaneMode = "fit"; // "fit" | "lowest" | "horizontal" | "threePoint"
    this.baseHeightOffset = 0;
    this.customBasePts = [];
    this.pickingBasePts = false;
    this.noiseFilter = true;
    this.manualPeakWorld = null;
    this.vizMode = 0; // 0..3 (Heap temporary GPU view)
    this.metrics = null;

    // Hover & 3D handle drag state
    this.hoverHit = null;
    this.hoverSnapStart = false;
    this.hoveredHandle = null;
    this.activeDrag = null;
    this._activeTool = "orbit";
    this._browseActive = true;

    // Pinned measurements (retained across new measurements!)
    this.pinnedItems = [];
    this._nextPinId = 1;
    this._copiedTimer = null;

    // Floating panel UI controller (extracted to measure-card-ui.js)
    this.cardUI = new MeasureCardUI({
      stage: this.stage,
      floatingCardEl: this.floatingCardEl,
      scaleCardEl: this.scaleCardEl,
      getBaseModes: () => BASE_MODES,
      getVizModes: () => VIZ_MODES,
    });

    // Root 3D visuals container
    this.rootGroup = new T.Group();
    this.rootGroup.name = "SmartMeasureRoot";
    this.activeGroup = new T.Group();
    this.activeGroup.name = "SmartMeasureActive";
    this.pinnedGroup = new T.Group();
    this.pinnedGroup.name = "SmartMeasurePinned";
    this.handlesGroup = new T.Group();
    this.handlesGroup.name = "SmartMeasureHandles";
    this.calibGroup = new T.Group();
    this.calibGroup.name = "ScaleCalibVisuals";

    this.rootGroup.add(this.pinnedGroup, this.activeGroup, this.handlesGroup, this.calibGroup, this.surfaceCursor);
    this.scene.add(this.rootGroup);

    this._handleMeshes = []; // raycastable 3D handles for current measurement
    this._raycaster = new T.Raycaster();
  }

  // -------------------------------------------------------------------------
  // Persistence & Scale API
  // -------------------------------------------------------------------------
  exportScaleConfig() {
    return {
      factor: Number(this.scale.factor) || 1.0,
      unit: UNIT_CONFIG[this.scale.unit] ? this.scale.unit : "m",
      calibrated: !!this.scale.calibrated,
    };
  }

  restoreScaleConfig(cfg) {
    if (!cfg || typeof cfg !== "object") {
      this.scale = { factor: 1.0, unit: "m", calibrated: false };
    } else {
      const f = Number(cfg.factor);
      this.scale = {
        factor: Number.isFinite(f) && f > 1e-6 && f < 1e7 ? f : 1.0,
        unit: UNIT_CONFIG[cfg.unit] ? cfg.unit : "m",
        calibrated: !!cfg.calibrated,
      };
    }
    this._renderFloatingCard();
    this.renderSvgOverlay();
    this.onContextBarRefresh?.();
  }

  setUnit(unit) {
    if (!UNIT_CONFIG[unit] || this.scale.unit === unit) return;
    this.scale.unit = unit;
    this._renderFloatingCard();
    this.renderSvgOverlay();
    this.onContextBarRefresh?.();
  }

  refreshLanguage() {
    if (this.scaleCardEl && !this.scaleCardEl.classList.contains("hidden") && this.scaleCalibPoints.length >= 2) {
      this._showScaleCalibCard();
    }
    this._renderFloatingCard();
    this.renderSvgOverlay();
  }

  applyScaleCalibration(realValue, unit, { pushHistory = true } = {}) {
    if (this.scaleCalibPoints.length < 2) return false;
    const rawDist = this.scaleCalibPoints[0].distanceTo(this.scaleCalibPoints[1]);
    if (rawDist < 1e-6) {
      this.setStatus(t("editor.measure.errPointsTooClose"));
      return false;
    }
    const val = Number(realValue);
    if (!Number.isFinite(val) || val <= 0) {
      this.setStatus(t("editor.measure.errInvalidLength"));
      return false;
    }
    const u = UNIT_CONFIG[unit] || UNIT_CONFIG.m;
    const realMeters = val / u.mul;
    const nextFactor = realMeters / rawDist;
    const prevScale = this.exportScaleConfig();
    const nextScale = { factor: nextFactor, unit: u.label, calibrated: true };

    const applyFn = (cfg) => {
      this.scale = { ...cfg };
      this._renderFloatingCard();
      this.renderSvgOverlay();
      this.onContextBarRefresh?.();
      this.requestRender();
    };
    applyFn(nextScale);
    this._hideScaleCalibCard();
    this.scaleCalibPoints = [];
    this._rebuildCalibVisuals();
    this.renderSvgOverlay();

    if (pushHistory && this.history) {
      this.history.push({
        label: t("editor.measure.calibHist", { val, unit: u.label }),
        undo: () => applyFn(prevScale),
        redo: () => applyFn(nextScale),
      });
    }
    this.setStatus(t("editor.measure.calibDone", { factor: nextFactor.toFixed(4) }));
    return true;
  }

  resetScaleCalibration({ pushHistory = true } = {}) {
    const prevScale = this.exportScaleConfig();
    if (!prevScale.calibrated && Math.abs(prevScale.factor - 1.0) < 1e-6) {
      this.setStatus(t("editor.measure.calibAlreadyDefault"));
      return;
    }
    const nextScale = { factor: 1.0, unit: prevScale.unit || "m", calibrated: false };
    const applyFn = (cfg) => {
      this.scale = { ...cfg };
      this._renderFloatingCard();
      this.renderSvgOverlay();
      this.onContextBarRefresh?.();
      this.requestRender();
    };
    applyFn(nextScale);
    if (pushHistory && this.history) {
      this.history.push({
        label: t("editor.measure.calibResetHist"),
        undo: () => applyFn(prevScale),
        redo: () => applyFn(nextScale),
      });
    }
    this.setStatus(t("editor.measure.calibResetDone"));
  }

  // -------------------------------------------------------------------------
  // Snapshot / Undo-Redo Helpers (Global HistoryManager 5B)
  // -------------------------------------------------------------------------
  captureSnapshot() {
    return {
      points: cloneVecArray(this.points),
      closed: this.closed,
      subMode: this.subMode,
      snapped: this.snapped,
      basePlaneMode: this.basePlaneMode,
      baseHeightOffset: this.baseHeightOffset,
      customBasePts: cloneVecArray(this.customBasePts),
      noiseFilter: this.noiseFilter,
      manualPeakWorld: this.manualPeakWorld ? this.manualPeakWorld.clone() : null,
      vizMode: this.vizMode,
    };
  }

  restoreSnapshot(snap) {
    if (!snap) return;
    this.points = cloneVecArray(snap.points);
    this.closed = !!snap.closed;
    this.subMode = snap.subMode || "area";
    this.snapped = !!snap.snapped;
    this.basePlaneMode = snap.basePlaneMode || "fit";
    this.baseHeightOffset = Number(snap.baseHeightOffset) || 0;
    this.customBasePts = cloneVecArray(snap.customBasePts);
    this.pickingBasePts = false;
    this.noiseFilter = snap.noiseFilter !== false;
    this.manualPeakWorld = snap.manualPeakWorld ? snap.manualPeakWorld.clone() : null;
    this.vizMode = this.closed && this.subMode === "volume" ? (snap.vizMode | 0) : 0;
    this.recompute();
  }

  _commitUndoableMutation(label, beforeSnap) {
    const afterSnap = this.captureSnapshot();
    if (this.history) {
      this.history.push({
        label,
        undo: () => this.restoreSnapshot(beforeSnap),
        redo: () => this.restoreSnapshot(afterSnap),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Tool Lifecycle & Safe Mode / Export Helpers
  // -------------------------------------------------------------------------
  invalidatePicker() {
    this.picker.invalidate();
  }

  setHelpersVisible(visible) {
    this.rootGroup.visible = !!visible;
  }

  onToolStateChanged(tool, isEffectiveBrowse) {
    const prevTool = this._activeTool;
    this._activeTool = tool;
    this._browseActive = !!isEffectiveBrowse;

    if (tool !== "scaleCalib") {
      this._hideScaleCalibCard();
      if (prevTool === "scaleCalib") {
        this.scaleCalibPoints = [];
        this._rebuildCalibVisuals();
      }
    }

    if (tool !== "smartMeasure") {
      this.pickingBasePts = false;
      this.hoverHit = null;
      this.hoverSnapStart = false;
      this.surfaceCursor.hide();
      // ALWAYS restore GPU temporary view mode to Standard (0) when exiting smartMeasure!
      if (this.vizMode !== 0) {
        this.vizMode = 0;
        this._syncGpuViz();
      }
      // Keep pinned results visible, hide transient floating card only if nothing pinned & tool left
      if (!this.closed && this.points.length === 0 && this.pinnedItems.length === 0) {
        this.floatingCardEl?.classList.add("hidden");
      } else if (tool !== "scaleCalib") {
        // Hide interactive editing card when switched to unrelated tools; pinned badges remain in SVG!
        this.floatingCardEl?.classList.add("hidden");
      }
    } else {
      if (this.points.length >= 2 || this.pinnedItems.length > 0) {
        this._renderFloatingCard();
      }
      this._syncGpuViz();
    }

    if (tool !== "smartMeasure" && tool !== "scaleCalib") {
      this.surfaceCursor.hide();
      this.activeDrag = null;
      this.hoveredHandle = null;
    }

    this._rebuildActiveVisuals();
    this.renderSvgOverlay();
    this.requestRender();
  }

  /**
   * Called on Esc press. Returns true if MeasureManager consumed Esc (e.g. exiting 3-pt base pick or restoring vizMode).
   */
  handleEscape() {
    if (this.pickingBasePts) {
      this.pickingBasePts = false;
      this.customBasePts = [];
      this._renderFloatingCard();
      this.onContextBarRefresh?.();
      this.setStatus(t("editor.measure.basePickCanceled"));
      this.requestRender();
      return true;
    }
    if (this.vizMode !== 0) {
      this.setVizMode(0);
      this.setStatus(t("editor.measure.vizExited"));
      return true;
    }
    if (this._activeTool === "scaleCalib" && !this.scaleCardEl?.classList.contains("hidden")) {
      this._hideScaleCalibCard();
      this.scaleCalibPoints = [];
      this._rebuildCalibVisuals();
      this.renderSvgOverlay();
      this.onContextBarRefresh?.();
      this.requestRender();
      return true;
    }
    return false;
  }

  /**
   * Conflict 1 (User Approved): Intercept Backspace strictly during point picking to undo ONLY the last point,
   * NEVER triggering Gaussian soft-delete!
   */
  undoLastPoint() {
    if (this._activeTool === "scaleCalib" && this.scaleCalibPoints.length > 0) {
      this.scaleCalibPoints.pop();
      this._hideScaleCalibCard();
      this._rebuildCalibVisuals();
      this.renderSvgOverlay();
      this.onContextBarRefresh?.();
      this.setStatus(this.scaleCalibPoints.length === 0 ? t("editor.measure.calibUndoFirst") : t("editor.measure.calibUndoSecond"));
      this.requestRender();
      return true;
    }
    if (this._activeTool === "smartMeasure") {
      if (this.pickingBasePts && this.customBasePts.length > 0) {
        this.customBasePts.pop();
        this._rebuildActiveVisuals();
        this.renderSvgOverlay();
        this.setStatus(t("editor.measure.baseUndoPt", { count: this.customBasePts.length }));
        this.requestRender();
        return true;
      }
      if (!this.closed && this.points.length > 0) {
        this.points.pop();
        this.recompute();
        this.setStatus(this.points.length === 0 ? t("editor.measure.undoAllPts") : t("editor.measure.undoPrevPt", { count: this.points.length }));
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Smart Measurement Actions
  // -------------------------------------------------------------------------
  clearActive({ keepPinned = true } = {}) {
    this.points = [];
    this.closed = false;
    this.subMode = "area";
    this.snapped = false;
    this.basePlaneMode = "fit";
    this.baseHeightOffset = 0;
    this.customBasePts = [];
    this.pickingBasePts = false;
    this.manualPeakWorld = null;
    this.vizMode = 0;
    this.metrics = null;
    this.activeDrag = null;
    this.hoveredHandle = null;
    if (!keepPinned) {
      this.pinnedItems = [];
      this._rebuildPinnedVisuals();
    }
    this._syncGpuViz();
    this._rebuildActiveVisuals();
    this._renderFloatingCard();
    this.renderSvgOverlay();
    this.onContextBarRefresh?.();
    this.requestRender();
  }

  closePolygon() {
    if (this.closed || this.points.length < 3) return false;
    this.closed = true;
    this.subMode = "area";
    this.snapped = false;
    this.basePlaneMode = "fit";
    this.baseHeightOffset = 0;
    this.manualPeakWorld = null;
    this.vizMode = 0;
    this.hoverSnapStart = false;
    this.recompute();
    this.setStatus(t("editor.measure.polyClosed"));
    return true;
  }

  setSubMode(mode) {
    if (!this.closed || (mode !== "area" && mode !== "volume")) return;
    if (this.subMode === mode) return;
    this.subMode = mode;
    if (mode !== "volume") {
      this.vizMode = 0;
      this.pickingBasePts = false;
    }
    this._syncGpuViz();
    this._rebuildActiveVisuals();
    this._renderFloatingCard();
    this.renderSvgOverlay();
    this.onContextBarRefresh?.();
    this.requestRender();
  }

  setVizMode(mode) {
    const m = this.closed && this.subMode === "volume" ? Math.max(0, Math.min(3, mode | 0)) : 0;
    if (this.vizMode === m) return;
    this.vizMode = m;
    this._syncGpuViz();
    this._rebuildActiveVisuals();
    this._renderFloatingCard();
    this.requestRender();
  }

  runSmartSnap() {
    const cloud = this.getCloud?.();
    if (!cloud || !this.closed || this.points.length < 3) return false;
    const beforeSnap = this.captureSnapshot();
    const snappedPts = smartSnapPolygonToEdges(cloud, this.points, 36);
    if (!snappedPts || snappedPts.length < 3) return false;
    this.points = snappedPts;
    this.snapped = true;
    this.manualPeakWorld = null;
    this.recompute();
    this._commitUndoableMutation(t("editor.measure.smartSnapHist"), beforeSnap);
    this.setStatus(t("editor.measure.smartSnapDone", { count: this.points.length }));
    return true;
  }

  setBasePlaneMode(mode) {
    if (!this.closed) return;
    if (mode === "threePoint") {
      this.pickingBasePts = true;
      this.customBasePts = [];
      this._renderFloatingCard();
      this.onContextBarRefresh?.();
      this.setStatus(t("editor.measure.basePickStart"));
      this.requestRender();
      return;
    }
    const beforeSnap = this.captureSnapshot();
    this.pickingBasePts = false;
    this.basePlaneMode = mode;
    this.baseHeightOffset = 0;
    this.recompute();
    const labelMap = {
      fit: t("editor.measure.baseFitHist"),
      lowest: t("editor.measure.baseLowestHist"),
      horizontal: t("editor.measure.baseHorizontalHist"),
    };
    this._commitUndoableMutation(labelMap[mode] || t("editor.measure.baseSwitchHist"), beforeSnap);
    this.setStatus(t("editor.measure.baseSwitched", { mode: labelMap[mode] || mode }));
  }

  adjustBaseHeightOffset(nextOffset, { pushHistory = true, beforeSnap = null } = {}) {
    if (!this.closed) return;
    const prev = beforeSnap || this.captureSnapshot();
    this.baseHeightOffset = Number(nextOffset) || 0;
    this.recompute();
    if (pushHistory) {
      this._commitUndoableMutation(t("editor.measure.baseHeightHist"), prev);
    }
  }

  setNoiseFilter(enabled) {
    const next = !!enabled;
    if (this.noiseFilter === next) return;
    const beforeSnap = this.captureSnapshot();
    this.noiseFilter = next;
    this.manualPeakWorld = null;
    this.recompute();
    this._commitUndoableMutation(next ? t("editor.measure.noiseFilterOnHist") : t("editor.measure.noiseFilterOffHist"), beforeSnap);
  }

  resetManualPeak() {
    if (!this.manualPeakWorld) return;
    const beforeSnap = this.captureSnapshot();
    this.manualPeakWorld = null;
    this.recompute();
    this._commitUndoableMutation(t("editor.measure.resetPeakHist"), beforeSnap);
  }

  pinCurrentMeasurement() {
    if (this.points.length < 2) return null;
    const id = this._nextPinId++;
    const kind = this.closed ? (this.subMode === "volume" ? "volume" : "area") : (this.points.length === 2 ? "distance" : "polyline");
    const kindNames = {
      distance: t("editor.measure.kindDistance"),
      polyline: t("editor.measure.kindPolyline"),
      area: t("editor.measure.kindArea"),
      volume: t("editor.measure.kindVolume"),
    };
    const item = {
      id,
      name: t("editor.measure.pinName", { kind: kindNames[kind], id }),
      kind,
      points: cloneVecArray(this.points),
      closed: this.closed,
      metrics: this._cloneMetricsSummary(),
    };
    this.pinnedItems.push(item);
    this._rebuildPinnedVisuals();
    // Clear active temporary measurement so user can measure next target while pinned stays!
    this.clearActive({ keepPinned: true });
    this.setStatus(t("editor.measure.pinnedStatus", { name: item.name }));
    return item;
  }

  removePinnedItem(id) {
    const idx = this.pinnedItems.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.pinnedItems.splice(idx, 1);
    this._rebuildPinnedVisuals();
    this._renderFloatingCard();
    this.renderSvgOverlay();
    this.requestRender();
  }

  clearAllPinned() {
    this.pinnedItems = [];
    this._rebuildPinnedVisuals();
    this._renderFloatingCard();
    this.renderSvgOverlay();
    this.requestRender();
  }

  _cloneMetricsSummary() {
    if (!this.metrics) return null;
    const m = this.metrics;
    return {
      straight: m.straight,
      horiz: m.horiz,
      deltaH: m.deltaH,
      slopeDeg: m.slopeDeg,
      slopePct: m.slopePct,
      total: m.total,
      segments: m.segments ? [...m.segments] : null,
      perimeter: m.perimeter,
      projectedArea: m.projectedArea,
      fittedPlaneArea: m.fittedPlaneArea,
      surfaceArea: m.surfaceArea,
      volume: m.volume,
      maxHeight: m.maxHeight,
      meanHeight: m.meanHeight,
      peakWorldPos: m.peakWorldPos ? m.peakWorldPos.clone() : null,
      peakBasePos: m.peakBasePos ? m.peakBasePos.clone() : null,
      baseBoundary3D: m.baseBoundary3D ? cloneVecArray(m.baseBoundary3D) : null,
    };
  }

  formatReportText() {
    const f = this.scale.factor;
    const u = this.scale.unit;
    const lines = [];
    if (this.scale.calibrated) {
      lines.push(t("editor.measure.reportCalib", { factor: f.toFixed(4), unit: u }));
    }
    if (!this.closed && this.points.length === 2 && this.metrics) {
      const m = this.metrics;
      lines.push(t("editor.measure.reportStraight", { val: formatLength(m.straight, f, u) }));
      lines.push(t("editor.measure.reportHoriz", { val: formatLength(m.horiz, f, u) }));
      lines.push(t("editor.measure.reportDeltaH", { val: `${m.deltaH >= 0 ? "+" : ""}${formatLength(m.deltaH, f, u)}` }));
      lines.push(t("editor.measure.reportSlope", { deg: m.slopeDeg.toFixed(1), pct: Number.isFinite(m.slopePct) ? m.slopePct.toFixed(1) + "%" : "∞" }));
    } else if (!this.closed && this.points.length >= 3 && this.metrics) {
      lines.push(t("editor.measure.reportPolyTotal", { segs: this.points.length - 1, val: formatLength(this.metrics.total, f, u) }));
      this.metrics.segments.forEach((seg, idx) => {
        lines.push(t("editor.measure.reportSeg", { idx: idx + 1, val: formatLength(seg, f, u) }));
      });
    } else if (this.closed && this.metrics) {
      const m = this.metrics;
      if (this.subMode === "area") {
        lines.push(t("editor.measure.reportAreaHead"));
        lines.push(t("editor.measure.reportProjArea", { val: formatArea(m.projectedArea, f, u) }));
        lines.push(t("editor.measure.reportSurfArea", { val: formatArea(m.surfaceArea, f, u) }));
        lines.push(t("editor.measure.reportFitArea", { val: formatArea(m.fittedPlaneArea, f, u) }));
        lines.push(t("editor.measure.reportPerim", { val: formatLength(m.perimeter, f, u) }));
      } else {
        lines.push(t("editor.measure.reportVolHead"));
        lines.push(t("editor.measure.reportVolume", { val: formatVolume(m.volume, f, u) }));
        lines.push(t("editor.measure.reportMaxH", { val: formatLength(m.maxHeight, f, u) }));
        lines.push(t("editor.measure.reportMeanH", { val: formatLength(m.meanHeight, f, u) }));
        lines.push(t("editor.measure.reportBaseArea", { val: formatArea(m.projectedArea, f, u) }));
        lines.push(t("editor.measure.reportPerim", { val: formatLength(m.perimeter, f, u) }));
      }
    }
    return lines.join("\n");
  }

  async copyCurrentReport() {
    const text = this.formatReportText();
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
    this.setStatus(t("editor.measure.copiedStatus"));
    const btn = this.floatingCardEl?.querySelector("[data-mact='copy']");
    if (btn) {
      btn.textContent = t("editor.measure.copiedBtn");
      if (this._copiedTimer) clearTimeout(this._copiedTimer);
      this._copiedTimer = setTimeout(() => {
        const b = this.floatingCardEl?.querySelector("[data-mact='copy']");
        if (b) b.textContent = t("editor.measure.copyBtn");
      }, 1400);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Core Metric Computation & GPU Sync
  // -------------------------------------------------------------------------
  recompute() {
    const cloud = this.getCloud?.();
    if (this.closed && this.points.length >= 3 && cloud) {
      this.metrics = computePolygonAreaAndVolume(cloud, this.points, {
        basePlaneMode: this.basePlaneMode,
        baseHeightOffset: this.baseHeightOffset,
        customBasePts: this.customBasePts.length === 3 ? this.customBasePts : null,
        noiseFilter: this.noiseFilter,
        manualPeakWorld: this.manualPeakWorld,
      });
    } else if (!this.closed && this.points.length === 2) {
      const m2 = computeTwoPointMetrics(this.points[0], this.points[1]);
      this.metrics = { ...m2, segments: [m2.straight], total: m2.straight };
    } else if (!this.closed && this.points.length >= 3) {
      this.metrics = computePolylineMetrics(this.points, false);
    } else {
      this.metrics = null;
    }

    this._syncGpuViz();
    this._rebuildActiveVisuals();
    this._renderFloatingCard();
    this.renderSvgOverlay();
    this.onContextBarRefresh?.();
    this.requestRender();
  }

  _syncGpuViz() {
    const cloud = this.getCloud?.();
    if (!cloud || typeof cloud.setMeasureVizUniforms !== "function") return;
    if (this._activeTool === "smartMeasure" && this.closed && this.subMode === "volume" && this.vizMode > 0 && this.metrics?.basePlane) {
      const bp = this.metrics.basePlane;
      cloud.setMeasureVizUniforms({
        mode: this.vizMode,
        origin: bp.origin,
        normal: bp.normal,
        axisU: bp.u,
        axisV: bp.v,
        polyUV: this.metrics.polyUV,
        polyBoundsUV: this.metrics.polyBoundsUV,
        maxHeight: Math.max(0.05, this.metrics.maxHeight || 1.0),
        translucentAlpha: this.translucentAlpha,
        gridGhostAlpha: this.gridGhostAlpha,
      });
    } else {
      cloud.setMeasureVizUniforms({ mode: 0 });
    }
  }

  // -------------------------------------------------------------------------
  // Pointer Interaction (Handles Drag + Solid Surface Picking)
  // -------------------------------------------------------------------------
  _screenToNdc(clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    return [
      ((clientX - r.left) / Math.max(1, r.width)) * 2 - 1,
      -((clientY - r.top) / Math.max(1, r.height)) * 2 + 1,
    ];
  }

  _screenToNorm01(clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))),
      Math.max(0, Math.min(1, (clientY - r.top) / Math.max(1, r.height))),
    ];
  }

  _projectToOverlayPx(worldPos) {
    const camera = this.getCamera?.();
    if (!camera || !worldPos) return null;
    const r = this.stage.getBoundingClientRect();
    const p = worldPos.clone().project(camera);
    if (p.z < -1.0 || p.z > 1.0) return null;
    return [((p.x + 1) * 0.5) * r.width, ((1 - p.y) * 0.5) * r.height];
  }

  _pickSolidAt(clientX, clientY) {
    const cloud = this.getCloud?.();
    const renderer = this.getRenderer?.();
    const camera = this.getCamera?.();
    if (!cloud || !renderer || !camera) return null;
    const [nx, ny] = this._screenToNorm01(clientX, clientY);
    return this.picker.pickSurface(
      cloud,
      renderer,
      camera,
      this.stage.clientWidth,
      this.stage.clientHeight,
      nx,
      ny,
      this.getDisplayMode?.() || "splat",
    );
  }

  _isNearStartVertex(clientX, clientY) {
    if (this._activeTool !== "smartMeasure" || this.closed || this.points.length < 3 || this.pickingBasePts) return false;
    const p0 = this._projectToOverlayPx(this.points[0]);
    if (!p0) return false;
    const r = this.stage.getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    return Math.hypot(sx - p0[0], sy - p0[1]) <= START_CLOSE_PX;
  }

  /**
   * Capture-phase pointerdown hook: intercepts 3D measurement handle drags BEFORE OrbitControls!
   * Returns true if a handle drag was started.
   */
  handlePointerDownCapture(e) {
    if (e.button !== 0 || this._activeTool !== "smartMeasure" || this.pickingBasePts) return false;
    if (this._handleMeshes.length === 0) return false;
    const camera = this.getCamera?.();
    if (!camera) return false;

    const [ndcX, ndcY] = this._screenToNdc(e.clientX, e.clientY);
    this._raycaster.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
    const hits = this._raycaster.intersectObjects(this._handleMeshes, false);
    if (hits.length === 0) return false;

    const hObj = hits[0].object;
    const ud = hObj.userData;
    const viewDir = new T.Vector3();
    camera.getWorldDirection(viewDir);

    if (ud.kind === "vertex") {
      const idx = ud.index;
      const anchor = this.points[idx].clone();
      // Drag plane tangent to base plane if closed, else camera-facing plane at anchor
      const nrm = this.metrics?.basePlane && !e.shiftKey
        ? this.metrics.basePlane.normal.clone()
        : viewDir.clone().negate();
      // If camera is nearly grazing the base plane, fall back to camera-facing plane for smooth drag!
      const planeNormal = Math.abs(nrm.dot(viewDir)) < 0.25 ? viewDir.clone().negate() : nrm;
      const dragPlane = new T.Plane().setFromNormalAndCoplanarPoint(planeNormal, anchor);
      const startHit = new T.Vector3();
      if (!this._raycaster.ray.intersectPlane(dragPlane, startHit)) startHit.copy(anchor);
      this.activeDrag = {
        kind: "vertex",
        index: idx,
        dragPlane,
        startHit,
        startPoints: cloneVecArray(this.points),
        beforeSnap: this.captureSnapshot(),
      };
      this.surfaceCursor.hide();
      return true;
    }

    if (ud.kind === "basePlane" && this.metrics?.basePlane) {
      const bp = this.metrics.basePlane;
      const anchor = new T.Vector3();
      hObj.getWorldPosition(anchor);
      const side = new T.Vector3().crossVectors(bp.normal, viewDir);
      const planeNormal = side.lengthSq() > 1e-5
        ? new T.Vector3().crossVectors(side, bp.normal).normalize()
        : viewDir.clone().negate();
      const dragPlane = new T.Plane().setFromNormalAndCoplanarPoint(planeNormal, anchor);
      const startHit = new T.Vector3();
      if (!this._raycaster.ray.intersectPlane(dragPlane, startHit)) startHit.copy(anchor);
      this.activeDrag = {
        kind: "basePlane",
        normal: bp.normal.clone(),
        dragPlane,
        startHit,
        startOffset: this.baseHeightOffset,
        beforeSnap: this.captureSnapshot(),
      };
      this.surfaceCursor.hide();
      return true;
    }

    if (ud.kind === "peak" && this.metrics?.peakWorldPos) {
      const anchor = this.metrics.peakWorldPos.clone();
      const dragPlane = new T.Plane().setFromNormalAndCoplanarPoint(viewDir.clone().negate(), anchor);
      const startHit = new T.Vector3();
      if (!this._raycaster.ray.intersectPlane(dragPlane, startHit)) startHit.copy(anchor);
      this.activeDrag = {
        kind: "peak",
        dragPlane,
        startHit,
        startPeak: anchor,
        beforeSnap: this.captureSnapshot(),
      };
      this.surfaceCursor.hide();
      return true;
    }

    return false;
  }

  /**
   * Handle pointermove during handle drag OR solid-surface hover preview.
   * Returns true if consumed by an active drag.
   */
  handlePointerMove(e, isEffectiveBrowse) {
    const camera = this.getCamera?.();
    if (!camera) return false;

    if (this.activeDrag) {
      const [ndcX, ndcY] = this._screenToNdc(e.clientX, e.clientY);
      this._raycaster.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
      const curHit = new T.Vector3();
      if (this._raycaster.ray.intersectPlane(this.activeDrag.dragPlane, curHit)) {
        const delta = curHit.clone().sub(this.activeDrag.startHit);
        if (this.activeDrag.kind === "vertex") {
          this.points = applySoftVertexDrag(this.activeDrag.startPoints, this.activeDrag.index, delta, this.closed);
          this.recompute();
          const softNote = this.points.length > 10 && this.closed ? t("editor.measure.softDeformNote") : "";
          this.showCursorHintPill?.(e.clientX, e.clientY, { text: t("editor.measure.dragVertexHint", { note: softNote }) });
        } else if (this.activeDrag.kind === "basePlane") {
          const dH = delta.dot(this.activeDrag.normal);
          this.baseHeightOffset = this.activeDrag.startOffset + dH;
          this.recompute();
          const offStr = formatLength(this.baseHeightOffset, this.scale.factor, this.scale.unit);
          this.showCursorHintPill?.(e.clientX, e.clientY, {
            text: t("editor.measure.dragBaseHint", { offset: `${this.baseHeightOffset >= 0 ? "+" : ""}${offStr}` }),
          });
        } else if (this.activeDrag.kind === "peak") {
          this.manualPeakWorld = this.activeDrag.startPeak.clone().add(delta);
          this.recompute();
          const hStr = formatLength(this.metrics?.maxHeight || 0, this.scale.factor, this.scale.unit);
          this.showCursorHintPill?.(e.clientX, e.clientY, { text: t("editor.measure.dragPeakHint", { height: hStr }) });
        }
      }
      return true;
    }

    if (this._activeTool !== "smartMeasure" && this._activeTool !== "scaleCalib") return false;
    if (isEffectiveBrowse) {
      this.surfaceCursor.hide();
      this.hoverHit = null;
      this.hoverSnapStart = false;
      return false;
    }

    // Check 3D handle hover first when in smartMeasure (and not picking 3-pt base)
    if (this._activeTool === "smartMeasure" && !this.pickingBasePts && this._handleMeshes.length > 0) {
      const [ndcX, ndcY] = this._screenToNdc(e.clientX, e.clientY);
      this._raycaster.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
      const hits = this._raycaster.intersectObjects(this._handleMeshes, false);
      if (hits.length > 0) {
        const hObj = hits[0].object;
        this.hoveredHandle = hObj;
        this.surfaceCursor.hide();
        this.hoverHit = null;
        this.hoverSnapStart = false;
        const kind = hObj.userData.kind;
        const isClosableStart = kind === "vertex" && hObj.userData.index === 0 && !this.closed && this.points.length >= 3;
        this.hoverSnapStart = isClosableStart;
        const tip = kind === "basePlane"
          ? t("editor.measure.hoverBaseHint")
          : kind === "peak"
          ? t("editor.measure.hoverPeakHint")
          : isClosableStart
          ? t("editor.measure.hoverStartVertexCloseHint")
          : (this.points.length > 10 && this.closed ? t("editor.measure.hoverVertexSoftHint") : t("editor.measure.hoverVertexHint"));
        this.showCursorHintPill?.(e.clientX, e.clientY, { text: tip });
        this._syncHandleHighlights();
        this.renderSvgOverlay();
        this.requestRender();
        return false;
      } else if (this.hoveredHandle) {
        this.hoveredHandle = null;
        this._syncHandleHighlights();
      }
    }

    // If closed (and not picking 3-pt base), no more surface picking cursor needed
    if (this._activeTool === "smartMeasure" && this.closed && !this.pickingBasePts) {
      this.surfaceCursor.hide();
      this.hoverHit = null;
      this.hoverSnapStart = false;
      this.hideCursorHintPill?.();
      this.requestRender();
      return false;
    }

    // Hovering near start vertex when >= 3 points: show dual drag + double-click-to-close hint (rc12 #3.2)!
    if (this._isNearStartVertex(e.clientX, e.clientY)) {
      this.hoverSnapStart = true;
      const p0 = this.points[0].clone();
      const toCam = new T.Vector3().subVectors(camera.position, p0).normalize();
      this.hoverHit = { idx: -1, worldPos: p0, normal: toCam };
      this.surfaceCursor.update(this.hoverHit, camera, { snapHighlight: true });
      this.showCursorHintPill?.(e.clientX, e.clientY, { text: t("editor.measure.hoverStartVertexCloseHint") });
      this.renderSvgOverlay();
      this.requestRender();
      return false;
    }
    this.hoverSnapStart = false;

    // Anti-floater GPU solid surface pick + normal-aligned circular ring cursor!
    const hit = this._pickSolidAt(e.clientX, e.clientY);
    this.hoverHit = hit;
    if (hit) {
      this.surfaceCursor.update(hit, camera, { snapHighlight: false });
      let msg = "";
      if (this._activeTool === "scaleCalib") {
        const step = this.scaleCalibPoints.length >= 2 ? 1 : this.scaleCalibPoints.length + 1;
        msg = step === 1 ? t("editor.measure.hoverCalib1") : t("editor.measure.hoverCalib2");
      } else if (this.pickingBasePts) {
        msg = t("editor.measure.hoverBasePt", { step: this.customBasePts.length + 1 });
      } else if (this.points.length === 0) {
        msg = t("editor.measure.hoverPt1");
      } else if (this.points.length === 1) {
        msg = t("editor.measure.hoverPt2");
      } else {
        msg = t("editor.measure.hoverPtMore", { count: this.points.length });
      }
      this.showCursorHintPill?.(e.clientX, e.clientY, { text: msg, warn: false });
    } else {
      this.surfaceCursor.hide();
      this.showCursorHintPill?.(e.clientX, e.clientY, { text: t("editor.measure.noSolidHit"), warn: true });
    }
    this.renderSvgOverlay();
    this.requestRender();
    return false;
  }

  handlePointerUpDrag() {
    if (!this.activeDrag) return false;
    const drag = this.activeDrag;
    this.activeDrag = null;
    this.hideCursorHintPill?.();
    if (drag.kind === "vertex") {
      const moved =
        drag.startPoints[drag.index] &&
        this.points[drag.index] &&
        drag.startPoints[drag.index].distanceTo(this.points[drag.index]) > 1e-4;
      if (moved) {
        this._commitUndoableMutation(t("editor.measure.dragVertexHist"), drag.beforeSnap);
      }
    } else if (drag.kind === "basePlane") {
      if (Math.abs(this.baseHeightOffset - drag.startOffset) > 1e-4) {
        this._commitUndoableMutation(t("editor.measure.baseHeightHist"), drag.beforeSnap);
      }
    } else if (drag.kind === "peak") {
      if (this.manualPeakWorld && this.manualPeakWorld.distanceTo(drag.startPeak) > 1e-4) {
        this._commitUndoableMutation(t("editor.measure.manualPeakHist"), drag.beforeSnap);
      }
    }
    this.requestRender();
    return true;
  }

  handlePointerLeave() {
    this.hoverHit = null;
    this.hoverSnapStart = false;
    this.surfaceCursor.hide();
    if (this.hoveredHandle) {
      this.hoveredHandle = null;
      this._syncHandleHighlights();
    }
    this.renderSvgOverlay();
  }

  /**
   * Handle single click (<5px drag guard) on canvas when scaleCalib or smartMeasure is active.
   */
  handleCanvasClick(e) {
    if (this._activeTool === "scaleCalib") {
      const hit = this._pickSolidAt(e.clientX, e.clientY);
      if (!hit) {
        this.showCursorHintPill?.(e.clientX, e.clientY, { text: t("editor.measure.noSolidHit"), warn: true });
        return true;
      }
      if (this.scaleCalibPoints.length >= 2) {
        this.scaleCalibPoints = [];
      }
      this.scaleCalibPoints.push(hit.worldPos.clone());
      this._rebuildCalibVisuals();
      this.renderSvgOverlay();
      this.onContextBarRefresh?.();
      if (this.scaleCalibPoints.length === 2) {
        this._showScaleCalibCard();
      } else {
        this._hideScaleCalibCard();
      }
      this.requestRender();
      return true;
    }

    if (this._activeTool === "smartMeasure") {
      // Sub-mode: 3-point reference base plane picking!
      if (this.pickingBasePts) {
        const hit = this._pickSolidAt(e.clientX, e.clientY);
        if (!hit) {
          this.showCursorHintPill?.(e.clientX, e.clientY, { text: t("editor.measure.noSolidHit"), warn: true });
          return true;
        }
        this.customBasePts.push(hit.worldPos.clone());
        if (this.customBasePts.length >= 3) {
          const beforeSnap = this.captureSnapshot();
          this.pickingBasePts = false;
          this.basePlaneMode = "threePoint";
          this.baseHeightOffset = 0;
          this.recompute();
          this._commitUndoableMutation(t("editor.measure.baseThreePointHist"), beforeSnap);
          this.setStatus(t("editor.measure.base3PtDone"));
        } else {
          this._rebuildActiveVisuals();
          this.renderSvgOverlay();
          this.onContextBarRefresh?.();
          this.setStatus(t("editor.measure.base3PtProgress", { count: this.customBasePts.length }));
          this.requestRender();
        }
        return true;
      }

      // Already closed -> clicks on empty surface do not destroy polygon (user uses vertices or "重新测量")
      if (this.closed) return true;

      // rc12 #3.2: Single-clicking start vertex is reserved for vertex drag/edit (NEVER prematurely closes!);
      // Double-click start vertex closes the polygon cleanly via handleCanvasDblClick!
      if (this._isNearStartVertex(e.clientX, e.clientY)) {
        return true;
      }

      const hit = this._pickSolidAt(e.clientX, e.clientY);
      if (!hit) {
        this.showCursorHintPill?.(e.clientX, e.clientY, { text: t("editor.measure.noSolidHit"), warn: true });
        return true;
      }
      this.points.push(hit.worldPos.clone());
      this.recompute();
      return true;
    }

    return false;
  }

  /**
   * rc12 #3.2: Double-clicking the start vertex (vertex #0) when polyline has >= 3 points closes the polygon!
   * Returns true if consumed so canvas double-click does NOT cancel smartMeasure back to Browse.
   */
  handleCanvasDblClick(e) {
    if (this._activeTool !== "smartMeasure" || this.closed || this.points.length < 3 || this.pickingBasePts) {
      return false;
    }
    let hitStart = this._isNearStartVertex(e.clientX, e.clientY);
    if (!hitStart && this._handleMeshes.length > 0) {
      const camera = this.getCamera?.();
      if (camera) {
        const [ndcX, ndcY] = this._screenToNdc(e.clientX, e.clientY);
        this._raycaster.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
        const hits = this._raycaster.intersectObjects(this._handleMeshes, false);
        if (hits.length > 0 && hits[0].object.userData?.kind === "vertex" && hits[0].object.userData?.index === 0) {
          hitStart = true;
        }
      }
    }
    if (!hitStart) return false;
    this.activeDrag = null;
    this.hideCursorHintPill?.();
    this.closePolygon();
    return true;
  }

  // -------------------------------------------------------------------------
  // Direct Programmatic Test / Script Hooks (for headless verification & power API)
  // -------------------------------------------------------------------------
  addMeasurePointWorld(vec3OrArr) {
    const v = Array.isArray(vec3OrArr) ? new T.Vector3(...vec3OrArr) : vec3OrArr.clone();
    this.points.push(v);
    this.recompute();
  }

  addScaleCalibPointWorld(vec3OrArr) {
    const v = Array.isArray(vec3OrArr) ? new T.Vector3(...vec3OrArr) : vec3OrArr.clone();
    if (this.scaleCalibPoints.length >= 2) this.scaleCalibPoints = [];
    this.scaleCalibPoints.push(v);
    this._rebuildCalibVisuals();
    this.renderSvgOverlay();
    this.onContextBarRefresh?.();
    if (this.scaleCalibPoints.length === 2) this._showScaleCalibCard();
    this.requestRender();
  }

  dragVertexDirect(index, deltaArr) {
    if (index < 0 || index >= this.points.length) return false;
    const beforeSnap = this.captureSnapshot();
    const delta = new T.Vector3(...deltaArr);
    this.points = applySoftVertexDrag(this.points, index, delta, this.closed);
    this.recompute();
    this._commitUndoableMutation(t("editor.measure.dragVertexHist"), beforeSnap);
    return true;
  }

  setThreePointBaseDirect(p0, p1, p2) {
    if (!this.closed) return false;
    const beforeSnap = this.captureSnapshot();
    this.customBasePts = [new T.Vector3(...p0), new T.Vector3(...p1), new T.Vector3(...p2)];
    this.pickingBasePts = false;
    this.basePlaneMode = "threePoint";
    this.baseHeightOffset = 0;
    this.recompute();
    this._commitUndoableMutation(t("editor.measure.baseThreePointHist"), beforeSnap);
    return true;
  }

  setManualPeakDirect(posArr) {
    if (!this.closed) return false;
    const beforeSnap = this.captureSnapshot();
    this.manualPeakWorld = new T.Vector3(...posArr);
    this.recompute();
    this._commitUndoableMutation(t("editor.measure.manualPeakHist"), beforeSnap);
    return true;
  }

  getStateSummary() {
    return {
      activeTool: this._activeTool,
      scale: this.exportScaleConfig(),
      scaleCalibPointCount: this.scaleCalibPoints.length,
      scaleCardVisible: !this.scaleCardEl?.classList.contains("hidden"),
      floatingCardVisible: !this.floatingCardEl?.classList.contains("hidden"),
      pointCount: this.points.length,
      closed: this.closed,
      subMode: this.subMode,
      snapped: this.snapped,
      basePlaneMode: this.basePlaneMode,
      baseHeightOffset: this.baseHeightOffset,
      pickingBasePts: this.pickingBasePts,
      noiseFilter: this.noiseFilter,
      hasManualPeak: !!this.manualPeakWorld,
      vizMode: this.vizMode,
      translucentAlpha: this.translucentAlpha,
      gridGhostAlpha: this.gridGhostAlpha,
      pinnedCount: this.pinnedItems.length,
      handleCount: this._handleMeshes.length,
      metrics: this.metrics
        ? {
            straight: this.metrics.straight ?? null,
            horiz: this.metrics.horiz ?? null,
            deltaH: this.metrics.deltaH ?? null,
            slopeDeg: this.metrics.slopeDeg ?? null,
            total: this.metrics.total ?? null,
            perimeter: this.metrics.perimeter ?? null,
            projectedArea: this.metrics.projectedArea ?? null,
            fittedPlaneArea: this.metrics.fittedPlaneArea ?? null,
            surfaceArea: this.metrics.surfaceArea ?? null,
            volume: this.metrics.volume ?? null,
            maxHeight: this.metrics.maxHeight ?? null,
            meanHeight: this.metrics.meanHeight ?? null,
            insidePointCount: this.metrics.insidePointCount ?? 0,
            gridLineVerts: this.metrics.gridLinePositions ? this.metrics.gridLinePositions.length / 3 : 0,
          }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // Per-Frame Update & 3D Scene Visual Builders
  // -------------------------------------------------------------------------
  updatePerFrame(camera) {
    if (!camera) return;
    // Auto-scale 3D interactive handles smoothly with camera distance
    for (const h of this._handleMeshes) {
      const wp = new T.Vector3();
      h.getWorldPosition(wp);
      const dist = Math.max(0.15, camera.position.distanceTo(wp));
      const base = camera.isOrthographicCamera
        ? Math.max(0.01, (camera.top - camera.bottom) * 0.011)
        : dist * 0.014;
      const mult = h.userData.scaleMult || 1.0;
      const hoverBoost = h === this.hoveredHandle ? 1.38 : 1.0;
      h.scale.setScalar(base * mult * hoverBoost);
    }
    this.renderSvgOverlay();
  }

  _disposeGroupChildren(grp) {
    while (grp.children.length > 0) {
      const c = grp.children[0];
      grp.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
        else c.material.dispose();
      }
    }
  }

  _syncHandleHighlights() {
    for (const h of this._handleMeshes) {
      const isHov = h === this.hoveredHandle;
      if (h.material?.color) {
        h.material.color.setHex(isHov ? 0xfacc15 : (h.userData.baseColor || 0xffffff));
      }
    }
  }

  _rebuildCalibVisuals() {
    this._disposeGroupChildren(this.calibGroup);
    if (this.scaleCalibPoints.length >= 2) {
      const geo = new T.BufferGeometry().setFromPoints(this.scaleCalibPoints.slice(0, 2));
      const line = new T.Line(
        geo,
        new T.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.95, depthTest: false }),
      );
      line.renderOrder = 36;
      this.calibGroup.add(line);
    }
  }

  _rebuildActiveVisuals() {
    this._disposeGroupChildren(this.activeGroup);
    this._disposeGroupChildren(this.handlesGroup);
    this._handleMeshes = [];

    if (this.points.length === 0) return;

    // 1. Active 3D Polyline / Closed Polygon Contour
    if (this.points.length >= 2) {
      const linePts = this.closed ? [...this.points, this.points[0]] : this.points;
      const geo = new T.BufferGeometry().setFromPoints(linePts);
      const col = this.closed
        ? (this.subMode === "volume" ? 0xf97316 : 0x38bdf8)
        : 0xffffff;
      const line = new T.Line(
        geo,
        new T.LineBasicMaterial({ color: col, transparent: true, opacity: 0.96, depthTest: false }),
      );
      line.renderOrder = 35;
      this.activeGroup.add(line);
    }

    // 2. Interactive 3D Vertex Spheres (always draggable when smartMeasure active!)
    const dense = this.closed && this.points.length > 10;
    const sphereGeo = new T.SphereGeometry(0.65, 14, 12);
    for (let i = 0; i < this.points.length; i++) {
      const isStart = i === 0;
      const baseColor = isStart && !this.closed ? 0xfacc15 : (dense ? 0xfdba74 : 0xef4444);
      const mat = new T.MeshBasicMaterial({
        color: baseColor,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      });
      const m = new T.Mesh(sphereGeo.clone(), mat);
      m.position.copy(this.points[i]);
      m.renderOrder = 40;
      m.userData = {
        kind: "vertex",
        index: i,
        baseColor,
        scaleMult: dense ? 0.62 : (isStart && !this.closed ? 1.15 : 0.92),
      };
      this.handlesGroup.add(m);
      this._handleMeshes.push(m);
    }
    sphereGeo.dispose();

    // 3. Closed Area / Heap 3D Visuals
    if (this.closed && this.metrics) {
      const m = this.metrics;
      const bp = m.basePlane;

      // 3a. Reference Base Plane Translucent Fill & Outline
      if (bp && m.polyUV && m.polyUV.length >= 3) {
        try {
          const shape = new T.Shape();
          shape.moveTo(m.polyUV[0][0], m.polyUV[0][1]);
          for (let i = 1; i < m.polyUV.length; i++) {
            shape.lineTo(m.polyUV[i][0], m.polyUV[i][1]);
          }
          shape.closePath();
          const shapeGeo = new T.ShapeGeometry(shape);
          // Transform local (u, v, 0) vertices into world space on basePlane
          const posAttr = shapeGeo.attributes.position;
          const vTmp = new T.Vector3();
          for (let i = 0; i < posAttr.count; i++) {
            const pu = posAttr.getX(i);
            const pv = posAttr.getY(i);
            vTmp.copy(bp.origin).addScaledVector(bp.u, pu).addScaledVector(bp.v, pv);
            posAttr.setXYZ(i, vTmp.x, vTmp.y, vTmp.z);
          }
          posAttr.needsUpdate = true;

          const fillColor = this.subMode === "volume" ? 0x14b8a6 : 0x38bdf8;
          // In Standard (0) & Heatmap (2) Heap Views, render base plane BEFORE splats (renderOrder -1) so the solid mound
          // naturally occludes the interior base fill; in Translucent (1) & Grid Compare (3) render through pile clearly!
          const showThroughPile = this.subMode === "volume" && (this.vizMode === 1 || this.vizMode === 3);
          const fillOpacity = this.subMode === "volume"
            ? (this.vizMode === 2 ? 0.0 : (showThroughPile ? 0.28 : 0.16))
            : 0.14;
          if (fillOpacity > 0.01) {
            const baseMesh = new T.Mesh(
              shapeGeo,
              new T.MeshBasicMaterial({
                color: fillColor,
                transparent: true,
                opacity: fillOpacity,
                side: T.DoubleSide,
                depthWrite: false,
              }),
            );
            baseMesh.renderOrder = showThroughPile ? 25 : -1;
            this.activeGroup.add(baseMesh);
          } else {
            shapeGeo.dispose();
          }
        } catch {
          // Non-simple self-intersecting polygon fallback: skip filled fan safely
        }

        if (m.baseBoundary3D && m.baseBoundary3D.length >= 3) {
          const bPts = [...m.baseBoundary3D, m.baseBoundary3D[0]];
          const bGeo = new T.BufferGeometry().setFromPoints(bPts);
          const bLine = new T.Line(
            bGeo,
            new T.LineBasicMaterial({
              color: this.subMode === "volume" ? 0x2dd4bf : 0x7dd3fc,
              transparent: true,
              opacity: 0.9,
              depthTest: false,
            }),
          );
          bLine.renderOrder = 34;
          this.activeGroup.add(bLine);
        }
      }

      // 3b. Heap Mode Only: 2.5D Surface Grid Wireframe + Base Vertical Drag Handle + Peak Pole & Drag Handle
      if (this.subMode === "volume") {
        // 2.5D calculated mesh wireframe (prominent in Grid Compare mode 3, subtle in Translucent mode 1)
        if (m.gridLinePositions && m.gridLinePositions.length >= 6 && (this.vizMode === 3 || this.vizMode === 1)) {
          const gridGeo = new T.BufferGeometry();
          gridGeo.setAttribute("position", new T.BufferAttribute(m.gridLinePositions, 3));
          const gridLines = new T.LineSegments(
            gridGeo,
            new T.LineBasicMaterial({
              color: this.vizMode === 3 ? 0x38bdf8 : 0x94a3b8,
              transparent: true,
              opacity: this.vizMode === 3 ? 0.92 : 0.36,
              depthTest: false,
            }),
          );
          gridLines.renderOrder = 32;
          this.activeGroup.add(gridLines);
        }

        // Interactive Base Plane Height Handle (teal octahedron/diamond at base centroid)
        if (bp) {
          const baseHandleGeo = new T.OctahedronGeometry(0.95, 0);
          const baseHandleMat = new T.MeshBasicMaterial({
            color: 0x2dd4bf,
            transparent: true,
            opacity: 0.96,
            depthTest: false,
          });
          const baseHandle = new T.Mesh(baseHandleGeo, baseHandleMat);
          baseHandle.position.copy(bp.origin);
          baseHandle.renderOrder = 41;
          baseHandle.userData = { kind: "basePlane", baseColor: 0x2dd4bf, scaleMult: 1.25 };
          this.handlesGroup.add(baseHandle);
          this._handleMeshes.push(baseHandle);
        }

        // Peak Vertical Pole (peakBasePos -> peakWorldPos) + Draggable Top Sphere
        if (m.peakBasePos && m.peakWorldPos) {
          const poleGeo = new T.BufferGeometry().setFromPoints([m.peakBasePos, m.peakWorldPos]);
          const poleLine = new T.Line(
            poleGeo,
            new T.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.98, depthTest: false }),
          );
          poleLine.renderOrder = 39;
          this.activeGroup.add(poleLine);

          const peakCapGeo = new T.SphereGeometry(0.92, 16, 12);
          const peakCapMat = new T.MeshBasicMaterial({
            color: 0xf59e0b,
            transparent: true,
            opacity: 0.98,
            depthTest: false,
          });
          const peakCap = new T.Mesh(peakCapGeo, peakCapMat);
          peakCap.position.copy(m.peakWorldPos);
          peakCap.renderOrder = 42;
          peakCap.userData = { kind: "peak", baseColor: 0xf59e0b, scaleMult: 1.2 };
          this.handlesGroup.add(peakCap);
          this._handleMeshes.push(peakCap);
        }
      }

      // 3c. Show 3-point custom base pick markers when active
      if (this.pickingBasePts && this.customBasePts.length > 0) {
        const bpGeo = new T.SphereGeometry(0.06, 12, 10);
        for (const pt of this.customBasePts) {
          const dot = new T.Mesh(
            bpGeo.clone(),
            new T.MeshBasicMaterial({ color: 0x2dd4bf, depthTest: false }),
          );
          dot.position.copy(pt);
          dot.renderOrder = 43;
          this.activeGroup.add(dot);
        }
        bpGeo.dispose();
      }
    }
  }

  _rebuildPinnedVisuals() {
    this._disposeGroupChildren(this.pinnedGroup);
    for (const item of this.pinnedItems) {
      if (!item.points || item.points.length < 2) continue;
      const pts = item.closed ? [...item.points, item.points[0]] : item.points;
      const geo = new T.BufferGeometry().setFromPoints(pts);
      const color = item.kind === "volume" ? 0xfb923c : item.kind === "area" ? 0x38bdf8 : 0xa78bfa;
      const line = new T.Line(
        geo,
        new T.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }),
      );
      line.renderOrder = 29;
      this.pinnedGroup.add(line);

      if (item.kind === "volume" && item.metrics?.peakBasePos && item.metrics?.peakWorldPos) {
        const pGeo = new T.BufferGeometry().setFromPoints([item.metrics.peakBasePos, item.metrics.peakWorldPos]);
        const pLine = new T.Line(
          pGeo,
          new T.LineBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0.85, depthTest: false }),
        );
        pLine.renderOrder = 30;
        this.pinnedGroup.add(pLine);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Crisp Screen-Space SVG Labels (Active + Live Preview + Pinned Measurements)
  // -------------------------------------------------------------------------
  renderSvgOverlay() {
    if (!this.overlaySvg) return;
    let grp = this.overlaySvg.querySelector("#smart-measure-svg-layer");
    const hasAnything =
      this.pinnedItems.length > 0 ||
      this.scaleCalibPoints.length > 0 ||
      this.points.length > 0 ||
      (this._activeTool === "smartMeasure" && this.hoverHit);
    if (!hasAnything || !this.rootGroup.visible) {
      if (grp) grp.remove();
      return;
    }
    if (!grp) {
      grp = document.createElementNS(SVG_NS, "g");
      grp.id = "smart-measure-svg-layer";
      this.overlaySvg.appendChild(grp);
    }
    grp.innerHTML = "";

    const f = this.scale.factor;
    const u = this.scale.unit;

    const addBadge = (x, y, text, { bg = "rgba(16, 22, 34, 0.92)", border = "rgba(255,255,255,0.32)", fg = "#fef3c7" } = {}) => {
      const bw = Math.max(54, text.length * 6.8 + 16);
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", (x - bw * 0.5).toFixed(1));
      rect.setAttribute("y", (y - 10).toFixed(1));
      rect.setAttribute("width", bw.toFixed(1));
      rect.setAttribute("height", "20");
      rect.setAttribute("rx", "6");
      rect.setAttribute("fill", bg);
      rect.setAttribute("stroke", border);
      rect.setAttribute("stroke-width", "1");
      const txt = document.createElementNS(SVG_NS, "text");
      txt.setAttribute("x", x.toFixed(1));
      txt.setAttribute("y", (y + 3.5).toFixed(1));
      txt.setAttribute("text-anchor", "middle");
      txt.setAttribute("fill", fg);
      txt.setAttribute("font-size", "11");
      txt.setAttribute("font-family", "Cascadia Mono, Consolas, monospace");
      txt.textContent = text;
      grp.append(rect, txt);
    };

    const addDashedLine = (a, b, color = "#ffffff") => {
      const ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("x1", a[0].toFixed(1));
      ln.setAttribute("y1", a[1].toFixed(1));
      ln.setAttribute("x2", b[0].toFixed(1));
      ln.setAttribute("y2", b[1].toFixed(1));
      ln.setAttribute("stroke", color);
      ln.setAttribute("stroke-width", "1.6");
      ln.setAttribute("stroke-dasharray", "5,4");
      ln.setAttribute("stroke-opacity", "0.86");
      grp.appendChild(ln);
    };

    const addDot2D = (p, color = "#ef4444", r = 5.2) => {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", p[0].toFixed(1));
      c.setAttribute("cy", p[1].toFixed(1));
      c.setAttribute("r", String(r));
      c.setAttribute("fill", color);
      c.setAttribute("stroke", "#ffffff");
      c.setAttribute("stroke-width", "2");
      grp.appendChild(c);
    };

    // 1. Pinned measurement badges (always stay visible!)
    for (const item of this.pinnedItems) {
      if (!item.points || item.points.length < 2) continue;
      const center3D = new T.Vector3();
      for (const p of item.points) center3D.add(p);
      center3D.divideScalar(item.points.length);
      const anchor = item.kind === "volume" && item.metrics?.peakWorldPos ? item.metrics.peakWorldPos : center3D;
      const px = this._projectToOverlayPx(anchor);
      if (!px) continue;
      let label = item.name;
      if (item.kind === "distance" && item.metrics) {
        label = `📌 ${formatLength(item.metrics.straight, f, u)}`;
      } else if (item.kind === "polyline" && item.metrics) {
        label = t("editor.measure.pinBadgeTotal", { val: formatLength(item.metrics.total, f, u) });
      } else if (item.kind === "area" && item.metrics) {
        label = t("editor.measure.pinBadgeArea", { val: formatArea(item.metrics.projectedArea, f, u) });
      } else if (item.kind === "volume" && item.metrics) {
        label = t("editor.measure.pinBadgeVol", { vol: formatVolume(item.metrics.volume, f, u), height: formatLength(item.metrics.maxHeight, f, u) });
      }
      addBadge(px[0], px[1] - 14, label, {
        bg: "rgba(24, 20, 34, 0.90)",
        border: "rgba(167, 139, 250, 0.65)",
        fg: "#e9d5ff",
      });
    }

    // 2. Scale calibration points & live line
    if (this._activeTool === "scaleCalib") {
      const p0 = this.scaleCalibPoints[0] ? this._projectToOverlayPx(this.scaleCalibPoints[0]) : null;
      const p1 = this.scaleCalibPoints[1] ? this._projectToOverlayPx(this.scaleCalibPoints[1]) : null;
      const live = this.hoverHit ? this._projectToOverlayPx(this.hoverHit.worldPos) : null;
      if (p0 && p1) {
        addBadge((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5 - 14, t("editor.measure.virtualBadge", { dist: this.scaleCalibPoints[0].distanceTo(this.scaleCalibPoints[1]).toFixed(3) }), {
          border: "rgba(56, 189, 248, 0.7)",
          fg: "#bae6fd",
        });
      } else if (p0 && live) {
        addDashedLine(p0, live, "#38bdf8");
      }
      if (p0) addDot2D(p0, "#0ea5e9", 5.8);
      if (p1) addDot2D(p1, "#0ea5e9", 5.8);
    }

    // 3. Active Smart Measurement guides & segment / peak badges
    if (this.points.length > 0) {
      // Live rubber-band line while open
      if (!this.closed && this._activeTool === "smartMeasure" && this.hoverHit && !this.pickingBasePts) {
        const lastPx = this._projectToOverlayPx(this.points[this.points.length - 1]);
        const livePx = this._projectToOverlayPx(this.hoverHit.worldPos);
        if (lastPx && livePx) {
          addDashedLine(lastPx, livePx, this.hoverSnapStart ? "#facc15" : "#ffffff");
          const d = this.points[this.points.length - 1].distanceTo(this.hoverHit.worldPos);
          addBadge((lastPx[0] + livePx[0]) * 0.5, (lastPx[1] + livePx[1]) * 0.5 - 12, formatLength(d, f, u), {
            bg: "rgba(15, 23, 42, 0.85)",
            border: "rgba(255,255,255,0.28)",
          });
        }
      }

      // Segment midpoint badges when open (2-pt or polyline)
      if (!this.closed && this.points.length >= 2) {
        for (let i = 1; i < this.points.length; i++) {
          const a = this._projectToOverlayPx(this.points[i - 1]);
          const b = this._projectToOverlayPx(this.points[i]);
          if (!a || !b) continue;
          const d = this.points[i - 1].distanceTo(this.points[i]);
          addBadge((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5 - 14, formatLength(d, f, u));
        }
      }

      // Start vertex subtle close-ring halo when >=3 open points
      if (!this.closed && this.points.length >= 3) {
        const p0 = this._projectToOverlayPx(this.points[0]);
        if (p0) {
          const ring = document.createElementNS(SVG_NS, "circle");
          ring.setAttribute("cx", p0[0].toFixed(1));
          ring.setAttribute("cy", p0[1].toFixed(1));
          ring.setAttribute("r", this.hoverSnapStart ? "12" : "9");
          ring.setAttribute("fill", "none");
          ring.setAttribute("stroke", "#facc15");
          ring.setAttribute("stroke-width", this.hoverSnapStart ? "2.4" : "1.5");
          ring.setAttribute("stroke-dasharray", this.hoverSnapStart ? "none" : "3,2");
          grp.appendChild(ring);
        }
      }

      // Closed Heap Mode peak height badge on peak top!
      if (this.closed && this.subMode === "volume" && this.metrics?.peakWorldPos) {
        const pkPx = this._projectToOverlayPx(this.metrics.peakWorldPos);
        if (pkPx) {
          addBadge(pkPx[0], pkPx[1] - 18, t("editor.measure.peakBadge", { height: formatLength(this.metrics.maxHeight, f, u) }), {
            bg: "rgba(38, 24, 8, 0.92)",
            border: "rgba(250, 204, 21, 0.78)",
            fg: "#fef08a",
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scale Calibration & Floating Result Card UI (delegated to MeasureCardUI)
  // -------------------------------------------------------------------------
  _showScaleCalibCard() {
    this.cardUI.showScaleCalibCard(this);
  }

  _hideScaleCalibCard() {
    this.cardUI.hideScaleCalibCard();
  }

  _renderFloatingCard() {
    this.cardUI.renderFloatingCard(this);
  }
}
