// Extracted DOM UI Controller for Smart Measurement Floating Result Card & Scale Calibration Popover.
// Owns DOM rendering, pointer dragging, and button event wiring cleanly separated from 3D geometry state.
import { UNIT_CONFIG, formatLength, formatArea, formatVolume } from "./geometry-engine.js";
import { t } from "../i18n.js";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class MeasureCardUI {
  constructor({ stage, floatingCardEl, scaleCardEl, getBaseModes, getVizModes }) {
    this.stage = stage;
    this.floatingCardEl = floatingCardEl;
    this.scaleCardEl = scaleCardEl;
    this.getBaseModes = getBaseModes;
    this.getVizModes = getVizModes;
    this.cardPos = { x: 94, y: 66 };
    this.cardDragged = false;
    this._initFloatingCardDrag();
  }

  _initFloatingCardDrag() {
    const el = this.floatingCardEl;
    if (!el) return;
    let dragging = null;

    el.addEventListener("pointerdown", (e) => {
      const head = e.target.closest(".mcard-drag-handle");
      if (!head || e.target.closest("button")) return;
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const stRect = this.stage.getBoundingClientRect();
      dragging = {
        dx: e.clientX - rect.left,
        dy: e.clientY - rect.top,
        stLeft: stRect.left,
        stTop: stRect.top,
        stW: stRect.width,
        stH: stRect.height,
        cardW: rect.width,
        cardH: rect.height,
      };
      this.cardDragged = true;
      try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });

    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const nx = Math.max(8, Math.min(dragging.stW - dragging.cardW - 8, e.clientX - dragging.stLeft - dragging.dx));
      const ny = Math.max(8, Math.min(dragging.stH - dragging.cardH - 8, e.clientY - dragging.stTop - dragging.dy));
      this.cardPos.x = nx;
      this.cardPos.y = ny;
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
    });

    window.addEventListener("pointerup", () => {
      dragging = null;
    });
  }

  showScaleCalibCard(mgr) {
    const el = this.scaleCardEl;
    if (!el || mgr.scaleCalibPoints.length < 2) return;
    const rawDist = mgr.scaleCalibPoints[0].distanceTo(mgr.scaleCalibPoints[1]);
    const currentScaled = rawDist * mgr.scale.factor * (UNIT_CONFIG[mgr.scale.unit]?.mul || 1);

    el.innerHTML = `
      <div class="mcard-head">
        <span class="mcard-title">${escapeHtml(t("editor.measure.calibTitle"))}</span>
        <button type="button" class="mcard-close" data-sact="close" aria-label="${escapeHtml(t("common.close"))}">✕</button>
      </div>
      <div class="mcard-body">
        <div class="scalib-meta">${escapeHtml(t("editor.measure.calibVirtualDist"))} <strong>${rawDist.toFixed(4)} u</strong>${mgr.scale.calibrated ? ` · ${escapeHtml(t("editor.measure.calibCurrentScaled", { val: currentScaled.toFixed(2), unit: mgr.scale.unit }))}` : ""}</div>
        <div class="scalib-input-row">
          <input type="number" id="scalib-length-input" step="any" min="0.0001" value="${currentScaled.toFixed(2)}" placeholder="${escapeHtml(t("editor.measure.calibPlaceholder"))}" />
          <select id="scalib-unit-select">
            <option value="m" ${mgr.scale.unit === "m" ? "selected" : ""}>m</option>
            <option value="cm" ${mgr.scale.unit === "cm" ? "selected" : ""}>cm</option>
            <option value="mm" ${mgr.scale.unit === "mm" ? "selected" : ""}>mm</option>
          </select>
        </div>
        <div class="scalib-note">${escapeHtml(t("editor.measure.calibNote"))}</div>
        <div class="scalib-actions">
          <button type="button" class="mini-btn" data-sact="repick">${escapeHtml(t("editor.contextBar.repickPoints"))}</button>
          <button type="button" class="primary-pill" data-sact="confirm">${escapeHtml(t("editor.measure.calibConfirm"))}</button>
        </div>
      </div>
    `;
    el.classList.remove("hidden");

    const inp = el.querySelector("#scalib-length-input");
    const sel = el.querySelector("#scalib-unit-select");
    const doConfirm = () => mgr.applyScaleCalibration(inp.value, sel.value);
    el.querySelector("[data-sact='confirm']").onclick = doConfirm;
    el.querySelector("[data-sact='repick']").onclick = () => {
      mgr.scaleCalibPoints = [];
      this.hideScaleCalibCard();
      mgr._rebuildCalibVisuals();
      mgr.renderSvgOverlay();
      mgr.onContextBarRefresh?.();
      mgr.requestRender();
    };
    el.querySelector("[data-sact='close']").onclick = () => this.hideScaleCalibCard();
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); doConfirm(); }
      if (ev.key === "Escape") { ev.preventDefault(); this.hideScaleCalibCard(); }
    });
    setTimeout(() => { try { inp.focus(); inp.select(); } catch { /* ignore */ } }, 20);
  }

  hideScaleCalibCard() {
    this.scaleCardEl?.classList.add("hidden");
  }

  renderFloatingCard(mgr) {
    const el = this.floatingCardEl;
    if (!el) return;

    const show =
      mgr._activeTool === "smartMeasure" &&
      (mgr.points.length >= 2 || mgr.pinnedItems.length > 0);

    if (!show) {
      el.classList.add("hidden");
      return;
    }

    el.style.left = `${this.cardPos.x}px`;
    el.style.top = `${this.cardPos.y}px`;
    el.classList.remove("hidden");

    const f = mgr.scale.factor;
    const u = mgr.scale.unit;
    const m = mgr.metrics;

    const unitButtons = ["m", "cm", "mm"]
      .map((uu) => `<button type="button" class="mcard-unit-btn ${u === uu ? "active" : ""}" data-munit="${uu}">${uu}</button>`)
      .join("");

    let bodyHtml = "";

    if (!mgr.closed && mgr.points.length === 2 && m) {
      const slopePctStr = Number.isFinite(m.slopePct) ? `${m.slopePct.toFixed(1)}%` : "∞";
      bodyHtml = `
        <div class="mcard-tag-row">
          <span class="mcard-badge">${escapeHtml(t("editor.measure.badgeTwoPt"))}</span>
          ${mgr.scale.calibrated ? `<span class="mcard-scale-pill">${escapeHtml(t("editor.measure.badgeCalibPill", { factor: f.toFixed(3) }))}</span>` : ""}
        </div>
        <div class="mcard-grid">
          <div class="mcard-kv hi"><span>${escapeHtml(t("editor.measure.lblStraight"))}</span><strong>${formatLength(m.straight, f, u)}</strong></div>
          <div class="mcard-kv"><span>${escapeHtml(t("editor.measure.lblHoriz"))}</span><strong>${formatLength(m.horiz, f, u)}</strong></div>
          <div class="mcard-kv"><span>${escapeHtml(t("editor.measure.lblDeltaH"))}</span><strong>${m.deltaH >= 0 ? "+" : ""}${formatLength(m.deltaH, f, u)}</strong></div>
          <div class="mcard-kv"><span>${escapeHtml(t("editor.measure.lblSlope"))}</span><strong>${m.slopeDeg.toFixed(1)}° (${slopePctStr})</strong></div>
        </div>
      `;
    } else if (!mgr.closed && mgr.points.length >= 3 && m) {
      const segRows = m.segments
        .map((seg, i) => `<div class="mcard-seg-row"><span>${escapeHtml(t("editor.measure.lblSeg", { idx: i + 1 }))}</span><strong>${formatLength(seg, f, u)}</strong></div>`)
        .join("");
      bodyHtml = `
        <div class="mcard-tag-row">
          <span class="mcard-badge">${escapeHtml(t("editor.measure.badgePolyline", { count: mgr.points.length }))}</span>
          <button type="button" class="mcard-inline-accent" data-mact="closePoly">${escapeHtml(t("editor.contextBar.closePolygon"))}</button>
        </div>
        <div class="mcard-kv hi full"><span>${escapeHtml(t("editor.measure.lblPolyTotal"))}</span><strong>${formatLength(m.total, f, u)}</strong></div>
        <div class="mcard-seg-list">${segRows}</div>
      `;
    } else if (mgr.closed && m) {
      const modeTabs = `
        <div class="mcard-mode-tabs">
          <button type="button" class="mcard-tab ${mgr.subMode === "area" ? "active" : ""}" data-mmode="area">${escapeHtml(t("editor.measure.tabArea"))}</button>
          <button type="button" class="mcard-tab ${mgr.subMode === "volume" ? "active" : ""}" data-mmode="volume">${escapeHtml(t("editor.measure.tabVolume"))}</button>
        </div>
      `;

      const smartSnapRow = `
        <div class="mcard-action-row">
          <button type="button" class="mcard-snap-btn ${mgr.snapped ? "snapped" : ""}" data-mact="smartSnap">
            ✦ ${escapeHtml(mgr.snapped ? t("editor.measure.smartSnapAgain") : t("editor.measure.smartSnapBtn"))}
          </button>
          <span class="mcard-hint-mini">${escapeHtml(t("editor.measure.snapHintMini", { count: mgr.points.length }))}</span>
        </div>
      `;

      if (mgr.subMode === "area") {
        bodyHtml = `
          ${modeTabs}
          <div class="mcard-grid">
            <div class="mcard-kv hi"><span>${escapeHtml(t("editor.measure.lblProjArea"))}</span><strong>${formatArea(m.projectedArea, f, u)}</strong></div>
            <div class="mcard-kv hi"><span>${escapeHtml(t("editor.measure.lblSurfArea"))}</span><strong>${formatArea(m.surfaceArea, f, u)}</strong></div>
            <div class="mcard-kv"><span>${escapeHtml(t("editor.measure.lblFitArea"))}</span><strong>${formatArea(m.fittedPlaneArea, f, u)}</strong></div>
            <div class="mcard-kv"><span>${escapeHtml(t("editor.measure.lblPerim"))}</span><strong>${formatLength(m.perimeter, f, u)}</strong></div>
          </div>
          ${smartSnapRow}
        `;
      } else {
        const baseBtns = this.getBaseModes().map((bm) => {
          const isAct = (bm.id === "threePoint" && mgr.pickingBasePts) || (!mgr.pickingBasePts && mgr.basePlaneMode === bm.id);
          return `<button type="button" class="mcard-chip ${isAct ? "active" : ""}" data-mbase="${bm.id}">${escapeHtml(bm.label)}</button>`;
        }).join("");

        const vizBtns = this.getVizModes().map((vm) =>
          `<button type="button" class="mcard-chip ${mgr.vizMode === vm.id ? "active" : ""}" data-mviz="${vm.id}" title="${escapeHtml(vm.tip)}">${escapeHtml(vm.label)}</button>`,
        ).join("");

        const offLabel = `${mgr.baseHeightOffset >= 0 ? "+" : ""}${formatLength(mgr.baseHeightOffset, f, u)}`;

        bodyHtml = `
          ${modeTabs}
          <div class="mcard-grid">
            <div class="mcard-kv hi full"><span>${escapeHtml(t("editor.measure.lblEstVol"))}</span><strong>${formatVolume(m.volume, f, u)}</strong></div>
            <div class="mcard-kv"><span>${escapeHtml(t("editor.measure.lblMaxH"))}${mgr.manualPeakWorld ? ` ${escapeHtml(t("editor.measure.lblManualTag"))}` : ""}</span><strong>${formatLength(m.maxHeight, f, u)}</strong></div>
            <div class="mcard-kv"><span>${escapeHtml(t("editor.measure.lblMeanH"))}</span><strong>${formatLength(m.meanHeight, f, u)}</strong></div>
            <div class="mcard-kv"><span>${escapeHtml(t("editor.measure.lblBaseArea"))}</span><strong>${formatArea(m.projectedArea, f, u)}</strong></div>
            <div class="mcard-kv"><span>${escapeHtml(t("editor.measure.lblPerim"))}</span><strong>${formatLength(m.perimeter, f, u)}</strong></div>
          </div>
          ${smartSnapRow}
          <div class="mcard-section">
            <div class="mcard-sec-head">
              <span>${escapeHtml(t("editor.measure.secBasePlane"))}</span>
              <span class="mcard-mono-mini">${escapeHtml(t("editor.measure.lblOffset", { val: offLabel }))}</span>
            </div>
            <div class="mcard-chip-row">${baseBtns}</div>
          </div>
          <div class="mcard-section">
            <div class="mcard-sec-head">
              <span>${escapeHtml(t("editor.measure.secPeakPole"))}</span>
              ${mgr.manualPeakWorld ? `<button type="button" class="mcard-link-btn" data-mact="resetPeak">${escapeHtml(t("editor.measure.btnResetPeak"))}</button>` : ""}
            </div>
            <label class="mcard-check-row">
              <input type="checkbox" id="chk-measure-noise-filter" ${mgr.noiseFilter ? "checked" : ""} />
              <span>${escapeHtml(t("editor.measure.chkNoiseFilter"))}</span>
            </label>
          </div>
          <div class="mcard-section">
            <div class="mcard-sec-head">
              <span>${escapeHtml(t("editor.measure.secVizModes"))}</span>
            </div>
            <div class="mcard-chip-row">${vizBtns}</div>
          </div>
        `;
      }
    } else {
      bodyHtml = `<div class="mcard-empty-hint">${escapeHtml(t("editor.measure.emptyHint"))}</div>`;
    }

    let pinnedHtml = "";
    if (mgr.pinnedItems.length > 0) {
      const rows = mgr.pinnedItems.map((it) => {
        let valStr = "";
        if (it.kind === "distance" && it.metrics) valStr = formatLength(it.metrics.straight, f, u);
        else if (it.kind === "polyline" && it.metrics) valStr = formatLength(it.metrics.total, f, u);
        else if (it.kind === "area" && it.metrics) valStr = formatArea(it.metrics.projectedArea, f, u);
        else if (it.kind === "volume" && it.metrics) valStr = formatVolume(it.metrics.volume, f, u);
        return `
          <div class="mcard-pin-row">
            <span class="mcard-pin-name">📌 ${escapeHtml(it.name)}</span>
            <strong class="mcard-pin-val">${valStr}</strong>
            <button type="button" class="mcard-pin-del" data-mpindel="${it.id}" title="${escapeHtml(t("editor.measure.removePinTitle"))}">✕</button>
          </div>
        `;
      }).join("");
      pinnedHtml = `
        <div class="mcard-pinned-box">
          <div class="mcard-sec-head">
            <span>${escapeHtml(t("editor.measure.pinnedHeader", { count: mgr.pinnedItems.length }))}</span>
            <button type="button" class="mcard-link-btn" data-mact="clearPins">${escapeHtml(t("editor.measure.clearPinsBtn"))}</button>
          </div>
          <div class="mcard-pin-list">${rows}</div>
        </div>
      `;
    }

    const canPinOrCopy = mgr.points.length >= 2;
    const rulerSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fdba74" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M4.5 16.5 16.5 4.5l3 3-12 12-3-3Z"/><path d="m11 10 1.8 1.8M8.3 12.7l1.8 1.8M13.7 7.3l1.8 1.8"/></svg>`;
    el.innerHTML = `
      <div class="mcard-head mcard-drag-handle" title="${escapeHtml(t("editor.measure.dragTitle"))}">
        <span class="mcard-title">${rulerSvg}${escapeHtml(t("editor.measure.cardTitle"))}</span>
        <div class="mcard-head-right">
          <div class="mcard-units">${unitButtons}</div>
          ${canPinOrCopy ? `<button type="button" class="mcard-icon-btn" data-mact="copy" title="${escapeHtml(t("editor.measure.copyTip"))}">${escapeHtml(t("editor.measure.copyBtn"))}</button>` : ""}
          ${canPinOrCopy ? `<button type="button" class="mcard-icon-btn accent" data-mact="pin" title="${escapeHtml(t("editor.measure.pinTip"))}">${escapeHtml(t("editor.measure.pinBtn"))}</button>` : ""}
          ${mgr.points.length > 0 ? `<button type="button" class="mcard-icon-btn" data-mact="clear" title="${escapeHtml(t("editor.measure.clearTip"))}">${escapeHtml(t("editor.measure.clearBtn"))}</button>` : ""}
        </div>
      </div>
      <div class="mcard-body">
        ${bodyHtml}
        ${pinnedHtml}
      </div>
    `;

    for (const b of el.querySelectorAll("[data-munit]")) {
      b.onclick = () => mgr.setUnit(b.dataset.munit);
    }
    for (const b of el.querySelectorAll("[data-mmode]")) {
      b.onclick = () => mgr.setSubMode(b.dataset.mmode);
    }
    for (const b of el.querySelectorAll("[data-mbase]")) {
      b.onclick = () => mgr.setBasePlaneMode(b.dataset.mbase);
    }
    for (const b of el.querySelectorAll("[data-mviz]")) {
      b.onclick = () => mgr.setVizMode(Number(b.dataset.mviz));
    }
    for (const b of el.querySelectorAll("[data-mpindel]")) {
      b.onclick = () => mgr.removePinnedItem(Number(b.dataset.mpindel));
    }
    const actMap = {
      copy: () => mgr.copyCurrentReport(),
      pin: () => mgr.pinCurrentMeasurement(),
      clear: () => mgr.clearActive({ keepPinned: true }),
      closePoly: () => mgr.closePolygon(),
      smartSnap: () => mgr.runSmartSnap(),
      resetPeak: () => mgr.resetManualPeak(),
      clearPins: () => mgr.clearAllPinned(),
    };
    for (const b of el.querySelectorAll("[data-mact]")) {
      b.onclick = () => actMap[b.dataset.mact]?.();
    }
    const chkNoise = el.querySelector("#chk-measure-noise-filter");
    if (chkNoise) {
      chkNoise.onchange = () => mgr.setNoiseFilter(chkNoise.checked);
    }
  }
}
