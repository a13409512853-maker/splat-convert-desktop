// Info Modals (Shortcuts List, Open-Source Credits), Modal Lifecycle & Delayed Tooltip Bindings.
import { t } from "../i18n.js";

export function createInfoModalsController({ $, bindTip, closeAllMenus, displayModeDropdown }) {
  let activeInfoModalKind = null;

  function openModal(id) {
    $(id)?.classList.remove("hidden");
  }

  function closeModal(id) {
    $(id)?.classList.add("hidden");
    if (id === "modal-info") activeInfoModalKind = null;
  }

  for (const btn of document.querySelectorAll("[data-close]")) {
    btn.onclick = () => closeModal(btn.dataset.close);
  }

  function renderShortcutsModalContent() {
    $("modal-info-title").textContent = t("editor.shortcuts.title");
    const rows = [
      [t("editor.shortcuts.gizmo"), "W / E / R"],
      [t("editor.shortcuts.spaceBounds"), "X / Z"],
      [t("editor.shortcuts.undoRedo"), "Ctrl+Z / Ctrl+Shift+Z"],
      [t("editor.shortcuts.softDelete"), "Delete"],
      [t("editor.shortcuts.boolMods"), "Ctrl / Alt / Ctrl+Alt"],
      [t("editor.shortcuts.basicTools"), "1 / 2 / 3 / 4 / 5 / 6"],
      [t("editor.shortcuts.brushRadius"), "[ / ]"],
      [t("editor.shortcuts.filterTools"), "Y / O / K / M / F"],
      [t("editor.shortcuts.alignTools"), "A / U / L"],
      [t("editor.shortcuts.measureTools"), "T / Shift+T"],
      [t("editor.shortcuts.ctrlDragTools"), t("editor.shortcuts.shiftLeftDrag")],
      [t("editor.shortcuts.displayMode"), "Tab"],
      [t("editor.shortcuts.cameraMode"), "V"],
      [t("editor.shortcuts.colorPanel"), "C"],
      [t("editor.shortcuts.compareColor"), "\\ / Shift+\\"],
      [t("editor.shortcuts.visibility"), "Shift+I / H / Alt+H"],
      [t("editor.shortcuts.selOps"), "Ctrl+A / Ctrl+D / Ctrl+I"],
      [t("editor.shortcuts.splitDup"), "P / Shift+D"],
      [t("editor.shortcuts.groupUngroup"), "Ctrl+G / Ctrl+Shift+G"],
      [t("editor.shortcuts.viewHelpers"), "G / B / N / Space"],
      [t("editor.shortcuts.exportView"), "F12"],
      [t("editor.shortcuts.saveOps"), "Ctrl+S / Ctrl+Shift+S"],
    ];
    $("modal-info-body").innerHTML = `<div class="info-grid">${rows
      .map(([a, b]) => `<div class="info-row"><span>${a}</span><kbd>${b}</kbd></div>`)
      .join("")}</div>`;
  }

  function renderCreditsModalContent() {
    $("modal-info-title").textContent = t("editor.credits.title");
    $("modal-info-body").innerHTML = `
      <div class="credits-list">
        <div class="credit-item"><strong>ReSplat Editor</strong> (Copyright © 2025 Re祁 · CC BY 4.0)<br/>${t("editor.credits.resplat")}</div>
        <div class="credit-item"><strong>SuperSplat</strong> (PlayCanvas Ltd. · MIT License)<br/>${t("editor.credits.supersplat")}</div>
        <div class="credit-item"><strong>Spirula Studio</strong> (harry7557558 · GPL-3.0)<br/>${t("editor.credits.spirula")}</div>
        <div class="credit-item"><strong>PlayCanvas Splat Transform</strong> (PlayCanvas Ltd. · MIT License)<br/>${t("editor.credits.splatTransform")}</div>
        <div class="credit-item"><strong>GaussianSplatEditor</strong> (TimChen1383 · MIT License)<br/>${t("editor.credits.gse")}</div>
        <div class="credit-item"><strong>Three.js</strong> (MIT) · <strong>Meta SAM 2</strong> (Apache-2.0) · <strong>ONNX Runtime Web</strong> (MIT) · <strong>Lucide Icons</strong> (ISC)</div>
      </div>`;
  }

  $("act-show-shortcuts").onclick = () => {
    closeAllMenus();
    activeInfoModalKind = "shortcuts";
    renderShortcutsModalContent();
    openModal("modal-info");
  };

  $("act-show-credits").onclick = () => {
    closeAllMenus();
    activeInfoModalKind = "credits";
    renderCreditsModalContent();
    openModal("modal-info");
  };

  function bindAllDelayedTooltips() {
    const tipOf = (k, key, region) => ({
      title: t(`editor.tips.${k}.title`),
      tip: t(`editor.tips.${k}.tip`),
      ...(key ? { key } : {}),
      region,
    });

    bindTip($("btn-save-overwrite-top"), tipOf("saveOverwrite", "Ctrl+S", "toolbar"));
    bindTip($("btn-save-as-top"), tipOf("saveAs", "Ctrl+Shift+S", "toolbar"));
    bindTip($("menu-chk-bounds-wrap"), tipOf("menuBounds", "B", "toolbar"));
    bindTip($("menu-chk-grid-wrap"), tipOf("menuGrid", "G", "toolbar"));

    bindTip($("btn-color-panel"), tipOf("colorPanel", "C", "toolbar"));
    bindTip($("btn-isolate-top"), tipOf("isolate", "Shift+I", "toolbar"));
    bindTip($("btn-hide-top"), tipOf("hide", "H", "toolbar"));
    bindTip($("btn-showall-top"), tipOf("showAll", "Alt+H", "toolbar"));
    bindTip($("btn-bounds-top"), tipOf("boundsTop", "B", "toolbar"));
    bindTip($("btn-grid-top"), tipOf("gridTop", "G", "toolbar"));
    bindTip($("btn-export-img-top"), tipOf("exportImgTop", "F12", "toolbar"));
    bindTip(displayModeDropdown.trigger, tipOf("displayMode", "Tab", "toolbar"));
    bindTip($("btn-cam-orbit"), tipOf("camOrbit", "V", "toolbar"));
    bindTip($("btn-cam-fly"), tipOf("camFly", "V", "toolbar"));
    bindTip($("fly-speed-bar"), tipOf("flySpeed", null, "toolbar"));

    const railTipKeys = {
      orbit: "1",
      rect: "2",
      lasso: "3",
      ellipse: "4",
      poly: "5",
      brush: "6",
      eyedropper: "Y",
      opacitySel: "O",
      sizeSel: "K",
      semanticSel: "M",
      floaterSel: "F",
      autoAlign: "A",
      verticalAlign: "U",
      groundAlign: "L",
      scaleCalib: "Shift+T",
      smartMeasure: "T",
    };
    for (const [tool, key] of Object.entries(railTipKeys)) {
      const el = document.querySelector(`#left-rail [data-tool="${tool}"]`);
      if (el) bindTip(el, tipOf(tool, key, "toolbar"));
    }
    bindTip($("btn-flyout-filter"), tipOf("flyoutFilter", null, "toolbar"));
    bindTip($("btn-flyout-align"), tipOf("flyoutAlign", null, "toolbar"));
    bindTip($("btn-flyout-measure"), tipOf("flyoutMeasure", null, "toolbar"));
    bindTip($("btn-undo"), tipOf("undo", "Ctrl+Z", "toolbar"));
    bindTip($("btn-redo"), tipOf("redo", "Ctrl+Shift+Z", "toolbar"));
    for (const [mode, tipKey, k] of [
      ["translate", "gizmoTranslate", "W"],
      ["rotate", "gizmoRotate", "E"],
      ["scale", "gizmoScale", "R"],
    ]) {
      const el = document.querySelector(`#top-gizmo-cluster [data-gizmo="${mode}"]`);
      if (el) bindTip(el, tipOf(tipKey, k, "toolbar"));
    }

    bindTip($("btn-flyout-smart"), tipOf("flyoutSmart", null, "toolbar"));
    const inpBtn = document.querySelector('#left-rail [data-tool="planeInpaint"]');
    if (inpBtn) bindTip(inpBtn, tipOf("planeInpaint", "J", "toolbar"));

    bindTip($("btn-local-space"), tipOf("localSpace", "X", "toolbar"));
    bindTip($("btn-bounds-center"), tipOf("boundsCenter", "Z", "toolbar"));
    bindTip($("btn-pivot-edit"), tipOf("pivotEdit", null, "scene"));
    bindTip($("btn-scale-lock"), tipOf("scaleLock", null, "scene"));
    bindTip($("btn-reset-pos"), tipOf("resetPos", null, "scene"));
    bindTip($("btn-reset-rot"), tipOf("resetRot", null, "scene"));
    bindTip($("btn-reset-scale"), tipOf("resetScale", null, "scene"));
    bindTip($("btn-clear-obj-sel"), tipOf("clearObjSel", null, "scene"));
    bindTip($("btn-expand-objects"), tipOf("expandObjects", null, "scene"));
    bindTip($("btn-expand-volumes"), tipOf("expandVolumes", null, "scene"));
    bindTip($("btn-history-toggle"), tipOf("historyToggle", null, "scene"));
    bindTip($("btn-group-selected"), tipOf("groupBtn", "Ctrl+G", "scene"));
    bindTip($("btn-ungroup-selected"), tipOf("ungroupBtn", "Ctrl+Shift+G", "scene"));
    bindTip($("btn-add-vol-menu"), tipOf("addVolBtn", null, "scene"));
    bindTip($("transform-card"), tipOf("transformCard", null, "scene"));

    bindTip($("histogram-canvas"), tipOf("histogram", null, "color"));
    bindTip($("btn-compare-hold"), tipOf("compareHold", "\\", "color"));
    bindTip($("btn-compare-split"), tipOf("compareSplit", "Shift+\\", "color"));

    bindTip($("img-transparent"), tipOf("imgTransparent", null, "modals"));
    bindTip($("img-hide-helpers"), tipOf("imgHideHelpers", null, "modals"));
  }

  function refreshActiveInfoModal() {
    if (activeInfoModalKind === "shortcuts") renderShortcutsModalContent();
    else if (activeInfoModalKind === "credits") renderCreditsModalContent();
  }

  return {
    openModal,
    closeModal,
    renderShortcutsModalContent,
    renderCreditsModalContent,
    refreshActiveInfoModal,
    bindAllDelayedTooltips,
  };
}
