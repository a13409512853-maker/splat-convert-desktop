// Unified global constants, strict +Y-up coordinate contract, ReSplat ring parameters,
// unified boolean selection terminology, and conflict-free shortcut registry.

import { t } from "./i18n.js";

export const COORD_SYSTEM = "y-up";
export const RING_MODE_SIZE = 0.04; // Exact ReSplat ringSize: A in [0.96, 1.0], 2*sqrt(2)*sigma boundary
export const SH_C0 = 0.28209479177387814;

export const DEFAULT_TOOLTIP_DELAY_MS = 500;
export const DEFAULT_MAX_HISTORY_STEPS = 50;
export const MAX_SCENE_OBJECTS = 32;

// Unified boolean terminology across the entire software (Section I.3) — getter-backed for instant hot-switch!
export const BOOL_OPS = Object.freeze([
  { id: "replace", get label() { return t("editor.boolOps.replace.label"); }, get desc() { return t("editor.boolOps.replace.desc"); } },
  { id: "add", get label() { return t("editor.boolOps.add.label"); }, get desc() { return t("editor.boolOps.add.desc"); } },
  { id: "subtract", get label() { return t("editor.boolOps.subtract.label"); }, get desc() { return t("editor.boolOps.subtract.desc"); } },
  { id: "intersect", get label() { return t("editor.boolOps.intersect.label"); }, get desc() { return t("editor.boolOps.intersect.desc"); } },
]);

// Volume Group boolean operations (top-to-bottom strictly ordered evaluation, Section V.2)
export const VOLUME_BOOL_OPS = Object.freeze([
  { id: "union", get label() { return t("editor.volBoolOps.union.label"); }, get short() { return t("editor.volBoolOps.union.short"); }, symbol: "∪" },
  { id: "subtract", get label() { return t("editor.volBoolOps.subtract.label"); }, get short() { return t("editor.volBoolOps.subtract.short"); }, symbol: "−" },
  { id: "intersect", get label() { return t("editor.volBoolOps.intersect.label"); }, get short() { return t("editor.volBoolOps.intersect.short"); }, symbol: "∩" },
]);

export const DISPLAY_MODES = Object.freeze([
  { id: "splat", get label() { return t("editor.displayModes.splat"); } },
  { id: "centers", get label() { return t("editor.displayModes.centers"); } },
  { id: "rings", get label() { return t("editor.displayModes.rings"); } },
]);

// Conflict-free unified shortcuts (forced visible on every bound button via <kbd>)
export const SHORTCUTS = Object.freeze({
  undo: "Ctrl+Z",
  redo: "Ctrl+Shift+Z",
  delete: "Del",
  gizmoTranslate: "W",
  gizmoRotate: "E",
  gizmoScale: "R",

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
  planeInpaint: "J",

  autoAlign: "A",
  verticalAlign: "U",
  groundAlign: "L",
  smartMeasure: "T",
  scaleCalib: "Shift+T",

  cycleDisplay: "Tab",
  colorPanel: "C",
  compareHold: "\\",
  compareSplit: "Shift+\\",
  isolate: "Shift+I",
  hideSelected: "H",
  showAll: "Alt+H",

  selectAll: "Ctrl+A",
  deselectAll: "Ctrl+D",
  invertSelect: "Ctrl+I",
  splitObject: "P",
  duplicateObject: "Shift+D",
  groupSelected: "Ctrl+G",
  ungroupSelected: "Ctrl+Shift+G",

  toggleGrid: "G",
  toggleBounds: "B",
  toggleCameraMode: "V",
  toggleOrtho: "N",
  focusView: "Space",
  exportImage: "F12",
  saveOverwrite: "Ctrl+S",
  saveAs: "Ctrl+Shift+S",
  cancel: "Esc",
});

// Bottom-left automatic concise usage guides for every active tool (Section III.3) — getter-backed!
export const TOOL_GUIDES = Object.freeze({
  get orbit() { return t("editor.guides.orbit"); },
  get rect() { return t("editor.guides.rect"); },
  get lasso() { return t("editor.guides.lasso"); },
  get ellipse() { return t("editor.guides.ellipse"); },
  get poly() { return t("editor.guides.poly"); },
  get brush() { return t("editor.guides.brush"); },
  get eyedropper() { return t("editor.guides.eyedropper"); },
  get opacitySel() { return t("editor.guides.opacitySel"); },
  get sizeSel() { return t("editor.guides.sizeSel"); },
  get semanticSel() { return t("editor.guides.semanticSel"); },
  get planeInpaint() { return t("editor.guides.planeInpaint"); },
  get floaterSel() { return t("editor.guides.floaterSel"); },
  get volume() { return t("editor.guides.volume"); },
  get plane() { return t("editor.guides.plane"); },
  get autoAlign() { return t("editor.guides.autoAlign"); },
  get verticalAlign() { return t("editor.guides.verticalAlign"); },
  get groundAlign() { return t("editor.guides.groundAlign"); },
  get scaleCalib() { return t("editor.guides.scaleCalib"); },
  get smartMeasure() { return t("editor.guides.smartMeasure"); },
});
