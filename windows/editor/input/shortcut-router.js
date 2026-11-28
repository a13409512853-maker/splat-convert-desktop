// Global Conflict-Free Keyboard Shortcut & Modifier Router (frozen rc12 contract).
import { t } from "../i18n.js";

export function installShortcutRouter(deps) {
  const {
    $,
    history,
    selectAllPoints,
    deselectAllPoints,
    invertSelectionPoints,
    openOverwriteSaveModal,
    openSaveAsModal,
    groupSelectedItems,
    ungroupSelectedItems,
    showAllHiddenPoints,
    toggleSplitCompare,
    startHoldCompare,
    endHoldCompare,
    openExportImageModal,
    cycleDisplayMode,
    measureMgr,
    softDeleteSelected,
    colorWheelPicker,
    getColorPickMode,
    setColorPickMode,
    setStatus,
    hideAutoAlignPrompt,
    semanticEngine,
    showSemanticOpOverlay,
    getPolyPoints,
    clearPolyPoints,
    finalizeScreenSelection,
    getActiveTool,
    setActiveTool,
    gizmo,
    updateGizmoRailActive,
    requestRender,
    fitCameraToCloud,
    adjustBrushRadius,
    isolateSelectedPoints,
    duplicateSelectedToObject,
    setGizmoMode,
    toggleColorPanel,
    hideSelectedPoints,
    splitSelectedToObject,
    toggleGrid,
    toggleBounds,
    toggleCameraControlMode,
    toggleCameraProjection,
    toggleGizmoSpaceMode,
    toggleBoundsCenter,
    syncTempModifierBoolUI,
  } = deps;

  window.addEventListener("keydown", (e) => {
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (e.key === "Escape") e.target.blur();
      return;
    }

    const k = e.key.toLowerCase();

    if (e.ctrlKey || e.metaKey) {
      if (k === "z" && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
      if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); history.redo(); return; }
      if (k === "a") { e.preventDefault(); selectAllPoints(); return; }
      if (k === "d") { e.preventDefault(); deselectAllPoints(); return; }
      if (k === "i") { e.preventDefault(); invertSelectionPoints(); return; }
      if (k === "s" && !e.shiftKey) { e.preventDefault(); openOverwriteSaveModal(); return; }
      if (k === "s" && e.shiftKey) { e.preventDefault(); openSaveAsModal(); return; }
      if (k === "g" && !e.shiftKey) { e.preventDefault(); groupSelectedItems(); return; }
      if (k === "g" && e.shiftKey) { e.preventDefault(); ungroupSelectedItems(); return; }
      return;
    }

    if (e.altKey && !e.shiftKey) {
      if (k === "h") { e.preventDefault(); showAllHiddenPoints(); return; }
      return;
    }

    if (e.key === "\\" || e.key === "|") {
      e.preventDefault();
      if (e.shiftKey) toggleSplitCompare();
      else startHoldCompare();
      return;
    }

    if (e.key === "F12") { e.preventDefault(); openExportImageModal(); return; }
    if (e.key === "Tab") { e.preventDefault(); cycleDisplayMode(); return; }

    // Safe Backspace guard: during Smart Measure point picking, ONLY undo last measure vertex!
    if (e.key === "Backspace" && measureMgr.undoLastPoint()) {
      e.preventDefault();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); softDeleteSelected(); return; }

    if (e.key === "Escape") {
      if (colorWheelPicker.isOpen) {
        colorWheelPicker.close();
        return;
      }
      if (getColorPickMode()) {
        setColorPickMode(null);
        setStatus(t("editor.status.eyedropperExited"));
        return;
      }
      if (measureMgr.handleEscape()) return;
      if (!$("auto-align-prompt")?.classList.contains("hidden")) {
        hideAutoAlignPrompt();
        return;
      }
      if (semanticEngine.isBusy) {
        semanticEngine.cancel();
        showSemanticOpOverlay({ visible: false });
        setStatus(t("editor.status.semanticEscCanceled"));
        return;
      }
      const openModals = document.querySelectorAll(".modal-backdrop:not(.hidden)");
      if (openModals.length > 0) {
        for (const m of openModals) m.classList.add("hidden");
        return;
      }
      if (getPolyPoints().length > 0) {
        clearPolyPoints();
        return;
      }
      if (getActiveTool() !== "orbit") setActiveTool("orbit");
      else if (gizmo.visible) {
        gizmo.detach();
        gizmo.visible = false;
        gizmo.enabled = false;
        updateGizmoRailActive("");
        requestRender();
      }
      return;
    }

    if (e.key === "Enter" && getActiveTool() === "smartMeasure" && !measureMgr.closed && measureMgr.points.length >= 3) {
      e.preventDefault();
      measureMgr.closePolygon();
      return;
    }
    if (e.key === "Enter" && getActiveTool() === "poly" && getPolyPoints().length >= 3) {
      e.preventDefault();
      finalizeScreenSelection("poly", getPolyPoints(), e);
      clearPolyPoints();
      return;
    }
    if (e.key === " ") { e.preventDefault(); fitCameraToCloud(true); return; }
    if (e.key === "[" && getActiveTool() === "brush") { adjustBrushRadius(-8); return; }
    if (e.key === "]" && getActiveTool() === "brush") { adjustBrushRadius(+8); return; }

    if (e.shiftKey) {
      if (k === "i") { e.preventDefault(); isolateSelectedPoints(); return; }
      if (k === "d") { e.preventDefault(); duplicateSelectedToObject(); return; }
      if (k === "t") { e.preventDefault(); setActiveTool("scaleCalib", { fromUserToggle: true }); return; }
      return;
    }

    if (k === "w") setGizmoMode("translate");
    else if (k === "e") setGizmoMode("rotate");
    else if (k === "r") setGizmoMode("scale");
    else if (k === "1") setActiveTool("orbit", { fromUserToggle: true });
    else if (k === "2") setActiveTool("rect", { fromUserToggle: true });
    else if (k === "3") setActiveTool("lasso", { fromUserToggle: true });
    else if (k === "4") setActiveTool("ellipse", { fromUserToggle: true });
    else if (k === "5") setActiveTool("poly", { fromUserToggle: true });
    else if (k === "6") setActiveTool("brush", { fromUserToggle: true });
    else if (k === "y") setActiveTool("eyedropper", { fromUserToggle: true });
    else if (k === "o") setActiveTool("opacitySel", { fromUserToggle: true });
    else if (k === "k") setActiveTool("sizeSel", { fromUserToggle: true });
    else if (k === "m") setActiveTool("semanticSel", { fromUserToggle: true });
    else if (k === "f") setActiveTool("floaterSel", { fromUserToggle: true });
    else if (k === "j") setActiveTool("planeInpaint", { fromUserToggle: true });
    else if (k === "a") setActiveTool("autoAlign");
    else if (k === "u") setActiveTool("verticalAlign", { fromUserToggle: true });
    else if (k === "l") setActiveTool("groundAlign", { fromUserToggle: true });
    else if (k === "t") setActiveTool("smartMeasure", { fromUserToggle: true });
    else if (k === "c") toggleColorPanel();
    else if (k === "h") hideSelectedPoints();
    else if (k === "p") splitSelectedToObject();
    else if (k === "g") toggleGrid();
    else if (k === "b") toggleBounds();
    else if (k === "v") toggleCameraControlMode();
    else if (k === "n") toggleCameraProjection();
    else if (k === "x") toggleGizmoSpaceMode();
    else if (k === "z") toggleBoundsCenter();
  });

  window.addEventListener("keyup", (e) => {
    syncTempModifierBoolUI(e);
    if (e.key === "\\" || e.key === "|") endHoldCompare();
  });
  window.addEventListener("blur", () => syncTempModifierBoolUI(null));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
      syncTempModifierBoolUI(e);
    }
  }, { capture: true });

  document.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest(".ctx-adv-popover, .ctx-adv-btn")) return;
    document.querySelectorAll(".ctx-adv-popover:not(.hidden)").forEach((p) => p.classList.add("hidden"));
    document.querySelectorAll(".ctx-adv-btn.active").forEach((b) => b.classList.remove("active"));
  });
}
