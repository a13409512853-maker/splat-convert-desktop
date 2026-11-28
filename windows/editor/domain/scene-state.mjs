/**
 * @module domain/scene-state
 * @description Pure, graphics-free persistent scene document state owned by EditSession:
 *  - Scene Objects & Groups transforms / visibility / membership
 *  - Parametric Bounding Volumes & CSG Boolean Groups snapshot (`primitiveCoordSystem: "y-up"`)
 *  - Live Color Grading state
 *  - Non-destructive Measure Scale calibration & pinned measurement summaries
 *
 * ZERO DOM, ZERO WebGL, ZERO Three.js dependencies.
 * Can be executed & verified standalone in Node.js and shared across WebGL2 & Native Vulkan backends.
 */
import { COORD_CONTRACT, createIdentityMatrix16, DomainError, ERROR_CODES } from "./contracts.mjs";

export class SceneStateStore {
  constructor() {
    this._objects = [];
    this._objectGroups = [];
    this._volumesSnapshot = {
      primitiveCoordSystem: COORD_CONTRACT.system,
      topLevelOrder: [],
      groups: [],
      items: [],
    };
    this._colorGrade = null;
    this._measureScale = { factor: 1, unit: "m", calibrated: false };
    this._measurePins = [];
  }

  /**
   * Capture a full serializable snapshot of all non-point persistent scene state.
   */
  captureSnapshot() {
    return {
      objects: structuredClone(this._objects),
      objectGroups: structuredClone(this._objectGroups),
      volumesSnapshot: structuredClone(this._volumesSnapshot),
      colorGrade: this._colorGrade ? structuredClone(this._colorGrade) : null,
      measureScale: structuredClone(this._measureScale),
      measurePins: structuredClone(this._measurePins),
    };
  }

  restoreSnapshot(snap) {
    if (!snap || typeof snap !== "object") return;
    if (Array.isArray(snap.objects)) this._objects = structuredClone(snap.objects);
    if (Array.isArray(snap.objectGroups)) this._objectGroups = structuredClone(snap.objectGroups);
    if (snap.volumesSnapshot && typeof snap.volumesSnapshot === "object") {
      this._volumesSnapshot = structuredClone(snap.volumesSnapshot);
    }
    this._colorGrade = snap.colorGrade ? structuredClone(snap.colorGrade) : null;
    if (snap.measureScale && typeof snap.measureScale === "object") {
      this._measureScale = structuredClone(snap.measureScale);
    }
    if (Array.isArray(snap.measurePins)) this._measurePins = structuredClone(snap.measurePins);
  }

  // --- Scene Objects & Groups ---
  setSceneGraph(objects, objectGroups = []) {
    if (!Array.isArray(objects)) {
      throw new DomainError(ERROR_CODES.INVALID_COMMAND, "objects must be an array.");
    }
    this._objects = objects.map((o) => ({
      id: Number(o.id),
      name: String(o.name || `Object ${o.id}`),
      visible: o.visible !== false,
      groupId: o.groupId ?? null,
      sourceKind: o.sourceKind || "original",
      matrix: Array.isArray(o.matrix) && o.matrix.length === 16 ? o.matrix.slice() : createIdentityMatrix16(),
    }));
    this._objectGroups = Array.isArray(objectGroups)
      ? objectGroups.map((g) => ({
          id: String(g.id),
          name: String(g.name || g.id),
          memberIds: Array.isArray(g.memberIds) ? g.memberIds.map(Number) : [],
        }))
      : [];
  }

  setObjectTransform(objectId, matrix16) {
    if (!Array.isArray(matrix16) || matrix16.length !== 16) {
      throw new DomainError(ERROR_CODES.INVALID_COMMAND, "matrix16 must be a 16-number column-major array.");
    }
    const id = Number(objectId);
    let obj = this._objects.find((o) => o.id === id);
    if (!obj) {
      obj = {
        id,
        name: id === 0 ? "Main Scene Cloud" : `Object ${id}`,
        visible: true,
        groupId: null,
        sourceKind: id === 0 ? "original" : "split",
        matrix: createIdentityMatrix16(),
      };
      this._objects.push(obj);
    }
    const prev = obj.matrix.slice();
    obj.matrix = matrix16.slice();
    return { before: prev, after: obj.matrix.slice() };
  }

  getObjects() {
    return structuredClone(this._objects);
  }

  getObjectGroups() {
    return structuredClone(this._objectGroups);
  }

  // --- Parametric Volumes & CSG Boolean Groups ---
  setVolumesSnapshot(snap) {
    const prev = structuredClone(this._volumesSnapshot);
    if (!snap || typeof snap !== "object") {
      this._volumesSnapshot = {
        primitiveCoordSystem: COORD_CONTRACT.system,
        topLevelOrder: [],
        groups: [],
        items: [],
      };
    } else {
      const next = structuredClone(snap);
      if (!next.primitiveCoordSystem) next.primitiveCoordSystem = COORD_CONTRACT.system;
      this._volumesSnapshot = next;
    }
    return { before: prev, after: structuredClone(this._volumesSnapshot) };
  }

  getVolumesSnapshot() {
    return structuredClone(this._volumesSnapshot);
  }

  // --- Live Color Grading ---
  setColorGrade(grade) {
    const prev = this._colorGrade ? structuredClone(this._colorGrade) : null;
    this._colorGrade = grade ? structuredClone(grade) : null;
    return { before: prev, after: this._colorGrade ? structuredClone(this._colorGrade) : null };
  }

  getColorGrade() {
    return this._colorGrade ? structuredClone(this._colorGrade) : null;
  }

  // --- Measure Scale & Pinned Measurements ---
  setMeasureScale(scaleCfg) {
    const prev = structuredClone(this._measureScale);
    if (scaleCfg && typeof scaleCfg === "object") {
      const factor = Number(scaleCfg.factor);
      this._measureScale = {
        factor: Number.isFinite(factor) && factor > 0 ? factor : 1,
        unit: ["m", "cm", "mm"].includes(scaleCfg.unit) ? scaleCfg.unit : "m",
        calibrated: !!scaleCfg.calibrated,
      };
    }
    return { before: prev, after: structuredClone(this._measureScale) };
  }

  getMeasureScale() {
    return structuredClone(this._measureScale);
  }

  setMeasurePins(pins) {
    const prev = structuredClone(this._measurePins);
    this._measurePins = Array.isArray(pins) ? structuredClone(pins) : [];
    return { before: prev, after: structuredClone(this._measurePins) };
  }

  getMeasurePins() {
    return structuredClone(this._measurePins);
  }

  dispose() {
    this._objects = [];
    this._objectGroups = [];
    this._volumesSnapshot = { primitiveCoordSystem: COORD_CONTRACT.system, topLevelOrder: [], groups: [], items: [] };
    this._colorGrade = null;
    this._measurePins = [];
  }
}
