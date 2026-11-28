// Complete +Y-Up 3D Gaussian Splatting Editor Orchestrator (v3.2.3)
// Integrates:
// - WebGL2 Instanced-Quad 3DGS Cloud (Points / 100% Lossless Splat / ReSplat Rings) + Async Sort Worker
// - Multi-Object & Group Scene Graph with O(1) GPU per-object 4x4 transforms
// - Spirula 6-face Colored Drag Handles (occlusion dimming + Shift symmetric stretch) + Ordered Boolean Volume Groups + Infinite Occlusion Plane
// - Basic & Special Selections (GPU ID Pick visible-only, ReSplat whole-Gaussian ring boundary, lazy SAM2 ONNX + 3D region-grow)
// - Full ReSplat Color Grading + 8-Band HSL + 3D LUT + Histogram + Fragment-Exact Split Compare + Pointer-Up History + SH Bake
// - +Y-Up Alignment Suite (Auto-Align / Vertical / 3-Point Ground / OpenCV->Y-Up / Measure)
// - Dual-Stack Bottom Context Bars, Delayed Global Tooltips, Forced Shortcut Badges, Hang Watchdog + Zero-Loss Replay
// - Non-Destructive Overwrite Save (v3 Recipe) & Crash-Safe Multi-Mode Save As + Bit-Exact PNG View Export
import * as T from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { TransformControls } from "./vendor/TransformControls.js";
import {
  BOOL_OPS,
  VOLUME_BOOL_OPS,
  SHORTCUTS,
  TOOL_GUIDES,
  DEFAULT_TOOLTIP_DELAY_MS,
  DEFAULT_MAX_HISTORY_STEPS,
  MAX_SCENE_OBJECTS,
} from "./constants.js";
import {
  HistoryManager,
  diffUint8Arrays,
  applyUint8Delta,
  encodeIndexRanges,
  decodeIndexRanges,
} from "./history.js";
import { DelayedTooltipManager, bindTip } from "./tooltip.js";
import { Cloud, FLAG_SELECTED, FLAG_DELETED, FLAG_HIDDEN } from "./cloud.js";
import { VolumeManager } from "./volumes.js";
import { compileGroupCsgProgram, evaluateCsgProgramCpu } from "./csg.js";
import {
  createDefaultGrade,
  cloneGrade,
  isGradeModified,
  gradesEqual,
  HSL_BANDS,
  drawHistogram,
  rgb2hsl,
  computeWhiteBalanceFromRgb,
  findNearestHslBand,
} from "./color-grade.js";
import { ColorPanelController } from "./ui/color-panel.js";
import {
  applyBooleanSelection,
  runScreenSelection,
  runEyedropperSelection,
  runOpacitySelection,
  runSizeSelection,
  runFloaterSelection,
} from "./selection.js";
import { SemanticBoxEngine } from "./semantic/semantic-engine.js";
import { PlaneInpaintEngine } from "./smart/plane-inpaint.js";
import { MeasureManager } from "./measure/measure-manager.js";
import { PerfHudController } from "./ui/perf-hud.js";
import { AdvancedMenuController } from "./ui/advanced-menu.js";
import {
  computeVerticalAlignment,
  computeGroundAlignment,
  detectTiltedSceneCandidate,
} from "./alignment.js";
import { HangWatchdog } from "./watchdog.js";
import { LoadingIndicatorController } from "./ui/loading-indicator.js";
import { AxisGizmoWidget } from "./ui/axis-gizmo.js";
import { ToolRailController } from "./ui/tool-rail.js";
import { ViewportContextMenu } from "./ui/context-menu.js";
import { createCustomSelect, closeAllCustomDropdowns } from "./ui/dropdown.js";
import { InfiniteGroundGrid, ModelCornerBounds } from "./ui/viewport-helpers.js";
import { DualCameraController } from "./ui/camera-controller.js";
import { installGlobalNumericScrub, installGlobalSliderInlineInputs } from "./ui/numeric-controls.js";
import { ColorWheelPicker, rgb255ToHex } from "./ui/color-wheel-picker.js";
import { ContextBarHost } from "./ui/context-bar-host.js";
import { installExportImageModal } from "./ui/export-image-modal.js";
import { createInfoModalsController } from "./ui/info-modals.js";
import { installShortcutRouter } from "./input/shortcut-router.js";
import { createAlignmentController } from "./controllers/alignment-controller.js";
import { postHost, typedArrayToB64, b64ToUint8, parseCloudBinaryBuffer } from "./bridge/host-bridge.js";
import { EditSession } from "./domain/edit-session.mjs";
import { BoxSelectTool } from "./domain/box-select-tool.mjs";
import { ThreePreviewAdapter } from "./domain/three-preview-adapter.mjs";
import {
  inspectRecipeCompatibility,
  decodeRecipeIntoSession,
  encodeProjectRecipe,
} from "./domain/recipe-codec.mjs";
import { setDomainTranslator } from "./domain/contracts.mjs";
import { initI18n, setLanguage, getLanguage, onLanguageChange, t } from "./i18n.js";

setDomainTranslator(t);

const $ = (id) => document.getElementById(id);

// Modular UI Controllers (decoupled & interface-driven for long-term maintenance)
const loadingUI = new LoadingIndicatorController({
  overlayEl: $("loading-overlay"),
  titleEl: $("loading-title"),
  stageEl: $("loading-stage"),
  pctEl: $("loading-pct"),
  barFillEl: $("loading-bar-fill"),
  etaEl: $("loading-eta"),
  etaThresholdMs: 10000,
});

// ============================================================================
// 1. Global State & Managers
// ============================================================================
const tooltipMgr = new DelayedTooltipManager(DEFAULT_TOOLTIP_DELAY_MS);
const semanticEngine = new SemanticBoxEngine();
const planeInpaintEngine = new PlaneInpaintEngine();

let cloud = null;
let editSession = null;
let previewAdapter = null;
let boxSelectTool = null;
let currentAssetId = "primary";
let currentAssetSha256 = "";
let hostBootInfo = {
  editorKind: "native-owned",
  editorEntry: "index.html",
  assetsHash: "",
  version: "3.2.3",
};
let lastRecipeCompat = null;
let totalSourcePoints = 0;
let loadedSourcePoints = 0;
let lastDeletedPointsCount = 0;
let currentFileName = "scene.ply";
let displayMode = "splat"; // "splat" | "centers" | "rings" (ReSplat Fig 6)
let cameraControlMode = "orbit"; // "orbit" | "fly" (ReSplat Fig 5)
let lowPerfSafeMode = false; // Emergency Centers-Mode: ONLY basic select + soft delete + undo/save; freezes ALL advanced/AI tools!
const SAFE_MODE_FROZEN_TOOLS = new Set([
  "eyedropper",
  "opacitySel",
  "sizeSel",
  "semanticSel",
  "floaterSel",
  "planeInpaint",
  "autoAlign",
  "verticalAlign",
  "groundAlign",
  "scaleCalib",
  "smartMeasure",
]);
const BASIC_EXCLUSIVE_TOOLS = new Set(["rect", "lasso", "ellipse", "poly", "brush"]);
const STATEFUL_BOOL_TOOLS = new Set(["rect", "lasso", "ellipse", "poly", "brush", "eyedropper", "semanticSel"]);
const PARAM_BAR_TOOLS = new Set(["opacitySel", "sizeSel", "floaterSel"]);
const SHIFT_BOX_TOOLS = new Set(["semanticSel", "planeInpaint"]);
const CANVAS_DRAG_TOOLS = new Set(["rect", "lasso", "ellipse", "brush"]);
const SPATIAL_PICK_TOOLS = new Set(["verticalAlign", "groundAlign", "scaleCalib", "smartMeasure"]);

let lastRenderCostMs = 0;
let lastSceneRadius = 6.0;
let isInteracting = false;
let activeTool = "orbit";
let browseCoexistActive = true; // B5: Browse (1) is ONLY mutually exclusive with 2-6; can coexist with Filter/Smart/Align!
let orbitExplicitlyOff = false; // rc8 #1: pressing 1 again in pure Browse exits Browse & hides gizmo; double-click re-activates!
let activeBoolOp = "replace";     // Standing selection mode for 2-6, Y, M (reset to "replace" on tool open!)
let gizmoMode = "translate";
let gizmoSpace = "world";       // #12: "world" | "local"
let useBoundsCenter = false;    // #12: snap gizmo pivot to current OBB center; restore previous pivot on OFF
let savedPivotBeforeBoundsCenter = null;
let pivotEditMode = false;      // #2: move ONLY gizmo pivot without moving model
let prevGizmoModeBeforePivotEdit = "translate";
let soloState = null;           // #3: { kind: "object" | "group", targetId, prevVis: Map<id, boolean> }
let historyExpanded = false;    // #1: default collapsed showing latest 3 steps
let objectsListExpanded = false;
let volumesListExpanded = false;
let dragCtx = null;             // #5: { domain: "object" | "volume", id }
let onlyVisible = false;
let wholeGaussian = false;
let brushRadiusPx = 24;
let scaleLocked = false;
let gridVisible = true;
let boundsVisible = true;
let encoderPreset = null;
let bundledExtractResolver = null;
let cachedBoundsDepthTex = null;
let cachedBoundsDepthCamSig = "";
let boundsDepthTimer = null;

function isEffectiveBrowse() {
  return activeTool === "orbit" || (browseCoexistActive && !BASIC_EXCLUSIVE_TOOLS.has(activeTool));
}

// Multi-Object Scene Graph (each object has its own THREE.Object3D for independent transforms!)
const scene = new T.Scene();
const objectRoot = new T.Group();
objectRoot.name = "ObjectsRoot";
scene.add(objectRoot);

let nextObjId = 1;
let nextObjGroupId = 1;
const sceneObjects = [];      // [{ id, name, visible, groupId, sourceKind, node, bakedGrades: [] }]
const sceneObjectGroups = []; // [{ id, name, node, memberIds: [] }]
const selectedObjectIds = new Set([0]);
let activeObjectGroupId = null;
const selectedVolumeIds = new Set();
let activeVolumeOrGroupId = null;

function initDefaultSceneObject() {
  while (objectRoot.children.length > 0) objectRoot.remove(objectRoot.children[0]);
  sceneObjects.length = 0;
  sceneObjectGroups.length = 0;
  selectedObjectIds.clear();
  activeObjectGroupId = null;
  nextObjId = 1;
  nextObjGroupId = 1;

  const mainNode = new T.Object3D();
  mainNode.name = "obj_0";
  objectRoot.add(mainNode);
  sceneObjects.push({
    id: 0,
    name: t("editor.scene.mainCloud"),
    isDefaultMainName: true,
    visible: true,
    groupId: null,
    sourceKind: "original",
    node: mainNode,
    bakedGrades: [],
  });
  selectedObjectIds.add(0);
}
initDefaultSceneObject();

// Color grading state (temporary live GPU preview until baked via Apply / tool switch / clear selection)
let liveGrade = createDefaultGrade();
let colorPanelUI = null;
let colorPickMode = null; // null | "wb" | "hsl" | "picker"
let pickerEyedropCallback = null;
let hslDragCtx = null;    // active Lightroom TAT screen-drag state
const colorWheelPicker = new ColorWheelPicker();
installGlobalNumericScrub(document.body);
installGlobalSliderInlineInputs(document.body);
let compareOriginalHold = false;
let splitCompareActive = false;
let splitCompareX = 0.5;
let colorPanelOpen = false;
const lutCache = new Map(); // filename -> { tex, rgba }

// Alignment, spatial hover guide & smooth damped transform animation state (rc8 #3 & #6)
let alignPoints = [];
let alignFlipped = false;
let alignAppliedState = null; // { tool: "verticalAlign" | "groundAlign", pivot: THREE.Vector3 }
let hoverPickPoint = null;    // { idx, worldPos, clientX, clientY }
let lastPointerClient = { x: -9999, y: -9999, inside: false };
let alignCtrl = null;
let infoModalsCtrl = null;
let exportImageCtrl = null;
let autoAlignPromptCheckTimer = null;
let lastTiltDetection = null;

// Special selection & smart tools params
const specialParams = {
  eyedropper: { rgb: [0.5, 0.5, 0.5], hasPicked: false, tolerance: 0.14, colorSpace: "rgb" },
  opacitySel: { min: 0.0, max: 0.15 },
  sizeSel: { min: 0.0, max: 0.5, mode: "max" },
  semanticSel: {
    mode: "auto",         // "auto" | "2d" | "3d"
    depthMode: "surface", // "surface" | "through"
    throughDepth: 0.8,    // meters behind visible front surface
    infiniteDepth: false,
    silent3D: true,
    viewCount3D: 6,
  },
  floaterSel: { voxelSize: 0.12, maxNeighbors: 5, maxOpacity: 0.95 },
  planeInpaint: {
    mode: "L2",           // "L0" | "L1" | "L2" (default L2)
    solidColorRgb: [196, 196, 196],
    edgeFeather: 0.18,
  },
};

// Configurable Performance HUD (default: FPS + GPU + CPU)
const perfHud = new PerfHudController({
  el: $("bottom-right-perf"),
  getSceneInfo: () => ({
    activePoints: cloud ? Math.max(0, cloud.n - lastDeletedPointsCount) : 0,
    totalPoints: cloud ? cloud.n : 0,
    displayMode,
  }),
});

// 3rd-Level Advanced Menu Controller (Tools Advanced Options & Perf HUD Settings)
const advancedMenuUI = new AdvancedMenuController({
  menuPopupEl: $("menu-advanced"),
  perfHud,
  bindTip,
  postHost,
  onSemanticPrefsChange: (p) => {
    specialParams.semanticSel.silent3D = !!p.silent3D;
    specialParams.semanticSel.viewCount3D = Number(p.viewCount3D) || 6;
  },
  onModelSelected: () => {
    if (activeTool === "semanticSel") showSpecialSelectionContextBar("semanticSel");
  },
});
Object.assign(specialParams.semanticSel, advancedMenuUI.getPrefs());

// Telemetry & Recovery
let lastTelemetryText = "GPU --%  -- GB/ --GB     |    CPU --%   -- GB/ --GB";
let isReplaying = false;

// ============================================================================
// 2. Three.js WebGL2 Strict +Y-Up Scene, Cameras, Grid, Gizmo & Volume Manager
// ============================================================================
const canvas = $("canvas");
const stage = $("viewport-stage");
const overlaySvg = $("overlay");
const renderer = new T.WebGLRenderer({
  canvas,
  antialias: false, // Gaussian splats are analytically smooth; disabling 4x MSAA saves ~4x ROP bandwidth!
  alpha: true,
  preserveDrawingBuffer: false, // Restores D3D11 zero-copy flip swapchain; PNG export uses offscreen RT!
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setClearColor(0x15171b, 1);

// Strict global +Y-up cameras
const perspCam = new T.PerspectiveCamera(50, 1, 0.002, 1e6);
perspCam.up.set(0, 1, 0);
perspCam.position.set(3.2, 2.6, 4.2);
const orthoCam = new T.OrthographicCamera(-5, 5, 5, -5, 0.002, 1e6);
orthoCam.up.set(0, 1, 0);
let camera = perspCam;

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.14;
orbit.enableZoom = false; // Handled by DualCameraController silky exponential wheel zoom
orbit.screenSpacePanning = true;
orbit.maxPolarAngle = Math.PI - 0.002;
orbit.minPolarAngle = 0.002;

// Infinite analytical +Y-up ground grid (Y = 0) & ReSplat 8-corner L-bracket bounds (Fig 7)
const infiniteGrid = new InfiniteGroundGrid();
scene.add(infiniteGrid);

const modelBounds = new ModelCornerBounds();
scene.add(modelBounds);

// Dual Camera Controller (Smooth Damped Orbit + Fly + Quintic Pose Flights)
const camCtrl = new DualCameraController({
  canvas,
  orbit,
  getCamera: () => camera,
  canNavigate: () => !colorPickMode && !["rect", "lasso", "ellipse", "poly", "brush"].includes(activeTool),
  isGizmoBusy: () => !!(gizmo?.dragging || activeHandleDrag || measureMgr?.activeDrag),
  onRender: (forceSort) => requestRender(forceSort),
  onInteractChange: (interacting) => {
    isInteracting = interacting;
  },
  onModeChange: (m) => {
    cameraControlMode = m;
    syncCameraModeButtons();
  },
});

// Markers group for alignment / measure / semantic prompt spheres
const markersGroup = new T.Group();
scene.add(markersGroup);

// Volume Manager (Box, Ellipsoid, +Y Cylinder, Infinite Plane + 6-face handles + Boolean Groups)
const volumeMgr = new VolumeManager(scene);

// Pivot & 3D TransformControls Gizmo
const pivot = new T.Object3D();
scene.add(pivot);
const gizmo = new TransformControls(camera, canvas);
gizmo.setSize(0.85);
gizmo.visible = false;
gizmo.enabled = false;
scene.add(gizmo);

let gizmoStartSnap = null;
let gizmoStartPivotInv = new T.Matrix4();
let gizmoStartPivotPos = new T.Vector3();
let gizmoStartPivotQuat = new T.Quaternion();
let gizmoStartPivotQuatInv = new T.Quaternion();
let gizmoStartNodeRecords = new Map(); // THREE.Object3D -> { startWorldMat, startWorldPos, startWorldQuat, startWorldScale, startLocalPos, startLocalQuat, startLocalScale }
let lastCanvasPointerCtrl = false;
let gizmoCtrlDupCtx = null; // Tracks Ctrl+Drag Translate duplicate-move context

function syncPivotOrientationForSpace() {
  pivot.scale.set(1, 1, 1);
  if (gizmoSpace === "local") {
    const primary = getPrimaryTransformNode();
    if (primary) {
      primary.updateMatrixWorld(true);
      primary.getWorldQuaternion(pivot.quaternion);
    } else {
      pivot.quaternion.identity();
    }
  } else {
    pivot.quaternion.identity();
  }
  pivot.updateMatrixWorld(true);
}

gizmo.addEventListener("dragging-changed", (e) => {
  camCtrl.syncOrbitEnabled(!e.value);
  isInteracting = e.value;
  if (e.value) {
    gizmoCtrlDupCtx = null;
    if (pivotEditMode && gizmo.object === pivot) {
      // #2 Pivot Edit Mode: dragging gizmo ONLY repositions pivot without touching model!
      gizmoStartSnap = null;
      gizmoStartNodeRecords.clear();
    } else {
      // rc11 #3.4: Ctrl + Drag Translate Gizmo executes Duplicate & Move for Objects or Volumes!
      if (lastCanvasPointerCtrl && gizmoMode === "translate") {
        if (activeVolumeOrGroupId) {
          const beforeVolSnap = volumeMgr.exportSnapshot();
          const srcNode = volumeMgr.getNode(activeVolumeOrGroupId);
          const parentGid = srcNode ? volumeMgr.getParentGroupId(srcNode) : null;
          const dupVol = srcNode ? volumeMgr.duplicateNode(srcNode.id, parentGid, -1) : null;
          if (dupVol) {
            selectedVolumeIds.clear();
            selectedVolumeIds.add(dupVol.id);
            activeVolumeOrGroupId = dupVol.id;
            gizmo.object = dupVol.root;
            volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
            renderSceneManager();
            gizmoCtrlDupCtx = { kind: "volume", beforeVolSnap, dupName: dupVol.name };
          }
        } else if (cloud) {
          const srcObjs = getEffectiveSelectedObjectIds();
          const targetObjIds = srcObjs.size > 0
            ? Array.from(srcObjs)
            : sceneObjects[0] ? [sceneObjects[0].id] : [];
          const firstObjId = targetObjIds[0];
          if (firstObjId != null) {
            const dupRes = duplicateSceneObjectToTarget(firstObjId, null, sceneObjects.length, { recordHistory: false });
            if (dupRes) {
              gizmoCtrlDupCtx = { kind: "object", dupRes };
            }
          }
        }
      }

      gizmoStartSnap = captureTransformSnapshot();
      if (gizmo.object === pivot) {
        syncPivotOrientationForSpace();
        pivot.updateMatrixWorld(true);
        gizmoStartPivotInv.copy(pivot.matrixWorld).invert();
        gizmoStartPivotPos.copy(pivot.position);
        gizmoStartPivotQuat.copy(pivot.quaternion);
        gizmoStartPivotQuatInv.copy(pivot.quaternion).invert();
      }
      gizmoStartNodeRecords.clear();
      for (const node of getActiveTransformNodes()) {
        node.updateMatrixWorld(true);
        const wp = new T.Vector3();
        const wq = new T.Quaternion();
        const ws = new T.Vector3();
        node.matrixWorld.decompose(wp, wq, ws);
        gizmoStartNodeRecords.set(node, {
          startWorldMat: node.matrixWorld.clone(),
          startWorldPos: wp,
          startWorldQuat: wq,
          startWorldScale: ws,
          startLocalPos: node.position.clone(),
          startLocalQuat: node.quaternion.clone(),
          startLocalScale: node.scale.clone(),
        });
      }
    }
  } else if (gizmoStartSnap) {
    const after = captureTransformSnapshot();
    const dupCtx = gizmoCtrlDupCtx;
    gizmoCtrlDupCtx = null;

    if (dupCtx && dupCtx.kind === "volume") {
      const afterVolSnap = volumeMgr.exportSnapshot();
      pushVolumeHistory(t("editor.history.dupMoveVol", { name: dupCtx.dupName }), dupCtx.beforeVolSnap, afterVolSnap);
    } else if (dupCtx && dupCtx.kind === "object") {
      const { newObj, newNode, oldN, prevFlags, savedIndices, targetGroupId, insertIdx, prevSelIds, prevActiveGroupId } = dupCtx.dupRes;
      const afterTransform = captureTransformSnapshot();
      history.push({
        label: t("editor.history.dupMoveObj", { name: newObj.name }),
        groupKey: "transform:translate",
        groupLabel: t("editor.history.groupTranslate"),
        undo: () => {
          cloud.truncatePoints(oldN);
          cloud.flags.set(prevFlags);
          if (newObj.groupId) {
            const g = sceneObjectGroups.find((x) => x.id === newObj.groupId);
            if (g) {
              const mi = g.memberIds.indexOf(newObj.id);
              if (mi >= 0) g.memberIds.splice(mi, 1);
            }
          }
          const pos = sceneObjects.indexOf(newObj);
          if (pos >= 0) sceneObjects.splice(pos, 1);
          if (newNode.parent) newNode.parent.remove(newNode);
          selectedObjectIds.clear();
          for (const id of prevSelIds) selectedObjectIds.add(id);
          activeObjectGroupId = prevActiveGroupId;
          modelBounds.recomputeLocalBoxes(cloud);
          syncObjectMatrices(true);
          updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
          renderSceneManager();
          syncTransformInputs();
          requestRender(true);
        },
        redo: () => {
          cloud.duplicatePoints(savedIndices, newObj.id, { selectNew: false });
          if (targetGroupId) {
            const g = sceneObjectGroups.find((x) => x.id === targetGroupId);
            if (g) {
              g.node.add(newNode);
              newObj.groupId = g.id;
              if (!g.memberIds.includes(newObj.id)) g.memberIds.push(newObj.id);
            } else {
              objectRoot.add(newNode);
              newObj.groupId = null;
            }
          } else {
            objectRoot.add(newNode);
          }
          if (!sceneObjects.includes(newObj)) {
            sceneObjects.splice(Math.min(insertIdx, sceneObjects.length), 0, newObj);
          }
          selectedObjectIds.clear();
          selectedObjectIds.add(newObj.id);
          activeObjectGroupId = null;
          applyTransformSnapshot(afterTransform);
          modelBounds.recomputeLocalBoxes(cloud);
          syncObjectMatrices(true);
          updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
          renderSceneManager();
          syncTransformInputs();
          requestRender(true);
        },
      });
    } else if (!transformsEqual(gizmoStartSnap, after)) {
      const before = gizmoStartSnap;
      const modeNow = gizmoMode;
      const modeLabel =
        modeNow === "translate"
          ? t("editor.transform.modeTranslate")
          : modeNow === "rotate"
            ? t("editor.transform.modeRotate")
            : t("editor.transform.modeScale");
      const grpLbl =
        modeNow === "translate"
          ? t("editor.history.groupTranslate")
          : modeNow === "rotate"
            ? t("editor.history.groupRotate")
            : t("editor.history.groupScale");
      history.push({
        label: t("editor.history.transformMode", { mode: modeLabel }),
        groupKey: `transform:${modeNow}`,
        groupLabel: grpLbl,
        undo: () => {
          applyTransformSnapshot(before);
          syncTransformInputs();
          volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
          requestRender(true);
        },
        redo: () => {
          applyTransformSnapshot(after);
          syncTransformInputs();
          volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
          requestRender(true);
        },
        journalEntry: { type: "transform", snapshot: after },
      });
    }
    gizmoStartSnap = null;
    gizmoStartNodeRecords.clear();
    // Always reset pivot scale to (1,1,1) and re-sync orientation after drag so consecutive scale drags start clean!
    if (gizmo.object === pivot) {
      syncPivotOrientationForSpace();
    }
    syncObjectMatrices(true); // rc8 #2A: exact tight full-point World AABB on gizmo drag end!
    if (useBoundsCenter) syncPivotToBoundsCenter();
  }
  requestRender(!e.value);
});

gizmo.addEventListener("objectChange", () => {
  if (!gizmo.object) return;
  if (gizmo.object === pivot) {
    if (pivotEditMode) {
      // #2 Pivot Edit Mode: only reposition pivot, leave model untouched!
      requestRender();
      return;
    }
    pivot.updateMatrixWorld(true);

    if (gizmoMode === "scale") {
      // rc11 Bug Fix: Shear-free, flip-free, rotation-safe scale around pivot!
      // NEVER calls Matrix4.decompose on a sheared or negative-determinant matrix!
      let sx = Math.max(0.02, Math.min(100.0, Number.isFinite(pivot.scale.x) ? pivot.scale.x : 1));
      let sy = Math.max(0.02, Math.min(100.0, Number.isFinite(pivot.scale.y) ? pivot.scale.y : 1));
      let sz = Math.max(0.02, Math.min(100.0, Number.isFinite(pivot.scale.z) ? pivot.scale.z : 1));
      if (scaleLocked) {
        const ax = gizmo.axis || "";
        let u = sx;
        if (ax === "Y") u = sy;
        else if (ax === "Z") u = sz;
        else if (ax !== "X") u = Math.cbrt(sx * sy * sz);
        sx = sy = sz = u;
        pivot.scale.set(u, u, u);
      }

      const relOffset = new T.Vector3();
      const nextWorldPos = new T.Vector3();
      const parentInv = new T.Matrix4();
      const qNodeToPivot = new T.Quaternion();
      const basisVec = new T.Vector3();

      for (const [node, rec] of gizmoStartNodeRecords.entries()) {
        // 1. Lock quaternion strictly to drag start (ZERO 180-deg flip, ZERO shear rotation corruption!)
        node.quaternion.copy(rec.startLocalQuat);

        // 2. Scale world-space position offset cleanly around pivot in pivot's coordinate frame
        relOffset.copy(rec.startWorldPos).sub(gizmoStartPivotPos).applyQuaternion(gizmoStartPivotQuatInv);
        relOffset.set(relOffset.x * sx, relOffset.y * sy, relOffset.z * sz);
        nextWorldPos.copy(relOffset).applyQuaternion(gizmoStartPivotQuat).add(gizmoStartPivotPos);
        if (node.parent) {
          node.parent.updateMatrixWorld(true);
          parentInv.copy(node.parent.matrixWorld).invert();
          node.position.copy(nextWorldPos).applyMatrix4(parentInv);
        } else {
          node.position.copy(nextWorldPos);
        }

        // 3. Map pivot-frame scale factors cleanly onto node's local X/Y/Z axes without shear!
        // qNodeToPivot transforms node's local unit axis into pivot's scale frame:
        qNodeToPivot.copy(gizmoStartPivotQuatInv).multiply(rec.startWorldQuat);

        basisVec.set(1, 0, 0).applyQuaternion(qNodeToPivot);
        const fx = Math.hypot(basisVec.x * sx, basisVec.y * sy, basisVec.z * sz);
        basisVec.set(0, 1, 0).applyQuaternion(qNodeToPivot);
        const fy = Math.hypot(basisVec.x * sx, basisVec.y * sy, basisVec.z * sz);
        basisVec.set(0, 0, 1).applyQuaternion(qNodeToPivot);
        const fz = Math.hypot(basisVec.x * sx, basisVec.y * sy, basisVec.z * sz);

        node.scale.set(
          Math.max(0.002, rec.startLocalScale.x * fx),
          Math.max(0.002, rec.startLocalScale.y * fy),
          Math.max(0.002, rec.startLocalScale.z * fz),
        );
      }
    } else {
      // Translate / Rotate: strictly orthogonal rigid motion (preserve exact startLocalScale!)
      const delta = new T.Matrix4().multiplyMatrices(pivot.matrixWorld, gizmoStartPivotInv);
      const parentInv = new T.Matrix4();
      const nextWorld = new T.Matrix4();
      const nextLocal = new T.Matrix4();
      const tmpScale = new T.Vector3();
      for (const [node, rec] of gizmoStartNodeRecords.entries()) {
        nextWorld.multiplyMatrices(delta, rec.startWorldMat);
        if (node.parent) {
          node.parent.updateMatrixWorld(true);
          parentInv.copy(node.parent.matrixWorld).invert();
          nextLocal.multiplyMatrices(parentInv, nextWorld);
        } else {
          nextLocal.copy(nextWorld);
        }
        nextLocal.decompose(node.position, node.quaternion, tmpScale);
        node.scale.copy(rec.startLocalScale);
      }
    }
  } else if (gizmoMode === "scale" && scaleLocked && gizmo.object) {
    const s = gizmo.object.scale;
    const ax = gizmo.axis || "";
    let u = s.x;
    if (ax === "Y") u = s.y;
    else if (ax === "Z") u = s.z;
    else if (ax !== "X") u = Math.cbrt(Math.max(1e-6, s.x * s.y * s.z));
    u = Math.max(0.005, u);
    gizmo.object.scale.set(u, u, u);
  }
  if (activeVolumeOrGroupId) {
    volumeMgr.updateAllHandleScales(camera);
    volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
  }
  syncObjectMatrices();
  syncTransformInputs();
  requestRender();
});

// History Manager (Delta/Command pattern + Auto-Grouping of >=3 consecutive repeated ops, rc11 #5 / rc12 #3.1)
// Only groups containing the current highlighted step OR explicitly opened by the user stay expanded;
// all other groups auto-collapse automatically!
const historyGroupUserOpen = new Map(); // groupId -> true (only when user manually expanded an inactive group)
const historyGroupCurrentCollapsed = new Set(); // groupId -> user manually collapsed while currentIndex stays inside
let lastRenderedHistCurrentIndex = -1;

function isHistoryGroupOpen(blk) {
  if (!blk || blk.type !== "group") return false;
  if (blk.containsCurrent) {
    return !historyGroupCurrentCollapsed.has(blk.id);
  }
  return !!historyGroupUserOpen.get(blk.id);
}

function resolveHistoryGroupMeta(entry) {
  if (!entry || entry.index === 0) return null;
  if (entry.groupKey) {
    return { key: entry.groupKey, label: entry.groupLabel || entry.label };
  }
  const lbl = String(entry.label || "").trim();
  if (!lbl) return null;
  // Normalize dynamic trailing counts so repeated same-action ops cleanly share a group key
  const base = lbl.replace(/\s*[（(][^（）()]*[）)]\s*$/, "").trim() || lbl;
  return { key: `lbl:${base}`, label: base };
}

function buildGroupedHistoryBlocks(reversedEntries) {
  const blocks = [];
  let i = 0;
  while (i < reversedEntries.length) {
    const e = reversedEntries[i];
    const meta = resolveHistoryGroupMeta(e);
    if (!meta) {
      blocks.push({ type: "entry", entry: e, containsCurrent: e.state === "current" });
      i++;
      continue;
    }
    let j = i + 1;
    while (j < reversedEntries.length) {
      const m2 = resolveHistoryGroupMeta(reversedEntries[j]);
      if (!m2 || m2.key !== meta.key) break;
      j++;
    }
    const runLen = j - i;
    if (runLen >= 3) {
      const run = reversedEntries.slice(i, j);
      const minIdx = run[run.length - 1].index;
      const maxIdx = run[0].index;
      const id = `${meta.key}:${minIdx}-${maxIdx}`;
      const containsCurrent = run.some((x) => x.state === "current");
      const allRedo = run.every((x) => x.state === "redo");
      blocks.push({
        type: "group",
        id,
        groupKey: meta.key,
        groupLabel: meta.label,
        entries: run,
        containsCurrent,
        allRedo,
      });
    } else {
      for (let k = i; k < j; k++) {
        blocks.push({ type: "entry", entry: reversedEntries[k], containsCurrent: reversedEntries[k].state === "current" });
      }
    }
    i = j;
  }
  return blocks;
}

function renderHistoryPanel() {
  const listEl = $("history-list");
  const badgeEl = $("history-count-badge");
  const cardEl = $("history-card");
  const toggleBtn = $("btn-history-toggle");
  if (!listEl) return;

  const tl = history.getTimeline();
  if (badgeEl) badgeEl.textContent = `${tl.currentIndex}/${history.maxSteps}`;
  if (cardEl) cardEl.classList.toggle("collapsed", !historyExpanded);
  if (toggleBtn) toggleBtn.textContent = historyExpanded ? t("editor.scene.collapse") : t("editor.scene.expand");

  // Newest steps at top; auto-group >=3 consecutive same-kind operations (rc11 #5 / rc12 #3.1)!
  const reversed = tl.entries.slice().reverse();
  const blocks = buildGroupedHistoryBlocks(reversed);
  const currentChanged = tl.currentIndex !== lastRenderedHistCurrentIndex;
  lastRenderedHistCurrentIndex = tl.currentIndex;

  // When current step moves, reset temporary active-group collapse overrides so the new active group auto-expands
  // and any previously auto-expanded (non-user-pinned) group automatically collapses!
  if (currentChanged) {
    historyGroupCurrentCollapsed.clear();
  }
  // Prune stale IDs no longer present in current blocks
  const activeBlockIds = new Set(blocks.filter((b) => b.type === "group").map((b) => b.id));
  for (const id of Array.from(historyGroupUserOpen.keys())) {
    if (!activeBlockIds.has(id)) historyGroupUserOpen.delete(id);
  }

  let visibleBlocks = blocks;
  if (!historyExpanded && blocks.length > 3) {
    const curPos = blocks.findIndex((b) => b.containsCurrent);
    if (curPos <= 1) {
      visibleBlocks = blocks.slice(0, 3);
    } else if (curPos >= blocks.length - 1) {
      visibleBlocks = blocks.slice(-3);
    } else {
      visibleBlocks = blocks.slice(curPos - 1, curPos + 2);
    }
  }

  const makeEntryBtn = (entry) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `history-item ${entry.state}`;
    btn.dataset.histIndex = String(entry.index);
    btn.innerHTML = `<span class="hist-idx">#${entry.index}</span><span class="hist-lbl"></span>`;
    btn.querySelector(".hist-lbl").textContent = entry.label;
    btn.onclick = () => {
      if (entry.index === tl.currentIndex) return;
      history.jumpTo(entry.index);
      renderSceneManager();
      syncTransformInputs();
      requestRender(true);
    };
    return btn;
  };

  listEl.innerHTML = "";
  for (const blk of visibleBlocks) {
    if (blk.type === "entry") {
      listEl.appendChild(makeEntryBtn(blk.entry));
      continue;
    }
    const isOpen = isHistoryGroupOpen(blk);
    const wrap = document.createElement("div");
    wrap.className =
      "history-group" +
      (isOpen ? "" : " collapsed") +
      (blk.containsCurrent ? " has-current" : "") +
      (blk.allRedo ? " all-redo" : "");
    wrap.dataset.histGroupId = blk.id;
    wrap.dataset.histGroupKey = blk.groupKey;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "history-group-head";
    head.innerHTML =
      `<span class="history-group-caret">${SVG_GROUP_TRIANGLE}</span>` +
      `<span class="history-group-lbl"></span>` +
      `<span class="history-group-count"></span>`;
    head.querySelector(".history-group-lbl").textContent = blk.groupLabel;
    head.querySelector(".history-group-count").textContent = t("editor.history.groupCountBadge", { count: blk.entries.length });
    head.onclick = () => {
      if (blk.containsCurrent) {
        if (isOpen) {
          historyGroupCurrentCollapsed.add(blk.id);
          historyGroupUserOpen.delete(blk.id);
        } else {
          historyGroupCurrentCollapsed.delete(blk.id);
        }
      } else {
        if (isOpen) historyGroupUserOpen.delete(blk.id);
        else historyGroupUserOpen.set(blk.id, true);
      }
      renderHistoryPanel();
    };

    const children = document.createElement("div");
    children.className = "history-group-children";
    for (const e of blk.entries) {
      children.appendChild(makeEntryBtn(e));
    }
    wrap.append(head, children);
    listEl.appendChild(wrap);
  }
}

function toggleHistoryCardExpanded() {
  historyExpanded = !historyExpanded;
  renderHistoryPanel();
}
$("btn-history-toggle")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleHistoryCardExpanded();
});
$("history-card-header")?.addEventListener("click", toggleHistoryCardExpanded);

const history = new HistoryManager(
  DEFAULT_MAX_HISTORY_STEPS,
  (st) => {
    $("btn-undo").disabled = st.undoCount === 0;
    $("btn-redo").disabled = st.redoCount === 0;
    setStatus(
      st.lastLabel
        ? t("editor.history.lastOpStatus", { label: st.lastLabel, count: st.undoCount, max: history.maxSteps })
        : t("editor.statusBar.ready"),
      !st.lastLabel,
    );
    renderHistoryPanel();
  },
  (payload) => {
    if (!isReplaying) postHost("checkpoint:" + JSON.stringify(payload));
  },
);
renderHistoryPanel();

// 3DGS Smart Measurement Suite Manager (Scale Calibration + Smart Measuring Pen + GPU Heap Views, rc9)
const measureMgr = new MeasureManager({
  scene,
  stage,
  overlaySvg,
  floatingCardEl: $("measure-floating-card"),
  scaleCardEl: $("scale-calib-card"),
  getCloud: () => cloud,
  getRenderer: () => renderer,
  getCamera: () => camera,
  getDisplayMode: () => displayMode,
  history,
  requestRender,
  setStatus,
  onContextBarRefresh: () => {
    if (activeTool === "scaleCalib") showScaleCalibContextBar();
    else if (activeTool === "smartMeasure") showSmartMeasureContextBar();
  },
  showCursorHintPill,
  hideCursorHintPill,
});

// Hang / Context-Lost Auto-Downgrade Watchdog (Section IV.2 & X)
function getLiveTelemetryText() {
  const domTxt = $("bottom-right-perf")?.textContent?.trim();
  if (lastTelemetryText && !lastTelemetryText.includes("--%")) return lastTelemetryText;
  return domTxt || lastTelemetryText;
}

function syncSafeModeUI() {
  const banner = $("safe-mode-banner");
  if (banner) banner.classList.toggle("hidden", !lowPerfSafeMode);

  for (const btnId of ["btn-flyout-filter", "btn-flyout-smart", "btn-flyout-align", "btn-flyout-measure"]) {
    const b = $(btnId);
    if (b) {
      b.disabled = lowPerfSafeMode;
      b.classList.toggle("safe-mode-frozen", lowPerfSafeMode);
    }
  }
  for (const toolId of SAFE_MODE_FROZEN_TOOLS) {
    const el = document.querySelector(`#left-rail [data-tool="${toolId}"]`);
    if (el) {
      el.disabled = lowPerfSafeMode;
      el.classList.toggle("safe-mode-frozen", lowPerfSafeMode);
    }
  }
  const colorBtn = $("btn-color-panel");
  if (colorBtn) {
    colorBtn.disabled = lowPerfSafeMode;
    colorBtn.classList.toggle("safe-mode-frozen", lowPerfSafeMode);
  }
  if (displayModeDropdown?.trigger) {
    displayModeDropdown.trigger.classList.toggle("safe-mode-frozen", lowPerfSafeMode);
  }
}

function enterLowPerfSafeMode(reason = null, telemetry = null, { showModal = true } = {}) {
  const effReason = reason || t("editor.watchdog.defaultReason");
  lowPerfSafeMode = true;
  closeAllMenus();
  if (splitCompareActive) toggleSplitCompare(false);
  if (colorPanelOpen) toggleColorPanel(false);
  if (SAFE_MODE_FROZEN_TOOLS.has(activeTool)) {
    setActiveTool("orbit");
  }
  if (semanticEngine.loaded) {
    semanticEngine.release().catch(() => {});
  }
  if (planeInpaintEngine.lama.loaded) {
    planeInpaintEngine.release().catch(() => {});
  }
  setDisplayMode("centers", { allowInSafeMode: true });
  syncSafeModeUI();
  setStatus(t("editor.status.safeModeEntered"));
  if (showModal) {
    showCrashRecoveryModal(effReason, telemetry || getLiveTelemetryText());
  }
  requestRender(true);
}

function exitLowPerfSafeMode() {
  if (!lowPerfSafeMode) return;
  lowPerfSafeMode = false;
  syncSafeModeUI();
  watchdog.reset();
  setStatus(t("editor.status.safeModeExited"));
  requestRender(true);
}

$("btn-exit-safe-mode")?.addEventListener("click", exitLowPerfSafeMode);

const watchdog = new HangWatchdog({
  canvas,
  getTelemetrySnapshot: () => getLiveTelemetryText(),
  onDowngradeRecover: ({ reason, telemetry }) => {
    history.persistJournal();
    const gl = canvas.getContext("webgl2");
    const ctxLost = !!(gl && gl.isContextLost());
    // If WebGL2 context is still healthy, switch in-place to Centers-Mode Safe Mode immediately
    // (0 reload delay, 0 point loss, freezes filter/color, preserves basic edit & alignment!).
    // Only request host WebView reload if WebGL2 context itself was lost.
    if (ctxLost && window.chrome?.webview) {
      showLoadingOverlay(true, t("editor.loading.rebuildingContextLost"), 15);
      postHost("enterSafeModeReload:" + JSON.stringify({ reason, telemetry }));
    } else {
      enterLowPerfSafeMode(reason, telemetry, { showModal: true });
    }
  },
});

function showCrashRecoveryModal(reason, telemetry) {
  $("crash-telemetry-pre").textContent = t("editor.modals.crashTelemetryFmt", {
    reason,
    telemetry: telemetry || lastTelemetryText,
  });
  openModal("modal-crash-recovery");
}

// ============================================================================
// 3. Render Loop, Object Matrix Sync & +Y-Up Axis Gizmo Sphere
// ============================================================================
let renderScheduled = false;
let forceSortNext = false;

function syncSceneStateToSession() {
  if (!editSession?.sceneState) return;
  objectRoot.updateMatrixWorld(true);
  editSession.sceneState.restoreSnapshot({
    objects: sceneObjects.map((o) => ({
      id: o.id,
      name: o.name,
      visible: o.visible !== false,
      groupId: o.groupId ?? null,
      sourceKind: o.sourceKind || "original",
      matrix: o.node.matrixWorld.elements.slice(),
      bakedGradesCount: (o.bakedGrades || []).length,
    })),
    objectGroups: sceneObjectGroups.map((g) => ({
      id: g.id,
      name: g.name,
      memberIds: [...(g.memberIds || [])],
      matrix: g.node.matrixWorld.elements.slice(),
    })),
    volumesSnapshot: volumeMgr ? volumeMgr.exportSnapshot() : null,
    colorGrade: cloneGrade(liveGrade),
    measureScale: measureMgr ? measureMgr.exportScaleConfig() : { factor: 1.0, unit: "m", calibrated: false },
    measurePins: measureMgr?.pinnedItems ? measureMgr.pinnedItems.map((it) => ({ id: it.id, name: it.name, kind: it.kind })) : [],
  });
}

function getBoundsFilterObjectIds() {
  if (activeObjectGroupId) {
    const og = sceneObjectGroups.find((g) => g.id === activeObjectGroupId);
    if (og && og.memberIds.length > 0) return new Set(og.memberIds);
  }
  if (selectedObjectIds.size > 0) return new Set(selectedObjectIds);
  // Empty selection -> OBB wraps all active visible points in the entire scene (#11)!
  return null;
}

function syncPivotToBoundsCenter() {
  if (!useBoundsCenter || !modelBounds.hasValidBounds) return;
  const c = modelBounds.getCenter();
  if (!c) return;
  pivot.position.copy(c);
  syncPivotOrientationForSpace();
}

function syncObjectMatrices(exactScan = false) {
  if (!cloud) return;
  objectRoot.updateMatrixWorld(true);
  for (const obj of sceneObjects) {
    cloud.setObjectMatrix(obj.id, obj.node.matrixWorld);
  }
  cloud.invalidateHoverPickCache();
  measureMgr.invalidatePicker();
  const isAnim = !!alignCtrl?.isAnimating();
  const doExact = !!(exactScan && !gizmo.dragging && !isAnim);
  modelBounds.syncFromSceneObjects(sceneObjects, getBoundsFilterObjectIds(), { cloud, exactScan: doExact });
  if (useBoundsCenter && !gizmo.dragging && !pivotEditMode && !activeVolumeOrGroupId && !isAnim) {
    syncPivotToBoundsCenter();
  }
  if (!gizmo.dragging && !isAnim) {
    syncSceneStateToSession();
  }
}

function requestRender(forceSort = false) {
  if (forceSort) forceSortNext = true;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderFrame();
  });
}

function resizeViewport() {
  const w = Math.max(1, stage.clientWidth);
  const h = Math.max(1, stage.clientHeight);
  renderer.setSize(w, h, false);
  perspCam.aspect = w / h;
  perspCam.updateProjectionMatrix();
  updateOrthoFrustum(w, h);
  requestRender(true);
}

function updateOrthoFrustum(w, h) {
  const dist = Math.max(0.05, camera.position.distanceTo(orbit.target));
  const halfH = Math.tan(T.MathUtils.degToRad(perspCam.fov * 0.5)) * dist;
  const halfW = halfH * (w / Math.max(1, h));
  orthoCam.left = -halfW;
  orthoCam.right = halfW;
  orthoCam.top = halfH;
  orthoCam.bottom = -halfH;
  orthoCam.updateProjectionMatrix();
}

function getBoundsDepthCamSignature() {
  camera.updateMatrixWorld();
  const e = camera.matrixWorldInverse.elements;
  return `${displayMode}|${camera.isOrthographicCamera ? 1 : 0}|${e[0].toFixed(3)},${e[4].toFixed(3)},${e[8].toFixed(3)},${e[12].toFixed(2)},${e[13].toFixed(2)},${e[14].toFixed(2)}`;
}

function scheduleSettledBoundsDepth(w, h, pr) {
  if (boundsDepthTimer) clearTimeout(boundsDepthTimer);
  if (!cloud || !boundsVisible || displayMode === "centers") return;
  boundsDepthTimer = setTimeout(() => {
    boundsDepthTimer = null;
    if (!cloud || !boundsVisible || displayMode === "centers" || isInteracting) return;
    const dw = Math.max(96, Math.round((w * pr) / 4));
    const dh = Math.max(64, Math.round((h * pr) / 4));
    cachedBoundsDepthTex = cloud.renderCoreDepthTexture(renderer, camera, dw, dh, 0.22);
    cachedBoundsDepthCamSig = getBoundsDepthCamSignature();
    requestRender(false);
  }, 140);
}

function syncVolumeScopeHighlightToCloud() {
  if (!cloud || typeof cloud.setVolumeScopeUniforms !== "function") return;
  const prog = volumeMgr.compileActiveScopeGpuProgram(camera.position);
  cloud.setVolumeScopeUniforms(prog, getEffectiveSelectedObjectIds());
}

function renderFrame() {
  const frameStart = performance.now();
  const w = Math.max(1, stage.clientWidth);
  const h = Math.max(1, stage.clientHeight);
  if (camera === orthoCam) updateOrthoFrustum(w, h);

  let needsFollowUp = false;
  const pr = renderer.getPixelRatio();
  if (cloud) {
    syncObjectMatrices();
    syncVolumeScopeHighlightToCloud();
    // Always render 100% complete point cloud (automatic interactive downsampling permanently removed!)
    needsFollowUp = !!cloud.prepareDraw(cloud.n, displayMode, camera, w * pr, h * pr, forceSortNext, isInteracting);
    forceSortNext = false;

    // Update Gaussian occlusion for full-extent OBB wireframe:
    // - Back corners are occluded every frame at 0ms cost via renderOrder=-2 before splats.
    // - Front corners test quarter-res core depth texture (live for <=600k, settled-frame for >600k!).
    if (boundsVisible && modelBounds.hasValidBounds) {
      let depthTex = null;
      if (displayMode !== "centers") {
        const sig = getBoundsDepthCamSignature();
        if (cloud.n <= 600000) {
          const dw = Math.max(96, Math.round((w * pr) / 3));
          const dh = Math.max(64, Math.round((h * pr) / 3));
          cachedBoundsDepthTex = cloud.renderCoreDepthTexture(renderer, camera, dw, dh, 0.22);
          cachedBoundsDepthCamSig = sig;
          depthTex = cachedBoundsDepthTex;
        } else if (cachedBoundsDepthTex && cachedBoundsDepthCamSig === sig) {
          depthTex = cachedBoundsDepthTex;
        } else if (!isInteracting) {
          scheduleSettledBoundsDepth(w, h, pr);
        }
      }
      modelBounds.updateOcclusion(camera, {
        displayMode,
        splatDepthTex: depthTex,
        viewportW: w * pr,
        viewportH: h * pr,
      });
    }
  }

  infiniteGrid.update(camera, lastSceneRadius);
  volumeMgr.updateAllHandleScales(camera);
  volumeMgr.updateCsgUniforms(camera);
  measureMgr.updatePerFrame(camera);
  renderer.render(scene, camera);
  axisGizmoWidget.draw();
  updateSpatialToolGuidesOverlay();
  if (needsFollowUp) requestRender(false);

  lastRenderCostMs = performance.now() - frameStart;
  perfHud.recordFrame(lastRenderCostMs);
}

// Restrained +Y-up 3D Axis Sphere (transparent when idle; interactive cursor-proximity 3D wireframe on hover!)
const axisGizmoWidget = new AxisGizmoWidget({
  canvas: $("axis-gizmo"),
  getCamera: () => camera,
  onSnapAxis: (dir) => {
    camCtrl.animateToAxis(dir, 0.28);
  },
});

// ============================================================================
// 4. Dual-Stack Bottom-Center Context Toolbar (delegated to ui/context-bar-host.js)
// ============================================================================
const contextBarHost = new ContextBarHost({
  rootEl: $("context-bar-stack"),
  statefulBoolTools: STATEFUL_BOOL_TOOLS,
  getActiveTool: () => activeTool,
  getActiveBoolOp: () => activeBoolOp,
  bindTip,
});
function setContextBar(category, renderFn, key = null) {
  contextBarHost.set(category, renderFn, key);
}
function clearContextBar(category) {
  contextBarHost.clear(category);
}
function getEffectiveBoolOp(e = null) {
  return contextBarHost.getEffectiveBoolOp(e);
}
function syncTempModifierBoolUI(e = null) {
  contextBarHost.syncTempModifierBoolUI(e);
}
function buildBoolButtons(container, activeVal, onPick, executeImmediate = false) {
  contextBarHost.buildBoolButtons(container, activeVal, onPick, executeImmediate);
}

// ============================================================================
// 5. Scene Manager, Multi-Object Groups & Transform Panel Sync
// ============================================================================
function getActiveTransformNodes() {
  if (activeVolumeOrGroupId) {
    const v = volumeMgr.getItem(activeVolumeOrGroupId);
    if (v) return [v.root];
    const g = volumeMgr.getGroup(activeVolumeOrGroupId);
    if (g) return [g.root];
  }
  if (activeObjectGroupId) {
    const og = sceneObjectGroups.find((g) => g.id === activeObjectGroupId);
    if (og) return [og.node];
  }
  const nodes = [];
  for (const obj of sceneObjects) {
    if (selectedObjectIds.has(obj.id)) nodes.push(obj.node);
  }
  return nodes.length ? nodes : sceneObjects[0] ? [sceneObjects[0].node] : [];
}

function getPrimaryTransformNode() {
  const nodes = getActiveTransformNodes();
  return nodes[0] || null;
}

function captureTransformSnapshot() {
  const entries = [];
  for (const obj of sceneObjects) {
    entries.push({
      kind: "object",
      id: obj.id,
      pos: obj.node.position.toArray(),
      rot: [obj.node.rotation.x, obj.node.rotation.y, obj.node.rotation.z],
      scale: obj.node.scale.toArray(),
    });
  }
  for (const og of sceneObjectGroups) {
    entries.push({
      kind: "objGroup",
      id: og.id,
      pos: og.node.position.toArray(),
      rot: [og.node.rotation.x, og.node.rotation.y, og.node.rotation.z],
      scale: og.node.scale.toArray(),
    });
  }
  for (const v of volumeMgr.items) {
    entries.push({
      kind: "volume",
      id: v.id,
      pos: v.root.position.toArray(),
      rot: [v.root.rotation.x, v.root.rotation.y, v.root.rotation.z],
      scale: v.root.scale.toArray(),
    });
  }
  for (const vg of volumeMgr.groups) {
    entries.push({
      kind: "volGroup",
      id: vg.id,
      pos: vg.root.position.toArray(),
      rot: [vg.root.rotation.x, vg.root.rotation.y, vg.root.rotation.z],
      scale: vg.root.scale.toArray(),
    });
  }
  return entries;
}

function applyTransformSnapshot(entries) {
  if (!Array.isArray(entries)) return;
  for (const e of entries) {
    let node = null;
    if (e.kind === "object") node = sceneObjects.find((o) => o.id === e.id)?.node;
    else if (e.kind === "objGroup") node = sceneObjectGroups.find((g) => g.id === e.id)?.node;
    else if (e.kind === "volume") node = volumeMgr.getItem(e.id)?.root;
    else if (e.kind === "volGroup") node = volumeMgr.getGroup(e.id)?.root;
    if (!node) continue;
    node.position.fromArray(e.pos);
    node.rotation.set(e.rot[0], e.rot[1], e.rot[2]);
    node.scale.fromArray(e.scale);
  }
  syncObjectMatrices(true);
  volumeMgr.updateAllHandleScales(camera);
}

function transformsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const eq = (x, y) => x.every((v, i) => Math.abs(v - y[i]) < 1e-5);
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || !eq(a[i].pos, b[i].pos) || !eq(a[i].rot, b[i].rot) || !eq(a[i].scale, b[i].scale)) {
      return false;
    }
  }
  return true;
}

// Inline SVG icons for Scene Manager & Transform controls (consistent crisp dark aesthetic)
const SVG_LOCK_CLOSED = `<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const SVG_LOCK_OPEN = `<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.4-2.1"/></svg>`;
const SVG_TRASH = `<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const SVG_SOLO = `<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/></svg>`;
const SVG_GROUP_TRIANGLE = `<svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M1.8 3.3c0-.5.4-.9.9-.9h6.6c.5 0 .9.4.9.9 0 .22-.08.43-.23.6L6.68 8.95a.9.9 0 0 1-1.36 0L2.03 3.9a.9.9 0 0 1-.23-.6Z"/></svg>`;

function syncTransformInputs() {
  const node = getPrimaryTransformNode();
  if (!node) return;
  const deg = (r) => Number(T.MathUtils.radToDeg(r).toFixed(2));
  const num = (v) => Number(v.toFixed(3));
  $("tr-px").value = num(node.position.x);
  $("tr-py").value = num(node.position.y);
  $("tr-pz").value = num(node.position.z);
  $("tr-rx").value = deg(node.rotation.x);
  $("tr-ry").value = deg(node.rotation.y);
  $("tr-rz").value = deg(node.rotation.z);
  $("tr-sx").value = num(node.scale.x);
  $("tr-sy").value = num(node.scale.y);
  $("tr-sz").value = num(node.scale.z);

  if (activeVolumeOrGroupId) {
    const v = volumeMgr.getNode(activeVolumeOrGroupId);
    $("transform-target-name").textContent = v ? v.name : t("editor.scene.volumeDefault");
  } else if (activeObjectGroupId) {
    const og = sceneObjectGroups.find((g) => g.id === activeObjectGroupId);
    $("transform-target-name").textContent = og ? og.name : t("editor.scene.objectGroupDefault");
  } else if (selectedObjectIds.size === 0) {
    $("transform-target-name").textContent = t("editor.scene.allScene");
  } else {
    $("transform-target-name").textContent =
      selectedObjectIds.size === 1
        ? sceneObjects.find((o) => selectedObjectIds.has(o.id))?.name || t("editor.scene.sceneObjectDefault")
        : t("editor.scene.selectedCount", { count: selectedObjectIds.size });
  }
}

function setScaleLocked(locked) {
  scaleLocked = !!locked;
  const btn = $("btn-scale-lock");
  if (btn) {
    btn.classList.toggle("active", scaleLocked);
    btn.innerHTML = scaleLocked ? SVG_LOCK_CLOSED : SVG_LOCK_OPEN;
  }
}
$("btn-scale-lock").onclick = () => setScaleLocked(!scaleLocked);

function setBoundsCenterEnabled(on, { skipRestore = false } = {}) {
  const next = !!on;
  if (next === useBoundsCenter) return;
  useBoundsCenter = next;
  $("btn-bounds-center")?.classList.toggle("active", useBoundsCenter);
  if (useBoundsCenter) {
    // Mutually exclusive with Pivot Edit Mode (#2 & #12)
    if (pivotEditMode) setPivotEditMode(false, { silent: true });
    savedPivotBeforeBoundsCenter = pivot.position.clone();
    syncObjectMatrices();
    syncPivotToBoundsCenter();
    if (!activeVolumeOrGroupId) {
      gizmo.attach(pivot);
      gizmo.setMode(gizmoMode);
      gizmo.setSpace(gizmoSpace);
      gizmo.visible = true;
      gizmo.enabled = true;
      updateGizmoRailActive(gizmoMode);
    }
    setStatus(t("editor.status.boundsCenterOn"));
  } else {
    if (!skipRestore && savedPivotBeforeBoundsCenter) {
      pivot.position.copy(savedPivotBeforeBoundsCenter);
      pivot.updateMatrixWorld(true);
    }
    savedPivotBeforeBoundsCenter = null;
    setStatus(t("editor.status.boundsCenterOff"));
  }
  requestRender();
}

function setPivotEditMode(on, { silent = false } = {}) {
  const next = !!on;
  if (next === pivotEditMode) return;
  pivotEditMode = next;
  $("btn-pivot-edit")?.classList.toggle("active", pivotEditMode);
  if (pivotEditMode) {
    // Automatically turn OFF Bounds Center (#12 mutual exclusion)
    if (useBoundsCenter) setBoundsCenterEnabled(false, { skipRestore: true });
    // Release volume focus so we edit the model's pivot cleanly
    if (activeVolumeOrGroupId) {
      activeVolumeOrGroupId = null;
      selectedVolumeIds.clear();
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      clearContextBar("volume");
      renderSceneManager();
    }
    prevGizmoModeBeforePivotEdit = gizmoMode;
    gizmoMode = "translate";
    if (!gizmo.visible || gizmo.object !== pivot) {
      const targetNode = getPrimaryTransformNode();
      if (targetNode && pivot.position.lengthSq() < 1e-8) {
        const wp = new T.Vector3();
        targetNode.getWorldPosition(wp);
        pivot.position.copy(wp);
      }
      pivot.rotation.set(0, 0, 0);
      pivot.scale.set(1, 1, 1);
      gizmo.attach(pivot);
    }
    gizmo.setMode("translate");
    gizmo.setSpace(gizmoSpace);
    gizmo.visible = true;
    gizmo.enabled = true;
    updateGizmoRailActive("translate");
    if (!silent) setStatus(t("editor.status.pivotEditOn"));
  } else {
    gizmoMode = prevGizmoModeBeforePivotEdit || "translate";
    gizmo.setMode(gizmoMode);
    gizmo.setSpace(gizmoSpace);
    updateGizmoRailActive(gizmoMode);
    if (!silent) setStatus(t("editor.status.pivotEditOff"));
  }
  requestRender();
}

function setGizmoSpaceMode(space) {
  gizmoSpace = space === "local" ? "local" : "world";
  gizmo.setSpace(gizmoSpace);
  if (gizmo.object === pivot) {
    syncPivotOrientationForSpace();
  }
  $("btn-local-space")?.classList.toggle("active", gizmoSpace === "local");
  setStatus(gizmoSpace === "local" ? t("editor.status.spaceLocal") : t("editor.status.spaceWorld"));
  requestRender();
}

$("btn-pivot-edit")?.addEventListener("click", () => setPivotEditMode(!pivotEditMode));
$("btn-local-space")?.addEventListener("click", () => setGizmoSpaceMode(gizmoSpace === "local" ? "world" : "local"));
$("btn-bounds-center")?.addEventListener("click", () => setBoundsCenterEnabled(!useBoundsCenter));

// Per-row Reset Arrows (#2): Models reset to (0,0,0)/(0,0,0)/(1,1,1); Volumes reset to creation initial values!
function resetTransformRow(rowKind) {
  const nodes = getActiveTransformNodes();
  if (nodes.length === 0) return;
  const before = captureTransformSnapshot();
  const activeVolNode = activeVolumeOrGroupId ? volumeMgr.getNode(activeVolumeOrGroupId) : null;

  for (const node of nodes) {
    if (activeVolNode && node === activeVolNode.root) {
      if (rowKind === "pos") node.position.fromArray(activeVolNode.initialPosition || [0, 0, 0]);
      else if (rowKind === "rot") {
        const r = activeVolNode.initialRotation || [0, 0, 0];
        node.rotation.set(r[0], r[1], r[2]);
      } else if (rowKind === "scale") node.scale.fromArray(activeVolNode.initialScale || [1, 1, 1]);
    } else {
      if (rowKind === "pos") node.position.set(0, 0, 0);
      else if (rowKind === "rot") node.rotation.set(0, 0, 0);
      else if (rowKind === "scale") node.scale.set(1, 1, 1);
    }
  }

  syncObjectMatrices(true);
  volumeMgr.updateAllHandleScales(camera);
  volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
  syncTransformInputs();
  const after = captureTransformSnapshot();
  if (!transformsEqual(before, after)) {
    const lblMap = {
      pos: t("editor.transform.resetPos"),
      rot: t("editor.transform.resetRot"),
      scale: t("editor.transform.resetScale"),
    };
    history.push({
      label: lblMap[rowKind] || t("editor.transform.resetAll"),
      undo: () => { applyTransformSnapshot(before); syncTransformInputs(); volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId); requestRender(true); },
      redo: () => { applyTransformSnapshot(after); syncTransformInputs(); volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId); requestRender(true); },
      journalEntry: { type: "transform", snapshot: after },
    });
  }
  requestRender(true);
}
$("btn-reset-pos")?.addEventListener("click", () => resetTransformRow("pos"));
$("btn-reset-rot")?.addEventListener("click", () => resetTransformRow("rot"));
$("btn-reset-scale")?.addEventListener("click", () => resetTransformRow("scale"));

for (const id of ["tr-px", "tr-py", "tr-pz", "tr-rx", "tr-ry", "tr-rz", "tr-sx", "tr-sy", "tr-sz"]) {
  $(id).addEventListener("change", () => {
    const nodes = getActiveTransformNodes();
    if (nodes.length === 0) return;
    const before = captureTransformSnapshot();

    const px = Number($("tr-px").value) || 0;
    const py = Number($("tr-py").value) || 0;
    const pz = Number($("tr-pz").value) || 0;
    const rx = T.MathUtils.degToRad(Number($("tr-rx").value) || 0);
    const ry = T.MathUtils.degToRad(Number($("tr-ry").value) || 0);
    const rz = T.MathUtils.degToRad(Number($("tr-rz").value) || 0);
    let sx = Math.max(0.001, Number($("tr-sx").value) || 1);
    let sy = Math.max(0.001, Number($("tr-sy").value) || 1);
    let sz = Math.max(0.001, Number($("tr-sz").value) || 1);
    if (scaleLocked && (id === "tr-sx" || id === "tr-sy" || id === "tr-sz")) {
      const uniform = id === "tr-sx" ? sx : id === "tr-sy" ? sy : sz;
      sx = sy = sz = uniform;
      $("tr-sx").value = $("tr-sy").value = $("tr-sz").value = uniform;
    }

    const primary = nodes[0];
    const dp = new T.Vector3(px - primary.position.x, py - primary.position.y, pz - primary.position.z);
    for (let k = 0; k < nodes.length; k++) {
      if (k === 0) {
        nodes[k].position.set(px, py, pz);
        nodes[k].rotation.set(rx, ry, rz);
        nodes[k].scale.set(sx, sy, sz);
      } else {
        nodes[k].position.add(dp);
        nodes[k].rotation.set(rx, ry, rz);
        nodes[k].scale.set(sx, sy, sz);
      }
    }

    syncObjectMatrices(true);
    volumeMgr.updateAllHandleScales(camera);
    volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
    const after = captureTransformSnapshot();
    if (!transformsEqual(before, after)) {
      history.push({
        label: t("editor.history.preciseTransform"),
        groupKey: "transform:precise",
        groupLabel: t("editor.history.groupTransform"),
        undo: () => { applyTransformSnapshot(before); syncTransformInputs(); volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId); requestRender(true); },
        redo: () => { applyTransformSnapshot(after); syncTransformInputs(); volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId); requestRender(true); },
        journalEntry: { type: "transform", snapshot: after },
      });
    }
    requestRender(true);
  });
}

function getEffectiveSelectedObjectIds() {
  if (activeObjectGroupId) {
    const og = sceneObjectGroups.find((g) => g.id === activeObjectGroupId);
    if (og) return new Set(og.memberIds);
  }
  return new Set(selectedObjectIds);
}

function countPointsPerObject() {
  const counts = new Map();
  if (!cloud) return counts;
  const n = cloud.n;
  const oids = cloud.objectIds;
  const flags = cloud.flags;
  for (let i = 0; i < n; i++) {
    if (flags[i] & FLAG_DELETED) continue;
    const id = oids[i];
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function formatCompactCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// #11 Clear Object Selection (leaves enabled Volumes untouched! OBB expands to entire scene!)
function clearObjectSelection() {
  selectedObjectIds.clear();
  activeObjectGroupId = null;
  if (cloud) cloud.syncVisualState(getEffectiveSelectedObjectIds());
  syncObjectMatrices(true);
  syncTransformInputs();
  renderSceneManager();
  updateColorScopeBadge();
  requestRender();
}
$("btn-clear-obj-sel")?.addEventListener("click", clearObjectSelection);

// #8 Overflow Expand/Collapse buttons for Objects & Volumes lists
$("btn-expand-objects")?.addEventListener("click", () => {
  objectsListExpanded = !objectsListExpanded;
  $("scene-objects-list")?.classList.toggle("expanded", objectsListExpanded);
  $("btn-expand-objects").textContent = objectsListExpanded ? t("editor.scene.collapse") : t("editor.scene.expand");
  $("btn-expand-objects").classList.toggle("active", objectsListExpanded);
});
$("btn-expand-volumes")?.addEventListener("click", () => {
  volumesListExpanded = !volumesListExpanded;
  $("scene-volumes-list")?.classList.toggle("expanded", volumesListExpanded);
  $("btn-expand-volumes").textContent = volumesListExpanded ? t("editor.scene.collapse") : t("editor.scene.expand");
  $("btn-expand-volumes").classList.toggle("active", volumesListExpanded);
});

function refreshListOverflowButtons() {
  requestAnimationFrame(() => {
    const oList = $("scene-objects-list");
    const oBtn = $("btn-expand-objects");
    if (oList && oBtn) {
      const overflows = objectsListExpanded || oList.scrollHeight > oList.clientHeight + 4;
      oBtn.classList.toggle("hidden", !overflows);
      oBtn.textContent = objectsListExpanded ? t("editor.scene.collapse") : t("editor.scene.expand");
    }
    const vList = $("scene-volumes-list");
    const vBtn = $("btn-expand-volumes");
    if (vList && vBtn) {
      const overflows = volumesListExpanded || vList.scrollHeight > vList.clientHeight + 4;
      vBtn.classList.toggle("hidden", !overflows);
      vBtn.textContent = volumesListExpanded ? t("editor.scene.collapse") : t("editor.scene.expand");
    }
  });
}

// #3 Solo (独显) toggle for both Scene Objects and Object Groups
function toggleSolo(kind, targetId) {
  const isSame = soloState && soloState.kind === kind && soloState.targetId === targetId;
  if (isSame) {
    for (const obj of sceneObjects) {
      const prev = soloState.prevVis.has(obj.id) ? soloState.prevVis.get(obj.id) : true;
      obj.visible = prev;
      if (cloud) cloud.objectVisibility.set(obj.id, prev);
    }
    soloState = null;
  } else {
    const prevVis = soloState ? soloState.prevVis : new Map(sceneObjects.map((o) => [o.id, o.visible]));
    let keepIds = new Set();
    if (kind === "object") {
      keepIds.add(targetId);
    } else if (kind === "group") {
      const og = sceneObjectGroups.find((g) => g.id === targetId);
      if (og) keepIds = new Set(og.memberIds);
    }
    for (const obj of sceneObjects) {
      obj.visible = keepIds.has(obj.id);
      if (cloud) cloud.objectVisibility.set(obj.id, obj.visible);
    }
    soloState = { kind, targetId, prevVis };
  }
  if (cloud) {
    modelBounds.recomputeLocalBoxes(cloud);
    updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
  }
  syncObjectMatrices();
  renderSceneManager();
  requestRender(true);
}

// #3 Undoable Scene Object deletion (protected when only 1 scene object remains!)
function deleteSceneObject(objId) {
  if (sceneObjects.length <= 1) {
    setStatus(t("editor.status.keepAtLeastOneObj"));
    return false;
  }
  const idx = sceneObjects.findIndex((o) => o.id === objId);
  if (idx < 0) return false;
  const obj = sceneObjects[idx];
  const oldGroupId = obj.groupId;
  const oldGroup = oldGroupId ? sceneObjectGroups.find((g) => g.id === oldGroupId) : null;
  const oldGroupMemberIdx = oldGroup ? oldGroup.memberIds.indexOf(obj.id) : -1;
  const oldParent = obj.node.parent;

  // Snapshot flags of points belonging to this object for exact 1-step Undo!
  const affectedIndices = [];
  const prevFlags = [];
  if (cloud) {
    for (let i = 0; i < cloud.n; i++) {
      if (cloud.objectIds[i] === obj.id) {
        affectedIndices.push(i);
        prevFlags.push(cloud.flags[i]);
      }
    }
  }

  const doDelete = () => {
    if (cloud) {
      for (const i of affectedIndices) cloud.flags[i] = (cloud.flags[i] | FLAG_DELETED) & ~FLAG_SELECTED;
    }
    if (oldGroup) {
      const mi = oldGroup.memberIds.indexOf(obj.id);
      if (mi >= 0) oldGroup.memberIds.splice(mi, 1);
      if (oldGroup.memberIds.length === 0) {
        const gi = sceneObjectGroups.indexOf(oldGroup);
        if (gi >= 0) sceneObjectGroups.splice(gi, 1);
        if (oldGroup.node.parent) oldGroup.node.parent.remove(oldGroup.node);
        if (activeObjectGroupId === oldGroup.id) activeObjectGroupId = null;
      }
    }
    if (obj.node.parent) obj.node.parent.remove(obj.node);
    const si = sceneObjects.indexOf(obj);
    if (si >= 0) sceneObjects.splice(si, 1);
    selectedObjectIds.delete(obj.id);
    if (soloState && soloState.kind === "object" && soloState.targetId === obj.id) soloState = null;
    if (cloud) {
      modelBounds.recomputeLocalBoxes(cloud);
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    }
    syncObjectMatrices();
    syncTransformInputs();
    renderSceneManager();
    updateColorScopeBadge();
    requestRender(true);
  };

  const doRestore = () => {
    if (!sceneObjects.includes(obj)) sceneObjects.splice(Math.min(idx, sceneObjects.length), 0, obj);
    if (oldGroup) {
      if (!sceneObjectGroups.includes(oldGroup)) {
        objectRoot.add(oldGroup.node);
        sceneObjectGroups.push(oldGroup);
      }
      if (!oldGroup.memberIds.includes(obj.id)) {
        oldGroup.memberIds.splice(Math.max(0, Math.min(oldGroupMemberIdx, oldGroup.memberIds.length)), 0, obj.id);
      }
      oldGroup.node.add(obj.node);
    } else if (oldParent) {
      oldParent.add(obj.node);
    } else {
      objectRoot.add(obj.node);
    }
    if (cloud) {
      for (let k = 0; k < affectedIndices.length; k++) cloud.flags[affectedIndices[k]] = prevFlags[k];
      cloud.objectVisibility.set(obj.id, obj.visible);
      modelBounds.recomputeLocalBoxes(cloud);
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    }
    syncObjectMatrices();
    syncTransformInputs();
    renderSceneManager();
    updateColorScopeBadge();
    requestRender(true);
  };

  doDelete();
  history.push({ label: t("editor.history.deleteObject", { name: obj.name }), undo: doRestore, redo: doDelete });
  return true;
}

// #3 Undoable Object Group deletion (blocked if deleting group would leave 0 scene objects!)
function deleteSceneObjectGroup(groupId) {
  const ogIdx = sceneObjectGroups.findIndex((g) => g.id === groupId);
  if (ogIdx < 0) return false;
  const og = sceneObjectGroups[ogIdx];
  const memberSet = new Set(og.memberIds);
  if (sceneObjects.length - memberSet.size < 1) {
    setStatus(t("editor.status.keepAtLeastOneObjGroup"));
    return false;
  }
  const removedObjs = sceneObjects.filter((o) => memberSet.has(o.id)).map((o) => ({ obj: o, idx: sceneObjects.indexOf(o) }));
  const affectedIndices = [];
  const prevFlags = [];
  if (cloud) {
    for (let i = 0; i < cloud.n; i++) {
      if (memberSet.has(cloud.objectIds[i])) {
        affectedIndices.push(i);
        prevFlags.push(cloud.flags[i]);
      }
    }
  }

  const doDelete = () => {
    if (cloud) {
      for (const i of affectedIndices) cloud.flags[i] = (cloud.flags[i] | FLAG_DELETED) & ~FLAG_SELECTED;
    }
    for (const { obj } of removedObjs) {
      const si = sceneObjects.indexOf(obj);
      if (si >= 0) sceneObjects.splice(si, 1);
      selectedObjectIds.delete(obj.id);
    }
    const gi = sceneObjectGroups.indexOf(og);
    if (gi >= 0) sceneObjectGroups.splice(gi, 1);
    if (og.node.parent) og.node.parent.remove(og.node);
    if (activeObjectGroupId === og.id) activeObjectGroupId = null;
    if (soloState && soloState.kind === "group" && soloState.targetId === og.id) soloState = null;
    if (cloud) {
      modelBounds.recomputeLocalBoxes(cloud);
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    }
    syncObjectMatrices();
    syncTransformInputs();
    renderSceneManager();
    updateColorScopeBadge();
    requestRender(true);
  };

  const doRestore = () => {
    if (!sceneObjectGroups.includes(og)) sceneObjectGroups.splice(Math.min(ogIdx, sceneObjectGroups.length), 0, og);
    objectRoot.add(og.node);
    for (const { obj, idx } of removedObjs) {
      if (!sceneObjects.includes(obj)) sceneObjects.splice(Math.min(idx, sceneObjects.length), 0, obj);
      og.node.add(obj.node);
      if (cloud) cloud.objectVisibility.set(obj.id, obj.visible);
    }
    if (cloud) {
      for (let k = 0; k < affectedIndices.length; k++) cloud.flags[affectedIndices[k]] = prevFlags[k];
      modelBounds.recomputeLocalBoxes(cloud);
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    }
    syncObjectMatrices();
    syncTransformInputs();
    renderSceneManager();
    updateColorScopeBadge();
    requestRender(true);
  };

  doDelete();
  history.push({ label: t("editor.history.deleteObjectGroup", { name: og.name }), undo: doRestore, redo: doDelete });
  return true;
}

// #5 Drag-and-drop reordering & cross-group move for Scene Objects (single-level object groups!)
function moveSceneObject(objId, targetGroupId = null, targetIndex = -1) {
  const obj = sceneObjects.find((o) => o.id === objId);
  if (!obj) return false;
  objectRoot.updateMatrixWorld(true);
  if (obj.groupId) {
    const oldG = sceneObjectGroups.find((g) => g.id === obj.groupId);
    if (oldG) {
      const mi = oldG.memberIds.indexOf(obj.id);
      if (mi >= 0) oldG.memberIds.splice(mi, 1);
      objectRoot.attach(obj.node);
      if (oldG.memberIds.length === 0) {
        const gi = sceneObjectGroups.indexOf(oldG);
        if (gi >= 0) sceneObjectGroups.splice(gi, 1);
        if (oldG.node.parent) oldG.node.parent.remove(oldG.node);
        if (activeObjectGroupId === oldG.id) activeObjectGroupId = null;
      }
    }
    obj.groupId = null;
  }

  if (targetGroupId) {
    const newG = sceneObjectGroups.find((g) => g.id === targetGroupId);
    if (newG) {
      newG.node.attach(obj.node);
      obj.groupId = newG.id;
      if (targetIndex >= 0 && targetIndex <= newG.memberIds.length) {
        newG.memberIds.splice(targetIndex, 0, obj.id);
      } else {
        newG.memberIds.push(obj.id);
      }
    }
  } else {
    objectRoot.attach(obj.node);
    const curIdx = sceneObjects.indexOf(obj);
    if (curIdx >= 0 && targetIndex >= 0) {
      sceneObjects.splice(curIdx, 1);
      const clamped = Math.max(0, Math.min(sceneObjects.length, targetIndex > curIdx ? targetIndex - 1 : targetIndex));
      sceneObjects.splice(clamped, 0, obj);
    }
  }
  syncObjectMatrices();
  renderSceneManager();
  syncTransformInputs();
  requestRender();
  return true;
}

function clearDragIndicators() {
  document.querySelectorAll(".dragging-lift, .drop-target-above, .drop-target-below, .drop-target-into").forEach((el) => {
    el.classList.remove("dragging-lift", "drop-target-above", "drop-target-below", "drop-target-into");
  });
}

// ============================================================================
// Scene Manager Inline Rename (same style as Color Panel .cr-val-input, rc11 #3.1),
// Right-Click Context Menus (rc11 #3.2 & #3.3), Merge / Multi-Delete & Ctrl+Drag Duplicate (rc11 #3.4)
// ============================================================================
const sceneMgrCtxMenuEl = $("scene-mgr-ctx-menu");

function hideSceneMgrContextMenu() {
  sceneMgrCtxMenuEl?.classList.add("hidden");
}

window.addEventListener("pointerdown", (e) => {
  if (sceneMgrCtxMenuEl && !sceneMgrCtxMenuEl.classList.contains("hidden") && !sceneMgrCtxMenuEl.contains(e.target)) {
    hideSceneMgrContextMenu();
  }
});

function showSceneMgrContextMenu(clientX, clientY, items) {
  if (!sceneMgrCtxMenuEl || !items || items.length === 0) return;
  closeAllMenus();
  sceneMgrCtxMenuEl.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (item.danger) btn.classList.add("danger");
    btn.disabled = !!item.disabled;
    const lbl = document.createElement("span");
    lbl.textContent = item.label;
    btn.appendChild(lbl);
    btn.onclick = (e) => {
      e.stopPropagation();
      hideSceneMgrContextMenu();
      item.onClick?.();
    };
    sceneMgrCtxMenuEl.appendChild(btn);
  }
  sceneMgrCtxMenuEl.classList.remove("hidden");
  const mw = sceneMgrCtxMenuEl.offsetWidth || 124;
  const mh = sceneMgrCtxMenuEl.offsetHeight || 104;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 720;
  const left = Math.max(8, Math.min(vw - mw - 8, clientX));
  const top = Math.max(8, Math.min(vh - mh - 8, clientY));
  sceneMgrCtxMenuEl.style.left = `${left}px`;
  sceneMgrCtxMenuEl.style.top = `${top}px`;
}

function startInlineRename(nameSpan, currentText, onCommit) {
  if (!nameSpan || !nameSpan.parentElement) return;
  const rowEl = nameSpan.closest(".scene-row");
  const wasDraggable = rowEl ? rowEl.draggable : false;
  if (rowEl) rowEl.draggable = false;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "scene-inline-rename";
  input.value = currentText || "";
  nameSpan.replaceWith(input);

  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    if (rowEl) rowEl.draggable = wasDraggable;
    const next = input.value.trim();
    if (commit && next && next !== currentText) {
      onCommit(next);
    } else {
      renderSceneManager();
      syncTransformInputs();
    }
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.select();
}

function isMatrixNearIdentity(mat) {
  const e = mat.elements;
  return (
    Math.abs(e[0] - 1) < 1e-5 && Math.abs(e[1]) < 1e-5 && Math.abs(e[2]) < 1e-5 &&
    Math.abs(e[4]) < 1e-5 && Math.abs(e[5] - 1) < 1e-5 && Math.abs(e[6]) < 1e-5 &&
    Math.abs(e[8]) < 1e-5 && Math.abs(e[9]) < 1e-5 && Math.abs(e[10] - 1) < 1e-5 &&
    Math.abs(e[12]) < 1e-5 && Math.abs(e[13]) < 1e-5 && Math.abs(e[14]) < 1e-5
  );
}

function duplicateSceneObjectToTarget(objId, targetGroupId = null, insertIdx = -1, { recordHistory = true } = {}) {
  if (!cloud) return null;
  if (sceneObjects.length >= MAX_SCENE_OBJECTS) {
    setStatus(t("editor.status.maxObjectsReached", { max: MAX_SCENE_OBJECTS }));
    return null;
  }
  const srcObj = sceneObjects.find((o) => o.id === objId);
  if (!srcObj) return null;

  const indices = [];
  for (let i = 0; i < cloud.n; i++) {
    if (!(cloud.flags[i] & FLAG_DELETED) && cloud.objectIds[i] === srcObj.id) {
      indices.push(i);
    }
  }
  if (indices.length === 0) return null;

  const prevSelIds = Array.from(selectedObjectIds);
  const prevActiveGroupId = activeObjectGroupId;
  const prevFlags = new Uint8Array(cloud.flags);
  const newId = nextObjId++;
  const newNode = new T.Object3D();
  newNode.name = "obj_" + newId;
  objectRoot.updateMatrixWorld(true);
  srcObj.node.updateMatrixWorld(true);
  srcObj.node.matrixWorld.decompose(newNode.position, newNode.quaternion, newNode.scale);
  objectRoot.add(newNode);

  const newObj = {
    id: newId,
    name: `${srcObj.name}${t("editor.scene.copySuffix")}`,
    visible: srcObj.visible,
    groupId: null,
    sourceKind: "duplicate",
    node: newNode,
    bakedGrades: (srcObj.bakedGrades || []).map((g) => ({ targetRanges: g.targetRanges, grade: cloneGrade(g.grade) })),
  };

  const dupInfo = cloud.duplicatePoints(indices, newId, { selectNew: false });
  if (!dupInfo) {
    objectRoot.remove(newNode);
    return null;
  }
  cloud.objectVisibility.set(newId, newObj.visible);

  const targetGrp = targetGroupId ? sceneObjectGroups.find((g) => g.id === targetGroupId) : null;
  const clampedInsertIdx =
    insertIdx >= 0 && insertIdx <= sceneObjects.length ? insertIdx : sceneObjects.length;
  sceneObjects.splice(clampedInsertIdx, 0, newObj);
  if (targetGrp) {
    targetGrp.node.attach(newNode);
    newObj.groupId = targetGrp.id;
    const gIdx = insertIdx >= 0 && insertIdx <= targetGrp.memberIds.length ? insertIdx : targetGrp.memberIds.length;
    targetGrp.memberIds.splice(gIdx, 0, newObj.id);
  }

  selectedObjectIds.clear();
  selectedObjectIds.add(newId);
  activeObjectGroupId = null;

  modelBounds.recomputeLocalBoxes(cloud);
  syncObjectMatrices(true);
  updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
  renderSceneManager();
  syncTransformInputs();
  requestRender(true);

  const savedIndices = Uint32Array.from(indices);
  const result = {
    newObj,
    newNode,
    oldN: dupInfo.oldN,
    prevFlags,
    savedIndices,
    targetGroupId: targetGrp ? targetGrp.id : null,
    insertIdx: clampedInsertIdx,
    prevSelIds,
    prevActiveGroupId,
  };

  if (recordHistory) {
    history.push({
      label: t("editor.history.dupMoveObj", { name: newObj.name }),
      undo: () => {
        cloud.truncatePoints(dupInfo.oldN);
        cloud.flags.set(prevFlags);
        if (newObj.groupId) {
          const g = sceneObjectGroups.find((x) => x.id === newObj.groupId);
          if (g) {
            const mi = g.memberIds.indexOf(newObj.id);
            if (mi >= 0) g.memberIds.splice(mi, 1);
          }
        }
        const pos = sceneObjects.indexOf(newObj);
        if (pos >= 0) sceneObjects.splice(pos, 1);
        if (newNode.parent) newNode.parent.remove(newNode);
        selectedObjectIds.clear();
        for (const id of prevSelIds) selectedObjectIds.add(id);
        activeObjectGroupId = prevActiveGroupId;
        modelBounds.recomputeLocalBoxes(cloud);
        syncObjectMatrices(true);
        updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
        renderSceneManager();
        syncTransformInputs();
        requestRender(true);
      },
      redo: () => {
        cloud.duplicatePoints(savedIndices, newId, { selectNew: false });
        cloud.objectVisibility.set(newId, newObj.visible);
        if (targetGrp && sceneObjectGroups.includes(targetGrp)) {
          targetGrp.node.add(newNode);
          newObj.groupId = targetGrp.id;
          if (!targetGrp.memberIds.includes(newId)) targetGrp.memberIds.push(newId);
        } else {
          objectRoot.add(newNode);
          newObj.groupId = null;
        }
        if (!sceneObjects.includes(newObj)) {
          sceneObjects.splice(Math.min(clampedInsertIdx, sceneObjects.length), 0, newObj);
        }
        selectedObjectIds.clear();
        selectedObjectIds.add(newId);
        activeObjectGroupId = null;
        modelBounds.recomputeLocalBoxes(cloud);
        syncObjectMatrices(true);
        updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
        renderSceneManager();
        syncTransformInputs();
        requestRender(true);
      },
    });
  }
  return result;
}

// rc11 #3.2: Undoable Merge of 2+ selected Scene Objects (bakes relative transforms cleanly!)
function mergeSelectedObjects() {
  if (!cloud) return false;
  const targets = sceneObjects.filter((o) => selectedObjectIds.has(o.id));
  if (targets.length < 2) return false;

  objectRoot.updateMatrixWorld(true);
  const dstObj = targets[0];
  dstObj.node.updateMatrixWorld(true);
  const dstWorldInv = dstObj.node.matrixWorld.clone().invert();
  const absorbed = targets.slice(1);

  const absorbedInfo = [];
  for (const srcObj of absorbed) {
    srcObj.node.updateMatrixWorld(true);
    const relMat = new T.Matrix4().multiplyMatrices(dstWorldInv, srcObj.node.matrixWorld);
    const needsBake = !isMatrixNearIdentity(relMat);
    const ptIndices = [];
    for (let i = 0; i < cloud.n; i++) {
      if (cloud.objectIds[i] === srcObj.id) ptIndices.push(i);
    }
    const oldGrp = srcObj.groupId ? sceneObjectGroups.find((g) => g.id === srcObj.groupId) : null;
    absorbedInfo.push({
      obj: srcObj,
      listIdx: sceneObjects.indexOf(srcObj),
      oldParent: srcObj.node.parent,
      oldGroup: oldGrp,
      oldGroupMemberIdx: oldGrp ? oldGrp.memberIds.indexOf(srcObj.id) : -1,
      ptIndices: Uint32Array.from(ptIndices),
      relMat,
      needsBake,
      bakeSnap: null,
      mergedPieceRec: needsBake
        ? {
            srcRanges: encodeIndexRanges(ptIndices.map((i) => cloud.srcIdx[i])),
            relMatrix: Array.from(relMat.elements),
            bakedGrades: (srcObj.bakedGrades || []).map((g) => ({ targetRanges: g.targetRanges, grade: cloneGrade(g.grade) })),
          }
        : null,
    });
  }

  const prevSelIds = Array.from(selectedObjectIds);

  const doMerge = () => {
    if (!dstObj.mergedPieces) dstObj.mergedPieces = [];
    for (const info of absorbedInfo) {
      if (info.needsBake && info.ptIndices.length > 0) {
        info.bakeSnap = cloud.bakeMatrixIntoPoints(info.ptIndices, info.relMat);
        if (info.mergedPieceRec && !dstObj.mergedPieces.includes(info.mergedPieceRec)) {
          dstObj.mergedPieces.push(info.mergedPieceRec);
        }
      }
      for (let k = 0; k < info.ptIndices.length; k++) {
        cloud.objectIds[info.ptIndices[k]] = dstObj.id;
      }
      if (info.oldGroup) {
        const mi = info.oldGroup.memberIds.indexOf(info.obj.id);
        if (mi >= 0) info.oldGroup.memberIds.splice(mi, 1);
        if (info.oldGroup.memberIds.length === 0) {
          const gi = sceneObjectGroups.indexOf(info.oldGroup);
          if (gi >= 0) sceneObjectGroups.splice(gi, 1);
          if (info.oldGroup.node.parent) info.oldGroup.node.parent.remove(info.oldGroup.node);
          if (activeObjectGroupId === info.oldGroup.id) activeObjectGroupId = null;
        }
      }
      if (info.obj.node.parent) info.obj.node.parent.remove(info.obj.node);
      const si = sceneObjects.indexOf(info.obj);
      if (si >= 0) sceneObjects.splice(si, 1);
      selectedObjectIds.delete(info.obj.id);
    }
    selectedObjectIds.clear();
    selectedObjectIds.add(dstObj.id);
    activeObjectGroupId = null;
    cloud.markObjectIdsDirty();
    modelBounds.recomputeLocalBoxes(cloud);
    syncObjectMatrices(true);
    updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    renderSceneManager();
    syncTransformInputs();
    updateColorScopeBadge();
    requestRender(true);
  };

  const doUndo = () => {
    for (let idx = absorbedInfo.length - 1; idx >= 0; idx--) {
      const info = absorbedInfo[idx];
      if (info.bakeSnap) {
        cloud.restorePointsBakedTransform(info.bakeSnap);
        info.bakeSnap = null;
      }
      if (info.mergedPieceRec && dstObj.mergedPieces) {
        const pi = dstObj.mergedPieces.indexOf(info.mergedPieceRec);
        if (pi >= 0) dstObj.mergedPieces.splice(pi, 1);
      }
      for (let k = 0; k < info.ptIndices.length; k++) {
        cloud.objectIds[info.ptIndices[k]] = info.obj.id;
      }
      if (!sceneObjects.includes(info.obj)) {
        sceneObjects.splice(Math.min(info.listIdx, sceneObjects.length), 0, info.obj);
      }
      if (info.oldGroup) {
        if (!sceneObjectGroups.includes(info.oldGroup)) {
          objectRoot.add(info.oldGroup.node);
          sceneObjectGroups.push(info.oldGroup);
        }
        if (!info.oldGroup.memberIds.includes(info.obj.id)) {
          info.oldGroup.memberIds.splice(
            Math.max(0, Math.min(info.oldGroupMemberIdx, info.oldGroup.memberIds.length)),
            0,
            info.obj.id,
          );
        }
        info.oldGroup.node.add(info.obj.node);
      } else if (info.oldParent) {
        info.oldParent.add(info.obj.node);
      } else {
        objectRoot.add(info.obj.node);
      }
      cloud.objectVisibility.set(info.obj.id, info.obj.visible);
    }
    selectedObjectIds.clear();
    for (const id of prevSelIds) selectedObjectIds.add(id);
    cloud.markObjectIdsDirty();
    modelBounds.recomputeLocalBoxes(cloud);
    syncObjectMatrices(true);
    updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    renderSceneManager();
    syncTransformInputs();
    updateColorScopeBadge();
    requestRender(true);
  };

  doMerge();
  history.push({
    label: t("editor.history.mergeObjects", { count: targets.length, name: dstObj.name }),
    undo: doUndo,
    redo: doMerge,
  });
  setStatus(t("editor.status.mergedObjects", { count: targets.length, name: dstObj.name }));
  return true;
}

// rc11 #3.2: Undoable Multi-Delete for selected Scene Objects (enforces >=1 remaining object!)
function deleteSelectedSceneObjects() {
  const targets = sceneObjects.filter((o) => selectedObjectIds.has(o.id));
  if (targets.length === 0) return false;
  if (sceneObjects.length - targets.length < 1) {
    setStatus(t("editor.status.keepAtLeastOneObj"));
    return false;
  }
  if (targets.length === 1) return deleteSceneObject(targets[0].id);

  const idSet = new Set(targets.map((o) => o.id));
  const records = targets.map((obj) => {
    const oldGrp = obj.groupId ? sceneObjectGroups.find((g) => g.id === obj.groupId) : null;
    return {
      obj,
      idx: sceneObjects.indexOf(obj),
      oldParent: obj.node.parent,
      oldGroup: oldGrp,
      oldGroupMemberIdx: oldGrp ? oldGrp.memberIds.indexOf(obj.id) : -1,
    };
  });
  const affectedIndices = [];
  const prevFlags = [];
  if (cloud) {
    for (let i = 0; i < cloud.n; i++) {
      if (idSet.has(cloud.objectIds[i])) {
        affectedIndices.push(i);
        prevFlags.push(cloud.flags[i]);
      }
    }
  }

  const doDelete = () => {
    if (cloud) {
      for (const i of affectedIndices) cloud.flags[i] = (cloud.flags[i] | FLAG_DELETED) & ~FLAG_SELECTED;
    }
    for (const r of records) {
      if (r.oldGroup) {
        const mi = r.oldGroup.memberIds.indexOf(r.obj.id);
        if (mi >= 0) r.oldGroup.memberIds.splice(mi, 1);
        if (r.oldGroup.memberIds.length === 0) {
          const gi = sceneObjectGroups.indexOf(r.oldGroup);
          if (gi >= 0) sceneObjectGroups.splice(gi, 1);
          if (r.oldGroup.node.parent) r.oldGroup.node.parent.remove(r.oldGroup.node);
          if (activeObjectGroupId === r.oldGroup.id) activeObjectGroupId = null;
        }
      }
      if (r.obj.node.parent) r.obj.node.parent.remove(r.obj.node);
      const si = sceneObjects.indexOf(r.obj);
      if (si >= 0) sceneObjects.splice(si, 1);
      selectedObjectIds.delete(r.obj.id);
    }
    if (cloud) {
      modelBounds.recomputeLocalBoxes(cloud);
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    }
    syncObjectMatrices(true);
    syncTransformInputs();
    renderSceneManager();
    updateColorScopeBadge();
    requestRender(true);
  };

  const doRestore = () => {
    for (const r of records) {
      if (!sceneObjects.includes(r.obj)) sceneObjects.splice(Math.min(r.idx, sceneObjects.length), 0, r.obj);
      if (r.oldGroup) {
        if (!sceneObjectGroups.includes(r.oldGroup)) {
          objectRoot.add(r.oldGroup.node);
          sceneObjectGroups.push(r.oldGroup);
        }
        if (!r.oldGroup.memberIds.includes(r.obj.id)) {
          r.oldGroup.memberIds.splice(Math.max(0, Math.min(r.oldGroupMemberIdx, r.oldGroup.memberIds.length)), 0, r.obj.id);
        }
        r.oldGroup.node.add(r.obj.node);
      } else if (r.oldParent) {
        r.oldParent.add(r.obj.node);
      } else {
        objectRoot.add(r.obj.node);
      }
      if (cloud) cloud.objectVisibility.set(r.obj.id, r.obj.visible);
    }
    if (cloud) {
      for (let k = 0; k < affectedIndices.length; k++) cloud.flags[affectedIndices[k]] = prevFlags[k];
      modelBounds.recomputeLocalBoxes(cloud);
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    }
    syncObjectMatrices(true);
    syncTransformInputs();
    renderSceneManager();
    updateColorScopeBadge();
    requestRender(true);
  };

  doDelete();
  history.push({ label: t("editor.history.deleteObjectsMulti", { count: targets.length }), undo: doRestore, redo: doDelete });
  return true;
}

// rc11 #3.2 & #3.3: Volume Multi-Merge, Multi-Delete & Group Wrap helpers
function mergeSelectedVolumes() {
  if (selectedVolumeIds.size < 2) return false;
  const before = volumeMgr.exportSnapshot();
  const mergedName = t("editor.scene.mergedVolumeName", { num: volumeMgr.groups.length + 1 });
  const grp = volumeMgr.mergeNodesIntoUnionGroup([...selectedVolumeIds], mergedName);
  if (!grp) return false;
  volumeMgr.syncAllVisuals(selectedVolumeIds, grp.id);
  pushVolumeHistory(t("editor.history.mergeVolumes", { name: grp.name }), before, volumeMgr.exportSnapshot());
  selectVolumeOrGroup(grp.id, false);
  setStatus(t("editor.status.mergedVolumes", { count: grp.children.length, name: grp.name }));
  return true;
}

function deleteSelectedVolumes(targetIds = null) {
  const ids = targetIds ? Array.from(targetIds) : Array.from(selectedVolumeIds);
  if (ids.length === 0) return false;
  const before = volumeMgr.exportSnapshot();
  const removed = new Set();
  for (const id of ids) {
    const node = volumeMgr.getNode(id);
    if (!node) continue;
    if (node.isVolumeGroup) {
      node.collectAllDescendantIds(removed);
      removed.add(node.id);
      volumeMgr.removeGroup(node.id);
    } else {
      removed.add(node.id);
      volumeMgr.removeVolume(node.id);
    }
  }
  for (const rid of removed) selectedVolumeIds.delete(rid);
  if (activeVolumeOrGroupId && removed.has(activeVolumeOrGroupId)) {
    activeVolumeOrGroupId = null;
    gizmo.detach();
    gizmo.visible = false;
    gizmo.enabled = false;
    clearContextBar("volume");
  }
  volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
  pushVolumeHistory(t("editor.history.deleteVolsMulti", { count: ids.length }), before, volumeMgr.exportSnapshot());
  renderSceneManager();
  syncTransformInputs();
  requestRender();
  return true;
}

function wrapVolumeGroupInParent(groupId) {
  const before = volumeMgr.exportSnapshot();
  const outer = volumeMgr.wrapGroupInNewParent(groupId);
  if (!outer) return false;
  volumeMgr.syncAllVisuals(selectedVolumeIds, outer.id);
  pushVolumeHistory(t("editor.history.groupVolumes", { name: outer.name }), before, volumeMgr.exportSnapshot());
  selectVolumeOrGroup(outer.id, false);
  setStatus(t("editor.status.groupedVolumes", { count: outer.children.length, name: outer.name }));
  return true;
}

function renderSceneManager() {
  const objCounts = countPointsPerObject();
  const objList = $("scene-objects-list");
  objList.innerHTML = "";
  objList.classList.toggle("expanded", objectsListExpanded);

  // Allow dropping dragged Scene Object onto empty list space to pull OUT of a group (or Ctrl+Drag copy!)
  objList.ondragover = (e) => {
    if (!dragCtx || dragCtx.domain !== "object") return;
    e.preventDefault();
    const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
    e.dataTransfer.dropEffect = isCopy ? "copy" : "move";
  };
  objList.ondrop = (e) => {
    if (!dragCtx || dragCtx.domain !== "object") return;
    if (e.target !== objList) return;
    e.preventDefault();
    clearDragIndicators();
    const id = dragCtx.id;
    const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
    dragCtx = null;
    if (isCopy) {
      duplicateSceneObjectToTarget(id, null, sceneObjects.length);
    } else {
      moveSceneObject(id, null, sceneObjects.length);
    }
  };

  // Render Object Groups first (neutral gray when unselected #11; collapse + points + solo + eye + trash #3/#5!)
  for (const og of sceneObjectGroups) {
    const isGroupSelected = activeObjectGroupId === og.id && !activeVolumeOrGroupId;
    const box = document.createElement("div");
    box.className = "obj-group-box" + (isGroupSelected ? " is-selected" : "");
    box.dataset.objGroupId = og.id;

    const head = document.createElement("div");
    head.className = "scene-row" + (isGroupSelected ? " selected" : "");
    head.onclick = () => {
      // Decoupled from enabled Volumes (#7 / B2): only clear volume selection highlight, NOT enabled state!
      activeVolumeOrGroupId = null;
      selectedVolumeIds.clear();
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      clearContextBar("volume");
      activeObjectGroupId = og.id;
      selectedObjectIds.clear();
      for (const mid of og.memberIds) selectedObjectIds.add(mid);
      if (cloud) cloud.syncVisualState(getEffectiveSelectedObjectIds());
      syncObjectMatrices();
      syncTransformInputs();
      renderSceneManager();
      updateColorScopeBadge();
      requestRender();
    };
    // rc11 #3.3: Right-click context menu on Object Group (single-level outermost group -> 解组 / 删除)
    head.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      activeVolumeOrGroupId = null;
      selectedVolumeIds.clear();
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      clearContextBar("volume");
      activeObjectGroupId = og.id;
      selectedObjectIds.clear();
      for (const mid of og.memberIds) selectedObjectIds.add(mid);
      renderSceneManager();
      const canDelGrpNow = sceneObjects.length - og.memberIds.length >= 1;
      showSceneMgrContextMenu(e.clientX, e.clientY, [
        { label: t("editor.scene.ctxUngroup"), onClick: () => ungroupSelectedItems() },
        { label: t("editor.scene.ctxDelete"), danger: true, disabled: !canDelGrpNow, onClick: () => deleteSceneObjectGroup(og.id) },
      ]);
    };
    // Drop object onto Object Group header to drag INTO this Object Group (or Ctrl+Drag copy into group!)
    head.ondragover = (e) => {
      if (!dragCtx || dragCtx.domain !== "object") return;
      e.preventDefault();
      e.stopPropagation();
      const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
      e.dataTransfer.dropEffect = isCopy ? "copy" : "move";
      box.classList.add("drop-target-into");
    };
    head.ondragleave = () => box.classList.remove("drop-target-into");
    head.ondrop = (e) => {
      if (!dragCtx || dragCtx.domain !== "object") return;
      e.preventDefault();
      e.stopPropagation();
      clearDragIndicators();
      const id = dragCtx.id;
      const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
      dragCtx = null;
      if (isCopy) {
        duplicateSceneObjectToTarget(id, og.id, og.memberIds.length);
      } else {
        moveSceneObject(id, og.id, og.memberIds.length);
      }
    };

    const colBtn = document.createElement("button");
    colBtn.type = "button";
    colBtn.className = "group-collapse-btn" + (og.collapsed ? " collapsed" : "");
    colBtn.innerHTML = SVG_GROUP_TRIANGLE;
    colBtn.setAttribute("aria-label", og.collapsed ? t("editor.scene.expandObjGroup") : t("editor.scene.collapseObjGroup"));
    bindTip(colBtn, {
      title: og.collapsed ? t("editor.scene.expandObjGroup") : t("editor.scene.collapseObjGroupTitle"),
      tip: t("editor.scene.collapseObjGroupTip"),
      region: "scene",
    });
    colBtn.onclick = (e) => {
      e.stopPropagation();
      og.collapsed = !og.collapsed;
      renderSceneManager();
    };

    const gName = document.createElement("span");
    gName.className = "name";
    gName.textContent = `📁 ${og.name} (${og.memberIds.length})`;
    gName.ondblclick = (e) => {
      e.stopPropagation();
      startInlineRename(gName, og.name, (next) => {
        og.name = next;
        renderSceneManager();
        syncTransformInputs();
      });
    };

    let grpPts = 0;
    let allVis = true;
    for (const mid of og.memberIds) {
      grpPts += objCounts.get(mid) || 0;
      const mObj = sceneObjects.find((o) => o.id === mid);
      if (mObj && !mObj.visible) allVis = false;
    }

    const gCnt = document.createElement("span");
    gCnt.className = "count-pill";
    gCnt.textContent = formatCompactCount(grpPts);

    const gSolo = document.createElement("button");
    gSolo.type = "button";
    const isGrpSolo = soloState && soloState.kind === "group" && soloState.targetId === og.id;
    gSolo.className = "row-btn" + (isGrpSolo ? " solo-active" : "");
    gSolo.innerHTML = SVG_SOLO;
    bindTip(gSolo, { title: t("editor.scene.soloObjGroupTitle"), tip: t("editor.scene.soloObjGroupTip"), region: "scene" });
    gSolo.onclick = (e) => { e.stopPropagation(); toggleSolo("group", og.id); };

    const gEye = document.createElement("button");
    gEye.type = "button";
    gEye.className = "row-btn" + (allVis ? "" : " off");
    gEye.textContent = allVis ? "👁" : "⊘";
    bindTip(gEye, {
      title: allVis ? t("editor.scene.hideObjGroupTitle") : t("editor.scene.showObjGroupTitle"),
      tip: t("editor.scene.toggleObjGroupTip"),
      region: "scene",
    });
    gEye.onclick = (e) => {
      e.stopPropagation();
      const nextVis = !allVis;
      for (const mid of og.memberIds) {
        const mObj = sceneObjects.find((o) => o.id === mid);
        if (mObj) {
          mObj.visible = nextVis;
          if (cloud) cloud.objectVisibility.set(mObj.id, nextVis);
        }
      }
      if (cloud) {
        modelBounds.recomputeLocalBoxes(cloud);
        updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
      }
      syncObjectMatrices();
      renderSceneManager();
      requestRender(true);
    };

    const canDelGrp = sceneObjects.length - og.memberIds.length >= 1;
    const gDel = document.createElement("button");
    gDel.type = "button";
    gDel.className = "row-btn danger";
    gDel.innerHTML = SVG_TRASH;
    gDel.disabled = !canDelGrp;
    bindTip(gDel, {
      title: t("editor.scene.deleteObjGroupTitle"),
      tip: canDelGrp ? t("editor.scene.deleteObjGroupTip") : t("editor.scene.deleteObjGroupDisabledTip"),
      region: "scene",
    });
    gDel.onclick = (e) => { e.stopPropagation(); deleteSceneObjectGroup(og.id); };

    head.append(colBtn, gName, gCnt, gSolo, gEye, gDel);
    box.appendChild(head);

    const childrenWrap = document.createElement("div");
    childrenWrap.className = "vol-group-children" + (og.collapsed ? " hidden" : "");
    og.memberIds.forEach((mid, idxInGrp) => {
      const obj = sceneObjects.find((o) => o.id === mid);
      if (obj) childrenWrap.appendChild(buildSceneObjectRow(obj, objCounts.get(obj.id) || 0, og, idxInGrp));
    });
    box.appendChild(childrenWrap);
    objList.appendChild(box);
  }

  // Render Loose Scene Objects
  sceneObjects.forEach((obj, looseIdx) => {
    if (obj.groupId) return;
    objList.appendChild(buildSceneObjectRow(obj, objCounts.get(obj.id) || 0, null, looseIdx));
  });

  // Render Volumes & Recursive Nested Volume Groups (#5, #6, #7, #10 + B2)
  const volList = $("scene-volumes-list");
  volList.innerHTML = "";
  volList.classList.toggle("expanded", volumesListExpanded);

  // Drop onto empty volumes list area pulls dragged volume/subgroup out to top-level (or Ctrl+Drag copy!)
  volList.ondragover = (e) => {
    if (!dragCtx || dragCtx.domain !== "volume") return;
    e.preventDefault();
    const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
    e.dataTransfer.dropEffect = isCopy ? "copy" : "move";
  };
  volList.ondrop = (e) => {
    if (!dragCtx || dragCtx.domain !== "volume") return;
    if (e.target !== volList) return;
    e.preventDefault();
    clearDragIndicators();
    const id = dragCtx.id;
    const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
    dragCtx = null;
    const before = volumeMgr.exportSnapshot();
    if (isCopy) {
      const cloned = volumeMgr.duplicateNode(id, null, volumeMgr.topLevelOrder.length);
      if (cloned) {
        volumeMgr.syncAllVisuals(selectedVolumeIds, cloned.id);
        pushVolumeHistory(t("editor.history.dupMoveVol", { name: cloned.name }), before, volumeMgr.exportSnapshot());
        selectVolumeOrGroup(cloned.id, false);
      }
    } else if (volumeMgr.moveNode(id, null, volumeMgr.topLevelOrder.length)) {
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      pushVolumeHistory(t("editor.history.reorderVolumes"), before, volumeMgr.exportSnapshot());
      renderSceneManager();
      syncTransformInputs();
      requestRender();
    }
  };

  const topNodes = volumeMgr.getTopLevelNodes();
  topNodes.forEach((node, idx) => {
    volList.appendChild(renderVolumeTreeNode(node, null, idx, 0));
  });

  if (topNodes.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:11px;color:var(--muted);padding:5px 6px;";
    empty.textContent = t("editor.scene.emptyVolumesHint");
    volList.appendChild(empty);
  }

  refreshListOverflowButtons();
}

function buildSceneObjectRow(obj, ptCount, parentObjGroup, idxInContainer) {
  const row = document.createElement("div");
  const isSel = selectedObjectIds.has(obj.id) && !activeVolumeOrGroupId && !activeObjectGroupId;
  row.className = "scene-row" + (isSel ? " selected" : "");
  row.dataset.objId = String(obj.id);
  row.draggable = true;

  row.ondragstart = (e) => {
    dragCtx = { domain: "object", id: obj.id, ctrlCopy: !!(e.ctrlKey || e.metaKey) };
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", String(obj.id));
    requestAnimationFrame(() => row.classList.add("dragging-lift"));
  };
  row.ondragend = () => { dragCtx = null; clearDragIndicators(); };
  row.ondragover = (e) => {
    if (!dragCtx || dragCtx.domain !== "object") return;
    const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
    if (!isCopy && dragCtx.id === obj.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isCopy ? "copy" : "move";
    const rect = row.getBoundingClientRect();
    const upper = e.clientY < rect.top + rect.height * 0.5;
    row.classList.toggle("drop-target-above", upper);
    row.classList.toggle("drop-target-below", !upper);
  };
  row.ondragleave = () => row.classList.remove("drop-target-above", "drop-target-below");
  row.ondrop = (e) => {
    if (!dragCtx || dragCtx.domain !== "object") return;
    const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
    if (!isCopy && dragCtx.id === obj.id) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = row.getBoundingClientRect();
    const upper = e.clientY < rect.top + rect.height * 0.5;
    clearDragIndicators();
    const id = dragCtx.id;
    dragCtx = null;
    const insertIdx = upper ? idxInContainer : idxInContainer + 1;
    if (isCopy) {
      duplicateSceneObjectToTarget(id, parentObjGroup ? parentObjGroup.id : null, insertIdx);
    } else {
      moveSceneObject(id, parentObjGroup ? parentObjGroup.id : null, insertIdx);
    }
  };

  // rc11 #3.2: Ctrl multi-select objects right-click menu -> [合并, 打组, 删除]
  row.oncontextmenu = (e) => {
    if (selectedObjectIds.size >= 2 && selectedObjectIds.has(obj.id)) {
      e.preventDefault();
      e.stopPropagation();
      const canDelAll = sceneObjects.length - selectedObjectIds.size >= 1;
      const canGrp = sceneObjects.filter((o) => selectedObjectIds.has(o.id) && !o.groupId).length >= 2;
      showSceneMgrContextMenu(e.clientX, e.clientY, [
        { label: t("editor.scene.ctxMerge"), onClick: () => mergeSelectedObjects() },
        { label: t("editor.scene.ctxGroup"), disabled: !canGrp, onClick: () => groupSelectedItems() },
        { label: t("editor.scene.ctxDelete"), danger: true, disabled: !canDelAll, onClick: () => deleteSelectedSceneObjects() },
      ]);
    }
  };

  row.onclick = (e) => {
    // Decoupled from enabled Volumes (#7 / B2): only clear volume selection highlight, NOT enabled state!
    activeVolumeOrGroupId = null;
    activeObjectGroupId = null;
    selectedVolumeIds.clear();
    volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
    clearContextBar("volume");
    if (e.ctrlKey || e.metaKey) {
      if (selectedObjectIds.has(obj.id)) selectedObjectIds.delete(obj.id);
      else selectedObjectIds.add(obj.id);
    } else {
      selectedObjectIds.clear();
      selectedObjectIds.add(obj.id);
    }
    if (cloud) cloud.syncVisualState(getEffectiveSelectedObjectIds());
    syncObjectMatrices(true);
    if (gizmo.object && gizmo.object !== pivot) {
      if (useBoundsCenter) syncPivotToBoundsCenter();
      else syncPivotOrientationForSpace();
      if (gizmo.visible) gizmo.attach(pivot);
      else gizmo.detach();
    }
    syncTransformInputs();
    renderSceneManager();
    updateColorScopeBadge();
    requestRender();
  };

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = (parentObjGroup ? "↳ " : "◆ ") + obj.name;
  name.ondblclick = (e) => {
    e.stopPropagation();
    startInlineRename(name, obj.name, (next) => {
      obj.name = next;
      obj.isDefaultMainName = false;
      renderSceneManager();
      syncTransformInputs();
    });
  };

  const cnt = document.createElement("span");
  cnt.className = "count-pill";
  cnt.textContent = formatCompactCount(ptCount);

  const soloBtn = document.createElement("button");
  soloBtn.type = "button";
  const isSolo = soloState && soloState.kind === "object" && soloState.targetId === obj.id;
  soloBtn.className = "row-btn" + (isSolo ? " solo-active" : "");
  soloBtn.innerHTML = SVG_SOLO;
  bindTip(soloBtn, { title: t("editor.scene.soloObjectTitle"), tip: t("editor.scene.soloObjectTip"), region: "scene" });
  soloBtn.onclick = (e) => { e.stopPropagation(); toggleSolo("object", obj.id); };

  const eye = document.createElement("button");
  eye.type = "button";
  eye.className = "row-btn" + (obj.visible ? "" : " off");
  eye.textContent = obj.visible ? "👁" : "⊘";
  bindTip(eye, {
    title: obj.visible ? t("editor.scene.hideObjectTitle") : t("editor.scene.showObjectTitle"),
    tip: t("editor.scene.toggleObjectTip"),
    region: "scene",
  });
  eye.onclick = (e) => {
    e.stopPropagation();
    obj.visible = !obj.visible;
    if (cloud) {
      cloud.objectVisibility.set(obj.id, obj.visible);
      modelBounds.recomputeLocalBoxes(cloud);
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    }
    syncObjectMatrices();
    renderSceneManager();
    requestRender(true);
  };

  const canDel = sceneObjects.length > 1;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "row-btn danger";
  del.innerHTML = SVG_TRASH;
  del.disabled = !canDel;
  bindTip(del, {
    title: t("editor.scene.deleteObjectTitle"),
    tip: canDel ? t("editor.scene.deleteObjectTip") : t("editor.scene.deleteObjectDisabledTip"),
    region: "scene",
  });
  del.onclick = (e) => { e.stopPropagation(); deleteSceneObject(obj.id); };

  row.append(name, cnt, soloBtn, eye, del);
  return row;
}

function pushVolumeHistory(label, beforeSnap, afterSnap) {
  history.push({
    label,
    undo: () => {
      volumeMgr.restoreSnapshot(beforeSnap);
      activeVolumeOrGroupId = null;
      selectedVolumeIds.clear();
      gizmo.detach();
      gizmo.visible = false;
      gizmo.enabled = false;
      clearContextBar("volume");
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      renderSceneManager();
      syncTransformInputs();
      requestRender();
    },
    redo: () => {
      volumeMgr.restoreSnapshot(afterSnap);
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      renderSceneManager();
      syncTransformInputs();
      requestRender();
    },
    journalEntry: { type: "volumes", snapshot: afterSnap },
  });
}

function makeBoolSelect(node) {
  const sel = document.createElement("select");
  sel.className = "vol-bool-select";
  for (const op of VOLUME_BOOL_OPS) {
    const opt = document.createElement("option");
    opt.value = op.id;
    opt.textContent = `${op.symbol} ${op.short}`;
    if ((node.boolOp || "union") === op.id) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onclick = (e) => e.stopPropagation();
  sel.onchange = () => {
    const before = volumeMgr.exportSnapshot();
    node.boolOp = sel.value;
    volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
    pushVolumeHistory(t("editor.history.changeBoolOp", { op: sel.value }), before, volumeMgr.exportSnapshot());
    renderSceneManager();
    requestRender();
  };
  return sel;
}

// Recursive renderer for Volume Groups (nested up to any depth) and Volume Items (#5, #6, #7, #10 + B2)
function renderVolumeTreeNode(node, parentGroup, idxInParent, depth) {
  if (node.isVolumeGroup) {
    const grp = node;
    const effEnabled = volumeMgr.isEffectivelyEnabled(grp.id);
    const isSel = selectedVolumeIds.has(grp.id) || activeVolumeOrGroupId === grp.id;

    const box = document.createElement("div");
    box.className =
      "vol-group-box" +
      (effEnabled ? " is-enabled" : "") +
      (depth > 0 ? " nested-group" : "");
    box.dataset.volGroupId = grp.id;

    const head = document.createElement("div");
    head.className = "scene-row" + (isSel ? " selected" : "");
    head.draggable = true;
    head.onclick = (e) => selectVolumeOrGroup(grp.id, e.ctrlKey || e.metaKey);

    // rc11 #3.2 & #3.3: Right-click context menu on Volume Group!
    // Multi-select (>=2 volumes/groups): [合并, 打组, 删除]
    // Single group: [打组 (omitted if outermost nested group!), 解组, 删除]
    head.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (selectedVolumeIds.size >= 2 && selectedVolumeIds.has(grp.id)) {
        showSceneMgrContextMenu(e.clientX, e.clientY, [
          { label: t("editor.scene.ctxMerge"), onClick: () => mergeSelectedVolumes() },
          { label: t("editor.scene.ctxGroup"), onClick: () => groupSelectedItems() },
          { label: t("editor.scene.ctxDelete"), danger: true, onClick: () => deleteSelectedVolumes() },
        ]);
        return;
      }
      selectVolumeOrGroup(grp.id, false);
      const isOutermostNested = !grp.parentGroupId && grp.children.some((c) => c.isVolumeGroup);
      const menuItems = [];
      if (!isOutermostNested) {
        menuItems.push({ label: t("editor.scene.ctxGroup"), onClick: () => wrapVolumeGroupInParent(grp.id) });
      }
      menuItems.push({ label: t("editor.scene.ctxUngroup"), onClick: () => ungroupSelectedItems() });
      menuItems.push({
        label: t("editor.scene.ctxDelete"),
        danger: true,
        onClick: () => deleteSelectedVolumes([grp.id]),
      });
      showSceneMgrContextMenu(e.clientX, e.clientY, menuItems);
    };

    head.ondragstart = (e) => {
      dragCtx = { domain: "volume", id: grp.id, ctrlCopy: !!(e.ctrlKey || e.metaKey) };
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("text/plain", grp.id);
      requestAnimationFrame(() => box.classList.add("dragging-lift"));
    };
    head.ondragend = () => { dragCtx = null; clearDragIndicators(); };
    head.ondragover = (e) => {
      if (!dragCtx || dragCtx.domain !== "volume") return;
      const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
      if (!isCopy && (dragCtx.id === grp.id || volumeMgr.isDescendant(dragCtx.id, grp.id))) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = isCopy ? "copy" : "move";
      const rect = head.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
      box.classList.remove("drop-target-above", "drop-target-below", "drop-target-into");
      if (relY < 0.25) box.classList.add("drop-target-above");
      else if (relY > 0.75 && !grp.collapsed) box.classList.add("drop-target-into");
      else box.classList.add("drop-target-into");
    };
    head.ondragleave = () => box.classList.remove("drop-target-above", "drop-target-below", "drop-target-into");
    head.ondrop = (e) => {
      if (!dragCtx || dragCtx.domain !== "volume") return;
      const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
      if (!isCopy && (dragCtx.id === grp.id || volumeMgr.isDescendant(dragCtx.id, grp.id))) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = head.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
      clearDragIndicators();
      const draggedId = dragCtx.id;
      dragCtx = null;
      const before = volumeMgr.exportSnapshot();
      if (isCopy) {
        const cloned = relY < 0.25
          ? volumeMgr.duplicateNode(draggedId, parentGroup ? parentGroup.id : null, idxInParent)
          : volumeMgr.duplicateNode(draggedId, grp.id, grp.children.length);
        if (cloned) {
          volumeMgr.syncAllVisuals(selectedVolumeIds, cloned.id);
          pushVolumeHistory(t("editor.history.dupMoveVol", { name: cloned.name }), before, volumeMgr.exportSnapshot());
          selectVolumeOrGroup(cloned.id, false);
        }
      } else {
        const moved = relY < 0.25
          ? volumeMgr.moveNode(draggedId, parentGroup ? parentGroup.id : null, idxInParent)
          : volumeMgr.moveNode(draggedId, grp.id, grp.children.length);
        if (moved) {
          volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
          pushVolumeHistory(t("editor.history.reorderVolGroupDrag"), before, volumeMgr.exportSnapshot());
          renderSceneManager();
          syncTransformInputs();
          requestRender();
        }
      }
    };

    const colBtn = document.createElement("button");
    colBtn.type = "button";
    colBtn.className = "group-collapse-btn" + (grp.collapsed ? " collapsed" : "");
    colBtn.innerHTML = SVG_GROUP_TRIANGLE;
    colBtn.setAttribute("aria-label", grp.collapsed ? t("editor.scene.expandVolGroup") : t("editor.scene.collapseVolGroup"));
    bindTip(colBtn, {
      title: grp.collapsed ? t("editor.scene.expandVolGroup") : t("editor.scene.collapseVolGroupTitle"),
      tip: t("editor.scene.collapseVolGroupTip"),
      region: "scene",
    });
    colBtn.onclick = (e) => {
      e.stopPropagation();
      grp.collapsed = !grp.collapsed;
      renderSceneManager();
    };

    const gName = document.createElement("span");
    gName.className = "name";
    gName.textContent = `📦 ${grp.name} (${grp.children.length})`;
    gName.ondblclick = (e) => {
      e.stopPropagation();
      startInlineRename(gName, grp.name, (next) => {
        grp.name = next;
        renderSceneManager();
        syncTransformInputs();
      });
    };

    head.append(colBtn, gName);

    // Group-to-group boolean op selector when nested at index > 0 (#6)!
    if (parentGroup && idxInParent > 0) {
      head.appendChild(makeBoolSelect(grp));
    }

    // Enable button (✓/○) ONLY on top-level Volume Groups (B2 + #6: inner members inherit ancestor enable state!)
    if (!parentGroup) {
      const gEnable = document.createElement("button");
      gEnable.type = "button";
      gEnable.className = "row-btn " + (grp.enabled ? "enable-on" : "off");
      gEnable.textContent = grp.enabled ? "✓" : "○";
      bindTip(gEnable, {
        title: grp.enabled ? t("editor.scene.disableVolGroupTitle") : t("editor.scene.enableVolGroupTitle"),
        tip: t("editor.scene.enableVolGroupTip"),
        region: "scene",
      });
      gEnable.onclick = (e) => {
        e.stopPropagation();
        const before = volumeMgr.exportSnapshot();
        grp.enabled = !grp.enabled;
        volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
        pushVolumeHistory(
          grp.enabled ? t("editor.history.enableNode", { name: grp.name }) : t("editor.history.disableNode", { name: grp.name }),
          before,
          volumeMgr.exportSnapshot(),
        );
        renderSceneManager();
        requestRender();
      };
      head.appendChild(gEnable);
    }

    const gEye = document.createElement("button");
    gEye.type = "button";
    gEye.className = "row-btn" + (grp.visible ? "" : " off");
    gEye.textContent = grp.visible ? "👁" : "⊘";
    bindTip(gEye, { title: t("editor.scene.toggleWireTitle"), tip: t("editor.scene.toggleWireTip"), region: "scene" });
    gEye.onclick = (e) => {
      e.stopPropagation();
      grp.visible = !grp.visible;
      grp.root.visible = grp.visible;
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      renderSceneManager();
      requestRender();
    };

    const gDel = document.createElement("button");
    gDel.type = "button";
    gDel.className = "row-btn danger";
    gDel.innerHTML = SVG_TRASH;
    bindTip(gDel, { title: t("editor.scene.deleteVolGroupTitle"), tip: t("editor.scene.deleteVolGroupTip"), region: "scene" });
    gDel.onclick = (e) => {
      e.stopPropagation();
      const before = volumeMgr.exportSnapshot();
      const removedIds = grp.collectAllDescendantIds(new Set([grp.id]));
      volumeMgr.removeGroup(grp.id);
      if (activeVolumeOrGroupId && removedIds.has(activeVolumeOrGroupId)) {
        activeVolumeOrGroupId = null;
        gizmo.detach();
        gizmo.visible = false;
        gizmo.enabled = false;
        clearContextBar("volume");
      }
      for (const rid of removedIds) selectedVolumeIds.delete(rid);
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      pushVolumeHistory(t("editor.history.deleteVolGroup", { name: grp.name }), before, volumeMgr.exportSnapshot());
      renderSceneManager();
      syncTransformInputs();
      requestRender();
    };

    head.append(gEye, gDel);
    box.appendChild(head);

    const childrenWrap = document.createElement("div");
    childrenWrap.className = "vol-group-children" + (grp.collapsed ? " hidden" : "");
    grp.children.forEach((child, cIdx) => {
      if (cIdx > 0) {
        const arrow = document.createElement("div");
        arrow.className = "vol-flow-arrow";
        const opInfo = VOLUME_BOOL_OPS.find((x) => x.id === (child.boolOp || "union")) || VOLUME_BOOL_OPS[0];
        arrow.textContent = t("editor.scene.volFlowArrow", { symbol: opInfo.symbol, label: opInfo.label });
        childrenWrap.appendChild(arrow);
      }
      childrenWrap.appendChild(renderVolumeTreeNode(child, grp, cIdx, depth + 1));
    });
    box.appendChild(childrenWrap);
    return box;
  }

  // Leaf VolumeItem row (NO ↑/↓ arrows #5; NO inner ○ scope toggle #6; trash icon #3; drag reorder/nest #5!)
  const v = node;
  const isSel = selectedVolumeIds.has(v.id) || activeVolumeOrGroupId === v.id;
  const isLooseEnabled = !parentGroup && v.enabled;
  const row = document.createElement("div");
  row.className = "scene-row" + (isSel ? " selected" : isLooseEnabled ? " is-enabled" : "");
  row.dataset.volId = v.id;
  row.draggable = true;
  row.onclick = (e) => selectVolumeOrGroup(v.id, e.ctrlKey || e.metaKey);

  // rc11 #3.2: Ctrl multi-select volumes right-click menu -> [合并, 打组, 删除]
  row.oncontextmenu = (e) => {
    if (selectedVolumeIds.size >= 2 && selectedVolumeIds.has(v.id)) {
      e.preventDefault();
      e.stopPropagation();
      showSceneMgrContextMenu(e.clientX, e.clientY, [
        { label: t("editor.scene.ctxMerge"), onClick: () => mergeSelectedVolumes() },
        { label: t("editor.scene.ctxGroup"), onClick: () => groupSelectedItems() },
        { label: t("editor.scene.ctxDelete"), danger: true, onClick: () => deleteSelectedVolumes() },
      ]);
    }
  };

  row.ondragstart = (e) => {
    dragCtx = { domain: "volume", id: v.id, ctrlCopy: !!(e.ctrlKey || e.metaKey) };
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", v.id);
    requestAnimationFrame(() => row.classList.add("dragging-lift"));
  };
  row.ondragend = () => { dragCtx = null; clearDragIndicators(); };
  row.ondragover = (e) => {
    if (!dragCtx || dragCtx.domain !== "volume") return;
    const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
    if (!isCopy && dragCtx.id === v.id) return;
    if (!isCopy && parentGroup && volumeMgr.isDescendant(dragCtx.id, parentGroup.id)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isCopy ? "copy" : "move";
    const rect = row.getBoundingClientRect();
    const upper = e.clientY < rect.top + rect.height * 0.5;
    row.classList.toggle("drop-target-above", upper);
    row.classList.toggle("drop-target-below", !upper);
  };
  row.ondragleave = () => row.classList.remove("drop-target-above", "drop-target-below");
  row.ondrop = (e) => {
    if (!dragCtx || dragCtx.domain !== "volume") return;
    const isCopy = !!(e.ctrlKey || e.metaKey || dragCtx.ctrlCopy);
    if (!isCopy && dragCtx.id === v.id) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = row.getBoundingClientRect();
    const upper = e.clientY < rect.top + rect.height * 0.5;
    clearDragIndicators();
    const draggedId = dragCtx.id;
    dragCtx = null;
    const before = volumeMgr.exportSnapshot();
    const insertIdx = upper ? idxInParent : idxInParent + 1;
    if (isCopy) {
      const cloned = volumeMgr.duplicateNode(draggedId, parentGroup ? parentGroup.id : null, insertIdx);
      if (cloned) {
        volumeMgr.syncAllVisuals(selectedVolumeIds, cloned.id);
        pushVolumeHistory(t("editor.history.dupMoveVol", { name: cloned.name }), before, volumeMgr.exportSnapshot());
        selectVolumeOrGroup(cloned.id, false);
      }
    } else if (volumeMgr.moveNode(draggedId, parentGroup ? parentGroup.id : null, insertIdx)) {
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      pushVolumeHistory(t("editor.history.reorderVolumesDrag"), before, volumeMgr.exportSnapshot());
      renderSceneManager();
      syncTransformInputs();
      requestRender();
    }
  };

  const iconMap = { box: "▢", ellipsoid: "◯", cylinder: "⌭", plane: "▧" };
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = `${iconMap[v.kind] || "▢"} ${v.name}`;
  name.ondblclick = (e) => {
    e.stopPropagation();
    startInlineRename(name, v.name, (next) => {
      v.name = next;
      renderSceneManager();
      syncTransformInputs();
    });
  };
  row.appendChild(name);

  if (parentGroup && idxInParent > 0) {
    row.appendChild(makeBoolSelect(v));
  }

  // Only loose (top-level) volumes display the Enable key (✓/○); group members inherit ancestor group enable (#6 + B2)
  if (!parentGroup) {
    const enBtn = document.createElement("button");
    enBtn.type = "button";
    enBtn.className = "row-btn " + (v.enabled ? "enable-on" : "off");
    enBtn.textContent = v.enabled ? "✓" : "○";
    bindTip(enBtn, {
      title: v.enabled ? t("editor.scene.disableVolTitle") : t("editor.scene.enableVolTitle"),
      tip: t("editor.scene.enableVolTip"),
      region: "scene",
    });
    enBtn.onclick = (e) => {
      e.stopPropagation();
      const before = volumeMgr.exportSnapshot();
      v.enabled = !v.enabled;
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      pushVolumeHistory(
        v.enabled ? t("editor.history.enableNode", { name: v.name }) : t("editor.history.disableNode", { name: v.name }),
        before,
        volumeMgr.exportSnapshot(),
      );
      renderSceneManager();
      requestRender();
    };
    row.appendChild(enBtn);
  }

  const eye = document.createElement("button");
  eye.type = "button";
  eye.className = "row-btn" + (v.visible ? "" : " off");
  eye.textContent = v.visible ? "👁" : "⊘";
  bindTip(eye, {
    title: v.visible ? t("editor.scene.hideVolTitle") : t("editor.scene.showVolTitle"),
    tip: t("editor.scene.toggleVolTip"),
    region: "scene",
  });
  eye.onclick = (e) => {
    e.stopPropagation();
    v.visible = !v.visible;
    v.root.visible = v.visible;
    volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
    renderSceneManager();
    requestRender();
  };

  const del = document.createElement("button");
  del.type = "button";
  del.className = "row-btn danger";
  del.innerHTML = SVG_TRASH;
  bindTip(del, { title: t("editor.scene.deleteVolTitle"), tip: t("editor.scene.deleteVolTip"), region: "scene" });
  del.onclick = (e) => {
    e.stopPropagation();
    const before = volumeMgr.exportSnapshot();
    volumeMgr.removeVolume(v.id);
    selectedVolumeIds.delete(v.id);
    if (activeVolumeOrGroupId === v.id) {
      activeVolumeOrGroupId = null;
      gizmo.detach();
      gizmo.visible = false;
      gizmo.enabled = false;
      clearContextBar("volume");
    }
    volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
    pushVolumeHistory(t("editor.history.deleteVol", { name: v.name }), before, volumeMgr.exportSnapshot());
    renderSceneManager();
    syncTransformInputs();
    requestRender();
  };

  row.append(eye, del);
  return row;
}

function selectVolumeOrGroup(id, multi, showGizmo = false) {
  if (!multi) selectedVolumeIds.clear();
  selectedVolumeIds.add(id);
  activeVolumeOrGroupId = id;
  if (pivotEditMode) setPivotEditMode(false, { silent: true });

  // Selecting a volume NEVER changes its enabled state (controlled strictly via ✓ button per B2!)
  // and NEVER clears Scene Object selection (decoupled per B2!)
  volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);

  const item = volumeMgr.getItem(id);
  const target = getPrimaryTransformNode();
  const shouldAttachGizmo = showGizmo || !item || item.kind === "plane";
  if (target && shouldAttachGizmo) {
    gizmo.attach(target);
    gizmo.setMode(gizmoMode);
    gizmo.setSpace(gizmoSpace);
    gizmo.visible = true;
    gizmo.enabled = true;
  } else {
    gizmo.detach();
    gizmo.visible = false;
    gizmo.enabled = false;
  }

  showVolumeContextBar(id);
  setToolGuide(item && item.kind === "plane" ? TOOL_GUIDES.plane : TOOL_GUIDES.volume);
  syncTransformInputs();
  renderSceneManager();
  requestRender();
}

function showVolumeContextBar(volOrGroupId) {
  const v = volumeMgr.getNode(volOrGroupId);
  if (!v) return;
  setContextBar("volume", (el) => {
    const title = document.createElement("span");
    title.className = "ctx-title";
    title.textContent = v.name;
    el.appendChild(title);

    if (v.kind === "plane") {
      const info = document.createElement("span");
      info.className = "ctx-param";
      info.textContent = t("editor.scene.planeScopeInfo");
      el.appendChild(info);
    } else {
      buildBoolButtons(
        el,
        null,
        (opId) => executeVolumeSelection(volOrGroupId, opId),
        true,
      );
      const gizBtn = document.createElement("button");
      gizBtn.className = "mini-btn" + (gizmo.visible ? " active" : "");
      gizBtn.innerHTML = `${t("editor.scene.axisBtn")} <kbd>W/E/R</kbd>`;
      bindTip(gizBtn, {
        title: t("editor.scene.toggleAxisTitle"),
        tip: t("editor.scene.toggleAxisTip"),
        key: "W/E/R",
        region: "toolbar",
      });
      gizBtn.onclick = () => {
        if (gizmo.visible) {
          gizmo.detach();
          gizmo.visible = false;
          gizmo.enabled = false;
        } else {
          const target = getPrimaryTransformNode();
          if (target) {
            gizmo.attach(target);
            gizmo.setMode(gizmoMode);
            gizmo.setSpace(gizmoSpace);
            gizmo.visible = true;
            gizmo.enabled = true;
          }
        }
        showVolumeContextBar(volOrGroupId);
        requestRender();
      };
      el.appendChild(gizBtn);
    }
  });
}

function executeVolumeSelection(volOrGroupId, op) {
  if (!cloud) return;
  const pred = volumeMgr.compileSingleOrGroup(volOrGroupId, camera.position);
  if (!pred) return;
  syncObjectMatrices();
  const tmp = new T.Vector3();
  const before = applyBooleanSelection(
    cloud,
    op,
    (i) => {
      cloud.getWorldPosition(i, tmp);
      return pred(tmp.x, tmp.y, tmp.z);
    },
    null,
    getEffectiveSelectedObjectIds(),
  );
  commitFlagDelta(t("editor.history.volumeSelect", { op: BOOL_OPS.find((x) => x.id === op)?.label || "" }), before);
}

// Group & Ungroup (supports nested Volume Groups + single-level Scene Object Groups!)
function groupSelectedItems() {
  if (selectedVolumeIds.size >= 2) {
    const before = volumeMgr.exportSnapshot();
    const grp = volumeMgr.createGroupFromItems([...selectedVolumeIds]);
    if (grp) {
      volumeMgr.syncAllVisuals(selectedVolumeIds, grp.id);
      pushVolumeHistory(t("editor.history.groupVolumes", { name: grp.name }), before, volumeMgr.exportSnapshot());
      selectVolumeOrGroup(grp.id, false);
      setStatus(t("editor.status.groupedVolumes", { count: grp.children.length, name: grp.name }));
    }
    return;
  }
  if (selectedObjectIds.size >= 2) {
    const members = sceneObjects.filter((o) => selectedObjectIds.has(o.id) && !o.groupId);
    if (members.length < 2) return;
    const grpNode = new T.Group();
    const id = "ogrp_" + nextObjGroupId++;
    const name = t("editor.scene.objectGroupName", { num: nextObjGroupId - 1 });
    grpNode.name = id;
    objectRoot.add(grpNode);
    objectRoot.updateMatrixWorld(true);
    for (const m of members) {
      grpNode.attach(m.node);
      m.groupId = id;
    }
    const og = { id, name, collapsed: false, node: grpNode, memberIds: members.map((m) => m.id) };
    sceneObjectGroups.push(og);
    activeObjectGroupId = id;
    syncObjectMatrices();
    syncTransformInputs();
    renderSceneManager();
    setStatus(t("editor.status.groupedObjects", { count: members.length, name }));
  }
}

function ungroupSelectedItems() {
  if (activeVolumeOrGroupId) {
    const grp = volumeMgr.getGroup(activeVolumeOrGroupId);
    if (grp) {
      const before = volumeMgr.exportSnapshot();
      volumeMgr.ungroup(grp.id);
      activeVolumeOrGroupId = null;
      selectedVolumeIds.clear();
      gizmo.detach();
      gizmo.visible = false;
      gizmo.enabled = false;
      clearContextBar("volume");
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      pushVolumeHistory(t("editor.history.ungroupVolumes", { name: grp.name }), before, volumeMgr.exportSnapshot());
      renderSceneManager();
      syncTransformInputs();
      requestRender();
      return;
    }
  }
  if (activeObjectGroupId) {
    const idx = sceneObjectGroups.findIndex((g) => g.id === activeObjectGroupId);
    if (idx >= 0) {
      const og = sceneObjectGroups[idx];
      objectRoot.updateMatrixWorld(true);
      for (const mid of og.memberIds) {
        const obj = sceneObjects.find((o) => o.id === mid);
        if (obj) {
          objectRoot.attach(obj.node);
          obj.groupId = null;
        }
      }
      objectRoot.remove(og.node);
      sceneObjectGroups.splice(idx, 1);
      activeObjectGroupId = null;
      syncObjectMatrices();
      syncTransformInputs();
      renderSceneManager();
      requestRender();
    }
  }
}

$("btn-group-selected").onclick = groupSelectedItems;
$("btn-ungroup-selected").onclick = ungroupSelectedItems;

// ============================================================================
// 6. Display Modes (ReSplat 3 Modes, Fig 6), Dual Camera & Selection Flag Operations
// ============================================================================
const MODE_ICONS = {
  splat: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="5.5"/></svg>`,
  centers: `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><rect x="8" y="2.2" width="8.2" height="8.2" rx="1.4" transform="rotate(45 8 2.2)"/></svg>`,
  rings: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><rect x="8" y="4.9" width="4.4" height="4.4" rx="0.8" transform="rotate(45 8 4.9)" fill="currentColor" stroke="none"/></svg>`,
};

function getDisplayModeOptions() {
  return [
    { value: "splat", label: t("editor.displayModes.splat"), iconHtml: MODE_ICONS.splat },
    { value: "centers", label: t("editor.displayModes.centers"), iconHtml: MODE_ICONS.centers },
    { value: "rings", label: t("editor.displayModes.rings"), iconHtml: MODE_ICONS.rings },
  ];
}

const displayModeDropdown = createCustomSelect({
  className: "mode-dropdown",
  placement: "down",
  accentActive: true,
  ariaLabel: t("editor.topBar.displayMode"),
  value: displayMode,
  options: getDisplayModeOptions(),
  onChange: (val) => setDisplayMode(val),
});
$("display-mode-mount").appendChild(displayModeDropdown.el);

function setDisplayMode(mode, opts = null) {
  const norm = mode === "points" ? "centers" : mode === "rings" ? "rings" : mode === "centers" ? "centers" : "splat";
  if (lowPerfSafeMode && norm !== "centers" && !(opts && opts.allowInSafeMode)) {
    displayModeDropdown.setValue("centers");
    setStatus(t("editor.status.safeModeLockCenters"));
    return;
  }
  displayMode = norm;
  displayModeDropdown.setValue(norm);
  requestRender(true);
}

function cycleDisplayMode() {
  if (lowPerfSafeMode) {
    setStatus(t("editor.status.safeModeLockCentersCycle"));
    return;
  }
  const order = ["splat", "centers", "rings"];
  setDisplayMode(order[(order.indexOf(displayMode) + 1) % order.length]);
}

function formatFlySpeedMps(v) {
  const n = Number(v) || 0;
  if (n >= 100) return `${Math.round(n)} m/s`;
  if (n >= 10) return `${n.toFixed(1)} m/s`;
  return `${n.toFixed(2)} m/s`;
}

function syncFlySpeedUI() {
  const bar = $("fly-speed-bar");
  const slider = $("fly-speed-slider");
  const out = $("fly-speed-value");
  const isFly = cameraControlMode === "fly";
  if (bar) bar.classList.toggle("hidden", !isFly);
  const cfg = camCtrl.getFlySpeedConfig();
  if (slider) {
    slider.min = String(cfg.min);
    slider.max = String(cfg.max);
    slider.step = String(cfg.step);
    slider.value = String(cfg.value);
  }
  if (out) out.textContent = formatFlySpeedMps(cfg.value);
}

$("fly-speed-slider")?.addEventListener("input", (e) => {
  const v = camCtrl.setFlySpeedMps(Number(e.target.value));
  const out = $("fly-speed-value");
  if (out) out.textContent = formatFlySpeedMps(v);
});
$("fly-speed-value")?.addEventListener("dblclick", () => {
  const cfg = camCtrl.getFlySpeedConfig();
  camCtrl.setFlySpeedMps(cfg.defaultSpeed);
  syncFlySpeedUI();
  setStatus(t("editor.status.flySpeedReset", { speed: formatFlySpeedMps(cfg.defaultSpeed) }));
});

function syncCameraModeButtons() {
  const isFly = cameraControlMode === "fly";
  $("btn-cam-orbit")?.classList.toggle("active", !isFly);
  $("btn-cam-fly")?.classList.toggle("active", isFly);
  syncFlySpeedUI();
}

function setCameraControlMode(mode) {
  const next = mode === "fly" ? "fly" : "orbit";
  camCtrl.setMode(next);
  cameraControlMode = next;
  syncCameraModeButtons();
  setStatus(
    next === "fly"
      ? t("editor.status.camFlySwitched", { speed: formatFlySpeedMps(camCtrl.flySpeedMps) })
      : t("editor.status.camOrbitSwitched"),
  );
}

$("btn-cam-orbit").onclick = () => setCameraControlMode("orbit");
$("btn-cam-fly").onclick = () => setCameraControlMode("fly");

// Keep clicks on checkboxes inside Advanced Options menu from closing the dropdown!
for (const lbl of document.querySelectorAll("#menu-advanced .menu-check-item")) {
  lbl.addEventListener("click", (e) => e.stopPropagation());
}

$("chk-show-bounds").onchange = (e) => setBoundsVisible(!!e.target.checked);
$("chk-show-grid").onchange = (e) => setGridVisible(!!e.target.checked);

let lastStatsSnapshot = null;

function updateStats(stats) {
  if (!stats) return;
  lastStatsSnapshot = stats;
  lastDeletedPointsCount = stats.deleted || 0;
  const dupAdded = Math.max(0, stats.total - (loadedSourcePoints || stats.total));
  const liveTotal = (totalSourcePoints || stats.total) + dupAdded;
  $("stat-total").textContent =
    loadedSourcePoints > 0 && loadedSourcePoints < totalSourcePoints
      ? t("editor.statusBar.totalWithRendered", { total: liveTotal.toLocaleString(), rendered: stats.total.toLocaleString() })
      : liveTotal.toLocaleString();
  $("stat-selected").textContent = stats.selected.toLocaleString();
  $("stat-deleted").textContent = stats.deleted.toLocaleString();
  // Section III.5: hide selected points counter when selection is empty!
  $("stat-selected-wrap").classList.toggle("hidden", stats.selected === 0);
  updateColorScopeBadge();
  perfHud.render(false);
}

function commitFlagDelta(label, beforeFlags, journalMeta = null) {
  if (!cloud) return 0;
  const delta = diffUint8Arrays(beforeFlags, cloud.flags);
  if (delta.changed === 0) {
    updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    return 0;
  }
  let boundsTouched = false;
  for (let i = 0; i < delta.indices.length; i++) {
    if ((delta.before[i] ^ delta.after[i]) & (FLAG_DELETED | FLAG_HIDDEN)) { boundsTouched = true; break; }
  }
  previewAdapter?.syncDeltaToSession(editSession, delta, true);
  updateStats(cloud.syncVisualStateSparse(delta.indices, getEffectiveSelectedObjectIds()));
  if (boundsTouched) {
    modelBounds.recomputeLocalBoxes(cloud);
    modelBounds.syncFromSceneObjects(sceneObjects);
  }
  requestRender(true);

  // Build compact replayable journal entry using srcIdx ranges for deleted/hidden/selected state
  let journalEntry = journalMeta;
  if (!journalEntry) {
    const deletedSet = [];
    for (let i = 0; i < delta.indices.length; i++) {
      const idx = delta.indices[i];
      if (delta.after[i] & FLAG_DELETED) deletedSet.push(cloud.srcIdx[idx]);
    }
    journalEntry = {
      type: "flagDelta",
      opLabel: label,
      delSrcRanges: encodeIndexRanges(deletedSet),
    };
  }

  history.push({
    label: t("editor.history.flagDelta", { label, count: delta.changed.toLocaleString() }),
    groupKey: boundsTouched ? "edit:visibility" : "select",
    groupLabel: boundsTouched ? t("editor.history.groupEditVis") : t("editor.history.groupSelect"),
    undo: () => {
      applyUint8Delta(cloud.flags, delta, false);
      previewAdapter?.syncDeltaToSession(editSession, delta, false);
      updateStats(cloud.syncVisualStateSparse(delta.indices, getEffectiveSelectedObjectIds()));
      if (boundsTouched) {
        modelBounds.recomputeLocalBoxes(cloud);
        modelBounds.syncFromSceneObjects(sceneObjects);
      }
      requestRender(true);
    },
    redo: () => {
      applyUint8Delta(cloud.flags, delta, true);
      previewAdapter?.syncDeltaToSession(editSession, delta, true);
      updateStats(cloud.syncVisualStateSparse(delta.indices, getEffectiveSelectedObjectIds()));
      if (boundsTouched) {
        modelBounds.recomputeLocalBoxes(cloud);
        modelBounds.syncFromSceneObjects(sceneObjects);
      }
      requestRender(true);
    },
    journalEntry,
  });
  return delta.changed;
}

function selectAllPoints() {
  if (!cloud) return;
  const scope = volumeMgr.compileActiveScope(camera.position);
  const tmp = new T.Vector3();
  const before = applyBooleanSelection(
    cloud,
    "replace",
    () => true,
    scope ? (i) => { cloud.getWorldPosition(i, tmp); return scope(tmp.x, tmp.y, tmp.z); } : null,
    getEffectiveSelectedObjectIds(),
  );
  commitFlagDelta(t("editor.history.selectAll"), before);
}

function deselectAllPoints() {
  if (!cloud) return;
  // Section VII.2: clearing selection auto-bakes any unbaked temporary color grading!
  autoBakeIfModified(t("editor.history.clearSelAutoBake"));
  const before = new Uint8Array(cloud.flags);
  for (let i = 0; i < cloud.n; i++) cloud.flags[i] &= ~FLAG_SELECTED;
  commitFlagDelta(t("editor.history.deselectAll"), before);
}

function invertSelectionPoints() {
  if (!cloud) return;
  const scope = volumeMgr.compileActiveScope(camera.position);
  const tmp = new T.Vector3();
  const before = new Uint8Array(cloud.flags);
  const activeObjs = getEffectiveSelectedObjectIds();
  for (let i = 0; i < cloud.n; i++) {
    const f = cloud.flags[i];
    if ((f & (FLAG_DELETED | FLAG_HIDDEN)) || cloud.objectVisibility.get(cloud.objectIds[i]) === false) continue;
    if (activeObjs.size > 0 && !activeObjs.has(cloud.objectIds[i])) continue;
    if (scope) {
      cloud.getWorldPosition(i, tmp);
      if (!scope(tmp.x, tmp.y, tmp.z)) continue;
    }
    cloud.flags[i] = (f & FLAG_SELECTED) ? (f & ~FLAG_SELECTED) : (f | FLAG_SELECTED);
  }
  commitFlagDelta(t("editor.history.invertSel"), before);
}

function recordSelectedScreenHoleBox() {
  if (!cloud) return;
  camera.updateMatrixWorld();
  const vp = new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = vp.elements;
  const tmp = new T.Vector3();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cnt = 0;
  const step = Math.max(1, Math.floor(cloud.n / 60000));
  for (let i = 0; i < cloud.n; i += step) {
    if ((cloud.flags[i] & FLAG_DELETED) || !(cloud.flags[i] & FLAG_SELECTED)) continue;
    cloud.getWorldPosition(i, tmp);
    const w = e[3] * tmp.x + e[7] * tmp.y + e[11] * tmp.z + e[15];
    if (w <= 1e-5) continue;
    const nx = ((e[0] * tmp.x + e[4] * tmp.y + e[8] * tmp.z + e[12]) / w + 1) * 0.5;
    const ny = (1 - (e[1] * tmp.x + e[5] * tmp.y + e[9] * tmp.z + e[13]) / w) * 0.5;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
    if (nx < x0) x0 = nx;
    if (ny < y0) y0 = ny;
    if (nx > x1) x1 = nx;
    if (ny > y1) y1 = ny;
    cnt++;
  }
  if (cnt >= 4 && x1 - x0 > 0.01 && y1 - y0 > 0.01) {
    planeInpaintEngine.recordLastHoleBox({ x0, y0, x1, y1 });
  }
}

function softDeleteSelected() {
  if (!cloud) return;
  recordSelectedScreenHoleBox();
  // Migrated vertical slice: EditSession is the single writer (ZERO pre-op full syncCloudToSession scan!)
  if (boxSelectTool && editSession && previewAdapter && cloud.n === cloud.originalCount) {
    const delLabel = t("editor.history.softDelete");
    const res = boxSelectTool.deleteSelected({ targetAssetId: currentAssetId, label: delLabel });
    if (res.changedCount > 0) {
      modelBounds.recomputeLocalBoxes(cloud);
      modelBounds.syncFromSceneObjects(sceneObjects);
      requestRender(true);
      // Zero-alloc O(N) RLE directly from EditSession flags (eliminates 30M JS Array + sort stall!)
      const delRanges = editSession.encodeFlagRanges(currentAssetId, 2);
      history.push({
        label: t("editor.history.flagDelta", { label: delLabel, count: res.changedCount.toLocaleString() }),
        undo: () => {
          boxSelectTool.undo();
          modelBounds.recomputeLocalBoxes(cloud);
          modelBounds.syncFromSceneObjects(sceneObjects);
          requestRender(true);
        },
        redo: () => {
          boxSelectTool.redo();
          modelBounds.recomputeLocalBoxes(cloud);
          modelBounds.syncFromSceneObjects(sceneObjects);
          requestRender(true);
        },
        journalEntry: {
          type: "flagDelta",
          opLabel: delLabel,
          delSrcRanges: delRanges,
        },
      });
    }
    return;
  }

  // Fallback for scenes with appended duplicated points (n > originalCount)
  const before = new Uint8Array(cloud.flags);
  let count = 0;
  for (let i = 0; i < cloud.n; i++) {
    if (!(cloud.flags[i] & FLAG_DELETED) && (cloud.flags[i] & FLAG_SELECTED)) {
      cloud.flags[i] = (cloud.flags[i] | FLAG_DELETED) & ~FLAG_SELECTED;
      count++;
    }
  }
  if (count > 0) commitFlagDelta(t("editor.history.softDelete"), before);
}

function isolateSelectedPoints() {
  if (!cloud) return;
  let anySel = false;
  for (let i = 0; i < cloud.n; i++) {
    if (!(cloud.flags[i] & FLAG_DELETED) && (cloud.flags[i] & FLAG_SELECTED)) { anySel = true; break; }
  }
  if (!anySel) { setStatus(t("editor.status.selectBeforeIsolate")); return; }
  const before = new Uint8Array(cloud.flags);
  for (let i = 0; i < cloud.n; i++) {
    if (cloud.flags[i] & FLAG_DELETED) continue;
    if (cloud.flags[i] & FLAG_SELECTED) cloud.flags[i] &= ~FLAG_HIDDEN;
    else cloud.flags[i] |= FLAG_HIDDEN;
  }
  commitFlagDelta(t("editor.history.isolate"), before);
}

function hideSelectedPoints() {
  if (!cloud) return;
  const before = new Uint8Array(cloud.flags);
  let count = 0;
  for (let i = 0; i < cloud.n; i++) {
    if (!(cloud.flags[i] & FLAG_DELETED) && (cloud.flags[i] & FLAG_SELECTED)) {
      cloud.flags[i] = (cloud.flags[i] | FLAG_HIDDEN) & ~FLAG_SELECTED;
      count++;
    }
  }
  if (count > 0) commitFlagDelta(t("editor.history.hide"), before);
}

function showAllHiddenPoints() {
  if (!cloud) return;
  const before = new Uint8Array(cloud.flags);
  for (let i = 0; i < cloud.n; i++) cloud.flags[i] &= ~FLAG_HIDDEN;
  commitFlagDelta(t("editor.history.showAll"), before);
}

function splitSelectedToObject() {
  if (!cloud) return;
  if (sceneObjects.length >= MAX_SCENE_OBJECTS) {
    setStatus(t("editor.status.maxObjectsReached", { max: MAX_SCENE_OBJECTS }));
    return;
  }
  const indices = [];
  const srcObjCount = new Map();
  for (let i = 0; i < cloud.n; i++) {
    if (!(cloud.flags[i] & FLAG_DELETED) && (cloud.flags[i] & FLAG_SELECTED)) {
      indices.push(i);
      const oid = cloud.objectIds[i];
      srcObjCount.set(oid, (srcObjCount.get(oid) || 0) + 1);
    }
  }
  if (indices.length === 0) { setStatus(t("editor.status.selectBeforeSplit")); return; }

  // Inherit transform of the dominant source object so split piece stays visually seamless
  let domObjId = 0, domMax = -1;
  for (const [oid, c] of srcObjCount.entries()) {
    if (c > domMax) { domMax = c; domObjId = oid; }
  }
  const domObj = sceneObjects.find((o) => o.id === domObjId) || sceneObjects[0];

  const newId = nextObjId++;
  const newNode = new T.Object3D();
  newNode.name = "obj_" + newId;
  domObj.node.updateMatrixWorld(true);
  domObj.node.matrixWorld.decompose(newNode.position, newNode.quaternion, newNode.scale);
  objectRoot.add(newNode);

  const newObj = {
    id: newId,
    name: t("editor.scene.splitObjectName", { num: newId }),
    visible: true,
    groupId: null,
    sourceKind: "split",
    node: newNode,
    bakedGrades: domObj.bakedGrades.map((g) => ({ targetRanges: g.targetRanges, grade: cloneGrade(g.grade) })),
  };

  const prevObjIds = new Uint8Array(indices.length);
  for (let k = 0; k < indices.length; k++) {
    prevObjIds[k] = cloud.objectIds[indices[k]];
    cloud.objectIds[indices[k]] = newId;
  }
  cloud.objectVisibility.set(newId, true);
  sceneObjects.push(newObj);
  selectedObjectIds.clear();
  selectedObjectIds.add(newId);
  activeObjectGroupId = null;

  modelBounds.recomputeLocalBoxes(cloud);
  syncObjectMatrices();
  cloud.markObjectIdsDirty();
  updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
  renderSceneManager();
  syncTransformInputs();
  requestRender(true);

  const idxArr = Uint32Array.from(indices);
  history.push({
    label: t("editor.history.splitObject", { name: newObj.name, count: indices.length.toLocaleString() }),
    undo: () => {
      for (let k = 0; k < idxArr.length; k++) cloud.objectIds[idxArr[k]] = prevObjIds[k];
      const pos = sceneObjects.indexOf(newObj);
      if (pos >= 0) sceneObjects.splice(pos, 1);
      objectRoot.remove(newNode);
      selectedObjectIds.clear();
      selectedObjectIds.add(domObj.id);
      syncObjectMatrices();
      cloud.markObjectIdsDirty();
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
      renderSceneManager();
      syncTransformInputs();
      requestRender(true);
    },
    redo: () => {
      objectRoot.add(newNode);
      sceneObjects.push(newObj);
      for (let k = 0; k < idxArr.length; k++) cloud.objectIds[idxArr[k]] = newId;
      cloud.objectVisibility.set(newId, newObj.visible);
      selectedObjectIds.clear();
      selectedObjectIds.add(newId);
      syncObjectMatrices();
      cloud.markObjectIdsDirty();
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
      renderSceneManager();
      syncTransformInputs();
      requestRender(true);
    },
    journalEntry: {
      type: "split",
      newId,
      name: newObj.name,
      srcRanges: encodeIndexRanges(indices.map((i) => cloud.srcIdx[i])),
    },
  });
}

function duplicateSelectedToObject() {
  if (!cloud) return;
  if (sceneObjects.length >= MAX_SCENE_OBJECTS) {
    setStatus(t("editor.status.maxObjectsReached", { max: MAX_SCENE_OBJECTS }));
    return;
  }
  const indices = [];
  const srcObjCount = new Map();
  for (let i = 0; i < cloud.n; i++) {
    if (!(cloud.flags[i] & FLAG_DELETED) && (cloud.flags[i] & FLAG_SELECTED)) {
      indices.push(i);
      const oid = cloud.objectIds[i];
      srcObjCount.set(oid, (srcObjCount.get(oid) || 0) + 1);
    }
  }
  if (indices.length === 0) { setStatus(t("editor.status.selectBeforeDup")); return; }

  let domObjId = 0, domMax = -1;
  for (const [oid, c] of srcObjCount.entries()) {
    if (c > domMax) { domMax = c; domObjId = oid; }
  }
  const domObj = sceneObjects.find((o) => o.id === domObjId) || sceneObjects[0];

  const newId = nextObjId++;
  const newNode = new T.Object3D();
  newNode.name = "obj_" + newId;
  domObj.node.updateMatrixWorld(true);
  domObj.node.matrixWorld.decompose(newNode.position, newNode.quaternion, newNode.scale);
  objectRoot.add(newNode);

  const newObj = {
    id: newId,
    name: t("editor.scene.dupObjectName", { num: newId }),
    visible: true,
    groupId: null,
    sourceKind: "duplicate",
    node: newNode,
    bakedGrades: domObj.bakedGrades.map((g) => ({ targetRanges: g.targetRanges, grade: cloneGrade(g.grade) })),
  };

  // Clear selection on original points so only the newly duplicated copy is selected!
  const prevFlags = new Uint8Array(cloud.flags);
  for (let i = 0; i < cloud.n; i++) cloud.flags[i] &= ~FLAG_SELECTED;

  const dupInfo = cloud.duplicatePoints(indices, newId);
  if (!dupInfo) return;

  sceneObjects.push(newObj);
  selectedObjectIds.clear();
  selectedObjectIds.add(newId);
  activeObjectGroupId = null;

  modelBounds.recomputeLocalBoxes(cloud);
  syncObjectMatrices();
  updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
  renderSceneManager();
  syncTransformInputs();
  requestRender(true);

  const savedIndices = Uint32Array.from(indices);
  history.push({
    label: t("editor.history.dupObject", { name: newObj.name, count: indices.length.toLocaleString() }),
    undo: () => {
      cloud.truncatePoints(dupInfo.oldN);
      cloud.flags.set(prevFlags);
      const pos = sceneObjects.indexOf(newObj);
      if (pos >= 0) sceneObjects.splice(pos, 1);
      objectRoot.remove(newNode);
      selectedObjectIds.clear();
      selectedObjectIds.add(domObj.id);
      syncObjectMatrices();
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
      renderSceneManager();
      syncTransformInputs();
      requestRender(true);
    },
    redo: () => {
      for (let i = 0; i < cloud.n; i++) cloud.flags[i] &= ~FLAG_SELECTED;
      cloud.duplicatePoints(savedIndices, newId);
      objectRoot.add(newNode);
      sceneObjects.push(newObj);
      selectedObjectIds.clear();
      selectedObjectIds.add(newId);
      syncObjectMatrices();
      updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
      renderSceneManager();
      syncTransformInputs();
      requestRender(true);
    },
    journalEntry: {
      type: "duplicate",
      newId,
      name: newObj.name,
      srcRanges: encodeIndexRanges(indices.map((i) => cloud.srcIdx[i])),
    },
  });
}

// ============================================================================
// 7. Tools, Special Selection Context Bars & Lazy SAM2 VRAM Management
// ============================================================================
let statusIsIdle = true;

function setToolGuide(text) {
  $("bottom-left-guide").textContent = text || TOOL_GUIDES.orbit;
}

function setStatus(text, isIdle = false) {
  statusIsIdle = !!isIdle;
  $("status-msg").textContent = text;
}

function clearSvgOverlay() {
  overlaySvg.innerHTML = "";
}

function clearMarkers() {
  while (markersGroup.children.length > 0) {
    const m = markersGroup.children[0];
    markersGroup.remove(m);
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
  }
}

function addMarkerSphere(pos, colorHex = 0xf97316, scaleMul = 1) {
  const dist = Math.max(0.2, camera.position.distanceTo(pos));
  const r = dist * 0.014 * scaleMul;
  const mesh = new T.Mesh(
    new T.SphereGeometry(r, 16, 12),
    new T.MeshBasicMaterial({ color: colorHex, depthTest: false }),
  );
  mesh.position.copy(pos);
  mesh.renderOrder = 30;
  markersGroup.add(mesh);
  return mesh;
}

function addMarkerLine(p0, p1, colorHex = 0xfacc15) {
  const line = new T.Line(
    new T.BufferGeometry().setFromPoints([p0, p1]),
    new T.LineBasicMaterial({ color: colorHex, depthTest: false }),
  );
  line.renderOrder = 29;
  markersGroup.add(line);
  return line;
}

function showSemanticOpOverlay({ visible, modeLabel = "", stage = "", note = "", visibleOrbitMode = false }) {
  const el = $("semantic-op-overlay");
  if (!el) return;
  el.classList.toggle("hidden", !visible);
  el.classList.toggle("visible-orbit-mode", !!visibleOrbitMode);
  if (visible) {
    const m = $("semantic-op-mode");
    const s = $("semantic-op-stage");
    const n = $("semantic-op-note");
    if (m && modeLabel) m.textContent = modeLabel;
    if (s && stage) s.textContent = stage;
    if (n) {
      n.textContent = note || "";
      n.classList.toggle("hidden", !note);
    }
  }
}

$("btn-semantic-cancel")?.addEventListener("click", () => {
  semanticEngine.cancel();
  showSemanticOpOverlay({ visible: false });
  setStatus(t("editor.status.semanticCanceled"));
});

function requestBundledModelsExtract() {
  if (!window.chrome?.webview) return Promise.resolve(null);
  return new Promise((resolve) => {
    bundledExtractResolver = resolve;
    postHost("ensureBundledModels");
    setTimeout(() => {
      if (bundledExtractResolver === resolve) {
        bundledExtractResolver = null;
        resolve(null);
      }
    }, 30000);
  });
}

function updateOrbitMouseMapping(tool = activeTool) {
  const isDrawTool = !isEffectiveBrowse() && (CANVAS_DRAG_TOOLS.has(tool) || tool === "poly");
  camCtrl.syncOrbitEnabled(true);
  if (isDrawTool) {
    // Left button draws selection; Right button orbits, Middle button pans, Wheel zooms!
    orbit.mouseButtons = {
      LEFT: null,
      MIDDLE: T.MOUSE.PAN,
      RIGHT: T.MOUSE.ROTATE,
    };
  } else {
    orbit.mouseButtons = {
      LEFT: T.MOUSE.ROTATE,
      MIDDLE: T.MOUSE.DOLLY,
      RIGHT: T.MOUSE.PAN,
    };
  }
}

function hideGaussianModelGizmo() {
  if (pivotEditMode) setPivotEditMode(false, { silent: true });
  if (gizmo.visible && gizmo.object === pivot) {
    gizmo.detach();
    gizmo.visible = false;
    gizmo.enabled = false;
    updateGizmoRailActive("");
  }
}

function hideBrushCursorRing() {
  const ring = $("brush-cursor-ring");
  if (ring) ring.classList.add("hidden");
  canvas.classList.remove("brush-cursor-hide");
}

function syncBrushCursorVisual() {
  const ring = $("brush-cursor-ring");
  if (!ring) return;
  const active = activeTool === "brush" && !isEffectiveBrowse() && !colorPickMode && !gizmo.dragging && !activeHandleDrag;
  canvas.classList.toggle("brush-cursor-hide", active);
  if (!active || !lastPointerClient.inside) {
    ring.classList.add("hidden");
    return;
  }
  const dia = Math.max(8, Math.round(brushRadiusPx * 2));
  ring.style.width = `${dia}px`;
  ring.style.height = `${dia}px`;
  ring.style.left = `${lastPointerClient.x}px`;
  ring.style.top = `${lastPointerClient.y}px`;
  ring.classList.remove("hidden");
}

const SVG_HINT_CURSOR = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-6.5 1.5L9.5 20 5 3Z"/></svg>`;
const SVG_HINT_WARN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12.5"/><circle cx="12" cy="16.2" r="0.8" fill="currentColor"/></svg>`;

function hideCursorHintPill() {
  const pill = $("cursor-hint-pill");
  if (pill) pill.classList.add("hidden");
}

function showCursorHintPill(clientX, clientY, { text, warn = false, swatchRgb = null }) {
  const pill = $("cursor-hint-pill");
  if (!pill) return;
  pill.classList.toggle("warn", !!warn);
  const icoHtml = swatchRgb
    ? `<span class="chp-swatch" style="background:rgb(${Math.round(swatchRgb[0] * 255)},${Math.round(swatchRgb[1] * 255)},${Math.round(swatchRgb[2] * 255)})"></span>`
    : `<span class="chp-ico">${warn ? SVG_HINT_WARN : SVG_HINT_CURSOR}</span>`;
  pill.innerHTML = `${icoHtml}<span>${text}</span>`;
  // Keep pill cleanly inside window right edge
  const r = stage.getBoundingClientRect();
  const flipLeft = clientX + 210 > r.right;
  pill.style.left = `${clientX}px`;
  pill.style.top = `${clientY}px`;
  pill.style.transform = flipLeft ? "translate(calc(-100% - 16px), -50%)" : "translate(18px, -50%)";
  pill.classList.remove("hidden");
}

function setColorPickMode(mode, { onPicked = null } = {}) {
  const next = mode === colorPickMode && !onPicked ? null : mode;
  colorPickMode = next;
  pickerEyedropCallback = next === "picker" ? onPicked : null;
  hslDragCtx = null;
  canvas.classList.toggle("eyedropper-cursor", !!colorPickMode);
  if (!colorPickMode) hideCursorHintPill();
  colorPanelUI?.syncPickModeButtons();
  colorWheelPicker.setEyedropperActive(colorPickMode === "picker");
  if (colorPickMode === "wb") {
    setStatus(t("editor.status.wbPickEnabled"));
  } else if (colorPickMode === "hsl") {
    setStatus(t("editor.status.hslPickEnabled"));
  } else if (colorPickMode === "picker") {
    setStatus(t("editor.status.colorWheelPickEnabled"));
  }
  syncBrushCursorVisual();
}

function setActiveTool(tool, { fromUserToggle = false } = {}) {
  if (lowPerfSafeMode && SAFE_MODE_FROZEN_TOOLS.has(tool)) {
    setStatus(t("editor.status.safeModeToolsFrozen"));
    return;
  }

  // Exit color eyedropper pick mode when switching tools
  if (colorPickMode) setColorPickMode(null);

  // rc8 #1: Universal shortcut/button toggle-off!
  // - Pressing the active non-orbit tool's own key/button cancels it back to pure Browse (1).
  // - Pressing 1 again while in pure Browse (1) exits Browse (1) & hides gizmo (double-click re-activates!).
  if (fromUserToggle && tool === activeTool && tool !== "autoAlign") {
    if (tool === "orbit") {
      orbitExplicitlyOff = !orbitExplicitlyOff;
      if (orbitExplicitlyOff) {
        hideGaussianModelGizmo();
        toolRailUI.syncActiveTool("orbit", false, true);
        setStatus(t("editor.status.exitedBrowse"));
      } else {
        toolRailUI.syncActiveTool("orbit", true, false);
        setStatus(t("editor.status.activatedBrowse"));
      }
      requestRender();
      return;
    }
    // Cancel active tool (2-6 / Filter / Smart / Align / Measure) back to pure Browse (1)!
    setActiveTool("orbit", { fromUserToggle: false });
    setStatus(t("editor.status.toolCanceledToBrowse"));
    return;
  }

  // B5: Browse (1) coexistence toggle ONLY when a non-basic tool is active and user presses 1
  if (tool === "orbit" && fromUserToggle && activeTool !== "orbit" && !BASIC_EXCLUSIVE_TOOLS.has(activeTool)) {
    browseCoexistActive = !browseCoexistActive;
    drawStroke = [];
    isDrawing = false;
    hoverPickPoint = null;
    hideCursorHintPill();
    clearSvgOverlay();
    toolRailUI.syncActiveTool(activeTool, browseCoexistActive, false);
    updateOrbitMouseMapping(activeTool);
    measureMgr.onToolStateChanged(activeTool, isEffectiveBrowse());
    setStatus(
      browseCoexistActive
        ? t("editor.status.browseCoexistOn", { tool: t(`editor.rail.${activeTool}`) })
        : t("editor.status.browseCoexistOff"),
    );
    requestRender();
    return;
  }

  orbitExplicitlyOff = false;

  // Whenever ANY tool other than Browse ("orbit") is activated (2-6 basic selection + Filter / Smart / Align / Measure),
  // automatically hide the Gaussian model's 3D Gizmo so it never obscures or intercepts tool interactions!
  if (tool !== "orbit") {
    hideGaussianModelGizmo();
  }

  const prevTool = activeTool;
  if (prevTool !== tool) {
    if (prevTool === "planeInpaint") {
      colorWheelPicker.close();
    }
    // rc12 #2.1: Opening any selection tool (2-6, Y, M) defaults standing op to "replace" (替换) until cancelled!
    if (STATEFUL_BOOL_TOOLS.has(tool)) {
      activeBoolOp = "replace";
    }
    // Section X: immediately release local SAM2 / LaMa VRAM when leaving AI tools!
    if (prevTool === "semanticSel" && semanticEngine.loaded) {
      semanticEngine.release().then(() => {
        setStatus(t("editor.status.leftSemanticFreed"));
      });
    }
    if (prevTool === "planeInpaint" && planeInpaintEngine.lama.loaded) {
      planeInpaintEngine.release().then(() => {
        setStatus(t("editor.status.leftInpaintFreed"));
      });
    }
  }

  activeTool = tool;
  if (tool === "orbit") {
    browseCoexistActive = true;
  } else if (BASIC_EXCLUSIVE_TOOLS.has(tool)) {
    // Strict mutual exclusion between Browse (1) and basic tools (2-6)
    browseCoexistActive = false;
  } else if (PARAM_BAR_TOOLS.has(tool) || SHIFT_BOX_TOOLS.has(tool)) {
    // Non-drag Filter parameter tools (O/K/F) AND Shift+Left-Drag box tools (M/J) keep Browse (1) active simultaneously!
    browseCoexistActive = true;
  } else {
    // Click-pick tools (Y / U / L / T) start ready to click-pick; press 1 anytime to toggle Browse coexistence!
    browseCoexistActive = false;
  }

  drawStroke = [];
  polyPoints = [];
  isDrawing = false;
  hoverPickPoint = null;
  alignAppliedState = null;
  hideCursorHintPill();
  clearSvgOverlay();

  toolRailUI.syncActiveTool(tool, browseCoexistActive, orbitExplicitlyOff);
  updateOrbitMouseMapping(tool);
  syncBrushCursorVisual();
  setToolGuide(TOOL_GUIDES[tool] || TOOL_GUIDES.orbit);

  if (tool !== "verticalAlign" && tool !== "groundAlign" && tool !== "semanticSel") {
    clearMarkers();
    alignPoints = [];
  }

  // Clear stale bars from replaced categories while allowing up to 2 different categories stacked!
  if (tool === "orbit") {
    clearContextBar("selection");
    clearContextBar("special");
    clearContextBar("smart");
    clearContextBar("align");
    clearContextBar("measure");
  } else if (["rect", "lasso", "ellipse", "poly", "brush"].includes(tool)) {
    clearContextBar("special");
    clearContextBar("smart");
    clearContextBar("align");
    clearContextBar("measure");
    showBasicSelectionContextBar();
  } else if (["eyedropper", "opacitySel", "sizeSel", "semanticSel", "floaterSel"].includes(tool)) {
    clearContextBar("selection");
    clearContextBar("smart");
    clearContextBar("align");
    clearContextBar("measure");
    if (tool === "semanticSel") {
      semanticEngine.ensureLoaded((msg) => setStatus(msg), requestBundledModelsExtract).then(() => {
        if (activeTool === "semanticSel") {
          showSpecialSelectionContextBar(tool);
          setStatus(t("editor.status.semanticReady", { status: semanticEngine.getStatusLabel() }));
        }
      });
    }
    showSpecialSelectionContextBar(tool);
  } else if (tool === "planeInpaint") {
    clearContextBar("selection");
    clearContextBar("special");
    clearContextBar("align");
    clearContextBar("measure");
    showPlaneInpaintContextBar();
  } else if (tool === "autoAlign") {
    clearContextBar("selection");
    clearContextBar("special");
    clearContextBar("smart");
    executeAutoAlign({ animated: true });
    setActiveTool("orbit");
    return;
  } else if (tool === "verticalAlign") {
    clearContextBar("selection");
    clearContextBar("special");
    clearContextBar("smart");
    clearContextBar("measure");
    alignPoints = [];
    alignFlipped = false;
    clearMarkers();
    showVerticalAlignContextBar();
  } else if (tool === "groundAlign") {
    clearContextBar("selection");
    clearContextBar("special");
    clearContextBar("smart");
    clearContextBar("measure");
    alignPoints = [];
    alignFlipped = false;
    clearMarkers();
    showGroundAlignContextBar();
  } else if (tool === "scaleCalib") {
    clearContextBar("selection");
    clearContextBar("special");
    clearContextBar("smart");
    clearContextBar("align");
    clearMarkers();
    showScaleCalibContextBar();
  } else if (tool === "smartMeasure") {
    clearContextBar("selection");
    clearContextBar("special");
    clearContextBar("smart");
    clearContextBar("align");
    clearMarkers();
    showSmartMeasureContextBar();
  }
  measureMgr.onToolStateChanged(tool, isEffectiveBrowse());
  requestRender();
}

function showBasicSelectionContextBar() {
  const names = {
    rect: t("editor.rail.rect"),
    lasso: t("editor.rail.lasso"),
    ellipse: t("editor.rail.ellipse"),
    poly: t("editor.rail.poly"),
    brush: t("editor.rail.brush"),
  };
  setContextBar("selection", (el) => {
    const title = document.createElement("span");
    title.className = "ctx-title";
    title.textContent = names[activeTool] || t("editor.contextBar.selectionFallback");
    el.appendChild(title);

    buildBoolButtons(el, getEffectiveBoolOp(), (opId) => {
      activeBoolOp = opId;
      showBasicSelectionContextBar();
    });

    if (activeTool === "brush") {
      const wrap = document.createElement("label");
      wrap.className = "ctx-param";
      wrap.innerHTML = `${t("editor.contextBar.brushRadius")} <input type="range" min="6" max="360" value="${brushRadiusPx}" /><span>${brushRadiusPx}px</span>`;
      const rng = wrap.querySelector("input");
      const out = wrap.querySelector("span");
      rng.oninput = () => {
        brushRadiusPx = Math.max(6, Math.min(360, Number(rng.value) || 24));
        out.textContent = `${brushRadiusPx}px`;
        syncBrushCursorVisual();
      };
      el.appendChild(wrap);
    }

    const chkVis = document.createElement("label");
    chkVis.className = "chk-inline";
    chkVis.innerHTML = `<input type="checkbox" ${onlyVisible ? "checked" : ""} /><span>${t("editor.contextBar.onlyVisible")}</span>`;
    chkVis.querySelector("input").onchange = (e) => { onlyVisible = e.target.checked; };
    bindTip(chkVis, { title: t("editor.contextBar.onlyVisible"), tip: t("editor.contextBar.onlyVisibleTip"), region: "toolbar" });

    const chkWhole = document.createElement("label");
    chkWhole.className = "chk-inline";
    chkWhole.innerHTML = `<input type="checkbox" ${wholeGaussian ? "checked" : ""} /><span>${t("editor.contextBar.wholeGaussian")}</span>`;
    chkWhole.querySelector("input").onchange = (e) => { wholeGaussian = e.target.checked; };
    bindTip(chkWhole, { title: t("editor.contextBar.wholeGaussian"), tip: t("editor.contextBar.wholeGaussianTip"), region: "toolbar" });

    el.append(chkVis, chkWhole);
  }, `selection:${activeTool}`);
}

// Section VI.2 strict left-to-right layout: Common Params -> Boolean Ops -> Advanced Options
function showSpecialSelectionContextBar(tool) {
  setContextBar("special", (el) => {
    const titles = {
      eyedropper: t("editor.rail.eyedropperFull"),
      opacitySel: t("editor.rail.opacitySelFull"),
      sizeSel: t("editor.rail.sizeSelFull"),
      semanticSel: t("editor.rail.semanticSelFull"),
      floaterSel: t("editor.rail.floaterSelFull"),
    };
    const title = document.createElement("span");
    title.className = "ctx-title";
    title.textContent = titles[tool];
    el.appendChild(title);

    // 1. Left: Common Parameters
    const paramsWrap = document.createElement("div");
    paramsWrap.className = "ctx-group";
    let buildAdvanced = null;

    if (tool === "eyedropper") {
      const p = specialParams.eyedropper;
      const r255 = Math.round(p.rgb[0] * 255);
      const g255 = Math.round(p.rgb[1] * 255);
      const b255 = Math.round(p.rgb[2] * 255);
      const hexStr = rgb255ToHex(r255, g255, b255);
      const swatch = document.createElement("span");
      swatch.className = "ctx-swatch";
      swatch.style.background = `rgb(${r255},${g255},${b255})`;
      // rc12 #2.4: Rich upward tooltip explaining the eyedropper sampled target color box!
      bindTip(swatch, {
        title: t("editor.contextBar.eyedropSwatchTitle"),
        tip: p.hasPicked
          ? t("editor.contextBar.eyedropSwatchTipPicked", { hex: hexStr, r: r255, g: g255, b: b255 })
          : t("editor.contextBar.eyedropSwatchTipEmpty"),
        region: "toolbar",
        placement: "top",
      });
      const tol = document.createElement("label");
      tol.className = "ctx-param";
      tol.innerHTML = `${t("editor.contextBar.tolerance")} <input type="range" min="0.02" max="0.6" step="0.01" value="${p.tolerance}" /><span>${Math.round(p.tolerance * 100)}%</span>`;
      tol.querySelector("input").oninput = (e) => {
        p.tolerance = Number(e.target.value);
        tol.querySelector("span").textContent = `${Math.round(p.tolerance * 100)}%`;
      };
      paramsWrap.append(swatch, tol);

      buildAdvanced = (pop) => {
        pop.innerHTML = `<div class="field-label">${t("editor.contextBar.colorSpace")}</div>`;
        const dd = createCustomSelect({
          className: "full-width",
          placement: "up",
          accentActive: false,
          value: p.colorSpace,
          options: [
            { value: "rgb", label: t("editor.contextBar.colorSpaceRgb") },
            { value: "hsv", label: t("editor.contextBar.colorSpaceHsv") },
          ],
          onChange: (val) => { p.colorSpace = val; },
        });
        pop.appendChild(dd.el);
      };
    } else if (tool === "opacitySel") {
      const p = specialParams.opacitySel;
      const wMin = document.createElement("label");
      wMin.className = "ctx-param";
      wMin.innerHTML = `${t("editor.contextBar.minBound")} <input type="number" min="0" max="1" step="0.02" value="${p.min}" />`;
      wMin.querySelector("input").onchange = (e) => { p.min = Math.max(0, Math.min(1, Number(e.target.value) || 0)); };
      const wMax = document.createElement("label");
      wMax.className = "ctx-param";
      wMax.innerHTML = `${t("editor.contextBar.maxBound")} <input type="number" min="0" max="1" step="0.02" value="${p.max}" />`;
      wMax.querySelector("input").onchange = (e) => { p.max = Math.max(0, Math.min(1, Number(e.target.value) || 0.15)); };
      paramsWrap.append(wMin, wMax);
    } else if (tool === "sizeSel") {
      const p = specialParams.sizeSel;
      const wMin = document.createElement("label");
      wMin.className = "ctx-param";
      wMin.innerHTML = `${t("editor.contextBar.minVal")} <input type="number" min="0" max="50" step="0.01" value="${p.min}" />`;
      wMin.querySelector("input").onchange = (e) => { p.min = Math.max(0, Number(e.target.value) || 0); };
      const wMax = document.createElement("label");
      wMax.className = "ctx-param";
      wMax.innerHTML = `${t("editor.contextBar.maxVal")} <input type="number" min="0" max="50" step="0.05" value="${p.max}" />`;
      wMax.querySelector("input").onchange = (e) => { p.max = Math.max(0, Number(e.target.value) || 0.5); };
      paramsWrap.append(wMin, wMax);

      buildAdvanced = (pop) => {
        pop.innerHTML = `<div class="field-label">${t("editor.contextBar.sizeMetric")}</div>`;
        const dd = createCustomSelect({
          className: "full-width",
          placement: "up",
          accentActive: false,
          value: p.mode,
          options: [
            { value: "max", label: t("editor.contextBar.sizeMetricMax") },
            { value: "mean", label: t("editor.contextBar.sizeMetricMean") },
            { value: "ratio", label: t("editor.contextBar.sizeMetricRatio") },
          ],
          onChange: (val) => { p.mode = val; },
        });
        pop.appendChild(dd.el);
      };
    } else if (tool === "semanticSel") {
      const p = specialParams.semanticSel;
      // 1. Dimension mode switcher: Auto (default) | 2D | 3D (switching immediately re-runs last box!)
      const modeGrp = document.createElement("div");
      modeGrp.className = "ctx-group";
      for (const [mId, mLbl, mTip] of [
        ["auto", t("editor.contextBar.semModeAuto"), t("editor.contextBar.semModeAutoTip")],
        ["2d", t("editor.contextBar.semMode2d"), t("editor.contextBar.semMode2dTip")],
        ["3d", t("editor.contextBar.semMode3d"), t("editor.contextBar.semMode3dTip")],
      ]) {
        const btn = document.createElement("button");
        btn.className = "mini-btn" + (p.mode === mId ? " active" : "");
        btn.dataset.semMode = mId;
        btn.textContent = mLbl;
        bindTip(btn, { title: t("editor.contextBar.semModeTitle", { mode: mLbl }), tip: mTip, region: "toolbar" });
        btn.onclick = () => {
          const prev = p.mode;
          p.mode = mId;
          showSpecialSelectionContextBar("semanticSel");
          if (prev !== mId && semanticEngine.hasCachedBox && (mId === "2d" || mId === "3d")) {
            runSemanticBoxAction(null, activeBoolOp, { reuseCachedBox: true });
          }
        };
        modeGrp.appendChild(btn);
      }
      paramsWrap.appendChild(modeGrp);

      // 2. Conditional 2D Depth Controls (visible in 2D mode, or when Auto resolved to 2D)
      const show2DDepth = p.mode === "2d" || (p.mode === "auto" && semanticEngine.hasCachedBox && semanticEngine.lastResolvedMode === "2d");
      if (show2DDepth) {
        const dGrp = document.createElement("div");
        dGrp.className = "ctx-group";
        const triggerRealtime2D = () => {
          if (semanticEngine.hasCachedBox && semanticEngine.lastResolvedMode === "2d") {
            const res = semanticEngine.reapplyCached2DDepth({
              op: activeBoolOp,
              depthMode: p.depthMode,
              throughDepthMeters: p.throughDepth,
              infiniteDepth: p.infiniteDepth,
            });
            if (res?.before) {
              const depthLbl =
                p.depthMode === "surface"
                  ? t("editor.contextBar.depthSurface")
                  : p.infiniteDepth
                    ? t("editor.contextBar.depthInfiniteShort")
                    : p.throughDepth.toFixed(2) + "m";
              commitFlagDelta(t("editor.history.semantic2dDepth", { depth: depthLbl }), res.before);
            }
          }
        };
        for (const [dId, dLbl] of [["surface", t("editor.contextBar.depthSurface")], ["through", t("editor.contextBar.depthThrough")]]) {
          const b = document.createElement("button");
          b.className = "mini-btn" + (p.depthMode === dId ? " active" : "");
          b.dataset.semDepth = dId;
          b.textContent = dLbl;
          b.onclick = () => {
            p.depthMode = dId;
            showSpecialSelectionContextBar("semanticSel");
            triggerRealtime2D();
          };
          dGrp.appendChild(b);
        }
        if (p.depthMode === "through") {
          const rngWrap = document.createElement("label");
          rngWrap.className = "ctx-param";
          rngWrap.innerHTML = `${t("editor.contextBar.depthThrough")} <input type="range" min="0.05" max="15" step="0.05" value="${p.throughDepth}" ${p.infiniteDepth ? "disabled" : ""} /><span>${p.infiniteDepth ? "∞" : p.throughDepth.toFixed(2) + "m"}</span>`;
          const rng = rngWrap.querySelector("input");
          const out = rngWrap.querySelector("span");
          rng.oninput = () => {
            p.throughDepth = Number(rng.value);
            out.textContent = `${p.throughDepth.toFixed(2)}m`;
            triggerRealtime2D();
          };
          const chkInf = document.createElement("label");
          chkInf.className = "chk-inline";
          chkInf.innerHTML = `<input type="checkbox" ${p.infiniteDepth ? "checked" : ""} /><span>${t("editor.contextBar.depthInfinite")}</span>`;
          chkInf.querySelector("input").onchange = (ev) => {
            p.infiniteDepth = ev.target.checked;
            showSpecialSelectionContextBar("semanticSel");
            triggerRealtime2D();
          };
          dGrp.append(rngWrap, chkInf);
        }
        paramsWrap.appendChild(dGrp);
      }

      // 3. Status pill
      const badge = document.createElement("span");
      badge.className = "ctx-param";
      badge.style.cssText = "font-size:11px;color:#fde68a;";
      badge.textContent = semanticEngine.getStatusLabel();
      paramsWrap.appendChild(badge);
    } else if (tool === "floaterSel") {
      const p = specialParams.floaterSel;
      const vox = document.createElement("label");
      vox.className = "ctx-param";
      vox.innerHTML = `${t("editor.contextBar.voxelSize")} <input type="number" min="0.01" max="5" step="0.02" value="${p.voxelSize}" />`;
      vox.querySelector("input").onchange = (e) => { p.voxelSize = Math.max(0.01, Number(e.target.value) || 0.12); };
      bindTip(vox, {
        title: t("editor.contextBar.voxelSize"),
        tip: t("editor.contextBar.voxelSizeTip"),
        region: "toolbar",
        placement: "top",
      });
      const nb = document.createElement("label");
      nb.className = "ctx-param";
      nb.innerHTML = `${t("editor.contextBar.maxNeighbors")} <input type="number" min="0" max="50" step="1" value="${p.maxNeighbors}" />`;
      nb.querySelector("input").onchange = (e) => { p.maxNeighbors = Math.max(0, Number(e.target.value) | 0); };
      bindTip(nb, {
        title: t("editor.contextBar.maxNeighbors"),
        tip: t("editor.contextBar.maxNeighborsTip"),
        region: "toolbar",
        placement: "top",
      });
      paramsWrap.append(vox, nb);

      buildAdvanced = (pop) => {
        const opLbl = document.createElement("label");
        opLbl.className = "ctx-param";
        opLbl.innerHTML = `${t("editor.contextBar.maxOpacityFilter")} <input type="number" min="0.05" max="1" step="0.05" value="${p.maxOpacity}" />`;
        opLbl.querySelector("input").onchange = (e) => { p.maxOpacity = Math.max(0.05, Math.min(1, Number(e.target.value) || 0.95)); };
        pop.appendChild(opLbl);
      };
    }

    el.appendChild(paramsWrap);

    // 2. Center: Unified Boolean Operations
    // rc12 #2.1: Eyedropper (Y) and Semantic (M) share stateful standing op ("replace" default + Ctrl=Add / Alt=Sub)!
    if (tool === "semanticSel" || tool === "eyedropper") {
      buildBoolButtons(el, getEffectiveBoolOp(), (opId) => {
        activeBoolOp = opId;
        showSpecialSelectionContextBar(tool);
        if (tool === "eyedropper" && specialParams.eyedropper.hasPicked) {
          executeSpecialSelection("eyedropper", opId);
        }
      }, false);
    } else {
      buildBoolButtons(el, null, (opId) => executeSpecialSelection(tool, opId), true);
    }

    // 3. Right: Collapsible Advanced Options (if applicable)
    if (buildAdvanced) {
      const advBtn = document.createElement("button");
      advBtn.type = "button";
      advBtn.className = "mini-btn ctx-adv-btn";
      advBtn.textContent = t("editor.contextBar.advancedUp");
      const pop = document.createElement("div");
      pop.className = "ctx-adv-popover hidden";
      pop.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      buildAdvanced(pop);
      advBtn.onclick = (e) => {
        e.stopPropagation();
        const willOpen = pop.classList.contains("hidden");
        document.querySelectorAll(".ctx-adv-popover").forEach((other) => other.classList.add("hidden"));
        pop.classList.toggle("hidden", !willOpen);
        advBtn.classList.toggle("active", willOpen);
      };
      el.append(advBtn, pop);
    }
  }, `special:${tool}`);
}

async function executeSpecialSelection(tool, op) {
  if (!cloud) return;
  syncObjectMatrices();
  const worldScopeFn = volumeMgr.compileActiveScope(camera.position);
  const activeObjectIds = getEffectiveSelectedObjectIds();

  if (tool === "eyedropper") {
    const p = specialParams.eyedropper;
    const before = runEyedropperSelection({
      cloud,
      targetRgb: p.rgb,
      tolerance: p.tolerance,
      colorSpace: p.colorSpace,
      op,
      worldScopeFn,
      activeObjectIds,
    });
    commitFlagDelta(t("editor.history.eyedropperSel", { space: p.colorSpace.toUpperCase() }), before);
  } else if (tool === "opacitySel") {
    const p = specialParams.opacitySel;
    const before = runOpacitySelection({
      cloud,
      minOpacity: p.min,
      maxOpacity: p.max,
      op,
      worldScopeFn,
      activeObjectIds,
    });
    commitFlagDelta(t("editor.history.opacitySel"), before);
  } else if (tool === "sizeSel") {
    const p = specialParams.sizeSel;
    const before = runSizeSelection({
      cloud,
      minSize: p.min,
      maxSize: p.max,
      mode: p.mode,
      op,
      worldScopeFn,
      activeObjectIds,
    });
    commitFlagDelta(t("editor.history.sizeSel"), before);
  } else if (tool === "floaterSel") {
    const p = specialParams.floaterSel;
    const before = runFloaterSelection({
      cloud,
      voxelSize: p.voxelSize,
      maxNeighbors: p.maxNeighbors,
      maxOpacity: p.maxOpacity,
      op,
      worldScopeFn,
      activeObjectIds,
    });
    commitFlagDelta(t("editor.history.floaterSel"), before);
  } else if (tool === "semanticSel") {
    if (semanticEngine.hasCachedBox) {
      await runSemanticBoxAction(null, op, { reuseCachedBox: true });
    } else {
      setStatus(t("editor.status.semanticDragHint"));
    }
  }
}

async function runSemanticBoxAction(boxNorm01, op = activeBoolOp, { reuseCachedBox = false } = {}) {
  if (!cloud) return null;
  syncObjectMatrices();
  const p = specialParams.semanticSel;
  const advPrefs = advancedMenuUI.getPrefs();
  const worldScopeFn = volumeMgr.compileActiveScope(camera.position);
  const activeObjectIds = getEffectiveSelectedObjectIds();

  watchdog.setPaused(true);
  showSemanticOpOverlay({
    visible: true,
    modeLabel: p.mode === "auto" ? t("editor.semantic.prepAuto") : t("editor.semantic.prepLocked", { mode: p.mode.toUpperCase() }),
    stage: t("editor.semantic.initStage"),
    visibleOrbitMode: false,
  });

  try {
    const res = await semanticEngine.runBoxSelection({
      cloud,
      renderer,
      camera,
      orbit,
      renderMainFrame: renderFrame,
      viewportW: stage.clientWidth,
      viewportH: stage.clientHeight,
      boxNorm01,
      modeSetting: p.mode,
      op,
      depthMode: p.depthMode,
      throughDepthMeters: p.throughDepth,
      infiniteDepth: p.infiniteDepth,
      silent3D: advPrefs.silent3D,
      viewCount3D: advPrefs.viewCount3D,
      worldScopeFn,
      activeObjectIds,
      reuseCachedBox,
      requestBundledExtractFn: requestBundledModelsExtract,
      onUiProgress: (info) => showSemanticOpOverlay({ visible: true, ...info }),
    });
    if (res && res.before) {
      const modeTxt = res.resolvedMode === "3d"
        ? t("editor.history.semantic3d", { views: res.validViews })
        : t("editor.history.semantic2d");
      commitFlagDelta(modeTxt, res.before);
      setStatus(
        t("editor.semantic.doneMsg", { mode: modeTxt, count: res.hitCount.toLocaleString(), reason: res.autoDecision?.reason || "" }) +
        (res.skippedViews > 0 ? t("editor.semantic.doneSkippedSuffix", { skipped: res.skippedViews }) : ""),
      );
      if (activeTool === "semanticSel") showSpecialSelectionContextBar("semanticSel");
    }
    return res;
  } catch (err) {
    if (err?.name === "AbortError") {
      setStatus(t("editor.status.semanticAborted"));
    } else {
      console.error("[SemanticBox] Error:", err);
      setStatus(t("editor.status.semanticFailed", { error: err?.message || String(err) }));
    }
    return null;
  } finally {
    showSemanticOpOverlay({ visible: false });
    watchdog.setPaused(false);
    requestRender(true);
  }
}

// Smart Tool: Plane Inpaint Context Bar (L0 Pure Color / L1 Fast Geometric / L2 LaMa Default, rc12 #5)
function openPlaneInpaintL0ColorPicker(anchorEl) {
  const p = specialParams.planeInpaint;
  colorWheelPicker.open({
    anchorEl,
    rgb255: p.solidColorRgb,
    placement: "top",
    onChange: (rgb255, hex) => {
      p.solidColorRgb = rgb255.slice();
      const sw = document.querySelector("#btn-inpaint-l0-color .icb-swatch");
      const hx = document.querySelector("#btn-inpaint-l0-color .icb-hex");
      if (sw) sw.style.background = hex;
      if (hx) hx.textContent = hex;
    },
    onCommit: (rgb255) => {
      p.solidColorRgb = rgb255.slice();
    },
    onRequestEyedropper: (wantActive) => {
      if (wantActive) {
        setColorPickMode("picker", {
          onPicked: (r01, g01, b01) => {
            const rgb255 = [Math.round(r01 * 255), Math.round(g01 * 255), Math.round(b01 * 255)];
            p.solidColorRgb = rgb255;
            colorWheelPicker.setRgb255(rgb255, { emitChange: true, emitCommit: true, recordRecent: true });
            setColorPickMode(null);
          },
        });
      } else {
        setColorPickMode(null);
      }
    },
  });
}

function showPlaneInpaintContextBar() {
  const p = specialParams.planeInpaint;
  setContextBar("smart", (el) => {
    const title = document.createElement("span");
    title.className = "ctx-title";
    title.textContent = t("editor.rail.planeInpaintFull");
    el.appendChild(title);

    const modeGrp = document.createElement("div");
    modeGrp.className = "ctx-group";
    for (const [mId, mLbl, mTip] of [
      ["L0", t("editor.contextBar.inpaintL0"), t("editor.contextBar.inpaintL0Tip")],
      ["L1", t("editor.contextBar.inpaintL1"), t("editor.contextBar.inpaintL1Tip")],
      ["L2", t("editor.contextBar.inpaintL2"), t("editor.contextBar.inpaintL2Tip")],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mini-btn" + (p.mode === mId ? " active" : "");
      b.dataset.inpaintMode = mId;
      b.textContent = mLbl;
      bindTip(b, { title: mLbl, tip: mTip, region: "toolbar", placement: "top" });
      b.onclick = (ev) => {
        ev.stopPropagation();
        p.mode = mId;
        showPlaneInpaintContextBar();
        if (mId === "L0") {
          const anchor = document.getElementById("btn-inpaint-l0-color") || document.querySelector('[data-inpaint-mode="L0"]');
          openPlaneInpaintL0ColorPicker(anchor);
        } else {
          colorWheelPicker.close();
        }
      };
      modeGrp.appendChild(b);
    }
    el.appendChild(modeGrp);

    if (p.mode === "L0") {
      const hex = rgb255ToHex(p.solidColorRgb[0], p.solidColorRgb[1], p.solidColorRgb[2]);
      const colBtn = document.createElement("button");
      colBtn.type = "button";
      colBtn.id = "btn-inpaint-l0-color";
      colBtn.className = "inpaint-color-btn";
      colBtn.innerHTML = `<span class="icb-swatch" style="background:${hex}"></span><span class="icb-hex">${hex}</span>`;
      bindTip(colBtn, {
        title: t("editor.contextBar.inpaintL0ColorTitle"),
        tip: t("editor.contextBar.inpaintL0ColorTip"),
        region: "toolbar",
        placement: "top",
      });
      colBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (colorWheelPicker.isOpen) colorWheelPicker.close();
        else openPlaneInpaintL0ColorPicker(colBtn);
      };
      el.appendChild(colBtn);
    }

    const fWrap = document.createElement("label");
    fWrap.className = "ctx-param";
    fWrap.innerHTML = `${t("editor.contextBar.edgeFeather")} <input type="range" min="0.05" max="0.45" step="0.01" value="${p.edgeFeather}" /><span>${Math.round(p.edgeFeather * 100)}%</span>`;
    const fRng = fWrap.querySelector("input");
    const fOut = fWrap.querySelector("span");
    fRng.oninput = () => {
      p.edgeFeather = Number(fRng.value);
      fOut.textContent = `${Math.round(p.edgeFeather * 100)}%`;
    };
    el.appendChild(fWrap);

    if (p.mode === "L2" && !planeInpaintEngine.isL2ModelInstalled()) {
      const dlBtn = document.createElement("button");
      dlBtn.className = "mini-btn active";
      dlBtn.id = "btn-inpaint-download-l2";
      dlBtn.textContent = t("editor.contextBar.downloadL2");
      bindTip(dlBtn, {
        title: t("editor.contextBar.downloadL2Title"),
        tip: t("editor.contextBar.downloadL2Tip"),
        region: "toolbar",
        placement: "top",
      });
      dlBtn.onclick = () => {
        postHost("modelDownload:lama-fp32");
        setStatus(t("editor.status.downloadL2Started"));
      };
      el.appendChild(dlBtn);
    }

    const lastHole = planeInpaintEngine.getLastHoleBox();
    if (lastHole) {
      const reuseBtn = document.createElement("button");
      reuseBtn.className = "mini-btn";
      reuseBtn.textContent = t("editor.contextBar.reuseLastHole");
      reuseBtn.onclick = () => runPlaneInpaintAction(lastHole);
      el.appendChild(reuseBtn);
    }
  }, "smart:planeInpaint");
}

async function runPlaneInpaintAction(boxNorm01) {
  if (!cloud || !boxNorm01) return null;
  if (sceneObjects.length >= MAX_SCENE_OBJECTS) {
    setStatus(t("editor.status.maxObjectsInpaint", { max: MAX_SCENE_OBJECTS }));
    return null;
  }
  syncObjectMatrices();
  const p = specialParams.planeInpaint;
  const opTitle =
    p.mode === "L0"
      ? t("editor.inpaint.opTitleL0")
      : p.mode === "L2"
        ? t("editor.inpaint.opTitleL2")
        : t("editor.inpaint.opTitleL1");
  watchdog.setPaused(true);
  showSemanticOpOverlay({
    visible: true,
    modeLabel: opTitle,
    stage: t("editor.inpaint.stageSynth"),
    visibleOrbitMode: false,
  });

  try {
    const res = await planeInpaintEngine.execute({
      cloud,
      renderer,
      camera,
      viewportW: stage.clientWidth,
      viewportH: stage.clientHeight,
      boxNorm01,
      mode: p.mode,
      solidColorRgb: p.solidColorRgb,
      edgeFeather: p.edgeFeather,
      requestBundledExtractFn: requestBundledModelsExtract,
      onProgress: ({ stage: st, note }) => {
        showSemanticOpOverlay({
          visible: true,
          modeLabel: opTitle,
          stage: st,
          note: note || "",
        });
      },
    });
    if (!res) return null;
    if (res.needDownloadL2) {
      setStatus(res.message);
      showPlaneInpaintContextBar();
      return res;
    }

    const newId = nextObjId++;
    const newNode = new T.Object3D();
    newNode.name = "obj_" + newId;
    objectRoot.add(newNode);
    const newObj = {
      id: newId,
      name: t("editor.scene.inpaintObjectName", { mode: res.mode, num: newId }),
      visible: true,
      groupId: null,
      sourceKind: "synthetic-inpaint",
      syntheticData: res.patchData,
      node: newNode,
      bakedGrades: [],
    };
    const appInfo = cloud.appendSyntheticPoints(res.patchData, newId);
    if (!appInfo) return null;

    sceneObjects.push(newObj);
    selectedObjectIds.clear();
    selectedObjectIds.add(newId);
    activeObjectGroupId = null;

    modelBounds.recomputeLocalBoxes(cloud);
    syncObjectMatrices();
    updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    renderSceneManager();
    syncTransformInputs();
    requestRender(true);

    history.push({
      label: t("editor.history.planeInpaint", { mode: res.mode, count: res.count.toLocaleString() }),
      undo: () => {
        cloud.truncatePoints(appInfo.oldN);
        const idx = sceneObjects.indexOf(newObj);
        if (idx >= 0) sceneObjects.splice(idx, 1);
        objectRoot.remove(newNode);
        selectedObjectIds.clear();
        selectedObjectIds.add(0);
        modelBounds.recomputeLocalBoxes(cloud);
        syncObjectMatrices();
        updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
        renderSceneManager();
        syncTransformInputs();
        requestRender(true);
      },
      redo: () => {
        objectRoot.add(newNode);
        sceneObjects.push(newObj);
        cloud.appendSyntheticPoints(res.patchData, newId);
        cloud.objectVisibility.set(newId, newObj.visible);
        selectedObjectIds.clear();
        selectedObjectIds.add(newId);
        modelBounds.recomputeLocalBoxes(cloud);
        syncObjectMatrices();
        updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
        renderSceneManager();
        syncTransformInputs();
        requestRender(true);
      },
    });
    setStatus(t("editor.status.inpaintDone", { mode: res.mode, count: res.count.toLocaleString() }));
    return res;
  } catch (err) {
    console.error("[PlaneInpaint] Error:", err);
    setStatus(t("editor.status.inpaintFailed", { error: err?.message || String(err) }));
    return null;
  } finally {
    showSemanticOpOverlay({ visible: false });
    watchdog.setPaused(false);
    requestRender(true);
  }
}

// ============================================================================
// 8. +Y-Up Alignment & Measurement Suite (delegated to controllers/alignment-controller.js)
// ============================================================================
alignCtrl = createAlignmentController({
  $,
  getCloud: () => cloud,
  getSceneObjects: () => sceneObjects,
  getEffectiveSelectedObjectIds,
  captureTransformSnapshot,
  applyTransformSnapshot,
  syncObjectMatrices,
  syncTransformInputs,
  fitCameraToCloud,
  requestRender,
  history,
  modelBounds,
  setContextBar,
  setStatus,
  clearMarkers,
  getAlignPoints: () => alignPoints,
  resetAlignPoints: () => { alignPoints = []; },
  getAlignAppliedState: () => alignAppliedState,
  setAlignAppliedState: (v) => { alignAppliedState = v; },
  measureMgr,
  setActiveTool,
});
const {
  cancelActiveTransformAnim,
  showAutoAlignPrompt,
  hideAutoAlignPrompt,
  applyRigidDeltaToSelectedObjects,
  executeAutoAlign,
  executeOpenCvToZUp,
  flipLastAligned180,
  showVerticalAlignContextBar,
  showGroundAlignContextBar,
  showScaleCalibContextBar,
  showSmartMeasureContextBar,
} = alignCtrl;

// ============================================================================
// 9. Camera-Raw / Lightroom Color Grading Panel, 5-Zone Histogram, Levels, HSL TAT & SH Bake
// ============================================================================
function pushColorGradeHistory(beforeGrade, afterGrade, detailLabel = "") {
  if (!beforeGrade || !afterGrade || gradesEqual(beforeGrade, afterGrade)) return false;
  const beforeSnap = cloneGrade(beforeGrade);
  const afterSnap = cloneGrade(afterGrade);
  const applySnap = (snap) => {
    liveGrade = cloneGrade(snap);
    if (liveGrade.lutName && !lutCache.has(liveGrade.lutName)) {
      loadLutPreset(liveGrade.lutName).then(() => syncLiveColorPreview());
    }
    syncColorSlidersUI();
    syncLiveColorPreview();
    syncSceneStateToSession();
  };
  syncSceneStateToSession();
  history.push({
    label: detailLabel
      ? t("editor.history.colorStepDetail", { detail: detailLabel })
      : t("editor.history.colorStep"),
    groupKey: "color",
    groupLabel: t("editor.history.groupColor"),
    undo: () => applySnap(beforeSnap),
    redo: () => applySnap(afterSnap),
  });
  return true;
}

function initColorPanelUI() {
  colorPanelUI = new ColorPanelController({
    getGrade: () => liveGrade,
    getCloud: () => cloud,
    getActiveObjectIds: () => getEffectiveSelectedObjectIds(),
    getLutRgba: () => (liveGrade.lutName ? lutCache.get(liveGrade.lutName)?.rgba || null : null),
    onChange: () => syncLiveColorPreview(),
    onCommit: (before, after, detail) => pushColorGradeHistory(before, after, detail),
    onTogglePickMode: (mode) => setColorPickMode(mode),
    getPickMode: () => colorPickMode,
  });
  loadLutManifest();
}

async function loadLutManifest() {
  const sel = $("lut-select");
  if (!sel) return;
  sel.innerHTML = `<option value="" data-is-default-lut="1">${t("editor.color.lutDefault")}</option>`;
  try {
    const res = await fetch("./luts/manifest.json");
    if (!res.ok) return;
    const list = await res.json();
    sel.innerHTML = "";
    for (const item of list) {
      const opt = document.createElement("option");
      const isDefault = item.id === "默认.png";
      opt.value = isDefault ? "" : item.id;
      if (isDefault) opt.dataset.isDefaultLut = "1";
      opt.textContent = isDefault ? t("editor.color.lutDefault") : (item.label || item.id);
      sel.appendChild(opt);
    }
  } catch {
    // Ignore if manifest unavailable
  }
  sel.onchange = async () => {
    const before = cloneGrade(liveGrade);
    liveGrade.lutName = sel.value;
    if (sel.value) await loadLutPreset(sel.value);
    syncLiveColorPreview();
    pushColorGradeHistory(before, liveGrade, "3D LUT");
  };
  const lutInt = $("lut-intensity");
  if (lutInt) {
    let lutDragBefore = null;
    const commitLutInt = () => {
      if (!lutDragBefore) return;
      const before = lutDragBefore;
      lutDragBefore = null;
      pushColorGradeHistory(before, liveGrade, "LUT");
    };
    lutInt.addEventListener("pointerdown", (e) => {
      if (e.button === 0) lutDragBefore = cloneGrade(liveGrade);
    });
    lutInt.addEventListener("pointerup", commitLutInt);
    lutInt.addEventListener("change", commitLutInt);
    lutInt.oninput = (e) => {
      if (!lutDragBefore) lutDragBefore = cloneGrade(liveGrade);
      liveGrade.lutIntensity = Number(e.target.value);
      $("lut-intensity-v").textContent = Math.round(liveGrade.lutIntensity * 100) + "%";
      syncLiveColorPreview();
    };
  }
}

async function loadLutPreset(filename) {
  if (!filename || filename === "默认.png") return null;
  if (lutCache.has(filename)) return lutCache.get(filename);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 16;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, 256, 16);
      const rgba = new Uint8Array(ctx.getImageData(0, 0, 256, 16).data);
      const tex = new T.DataTexture(rgba, 256, 16, T.RGBAFormat, T.UnsignedByteType);
      tex.minFilter = T.LinearFilter;
      tex.magFilter = T.LinearFilter;
      tex.wrapS = T.ClampToEdgeWrapping;
      tex.wrapT = T.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.needsUpdate = true;
      const entry = { tex, rgba };
      lutCache.set(filename, entry);
      resolve(entry);
    };
    img.onerror = () => resolve(null);
    img.src = `./luts/${encodeURIComponent(filename)}`;
  });
}

function syncColorSlidersUI() {
  colorPanelUI?.syncUI();
}

function updateColorScopeBadge() {
  if (!cloud) return;
  let selCnt = 0;
  for (let i = 0; i < cloud.n; i++) {
    if (!(cloud.flags[i] & FLAG_DELETED) && (cloud.flags[i] & FLAG_SELECTED)) selCnt++;
  }
  $("color-scope-badge").textContent =
    selCnt > 0
      ? t("editor.color.scopeSelection", { count: selCnt.toLocaleString() })
      : t("editor.color.scopeObjects", { count: getEffectiveSelectedObjectIds().size });
}

function syncLiveColorPreview() {
  if (!cloud) return;
  const active = isGradeModified(liveGrade, { forBake: false });
  const lutEntry = liveGrade.lutName ? lutCache.get(liveGrade.lutName) : null;
  cloud.setColorGradeUniforms(
    liveGrade,
    active,
    compareOriginalHold,
    splitCompareActive ? splitCompareX : -1.0,
    lutEntry ? lutEntry.tex : null,
    lutEntry ? lutEntry.rgba : null,
  );
  if (colorPanelOpen) {
    colorPanelUI?.redrawHistogram();
  }
  requestRender();
}

function resetLiveColorGrade() {
  liveGrade = createDefaultGrade();
  if (colorPickMode) setColorPickMode(null);
  compareOriginalHold = false;
  splitCompareActive = false;
  $("split-divider").classList.add("hidden");
  $("btn-compare-split").classList.remove("active");
  syncColorSlidersUI();
  syncLiveColorPreview();
}

function bakeCurrentColorGrade(customLabel = null) {
  const effLabel = customLabel || t("editor.history.colorBakeDefault");
  if (!cloud || !isGradeModified(liveGrade, { forBake: true })) return false;
  if (liveGrade.pointColor) liveGrade.pointColor.visualizeRange = false;
  if (colorPickMode) setColorPickMode(null);
  const gradeSnapshot = cloneGrade(liveGrade);
  const lutEntry = gradeSnapshot.lutName ? lutCache.get(gradeSnapshot.lutName) : null;
  const activeObjs = getEffectiveSelectedObjectIds();

  const delta = cloud.bakeColorGrade(gradeSnapshot, activeObjs, lutEntry ? lutEntry.rgba : null);
  if (!delta) return false;

  // Record parametric grade onto affected Scene Objects so offline export bakes DC + SH1-3 + Opacity!
  const gradeRecordsAdded = [];
  if (delta.hasSelectionScope) {
    // Group baked indices by objectId
    const byObj = new Map();
    for (let k = 0; k < delta.indices.length; k++) {
      const pt = delta.indices[k];
      const oid = cloud.objectIds[pt];
      let arr = byObj.get(oid);
      if (!arr) { arr = []; byObj.set(oid, arr); }
      arr.push(cloud.srcIdx[pt]);
    }
    for (const [oid, srcList] of byObj.entries()) {
      const obj = sceneObjects.find((o) => o.id === oid);
      if (!obj) continue;
      const rec = { targetRanges: encodeIndexRanges(srcList), grade: gradeSnapshot };
      obj.bakedGrades.push(rec);
      gradeRecordsAdded.push({ obj, rec });
    }
  } else {
    for (const obj of sceneObjects) {
      if (activeObjs.size > 0 && !activeObjs.has(obj.id)) continue;
      const rec = { targetRanges: "all", grade: gradeSnapshot };
      obj.bakedGrades.push(rec);
      gradeRecordsAdded.push({ obj, rec });
    }
  }

  resetLiveColorGrade();

  history.push({
    label: t("editor.history.flagDelta", { label: effLabel, count: delta.indices.length.toLocaleString() }),
    groupKey: "color",
    groupLabel: t("editor.history.groupColor"),
    undo: () => {
      cloud.applyBakedColorDelta(delta, false);
      for (const { obj, rec } of gradeRecordsAdded) {
        const i = obj.bakedGrades.indexOf(rec);
        if (i >= 0) obj.bakedGrades.splice(i, 1);
      }
      liveGrade = cloneGrade(gradeSnapshot);
      syncColorSlidersUI();
      syncLiveColorPreview();
      requestRender();
    },
    redo: () => {
      cloud.applyBakedColorDelta(delta, true);
      for (const { obj, rec } of gradeRecordsAdded) {
        obj.bakedGrades.push(rec);
      }
      resetLiveColorGrade();
      requestRender();
    },
    journalEntry: {
      type: "colorBake",
      grade: gradeSnapshot,
      objectIds: gradeRecordsAdded.map((x) => x.obj.id),
      hasSelectionScope: delta.hasSelectionScope,
      srcRanges: delta.hasSelectionScope
        ? encodeIndexRanges(Array.from(delta.indices, (i) => cloud.srcIdx[i]))
        : "all",
    },
  });
  return true;
}

function autoBakeIfModified(reason) {
  if (isGradeModified(liveGrade, { forBake: true })) {
    bakeCurrentColorGrade(reason);
  }
}

function toggleColorPanel(forceState = null) {
  const next = forceState !== null ? !!forceState : !colorPanelOpen;
  if (lowPerfSafeMode && next) {
    setStatus(t("editor.status.safeModeColorFrozen"));
    return;
  }
  if (colorPanelOpen && !next) {
    if (colorPickMode) setColorPickMode(null);
  }
  colorPanelOpen = next;
  $("color-grade-card").classList.toggle("hidden", !colorPanelOpen);
  $("btn-color-panel").classList.toggle("active", colorPanelOpen);
  if (colorPanelOpen) {
    updateColorScopeBadge();
    syncColorSlidersUI();
    syncLiveColorPreview();
  }
}

$("btn-color-panel").onclick = () => toggleColorPanel();
$("btn-color-reset").onclick = () => {
  const before = cloneGrade(liveGrade);
  resetLiveColorGrade();
  pushColorGradeHistory(before, liveGrade, t("editor.color.resetAll"));
};

// Hold Before/After compare button
const holdCompareBtn = $("btn-compare-hold");
holdCompareBtn.onpointerdown = () => {
  compareOriginalHold = true;
  holdCompareBtn.classList.add("active");
  syncLiveColorPreview();
};
const endHoldCompare = () => {
  if (!compareOriginalHold) return;
  compareOriginalHold = false;
  holdCompareBtn.classList.remove("active");
  syncLiveColorPreview();
};
holdCompareBtn.onpointerup = endHoldCompare;
holdCompareBtn.onpointerleave = endHoldCompare;

function toggleSplitCompare() {
  splitCompareActive = !splitCompareActive;
  $("btn-compare-split").classList.toggle("active", splitCompareActive);
  $("split-divider").classList.toggle("hidden", !splitCompareActive);
  if (splitCompareActive) $("split-divider").style.left = `${splitCompareX * 100}%`;
  syncLiveColorPreview();
}
$("btn-compare-split").onclick = toggleSplitCompare;

// Draggable Split Divider
let draggingSplit = false;
$("split-divider").addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  draggingSplit = true;
  $("split-divider").setPointerCapture(e.pointerId);
});
window.addEventListener("pointermove", (e) => {
  if (!draggingSplit) return;
  const r = stage.getBoundingClientRect();
  splitCompareX = Math.max(0.05, Math.min(0.95, (e.clientX - r.left) / Math.max(1, r.width)));
  $("split-divider").style.left = `${splitCompareX * 100}%`;
  syncLiveColorPreview();
});
window.addEventListener("pointerup", () => { draggingSplit = false; });

// ============================================================================
// 10. Pointer Interaction: 6-Face Volume Handles, 2D Selections, GPU Pick, Double-Click Pivot
// ============================================================================
const raycaster = new T.Raycaster();
let pointerDownPos = null;
let isDrawing = false;
let drawStroke = [];
let polyPoints = [];

// Spirula-style 6-face volume drag state
let activeHandleDrag = null;

function screenToNdc(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return [
    ((clientX - r.left) / Math.max(1, r.width)) * 2 - 1,
    -((clientY - r.top) / Math.max(1, r.height)) * 2 + 1,
  ];
}

function screenToNorm01(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))),
    Math.max(0, Math.min(1, (clientY - r.top) / Math.max(1, r.height))),
  ];
}

function pickWorldPointAtCursor(clientX, clientY) {
  if (!cloud) return null;
  const [nx, ny] = screenToNorm01(clientX, clientY);
  const idx = cloud.pickSinglePoint(
    renderer,
    camera,
    stage.clientWidth,
    stage.clientHeight,
    nx,
    ny,
    displayMode,
    6,
  );
  if (idx >= 0) {
    const wp = new T.Vector3();
    cloud.getWorldPosition(idx, wp);
    return { idx, worldPos: wp, nx, ny };
  }
  // Fallback: intersect XZ ground plane Y = 0
  const [ndcX, ndcY] = screenToNdc(clientX, clientY);
  raycaster.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
  const hit = new T.Vector3();
  if (raycaster.ray.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0), 0), hit)) {
    return { idx: -1, worldPos: hit, nx, ny };
  }
  return null;
}

function pickGaussianOnlyAtCursor(clientX, clientY, { cached = true } = {}) {
  if (!cloud) return null;
  const [nx, ny] = screenToNorm01(clientX, clientY);
  const idx = cached
    ? cloud.pickSinglePointCached(renderer, camera, stage.clientWidth, stage.clientHeight, nx, ny, displayMode, 6)
    : cloud.pickSinglePoint(renderer, camera, stage.clientWidth, stage.clientHeight, nx, ny, displayMode, 6);
  if (idx >= 0) {
    const wp = new T.Vector3();
    cloud.getWorldPosition(idx, wp);
    return { idx, worldPos: wp, nx, ny };
  }
  return null;
}

function projectWorldToOverlayPx(worldPos) {
  const r = stage.getBoundingClientRect();
  const p = worldPos.clone().project(camera);
  if (p.z < -1.0 || p.z > 1.0) return null;
  return [((p.x + 1) * 0.5) * r.width, ((1 - p.y) * 0.5) * r.height];
}

// Fig 4 Spatial Guides SVG Layer (red white-ring dots + crisp white lines + warm-orange translucent triangle for U/L)
function updateSpatialToolGuidesOverlay() {
  const ns = "http://www.w3.org/2000/svg";
  let grp = overlaySvg.querySelector("#spatial-guides-layer");
  const isAlignSpatial = (activeTool === "verticalAlign" || activeTool === "groundAlign") && !isEffectiveBrowse() && !colorPickMode;
  if (!isAlignSpatial) {
    if (grp) grp.remove();
    return;
  }
  if (!grp) {
    grp = document.createElementNS(ns, "g");
    grp.id = "spatial-guides-layer";
    overlaySvg.appendChild(grp);
  }
  grp.innerHTML = "";

  const pts3D = alignPoints;
  const livePt = hoverPickPoint && !alignAppliedState ? hoverPickPoint.worldPos : null;

  const projPlaced = pts3D.map((p) => projectWorldToOverlayPx(p)).filter(Boolean);
  const projLive = livePt ? projectWorldToOverlayPx(livePt) : null;

  const addLine = (a, b, dashed = false) => {
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", a[0].toFixed(1));
    ln.setAttribute("y1", a[1].toFixed(1));
    ln.setAttribute("x2", b[0].toFixed(1));
    ln.setAttribute("y2", b[1].toFixed(1));
    ln.setAttribute("stroke", "#ffffff");
    ln.setAttribute("stroke-width", dashed ? "1.6" : "2.2");
    ln.setAttribute("stroke-linecap", "round");
    if (dashed) {
      ln.setAttribute("stroke-dasharray", "5,4");
      ln.setAttribute("stroke-opacity", "0.82");
    }
    grp.appendChild(ln);
  };

  const addDot = (p, isPreview = false) => {
    const outer = document.createElementNS(ns, "circle");
    outer.setAttribute("cx", p[0].toFixed(1));
    outer.setAttribute("cy", p[1].toFixed(1));
    outer.setAttribute("r", isPreview ? "4.6" : "6.2");
    outer.setAttribute("fill", isPreview ? "rgba(239,68,68,0.85)" : "#ef4444");
    outer.setAttribute("stroke", "#ffffff");
    outer.setAttribute("stroke-width", isPreview ? "1.8" : "2.4");
    grp.appendChild(outer);
  };

  if (activeTool === "groundAlign") {
    // Filled translucent warm-orange triangle when 3 pts placed OR 2 pts + live hover! (Exact Fig 4 style!)
    const triPts = projPlaced.length >= 3
      ? projPlaced.slice(0, 3)
      : (projPlaced.length === 2 && projLive ? [projPlaced[0], projPlaced[1], projLive] : null);
    if (triPts) {
      const poly = document.createElementNS(ns, "polygon");
      poly.setAttribute("points", triPts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" "));
      poly.setAttribute("fill", "rgba(217, 119, 6, 0.44)");
      poly.setAttribute("stroke", "#ffffff");
      poly.setAttribute("stroke-width", "2.1");
      poly.setAttribute("stroke-linejoin", "round");
      grp.appendChild(poly);
    } else if (projPlaced.length === 2) {
      addLine(projPlaced[0], projPlaced[1], false);
    } else if (projPlaced.length === 1 && projLive) {
      addLine(projPlaced[0], projLive, true);
    }
    for (const p of projPlaced) addDot(p, false);
    if (projLive && projPlaced.length < 3) addDot(projLive, true);
  } else if (activeTool === "verticalAlign") {
    if (projPlaced.length >= 2) addLine(projPlaced[0], projPlaced[1], false);
    else if (projPlaced.length === 1 && projLive) addLine(projPlaced[0], projLive, true);
    for (const p of projPlaced) addDot(p, false);
    if (projLive && projPlaced.length < 2) addDot(projLive, true);
  }
}

function updateSvgDrawOverlay() {
  clearSvgOverlay();
  const r = stage.getBoundingClientRect();
  const toPx = (p) => [((p[0] + 1) * 0.5) * r.width, ((1 - p[1]) * 0.5) * r.height];
  const ns = "http://www.w3.org/2000/svg";

  if ((activeTool === "rect" || activeTool === "semanticSel" || activeTool === "planeInpaint") && drawStroke.length >= 2) {
    const a = toPx(drawStroke[0]);
    const b = toPx(drawStroke[drawStroke.length - 1]);
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", Math.min(a[0], b[0]));
    rect.setAttribute("y", Math.min(a[1], b[1]));
    rect.setAttribute("width", Math.abs(b[0] - a[0]));
    rect.setAttribute("height", Math.abs(b[1] - a[1]));
    if (activeTool === "semanticSel") {
      rect.setAttribute("fill", "rgba(250,204,21,0.14)");
      rect.setAttribute("stroke", "#facc15");
    } else if (activeTool === "planeInpaint") {
      rect.setAttribute("fill", "rgba(16,185,129,0.15)");
      rect.setAttribute("stroke", "#10b981");
    } else {
      rect.setAttribute("fill", "rgba(249,115,22,0.16)");
      rect.setAttribute("stroke", "#f97316");
    }
    rect.setAttribute("stroke-width", "1.8");
    rect.setAttribute("stroke-dasharray", "5,3");
    overlaySvg.appendChild(rect);
  } else if (activeTool === "ellipse" && drawStroke.length >= 2) {
    const a = toPx(drawStroke[0]);
    const b = toPx(drawStroke[drawStroke.length - 1]);
    const ell = document.createElementNS(ns, "ellipse");
    ell.setAttribute("cx", (a[0] + b[0]) * 0.5);
    ell.setAttribute("cy", (a[1] + b[1]) * 0.5);
    ell.setAttribute("rx", Math.abs(b[0] - a[0]) * 0.5);
    ell.setAttribute("ry", Math.abs(b[1] - a[1]) * 0.5);
    ell.setAttribute("fill", "rgba(249,115,22,0.16)");
    ell.setAttribute("stroke", "#f97316");
    ell.setAttribute("stroke-width", "1.6");
    ell.setAttribute("stroke-dasharray", "5,3");
    overlaySvg.appendChild(ell);
  } else if ((activeTool === "lasso" || activeTool === "brush") && drawStroke.length >= 2) {
    const pts = drawStroke.map((p) => toPx(p).join(",")).join(" ");
    const el = document.createElementNS(ns, activeTool === "lasso" ? "polygon" : "polyline");
    el.setAttribute("points", pts);
    el.setAttribute("fill", activeTool === "lasso" ? "rgba(249,115,22,0.16)" : "none");
    if (activeTool === "lasso") el.setAttribute("fill-rule", "nonzero");
    el.setAttribute("stroke", "#f97316");
    el.setAttribute("stroke-width", activeTool === "brush" ? String(brushRadiusPx * 2) : "1.6");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("stroke-opacity", activeTool === "brush" ? "0.35" : "1");
    overlaySvg.appendChild(el);
  } else if (activeTool === "poly" && polyPoints.length >= 1) {
    const pts = polyPoints.map((p) => toPx(p).join(",")).join(" ");
    const pl = document.createElementNS(ns, "polyline");
    pl.setAttribute("points", pts);
    pl.setAttribute("fill", "rgba(249,115,22,0.12)");
    pl.setAttribute("fill-rule", "nonzero");
    pl.setAttribute("stroke", "#f97316");
    pl.setAttribute("stroke-width", "1.6");
    overlaySvg.appendChild(pl);
    for (let i = 0; i < polyPoints.length; i++) {
      const [px, py] = toPx(polyPoints[i]);
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", px);
      dot.setAttribute("cy", py);
      dot.setAttribute("r", i === 0 ? "5" : "3.5");
      dot.setAttribute("fill", i === 0 ? "#facc15" : "#f97316");
      overlaySvg.appendChild(dot);
    }
  }
  updateSpatialToolGuidesOverlay();
}

function effectivePointerBoolOp(e) {
  return getEffectiveBoolOp(e);
}

function finalizeScreenSelection(kind, path, e) {
  if (!cloud || path.length < 2) return;
  syncObjectMatrices();
  const r = stage.getBoundingClientRect();
  const aspect = Math.max(0.1, r.width / Math.max(1, r.height));
  const op = effectivePointerBoolOp(e);
  const worldScopeFn = volumeMgr.compileActiveScope(camera.position);

  // Migrated vertical slice: EditSession is the single writer (ZERO pre-op full syncCloudToSession scan!)
  if (kind === "rect" && boxSelectTool && editSession && previewAdapter && cloud.n === cloud.originalCount) {
    const a = path[0];
    const b = path[path.length - 1];
    const rectNdc = {
      minX: Math.min(a[0], b[0]),
      maxX: Math.max(a[0], b[0]),
      minY: Math.min(a[1], b[1]),
      maxY: Math.max(a[1], b[1]),
    };
    const res = boxSelectTool.selectBox({
      rectNdc,
      op,
      onlyVisible,
      wholeGaussian,
      targetAssetId: currentAssetId,
      worldScopeFn,
      activeObjectIds: getEffectiveSelectedObjectIds(),
    });
    if (res.changedCount > 0) {
      requestRender(true);
      history.push({
        label: t("editor.history.flagDelta", { label: res.label, count: res.changedCount.toLocaleString() }),
        undo: () => {
          boxSelectTool.undo();
          requestRender(true);
        },
        redo: () => {
          boxSelectTool.redo();
          requestRender(true);
        },
        journalEntry: { type: "flagDelta", opLabel: res.label, delSrcRanges: [] },
      });
    }
    return;
  }

  const before = runScreenSelection({
    cloud,
    renderer,
    camera,
    viewportW: r.width,
    viewportH: r.height,
    displayMode,
    kind,
    path,
    op,
    aspect,
    brushRadiusNdc: (brushRadiusPx / Math.max(1, r.height)) * 2,
    onlyVisible,
    wholeGaussian,
    worldScopeFn,
    activeObjectIds: getEffectiveSelectedObjectIds(),
  });
  const opLbl = BOOL_OPS.find((x) => x.id === op)?.label || op;
  commitFlagDelta(t("editor.history.selectOp", { op: opLbl }), before);
}

// Capture-phase intercept BEFORE OrbitControls:
// 1) Color Panel WB & Lightroom HSL TAT Eyedroppers
// 2) Ctrl + Left-Click Box-Drag for Semantic Selection (M) & Plane Inpaint (J) (rc8 #1)
canvas.addEventListener("pointerdown", (e) => {
  lastCanvasPointerCtrl = !!(e.ctrlKey || e.metaKey);
  if (e.button !== 0) return;

  // Color Panel Eyedroppers (White Balance / Lightroom HSL TAT)
  if (colorPickMode && cloud) {
    e.stopImmediatePropagation();
    e.preventDefault();
    const hit = pickGaussianOnlyAtCursor(e.clientX, e.clientY, { cached: true });
    if (!hit) {
      showCursorHintPill(e.clientX, e.clientY, { text: t("editor.status.noSceneHit"), warn: true });
      return;
    }
    const [r, g, b] = cloud.getRgba01(hit.idx);
    if (colorPickMode === "picker") {
      if (typeof pickerEyedropCallback === "function") {
        pickerEyedropCallback(r, g, b);
      } else {
        setColorPickMode(null);
      }
      setStatus(t("editor.status.colorWheelPicked"));
      return;
    }
    if (colorPickMode === "wb") {
      const before = cloneGrade(liveGrade);
      const { temperature, tintShift } = computeWhiteBalanceFromRgb(r, g, b);
      liveGrade.temperature = temperature;
      liveGrade.tintShift = tintShift;
      liveGrade.wbPreset = "custom";
      setColorPickMode(null);
      syncColorSlidersUI();
      syncLiveColorPreview();
      pushColorGradeHistory(before, liveGrade, t("editor.color.wbLabel"));
      setStatus(t("editor.status.wbCalibrated"));
      return;
    }
    if (colorPickMode === "hsl") {
      const before = cloneGrade(liveGrade);
      const hsl = rgb2hsl(r, g, b);
      const pc = liveGrade.pointColor;
      pc.enabled = true;
      pc.targetRgb = [r, g, b];
      pc.targetHsl = hsl;
      const band = colorPanelUI?.selectHslBandForHue(hsl[0]);
      const chan = colorPanelUI?.hslTargetChannel || "sat";
      hslDragCtx = {
        beforeGrade: before,
        chan,
        bandLabel: band?.label || t("editor.color.pickedColorFallback"),
        rgb: [r, g, b],
        startX: e.clientX,
        startY: e.clientY,
        startVal: Number(pc[chan]) || 0,
      };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      syncColorSlidersUI();
      syncLiveColorPreview();
      return;
    }
  }

  // Smart Measurement 3D Handle Drag (Vertex / Base Plane Height / Peak Pole — intercepts BEFORE OrbitControls!)
  if (activeTool === "smartMeasure" && !isEffectiveBrowse() && !gizmo.dragging && measureMgr.handlePointerDownCapture(e)) {
    closeAllMenus();
    e.stopImmediatePropagation();
    e.preventDefault();
    camCtrl.syncOrbitEnabled(false);
    isInteracting = true;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    return;
  }

  // Shift + Left-Click Drag for Semantic Selection (M) & Plane Inpaint (J) (rc12 #2.1: leaves Ctrl=Add & Alt=Sub conflict-free!)
  // Plane Inpaint also accepts Ctrl+Left-Drag as ergonomic fallback since J has no boolean mode modifiers.
  const triggerShiftBox =
    (activeTool === "semanticSel" && e.shiftKey) ||
    (activeTool === "planeInpaint" && (e.shiftKey || e.ctrlKey || e.metaKey));
  if (triggerShiftBox) {
    closeAllMenus();
    e.stopImmediatePropagation();
    e.preventDefault();
    const [ndcX, ndcY] = screenToNdc(e.clientX, e.clientY);
    isDrawing = true;
    drawStroke = [[ndcX, ndcY]];
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    updateSvgDrawOverlay();
  }
}, { capture: true });

// Canvas Pointer Down
canvas.addEventListener("pointerdown", (e) => {
  closeAllMenus();
  if (e.button !== 0) return;

  pointerDownPos = { x: e.clientX, y: e.clientY, time: performance.now() };
  const [ndcX, ndcY] = screenToNdc(e.clientX, e.clientY);

  // 1. Check Spirula-style 6-face Volume Handle hit FIRST (takes priority over gizmo/orbit!)
  const handleMeshes = volumeMgr.getVisibleHandleMeshes();
  if (handleMeshes.length > 0 && !gizmo.dragging) {
    raycaster.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
    const hits = raycaster.intersectObjects(handleMeshes, false);
    if (hits.length > 0) {
      const hObj = hits[0].object;
      const ud = hObj.userData;
      const vol = volumeMgr.getItem(ud.volumeId);
      if (vol) {
        e.stopPropagation();
        vol.root.updateMatrixWorld(true);
        const worldPos = new T.Vector3();
        const worldQuat = new T.Quaternion();
        const worldScale = new T.Vector3();
        vol.root.matrixWorld.decompose(worldPos, worldQuat, worldScale);

        const localAxisVec = new T.Vector3(
          ud.axis === 0 ? 1 : 0,
          ud.axis === 1 ? 1 : 0,
          ud.axis === 2 ? 1 : 0,
        );
        const worldAxis = localAxisVec.clone().applyQuaternion(worldQuat).normalize();
        const handleWorldPos = new T.Vector3();
        hObj.getWorldPosition(handleWorldPos);

        // Build drag plane containing worldAxis and perpendicular to camera view direction (robust fallback if parallel)
        const viewDir = new T.Vector3();
        camera.getWorldDirection(viewDir);
        const side = new T.Vector3().crossVectors(worldAxis, viewDir);
        const planeNormal =
          side.lengthSq() > 1e-5
            ? new T.Vector3().crossVectors(side, worldAxis).normalize()
            : viewDir.clone().negate();
        const dragPlane = new T.Plane().setFromNormalAndCoplanarPoint(planeNormal, handleWorldPos);
        const startHit = new T.Vector3();
        raycaster.ray.intersectPlane(dragPlane, startHit);

        // Parent scale along this local axis (for accurate drag inside scaled Volume Groups)
        const parentScale = new T.Vector3(1, 1, 1);
        if (vol.root.parent) {
          const pPos = new T.Vector3(), pQ = new T.Quaternion();
          vol.root.parent.matrixWorld.decompose(pPos, pQ, parentScale);
        }

        activeHandleDrag = {
          vol,
          axis: ud.axis,
          sign: ud.sign,
          worldAxis,
          dragPlane,
          startHit,
          startLocalPos: vol.root.position.clone(),
          startLocalScale: vol.root.scale.clone(),
          localAxisDir: localAxisVec.clone().applyQuaternion(vol.root.quaternion).normalize(),
          parentAxisScale: Math.max(1e-4, parentScale.getComponent(ud.axis)),
          beforeSnap: captureTransformSnapshot(),
        };
        camCtrl.syncOrbitEnabled(false);
        gizmo.enabled = false;
        isInteracting = true;
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        return;
      }
    }
  }

  // 2. 2D Drawing Selection / Semantic Box / Plane Inpaint Box Tools (skipped while Browse coexistence is active!)
  if (!isEffectiveBrowse() && CANVAS_DRAG_TOOLS.has(activeTool)) {
    isDrawing = true;
    drawStroke = [[ndcX, ndcY]];
    updateSvgDrawOverlay();
    return;
  }

  // 3. Polygon Selection (vertex clicks, close if within 12px of first vertex!)
  if (!isEffectiveBrowse() && activeTool === "poly") {
    if (polyPoints.length >= 3) {
      const r = stage.getBoundingClientRect();
      const firstX = ((polyPoints[0][0] + 1) * 0.5) * r.width + r.left;
      const firstY = ((1 - polyPoints[0][1]) * 0.5) * r.height + r.top;
      if (Math.hypot(e.clientX - firstX, e.clientY - firstY) <= 13) {
        finalizeScreenSelection("poly", polyPoints, e);
        polyPoints = [];
        clearSvgOverlay();
        return;
      }
    }
    polyPoints.push([ndcX, ndcY]);
    updateSvgDrawOverlay();
    return;
  }
});

canvas.addEventListener("pointerleave", () => {
  lastPointerClient.inside = false;
  hoverPickPoint = null;
  hideBrushCursorRing();
  hideCursorHintPill();
  measureMgr.handlePointerLeave();
  updateSpatialToolGuidesOverlay();
});

canvas.addEventListener("pointermove", (e) => {
  lastPointerClient.x = e.clientX;
  lastPointerClient.y = e.clientY;
  lastPointerClient.inside = true;
  syncBrushCursorVisual();

  // Active Smart Measurement 3D handle drag (vertex / base plane / peak pole)
  if (measureMgr.activeDrag) {
    measureMgr.handlePointerMove(e, isEffectiveBrowse());
    return;
  }

  // Active Lightroom HSL TAT Eyedropper screen-drag!
  if (hslDragCtx) {
    const dx = e.clientX - hslDragCtx.startX;
    const dy = hslDragCtx.startY - e.clientY;
    const deltaPx = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
    const pc = liveGrade.pointColor;
    const chan = hslDragCtx.chan;
    const chanLabel =
      chan === "hue"
        ? t("editor.color.chanHue")
        : chan === "light"
          ? t("editor.color.chanLight")
          : t("editor.color.chanSat");
    if (chan === "hue") {
      pc.hue = Math.max(-0.5, Math.min(0.5, hslDragCtx.startVal + deltaPx / 260));
      const uiV = Math.round(pc.hue * 200);
      showCursorHintPill(e.clientX, e.clientY, {
        text: `${hslDragCtx.bandLabel} · ${chanLabel} ${uiV > 0 ? "+" : ""}${uiV}`,
        swatchRgb: hslDragCtx.rgb,
      });
    } else if (chan === "sat") {
      pc.sat = Math.max(-1, Math.min(1, hslDragCtx.startVal + deltaPx / 200));
      const uiV = Math.round(pc.sat * 100);
      showCursorHintPill(e.clientX, e.clientY, {
        text: `${hslDragCtx.bandLabel} · ${chanLabel} ${uiV > 0 ? "+" : ""}${uiV}`,
        swatchRgb: hslDragCtx.rgb,
      });
    } else {
      pc.light = Math.max(-1, Math.min(1, hslDragCtx.startVal + deltaPx / 200));
      const uiV = Math.round(pc.light * 100);
      showCursorHintPill(e.clientX, e.clientY, {
        text: `${hslDragCtx.bandLabel} · ${chanLabel} ${uiV > 0 ? "+" : ""}${uiV}`,
        swatchRgb: hslDragCtx.rgb,
      });
    }
    syncColorSlidersUI();
    syncLiveColorPreview();
    return;
  }

  const [ndcX, ndcY] = screenToNdc(e.clientX, e.clientY);

  // Active 6-face Spirula Handle Drag
  if (activeHandleDrag) {
    raycaster.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
    const curHit = new T.Vector3();
    if (raycaster.ray.intersectPlane(activeHandleDrag.dragPlane, curHit)) {
      const dWorld = curHit.clone().sub(activeHandleDrag.startHit).dot(activeHandleDrag.worldAxis);
      const dLocal = (dWorld * activeHandleDrag.sign) / activeHandleDrag.parentAxisScale;
      const { vol, axis, sign, startLocalPos, startLocalScale, localAxisDir } = activeHandleDrag;
      const origHalf = startLocalScale.getComponent(axis);

      if (e.shiftKey) {
        // Shift: symmetrically stretch BOTH opposite faces (center stays fixed!)
        const nextHalf = Math.max(0.03, origHalf + dLocal);
        vol.root.scale.copy(startLocalScale);
        vol.root.scale.setComponent(axis, nextHalf);
        vol.root.position.copy(startLocalPos);
      } else {
        // Default: push/pull ONLY the dragged face (opposite face stays anchored!)
        const nextHalf = Math.max(0.03, origHalf + dLocal * 0.5);
        const shiftAmount = (nextHalf - origHalf) * sign;
        vol.root.scale.copy(startLocalScale);
        vol.root.scale.setComponent(axis, nextHalf);
        vol.root.position.copy(startLocalPos).addScaledVector(localAxisDir, shiftAmount);
      }
      vol.updateHandleScales(camera);
      volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
      syncTransformInputs();
      requestRender();
    }
    return;
  }

  // Hover highlight on 6-face volume handles (Spirula Figs 2 & 4 yellow highlight!)
  if (!isDrawing && !gizmo.dragging) {
    const handleMeshes = volumeMgr.getVisibleHandleMeshes();
    if (handleMeshes.length > 0) {
      raycaster.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
      const hits = raycaster.intersectObjects(handleMeshes, false);
      const hitKey = hits.length > 0 ? hits[0].object.userData.handleKey : null;
      const hitVolId = hits.length > 0 ? hits[0].object.userData.volumeId : null;
      let changed = false;
      for (const v of volumeMgr.items) {
        const nextKey = v.id === hitVolId ? hitKey : null;
        if (v._hoveredHandleKey !== nextKey) {
          v.setHoveredHandle(nextKey);
          changed = true;
        }
      }
      canvas.style.cursor = hitKey ? "grab" : "";
      if (changed) requestRender();
    }
  }

  // Active 2D draw selection / Ctrl+Left-Drag box prompt
  if (isDrawing) {
    if (activeTool === "rect" || activeTool === "ellipse" || activeTool === "semanticSel" || activeTool === "planeInpaint") {
      drawStroke[1] = [ndcX, ndcY];
    } else {
      const last = drawStroke[drawStroke.length - 1];
      if (!last || Math.hypot(ndcX - last[0], ndcY - last[1]) > 0.008) {
        drawStroke.push([ndcX, ndcY]);
      }
    }
    updateSvgDrawOverlay();
    return;
  }

  // Hover pill feedback for Color Eyedroppers (WB / Lightroom HSL TAT)
  if (colorPickMode && cloud && !gizmo.dragging) {
    const hit = pickGaussianOnlyAtCursor(e.clientX, e.clientY, { cached: true });
    if (hit) {
      const rgb = cloud.getRgba01(hit.idx);
      if (colorPickMode === "picker") {
        const hx = rgb255ToHex(Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255));
        showCursorHintPill(e.clientX, e.clientY, { text: t("editor.colorWheel.pickHoverHint", { hex: hx }), swatchRgb: rgb });
      } else if (colorPickMode === "wb") {
        showCursorHintPill(e.clientX, e.clientY, { text: t("editor.color.wbHintHover"), swatchRgb: rgb });
      } else {
        const hsl = rgb2hsl(rgb[0], rgb[1], rgb[2]);
        const band = HSL_BANDS[findNearestHslBand(hsl[0])];
        const ch = colorPanelUI?.hslTargetChannel || "sat";
        const chName =
          ch === "hue"
            ? t("editor.color.chanHue")
            : ch === "light"
              ? t("editor.color.chanLight")
              : t("editor.color.chanSat");
        showCursorHintPill(e.clientX, e.clientY, {
          text: t("editor.color.hslHintHover", { band: band.label, chan: chName }),
          swatchRgb: rgb,
        });
      }
    } else {
      showCursorHintPill(e.clientX, e.clientY, { text: t("editor.status.noSceneHit"), warn: true });
    }
    return;
  }

  // Hover Fig 5 Cursor Hint Pill & Spatial Preview for U / L / ScaleCalib / SmartMeasure (zero-stall O(1) cached pick!)
  if (SPATIAL_PICK_TOOLS.has(activeTool) && !isEffectiveBrowse() && !gizmo.dragging && !activeHandleDrag && cloud) {
    if (activeTool === "scaleCalib" || activeTool === "smartMeasure") {
      hoverPickPoint = null;
      measureMgr.handlePointerMove(e, isEffectiveBrowse());
      canvas.style.cursor = measureMgr.hoveredHandle ? "grab" : "";
      return;
    }
    const hit = pickGaussianOnlyAtCursor(e.clientX, e.clientY, { cached: true });
    hoverPickPoint = hit ? { idx: hit.idx, worldPos: hit.worldPos, clientX: e.clientX, clientY: e.clientY } : null;
    if (hit) {
      let msg = "";
      if (activeTool === "groundAlign") {
        const step = alignAppliedState ? 1 : Math.min(3, alignPoints.length + 1);
        msg = t("editor.align.hoverGroundPt", { step });
      } else {
        const step = alignAppliedState ? 1 : Math.min(2, alignPoints.length + 1);
        msg = step === 1 ? t("editor.align.hoverVertPt1") : t("editor.align.hoverVertPt2");
      }
      showCursorHintPill(e.clientX, e.clientY, { text: msg, warn: false });
    } else {
      showCursorHintPill(e.clientX, e.clientY, { text: t("editor.status.noSceneHit"), warn: true });
    }
    updateSpatialToolGuidesOverlay();
  } else {
    hoverPickPoint = null;
    hideCursorHintPill();
  }
});

canvas.addEventListener("pointerup", (e) => {
  // Finish Smart Measurement 3D handle drag cleanly -> 1 undoable global HistoryManager step!
  if (measureMgr.handlePointerUpDrag()) {
    isInteracting = false;
    updateOrbitMouseMapping(activeTool);
    return;
  }
  // Finish Lightroom HSL TAT screen-drag cleanly -> commit 1 history step on mouse release!
  if (hslDragCtx) {
    const before = hslDragCtx.beforeGrade;
    const bandLabel = hslDragCtx.bandLabel;
    hslDragCtx = null;
    hideCursorHintPill();
    pushColorGradeHistory(before, liveGrade, bandLabel);
    return;
  }
  // Finish 6-face handle drag -> 1 undoable step!
  if (activeHandleDrag) {
    const { beforeSnap, vol } = activeHandleDrag;
    activeHandleDrag = null;
    isInteracting = false;
    updateOrbitMouseMapping(activeTool);
    gizmo.enabled = gizmo.visible;
    const after = captureTransformSnapshot();
    if (!transformsEqual(beforeSnap, after)) {
      history.push({
        label: t("editor.history.dragVolHandles", { name: vol.name }),
        groupKey: "volume:drag",
        groupLabel: t("editor.history.groupVolDrag"),
        undo: () => { applyTransformSnapshot(beforeSnap); syncTransformInputs(); volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId); requestRender(true); },
        redo: () => { applyTransformSnapshot(after); syncTransformInputs(); volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId); requestRender(true); },
        journalEntry: { type: "transform", snapshot: after },
      });
    }
    volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
    requestRender(true);
    return;
  }

  // Finish 2D draw selection / Semantic Box / Plane Inpaint Box
  if (isDrawing) {
    isDrawing = false;
    const strokeCopy = drawStroke.slice();
    drawStroke = [];
    clearSvgOverlay();
    if (strokeCopy.length >= 2) {
      if (activeTool === "semanticSel" || activeTool === "planeInpaint") {
        const r = stage.getBoundingClientRect();
        const a = strokeCopy[0], b = strokeCopy[strokeCopy.length - 1];
        const pxW = Math.abs(b[0] - a[0]) * 0.5 * r.width;
        const pxH = Math.abs(b[1] - a[1]) * 0.5 * r.height;
        if (pxW < 8 || pxH < 8) {
          setStatus(activeTool === "semanticSel" ? t("editor.status.semanticBoxMinPx") : t("editor.status.inpaintBoxMinPx"));
          return;
        }
        const x0 = Math.max(0, Math.min(1, (Math.min(a[0], b[0]) + 1) * 0.5));
        const x1 = Math.max(0, Math.min(1, (Math.max(a[0], b[0]) + 1) * 0.5));
        const y0 = Math.max(0, Math.min(1, (1 - Math.max(a[1], b[1])) * 0.5));
        const y1 = Math.max(0, Math.min(1, (1 - Math.min(a[1], b[1])) * 0.5));
        const boxNorm01 = { x0, y0, x1, y1 };
        if (activeTool === "semanticSel") {
          runSemanticBoxAction(boxNorm01, effectivePointerBoolOp(e));
        } else {
          runPlaneInpaintAction(boxNorm01);
        }
      } else {
        finalizeScreenSelection(activeTool, strokeCopy, e);
      }
    }
    return;
  }

  // Click-vs-Drag Guard (<5px travel): guarantees orbiting NEVER triggers accidental picks!
  if (e.button === 0 && pointerDownPos) {
    const travel = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    pointerDownPos = null;
    if (travel > 5) return;

    // 1. Eyedropper click (only when Browse coexistence is OFF; samples color & immediately selects using standing/Ctrl/Alt op!)
    if (!isEffectiveBrowse() && activeTool === "eyedropper") {
      const hit = pickWorldPointAtCursor(e.clientX, e.clientY);
      if (hit && hit.idx >= 0) {
        const [r, g, b] = cloud.getRgba01(hit.idx);
        specialParams.eyedropper.rgb = [r, g, b];
        specialParams.eyedropper.hasPicked = true;
        const op = getEffectiveBoolOp(e);
        executeSpecialSelection("eyedropper", op);
        showSpecialSelectionContextBar("eyedropper");
        setStatus(t("editor.status.eyedropperPicked"));
      }
      return;
    }

    // 2. Semantic selection uses Shift + Left-Drag (so plain left-drag orbits freely & Ctrl/Alt control Add/Subtract!)
    if (activeTool === "semanticSel" && !e.shiftKey) {
      setStatus(t("editor.status.semanticUseShiftDrag"));
      return;
    }

    // 3. Vertical Line Alignment (2 points -> immediate damped apply on 2nd click!, rc8 #6)
    if (!isEffectiveBrowse() && activeTool === "verticalAlign") {
      const hit = pickGaussianOnlyAtCursor(e.clientX, e.clientY, { cached: true });
      if (!hit) {
        showCursorHintPill(e.clientX, e.clientY, { text: t("editor.status.noSceneHit"), warn: true });
        return;
      }
      if (alignAppliedState || alignPoints.length >= 2) {
        alignAppliedState = null;
        alignPoints = [];
        clearMarkers();
      }
      alignPoints.push(hit.worldPos.clone());
      if (alignPoints.length === 2) {
        try {
          const p0 = alignPoints[0].clone();
          const p1 = alignPoints[1].clone();
          const { deltaMat } = computeVerticalAlignment(p0, p1, false);
          alignAppliedState = { tool: "verticalAlign", pivot: p0.clone() };
          alignPoints = [];
          clearMarkers();
          updateSpatialToolGuidesOverlay();
          applyRigidDeltaToSelectedObjects(deltaMat, t("editor.history.verticalAlign"), { animated: true, durationSec: 0.34, fitAfter: false });
          showVerticalAlignContextBar();
          setStatus(t("editor.status.verticalAlignDone"));
        } catch (err) {
          alignPoints = [];
          setStatus(err.message);
          showVerticalAlignContextBar();
        }
      } else {
        showVerticalAlignContextBar();
        updateSpatialToolGuidesOverlay();
        requestRender();
      }
      return;
    }

    // 4. Plane Alignment (3 points -> immediate damped apply on 3rd click!, rc8 #6)
    if (!isEffectiveBrowse() && activeTool === "groundAlign") {
      const hit = pickGaussianOnlyAtCursor(e.clientX, e.clientY, { cached: true });
      if (!hit) {
        showCursorHintPill(e.clientX, e.clientY, { text: t("editor.status.noSceneHit"), warn: true });
        return;
      }
      if (alignAppliedState || alignPoints.length >= 3) {
        alignAppliedState = null;
        alignPoints = [];
        clearMarkers();
      }
      alignPoints.push(hit.worldPos.clone());
      if (alignPoints.length === 3) {
        try {
          syncObjectMatrices(false);
          const p0 = alignPoints[0].clone();
          const p1 = alignPoints[1].clone();
          const p2 = alignPoints[2].clone();
          const { deltaMat } = computeGroundAlignment(p0, p1, p2, cloud, getEffectiveSelectedObjectIds(), false);
          const center = new T.Vector3().add(p0).add(p1).add(p2).divideScalar(3).applyMatrix4(deltaMat);
          alignAppliedState = { tool: "groundAlign", pivot: center };
          alignPoints = [];
          clearMarkers();
          updateSpatialToolGuidesOverlay();
          applyRigidDeltaToSelectedObjects(deltaMat, t("editor.history.groundAlign"), { animated: true, durationSec: 0.34, fitAfter: false });
          showGroundAlignContextBar();
          setStatus(t("editor.status.groundAlignDone"));
        } catch (err) {
          alignPoints = [];
          setStatus(err.message);
          showGroundAlignContextBar();
        }
      } else {
        showGroundAlignContextBar();
        updateSpatialToolGuidesOverlay();
        requestRender();
      }
      return;
    }

    // 5. Smart Measurement Suite (Scale Calibration + Smart Measuring Pen — anti-floater GPU solid pick!)
    if (!isEffectiveBrowse() && (activeTool === "scaleCalib" || activeTool === "smartMeasure")) {
      measureMgr.handleCanvasClick(e);
      return;
    }

    // 6. Browse mode single-click (#11 + B1):
    //    - Click Gaussian point -> strictly single-select its owning Scene Object (World AABB wraps ONLY that object!)
    //    - Click Volume directly -> select that Volume for transform (does NOT alter enabled state!)
    //    - Click empty space -> clear Scene Object selection (World AABB wraps entire scene!)
    if (isEffectiveBrowse() && !gizmo.dragging) {
      const hitPt = pickWorldPointAtCursor(e.clientX, e.clientY);
      if (hitPt && hitPt.idx >= 0 && cloud) {
        const oid = cloud.objectIds[hitPt.idx];
        const obj = sceneObjects.find((o) => o.id === oid);
        if (obj) {
          activeVolumeOrGroupId = null;
          selectedVolumeIds.clear();
          volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
          clearContextBar("volume");
          activeObjectGroupId = null;
          selectedObjectIds.clear();
          selectedObjectIds.add(obj.id);
          cloud.syncVisualState(getEffectiveSelectedObjectIds());
          syncObjectMatrices(true);
          syncTransformInputs();
          renderSceneManager();
          updateColorScopeBadge();
          requestRender();
          return;
        }
      }
      const [ndcX, ndcY] = screenToNdc(e.clientX, e.clientY);
      const fills = volumeMgr.getVisibleFillMeshes();
      if (fills.length > 0) {
        raycaster.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
        const hits = raycaster.intersectObjects(fills, false);
        if (hits.length > 0 && hits[0].object.userData.volumeId) {
          selectVolumeOrGroup(hits[0].object.userData.volumeId, e.ctrlKey || e.metaKey);
          return;
        }
      }
      // Clicked empty background -> clear Scene Object selection so OBB wraps entire scene (#11)!
      if (selectedObjectIds.size > 0 || activeObjectGroupId) {
        clearObjectSelection();
      }
    }
  }
});

// Double-Click:
// - In Polygon tool with >=3 vertices: closes polygon!
// - Otherwise, double-clicking a Gaussian point ALWAYS summons the 3D Gizmo at that point,
//   automatically CANCELS any active non-Browse tool back to pure Browse (1), releases any Volume gizmo lock,
//   and disables Bounds Center!
canvas.addEventListener("dblclick", (e) => {
  // rc12 #3.2: Double-clicking the start vertex in Smart Measure Pen closes the polygon (>=3 pts)!
  if (!isEffectiveBrowse() && activeTool === "smartMeasure" && measureMgr.handleCanvasDblClick(e)) {
    return;
  }
  if (!isEffectiveBrowse() && activeTool === "poly" && polyPoints.length >= 3) {
    finalizeScreenSelection("poly", polyPoints, e);
    polyPoints = [];
    clearSvgOverlay();
    return;
  }

  const hit = pickWorldPointAtCursor(e.clientX, e.clientY);
  if (!hit) return;

  // Summoning the Gaussian model's 3D Gizmo via double-click ALWAYS activates Browse (1) and cancels any active tool!
  if (activeTool !== "orbit" || orbitExplicitlyOff) {
    setActiveTool("orbit", { fromUserToggle: false });
  }

  // #12: Double-clicking to reposition pivot automatically disables "使用边界中心"!
  if (useBoundsCenter) {
    setBoundsCenterEnabled(false, { skipRestore: true });
  }

  // When gizmo was hidden (including after cancelling another tool), double-clicking auto-activates Translate gizmo!
  const wasGizmoHidden = !gizmo.visible;

  // #13 Fix (Video 1): Always release Volume gizmo lock when double-clicking a Gaussian point,
  // WITHOUT disabling any enabled Volume scope constraint!
  if (activeVolumeOrGroupId) {
    activeVolumeOrGroupId = null;
    selectedVolumeIds.clear();
    volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
    clearContextBar("volume");
    renderSceneManager();
    syncTransformInputs();
  }

  camCtrl.animateTargetTo(hit.worldPos, 0.26);

  pivot.position.copy(hit.worldPos);
  syncPivotOrientationForSpace();

  if (wasGizmoHidden) {
    gizmoMode = "translate";
  }

  gizmo.attach(pivot);
  gizmo.setMode(gizmoMode);
  gizmo.setSpace(gizmoSpace);
  gizmo.visible = true;
  gizmo.enabled = true;
  updateGizmoRailActive(gizmoMode);
  setStatus(
    t("editor.status.pivotSet", {
      x: hit.worldPos.x.toFixed(2),
      y: hit.worldPos.y.toFixed(2),
      z: hit.worldPos.z.toFixed(2),
    }),
  );
  requestRender(true);
});

// Right-Click Context Menu (only on short right-click, NOT after right-drag pan/orbit!)
let rightDownPos = null;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 2) rightDownPos = { x: e.clientX, y: e.clientY };
});
let ctxMenuWorldPos = new T.Vector3(0, 0, 0);
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (rightDownPos && Math.hypot(e.clientX - rightDownPos.x, e.clientY - rightDownPos.y) > 6) {
    return; // Was right-drag orbit/pan!
  }
  const hit = pickWorldPointAtCursor(e.clientX, e.clientY);
  ctxMenuWorldPos = hit ? hit.worldPos.clone() : orbit.target.clone();
  contextMenuUI.showAt(e.clientX, e.clientY);
});

function spawnVolumeAt(kind, pos) {
  const before = volumeMgr.exportSnapshot();
  const radius = Math.max(0.4, camera.position.distanceTo(orbit.target) * 0.16);
  const v = volumeMgr.createVolume(kind, pos || orbit.target.clone(), radius);
  pushVolumeHistory(t("editor.history.createVol", { name: v.name }), before, volumeMgr.exportSnapshot());
  selectVolumeOrGroup(v.id, false);
}

function hasAnySelectedPoints() {
  if (!cloud) return false;
  for (let i = 0; i < cloud.n; i++) {
    if (!(cloud.flags[i] & FLAG_DELETED) && (cloud.flags[i] & FLAG_SELECTED)) return true;
  }
  return false;
}

const contextMenuUI = new ViewportContextMenu({
  menuEl: $("viewport-ctx-menu"),
  stageEl: stage,
  getLastTool: () => toolRailUI.getLastTool(),
  getActionState: () => ({
    canUndo: history.undoStack.length > 0,
    canRedo: history.redoStack.length > 0,
    hasSelection: hasAnySelectedPoints(),
  }),
  onAction: (act, payload) => {
    closeAllMenus();
    if (act === "recallTool" && typeof payload === "string") setActiveTool(payload);
    else if (act === "undo") history.undo();
    else if (act === "redo") history.redo();
    else if (act === "cycleMode") cycleDisplayMode();
    else if (act === "toggleColor") toggleColorPanel();
    else if (act === "fitView") fitCameraToCloud(true);
    else if (act === "autoAlign") setActiveTool("autoAlign");
    else if (act === "vol-box") spawnVolumeAt("box", ctxMenuWorldPos);
    else if (act === "vol-ellipsoid") spawnVolumeAt("ellipsoid", ctxMenuWorldPos);
    else if (act === "vol-cylinder") spawnVolumeAt("cylinder", ctxMenuWorldPos);
    else if (act === "vol-plane") spawnVolumeAt("plane", ctxMenuWorldPos);
    else if (act === "isolate") isolateSelectedPoints();
    else if (act === "hide") hideSelectedPoints();
    else if (act === "showall") showAllHiddenPoints();
    else if (act === "split") splitSelectedToObject();
    else if (act === "dup") duplicateSelectedToObject();
    else if (act === "delete") softDeleteSelected();
  },
});

$("btn-add-vol-menu").onclick = (e) => {
  e.stopPropagation();
  const r = e.target.getBoundingClientRect();
  ctxMenuWorldPos = orbit.target.clone();
  contextMenuUI.showAt(r.left - 110, r.bottom + 6);
};

// ============================================================================
// 11. Modular Tool Rail, Top-Right W/E/R Gizmo Cluster & Menu Wiring
// ============================================================================
const toolRailUI = new ToolRailController({
  railEl: $("left-rail"),
  gizmoClusterEl: $("top-gizmo-cluster"),
  onSelectTool: (tool) => setActiveTool(tool, { fromUserToggle: true }),
  onSelectGizmo: (mode) => setGizmoMode(mode),
});

function updateGizmoRailActive(mode) {
  toolRailUI.syncGizmoMode(mode, gizmo.visible);
}

function setGizmoMode(mode) {
  // Pressing the active W/E/R hotkey or clicking its active toolbar button again toggles & hides the gizmo!
  if (gizmo.visible && gizmoMode === mode) {
    if (pivotEditMode) setPivotEditMode(false, { silent: true });
    gizmo.detach();
    gizmo.visible = false;
    gizmo.enabled = false;
    updateGizmoRailActive("");
    if (activeVolumeOrGroupId) showVolumeContextBar(activeVolumeOrGroupId);
    setStatus(t("editor.status.gizmoHidden"));
    requestRender();
    return;
  }
  if (pivotEditMode && mode !== "translate") {
    setPivotEditMode(false, { silent: true });
  }
  gizmoMode = mode;
  gizmo.setMode(mode);
  gizmo.setSpace(gizmoSpace);
  if (activeVolumeOrGroupId) {
    const targetNode = getPrimaryTransformNode();
    if (targetNode && gizmo.object !== targetNode) gizmo.attach(targetNode);
  } else {
    if (gizmo.object !== pivot) {
      if (useBoundsCenter) syncPivotToBoundsCenter();
      else {
        pivot.position.copy(orbit.target);
        syncPivotOrientationForSpace();
      }
      gizmo.attach(pivot);
    } else {
      syncPivotOrientationForSpace();
    }
  }
  gizmo.visible = true;
  gizmo.enabled = true;
  updateGizmoRailActive(mode);
  if (activeVolumeOrGroupId) showVolumeContextBar(activeVolumeOrGroupId);
  requestRender();
}

// Edit secondary menu actions (Undo/Redo + Alignment shortcuts)
$("btn-undo").onclick = () => { closeAllMenus(); history.undo(); };
$("btn-redo").onclick = () => { closeAllMenus(); history.redo(); };
$("act-tool-autoalign").onclick = () => { closeAllMenus(); setActiveTool("autoAlign"); };
$("act-tool-vertical").onclick = () => { closeAllMenus(); setActiveTool("verticalAlign"); };
$("act-tool-ground").onclick = () => { closeAllMenus(); setActiveTool("groundAlign"); };
$("act-tool-scale-calib").onclick = () => { closeAllMenus(); setActiveTool("scaleCalib", { fromUserToggle: true }); };
$("act-tool-smart-measure").onclick = () => { closeAllMenus(); setActiveTool("smartMeasure", { fromUserToggle: true }); };

// Top dropdown menus
function closeAllMenus() {
  for (const m of document.querySelectorAll(".menu-popup, #viewport-ctx-menu, #scene-mgr-ctx-menu")) {
    m.classList.add("hidden");
  }
  for (const trig of document.querySelectorAll(".menu-trigger")) trig.classList.remove("open");
  advancedMenuUI.closeSubmenus();
  toolRailUI.closeFlyouts();
  closeAllCustomDropdowns();
}

$("menu-advanced")?.addEventListener("click", (e) => {
  // Keep Advanced Menu open when toggling checkboxes, presets, or 3rd-level download controls
  if (e.target.closest(".menu-sub-wrap, .menu-check-item")) {
    e.stopPropagation();
  }
});

for (const trig of document.querySelectorAll(".menu-trigger")) {
  trig.onclick = (e) => {
    e.stopPropagation();
    const pop = $("menu-" + trig.dataset.menu);
    const wasHidden = pop.classList.contains("hidden");
    closeAllMenus();
    if (wasHidden) {
      pop.classList.remove("hidden");
      trig.classList.add("open");
    }
  };
}
document.addEventListener("click", closeAllMenus);

$("act-sel-all").onclick = () => { closeAllMenus(); selectAllPoints(); };
$("act-sel-none").onclick = () => { closeAllMenus(); deselectAllPoints(); };
$("act-sel-invert").onclick = () => { closeAllMenus(); invertSelectionPoints(); };
$("act-sel-isolate").onclick = () => { closeAllMenus(); isolateSelectedPoints(); };
$("act-sel-hide").onclick = () => { closeAllMenus(); hideSelectedPoints(); };
$("act-sel-showall").onclick = () => { closeAllMenus(); showAllHiddenPoints(); };
$("act-sel-split").onclick = () => { closeAllMenus(); splitSelectedToObject(); };
$("act-sel-dup").onclick = () => { closeAllMenus(); duplicateSelectedToObject(); };
$("act-sel-delete").onclick = () => { closeAllMenus(); softDeleteSelected(); };

$("btn-isolate-top").onclick = isolateSelectedPoints;
$("btn-hide-top").onclick = hideSelectedPoints;
$("btn-showall-top").onclick = showAllHiddenPoints;

function setGridVisible(v) {
  gridVisible = !!v;
  infiniteGrid.visible = gridVisible;
  $("btn-grid-top")?.classList.toggle("active", gridVisible);
  const chk = $("chk-show-grid");
  if (chk) chk.checked = gridVisible;
  requestRender();
}
function toggleGrid() { setGridVisible(!gridVisible); }

function setBoundsVisible(v) {
  boundsVisible = !!v;
  modelBounds.setUserEnabled(boundsVisible);
  $("btn-bounds-top")?.classList.toggle("active", boundsVisible);
  const chk = $("chk-show-bounds");
  if (chk) chk.checked = boundsVisible;
  requestRender();
}
function toggleBounds() { setBoundsVisible(!boundsVisible); }

function toggleCameraProjection() {
  const prev = camera;
  camera = camera === perspCam ? orthoCam : perspCam;
  camera.position.copy(prev.position);
  camera.up.copy(prev.up);
  camera.lookAt(orbit.target);
  orbit.object = camera;
  gizmo.camera = camera;
  resizeViewport();
  setStatus(camera === orthoCam ? t("editor.status.camOrthoSwitched") : t("editor.status.camPerspSwitched"));
}

$("act-toggle-grid").onclick = () => { closeAllMenus(); toggleGrid(); };
$("btn-grid-top").onclick = toggleGrid;
$("act-toggle-bounds").onclick = () => { closeAllMenus(); toggleBounds(); };
$("btn-bounds-top").onclick = toggleBounds;
$("act-toggle-proj").onclick = () => { closeAllMenus(); toggleCameraProjection(); };
$("act-toggle-cammode").onclick = () => { closeAllMenus(); setCameraControlMode(cameraControlMode === "orbit" ? "fly" : "orbit"); };
$("act-fit-view").onclick = () => { closeAllMenus(); fitCameraToCloud(true); };
$("act-opencv-zup").onclick = () => { closeAllMenus(); executeOpenCvToZUp(); };
$("act-cancel-close").onclick = () => postHost("cancel");

// Global Conflict-Free Keyboard Shortcuts & Modifiers (delegated to input/shortcut-router.js)
installShortcutRouter({
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
  startHoldCompare: () => {
    if (!compareOriginalHold) {
      compareOriginalHold = true;
      holdCompareBtn.classList.add("active");
      syncLiveColorPreview();
    }
  },
  endHoldCompare,
  openExportImageModal: () => exportImageCtrl?.openExportImageModal(),
  cycleDisplayMode,
  measureMgr,
  softDeleteSelected,
  colorWheelPicker,
  getColorPickMode: () => colorPickMode,
  setColorPickMode,
  setStatus,
  hideAutoAlignPrompt,
  semanticEngine,
  showSemanticOpOverlay,
  getPolyPoints: () => polyPoints,
  clearPolyPoints: () => {
    polyPoints = [];
    clearSvgOverlay();
  },
  finalizeScreenSelection,
  getActiveTool: () => activeTool,
  setActiveTool,
  gizmo,
  updateGizmoRailActive,
  requestRender,
  fitCameraToCloud,
  adjustBrushRadius: (delta) => {
    brushRadiusPx = Math.max(6, Math.min(360, brushRadiusPx + delta));
    syncBrushCursorVisual();
    showBasicSelectionContextBar();
  },
  isolateSelectedPoints,
  duplicateSelectedToObject,
  setGizmoMode,
  toggleColorPanel,
  hideSelectedPoints,
  splitSelectedToObject,
  toggleGrid,
  toggleBounds,
  toggleCameraControlMode: () => setCameraControlMode(cameraControlMode === "orbit" ? "fly" : "orbit"),
  toggleCameraProjection,
  toggleGizmoSpaceMode: () => setGizmoSpaceMode(gizmoSpace === "local" ? "world" : "local"),
  toggleBoundsCenter: () => setBoundsCenterEnabled(!useBoundsCenter),
  syncTempModifierBoolUI,
});

// ============================================================================
// 12. Export Current View Image (delegated to ui/export-image-modal.js)
// ============================================================================
exportImageCtrl = installExportImageModal({
  $,
  stage,
  renderer,
  scene,
  perspCam,
  orthoCam,
  getCamera: () => camera,
  getCloud: () => cloud,
  getDisplayMode: () => displayMode,
  getCurrentFileName: () => currentFileName,
  watchdog,
  infiniteGrid,
  modelBounds,
  volumeMgr,
  gizmo,
  markersGroup,
  measureMgr,
  updateOrthoFrustum,
  syncObjectMatrices,
  openModal,
  closeModal,
  closeAllMenus,
  postHost,
  setStatus,
  requestRender,
});

// ============================================================================
// 13. Non-Destructive Overwrite Save (v3 Recipe) & Crash-Safe Save As (Section IX)
// ============================================================================

function buildV3Recipe(exportObjectIds = null) {
  syncObjectMatrices();

  // Compute global deleted ranges on original source indices (for main object)
  const deletedByObj = new Map();
  const splitOutFromMain = [];
  const membersByObj = new Map();
  const liveSelByObj = new Map();
  let hasLiveGradeSel = false;
  const hasLiveGrade = isGradeModified(liveGrade, { forBake: true });
  const activeGradeObjs = hasLiveGrade ? getEffectiveSelectedObjectIds() : null;

  for (const obj of sceneObjects) {
    deletedByObj.set(obj.id, []);
    membersByObj.set(obj.id, []);
    liveSelByObj.set(obj.id, []);
  }

  if (cloud) {
    for (let i = 0; i < cloud.n; i++) {
      const oid = cloud.objectIds[i];
      const sIdx = cloud.srcIdx[i];
      if (cloud.flags[i] & FLAG_DELETED) {
        deletedByObj.get(oid)?.push(sIdx);
        continue;
      }
      if (hasLiveGrade && !(cloud.flags[i] & FLAG_HIDDEN) && (cloud.flags[i] & FLAG_SELECTED)) {
        hasLiveGradeSel = true;
        liveSelByObj.get(oid)?.push(sIdx);
      }
      if (oid !== 0) {
        membersByObj.get(oid)?.push(sIdx);
        if (i < cloud.originalCount) {
          splitOutFromMain.push(sIdx);
        }
      }
    }
  }

  // Non-destructively include active liveGrade in exported recipe WITHOUT wiping the user's live sliders!
  const objectsPayload = [];
  for (const obj of sceneObjects) {
    obj.node.updateMatrixWorld(true);
    const delRanges = encodeIndexRanges(deletedByObj.get(obj.id) || []);
    const gradesOut = (obj.bakedGrades || []).map((g) => ({ targetRanges: g.targetRanges, grade: cloneGrade(g.grade) }));
    if (hasLiveGrade) {
      const liveSnap = cloneGrade(liveGrade);
      if (liveSnap.pointColor) liveSnap.pointColor.visualizeRange = false;
      if (hasLiveGradeSel) {
        const selSrc = liveSelByObj.get(obj.id) || [];
        if (selSrc.length > 0) gradesOut.push({ targetRanges: encodeIndexRanges(selSrc), grade: liveSnap });
      } else if (!activeGradeObjs || activeGradeObjs.size === 0 || activeGradeObjs.has(obj.id)) {
        gradesOut.push({ targetRanges: "all", grade: liveSnap });
      }
    }

    const pieceExcludedSet = new Set();
    const extraMergedEntries = [];
    if (Array.isArray(obj.mergedPieces) && obj.mergedPieces.length > 0) {
      for (const piece of obj.mergedPieces) {
        if (!piece || !Array.isArray(piece.srcRanges) || !piece.srcRanges.length) continue;
        for (const [s0, s1] of piece.srcRanges) {
          for (let s = s0; s <= s1; s++) pieceExcludedSet.add(s);
        }
        const relM = new T.Matrix4().fromArray(piece.relMatrix);
        const worldM = new T.Matrix4().multiplyMatrices(obj.node.matrixWorld, relM);
        extraMergedEntries.push({
          id: obj.id,
          name: `${obj.name} (merged)`,
          visible: obj.visible,
          groupId: obj.groupId,
          sourceKind: obj.sourceKind,
          memberRanges: piece.srcRanges,
          excludedRanges: [],
          deletedRanges: delRanges,
          matrix: Array.from(worldM.elements),
          bakedGrades: [
            ...(piece.bakedGrades || []).map((g) => ({ targetRanges: g.targetRanges, grade: cloneGrade(g.grade) })),
            ...gradesOut,
          ],
        });
      }
    }

    const rawMembers = membersByObj.get(obj.id) || [];
    const filteredMembers = pieceExcludedSet.size > 0 ? rawMembers.filter((s) => !pieceExcludedSet.has(s)) : rawMembers;
    const mainExcluded =
      obj.id === 0
        ? pieceExcludedSet.size > 0
          ? encodeIndexRanges([...splitOutFromMain, ...pieceExcludedSet])
          : encodeIndexRanges(splitOutFromMain)
        : [];

    const base = {
      id: obj.id,
      name: obj.name,
      visible: obj.visible,
      groupId: obj.groupId,
      sourceKind: obj.sourceKind,
      memberRanges: obj.id === 0 ? "all" : encodeIndexRanges(filteredMembers),
      excludedRanges: mainExcluded,
      deletedRanges: delRanges,
      matrix: Array.from(obj.node.matrixWorld.elements),
      bakedGrades: gradesOut,
    };
    if (obj.sourceKind === "synthetic-inpaint" && obj.syntheticData) {
      const sd = obj.syntheticData;
      base.syntheticData = {
        count: Math.floor(sd.positions.length / 3),
        posB64: typedArrayToB64(sd.positions),
        scaleB64: typedArrayToB64(sd.logScales),
        quatB64: typedArrayToB64(sd.quats),
        rgbaB64: typedArrayToB64(sd.rgba),
      };
    }
    objectsPayload.push(base);
    for (const extra of extraMergedEntries) objectsPayload.push(extra);
  }

  const groupsPayload = sceneObjectGroups.map((og) => ({
    id: og.id,
    name: og.name,
    memberIds: [...og.memberIds],
  }));

  const baseV3 = {
    version: 3,
    coordSystem: "y-up",
    matrixSpace: "source",
    exportObjectIds: exportObjectIds ? exportObjectIds.map(Number) : sceneObjects.map((o) => o.id),
    deletedRanges: encodeIndexRanges(deletedByObj.get(0) || []),
    objects: objectsPayload,
    groups: groupsPayload,
    volumes: volumeMgr.exportSnapshot(),
    measureScale: measureMgr.exportScaleConfig(),
    rules: [],
    translation: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: 1,
  };

  if (editSession && previewAdapter) {
    // Sync persistent non-point scene state (objects, groups, volumes, liveGrade, measureScale) into EditSession!
    const primaryMat = sceneObjects[0] ? Array.from(sceneObjects[0].node.matrixWorld.elements) : null;
    if (primaryMat && editSession.hasAsset(currentAssetId)) {
      editSession.setEntityMatrix(currentAssetId, primaryMat);
    }
    if (editSession.sceneState) {
      editSession.sceneState.setSceneGraph(objectsPayload, groupsPayload);
      editSession.sceneState.setVolumesSnapshot(baseV3.volumes);
      editSession.sceneState.setColorGrade(liveGrade);
      editSession.sceneState.setMeasureScale(baseV3.measureScale);
    }
    editSession.setParametricVolumes(baseV3.volumes.items || []);
    const canKeepV4 = sceneObjects.length === 1 && (!exportObjectIds || (exportObjectIds.length === 1 && exportObjectIds[0] === 0));
    const encoded = encodeProjectRecipe(editSession, {
      primaryAssetId: currentAssetId,
      baseV3Payload: baseV3,
      primaryEntityMatrix: primaryMat,
      forceConvertToV3: !canKeepV4,
    });
    return encoded.recipe;
  }

  return baseV3;
}

function showRecipeCompatBanner(warnings) {
  const banner = $("recipe-compat-banner");
  const textEl = $("recipe-compat-text");
  if (!banner || !textEl) return;
  if (!warnings || warnings.length === 0) {
    banner.classList.add("hidden");
    return;
  }
  textEl.textContent = warnings.join(" ");
  banner.classList.remove("hidden");
}
$("btn-dismiss-compat")?.addEventListener("click", () => {
  $("recipe-compat-banner")?.classList.add("hidden");
});

function openOverwriteSaveModal() {
  const list = $("overwrite-objects-list");
  list.innerHTML = "";
  const counts = countPointsPerObject();
  for (const obj of sceneObjects) {
    const cnt = counts.get(obj.id) || 0;
    const lbl = document.createElement("label");
    lbl.innerHTML = `<input type="checkbox" value="${obj.id}" ${obj.visible && cnt > 0 ? "checked" : ""} /> <span>${t("editor.modals.overwriteObjItem", { name: obj.name, count: cnt.toLocaleString() })}</span>`;
    list.appendChild(lbl);
  }
  const compatWarn = $("overwrite-compat-warn");
  if (compatWarn) {
    if (lastRecipeCompat && lastRecipeCompat.requiresPreservation && lastRecipeCompat.warnings?.length) {
      const warnStr = lastRecipeCompat.warnings.join(" ");
      compatWarn.textContent = !lastRecipeCompat.supported
        ? t("editor.modals.compatProtectUnsupported", { warnings: warnStr })
        : t("editor.modals.compatProtectV4", { warnings: warnStr });
      compatWarn.classList.remove("hidden");
    } else {
      compatWarn.classList.add("hidden");
    }
  }
  openModal("modal-save-overwrite");
}

$("act-save-overwrite").onclick = () => { closeAllMenus(); openOverwriteSaveModal(); };
$("btn-save-overwrite-top").onclick = openOverwriteSaveModal;
$("btn-confirm-overwrite").onclick = () => {
  const checked = [...document.querySelectorAll("#overwrite-objects-list input:checked")].map((x) => Number(x.value));
  if (checked.length === 0) {
    setStatus(t("editor.status.selectOneObject"));
    return;
  }
  const recipe = buildV3Recipe(checked);
  closeModal("modal-save-overwrite");
  postHost("apply:" + JSON.stringify(recipe));
};

function refreshSaveAsEncoderSummary() {
  const el = $("saveas-encoder-summary");
  if (!el) return;
  if (encoderPreset && encoderPreset.formatSuffix) {
    el.textContent = t("editor.modals.saveAsSummary", {
      keep: encoderPreset.keep,
      iterations: encoderPreset.iterations,
      device: encoderPreset.device,
      sogVersion: encoderPreset.sogVersion,
      spzVersion: encoderPreset.spzVersion,
    });
  } else {
    el.textContent = t("editor.modals.saveAsSummaryDefault");
  }
}

function openSaveAsModal() {
  if (encoderPreset && encoderPreset.formatSuffix) {
    const sel = $("saveas-format");
    if ([...sel.options].some((o) => o.value === encoderPreset.formatSuffix)) {
      sel.value = encoderPreset.formatSuffix;
    }
  }
  refreshSaveAsEncoderSummary();
  $("saveas-status").classList.add("hidden");
  $("btn-confirm-save-as").disabled = false;
  openModal("modal-save-as");
}

$("act-save-as").onclick = () => { closeAllMenus(); openSaveAsModal(); };
$("btn-save-as-top").onclick = openSaveAsModal;
$("btn-confirm-save-as").onclick = () => {
  const mode = document.querySelector('input[name="saveas-mode"]:checked')?.value || "merged";
  const format = $("saveas-format").value;
  const useMainParams = $("saveas-use-main-params").checked;
  const counts = countPointsPerObject();
  const activeObjs = sceneObjects.filter((o) => (counts.get(o.id) || 0) > 0);
  if (activeObjs.length === 0) {
    $("saveas-status").textContent = t("editor.modals.saveAsNoActiveObjects");
    $("saveas-status").classList.remove("hidden");
    return;
  }

  const jobs = [];
  if (mode === "merged") {
    jobs.push({ name: "merged", recipe: buildV3Recipe(activeObjs.map((o) => o.id)) });
  } else if (mode === "per-object") {
    for (const obj of activeObjs) {
      jobs.push({ name: obj.name, recipe: buildV3Recipe([obj.id]) });
    }
  } else if (mode === "per-group") {
    const grouped = new Set();
    for (const og of sceneObjectGroups) {
      const ids = og.memberIds.filter((id) => (counts.get(id) || 0) > 0);
      if (ids.length > 0) {
        ids.forEach((id) => grouped.add(id));
        jobs.push({ name: og.name, recipe: buildV3Recipe(ids) });
      }
    }
    for (const obj of activeObjs) {
      if (!grouped.has(obj.id)) {
        jobs.push({ name: obj.name, recipe: buildV3Recipe([obj.id]) });
      }
    }
  }

  // Persist crash-safe checkpoint BEFORE invoking heavy re-encoding!
  history.persistJournal();
  const statusEl = $("saveas-status");
  statusEl.textContent = t("editor.modals.saveAsWaitingFolder");
  statusEl.classList.remove("hidden");
  $("btn-confirm-save-as").disabled = true;
  watchdog.setPaused(true);

  postHost(
    "saveAs:" +
      JSON.stringify({
        mode,
        format,
        useMainParams,
        jobs,
        checkpoint: history.exportJournalPayload(),
      }),
  );
};

// ============================================================================
// 14. Modals, Shortcuts List, Open-Source Credits & Delayed Tooltip Bindings (delegated to ui/info-modals.js)
// ============================================================================
infoModalsCtrl = createInfoModalsController({ $, bindTip, closeAllMenus, displayModeDropdown });
function openModal(id) { infoModalsCtrl.openModal(id); }
function closeModal(id) { infoModalsCtrl.closeModal(id); }
function bindAllDelayedTooltips() { infoModalsCtrl.bindAllDelayedTooltips(); }

// ============================================================================
// 15. Binary SGC3/SGC2 Cloud Loader, Full v3 Recipe Restore & Zero-Loss Journal Replay
// ============================================================================
function showLoadingOverlay(visible, stageText = "", pct = null) {
  loadingUI.update(visible, stageText, pct);
}

function fitCameraToCloud(animate = false, { calibrateFlySpeed = false } = {}) {
  if (!cloud || cloud.n === 0) return;
  syncObjectMatrices();
  const step = Math.max(1, Math.floor(cloud.n / 8000));
  const xs = [], ys = [], zs = [];
  const tmp = new T.Vector3();
  for (let i = 0; i < cloud.n; i += step) {
    if (cloud.flags[i] & FLAG_DELETED) continue;
    cloud.getWorldPosition(i, tmp);
    xs.push(tmp.x); ys.push(tmp.y); zs.push(tmp.z);
  }
  if (xs.length === 0) return;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const lo = Math.floor(xs.length * 0.05);
  const hi = Math.floor(xs.length * 0.95);
  const cx = (xs[lo] + xs[hi]) * 0.5;
  const cy = (ys[lo] + ys[hi]) * 0.5;
  const cz = (zs[lo] + zs[hi]) * 0.5;
  const span = Math.max(0.2, Math.hypot(xs[hi] - xs[lo], ys[hi] - ys[lo], zs[hi] - zs[lo]));
  lastSceneRadius = span * 0.5;
  perspCam.near = Math.max(0.005, Math.min(0.2, span * 0.0005));
  perspCam.far = Math.max(2500, span * 350);
  perspCam.updateProjectionMatrix();
  camCtrl.setSceneScale(span);
  if (calibrateFlySpeed) {
    camCtrl.calibrateFlySpeedFromSpan(span);
    syncFlySpeedUI();
  }
  modelBounds.syncFromSceneObjects(sceneObjects);

  const endTarget = new T.Vector3(cx, cy, cz);
  const endPos = new T.Vector3(cx + span * 0.85, cy + span * 0.65, cz + span * 1.1);
  const endUp = new T.Vector3(0, 1, 0);
  if (animate) {
    camCtrl.animateToPose({ position: endPos, target: endTarget, up: endUp, durationSec: 0.34 });
  } else {
    camCtrl.snapImmediate();
    orbit.target.copy(endTarget);
    perspCam.up.copy(endUp);
    orthoCam.up.copy(endUp);
    camera.position.copy(endPos);
    camera.lookAt(orbit.target);
    const prevDamp = orbit.enableDamping;
    orbit.enableDamping = false;
    orbit.update();
    orbit.enableDamping = prevDamp;
    requestRender(true);
  }
}

function parseSgcBuffer(arrayBuffer, opts = {}) {
  const res = parseCloudBinaryBuffer(arrayBuffer, opts);
  if (res.format === "SGC3") {
    return { isSoA: true, soa: res.cloudInput, totalSrc: res.totalSourcePoints, loaded: res.cloudInput.count };
  }
  return {
    isSoA: false,
    floats: res.cloudInput,
    srcIdx: res.sourceIndices,
    totalSrc: res.totalSourcePoints,
    loaded: Math.floor(res.cloudInput.length / 14),
  };
}

function buildSrcIdxLookup() {
  const map = new Map();
  if (!cloud) return map;
  for (let i = 0; i < cloud.originalCount; i++) {
    map.set(cloud.srcIdx[i], i);
  }
  return map;
}

function restoreV3Recipe(recipe) {
  if (!recipe || !cloud) return;
  if (recipe.version === 1 || recipe.version === 2) {
    // Legacy v1/v2 restore
    const main = sceneObjects[0].node;
    if (Array.isArray(recipe.translation)) main.position.fromArray(recipe.translation);
    if (Array.isArray(recipe.rotation)) {
      main.rotation.set(
        T.MathUtils.degToRad(recipe.rotation[0] || 0),
        T.MathUtils.degToRad(recipe.rotation[1] || 0),
        T.MathUtils.degToRad(recipe.rotation[2] || 0),
        "ZYX",
      );
    }
    if (recipe.scale > 0) main.scale.setScalar(recipe.scale);
    syncObjectMatrices();
    return;
  }
  if (recipe.version !== 3) return;

  const srcToCloud = buildSrcIdxLookup();

  // 1. Restore volumes (with idempotent one-time legacy z-up cylinder migration!)
  if (recipe.volumes) {
    volumeMgr.restoreSnapshot(recipe.volumes, {
      recipeCoordSystem: recipe.coordSystem ?? null,
      recipeVersion: recipe.version ?? 3,
    });
  }

  // 2. Restore objects (main, split, duplicate) + transforms + baked grades + soft-deletes
  initDefaultSceneObject();
  const objs = Array.isArray(recipe.objects) ? recipe.objects : [];
  for (const od of objs) {
    let obj;
    if (od.id === 0) {
      obj = sceneObjects[0];
      if (od.name) {
        obj.name = od.name;
        obj.isDefaultMainName = false;
      }
      obj.visible = od.visible !== false;
      obj.groupId = od.groupId || null;
    } else {
      const node = new T.Object3D();
      node.name = "obj_" + od.id;
      objectRoot.add(node);
      obj = {
        id: od.id,
        name: od.name || t("editor.scene.objectFallbackName", { id: od.id }),
        visible: od.visible !== false,
        groupId: od.groupId || null,
        sourceKind: od.sourceKind || "split",
        node,
        bakedGrades: [],
      };
      sceneObjects.push(obj);
      if (od.id >= nextObjId) nextObjId = od.id + 1;

      const memberCloudIndices = [];
      decodeIndexRanges(od.memberRanges, (sIdx) => {
        const ci = srcToCloud.get(sIdx);
        if (ci !== undefined) memberCloudIndices.push(ci);
      });
      if (obj.sourceKind === "synthetic-inpaint" && od.syntheticData && od.syntheticData.posB64) {
        const sd = od.syntheticData;
        const posU8 = b64ToUint8(sd.posB64);
        const scU8 = b64ToUint8(sd.scaleB64);
        const qtU8 = b64ToUint8(sd.quatB64);
        const rgU8 = b64ToUint8(sd.rgbaB64);
        const patchData = {
          positions: new Float32Array(posU8.buffer),
          logScales: new Float32Array(scU8.buffer),
          quats: new Float32Array(qtU8.buffer),
          rgba: rgU8,
        };
        obj.syntheticData = patchData;
        cloud.appendSyntheticPoints(patchData, obj.id);
      } else if (obj.sourceKind === "duplicate") {
        cloud.duplicatePoints(memberCloudIndices, obj.id);
        for (let i = cloud.n - memberCloudIndices.length; i < cloud.n; i++) {
          cloud.flags[i] &= ~FLAG_SELECTED;
        }
      } else {
        for (const ci of memberCloudIndices) cloud.objectIds[ci] = obj.id;
        cloud.markObjectIdsDirty();
      }
      cloud.objectVisibility.set(obj.id, obj.visible);
    }

    if (Array.isArray(od.matrix) && od.matrix.length === 16) {
      const m = new T.Matrix4().fromArray(od.matrix);
      m.decompose(obj.node.position, obj.node.quaternion, obj.node.scale);
    }

    // Apply deleted ranges for this object
    if (Array.isArray(od.deletedRanges) && od.deletedRanges.length > 0) {
      const delSet = new Set();
      decodeIndexRanges(od.deletedRanges, (sIdx) => delSet.add(sIdx));
      for (let i = 0; i < cloud.n; i++) {
        if (cloud.objectIds[i] === obj.id && delSet.has(cloud.srcIdx[i])) {
          cloud.flags[i] |= FLAG_DELETED;
        }
      }
    }

    // Re-apply baked grades visually onto cloud colors
    if (Array.isArray(od.bakedGrades) && od.bakedGrades.length > 0) {
      obj.bakedGrades = od.bakedGrades.map((g) => ({ targetRanges: g.targetRanges, grade: cloneGrade(g.grade) }));
      for (const ge of obj.bakedGrades) {
        const subset = ge.targetRanges === "all" ? null : new Set();
        if (subset) decodeIndexRanges(ge.targetRanges, (sIdx) => subset.add(sIdx));
        const clampU8 = (v) => { const k = Math.round(v * 255); return k < 0 ? 0 : k > 255 ? 255 : k; };
        for (let i = 0; i < cloud.n; i++) {
          if (cloud.objectIds[i] !== obj.id) continue;
          if (subset && !subset.has(cloud.srcIdx[i])) continue;
          const i4 = i * 4;
          const [nr, ng, nb, na] = applyColorGradeCPU(
            cloud.rgba[i4] / 255, cloud.rgba[i4 + 1] / 255, cloud.rgba[i4 + 2] / 255, cloud.rgba[i4 + 3] / 255, ge.grade,
          );
          cloud.rgba[i4] = clampU8(nr);
          cloud.rgba[i4 + 1] = clampU8(ng);
          cloud.rgba[i4 + 2] = clampU8(nb);
          cloud.rgba[i4 + 3] = clampU8(na);
        }
      }
      cloud._flushColorTexture();
    }
  }

  // 3. Restore Object Groups
  for (const gd of recipe.groups || []) {
    const grpNode = new T.Group();
    grpNode.name = gd.id;
    objectRoot.add(grpNode);
    objectRoot.updateMatrixWorld(true);
    for (const mid of gd.memberIds || []) {
      const obj = sceneObjects.find((o) => o.id === mid);
      if (obj) {
        grpNode.attach(obj.node);
        obj.groupId = gd.id;
      }
    }
    sceneObjectGroups.push({ id: gd.id, name: gd.name, node: grpNode, memberIds: [...(gd.memberIds || [])] });
  }

  modelBounds.recomputeLocalBoxes(cloud);
  syncObjectMatrices();
  previewAdapter?.syncCloudToSession(editSession);
  updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
  renderSceneManager();
  syncTransformInputs();
}

function restoreAnyRecipe(recipe) {
  if (!recipe || !cloud) return;
  if (recipe.measureScale) measureMgr.restoreScaleConfig(recipe.measureScale);
  const compat = inspectRecipeCompatibility(recipe);
  lastRecipeCompat = compat;
  showRecipeCompatBanner(compat.warnings);

  if (!compat.supported) {
    if (editSession) decodeRecipeIntoSession(recipe, editSession, { primaryAssetId: currentAssetId });
    setStatus(compat.warnings[0] || t("editor.status.unsupportedRecipeKept"));
    return;
  }

  if (compat.version === 4) {
    if (editSession && previewAdapter) {
      decodeRecipeIntoSession(recipe, editSession, { primaryAssetId: currentAssetId });
      previewAdapter.syncFromSession(editSession);
    }
    if (Array.isArray(recipe.entityDeltaMatrix) && recipe.entityDeltaMatrix.length === 16 && sceneObjects[0]) {
      const m = new T.Matrix4().fromArray(recipe.entityDeltaMatrix);
      m.decompose(sceneObjects[0].node.position, sceneObjects[0].node.quaternion, sceneObjects[0].node.scale);
    }
    if (recipe.colorGrade && recipe.colorGrade.enabled) {
      const cg = recipe.colorGrade;
      liveGrade = createDefaultGrade();
      liveGrade.brightness = Number(cg.brightness) || 0;
      liveGrade.blackPoint = Number(cg.blackPoint) || 0;
      liveGrade.whitePoint = typeof cg.whitePoint === "number" ? cg.whitePoint : 1;
      liveGrade.saturation = typeof cg.saturation === "number" ? cg.saturation : 1;
      liveGrade.temperature = Number(cg.temperature) || 0;
      if (Array.isArray(cg.tint) && cg.tint.length === 3) liveGrade.tint = cg.tint.slice();
      liveGrade.transparency = typeof cg.transparency === "number" ? cg.transparency : 1;
      if (Array.isArray(cg.hslHue) && cg.hslHue.length === 8) liveGrade.hslHue = cg.hslHue.slice();
      if (Array.isArray(cg.hslSat) && cg.hslSat.length === 8) liveGrade.hslSat = cg.hslSat.slice();
      if (Array.isArray(cg.hslLight) && cg.hslLight.length === 8) liveGrade.hslLight = cg.hslLight.slice();
      if (cg.lutName) liveGrade.lutName = cg.lutName;
      if (typeof cg.lutIntensity === "number") liveGrade.lutIntensity = cg.lutIntensity;
      syncColorSlidersUI();
      syncLiveColorPreview();
    }
    modelBounds.recomputeLocalBoxes(cloud);
    syncObjectMatrices();
    updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    renderSceneManager();
    syncTransformInputs();
    return;
  }

  if (compat.version === 3 && editSession) {
    decodeRecipeIntoSession(recipe, editSession, { primaryAssetId: currentAssetId });
  }
  restoreV3Recipe(recipe);
}

function replayCommandJournal(journal) {
  if (!journal || !Array.isArray(journal.entries) || !cloud) return 0;
  isReplaying = true;
  let count = 0;
  try {
    const srcToCloud = buildSrcIdxLookup();
    for (const entry of journal.entries) {
      if (entry.type === "transform" && entry.snapshot) {
        const before = captureTransformSnapshot();
        applyTransformSnapshot(entry.snapshot);
        const after = captureTransformSnapshot();
        history.push({
          label: entry.label || t("editor.history.restoreTransform"),
          undo: () => { applyTransformSnapshot(before); syncTransformInputs(); requestRender(true); },
          redo: () => { applyTransformSnapshot(after); syncTransformInputs(); requestRender(true); },
          journalEntry: entry,
        });
        count++;
      } else if (entry.type === "volumes" && entry.snapshot) {
        const before = volumeMgr.exportSnapshot();
        volumeMgr.restoreSnapshot(entry.snapshot);
        pushVolumeHistory(entry.label || t("editor.history.restoreVolumes"), before, entry.snapshot);
        count++;
      } else if (entry.type === "flagDelta" && entry.delSrcRanges?.length) {
        const before = new Uint8Array(cloud.flags);
        decodeIndexRanges(entry.delSrcRanges, (sIdx) => {
          const ci = srcToCloud.get(sIdx);
          if (ci !== undefined) cloud.flags[ci] |= FLAG_DELETED;
        });
        commitFlagDelta(entry.opLabel || t("editor.history.restoreDelete"), before, entry);
        count++;
      } else if (entry.type === "colorBake" && entry.grade) {
        liveGrade = cloneGrade(entry.grade);
        if (entry.hasSelectionScope && Array.isArray(entry.srcRanges)) {
          for (let i = 0; i < cloud.n; i++) cloud.flags[i] &= ~FLAG_SELECTED;
          decodeIndexRanges(entry.srcRanges, (sIdx) => {
            const ci = srcToCloud.get(sIdx);
            if (ci !== undefined) cloud.flags[ci] |= FLAG_SELECTED;
          });
        }
        bakeCurrentColorGrade(entry.label || t("editor.history.restoreColor"));
        count++;
      }
    }
  } finally {
    isReplaying = false;
  }
  syncObjectMatrices();
  updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
  renderSceneManager();
  syncTransformInputs();
  return count;
}

async function mountCloudFromArrayBuffer(arrayBuffer, opts = {}) {
  watchdog.setPaused(true);
  showLoadingOverlay(true, t("editor.loading.buildingWebgl"), 95);
  try {
    const parsed = parseSgcBuffer(arrayBuffer);
    totalSourcePoints = opts.totalPoints || parsed.totalSrc;
    loadedSourcePoints = parsed.loaded;

    if (previewAdapter) { previewAdapter.dispose(); previewAdapter = null; }
    if (editSession) { editSession.dispose(); editSession = null; }
    boxSelectTool = null;
    lastRecipeCompat = null;
    showRecipeCompatBanner([]);

    if (cloud) {
      scene.remove(cloud);
      cloud.dispose();
      cloud = null;
      // Flush driver queue so previous cloud's multi-GB VRAM textures are released before allocating next!
      try { renderer.getContext().flush(); } catch { /* ignore */ }
    }
    initDefaultSceneObject();
    cloud = parsed.isSoA
      ? new Cloud(parsed.soa, null, () => requestRender(), renderer)
      : new Cloud(parsed.floats, parsed.srcIdx, () => requestRender(), renderer);
    scene.add(cloud);

    currentAssetId = opts.assetId || "primary";
    if (opts.sourceSha256) currentAssetSha256 = opts.sourceSha256;
    editSession = new EditSession({ maxHistorySteps: history.maxSteps });
    editSession.registerAsset({
      assetId: currentAssetId,
      name: currentFileName,
      sha256: currentAssetSha256,
      pointCount: Math.max(totalSourcePoints, cloud.originalCount),
      orderingVersion: "source-v1",
    });
    previewAdapter = new ThreePreviewAdapter({
      cloud,
      assetId: currentAssetId,
      renderer,
      getCamera: () => camera,
      getViewportSize: () => ({ w: stage.clientWidth, h: stage.clientHeight }),
      getDisplayMode: () => displayMode,
      getActiveObjectIds: () => getEffectiveSelectedObjectIds(),
      onStatsUpdated: (st) => updateStats(st),
    });
    boxSelectTool = new BoxSelectTool({ previewBackend: previewAdapter, editSession });
    measureMgr.clearActive({ keepPinned: false });
    measureMgr.restoreScaleConfig(null);
    measureMgr.invalidatePicker();

    const hadSavedRecipe = !!(opts.recipeJson && opts.recipeJson !== "null");
    if (hadSavedRecipe) {
      try {
        restoreAnyRecipe(typeof opts.recipeJson === "string" ? JSON.parse(opts.recipeJson) : opts.recipeJson);
      } catch (err) {
        console.warn("Restore recipe warning:", err);
        showRecipeCompatBanner([t("editor.status.restoreRecipeFailed", { error: err.message })]);
      }
    }

    if (opts.recoveryJournal) {
      try {
        const j = typeof opts.recoveryJournal === "string" ? JSON.parse(opts.recoveryJournal) : opts.recoveryJournal;
        const replayed = replayCommandJournal(j);
        setStatus(t("editor.status.journalReplayed", { count: replayed }));
      } catch {
        // ignore
      }
    }

    updateStats(cloud.syncVisualState(getEffectiveSelectedObjectIds()));
    modelBounds.recomputeLocalBoxes(cloud);
    syncObjectMatrices(true);
    renderSceneManager();
    syncTransformInputs();
    fitCameraToCloud(false, { calibrateFlySpeed: true });
    showLoadingOverlay(false);
    watchdog.reset();
    watchdog.setPaused(false);
    watchdog.start();
    requestRender(true);

    // rc8 #3: Smart conditional bottom prompt for tilted scene-like models (skip if saved recipe exists!)
    hideAutoAlignPrompt();
    if (autoAlignPromptCheckTimer) clearTimeout(autoAlignPromptCheckTimer);
    lastTiltDetection = null;
    if (!hadSavedRecipe && !opts.skipAutoAlignPrompt) {
      autoAlignPromptCheckTimer = setTimeout(() => {
        autoAlignPromptCheckTimer = null;
        if (!cloud) return;
        const det = detectTiltedSceneCandidate(cloud);
        lastTiltDetection = det;
        if (det && det.shouldPrompt) {
          showAutoAlignPrompt(det);
        }
      }, 160);
    }
  } catch (err) {
    showLoadingOverlay(false);
    setStatus(t("editor.status.modelLoadFailed", { error: err.message }));
    postHost("error:" + err.message);
  }
}

// ============================================================================
// 16. WebView2 Host Message Bridge, Hot-Switch Localization & Boot Sequence
// ============================================================================
function refreshAllLocalizedUI() {
  document.title = t("editor.window.title");
  if (sceneObjects[0]?.isDefaultMainName) {
    sceneObjects[0].name = t("editor.scene.mainCloud");
  }
  toolRailUI.refreshLabels();
  displayModeDropdown.setOptions(getDisplayModeOptions(), displayMode);
  displayModeDropdown.trigger?.setAttribute("aria-label", t("editor.topBar.displayMode"));
  renderSceneManager();
  syncTransformInputs();
  renderHistoryPanel();
  colorPanelUI?.refreshLanguage();
  colorWheelPicker.refreshLanguage();
  updateColorScopeBadge();
  const lutSel = $("lut-select");
  if (lutSel) {
    const defOpt = lutSel.querySelector('option[data-is-default-lut="1"], option[value=""]');
    if (defOpt) defOpt.textContent = t("editor.color.lutDefault");
  }
  measureMgr.refreshLanguage();
  perfHud.refreshLanguage();
  advancedMenuUI.refreshLanguage();
  bindAllDelayedTooltips();
  setToolGuide(
    activeVolumeOrGroupId
      ? (volumeMgr.getItem(activeVolumeOrGroupId)?.kind === "plane" ? TOOL_GUIDES.plane : TOOL_GUIDES.volume)
      : (TOOL_GUIDES[activeTool] || TOOL_GUIDES.orbit),
  );
  // Refresh active bottom context bars cleanly without re-triggering entrance flash
  if (BASIC_EXCLUSIVE_TOOLS.has(activeTool)) showBasicSelectionContextBar();
  else if (["eyedropper", "opacitySel", "sizeSel", "semanticSel", "floaterSel"].includes(activeTool)) showSpecialSelectionContextBar(activeTool);
  else if (activeTool === "planeInpaint") showPlaneInpaintContextBar();
  else if (activeTool === "verticalAlign") showVerticalAlignContextBar();
  else if (activeTool === "groundAlign") showGroundAlignContextBar();
  else if (activeTool === "scaleCalib") showScaleCalibContextBar();
  else if (activeTool === "smartMeasure") showSmartMeasureContextBar();
  if (activeVolumeOrGroupId) showVolumeContextBar(activeVolumeOrGroupId);

  // Refresh open dialogs & prompts
  if (!$("modal-info")?.classList.contains("hidden")) {
    infoModalsCtrl?.refreshActiveInfoModal();
  }
  if (!$("modal-save-as")?.classList.contains("hidden")) {
    refreshSaveAsEncoderSummary();
  }
  if (!$("auto-align-prompt")?.classList.contains("hidden") && lastTiltDetection && typeof lastTiltDetection.tiltDeg === "number") {
    const desc = $("auto-align-prompt-desc");
    if (desc) desc.textContent = t("editor.banners.autoAlignDescDeg", { deg: lastTiltDetection.tiltDeg.toFixed(1) });
  }
  if (lastStatsSnapshot) updateStats(lastStatsSnapshot);
  if (statusIsIdle) {
    $("status-msg").textContent = t("editor.statusBar.ready");
  }
}

window.chrome?.webview?.addEventListener("message", async (e) => {
  const msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
  if (!msg) return;

  if (msg.type === "setLanguage") {
    await setLanguage(msg.lang || getLanguage(), msg.dict || null, msg.fallback || null);
    if (msg.models) {
      advancedMenuUI.setModelsPayload(msg.models);
      semanticEngine.configureModels(msg.models);
      planeInpaintEngine.configureModels(msg.models);
    }
    if (msg.encoderPreset) {
      encoderPreset = msg.encoderPreset;
      refreshSaveAsEncoderSummary();
    }
    return;
  }
  if (msg.type === "progress") {
    showLoadingOverlay(true, msg.stage || t("editor.loading.title"), msg.percent);
    return;
  }
  if (msg.type === "loadError") {
    loadingUI.showError(msg.message || t("editor.loading.loadFailed"));
    return;
  }
  if (msg.type === "telemetry") {
    lastTelemetryText = msg.text || lastTelemetryText;
    perfHud.updateHardware(msg.data || null, msg.text || null);
    return;
  }
  if (msg.type === "modelsStatus") {
    if (msg.models) {
      advancedMenuUI.setModelsPayload(msg.models);
      semanticEngine.configureModels(msg.models);
      planeInpaintEngine.configureModels(msg.models);
      if (activeTool === "semanticSel") showSpecialSelectionContextBar("semanticSel");
      if (activeTool === "planeInpaint") showPlaneInpaintContextBar();
    }
    return;
  }
  if (msg.type === "bundledModelsReady") {
    if (msg.models) {
      advancedMenuUI.setModelsPayload(msg.models);
      semanticEngine.configureModels(msg.models);
      planeInpaintEngine.configureModels(msg.models);
    }
    if (bundledExtractResolver) {
      const fn = bundledExtractResolver;
      bundledExtractResolver = null;
      fn(msg.models || null);
    }
    if (!msg.ok && msg.error) setStatus(msg.error);
    return;
  }
  if (msg.type === "modelDownloadProgress") {
    advancedMenuUI.updateDownloadProgress(msg.modelId, msg.percent, msg.stage);
    setStatus(t("editor.status.modelDownloading", { percent: msg.percent, stage: msg.stage }));
    return;
  }
  if (msg.type === "modelDownloadDone") {
    advancedMenuUI.clearDownloadProgress(msg.modelId);
    if (msg.models) {
      advancedMenuUI.setModelsPayload(msg.models);
      semanticEngine.configureModels(msg.models);
      planeInpaintEngine.configureModels(msg.models);
    }
    if (msg.message) setStatus(msg.message);
    if (activeTool === "semanticSel") showSpecialSelectionContextBar("semanticSel");
    if (activeTool === "planeInpaint") showPlaneInpaintContextBar();
    return;
  }
  if (msg.type === "sam2Status") {
    if (msg.message) setStatus(msg.message);
    if (activeTool === "semanticSel") showSpecialSelectionContextBar("semanticSel");
    return;
  }
  if (msg.type === "exportImageResult") {
    setStatus(msg.ok ? t("editor.status.viewImageSaved", { path: msg.path }) : (msg.message || t("editor.status.exportCanceled")));
    return;
  }
  if (msg.type === "saveAsProgress") {
    const st = $("saveas-status");
    st.textContent = t("editor.modals.saveAsProgress", { percent: msg.percent, detail: msg.detail || "" });
    st.classList.remove("hidden");
    return;
  }
  if (msg.type === "saveAsResult") {
    watchdog.setPaused(false);
    $("btn-confirm-save-as").disabled = false;
    const st = $("saveas-status");
    st.textContent = msg.message || (msg.ok ? t("editor.modals.saveAsDone") : t("editor.modals.saveAsFailed"));
    st.classList.remove("hidden");
    setStatus(st.textContent);
    return;
  }
  if (msg.type === "cloudReloaded") {
    // Auto-downgrade reload triggered by HangWatchdog / WebGL context lost
    const journalBackup = history.exportJournalPayload();
    const res = await fetch(msg.cloudUrl);
    const buf = await res.arrayBuffer();
    history.clear();
    await mountCloudFromArrayBuffer(buf, {
      totalPoints: msg.totalPoints,
      recoveryJournal: journalBackup,
    });
    enterLowPerfSafeMode(msg.reason, msg.telemetry, { showModal: true });
    return;
  }
  if (msg.type === "init") {
    if (msg.lang || msg.i18nDict || msg.i18nFallback) {
      await setLanguage(msg.lang || getLanguage(), msg.i18nDict || null, msg.i18nFallback || null);
    }
    currentFileName = msg.fileName || "scene.ply";
    currentAssetId = msg.assetId || "primary";
    currentAssetSha256 = msg.sourceSha256 || msg.sourceFingerprint || "";
    hostBootInfo = {
      editorKind: msg.editorKind || "native-owned",
      editorEntry: msg.editorEntry || "index.html",
      assetsHash: msg.assetsHash || "",
      version: msg.appVersion || "3.2.3",
      fileName: currentFileName,
      locationHref: window.location.href,
    };
    encoderPreset = msg.encoderPreset || null;
    if (msg.telemetry || msg.telemetryData) {
      lastTelemetryText = msg.telemetry || lastTelemetryText;
      perfHud.updateHardware(msg.telemetryData || null, msg.telemetry || null);
    }
    if (msg.tooltipConfig) {
      tooltipMgr.configure(msg.tooltipConfig);
      if (msg.tooltipConfig.maxHistorySteps) history.setMaxSteps(msg.tooltipConfig.maxHistorySteps);
    }
    if (msg.sessionKey) history.setSessionKey(msg.sessionKey);
    if (msg.models) {
      advancedMenuUI.setModelsPayload(msg.models);
      semanticEngine.configureModels(msg.models);
      planeInpaintEngine.configureModels(msg.models);
    }

    showLoadingOverlay(true, t("editor.loading.transferringBinary"), 93);
    const res = await fetch(msg.cloudUrl);
    if (!res.ok) throw new Error(t("editor.loading.loadBinaryHttpErr", { status: res.status }));
    const buf = await res.arrayBuffer();
    await mountCloudFromArrayBuffer(buf, {
      totalPoints: msg.totalPoints,
      assetId: currentAssetId,
      sourceSha256: currentAssetSha256,
      recipeJson: msg.recipe,
      recoveryJournal: msg.recoveryJournal,
    });
    if (msg.crashRecovery) {
      enterLowPerfSafeMode(msg.crashRecovery.reason, msg.crashRecovery.telemetry, { showModal: true });
    }
  }
});

// Boot UI + Async i18n Init (loads ./locales/zh-CN.json & ?lang=... immediately for standalone / WebView2!)
initColorPanelUI();
onLanguageChange(() => refreshAllLocalizedUI());
bindAllDelayedTooltips();
renderSceneManager();
setToolGuide(TOOL_GUIDES.orbit);
initI18n().catch((err) => console.warn("[i18n] init failed:", err));
window.addEventListener("resize", resizeViewport);
window.addEventListener("beforeunload", () => {
  try {
    if (previewAdapter) { previewAdapter.dispose(); previewAdapter = null; }
    if (editSession) { editSession.dispose(); editSession = null; }
    boxSelectTool = null;
    semanticEngine.release().catch(() => {});
    planeInpaintEngine.release().catch(() => {});
    if (cloud) { cloud.dispose(); cloud = null; }
    infiniteGrid.dispose();
    modelBounds.dispose();
    renderer.dispose();
  } catch { /* ignore */ }
});
resizeViewport();

// Expose clean diagnostic/test hook for automated Playwright & smoke verification
window.__SPLAT_EDITOR__ = {
  setLanguage: (code, dict = null, fallback = null) => setLanguage(code, dict, fallback),
  getLanguage,
  t,
  loadBuffer: (buf, opts) => mountCloudFromArrayBuffer(buf, opts),
  setDisplayMode,
  setCameraMode: setCameraControlMode,
  toggleBounds,
  toggleGrid,
  enterLowPerfSafeMode,
  exitLowPerfSafeMode,
  getSafeModeState: () => ({
    active: lowPerfSafeMode,
    displayMode,
    frozenTools: Array.from(SAFE_MODE_FROZEN_TOOLS),
  }),
  isCameraAnimating: () => camCtrl.isAnimating(),
  animateToAxis: (dirVec) => camCtrl.animateToAxis(new T.Vector3(dirVec[0], dirVec[1], dirVec[2]), 0.28),
  fitCameraToCloud: (animate = true) => fitCameraToCloud(animate),
  openDisplayDropdown: () => displayModeDropdown.open(),
  closeAllMenus,
  setActiveTool,
  setGizmoMode,
  spawnVolumeAt,
  selectVolumeOrGroup,
  groupSelectedItems,
  ungroupSelectedItems,
  toggleColorPanel,
  toggleSplitCompare,
  bakeCurrentColorGrade,
  selectAllPoints,
  deselectAllPoints,
  invertSelectionPoints,
  isolateSelectedPoints,
  hideSelectedPoints,
  showAllHiddenPoints,
  splitSelectedToObject,
  duplicateSelectedToObject,
  softDeleteSelected,
  executeAutoAlign,
  buildV3Recipe,
  buildRecipe: () => buildV3Recipe(),
  undo: () => history.undo(),
  redo: () => history.redo(),
  getHostBootInfo: () => ({ ...hostBootInfo }),
  getRecipeCompat: () => lastRecipeCompat,
  getEditSessionStats: () => (editSession ? editSession.getStats() : null),
  getSyncTelemetry: () => (previewAdapter ? previewAdapter.getTelemetry() : null),
  resetSyncTelemetry: () => { if (previewAdapter) previewAdapter.resetTelemetry(); },
  getSceneStateSnapshot: () => (editSession?.sceneState ? editSession.sceneState.captureSnapshot() : null),
  getBoundsInfo: () => ({
    visible: modelBounds.visible,
    hasValidBounds: modelBounds.hasValidBounds,
    recomputeScanCount: modelBounds.recomputeScanCount,
    localBox: modelBounds.getLocalBox(0),
    worldCorners: modelBounds.getWorldCorners(),
    cameraPos: camera.position.toArray(),
    cameraTarget: orbit.target.toArray(),
    cameraUp: camera.up.toArray(),
  }),
  setObjectTransform: (objId, pos, rotDeg, scale, exact = true) => {
    const obj = sceneObjects.find((o) => o.id === objId);
    if (!obj) return false;
    if (Array.isArray(pos) && pos.length === 3) obj.node.position.set(pos[0], pos[1], pos[2]);
    if (Array.isArray(rotDeg) && rotDeg.length === 3) {
      obj.node.rotation.set(
        T.MathUtils.degToRad(rotDeg[0]),
        T.MathUtils.degToRad(rotDeg[1]),
        T.MathUtils.degToRad(rotDeg[2]),
      );
    }
    if (Array.isArray(scale) && scale.length === 3) obj.node.scale.set(scale[0], scale[1], scale[2]);
    syncObjectMatrices(exact);
    syncTransformInputs();
    renderFrame();
    return true;
  },
  triggerBoxSelect: (minX, minY, maxX, maxY, op = "replace") => {
    if (!boxSelectTool || !editSession || !previewAdapter) return null;
    syncObjectMatrices();
    const res = boxSelectTool.selectBox({
      rectNdc: { minX, maxX, minY, maxY },
      op,
      onlyVisible,
      wholeGaussian,
      targetAssetId: currentAssetId,
      worldScopeFn: volumeMgr.compileActiveScope(camera.position),
      activeObjectIds: getEffectiveSelectedObjectIds(),
    });
    if (res.changedCount > 0) {
      history.push({
        label: t("editor.history.flagDelta", { label: res.label, count: res.changedCount.toLocaleString() }),
        undo: () => { boxSelectTool.undo(); requestRender(true); },
        redo: () => { boxSelectTool.redo(); requestRender(true); },
      });
    }
    renderFrame();
    return res;
  },
  confirmOverwriteSaveNow: () => {
    const recipe = buildV3Recipe();
    postHost("apply:" + JSON.stringify(recipe));
    return recipe;
  },
  getEncoderPreset: () => encoderPreset,
  setEncoderPreset: (p) => { encoderPreset = p; },
  openSaveAsModal,
  closeModal,
  getVolumeManager: () => volumeMgr,
  getMeasureManager: () => measureMgr,
  getMeasureState: () => measureMgr.getStateSummary(),
  applyVerticalAlignPoints: (p0, p1, flip = false) => {
    const { deltaMat } = computeVerticalAlignment(new T.Vector3(...p0), new T.Vector3(...p1), flip);
    applyRigidDeltaToSelectedObjects(deltaMat, t("editor.history.verticalAlign"));
  },
  applyGroundAlignPoints: (p0, p1, p2, flip = false) => {
    syncObjectMatrices();
    const { deltaMat } = computeGroundAlignment(
      new T.Vector3(...p0), new T.Vector3(...p1), new T.Vector3(...p2),
      cloud, getEffectiveSelectedObjectIds(), flip,
    );
    applyRigidDeltaToSelectedObjects(deltaMat, t("editor.history.groundAlign"));
  },
  detectTiltedScene: () => (cloud ? detectTiltedSceneCandidate(cloud) : null),
  getLastTiltDetection: () => lastTiltDetection,
  getLiveGrade: () => cloneGrade(liveGrade),
  setColorPickMode,
  getRc8State: () => ({
    activeTool,
    browseCoexistActive,
    orbitExplicitlyOff,
    gizmoVisible: gizmo.visible,
    colorPickMode,
    alignAppliedState: alignAppliedState ? { tool: alignAppliedState.tool } : null,
    autoAlignPromptVisible: !$("auto-align-prompt")?.classList.contains("hidden"),
    brushRadiusPx,
    lastWasExactBounds: !!modelBounds._lastWasExact,
  }),
  runLassoSelectionDirect: (pathNdc, op = "replace") => {
    if (!cloud) return 0;
    syncObjectMatrices(false);
    const r = stage.getBoundingClientRect();
    const before = runScreenSelection({
      cloud,
      renderer,
      camera,
      viewportW: r.width,
      viewportH: r.height,
      displayMode,
      kind: "lasso",
      path: pathNdc,
      op,
      aspect: Math.max(0.1, r.width / Math.max(1, r.height)),
      onlyVisible,
      wholeGaussian,
      worldScopeFn: volumeMgr.compileActiveScope(camera.position),
      activeObjectIds: getEffectiveSelectedObjectIds(),
    });
    commitFlagDelta(t("editor.history.lassoTest"), before);
    renderFrame();
    return Array.from(cloud.flags).filter((f) => !(f & FLAG_DELETED) && (f & FLAG_SELECTED)).length;
  },
  getPrimaryMatrix: () => (sceneObjects[0] ? Array.from(sceneObjects[0].node.matrixWorld.elements) : null),
  setLiveColorGrade: (patch) => {
    Object.assign(liveGrade, patch || {});
    syncColorSlidersUI();
    syncLiveColorPreview();
  },
  getCloudStats: () => ({
    n: cloud ? cloud.n : 0,
    deleted: cloud ? Array.from(cloud.flags).filter((f) => (f & FLAG_DELETED) !== 0).length : 0,
    selected: cloud ? Array.from(cloud.flags).filter((f) => !(f & FLAG_DELETED) && (f & FLAG_SELECTED) !== 0).length : 0,
  }),
  orbitCameraStep: (dAzim, dElev = 0) => {
    camCtrl.snapImmediate();
    isInteracting = true;
    const offset = camera.position.clone().sub(orbit.target);
    const sph = new T.Spherical().setFromVector3(offset);
    sph.theta += dAzim;
    sph.phi = Math.max(0.12, Math.min(Math.PI - 0.12, sph.phi + dElev));
    const v = new T.Vector3().setFromSpherical(sph);
    camera.position.copy(orbit.target).add(v);
    camera.up.set(0, 1, 0);
    camera.lookAt(orbit.target);
    const prevDamp = orbit.enableDamping;
    orbit.enableDamping = false;
    orbit.update();
    orbit.enableDamping = prevDamp;
    renderFrame();
  },
  endOrbitTest: () => {
    isInteracting = false;
    requestRender(true);
  },
  setTelemetry: (txt, data = null) => {
    lastTelemetryText = txt;
    perfHud.updateHardware(data, txt);
  },
  getPerfHudState: () => ({
    fps: perfHud.getFps(),
    text: $("bottom-right-perf")?.textContent || "",
    enabled: perfHud.getEnabledFields(),
  }),
  setPerfHudField: (id, on) => perfHud.setFieldEnabled(id, on),
  getAdvancedMenuState: () => ({
    prefs: advancedMenuUI.getPrefs(),
    semanticMode: specialParams.semanticSel.mode,
    semanticDepthMode: specialParams.semanticSel.depthMode,
    inpaintMode: specialParams.planeInpaint.mode,
  }),
  setSemanticPrefs: (patch) => {
    Object.assign(specialParams.semanticSel, patch || {});
    if (activeTool === "semanticSel") showSpecialSelectionContextBar("semanticSel");
  },
  setInpaintPrefs: (patch) => {
    Object.assign(specialParams.planeInpaint, patch || {});
    if (activeTool === "planeInpaint") showPlaneInpaintContextBar();
  },
  configureModels: (payload) => {
    advancedMenuUI.setModelsPayload(payload);
    semanticEngine.configureModels(payload);
    planeInpaintEngine.configureModels(payload);
  },
  runSemanticBox: (boxNorm01, op = "replace", opts = {}) => runSemanticBoxAction(boxNorm01, op, opts),
  reapplySemantic2DDepth: (opts) => {
    Object.assign(specialParams.semanticSel, opts || {});
    const res = semanticEngine.reapplyCached2DDepth({
      op: activeBoolOp,
      depthMode: specialParams.semanticSel.depthMode,
      throughDepthMeters: specialParams.semanticSel.throughDepth,
      infiniteDepth: specialParams.semanticSel.infiniteDepth,
    });
    if (res?.before) commitFlagDelta(t("editor.history.depthAdjust2d"), res.before);
    return res;
  },
  runPlaneInpaintBox: (boxNorm01) => runPlaneInpaintAction(boxNorm01),
  openAdvancedSubmenu: (subId) => {
    $("menu-advanced")?.classList.remove("hidden");
    advancedMenuUI.openSubmenu(subId);
  },
  getHistoryTimeline: () => history.getTimeline(),
  jumpToHistory: (idx) => {
    const ok = history.jumpTo(idx);
    renderSceneManager();
    syncTransformInputs();
    requestRender(true);
    return ok;
  },
  toggleHistoryExpanded: () => toggleHistoryCardExpanded(),
  setLocalSpace: (on) => setGizmoSpaceMode(on ? "local" : "world"),
  setBoundsCenter: (on) => setBoundsCenterEnabled(!!on),
  setPivotEdit: (on) => setPivotEditMode(!!on),
  setScaleLocked,
  resetTransformRow,
  clearObjectSelection,
  toggleSolo,
  deleteSceneObject,
  deleteSceneObjectGroup,
  moveSceneObject,
  selectSceneObjectSingle: (id) => {
    activeVolumeOrGroupId = null;
    selectedVolumeIds.clear();
    volumeMgr.syncAllVisuals(selectedVolumeIds, activeVolumeOrGroupId);
    clearContextBar("volume");
    activeObjectGroupId = null;
    selectedObjectIds.clear();
    if (id != null) selectedObjectIds.add(id);
    if (cloud) cloud.syncVisualState(getEffectiveSelectedObjectIds());
    syncObjectMatrices(true);
    if (gizmo.object && gizmo.object !== pivot) {
      if (useBoundsCenter) syncPivotToBoundsCenter();
      else syncPivotOrientationForSpace();
      if (gizmo.visible) gizmo.attach(pivot);
      else gizmo.detach();
    }
    syncTransformInputs();
    renderSceneManager();
    requestRender();
  },
  setActiveToolUser: (tool) => setActiveTool(tool, { fromUserToggle: true }),
  getRc5State: () => ({
    gizmoSpace,
    useBoundsCenter,
    pivotEditMode,
    pivotPos: pivot.position.toArray(),
    gizmoAttachedToPivot: gizmo.object === pivot,
    gizmoVisible: gizmo.visible,
    scaleLocked,
    browseCoexistActive,
    isEffectiveBrowse: isEffectiveBrowse(),
    selectedObjectIds: Array.from(selectedObjectIds),
    activeObjectGroupId,
    activeVolumeOrGroupId,
    selectedVolumeIds: Array.from(selectedVolumeIds),
    historyExpanded,
    soloState: soloState ? { kind: soloState.kind, targetId: soloState.targetId } : null,
    csgPreviewCount: volumeMgr._csgMeshes.size,
  }),
  setCameraControlMode,
  getFlySpeedConfig: () => camCtrl.getFlySpeedConfig(),
  setFlySpeedMps: (v) => { const r = camCtrl.setFlySpeedMps(v); syncFlySpeedUI(); return r; },
  calibrateFlySpeedFromSpan: (s) => { const r = camCtrl.calibrateFlySpeedFromSpan(s); syncFlySpeedUI(); return r; },
  toggleFlyout: (name) => toolRailUI.toggleFlyout(name),
  renderSceneManager,
  toggleCameraProjection,
  setCameraPose: (pos, target) => {
    camCtrl.snapImmediate();
    camera.position.set(pos[0], pos[1], pos[2]);
    orbit.target.set(target[0], target[1], target[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(orbit.target);
    const prevD = orbit.enableDamping;
    orbit.enableDamping = false;
    orbit.update();
    orbit.enableDamping = prevD;
    renderFrame();
  },
  getHandleOcclusionReport: () => volumeMgr.getHandleOcclusionReport(),
  mergeSelectedObjects,
  mergeSelectedVolumes,
  duplicateSceneObjectToTarget,
  duplicateVolumeNode: (id, parentId, idx) => {
    const before = volumeMgr.exportSnapshot();
    const cloned = volumeMgr.duplicateNode(id, parentId ?? null, idx ?? -1);
    if (cloned) {
      volumeMgr.syncAllVisuals(selectedVolumeIds, cloned.id);
      pushVolumeHistory(t("editor.history.dupMoveVol", { name: cloned.name }), before, volumeMgr.exportSnapshot());
      selectVolumeOrGroup(cloned.id, false);
    }
    return cloned ? cloned.id : null;
  },
  wrapVolumeGroupInParent,
  getHistoryDebug: () => {
    const tl = history.getTimeline();
    const blocks = buildGroupedHistoryBlocks(tl.entries.slice().reverse());
    return {
      currentIndex: tl.currentIndex,
      totalSteps: tl.totalSteps,
      blocks: blocks.map((b) =>
        b.type === "group"
          ? {
              type: "group",
              id: b.id,
              groupKey: b.groupKey,
              groupLabel: b.groupLabel,
              count: b.entries.length,
              containsCurrent: b.containsCurrent,
              open: isHistoryGroupOpen(b),
            }
          : { type: "entry", index: b.entry.index, label: b.entry.label, state: b.entry.state },
      ),
    };
  },
  getBoolOpState: () => ({
    standing: activeBoolOp,
    temp: contextBarHost.tempModifierBoolOp,
    effective: getEffectiveBoolOp(),
    brushRadiusPx,
  }),
  getColorWheelPicker: () => colorWheelPicker,
  getVolumeScopeGpuStatus: () => {
    const u = cloud?.material?.uniforms;
    return {
      active: u ? u.uVolScopeActive.value : 0,
      primCount: u ? u.uVolPrimCount.value : 0,
      opCount: u ? u.uVolOpCount.value : 0,
    };
  },
  getSpecialParams: () => specialParams,
  getCameraUp: () => camera.up.toArray(),
  getGizmo: () => gizmo,
  getPivot: () => pivot,
  getSceneObjectsInfo: () => sceneObjects.map((o) => ({
    id: o.id, name: o.name, groupId: o.groupId, visible: o.visible,
    pos: o.node.position.toArray(),
    rotDeg: [T.MathUtils.radToDeg(o.node.rotation.x), T.MathUtils.radToDeg(o.node.rotation.y), T.MathUtils.radToDeg(o.node.rotation.z)],
    scale: o.node.scale.toArray(),
    mergedPiecesCount: (o.mergedPieces || []).length,
  })),
  setPrimaryNodeRotationDeg: (rx, ry, rz) => {
    const n = getPrimaryTransformNode();
    if (!n) return false;
    n.rotation.set(T.MathUtils.degToRad(rx), T.MathUtils.degToRad(ry), T.MathUtils.degToRad(rz));
    n.updateMatrixWorld(true);
    syncObjectMatrices(true);
    syncTransformInputs();
    renderFrame();
    return true;
  },
  getPrimaryNodeTransform: () => {
    const n = getPrimaryTransformNode();
    if (!n) return null;
    return {
      pos: n.position.toArray(),
      rotDeg: [T.MathUtils.radToDeg(n.rotation.x), T.MathUtils.radToDeg(n.rotation.y), T.MathUtils.radToDeg(n.rotation.z)],
      quat: n.quaternion.toArray(),
      scale: n.scale.toArray(),
    };
  },
  simulateScaleGizmoDrag: (axis, scaleFactor) => {
    // Exercises the EXACT TransformControls + pivot objectChange path for automated verification!
    if (!gizmo.visible || gizmoMode !== "scale") setGizmoMode("scale");
    gizmo.axis = axis;
    gizmo.dispatchEvent({ type: "dragging-changed", value: true });
    const sx = axis.includes("X") ? scaleFactor : 1;
    const sy = axis.includes("Y") ? scaleFactor : 1;
    const sz = axis.includes("Z") ? scaleFactor : 1;
    if (gizmo.object === pivot) {
      pivot.scale.set(sx, sy, sz);
    } else if (gizmo.object) {
      gizmo.object.scale.multiply(new T.Vector3(sx, sy, sz));
    }
    gizmo.dispatchEvent({ type: "objectChange" });
    gizmo.dispatchEvent({ type: "dragging-changed", value: false });
    gizmo.axis = null;
    renderFrame();
    return window.__SPLAT_EDITOR__.getPrimaryNodeTransform();
  },
  simulateCtrlTranslateDrag: (dx, dy, dz) => {
    // Exercises Ctrl+Drag copy-move via 3D Viewport Translate Gizmo!
    setGizmoMode("translate");
    lastCanvasPointerCtrl = true;
    gizmo.axis = "X";
    gizmo.dispatchEvent({ type: "dragging-changed", value: true });
    if (gizmo.object === pivot) {
      pivot.position.x += dx;
      pivot.position.y += dy;
      pivot.position.z += dz;
    } else if (gizmo.object) {
      gizmo.object.position.x += dx;
      gizmo.object.position.y += dy;
      gizmo.object.position.z += dz;
    }
    gizmo.dispatchEvent({ type: "objectChange" });
    gizmo.dispatchEvent({ type: "dragging-changed", value: false });
    gizmo.axis = null;
    lastCanvasPointerCtrl = false;
    renderFrame();
    return { objCount: sceneObjects.length, volCount: volumeMgr.items.length };
  },
  buildV3Recipe: () => buildV3Recipe(),
  verifyCsgAgreement: (groupId, sampleCount = 600) => {
    const grp = volumeMgr.getGroup(groupId);
    if (!grp) return { ok: false, reason: "group not found" };
    volumeMgr.container.updateMatrixWorld(true);
    const prog = compileGroupCsgProgram(grp);
    const pred = volumeMgr.compileSingleOrGroup(groupId, camera.position);
    let matched = 0, insideCount = 0;
    const min = prog.aabbMin, max = prog.aabbMax;
    let seed = 1337;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < sampleCount; i++) {
      const x = min.x - 0.15 + rand() * (max.x - min.x + 0.3);
      const y = min.y - 0.15 + rand() * (max.y - min.y + 0.3);
      const z = min.z - 0.15 + rand() * (max.z - min.z + 0.3);
      const a = !!pred(x, y, z);
      const b = !!evaluateCsgProgramCpu(prog, x, y, z);
      if (a === b) matched++;
      if (a) insideCount++;
    }
    return { ok: matched === sampleCount, matched, total: sampleCount, insideCount, primCount: prog.primCount, opCount: prog.opCount };
  },
  openContextMenuAt: (x, y) => contextMenuUI.showAt(x, y),
  testLoadingEta: (pct, elapsedSec) => {
    loadingUI.update(true, t("editor.loading.decodingMassive"), pct);
    loadingUI._startMs = performance.now() - elapsedSec * 1000;
    loadingUI._smoothedRate = 2.4;
    loadingUI._renderEta(performance.now());
  },
  hideLoading: () => loadingUI.update(false),
  triggerCrashTest: (reason) => watchdog.triggerDowngrade(reason || t("editor.watchdog.stressTestReason")),
  getPerfStats: () => ({
    adaptiveDrawRatio: 1.0,
    lastRenderCostMs: Number(lastRenderCostMs.toFixed(2)),
    lastSortMs: cloud ? Number((cloud.lastSortMs || 0).toFixed(2)) : 0,
    lastSortUploadMs: cloud ? Number((cloud.lastSortUploadMs || 0).toFixed(2)) : 0,
    sortCompletedCount: cloud ? (cloud.sortCompletedCount || 0) : 0,
    drawnInstances: cloud ? (displayMode === "centers" ? cloud.centersGeo.instanceCount : cloud.geometry.instanceCount) : 0,
    totalPoints: cloud ? cloud.n : 0,
    cameraTarget: orbit ? orbit.target.toArray() : [0, 0, 0],
    sceneRadius: Number(lastSceneRadius.toFixed(4)),
    cameraFovY: camera ? camera.fov : 50,
  }),
  getState: () => ({
    displayMode,
    cameraControlMode,
    cameraDampingEnabled: orbit.enableDamping,
    interactiveDownsampleRemoved: true,
    lowPerfSafeMode,
    boundsVisible,
    gridVisible,
    activeTool,
    gizmoMode,
    totalPoints: cloud ? cloud.n : 0,
    totalSourcePoints,
    objectCount: sceneObjects.length,
    objectGroupCount: sceneObjectGroups.length,
    volumeCount: volumeMgr.items.length,
    volumeGroupCount: volumeMgr.groups.length,
    undoCount: history.undoStack.length,
    redoCount: history.redoStack.length,
    colorPanelOpen,
    splitCompareActive,
    semanticStatus: semanticEngine.getStatusLabel(),
    contextBarCount: contextBarHost.count,
    tooltipDelayMs: tooltipMgr.delayMs,
  }),
};

postHost("ready");
