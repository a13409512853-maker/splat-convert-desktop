// Bounding Volumes (Box, Ellipsoid, +Y Cylinder) + Infinite Camera-Facing Occlusion Plane
// + Sleek 2D Flat Camera-Facing Face Handles with Real-Time Volume Occlusion Dimming (rc11 #2.1)
// + Recursive Nested Volume Groups with strictly ordered top-to-bottom boolean evaluation (∪ / − / ∩)
// + Real-Time Exact Analytical GPU Ray-Cast CSG Translucent Preview Shell for Enabled Volume Groups
// + Drag-and-drop reordering, Ctrl+Drag duplicate-move, cross-group nesting, & Full Undo/Redo Snapshots.
import * as T from "three";
import { compileGroupCsgProgram, evaluateCsgProgramCpu, CsgVolumePreview } from "./csg.js";
import { migrateRecipeVolumesToYUp } from "./domain/recipe-codec.mjs";
import { t } from "./i18n.js";

let _nextVolId = 1;

const HANDLE_COLORS = {
  px: 0xef4444, nx: 0xef4444, // ±X Red
  py: 0x22c55e, ny: 0x22c55e, // ±Y Green
  pz: 0x3b82f6, nz: 0x3b82f6, // ±Z Blue
};

const HANDLE_HOVER_COLOR = 0xfacc15; // Crisp yellow hover highlight

const FACE_DEFS = [
  { key: "px", dir: [1, 0, 0], axis: 0, sign: 1 },
  { key: "nx", dir: [-1, 0, 0], axis: 0, sign: -1 },
  { key: "py", dir: [0, 1, 0], axis: 1, sign: 1 },
  { key: "ny", dir: [0, -1, 0], axis: 1, sign: -1 },
  { key: "pz", dir: [0, 0, 1], axis: 2, sign: 1 },
  { key: "nz", dir: [0, 0, -1], axis: 2, sign: -1 },
];

const _TMP_POS = new T.Vector3();
const _TMP_QUAT = new T.Quaternion();
const _TMP_SCALE = new T.Vector3();
const _TMP_HANDLE_POS = new T.Vector3();
const _TMP_RO = new T.Vector3();
const _TMP_RD = new T.Vector3();
const _TMP_LO = new T.Vector3();
const _TMP_LD = new T.Vector3();
const _TMP_PT = new T.Vector3();
const _DIM_TARGET_COLOR = new T.Color(0x464e5c);
const _TMP_COLOR = new T.Color();

function rayIntersectLocalUnitPrimitive(kindCode, lo, ld) {
  if (kindCode === 0) {
    // Unit Box: |x|<=1, |y|<=1, |z|<=1
    const dx = Math.abs(ld.x) < 1e-9 ? (ld.x >= 0 ? 1e-9 : -1e-9) : ld.x;
    const dy = Math.abs(ld.y) < 1e-9 ? (ld.y >= 0 ? 1e-9 : -1e-9) : ld.y;
    const dz = Math.abs(ld.z) < 1e-9 ? (ld.z >= 0 ? 1e-9 : -1e-9) : ld.z;
    const tx0 = (-1 - lo.x) / dx, tx1 = (1 - lo.x) / dx;
    const ty0 = (-1 - lo.y) / dy, ty1 = (1 - lo.y) / dy;
    const tz0 = (-1 - lo.z) / dz, tz1 = (1 - lo.z) / dz;
    const t0 = Math.max(Math.min(tx0, tx1), Math.min(ty0, ty1), Math.min(tz0, tz1));
    const t1 = Math.min(Math.max(tx0, tx1), Math.max(ty0, ty1), Math.max(tz0, tz1));
    return t1 > Math.max(t0, 0) ? [t0, t1] : null;
  }
  if (kindCode === 1) {
    // Unit Ellipsoid: x^2 + y^2 + z^2 <= 1
    const a = ld.x * ld.x + ld.y * ld.y + ld.z * ld.z;
    if (a < 1e-12) return null;
    const b = lo.x * ld.x + lo.y * ld.y + lo.z * ld.z;
    const c = lo.x * lo.x + lo.y * lo.y + lo.z * lo.z - 1;
    const disc = b * b - a * c;
    if (disc <= 0) return null;
    const sq = Math.sqrt(disc);
    const t0 = (-b - sq) / a;
    const t1 = (-b + sq) / a;
    return t1 > Math.max(t0, 0) ? [t0, t1] : null;
  }
  // Unit +Y-up Cylinder: x^2 + z^2 <= 1, |y| <= 1
  const a = ld.x * ld.x + ld.z * ld.z;
  const b = lo.x * ld.x + lo.z * ld.z;
  const c = lo.x * lo.x + lo.z * lo.z - 1;
  let tCyl0 = -1e20, tCyl1 = 1e20;
  if (a < 1e-10) {
    if (c > 0) return null;
  } else {
    const disc = b * b - a * c;
    if (disc <= 0) return null;
    const sq = Math.sqrt(disc);
    tCyl0 = (-b - sq) / a;
    tCyl1 = (-b + sq) / a;
  }
  let tY0 = -1e20, tY1 = 1e20;
  if (Math.abs(ld.y) < 1e-9) {
    if (Math.abs(lo.y) > 1) return null;
  } else {
    const ya = (-1 - lo.y) / ld.y;
    const yb = (1 - lo.y) / ld.y;
    tY0 = Math.min(ya, yb);
    tY1 = Math.max(ya, yb);
  }
  const t0 = Math.max(tCyl0, tY0);
  const t1 = Math.min(tCyl1, tY1);
  return t1 > Math.max(t0, 0) ? [t0, t1] : null;
}

function rayIntersectAabb(ro, rd, minV, maxV) {
  const dx = Math.abs(rd.x) < 1e-9 ? (rd.x >= 0 ? 1e-9 : -1e-9) : rd.x;
  const dy = Math.abs(rd.y) < 1e-9 ? (rd.y >= 0 ? 1e-9 : -1e-9) : rd.y;
  const dz = Math.abs(rd.z) < 1e-9 ? (rd.z >= 0 ? 1e-9 : -1e-9) : rd.z;
  const tx0 = (minV.x - ro.x) / dx, tx1 = (maxV.x - ro.x) / dx;
  const ty0 = (minV.y - ro.y) / dy, ty1 = (maxV.y - ro.y) / dy;
  const tz0 = (minV.z - ro.z) / dz, tz1 = (maxV.z - ro.z) / dz;
  const t0 = Math.max(Math.min(tx0, tx1), Math.min(ty0, ty1), Math.min(tz0, tz1));
  const t1 = Math.min(Math.max(tx0, tx1), Math.max(ty0, ty1), Math.max(tz0, tz1));
  return t1 > Math.max(t0, 0) ? [t0, t1] : null;
}

export class VolumeItem {
  constructor(kind, name = null, forcedId = null) {
    if (forcedId) {
      this.id = forcedId;
      const num = parseInt(String(forcedId).replace(/\D+/g, ""), 10);
      if (Number.isFinite(num) && num >= _nextVolId) _nextVolId = num + 1;
    } else {
      this.id = "vol_" + _nextVolId++;
    }
    this.isVolumeGroup = false;
    this.kind = kind; // "box" | "ellipsoid" | "cylinder" | "plane"
    const labels = {
      box: t("editor.volumes.box"),
      ellipsoid: t("editor.volumes.ellipsoid"),
      cylinder: t("editor.volumes.cylinder"),
      plane: t("editor.volumes.plane"),
    };
    const idxNum = parseInt(this.id.replace(/\D+/g, ""), 10) || 1;
    this.name = name || t("editor.volumes.itemName", { kind: labels[kind] || t("editor.volumes.fallback"), num: idxNum });
    this.enabled = true;
    this.visible = true;
    this.groupId = null;
    this.boolOp = "union"; // "union" | "subtract" | "intersect"

    this.root = new T.Group();
    this.root.name = this.id;
    this.root.userData.volumeId = this.id;
    // Dedicated world-space handle container (mounted outside this.root so non-uniform box scaling NEVER shears squares!)
    this.handleGroup = new T.Group();
    this.handleGroup.name = this.id + "_handles";
    this.handleGroup.visible = false;
    this.handles = [];
    this.hoverHighlightMesh = null;
    this._selected = false;
    this._effectivelyEnabled = true;
    this._inCsgGroup = false;
    this._hoveredHandleKey = null;

    // Creation initial transform (used by #2 Reset Arrows on Transform Card!)
    this.initialPosition = [0, 0, 0];
    this.initialRotation = [0, 0, 0];
    this.initialScale = [1, 1, 1];

    this._buildVisuals();
  }

  captureInitialTransform() {
    this.initialPosition = this.root.position.toArray();
    this.initialRotation = [this.root.rotation.x, this.root.rotation.y, this.root.rotation.z];
    this.initialScale = this.root.scale.toArray();
  }

  _buildVisuals() {
    const isPlane = this.kind === "plane";
    this.wireMat = new T.LineBasicMaterial({
      color: isPlane ? 0x3b82f6 : 0x4ade80,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    this.fillMat = new T.MeshBasicMaterial({
      color: isPlane ? 0x3b82f6 : 0xd6964c,
      transparent: true,
      opacity: isPlane ? 0.10 : 0.09,
      side: T.DoubleSide,
      depthWrite: false,
    });

    if (this.kind === "box") {
      const boxGeo = new T.BoxGeometry(2, 2, 2);
      this.fillMesh = new T.Mesh(boxGeo, this.fillMat);
      this.fillMesh.userData.volumeId = this.id;
      this.fillMesh.renderOrder = 11;
      this.wireMesh = new T.LineSegments(new T.EdgesGeometry(boxGeo), this.wireMat);
      this.wireMesh.renderOrder = 15;
      this.root.add(this.fillMesh, this.wireMesh);
      this._createFaceHandles();
      this._createBoxHoverHighlight();
    } else if (this.kind === "ellipsoid") {
      const sphGeo = new T.SphereGeometry(1, 32, 22);
      this.fillMesh = new T.Mesh(sphGeo, this.fillMat);
      this.fillMesh.userData.volumeId = this.id;
      this.fillMesh.renderOrder = 11;
      this.root.add(this.fillMesh);
      const makeRing = (rotX, rotY) => {
        const pts = [];
        for (let i = 0; i <= 72; i++) {
          const a = (i / 72) * Math.PI * 2;
          pts.push(new T.Vector3(Math.cos(a), Math.sin(a), 0));
        }
        const l = new T.Line(new T.BufferGeometry().setFromPoints(pts), this.wireMat);
        l.rotation.set(rotX, rotY, 0);
        l.renderOrder = 15;
        return l;
      };
      this.root.add(makeRing(0, 0), makeRing(Math.PI / 2, 0), makeRing(0, Math.PI / 2));
      this._createFaceHandles();
      this._createRingHoverHighlight();
    } else if (this.kind === "cylinder") {
      // Three.js CylinderGeometry is natively +Y-up (x^2 + z^2 <= 1, |y| <= 1)
      const cylGeo = new T.CylinderGeometry(1, 1, 2, 36, 1, false);
      this.fillMesh = new T.Mesh(cylGeo, this.fillMat);
      this.fillMesh.userData.volumeId = this.id;
      this.fillMesh.renderOrder = 11;
      this.wireMesh = new T.LineSegments(new T.EdgesGeometry(cylGeo, 20), this.wireMat);
      this.wireMesh.renderOrder = 15;
      this.root.add(this.fillMesh, this.wireMesh);
      this._createFaceHandles();
      this._createRingHoverHighlight();
    } else if (this.kind === "plane") {
      const plGeo = new T.PlaneGeometry(4, 4);
      this.fillMesh = new T.Mesh(plGeo, this.fillMat);
      this.fillMesh.userData.volumeId = this.id;
      this.fillMesh.renderOrder = 11;
      const borderPts = [
        new T.Vector3(-2, -2, 0), new T.Vector3(2, -2, 0),
        new T.Vector3(2, 2, 0), new T.Vector3(-2, 2, 0),
        new T.Vector3(-2, -2, 0),
      ];
      const crossPts = [
        new T.Vector3(-2, 0, 0), new T.Vector3(2, 0, 0),
        new T.Vector3(0, -2, 0), new T.Vector3(0, 2, 0),
      ];
      this.wireMesh = new T.Line(new T.BufferGeometry().setFromPoints(borderPts), this.wireMat);
      this.wireMesh.renderOrder = 15;
      const cross = new T.LineSegments(new T.BufferGeometry().setFromPoints(crossPts), this.wireMat);
      cross.renderOrder = 15;
      this.root.add(this.fillMesh, this.wireMesh, cross);
    }

    this.applyAppearance({ selected: false, effectivelyEnabled: true, inCsgGroup: false, isSubtract: false });
  }

  _createBoxHoverHighlight() {
    const faceGeo = new T.PlaneGeometry(2, 2);
    const faceMat = new T.MeshBasicMaterial({
      color: HANDLE_HOVER_COLOR,
      transparent: true,
      opacity: 0.22,
      side: T.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    const borderGeo = new T.EdgesGeometry(faceGeo);
    const borderMat = new T.LineBasicMaterial({ color: HANDLE_HOVER_COLOR, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    const grp = new T.Group();
    const fMesh = new T.Mesh(faceGeo, faceMat);
    fMesh.renderOrder = 20;
    const bMesh = new T.LineSegments(borderGeo, borderMat);
    bMesh.renderOrder = 21;
    grp.add(fMesh, bMesh);
    grp.visible = false;
    this.hoverHighlightMesh = grp;
    this.root.add(grp);
  }

  _createRingHoverHighlight() {
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push(new T.Vector3(Math.cos(a) * 0.42, Math.sin(a) * 0.42, 0));
    }
    const lineMat = new T.LineBasicMaterial({ color: HANDLE_HOVER_COLOR, depthTest: false });
    const discMat = new T.MeshBasicMaterial({
      color: HANDLE_HOVER_COLOR,
      transparent: true,
      opacity: 0.20,
      side: T.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    const grp = new T.Group();
    grp.add(
      new T.Mesh(new T.CircleGeometry(0.42, 48), discMat),
      new T.Line(new T.BufferGeometry().setFromPoints(pts), lineMat),
    );
    grp.visible = false;
    grp.renderOrder = 18;
    this.hoverHighlightMesh = grp;
    this.root.add(grp);
  }

  /**
   * #9 Sleek 2D flat camera-facing colored squares with crisp thin dark hairline border (Fig 5 style, ZERO 3D cube volume!).
   */
  _createFaceHandles() {
    const sqGeo = new T.PlaneGeometry(1, 1);
    const borderGeo = new T.PlaneGeometry(1.18, 1.18);
    for (const d of FACE_DEFS) {
      const borderMat = new T.MeshBasicMaterial({
        color: 0x0b0d12,
        transparent: true,
        opacity: 0.94,
        side: T.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const mat = new T.MeshBasicMaterial({
        color: HANDLE_COLORS[d.key],
        transparent: true,
        opacity: 1.0,
        side: T.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const m = new T.Mesh(sqGeo, mat);
      m.position.set(d.dir[0], d.dir[1], d.dir[2]);
      m.renderOrder = 28;
      const border = new T.Mesh(borderGeo, borderMat);
      border.position.z = -0.002;
      border.renderOrder = 27;
      m.add(border);
      m.userData = {
        isVolumeHandle: true,
        volumeId: this.id,
        handleKey: d.key,
        dir: d.dir,
        axis: d.axis,
        sign: d.sign,
        baseColor: HANDLE_COLORS[d.key],
        borderMesh: border,
        occluded: false,
      };
      this.handles.push(m);
      this.handleGroup.add(m);
    }
  }

  _refreshHandleAppearance(h) {
    const isHovered = h.userData.handleKey === this._hoveredHandleKey;
    const occluded = !!h.userData.occluded;
    const border = h.userData.borderMesh;
    if (isHovered) {
      h.material.color.setHex(HANDLE_HOVER_COLOR);
      h.material.opacity = 1.0;
      h.renderOrder = 30;
      if (border) {
        border.material.opacity = 0.96;
        border.renderOrder = 29;
      }
    } else if (occluded) {
      // Visually recessed & desaturated when occluded by any bounding volume between camera and handle (rc11 #2.1)
      _TMP_COLOR.setHex(h.userData.baseColor).lerp(_DIM_TARGET_COLOR, 0.48);
      h.material.color.copy(_TMP_COLOR);
      h.material.opacity = 0.34;
      h.renderOrder = 24;
      if (border) {
        border.material.opacity = 0.24;
        border.renderOrder = 23;
      }
    } else {
      h.material.color.setHex(h.userData.baseColor);
      h.material.opacity = 1.0;
      h.renderOrder = 28;
      if (border) {
        border.material.opacity = 0.94;
        border.renderOrder = 27;
      }
    }
  }

  setHandleOccluded(handle, occluded) {
    const next = !!occluded;
    handle.userData.occluded = next;
    this._refreshHandleAppearance(handle);
  }

  setHoveredHandle(handleKey) {
    if (this._hoveredHandleKey === handleKey) return;
    this._hoveredHandleKey = handleKey;
    for (const h of this.handles) {
      this._refreshHandleAppearance(h);
    }
    if (this.hoverHighlightMesh) {
      const def = FACE_DEFS.find((f) => f.key === handleKey);
      if (!def || !this._selected) {
        this.hoverHighlightMesh.visible = false;
      } else {
        this.hoverHighlightMesh.visible = true;
        const posMul = this.kind === "box" ? 1.0 : 0.88;
        this.hoverHighlightMesh.position.set(def.dir[0] * posMul, def.dir[1] * posMul, def.dir[2] * posMul);
        this.hoverHighlightMesh.rotation.set(0, 0, 0);
        if (def.axis === 0) this.hoverHighlightMesh.rotation.y = Math.PI / 2;
        else if (def.axis === 1) this.hoverHighlightMesh.rotation.x = Math.PI / 2;
      }
    }
  }

  /**
   * Apply distinct visual states for Enabled (#7) vs Selected (#7 / Fig 1) vs CSG Group (#10 / Fig 5):
   * - Unenabled: neutral cool-gray thin wireframe, NO yellow/amber fill!
   * - Enabled standalone: crisp green/blue wireframe + translucent warm amber fill.
   * - Enabled inside CSG group: crisp green (union) / coral-red (subtract) / amber (intersect) wireframe;
   *   fill is rendered by the parent group's unified CSG composite shell (opacity 0 on raw fill so raycast still works!).
   * - Selected: bright highlight wireframe + sleek flat 2D handles.
   */
  applyAppearance({ selected = this._selected, effectivelyEnabled = this._effectivelyEnabled, inCsgGroup = this._inCsgGroup, isSubtract = false, isIntersect = false } = {}) {
    this._selected = !!selected;
    this._effectivelyEnabled = !!effectivelyEnabled;
    this._inCsgGroup = !!inCsgGroup;
    if (!this._selected) this.setHoveredHandle(null);

    const isPlane = this.kind === "plane";
    if (!this._effectivelyEnabled) {
      // Unenabled: NO amber/yellow fill; subtle gray wireframe (or bright orange outline if selected for transform)
      this.wireMat.color.setHex(this._selected ? 0xfb923c : 0x7c8696);
      this.wireMat.opacity = this._selected ? 0.92 : 0.48;
      this.fillMat.opacity = 0.0; // invisible visually, still raycastable!
    } else if (isPlane) {
      this.wireMat.color.setHex(this._selected ? 0x60a5fa : 0x3b82f6);
      this.wireMat.opacity = this._selected ? 0.88 : 0.64;
      this.fillMat.color.setHex(0x3b82f6);
      this.fillMat.opacity = this._selected ? 0.13 : 0.08;
    } else {
      // rc12 #4.2: Lighter, subtler enabled 3D bounding volume fill so enclosed Gaussians remain crystal clear!
      let wireHex = 0x4ade80;
      if (isSubtract) wireHex = 0xf87171;
      else if (isIntersect) wireHex = 0xfbbf24;
      if (this._selected) {
        wireHex = isSubtract ? 0xfca5a5 : 0x86efac;
      }
      this.wireMat.color.setHex(wireHex);
      this.wireMat.opacity = this._selected ? 0.88 : 0.62;
      this.fillMat.color.setHex(0xd6964c);
      // Inside an enabled CSG group, the group's unified CSG preview mesh renders the exact boolean volume!
      this.fillMat.opacity = this._inCsgGroup ? 0.0 : (this._selected ? 0.13 : 0.085);
    }

    this.handleGroup.visible = this._selected && this.visible;
    for (const h of this.handles) {
      h.visible = this._selected && this.visible;
    }
  }

  setSelected(sel) {
    this.applyAppearance({ selected: !!sel });
  }

  /**
   * Position & orient 2D flat handles strictly in UN-SCALED WORLD SPACE so non-uniform Box/Ellipsoid/Cylinder
   * scaling or scaled parent VolumeGroups can NEVER shear or deform handles away from perfect squares!
   */
  updateHandleScales(camera = null) {
    if (this.handles.length === 0) return;
    this.root.updateMatrixWorld(true);
    this.root.matrixWorld.decompose(_TMP_POS, _TMP_QUAT, _TMP_SCALE);

    const sx = Math.max(0.01, Math.abs(_TMP_SCALE.x));
    const sy = Math.max(0.01, Math.abs(_TMP_SCALE.y));
    const sz = Math.max(0.01, Math.abs(_TMP_SCALE.z));
    const maxCap = Math.max(sx, sy, sz) * 0.35;
    const orthoSize =
      camera && camera.isOrthographicCamera
        ? (Math.abs(camera.top - camera.bottom) / Math.max(0.01, camera.zoom)) * 0.0135
        : null;

    for (const h of this.handles) {
      const dir = h.userData.dir;
      _TMP_HANDLE_POS.set(dir[0], dir[1], dir[2]).applyMatrix4(this.root.matrixWorld);
      h.position.copy(_TMP_HANDLE_POS);

      if (camera) {
        h.quaternion.copy(camera.quaternion);
      } else {
        h.quaternion.identity();
      }

      let targetWorldSize;
      if (orthoSize !== null) {
        targetWorldSize = orthoSize;
      } else if (camera) {
        const dist = Math.max(0.1, camera.position.distanceTo(_TMP_HANDLE_POS));
        targetWorldSize = dist * 0.0135;
      } else {
        targetWorldSize = ((sx + sy + sz) / 3) * 0.055;
      }
      targetWorldSize = Math.max(0.012, Math.min(maxCap, targetWorldSize));

      const hoverBoost = h.userData.handleKey === this._hoveredHandleKey ? 1.35 : 1.0;
      const szW = targetWorldSize * hoverBoost;
      // Strict isotropic world-space scale -> ALWAYS a crisp 1:1 square regardless of box aspect ratio or view angle!
      h.scale.set(szW, szW, 1);
      h.updateMatrixWorld(true);
    }
  }

  containsWorldPoint(x, y, z, invMatrix, cameraPos = null) {
    if (this.kind === "plane") {
      if (!cameraPos) return true;
      const pz = invMatrix[2] * x + invMatrix[6] * y + invMatrix[10] * z + invMatrix[14];
      const cz =
        invMatrix[2] * cameraPos.x +
        invMatrix[6] * cameraPos.y +
        invMatrix[10] * cameraPos.z +
        invMatrix[14];
      return cz >= 0 ? pz >= 0 : pz <= 0;
    }

    const a = invMatrix[0] * x + invMatrix[4] * y + invMatrix[8] * z + invMatrix[12];
    const b = invMatrix[1] * x + invMatrix[5] * y + invMatrix[9] * z + invMatrix[13];
    const c = invMatrix[2] * x + invMatrix[6] * y + invMatrix[10] * z + invMatrix[14];

    if (this.kind === "box") {
      return Math.abs(a) <= 1 && Math.abs(b) <= 1 && Math.abs(c) <= 1;
    }
    if (this.kind === "ellipsoid") {
      return a * a + b * b + c * c <= 1;
    }
    if (this.kind === "cylinder") {
      return a * a + c * c <= 1 && Math.abs(b) <= 1;
    }
    return false;
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      enabled: this.enabled,
      visible: this.visible,
      groupId: this.groupId,
      boolOp: this.boolOp,
      primitiveCoordSystem: "y-up",
      position: this.root.position.toArray(),
      rotation: [this.root.rotation.x, this.root.rotation.y, this.root.rotation.z],
      scale: this.root.scale.toArray(),
      initialPosition: this.initialPosition.slice(),
      initialRotation: this.initialRotation.slice(),
      initialScale: this.initialScale.slice(),
    };
  }
}

export class VolumeGroup {
  constructor(name = null, forcedId = null) {
    if (forcedId) {
      this.id = forcedId;
      const num = parseInt(String(forcedId).replace(/\D+/g, ""), 10);
      if (Number.isFinite(num) && num >= _nextVolId) _nextVolId = num + 1;
    } else {
      this.id = "vgrp_" + _nextVolId++;
    }
    this.isVolumeGroup = true;
    const idxNum = parseInt(this.id.replace(/\D+/g, ""), 10) || 1;
    this.name = name || t("editor.volumes.groupName", { num: idxNum });
    this.enabled = true;
    this.visible = true;
    this.collapsed = false;
    this.parentGroupId = null; // supports recursive group-inside-group nesting (#6)!
    this.boolOp = "union";     // group-to-group boolean op when nested inside a parent group (#6)!
    this.root = new T.Group();
    this.root.name = this.id;
    this.children = [];        // Array<VolumeItem | VolumeGroup>, strictly evaluated top-to-bottom!

    this.initialPosition = [0, 0, 0];
    this.initialRotation = [0, 0, 0];
    this.initialScale = [1, 1, 1];
  }

  captureInitialTransform() {
    this.initialPosition = this.root.position.toArray();
    this.initialRotation = [this.root.rotation.x, this.root.rotation.y, this.root.rotation.z];
    this.initialScale = this.root.scale.toArray();
  }

  addChild(node, boolOp = null, insertIndex = -1) {
    if (node.isVolumeGroup) node.parentGroupId = this.id;
    else node.groupId = this.id;
    if (boolOp) node.boolOp = boolOp;
    else if (!node.boolOp) node.boolOp = "union";
    if (insertIndex >= 0 && insertIndex <= this.children.length) {
      this.children.splice(insertIndex, 0, node);
    } else {
      this.children.push(node);
    }
    this.root.attach(node.root);
  }

  addItem(item, boolOp = "union") {
    this.addChild(item, boolOp);
  }

  removeChild(node) {
    const idx = this.children.indexOf(node);
    if (idx >= 0) this.children.splice(idx, 1);
    if (node.isVolumeGroup) node.parentGroupId = null;
    else node.groupId = null;
  }

  removeItem(item) {
    this.removeChild(item);
  }

  moveChild(nodeId, delta) {
    const idx = this.children.findIndex((c) => c.id === nodeId);
    if (idx < 0) return false;
    const next = idx + delta;
    if (next < 0 || next >= this.children.length) return false;
    const [it] = this.children.splice(idx, 1);
    this.children.splice(next, 0, it);
    return true;
  }

  countLeafItems() {
    let total = 0;
    for (const c of this.children) {
      total += c.isVolumeGroup ? c.countLeafItems() : 1;
    }
    return total;
  }

  collectLeafItems(out = []) {
    for (const c of this.children) {
      if (c.isVolumeGroup) c.collectLeafItems(out);
      else out.push(c);
    }
    return out;
  }

  collectAllDescendantIds(out = new Set()) {
    for (const c of this.children) {
      out.add(c.id);
      if (c.isVolumeGroup) c.collectAllDescendantIds(out);
    }
    return out;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      visible: this.visible,
      collapsed: !!this.collapsed,
      parentGroupId: this.parentGroupId || null,
      boolOp: this.boolOp || "union",
      position: this.root.position.toArray(),
      rotation: [this.root.rotation.x, this.root.rotation.y, this.root.rotation.z],
      scale: this.root.scale.toArray(),
      initialPosition: this.initialPosition.slice(),
      initialRotation: this.initialRotation.slice(),
      initialScale: this.initialScale.slice(),
      childIds: this.children.map((c) => c.id),
    };
  }
}

export class VolumeManager {
  constructor(scene) {
    this.scene = scene;
    this.container = new T.Group();
    this.container.name = "VolumesContainer";
    scene.add(this.container);
    this.items = [];
    this.groups = [];
    this.topLevelOrder = []; // Ordered IDs of top-level VolumeGroups & loose VolumeItems (drag-reorderable!)

    // Dedicated world-space exact analytical GPU ray-cast CSG preview container for enabled volume groups (#10)
    this.csgPreviewContainer = new T.Group();
    this.csgPreviewContainer.name = "VolumeCsgPreviews";
    this.container.add(this.csgPreviewContainer);
    // Dedicated world-space un-scaled 2D handle container (prevents non-uniform box scale shear!)
    this.handleContainer = new T.Group();
    this.handleContainer.name = "VolumeHandlesWorld";
    this.container.add(this.handleContainer);
    this._csgMeshes = new Map(); // topGroupId -> { preview: CsgVolumePreview, sig }
    this._lastCamera = null;
  }

  _ensureTopLevelOrder() {
    const validTop = new Set();
    for (const g of this.groups) if (!g.parentGroupId) validTop.add(g.id);
    for (const v of this.items) if (!v.groupId) validTop.add(v.id);
    this.topLevelOrder = this.topLevelOrder.filter((id) => validTop.has(id));
    for (const g of this.groups) if (!g.parentGroupId && !this.topLevelOrder.includes(g.id)) this.topLevelOrder.push(g.id);
    for (const v of this.items) if (!v.groupId && !this.topLevelOrder.includes(v.id)) this.topLevelOrder.push(v.id);
  }

  getTopLevelNodes() {
    this._ensureTopLevelOrder();
    return this.topLevelOrder.map((id) => this.getNode(id)).filter(Boolean);
  }

  getNode(id) {
    return this.getItem(id) || this.getGroup(id);
  }

  getItem(id) {
    return this.items.find((v) => v.id === id) || null;
  }

  getGroup(id) {
    return this.groups.find((g) => g.id === id) || null;
  }

  getParentGroupId(node) {
    if (!node) return null;
    return node.isVolumeGroup ? node.parentGroupId : node.groupId;
  }

  /**
   * Walk up the group hierarchy to return the outermost top-level VolumeGroup, or null if loose.
   */
  getTopLevelGroup(id) {
    let cur = this.getNode(id);
    if (!cur) return null;
    let topGrp = cur.isVolumeGroup ? cur : null;
    let guard = 0;
    while (cur && guard++ < 16) {
      const pid = this.getParentGroupId(cur);
      if (!pid) break;
      const p = this.getGroup(pid);
      if (!p) break;
      topGrp = p;
      cur = p;
    }
    return topGrp;
  }

  isEffectivelyEnabled(id) {
    const topGrp = this.getTopLevelGroup(id);
    if (topGrp) return !!topGrp.enabled;
    const node = this.getNode(id);
    return !!(node && node.enabled);
  }

  isEffectivelyVisible(id) {
    let cur = this.getNode(id);
    let guard = 0;
    while (cur && guard++ < 16) {
      if (!cur.visible) return false;
      const pid = this.getParentGroupId(cur);
      if (!pid) break;
      cur = this.getGroup(pid);
    }
    return true;
  }

  setEffectiveEnabled(id, enabledVal) {
    const topGrp = this.getTopLevelGroup(id);
    if (topGrp) {
      topGrp.enabled = !!enabledVal;
    } else {
      const node = this.getNode(id);
      if (node) node.enabled = !!enabledVal;
    }
  }

  isDescendant(ancestorGroupId, candidateId) {
    if (!ancestorGroupId || !candidateId) return false;
    if (ancestorGroupId === candidateId) return true;
    const grp = this.getGroup(ancestorGroupId);
    if (!grp) return false;
    return grp.collectAllDescendantIds().has(candidateId);
  }

  createVolume(kind, center = new T.Vector3(0, 0, 0), radius = 1.0, name = null, forcedId = null) {
    const item = new VolumeItem(kind, name, forcedId);
    item.root.position.copy(center);
    if (kind === "plane") {
      const s = Math.max(0.5, radius * 1.1);
      item.root.scale.set(s, s, s);
      // PlaneGeometry lies in local XY (vertical in +Y-up!)
      item.root.rotation.set(0, 0, 0);
    } else {
      const r = Math.max(0.15, radius);
      item.root.scale.set(r, r, r);
    }
    item.captureInitialTransform();
    this.container.add(item.root);
    this.handleContainer.add(item.handleGroup);
    this.items.push(item);
    this.topLevelOrder.push(item.id);
    return item;
  }

  _pruneEmptyGroups() {
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (let i = this.groups.length - 1; i >= 0; i--) {
        const g = this.groups[i];
        if (g.children.length === 0) {
          if (g.parentGroupId) {
            const p = this.getGroup(g.parentGroupId);
            if (p) p.removeChild(g);
          }
          if (g.root.parent) g.root.parent.remove(g.root);
          this.groups.splice(i, 1);
          this._disposeCsgPreview(g.id);
          pruned = true;
        }
      }
    }
    this._ensureTopLevelOrder();
  }

  removeVolume(id) {
    const idx = this.items.findIndex((v) => v.id === id);
    if (idx < 0) return false;
    const item = this.items[idx];
    if (item.groupId) {
      const g = this.getGroup(item.groupId);
      if (g) g.removeChild(item);
    }
    if (item.root.parent) item.root.parent.remove(item.root);
    if (item.handleGroup.parent) item.handleGroup.parent.remove(item.handleGroup);
    this.items.splice(idx, 1);
    this._pruneEmptyGroups();
    return true;
  }

  removeGroup(groupId) {
    const grp = this.getGroup(groupId);
    if (!grp) return false;
    // Recursively remove all nested children first
    const copy = [...grp.children];
    for (const c of copy) {
      if (c.isVolumeGroup) this.removeGroup(c.id);
      else this.removeVolume(c.id);
    }
    if (grp.parentGroupId) {
      const p = this.getGroup(grp.parentGroupId);
      if (p) p.removeChild(grp);
    }
    const gi = this.groups.indexOf(grp);
    if (gi >= 0) this.groups.splice(gi, 1);
    if (grp.root.parent) grp.root.parent.remove(grp.root);
    this._disposeCsgPreview(grp.id);
    this._pruneEmptyGroups();
    return true;
  }

  /**
   * Group >=2 selected volumes and/or volume groups into a new parent VolumeGroup!
   * Supports recursive nesting (#6): any existing VolumeGroup nested inside defaults to collapsed=true!
   */
  createGroupFromItems(nodeIds, name = null, forcedId = null) {
    const rawNodes = nodeIds
      .map((id) => this.getNode(id))
      .filter((n) => n && (n.isVolumeGroup || n.kind !== "plane"));
    if (rawNodes.length < 2) return null;

    // Filter out nodes whose ancestor is already in the selection
    const idSet = new Set(rawNodes.map((n) => n.id));
    const members = rawNodes.filter((n) => {
      let pid = this.getParentGroupId(n);
      while (pid) {
        if (idSet.has(pid)) return false;
        const p = this.getGroup(pid);
        pid = p ? p.parentGroupId : null;
      }
      return true;
    });
    if (members.length < 2) return null;

    // Check if all members share the same existing parent group (nest inside it) or go to top-level
    const sharedParentId = this.getParentGroupId(members[0]);
    const allSameParent = sharedParentId && members.every((m) => this.getParentGroupId(m) === sharedParentId);
    const parentGrp = allSameParent ? this.getGroup(sharedParentId) : null;

    this.container.updateMatrixWorld(true);
    const center = new T.Vector3();
    const wp = new T.Vector3();
    for (const m of members) {
      m.root.getWorldPosition(wp);
      center.add(wp);
    }
    center.divideScalar(members.length);

    // Detach members from previous parents cleanly
    for (const m of members) {
      const oldPid = this.getParentGroupId(m);
      if (oldPid) {
        const oldG = this.getGroup(oldPid);
        if (oldG) {
          oldG.removeChild(m);
          this.container.attach(m.root);
        }
      }
    }

    const grp = new VolumeGroup(name, forcedId);
    grp.root.position.copy(center);
    if (parentGrp) {
      parentGrp.root.add(grp.root);
      this.container.updateMatrixWorld(true);
      // Convert world center to parent local
      parentGrp.root.worldToLocal(grp.root.position);
      grp.parentGroupId = parentGrp.id;
      grp.collapsed = true; // Nested groups default to collapsed (#6)!
      parentGrp.children.push(grp);
    } else {
      this.container.add(grp.root);
      this.topLevelOrder.unshift(grp.id);
    }
    grp.root.updateMatrixWorld(true);
    grp.captureInitialTransform();

    for (const m of members) {
      if (m.isVolumeGroup) m.collapsed = true; // Nested sub-groups default collapsed (#6)!
      grp.addChild(m, m.boolOp || "union");
    }
    this.groups.push(grp);
    this._pruneEmptyGroups();
    return grp;
  }

  ungroup(groupId) {
    const idx = this.groups.findIndex((g) => g.id === groupId);
    if (idx < 0) return false;
    const grp = this.groups[idx];
    const parentGrp = grp.parentGroupId ? this.getGroup(grp.parentGroupId) : null;
    const insertIdx = parentGrp ? parentGrp.children.indexOf(grp) : this.topLevelOrder.indexOf(grp.id);
    const childrenCopy = [...grp.children];

    this.container.updateMatrixWorld(true);
    if (parentGrp) parentGrp.removeChild(grp);
    for (let k = 0; k < childrenCopy.length; k++) {
      const c = childrenCopy[k];
      if (parentGrp) {
        parentGrp.addChild(c, c.boolOp || "union", insertIdx >= 0 ? insertIdx + k : -1);
      } else {
        this.container.attach(c.root);
        if (c.isVolumeGroup) c.parentGroupId = null;
        else c.groupId = null;
        if (insertIdx >= 0) this.topLevelOrder.splice(insertIdx + k, 0, c.id);
        else this.topLevelOrder.push(c.id);
      }
    }
    grp.children.length = 0;
    if (grp.root.parent) grp.root.parent.remove(grp.root);
    this.groups.splice(idx, 1);
    this._disposeCsgPreview(grp.id);
    this._ensureTopLevelOrder();
    return true;
  }

  /**
   * Drag-and-drop move any VolumeItem or VolumeGroup to a new parent group (or top-level null) and index (#5/#6).
   * Preserves exact world-space transforms and prevents illegal self/ancestor cycles!
   */
  moveNode(nodeId, targetParentGroupId = null, targetIndex = -1) {
    const node = this.getNode(nodeId);
    if (!node) return false;
    // Planes cannot be dragged inside a volume CSG group
    if (!node.isVolumeGroup && node.kind === "plane" && targetParentGroupId) return false;
    if (targetParentGroupId) {
      if (node.id === targetParentGroupId) return false;
      if (node.isVolumeGroup && this.isDescendant(node.id, targetParentGroupId)) return false;
      if (!this.getGroup(targetParentGroupId)) return false;
    }

    this.container.updateMatrixWorld(true);
    const oldParentId = this.getParentGroupId(node);
    let adjustedIndex = targetIndex;

    // Remove from old container
    if (oldParentId) {
      const oldG = this.getGroup(oldParentId);
      if (oldG) {
        const oldIdx = oldG.children.indexOf(node);
        if (oldParentId === targetParentGroupId && adjustedIndex > oldIdx) adjustedIndex--;
        oldG.removeChild(node);
      }
      this.container.attach(node.root);
    } else {
      const oldTopIdx = this.topLevelOrder.indexOf(node.id);
      if (!targetParentGroupId && adjustedIndex > oldTopIdx && oldTopIdx >= 0) adjustedIndex--;
      if (oldTopIdx >= 0) this.topLevelOrder.splice(oldTopIdx, 1);
    }

    // Insert into new container
    if (targetParentGroupId) {
      const targetG = this.getGroup(targetParentGroupId);
      if (node.isVolumeGroup && oldParentId !== targetParentGroupId) {
        node.collapsed = true; // Newly nested sub-group defaults collapsed (#6)
      }
      targetG.addChild(node, node.boolOp || "union", adjustedIndex);
    } else {
      this.container.attach(node.root);
      if (node.isVolumeGroup) node.parentGroupId = null;
      else node.groupId = null;
      if (adjustedIndex >= 0 && adjustedIndex <= this.topLevelOrder.length) {
        this.topLevelOrder.splice(adjustedIndex, 0, node.id);
      } else {
        this.topLevelOrder.push(node.id);
      }
    }

    this._pruneEmptyGroups();
    this.container.updateMatrixWorld(true);
    return true;
  }

  /**
   * Deep-clone any VolumeItem or recursive VolumeGroup (preserving exact world transform!)
   * and insert it at (targetParentGroupId, targetIndex) for Ctrl+Drag Duplicate & Move (rc11 #3.4).
   */
  duplicateNode(nodeId, targetParentGroupId = null, targetIndex = -1) {
    const src = this.getNode(nodeId);
    if (!src) return null;
    if (!src.isVolumeGroup && src.kind === "plane" && targetParentGroupId) return null;
    if (targetParentGroupId && !this.getGroup(targetParentGroupId)) return null;

    this.container.updateMatrixWorld(true);
    const copySuffix = t("editor.scene.copySuffix");

    const cloneRecursive = (node, parentGrp, insertIdx) => {
      node.root.updateMatrixWorld(true);
      const wp = new T.Vector3();
      const wq = new T.Quaternion();
      const ws = new T.Vector3();
      node.root.matrixWorld.decompose(wp, wq, ws);

      if (!node.isVolumeGroup) {
        const copy = new VolumeItem(node.kind, `${node.name}${copySuffix}`);
        copy.enabled = node.enabled;
        copy.visible = node.visible;
        copy.boolOp = node.boolOp || "union";
        copy.root.visible = copy.visible;
        copy.root.position.copy(wp);
        copy.root.quaternion.copy(wq);
        copy.root.scale.copy(ws);
        copy.captureInitialTransform();
        this.container.add(copy.root);
        this.handleContainer.add(copy.handleGroup);
        this.items.push(copy);
        if (parentGrp) {
          parentGrp.addChild(copy, copy.boolOp, insertIdx);
        } else if (insertIdx >= 0 && insertIdx <= this.topLevelOrder.length) {
          this.topLevelOrder.splice(insertIdx, 0, copy.id);
        } else {
          this.topLevelOrder.push(copy.id);
        }
        return copy;
      }

      const grpCopy = new VolumeGroup(`${node.name}${copySuffix}`);
      grpCopy.enabled = node.enabled;
      grpCopy.visible = node.visible;
      grpCopy.collapsed = parentGrp ? true : !!node.collapsed;
      grpCopy.boolOp = node.boolOp || "union";
      grpCopy.root.visible = grpCopy.visible;
      grpCopy.root.position.copy(wp);
      grpCopy.root.quaternion.copy(wq);
      grpCopy.root.scale.copy(ws);
      grpCopy.captureInitialTransform();
      this.container.add(grpCopy.root);
      this.groups.push(grpCopy);

      if (parentGrp) {
        parentGrp.addChild(grpCopy, grpCopy.boolOp, insertIdx);
      } else if (insertIdx >= 0 && insertIdx <= this.topLevelOrder.length) {
        this.topLevelOrder.splice(insertIdx, 0, grpCopy.id);
      } else {
        this.topLevelOrder.push(grpCopy.id);
      }
      grpCopy.root.updateMatrixWorld(true);

      for (const ch of node.children) {
        cloneRecursive(ch, grpCopy, -1);
      }
      return grpCopy;
    };

    const parentGrp = targetParentGroupId ? this.getGroup(targetParentGroupId) : null;
    const cloned = cloneRecursive(src, parentGrp, targetIndex);
    this._ensureTopLevelOrder();
    this.container.updateMatrixWorld(true);
    return cloned;
  }

  /**
   * Wrap an existing single non-outermost VolumeGroup inside a new outer VolumeGroup (rc11 #3.3).
   */
  wrapGroupInNewParent(groupId, name = null) {
    const grp = this.getGroup(groupId);
    if (!grp) return null;
    // Reject if already an outermost nested group
    if (!grp.parentGroupId && grp.children.some((c) => c.isVolumeGroup)) return null;

    this.container.updateMatrixWorld(true);
    const oldParent = grp.parentGroupId ? this.getGroup(grp.parentGroupId) : null;
    const oldIdx = oldParent ? oldParent.children.indexOf(grp) : this.topLevelOrder.indexOf(grp.id);

    const wp = new T.Vector3();
    grp.root.getWorldPosition(wp);

    if (oldParent) {
      oldParent.removeChild(grp);
      this.container.attach(grp.root);
    } else if (oldIdx >= 0) {
      this.topLevelOrder.splice(oldIdx, 1);
    }

    const outer = new VolumeGroup(name);
    outer.root.position.copy(wp);
    outer.enabled = grp.enabled;
    outer.visible = grp.visible;
    if (oldParent) {
      oldParent.root.add(outer.root);
      this.container.updateMatrixWorld(true);
      oldParent.root.worldToLocal(outer.root.position);
      outer.parentGroupId = oldParent.id;
      outer.collapsed = true;
      if (oldIdx >= 0 && oldIdx <= oldParent.children.length) oldParent.children.splice(oldIdx, 0, outer);
      else oldParent.children.push(outer);
    } else {
      this.container.add(outer.root);
      if (oldIdx >= 0 && oldIdx <= this.topLevelOrder.length) this.topLevelOrder.splice(oldIdx, 0, outer.id);
      else this.topLevelOrder.unshift(outer.id);
    }
    outer.root.updateMatrixWorld(true);
    outer.captureInitialTransform();
    grp.collapsed = true;
    outer.addChild(grp, grp.boolOp || "union");
    this.groups.push(outer);
    this._ensureTopLevelOrder();
    this.container.updateMatrixWorld(true);
    return outer;
  }

  /**
   * Merge 2+ selected volumes / volume groups into a single flat unified Union VolumeGroup (rc11 #3.2).
   */
  mergeNodesIntoUnionGroup(nodeIds, name = null) {
    const leafList = [];
    const seenLeaf = new Set();
    for (const id of nodeIds) {
      const n = this.getNode(id);
      if (!n) continue;
      if (n.isVolumeGroup) {
        for (const lf of n.collectLeafItems()) {
          if (lf.kind !== "plane" && !seenLeaf.has(lf.id)) {
            seenLeaf.add(lf.id);
            leafList.push(lf);
          }
        }
      } else if (n.kind !== "plane" && !seenLeaf.has(n.id)) {
        seenLeaf.add(n.id);
        leafList.push(n);
      }
    }
    if (leafList.length < 2) return null;

    this.container.updateMatrixWorld(true);
    const center = new T.Vector3();
    const wp = new T.Vector3();
    for (const lf of leafList) {
      lf.root.getWorldPosition(wp);
      center.add(wp);
    }
    center.divideScalar(leafList.length);

    for (const lf of leafList) {
      if (lf.groupId) {
        const og = this.getGroup(lf.groupId);
        if (og) og.removeChild(lf);
      } else {
        const ti = this.topLevelOrder.indexOf(lf.id);
        if (ti >= 0) this.topLevelOrder.splice(ti, 1);
      }
      this.container.attach(lf.root);
    }

    const merged = new VolumeGroup(name);
    merged.enabled = true;
    merged.visible = true;
    merged.collapsed = true;
    merged.root.position.copy(center);
    this.container.add(merged.root);
    this.topLevelOrder.unshift(merged.id);
    merged.root.updateMatrixWorld(true);
    merged.captureInitialTransform();

    for (const lf of leafList) {
      lf.boolOp = "union";
      merged.addChild(lf, "union");
    }
    this.groups.push(merged);
    this._pruneEmptyGroups();
    this.container.updateMatrixWorld(true);
    return merged;
  }

  _buildHandleOccluders() {
    const occluders = [];
    for (const rec of this._csgMeshes.values()) {
      if (rec.preview.mesh.visible && rec.preview.lastProgram && rec.preview.lastProgram.primCount > 0) {
        occluders.push({ type: "csg", prog: rec.preview.lastProgram });
      }
    }
    for (const item of this.items) {
      if (item.kind === "plane" || !this.isEffectivelyVisible(item.id)) continue;
      if (item._inCsgGroup) continue; // Exact CSG shell already handles occlusion for this group!
      if (Math.abs(item.root.matrixWorld.determinant()) < 1e-12) continue;
      const kindCode = item.kind === "ellipsoid" ? 1 : item.kind === "cylinder" ? 2 : 0;
      occluders.push({
        type: "prim",
        kindCode,
        invMat: item.root.matrixWorld.clone().invert(),
      });
    }
    return occluders;
  }

  _isHandleOccluded(handlePos, ownerItem, camera, occluders) {
    if (!camera || occluders.length === 0) return false;
    let dist;
    if (camera.isOrthographicCamera) {
      camera.getWorldDirection(_TMP_RD).normalize();
      dist = 500;
      _TMP_RO.copy(handlePos).addScaledVector(_TMP_RD, -dist);
    } else {
      _TMP_RO.copy(camera.position);
      _TMP_RD.subVectors(handlePos, _TMP_RO);
      dist = _TMP_RD.length();
      if (dist < 1e-4) return false;
      _TMP_RD.divideScalar(dist);
    }

    ownerItem.root.matrixWorld.decompose(_TMP_POS, _TMP_QUAT, _TMP_SCALE);
    const minHalf = Math.max(0.01, Math.min(Math.abs(_TMP_SCALE.x), Math.abs(_TMP_SCALE.y), Math.abs(_TMP_SCALE.z)));
    const epsHandle = Math.min(Math.max(0.01, dist * 0.012), minHalf * 0.35);
    const tMax = dist - epsHandle;
    const tMin = 1e-4;
    if (tMax <= tMin) return false;

    for (let oi = 0; oi < occluders.length; oi++) {
      const occ = occluders[oi];
      if (occ.type === "prim") {
        const m = occ.invMat.elements;
        _TMP_LO.set(
          m[0] * _TMP_RO.x + m[4] * _TMP_RO.y + m[8] * _TMP_RO.z + m[12],
          m[1] * _TMP_RO.x + m[5] * _TMP_RO.y + m[9] * _TMP_RO.z + m[13],
          m[2] * _TMP_RO.x + m[6] * _TMP_RO.y + m[10] * _TMP_RO.z + m[14],
        );
        _TMP_LD.set(
          m[0] * _TMP_RD.x + m[4] * _TMP_RD.y + m[8] * _TMP_RD.z,
          m[1] * _TMP_RD.x + m[5] * _TMP_RD.y + m[9] * _TMP_RD.z,
          m[2] * _TMP_RD.x + m[6] * _TMP_RD.y + m[10] * _TMP_RD.z,
        );
        const hit = rayIntersectLocalUnitPrimitive(occ.kindCode, _TMP_LO, _TMP_LD);
        if (!hit) continue;
        const a = Math.max(tMin, hit[0]);
        const b = Math.min(tMax, hit[1]);
        if (b - a > Math.max(1e-4, epsHandle * 0.3)) return true;
      } else {
        const prog = occ.prog;
        const aabbHit = rayIntersectAabb(_TMP_RO, _TMP_RD, prog.aabbMin, prog.aabbMax);
        if (!aabbHit) continue;
        const segA = Math.max(tMin, aabbHit[0]);
        const segB = Math.min(tMax, aabbHit[1]);
        if (segB - segA <= 1e-4) continue;

        // Exact CSG interval partitioning along ray [segA, segB] -> handles subtract cavities with 0 false positives!
        const ts = [segA, segB];
        for (let p = 0; p < prog.primCount; p++) {
          const m = prog.invMatrices[p].elements;
          _TMP_LO.set(
            m[0] * _TMP_RO.x + m[4] * _TMP_RO.y + m[8] * _TMP_RO.z + m[12],
            m[1] * _TMP_RO.x + m[5] * _TMP_RO.y + m[9] * _TMP_RO.z + m[13],
            m[2] * _TMP_RO.x + m[6] * _TMP_RO.y + m[10] * _TMP_RO.z + m[14],
          );
          _TMP_LD.set(
            m[0] * _TMP_RD.x + m[4] * _TMP_RD.y + m[8] * _TMP_RD.z,
            m[1] * _TMP_RD.x + m[5] * _TMP_RD.y + m[9] * _TMP_RD.z,
            m[2] * _TMP_RD.x + m[6] * _TMP_RD.y + m[10] * _TMP_RD.z,
          );
          const hit = rayIntersectLocalUnitPrimitive(prog.primKinds[p], _TMP_LO, _TMP_LD);
          if (!hit) continue;
          if (hit[0] > segA && hit[0] < segB) ts.push(hit[0]);
          if (hit[1] > segA && hit[1] < segB) ts.push(hit[1]);
        }
        ts.sort((u, v) => u - v);
        for (let k = 0; k < ts.length - 1; k++) {
          if (ts[k + 1] - ts[k] <= Math.max(1e-4, epsHandle * 0.25)) continue;
          const tm = 0.5 * (ts[k] + ts[k + 1]);
          _TMP_PT.copy(_TMP_RO).addScaledVector(_TMP_RD, tm);
          if (evaluateCsgProgramCpu(prog, _TMP_PT.x, _TMP_PT.y, _TMP_PT.z)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  updateAllHandleScales(camera) {
    if (camera) this._lastCamera = camera;
    const cam = camera || this._lastCamera;
    let anyVisibleHandles = false;
    for (const item of this.items) {
      const show = item._selected && this.isEffectivelyVisible(item.id);
      item.handleGroup.visible = show;
      if (show) {
        item.updateHandleScales(cam);
        if (item.handles.length > 0) anyVisibleHandles = true;
      }
    }
    if (anyVisibleHandles && cam) {
      this.container.updateMatrixWorld(true);
      const occluders = this._buildHandleOccluders();
      for (const item of this.items) {
        if (!item.handleGroup.visible || item.handles.length === 0) continue;
        for (const h of item.handles) {
          const occ = this._isHandleOccluded(h.position, item, cam, occluders);
          item.setHandleOccluded(h, occ);
        }
      }
    }
  }

  getHandleOcclusionReport() {
    const report = [];
    for (const item of this.items) {
      if (!item.handleGroup.visible) continue;
      for (const h of item.handles) {
        report.push({
          volumeId: item.id,
          key: h.userData.handleKey,
          occluded: !!h.userData.occluded,
          opacity: Number(h.material.opacity.toFixed(3)),
          borderOpacity: h.userData.borderMesh ? Number(h.userData.borderMesh.material.opacity.toFixed(3)) : 1,
        });
      }
    }
    return report;
  }

  updateCsgUniforms(camera) {
    if (!camera) return;
    this._lastCamera = camera;
    for (const rec of this._csgMeshes.values()) {
      rec.preview.updateCamera(camera);
    }
  }

  getVisibleHandleMeshes() {
    const res = [];
    for (const item of this.items) {
      if (!this.isEffectivelyVisible(item.id) || !item._selected) continue;
      for (const h of item.handles) {
        if (h.visible) res.push(h);
      }
    }
    return res;
  }

  getVisibleFillMeshes() {
    const res = [];
    for (const item of this.items) {
      if (this.isEffectivelyVisible(item.id) && item.fillMesh) res.push(item.fillMesh);
    }
    return res;
  }

  /**
   * Synchronize all wireframe/fill visual states & rebuild exact CSG translucent preview shells (#7/#9/#10).
   */
  syncAllVisuals(selectedIds = null, activeId = null) {
    this.container.updateMatrixWorld(true);
    const selSet = selectedIds instanceof Set ? selectedIds : new Set();

    // Update each leaf VolumeItem appearance
    for (const item of this.items) {
      const topGrp = this.getTopLevelGroup(item.id);
      const effEnabled = topGrp ? !!topGrp.enabled : !!item.enabled;
      let isSel = selSet.has(item.id) || activeId === item.id;
      if (!isSel && activeId) {
        const actGrp = this.getGroup(activeId);
        if (actGrp && actGrp.collectAllDescendantIds().has(item.id)) isSel = true;
      }
      // Walk ancestor chain inside topGrp to determine effective subtract / intersect wireframe tint
      let isSub = false;
      let isInt = false;
      let walk = item;
      let guard = 0;
      while (walk && guard++ < 16) {
        const pid = this.getParentGroupId(walk);
        if (!pid) break;
        const pg = this.getGroup(pid);
        if (!pg) break;
        if (pg.children[0] !== walk) {
          if (walk.boolOp === "subtract") { isSub = true; break; }
          if (walk.boolOp === "intersect") isInt = true;
        }
        walk = pg;
      }
      item.applyAppearance({
        selected: isSel,
        effectivelyEnabled: effEnabled,
        inCsgGroup: !!(topGrp && effEnabled),
        isSubtract: isSub,
        isIntersect: !isSub && isInt,
      });
      const showHandles = isSel && this.isEffectivelyVisible(item.id);
      item.handleGroup.visible = showHandles;
      if (showHandles && this._lastCamera) {
        item.updateHandleScales(this._lastCamera);
      }
    }

    // Refresh exact analytical GPU ray-cast CSG preview shells for every enabled & visible top-level VolumeGroup (#10)
    const activeTopIds = new Set();
    for (const grp of this.groups) {
      if (grp.parentGroupId) continue;
      const shouldShow = grp.enabled && grp.visible && grp.countLeafItems() > 0;
      if (!shouldShow) {
        this._disposeCsgPreview(grp.id);
        continue;
      }
      activeTopIds.add(grp.id);
      const sig = this._computeGroupCsgSignature(grp);
      let rec = this._csgMeshes.get(grp.id);
      if (rec && rec.sig === sig) {
        if (this._lastCamera) rec.preview.updateCamera(this._lastCamera);
        continue;
      }

      if (!rec) {
        const preview = new CsgVolumePreview();
        this.csgPreviewContainer.add(preview.mesh);
        rec = { preview, sig: "" };
        this._csgMeshes.set(grp.id, rec);
      }
      const prog = compileGroupCsgProgram(grp);
      rec.preview.updateProgram(prog);
      if (this._lastCamera) rec.preview.updateCamera(this._lastCamera);
      rec.sig = sig;
    }
    // Dispose any orphaned preview meshes
    for (const id of Array.from(this._csgMeshes.keys())) {
      if (!activeTopIds.has(id)) this._disposeCsgPreview(id);
    }
    if (this._lastCamera) {
      this.updateAllHandleScales(this._lastCamera);
    }
  }

  _disposeCsgPreview(groupId) {
    const rec = this._csgMeshes.get(groupId);
    if (!rec) return;
    rec.preview.dispose();
    this._csgMeshes.delete(groupId);
  }

  _computeGroupCsgSignature(node) {
    if (!node.isVolumeGroup) {
      const e = node.root.matrixWorld.elements;
      return `I:${node.id}:${node.kind}:${node.boolOp}:${e[0].toFixed(4)},${e[1].toFixed(4)},${e[2].toFixed(4)},${e[4].toFixed(4)},${e[5].toFixed(4)},${e[6].toFixed(4)},${e[8].toFixed(4)},${e[9].toFixed(4)},${e[10].toFixed(4)},${e[12].toFixed(4)},${e[13].toFixed(4)},${e[14].toFixed(4)}`;
    }
    return `G:${node.id}:${node.boolOp}:[${node.children.map((c) => this._computeGroupCsgSignature(c)).join("|")}]`;
  }

  /**
   * Recursively compile any VolumeItem or (nested) VolumeGroup into an exact analytical world-point predicate.
   */
  _compileNodePredicate(node, cameraPos, invScratch) {
    if (!node) return null;
    if (!node.isVolumeGroup) {
      invScratch.copy(node.root.matrixWorld).invert();
      const m = invScratch.elements.slice();
      return (x, y, z) => node.containsWorldPoint(x, y, z, m, cameraPos);
    }
    const steps = [];
    for (const c of node.children) {
      const fn = this._compileNodePredicate(c, cameraPos, invScratch);
      if (fn) steps.push({ fn, op: c.boolOp || "union" });
    }
    if (steps.length === 0) return null;
    return (x, y, z) => {
      let inside = steps[0].fn(x, y, z);
      for (let k = 1; k < steps.length; k++) {
        const st = steps[k];
        const hit = st.fn(x, y, z);
        if (st.op === "union") inside = inside || hit;
        else if (st.op === "subtract") inside = inside && !hit;
        else if (st.op === "intersect") inside = inside && hit;
      }
      return inside;
    };
  }

  compileSingleOrGroup(id, cameraPos) {
    this.container.updateMatrixWorld(true);
    const node = this.getNode(id);
    if (!node) return null;
    return this._compileNodePredicate(node, cameraPos, new T.Matrix4());
  }

  /**
   * Compile the GLOBAL active spatial scope enforced on ALL selection tools:
   * Evaluates all enabled top-level VolumeGroups (recursively) + loose enabled Volumes + loose enabled Planes.
   */
  compileActiveScope(cameraPos) {
    this.container.updateMatrixWorld(true);
    const inv = new T.Matrix4();
    const volumePreds = [];
    const planePreds = [];

    for (const grp of this.groups) {
      if (grp.parentGroupId || !grp.enabled) continue;
      const p = this._compileNodePredicate(grp, cameraPos, inv);
      if (p) volumePreds.push(p);
    }

    for (const item of this.items) {
      if (!item.enabled || item.groupId) continue;
      inv.copy(item.root.matrixWorld).invert();
      const m = inv.elements.slice();
      if (item.kind === "plane") {
        planePreds.push((x, y, z) => item.containsWorldPoint(x, y, z, m, cameraPos));
      } else {
        volumePreds.push((x, y, z) => item.containsWorldPoint(x, y, z, m, cameraPos));
      }
    }

    if (volumePreds.length === 0 && planePreds.length === 0) return null;

    return (x, y, z) => {
      if (planePreds.length > 0) {
        for (let i = 0; i < planePreds.length; i++) {
          if (!planePreds[i](x, y, z)) return false;
        }
      }
      if (volumePreds.length > 0) {
        let inAnyVol = false;
        for (let i = 0; i < volumePreds.length; i++) {
          if (volumePreds[i](x, y, z)) {
            inAnyVol = true;
            break;
          }
        }
        if (!inAnyVol) return false;
      }
      return true;
    };
  }

  /**
   * rc12 #4.3: Compile ALL currently enabled bounding volumes, CSG volume groups, and occlusion planes
   * into one compact GPU RPN program (up to 24 prims, 48 ops) so SplatCloud highlights enclosed
   * selectable Gaussians in real-time at 120 FPS whenever models OR volumes move!
   * Semantics are 100% identical to compileActiveScope(cameraPos):
   *   (any enabled 3D volume / top-level CSG group) AND (all enabled loose occlusion planes).
   */
  compileActiveScopeGpuProgram(cameraPos) {
    this.container.updateMatrixWorld(true);
    const MAX_P = 24;
    const MAX_O = 48;
    const OP_PUSH = 0;
    const OP_UNION = 1;
    const OP_SUBTRACT = 2;
    const OP_INTERSECT = 3;

    const primKinds = new Int32Array(MAX_P);
    const planeSigns = new Float32Array(MAX_P);
    const invMatrices = [];
    for (let i = 0; i < MAX_P; i++) invMatrices.push(new T.Matrix4());
    const ops = new Int32Array(MAX_O);

    let primCount = 0;
    let opCount = 0;
    const invScratch = new T.Matrix4();

    const kindCode = (k) => (k === "ellipsoid" ? 1 : k === "cylinder" ? 2 : k === "plane" ? 3 : 0);

    const emitNode = (node) => {
      if (!node) return false;
      if (!node.isVolumeGroup) {
        if (node.kind === "plane") return false;
        if (primCount >= MAX_P || opCount >= MAX_O) return false;
        const mw = node.root.matrixWorld;
        if (Math.abs(mw.determinant()) < 1e-12) return false;
        const idx = primCount++;
        primKinds[idx] = kindCode(node.kind);
        planeSigns[idx] = 1.0;
        invScratch.copy(mw).invert();
        invMatrices[idx].copy(invScratch);
        ops[opCount++] = (idx << 2) | OP_PUSH;
        return true;
      }
      let emitted = false;
      for (let i = 0; i < node.children.length; i++) {
        const ch = node.children[i];
        if (!emitNode(ch)) continue;
        if (!emitted) {
          emitted = true;
        } else if (opCount < MAX_O) {
          ops[opCount++] =
            ch.boolOp === "subtract" ? OP_SUBTRACT : ch.boolOp === "intersect" ? OP_INTERSECT : OP_UNION;
        }
      }
      return emitted;
    };

    // 1. Emit union across all enabled top-level VolumeGroups + loose enabled 3D volumes
    let has3DVol = false;
    for (const grp of this.groups) {
      if (grp.parentGroupId || !grp.enabled) continue;
      if (emitNode(grp)) {
        if (has3DVol && opCount < MAX_O) ops[opCount++] = OP_UNION;
        has3DVol = true;
      }
    }
    for (const item of this.items) {
      if (!item.enabled || item.groupId || item.kind === "plane") continue;
      if (emitNode(item)) {
        if (has3DVol && opCount < MAX_O) ops[opCount++] = OP_UNION;
        has3DVol = true;
      }
    }

    // 2. Intersect with all enabled loose occlusion planes (camera-facing side)
    let hasPlane = false;
    for (const item of this.items) {
      if (!item.enabled || item.groupId || item.kind !== "plane") continue;
      if (primCount >= MAX_P || opCount >= MAX_O) break;
      const mw = item.root.matrixWorld;
      if (Math.abs(mw.determinant()) < 1e-12) continue;
      invScratch.copy(mw).invert();
      const m = invScratch.elements;
      let sign = 1.0;
      if (cameraPos) {
        const cz = m[2] * cameraPos.x + m[6] * cameraPos.y + m[10] * cameraPos.z + m[14];
        sign = cz >= 0 ? 1.0 : -1.0;
      }
      const idx = primCount++;
      primKinds[idx] = 3; // KIND_PLANE
      planeSigns[idx] = sign;
      invMatrices[idx].copy(invScratch);
      ops[opCount++] = (idx << 2) | OP_PUSH;
      if ((has3DVol || hasPlane) && opCount < MAX_O) {
        ops[opCount++] = OP_INTERSECT;
      }
      hasPlane = true;
    }

    return {
      active: primCount > 0 && opCount > 0,
      primCount,
      opCount,
      primKinds,
      planeSigns,
      invMatrices,
      ops,
    };
  }

  setHelpersVisible(vis) {
    this.container.visible = !!vis;
  }

  exportSnapshot() {
    this._ensureTopLevelOrder();
    return {
      primitiveCoordSystem: "y-up",
      topLevelOrder: this.topLevelOrder.slice(),
      groups: this.groups.map((g) => g.toJSON()),
      items: this.items.map((v) => v.toJSON()),
    };
  }

  restoreSnapshot(rawSnap, opts = {}) {
    // Clear existing
    for (const id of Array.from(this._csgMeshes.keys())) this._disposeCsgPreview(id);
    while (this.items.length > 0) {
      const it = this.items.pop();
      if (it.root.parent) it.root.parent.remove(it.root);
      if (it.handleGroup.parent) it.handleGroup.parent.remove(it.handleGroup);
    }
    while (this.groups.length > 0) {
      const g = this.groups.pop();
      if (g.root.parent) g.root.parent.remove(g.root);
    }
    this.topLevelOrder = [];
    if (!rawSnap) return { migratedCylinders: 0 };

    // Idempotently migrate legacy z-up cylinders (from <=rc10 / 3.2.1 recipes) into +Y-up pure TRS once!
    const mig = migrateRecipeVolumesToYUp(
      rawSnap,
      opts.recipeCoordSystem ?? null,
      opts.recipeVersion ?? 3,
    );
    const snap = mig.volumes;

    const grpMap = new Map();
    for (const gd of snap.groups || []) {
      const grp = new VolumeGroup(gd.name, gd.id);
      grp.enabled = gd.enabled !== false;
      grp.visible = gd.visible !== false;
      grp.collapsed = !!gd.collapsed;
      grp.parentGroupId = gd.parentGroupId || null;
      grp.boolOp = gd.boolOp || "union";
      grp.root.visible = grp.visible;
      grp.root.position.fromArray(gd.position || [0, 0, 0]);
      if (gd.rotation) grp.root.rotation.set(gd.rotation[0], gd.rotation[1], gd.rotation[2]);
      grp.root.scale.fromArray(gd.scale || [1, 1, 1]);
      grp.initialPosition = (gd.initialPosition || gd.position || [0, 0, 0]).slice();
      grp.initialRotation = (gd.initialRotation || gd.rotation || [0, 0, 0]).slice();
      grp.initialScale = (gd.initialScale || gd.scale || [1, 1, 1]).slice();
      this.groups.push(grp);
      grpMap.set(grp.id, grp);
    }

    // Attach group roots to their parentGroup (or top-level container)
    for (const grp of this.groups) {
      if (grp.parentGroupId && grpMap.has(grp.parentGroupId)) {
        grpMap.get(grp.parentGroupId).root.add(grp.root);
      } else {
        grp.parentGroupId = null;
        this.container.add(grp.root);
      }
    }

    const itemMap = new Map();
    for (const vd of snap.items || []) {
      const item = new VolumeItem(vd.kind, vd.name, vd.id);
      item.enabled = vd.enabled !== false;
      item.visible = vd.visible !== false;
      item.boolOp = vd.boolOp || "union";
      item.root.visible = item.visible;
      item.root.position.fromArray(vd.position || [0, 0, 0]);
      if (vd.rotation) item.root.rotation.set(vd.rotation[0], vd.rotation[1], vd.rotation[2]);
      item.root.scale.fromArray(vd.scale || [1, 1, 1]);
      item.initialPosition = (vd.initialPosition || vd.position || [0, 0, 0]).slice();
      item.initialRotation = (vd.initialRotation || vd.rotation || [0, 0, 0]).slice();
      item.initialScale = (vd.initialScale || vd.scale || [1, 1, 1]).slice();
      item.groupId = vd.groupId || null;
      if (item.groupId && grpMap.has(item.groupId)) {
        grpMap.get(item.groupId).root.add(item.root);
      } else {
        item.groupId = null;
        this.container.add(item.root);
      }
      this.handleContainer.add(item.handleGroup);
      this.items.push(item);
      itemMap.set(item.id, item);
    }

    // Restore exact top-to-bottom child order (items AND nested groups!) inside each group
    for (const gd of snap.groups || []) {
      const grp = grpMap.get(gd.id);
      if (!grp) continue;
      for (const cid of gd.childIds || []) {
        const c = itemMap.get(cid) || grpMap.get(cid);
        if (c) grp.children.push(c);
      }
    }
    this.topLevelOrder = Array.isArray(snap.topLevelOrder) ? snap.topLevelOrder.slice() : [];
    this._ensureTopLevelOrder();
    this.container.updateMatrixWorld(true);
    this.syncAllVisuals();
    return { migratedCylinders: mig.migratedCount };
  }
}
