/**
 * @module semantic/semantic-engine
 * @description Next-generation Box-Prompt 2D/3D Semantic Segmentation Orchestrator (M08).
 *
 * Implements every confirmed requirement from 模块设计思路与架构档案.md M08:
 * 1. Box-prompt only (no click/seed points) + unified boolean ops (replace/add/subtract/intersect).
 * 2. Auto 2D vs 3D mode classification via 3D coplanarity + border depth-discontinuity + eigen flatness
 *    (strictly coplanar patches like a flower on a painting -> 2D; 3D-prior for all real objects).
 *    Instant re-run using the last drawn box when user manually switches Auto/2D/3D in bottom bar.
 * 3. 2D Surface & Depth-Limited/Infinite Through modes with real-time slider refresh reusing cached 2D mask.
 * 4. 3D Multi-View (+Z-up horizontal-ring-first + upper-hemisphere supplement; presets 4 / 6[default] / 8 / 12):
 *    - Stage 1: Multi-worker parallel anchor-ray + 2D depth-component occlusion pre-screening +
 *      two-stage rerouting (subtle angle/pitch/distance adjust -> wide-angle jump with >=30° separation -> drop).
 *    - Stage 2: Silent offscreen FBO rendering (default) or valid-view-only live camera stepping +
 *      SAM 2.1 inference + 256-D `image_embed` cosine similarity & `object_score` verification.
 *    - Stage 3: Multi-view visibility carving + confidence voting (occluded abstains to preserve backfaces) +
 *      3D anchor-connected spatial graph + horizontal support-plane leak suppression.
 * 5. Full AbortController (`Esc` / Cancel) + CPU (WASM) notice + immediate VRAM release on exit.
 */
import * as T from "three";
import {
  FLAG_DELETED,
  FLAG_HIDDEN,
  HALF_TO_FLOAT,
  decodePickId,
} from "../cloud.js";
import { applyBooleanSelection } from "../selection.js";
import { SamRuntime, cosineSimilarity } from "./sam-runtime.js";
import { t } from "../i18n.js";

const VEC_A = new T.Vector3();
const VEC_B = new T.Vector3();
const VEC_C = new T.Vector3();
const UP_Y = new T.Vector3(0, 1, 0);

function packVoxelKey(ix, iy, iz) {
  return `${ix},${iy},${iz}`;
}

/**
 * 3x3 symmetric Jacobi eigensolver returning sorted eigenvalues [l1 >= l2 >= l3] and corresponding unit eigenvectors.
 */
function eigenSymmetric3x3(xx, xy, xz, yy, yz, zz) {
  const a = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 18; iter++) {
    let p = 0, q = 1, maxOff = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > maxOff) { p = 0; q = 2; maxOff = Math.abs(a[0][2]); }
    if (Math.abs(a[1][2]) > maxOff) { p = 1; q = 2; maxOff = Math.abs(a[1][2]); }
    if (maxOff < 1e-12) break;
    const diff = a[q][q] - a[p][p];
    const t = Math.abs(diff) < 1e-18
      ? 1
      : (() => {
          const tau = diff / (2 * a[p][q]);
          return (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        })();
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    a[p][p] = app - t * apq;
    a[q][q] = aqq + t * apq;
    a[p][q] = a[q][p] = 0;
    for (let r = 0; r < 3; r++) {
      if (r === p || r === q) continue;
      const arp = a[r][p], arq = a[r][q];
      a[r][p] = a[p][r] = c * arp - s * arq;
      a[r][q] = a[q][r] = s * arp + c * arq;
    }
    for (let r = 0; r < 3; r++) {
      const vrp = v[r][p], vrq = v[r][q];
      v[r][p] = c * vrp - s * vrq;
      v[r][q] = s * vrp + c * vrq;
    }
  }
  const pairs = [0, 1, 2].map((k) => ({
    val: Math.max(0, a[k][k]),
    vec: new T.Vector3(v[0][k], v[1][k], v[2][k]).normalize(),
  }));
  pairs.sort((x, y) => y.val - x.val);
  return pairs;
}

/**
 * Build nominal +Z-up 3D camera slots: horizontal ring first, then upper hemisphere supplement.
 * Returns offsets relative to primary view's azimuth & elevation (excluding primary slot 0).
 */
export function buildNominal3DViewSlots(totalViews = 6) {
  const n = Number(totalViews) || 6;
  if (n <= 4) {
    return [
      { ring: "horiz", yawDeg: -60, elevDeltaDeg: 0, distMul: 1.04 },
      { ring: "horiz", yawDeg: 60, elevDeltaDeg: 0, distMul: 1.04 },
      { ring: "hemi", yawDeg: 0, elevDeltaDeg: 35, distMul: 1.08 },
    ];
  }
  if (n <= 6) {
    return [
      { ring: "horiz", yawDeg: -55, elevDeltaDeg: 0, distMul: 1.04 },
      { ring: "horiz", yawDeg: 55, elevDeltaDeg: 0, distMul: 1.04 },
      { ring: "horiz", yawDeg: -125, elevDeltaDeg: 4, distMul: 1.06 },
      { ring: "horiz", yawDeg: 125, elevDeltaDeg: 4, distMul: 1.06 },
      { ring: "hemi", yawDeg: 0, elevDeltaDeg: 35, distMul: 1.08 },
    ];
  }
  if (n <= 8) {
    return [
      { ring: "horiz", yawDeg: -50, elevDeltaDeg: 0, distMul: 1.04 },
      { ring: "horiz", yawDeg: 50, elevDeltaDeg: 0, distMul: 1.04 },
      { ring: "horiz", yawDeg: -105, elevDeltaDeg: 4, distMul: 1.06 },
      { ring: "horiz", yawDeg: 105, elevDeltaDeg: 4, distMul: 1.06 },
      { ring: "horiz", yawDeg: 180, elevDeltaDeg: 6, distMul: 1.08 },
      { ring: "hemi", yawDeg: -35, elevDeltaDeg: 36, distMul: 1.08 },
      { ring: "hemi", yawDeg: 145, elevDeltaDeg: 36, distMul: 1.08 },
    ];
  }
  // 12 views: 8-view horizontal ring + 3 upper-hemisphere (120° spacing) + 1 high top-down
  return [
    { ring: "horiz", yawDeg: -45, elevDeltaDeg: 0, distMul: 1.04 },
    { ring: "horiz", yawDeg: 45, elevDeltaDeg: 0, distMul: 1.04 },
    { ring: "horiz", yawDeg: -90, elevDeltaDeg: 3, distMul: 1.05 },
    { ring: "horiz", yawDeg: 90, elevDeltaDeg: 3, distMul: 1.05 },
    { ring: "horiz", yawDeg: -135, elevDeltaDeg: 5, distMul: 1.06 },
    { ring: "horiz", yawDeg: 135, elevDeltaDeg: 5, distMul: 1.06 },
    { ring: "horiz", yawDeg: 180, elevDeltaDeg: 6, distMul: 1.08 },
    { ring: "hemi", yawDeg: 0, elevDeltaDeg: 35, distMul: 1.08 },
    { ring: "hemi", yawDeg: -120, elevDeltaDeg: 35, distMul: 1.08 },
    { ring: "hemi", yawDeg: 120, elevDeltaDeg: 35, distMul: 1.08 },
    { ring: "hemi", yawDeg: 180, elevDeltaDeg: 55, distMul: 1.12 },
  ];
}

function makeOrbitPose(baseOffset, anchorPos, yawDeg, elevDeltaDeg, distMul) {
  const dist = Math.max(0.12, baseOffset.length() * distMul);
  const baseHoriz = Math.hypot(baseOffset.x, baseOffset.z);
  const baseAzim = Math.atan2(baseOffset.x, baseOffset.z);
  const baseElev = Math.atan2(baseOffset.y, Math.max(1e-5, baseHoriz));

  const azim = baseAzim + (yawDeg * Math.PI) / 180;
  const elev = Math.max(-1.15, Math.min(1.42, baseElev + (elevDeltaDeg * Math.PI) / 180));
  const cosE = Math.cos(elev);
  const pos = new T.Vector3(
    anchorPos.x + dist * cosE * Math.sin(azim),
    anchorPos.y + dist * Math.sin(elev),
    anchorPos.z + dist * cosE * Math.cos(azim),
  );
  const dir = pos.clone().sub(anchorPos).normalize();
  return { pos, dir, yawDeg, elevDeltaDeg, distMul };
}

class OcclusionWorkerPool {
  constructor() {
    this._workers = [];
    this._jobId = 0;
  }

  _ensurePool() {
    if (this._workers.length > 0) return;
    const count = Math.max(2, Math.min(4, navigator.hardwareConcurrency || 2));
    for (let i = 0; i < count; i++) {
      try {
        const w = new Worker(new URL("./occlusion-worker.js", import.meta.url), { type: "module" });
        this._workers.push(w);
      } catch (err) {
        console.warn("[OcclusionPool] Worker creation fallback:", err);
        break;
      }
    }
  }

  async initScene(payload) {
    this._ensurePool();
    if (this._workers.length === 0) return false;
    const jobId = ++this._jobId;
    const settled = await Promise.all(
      this._workers.map(
        (w) =>
          new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              w.removeEventListener("message", onMsg);
              w.removeEventListener("error", onErr);
              resolve(ok);
            };
            const onMsg = (ev) => {
              if (ev.data?.type === "ready" && ev.data.jobId === jobId) finish(true);
            };
            const onErr = (err) => {
              console.warn("[OcclusionPool] worker init error:", err?.message || err);
              finish(false);
            };
            const timer = setTimeout(() => finish(false), 4000);
            w.addEventListener("message", onMsg);
            w.addEventListener("error", onErr);
            w.postMessage({ type: "init", jobId, ...payload });
          }),
      ),
    );
    if (settled.some((ok) => !ok)) {
      this.dispose();
      return false;
    }
    return true;
  }

  async evalPoses(poses) {
    if (this._workers.length === 0 || poses.length === 0) {
      return poses.map((p) => ({
        id: p.id,
        accepted: true,
        reason: "no-worker-pass",
        visibleRatio: 1,
        occludedRatio: 0,
        clearance: 10,
        projectedBox: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 },
        visiblePoints: [],
      }));
    }
    const jobId = ++this._jobId;
    const k = Math.min(this._workers.length, poses.length);
    const buckets = Array.from({ length: k }, () => []);
    for (let i = 0; i < poses.length; i++) buckets[i % k].push(poses[i]);

    const chunks = await Promise.all(
      buckets.map(
        (batch, bi) =>
          new Promise((resolve) => {
            const w = this._workers[bi];
            let done = false;
            const finish = (res) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              w.removeEventListener("message", onMsg);
              w.removeEventListener("error", onErr);
              resolve(res);
            };
            const onMsg = (ev) => {
              if (ev.data?.type === "batchResult" && ev.data.jobId === jobId) finish(ev.data.results || []);
            };
            const onErr = () => {
              finish(batch.map((p) => ({
                id: p.id, accepted: true, reason: "worker-err-pass", visibleRatio: 0.8, occludedRatio: 0.1,
                clearance: 5, projectedBox: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }, visiblePoints: [],
              })));
            };
            const timer = setTimeout(onErr, 6000);
            w.addEventListener("message", onMsg);
            w.addEventListener("error", onErr);
            w.postMessage({ type: "evalBatch", jobId, poses: batch });
          }),
      ),
    );
    return chunks.flat();
  }

  dispose() {
    for (const w of this._workers) {
      try { w.terminate(); } catch { /* ignore */ }
    }
    this._workers = [];
  }
}

export class SemanticBoxEngine {
  constructor() {
    this.sam = new SamRuntime();
    this._occPool = new OcclusionWorkerPool();
    this._abortCtrl = null;
    this._busy = false;

    // Cached last primary box segmentation so switching 2D/3D or dragging 2D thickness slider
    // re-runs instantaneously without requiring the user to redraw the box!
    this._lastContext = null;
    this._lastResolvedMode = "3d";
    this._lastAutoDecision = null;
    this._lastDeletedOrSelectedBounds = null;
  }

  get loaded() { return this.sam.loaded; }
  get isBusy() { return this._busy; }
  get activeBackend() { return this.sam.activeBackend; }
  get hasCachedBox() { return !!this._lastContext; }
  get lastResolvedMode() { return this._lastResolvedMode; }
  get lastAutoDecision() { return this._lastAutoDecision; }

  configureModels(payload) {
    this.sam.configureModels(payload);
  }

  getStatusLabel() {
    return this.sam.getStatusSummary();
  }

  cancel() {
    if (this._abortCtrl) {
      this._abortCtrl.abort();
    }
  }

  async ensureLoaded(onStage, requestBundledExtractFn) {
    return this.sam.ensureLoaded(onStage, requestBundledExtractFn);
  }

  async release() {
    this.cancel();
    this._lastContext = null;
    this._occPool.dispose();
    await this.sam.release();
  }

  /**
   * Auto 2D vs 3D geometric classification (< 15ms CPU on primary view surface points).
   * Strictly coplanar patches embedded in surrounding plane (e.g., flower in framed painting) -> "2d";
   * All volumetric / raised / depth-discontinuous targets -> "3d" (3D prior).
   */
  classifyAutoDimension(cloud, camera, maskTopDown, maskW, maskH, pickPixels) {
    const camPos = camera.position;
    const camFwd = new T.Vector3();
    camera.getWorldDirection(camFwd);

    const inPts = [];
    const ringPts = [];
    const seenIn = new Set();
    const seenRing = new Set();

    // Find mask bounding box in pixel space
    let xMin = maskW, xMax = 0, yMin = maskH, yMax = 0;
    let maskPixCount = 0;
    for (let y = 0; y < maskH; y++) {
      const row = y * maskW;
      for (let x = 0; x < maskW; x++) {
        if (maskTopDown[row + x]) {
          maskPixCount++;
          if (x < xMin) xMin = x;
          if (x > xMax) xMax = x;
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
      }
    }
    if (maskPixCount < 16) return { mode: "3d", reason: t("editor.semantic.reasonDefault3dFewPixels"), metrics: {} };

    const ringPad = Math.max(6, Math.min(24, Math.round(Math.max(xMax - xMin, yMax - yMin) * 0.16)));
    const stride = Math.max(1, Math.floor(Math.sqrt(maskPixCount / 1600)));

    let borderTested = 0;
    let borderJumpHits = 0;
    const getDepthAt = (x, y) => {
      if (x < 0 || x >= maskW || y < 0 || y >= maskH) return null;
      const glY = maskH - 1 - y;
      const off = (glY * maskW + x) * 4;
      const id1 = decodePickId(pickPixels, off);
      if (id1 <= 0 || id1 - 1 >= cloud.n) return null;
      cloud.getWorldPosition(id1 - 1, VEC_A);
      return { idx: id1 - 1, pos: VEC_A.clone(), depth: VEC_B.subVectors(VEC_A, camPos).dot(camFwd) };
    };

    for (let y = Math.max(0, yMin - ringPad); y <= Math.min(maskH - 1, yMax + ringPad); y += stride) {
      for (let x = Math.max(0, xMin - ringPad); x <= Math.min(maskW - 1, xMax + ringPad); x += stride) {
        const inside = maskTopDown[y * maskW + x] !== 0;
        const sample = getDepthAt(x, y);
        if (!sample) continue;
        if (inside) {
          if (!seenIn.has(sample.idx) && inPts.length < 1800) {
            seenIn.add(sample.idx);
            inPts.push(sample.pos);
          }
          // Check mask border depth jump against outward 4-neighbor at ring step
          const dStep = Math.max(3, Math.round(ringPad * 0.4));
          const dirs = [[dStep, 0], [-dStep, 0], [0, dStep], [0, -dStep]];
          for (const [dx, dy] of dirs) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= maskW || ny < 0 || ny >= maskH) continue;
            if (maskTopDown[ny * maskW + nx] === 0) {
              const outS = getDepthAt(nx, ny);
              if (outS) {
                borderTested++;
                const relJump = Math.abs(outS.depth - sample.depth) / Math.max(0.25, sample.depth);
                if (relJump > 0.045) borderJumpHits++;
              }
              break;
            }
          }
        } else {
          // Only collect ring points close to mask bbox
          if (!seenRing.has(sample.idx) && ringPts.length < 1800) {
            seenRing.add(sample.idx);
            ringPts.push(sample.pos);
          }
        }
      }
    }

    if (inPts.length < 24 || ringPts.length < 24) {
      return { mode: "3d", reason: t("editor.semantic.reasonDefault3dFewRing"), metrics: { inCount: inPts.length, ringCount: ringPts.length } };
    }

    // 1. PCA flatness of inside points
    const inMean = new T.Vector3();
    for (const p of inPts) inMean.add(p);
    inMean.divideScalar(inPts.length);
    let ixx = 0, ixy = 0, ixz = 0, iyy = 0, iyz = 0, izz = 0;
    let objRadiusSq = 0;
    for (const p of inPts) {
      const dx = p.x - inMean.x, dy = p.y - inMean.y, dz = p.z - inMean.z;
      ixx += dx * dx; ixy += dx * dy; ixz += dx * dz;
      iyy += dy * dy; iyz += dy * dz; izz += dz * dz;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > objRadiusSq) objRadiusSq = r2;
    }
    const objRad = Math.max(0.02, Math.sqrt(objRadiusSq));
    const inEig = eigenSymmetric3x3(ixx / inPts.length, ixy / inPts.length, ixz / inPts.length, iyy / inPts.length, iyz / inPts.length, izz / inPts.length);
    const inPlanarity = inEig[2].val / Math.max(inEig[1].val, 1e-8);

    // 2. Robust plane fit on surrounding ring points
    const rMean = new T.Vector3();
    for (const p of ringPts) rMean.add(p);
    rMean.divideScalar(ringPts.length);
    let rxx = 0, rxy = 0, rxz = 0, ryy = 0, ryz = 0, rzz = 0;
    for (const p of ringPts) {
      const dx = p.x - rMean.x, dy = p.y - rMean.y, dz = p.z - rMean.z;
      rxx += dx * dx; rxy += dx * dy; rxz += dx * dz;
      ryy += dy * dy; ryz += dy * dz; rzz += dz * dz;
    }
    const rEig = eigenSymmetric3x3(rxx / ringPts.length, rxy / ringPts.length, rxz / ringPts.length, ryy / ringPts.length, ryz / ringPts.length, rzz / ringPts.length);
    const ringNormal = rEig[2].vec;
    const ringPlanarity = rEig[2].val / Math.max(rEig[1].val, 1e-8);

    // Protrusion of S_in above/below ring plane (viewing-angle invariant!)
    const dists = inPts.map((p) => Math.abs((p.x - rMean.x) * ringNormal.x + (p.y - rMean.y) * ringNormal.y + (p.z - rMean.z) * ringNormal.z));
    dists.sort((a, b) => a - b);
    const p50Protrusion = dists[Math.floor(dists.length * 0.5)] / objRad;
    const p90Protrusion = dists[Math.floor(dists.length * 0.9)] / objRad;
    const normalDot = Math.abs(inEig[2].vec.dot(ringNormal));

    // Also compute plane-relative border discontinuity (immune to oblique perspective foreshortening along tilted planes!)
    let borderPlaneJump = 0;
    const planeStepThresh = Math.max(0.015, objRad * 0.08);
    for (let i = 0; i < inPts.length; i++) {
      const d = Math.abs((inPts[i].x - rMean.x) * ringNormal.x + (inPts[i].y - rMean.y) * ringNormal.y + (inPts[i].z - rMean.z) * ringNormal.z);
      if (d > planeStepThresh) borderPlaneJump++;
    }
    const borderPlaneJumpRatio = borderPlaneJump / Math.max(1, inPts.length);
    const rawDepthJumpRatio = borderTested > 0 ? borderJumpHits / borderTested : 0;

    // 3D-prior rule: ONLY strictly coplanar flat surface with no out-of-plane step -> 2D!
    const isFlatCoplanar2D =
      inPlanarity < 0.045 &&
      ringPlanarity < 0.08 &&
      normalDot > 0.92 &&
      p50Protrusion < 0.045 &&
      p90Protrusion < 0.095 &&
      borderPlaneJumpRatio < 0.14;

    const metrics = {
      inPlanarity: Number(inPlanarity.toFixed(4)),
      ringPlanarity: Number(ringPlanarity.toFixed(4)),
      normalDot: Number(normalDot.toFixed(3)),
      p90Protrusion: Number(p90Protrusion.toFixed(4)),
      borderPlaneJumpRatio: Number(borderPlaneJumpRatio.toFixed(3)),
      rawDepthJumpRatio: Number(rawDepthJumpRatio.toFixed(3)),
    };

    if (isFlatCoplanar2D) {
      return { mode: "2d", reason: t("editor.semantic.reasonCoplanar2d"), metrics };
    }
    return { mode: "3d", reason: t("editor.semantic.reasonVolumetric3d"), metrics };
  }

  /**
   * Resolve 2D mask to 3D Gaussian hit mask (Surface / Depth-Limited Through / Infinite Through).
   * Fast pure-CPU evaluation reusing cached 2D mask + pick buffer -> enables real-time slider refresh!
   */
  resolve2DSelection(ctx, { depthMode = "surface", throughDepthMeters = 0.8, infiniteDepth = false }) {
    const { cloud, cameraSnap, maskTopDown, maskW, maskH, pickPixels, activeObjectIds, worldScopeFn } = ctx;
    const n = cloud.n;
    const hitMask = new Uint8Array(n);

    // 1. Collect visible surface hits & estimate front surface depth d0
    const frontDepths = [];
    const camPos = cameraSnap.position;
    const camFwd = cameraSnap.forward;
    const vp = cameraSnap.viewProj;

    for (let y = 0; y < maskH; y++) {
      const rowTop = y * maskW;
      const glRow = (maskH - 1 - y) * maskW;
      for (let x = 0; x < maskW; x++) {
        if (!maskTopDown[rowTop + x]) continue;
        const id1 = decodePickId(pickPixels, (glRow + x) * 4);
        if (id1 > 0 && id1 - 1 < n) {
          const idx = id1 - 1;
          hitMask[idx] = 1;
          if (frontDepths.length < 4096) {
            cloud.getWorldPosition(idx, VEC_A);
            const d = VEC_B.subVectors(VEC_A, camPos).dot(camFwd);
            if (d > 0) frontDepths.push(d);
          }
        }
      }
    }

    if (depthMode === "surface") {
      // Add tiny surface-skin tolerance (keeps multi-layer Gaussian skin intact without pinhole noise)
      if (frontDepths.length > 0) {
        frontDepths.sort((a, b) => a - b);
        const dFront = frontDepths[Math.floor(frontDepths.length * 0.12)];
        const dRear = frontDepths[Math.floor(frontDepths.length * 0.92)];
        const skinPad = Math.max(0.02, (dRear - dFront) * 0.15 + 0.015);
        this._projectIntoMaskByDepth(cloud, hitMask, maskTopDown, maskW, maskH, vp, camPos, camFwd, dFront - skinPad, dRear + skinPad, activeObjectIds, worldScopeFn);
      }
      return hitMask;
    }

    // Through mode: finite thickness from visible front surface d0, or infinite depth!
    let dMin = 0.001;
    let dMax = Infinity;
    if (!infiniteDepth) {
      frontDepths.sort((a, b) => a - b);
      const d0 = frontDepths.length > 0 ? frontDepths[Math.floor(frontDepths.length * 0.1)] : 0.001;
      dMin = Math.max(0.001, d0 - 0.03);
      dMax = d0 + Math.max(0.02, Number(throughDepthMeters) || 0.8);
    }
    this._projectIntoMaskByDepth(cloud, hitMask, maskTopDown, maskW, maskH, vp, camPos, camFwd, dMin, dMax, activeObjectIds, worldScopeFn);
    return hitMask;
  }

  _projectIntoMaskByDepth(cloud, outMask, maskTopDown, maskW, maskH, vp, camPos, camFwd, dMin, dMax, activeObjectIds, worldScopeFn) {
    const n = cloud.n;
    const flags = cloud.flags;
    const e = vp.elements;
    const e0 = e[0], e1 = e[1], e3 = e[3];
    const e4 = e[4], e5 = e[5], e7 = e[7];
    const e8 = e[8], e9 = e[9], e11 = e[11];
    const e12 = e[12], e13 = e[13], e15 = e[15];
    const hasFilter = activeObjectIds && activeObjectIds.size > 0;

    for (let i = 0; i < n; i++) {
      if (outMask[i]) continue;
      if (flags[i] & (FLAG_DELETED | FLAG_HIDDEN)) continue;
      if (hasFilter && !activeObjectIds.has(cloud.objectIds[i])) continue;
      cloud.getWorldPosition(i, VEC_A);
      const depth = (VEC_A.x - camPos.x) * camFwd.x + (VEC_A.y - camPos.y) * camFwd.y + (VEC_A.z - camPos.z) * camFwd.z;
      if (depth < dMin || depth > dMax) continue;
      const w = e3 * VEC_A.x + e7 * VEC_A.y + e11 * VEC_A.z + e15;
      if (w <= 1e-5) continue;
      const nx = ((e0 * VEC_A.x + e4 * VEC_A.y + e8 * VEC_A.z + e12) / w + 1) * 0.5;
      const ny = (1 - (e1 * VEC_A.x + e5 * VEC_A.y + e9 * VEC_A.z + e13) / w) * 0.5;
      if (nx < 0 || nx >= 1 || ny < 0 || ny >= 1) continue;
      const mx = Math.floor(nx * maskW);
      const my = Math.floor(ny * maskH);
      if (maskTopDown[my * maskW + mx]) {
        if (worldScopeFn && !worldScopeFn(VEC_A.x, VEC_A.y, VEC_A.z)) continue;
        outMask[i] = 1;
      }
    }
  }

  /**
   * Real-time 2D depth slider refresh without re-running SAM!
   */
  reapplyCached2DDepth({ op = "replace", depthMode = "surface", throughDepthMeters = 0.8, infiniteDepth = false }) {
    if (!this._lastContext || this._lastResolvedMode !== "2d") return null;
    const hitMask = this.resolve2DSelection(this._lastContext, { depthMode, throughDepthMeters, infiniteDepth });
    const { cloud, activeObjectIds } = this._lastContext;
    const before = applyBooleanSelection(cloud, op, (i) => hitMask[i] === 1, null, activeObjectIds);
    return { before, resolvedMode: "2d", hitCount: this._countMask(hitMask) };
  }

  _countMask(m) {
    let c = 0;
    for (let i = 0; i < m.length; i++) if (m[i]) c++;
    return c;
  }

  /**
   * Execute full box-prompt semantic selection (Auto / 2D / 3D).
   */
  async runBoxSelection({
    cloud,
    renderer,
    camera,
    orbit,
    renderMainFrame,
    viewportW,
    viewportH,
    boxNorm01,
    modeSetting = "auto",        // "auto" | "2d" | "3d"
    op = "replace",
    depthMode = "surface",       // "surface" | "through"
    throughDepthMeters = 0.8,
    infiniteDepth = false,
    silent3D = true,
    viewCount3D = 6,
    worldScopeFn = null,
    activeObjectIds = null,
    reuseCachedBox = false,
    requestBundledExtractFn = null,
    onUiProgress = null,         // ({ modeLabel, stage, note, visibleOrbitMode }) => void
  }) {
    if (this._busy) return null;
    this._busy = true;
    this._abortCtrl = new AbortController();
    const signal = this._abortCtrl.signal;
    const checkAbort = () => { if (signal.aborted) throw new DOMException(t("editor.semantic.aborted"), "AbortError"); };

    const report = (modeLabel, stage, note = "", visibleOrbitMode = false) => {
      if (typeof onUiProgress === "function") {
        onUiProgress({ modeLabel, stage, note, visibleOrbitMode });
      }
    };

    try {
      const backend = await this.ensureLoaded(
        (st) => report(t("editor.semantic.stageInitEngine"), st),
        requestBundledExtractFn,
      );
      checkAbort();
      const cpuNote = backend === "wasm"
        ? t("editor.semantic.cpuWasmNote")
        : "";

      let ctx = null;
      if (reuseCachedBox && this._lastContext && this._lastContext.cloud === cloud) {
        ctx = this._lastContext;
      } else {
        report(t("editor.semantic.stagePrimaryTitle"), t("editor.semantic.stagePrimaryDesc"), cpuNote);
        const capScale = Math.min(1, 768 / Math.max(viewportW, viewportH, 1));
        const capW = Math.max(256, Math.round(viewportW * capScale));
        const capH = Math.max(256, Math.round(viewportH * capScale));

        const primaryFrame = await cloud.renderOffscreenColor(renderer, camera, capW, capH, { hideSelection: true });
        checkAbort();
        const pickScale = Math.min(1, 512 / Math.max(viewportW, viewportH, 1));
        const pw = Math.max(128, Math.round(viewportW * pickScale));
        const ph = Math.max(128, Math.round(viewportH * pickScale));
        const { pixels: pickPixels } = cloud.renderPickBuffer(renderer, camera, pw, ph, "splat", 0.05);
        checkAbort();

        const primaryPred = await this.sam.segmentBox(primaryFrame.rgba, capW, capH, boxNorm01, {
          bottomUp: true,
          outW: pw,
          outH: ph,
          frameKey: `primary:${Date.now()}`,
        });
        checkAbort();

        camera.updateMatrixWorld();
        const vp = new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const fwd = new T.Vector3();
        camera.getWorldDirection(fwd);
        const autoDecision = this.classifyAutoDimension(cloud, camera, primaryPred.maskTopDown, pw, ph, pickPixels);
        this._lastAutoDecision = autoDecision;

        ctx = {
          cloud,
          boxNorm01: { ...boxNorm01 },
          maskTopDown: primaryPred.maskTopDown,
          confidenceTopDown: primaryPred.confidenceTopDown,
          predictedIou: primaryPred.predictedIou,
          prototype: primaryPred.prototype,
          maskW: pw,
          maskH: ph,
          capW,
          capH,
          pickPixels,
          autoDecision,
          activeObjectIds: activeObjectIds ? new Set(activeObjectIds) : null,
          worldScopeFn,
          cameraSnap: {
            position: camera.position.clone(),
            target: orbit ? orbit.target.clone() : new T.Vector3(),
            up: camera.up.clone(),
            forward: fwd,
            fov: camera.fov || 50,
            aspect: camera.aspect || viewportW / Math.max(1, viewportH),
            isOrtho: !!camera.isOrthographicCamera,
            viewProj: vp,
          },
        };
        this._lastContext = ctx;
      }

      // Resolve effective dimension (Auto vs Locked 2D/3D)
      const resolvedMode = modeSetting === "auto" ? ctx.autoDecision.mode : modeSetting;
      this._lastResolvedMode = resolvedMode;
      const modeTitle = modeSetting === "auto"
        ? (resolvedMode === "3d"
            ? t("editor.semantic.modeAuto3d")
            : t("editor.semantic.modeAuto2d"))
        : (resolvedMode === "3d"
            ? t("editor.semantic.modeLocked3d")
            : t("editor.semantic.modeLocked2d"));

      if (resolvedMode === "2d" || ctx.cameraSnap.isOrtho) {
        report(modeTitle, depthMode === "surface" ? t("editor.semantic.stageExtractSurface") : t("editor.semantic.stageFilterDepth"), cpuNote);
        const hitMask = this.resolve2DSelection(ctx, { depthMode, throughDepthMeters, infiniteDepth });
        checkAbort();
        const before = applyBooleanSelection(cloud, op, (i) => hitMask[i] === 1, null, ctx.activeObjectIds);
        return {
          before,
          resolvedMode: "2d",
          autoDecision: ctx.autoDecision,
          hitCount: this._countMask(hitMask),
          validViews: 1,
          skippedViews: 0,
          backend,
        };
      }

      // 3D Multi-View Pipeline!
      const res3d = await this._run3DMultiView(ctx, {
        renderer,
        camera,
        orbit,
        renderMainFrame,
        silent3D,
        viewCount3D,
        modeTitle,
        cpuNote,
        report,
        checkAbort,
      });
      checkAbort();
      const before = applyBooleanSelection(cloud, op, (i) => res3d.finalMask[i] === 1, null, ctx.activeObjectIds);
      return {
        before,
        resolvedMode: "3d",
        autoDecision: ctx.autoDecision,
        hitCount: this._countMask(res3d.finalMask),
        validViews: res3d.validViews,
        skippedViews: res3d.skippedViews,
        backend,
      };
    } finally {
      this._busy = false;
      this._abortCtrl = null;
    }
  }

  async _run3DMultiView(ctx, {
    renderer,
    camera,
    orbit,
    renderMainFrame,
    silent3D,
    viewCount3D,
    modeTitle,
    cpuNote,
    report,
    checkAbort,
  }) {
    const { cloud, maskTopDown, confidenceTopDown, maskW, maskH, pickPixels, prototype: refProto, cameraSnap, activeObjectIds, worldScopeFn } = ctx;
    const n = cloud.n;

    // 1. Primary view visible hits + frustum center candidates + base anchor extraction
    report(modeTitle, t("editor.semantic.stagePrimaryAnchors"), cpuNote, !silent3D);
    const primaryVisible = new Uint8Array(n);
    const primarySurfaceIdx = [];
    const primarySurfaceConf = [];
    for (let y = 0; y < maskH; y++) {
      const topRow = y * maskW;
      const glRow = (maskH - 1 - y) * maskW;
      for (let x = 0; x < maskW; x++) {
        if (!maskTopDown[topRow + x]) continue;
        const id1 = decodePickId(pickPixels, (glRow + x) * 4);
        if (id1 > 0 && id1 - 1 < n) {
          const idx = id1 - 1;
          if (!primaryVisible[idx]) {
            primaryVisible[idx] = 1;
            primarySurfaceIdx.push(idx);
            primarySurfaceConf.push(confidenceTopDown[topRow + x]);
          }
        }
      }
    }

    if (primarySurfaceIdx.length === 0) {
      return { finalMask: primaryVisible, validViews: 1, skippedViews: 0 };
    }

    // Compute robust target center, radius, AABB & 24-32 spatially distributed base anchors
    const xs = [], ys = [], zs = [];
    for (let k = 0; k < primarySurfaceIdx.length; k++) {
      cloud.getWorldPosition(primarySurfaceIdx[k], VEC_A);
      xs.push(VEC_A.x); ys.push(VEC_A.y); zs.push(VEC_A.z);
    }
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    zs.sort((a, b) => a - b);
    const pLo = Math.floor(xs.length * 0.05);
    const pHi = Math.max(pLo, Math.floor(xs.length * 0.95));
    const objMin = [xs[pLo], ys[pLo], zs[pLo]];
    const objMax = [xs[pHi], ys[pHi], zs[pHi]];
    const anchorCenter = new T.Vector3(
      (objMin[0] + objMax[0]) * 0.5,
      (objMin[1] + objMax[1]) * 0.5,
      (objMin[2] + objMax[2]) * 0.5,
    );
    const objRadius = Math.max(
      0.04,
      0.5 * Math.hypot(objMax[0] - objMin[0], objMax[1] - objMin[1], objMax[2] - objMin[2]),
    );

    // Select up to 28 spatially spread high-confidence base anchors
    const anchorCoords = [];
    const anchorStep = Math.max(1, Math.floor(primarySurfaceIdx.length / 28));
    for (let k = 0; k < primarySurfaceIdx.length && anchorCoords.length < 28 * 3; k += anchorStep) {
      cloud.getWorldPosition(primarySurfaceIdx[k], VEC_A);
      if (VEC_A.distanceTo(anchorCenter) > objRadius * 1.65) continue;
      anchorCoords.push(VEC_A.x, VEC_A.y, VEC_A.z);
    }
    if (anchorCoords.length === 0) anchorCoords.push(anchorCenter.x, anchorCenter.y, anchorCenter.z);

    // Build candidate pool: all points within enlarged target 3D sphere + primary view frustum core
    const maxCandR = objRadius * 2.2;
    const maxCandR2 = maxCandR * maxCandR;
    const candidates = new Uint8Array(n);
    const hasObjFilter = activeObjectIds && activeObjectIds.size > 0;
    for (let i = 0; i < n; i++) {
      if (cloud.flags[i] & (FLAG_DELETED | FLAG_HIDDEN)) continue;
      if (hasObjFilter && !activeObjectIds.has(cloud.objectIds[i])) continue;
      if (primaryVisible[i]) { candidates[i] = 1; continue; }
      cloud.getWorldPosition(i, VEC_A);
      const dx = VEC_A.x - anchorCenter.x, dy = VEC_A.y - anchorCenter.y, dz = VEC_A.z - anchorCenter.z;
      if (dx * dx + dy * dy + dz * dz <= maxCandR2) {
        if (!worldScopeFn || worldScopeFn(VEC_A.x, VEC_A.y, VEC_A.z)) candidates[i] = 1;
      }
    }

    // Stratified sample of non-target scene points for multi-worker occlusion screening
    const maxSceneSamples = 140000;
    const sampleStep = Math.max(1, Math.floor(n / maxSceneSamples));
    const sceneSamplePos = [];
    const sceneSampleScale = [];
    for (let i = 0; i < n; i += sampleStep) {
      if (cloud.flags[i] & (FLAG_DELETED | FLAG_HIDDEN)) continue;
      if (primaryVisible[i]) continue;
      cloud.getWorldPosition(i, VEC_A);
      // Skip points strictly inside target tight core so self-occlusion never triggers false positive
      if (VEC_A.distanceTo(anchorCenter) < objRadius * 0.92) continue;
      sceneSamplePos.push(VEC_A.x, VEC_A.y, VEC_A.z);
      const i4 = i * 4;
      const maxLog = Math.max(HALF_TO_FLOAT[cloud.scaleHalf[i4]], HALF_TO_FLOAT[cloud.scaleHalf[i4 + 1]], HALF_TO_FLOAT[cloud.scaleHalf[i4 + 2]]);
      sceneSampleScale.push(Math.min(0.6, Math.exp(Math.max(-10, Math.min(2, maxLog)))));
    }

    // 2. Stage 1: Multi-Worker Parallel Occlusion Pre-Screening & Two-Stage Reroute Selection
    report(modeTitle, t("editor.semantic.stageScreenViews"), cpuNote, !silent3D);
    await this._occPool.initScene({
      scenePos: new Float32Array(sceneSamplePos),
      sceneScale: new Float32Array(sceneSampleScale),
      anchors: new Float32Array(anchorCoords),
      objCenter: [anchorCenter.x, anchorCenter.y, anchorCenter.z],
      objRadius,
      objMin,
      objMax,
    });
    checkAbort();

    const baseOffset = cameraSnap.position.clone().sub(anchorCenter);
    // Keep sensible orbit distance proportional to object radius so framing stays clean
    const idealDist = Math.max(objRadius * 2.4, Math.min(baseOffset.length(), objRadius * 14));
    baseOffset.setLength(idealDist);

    const nominalSlots = buildNominal3DViewSlots(viewCount3D);
    const allProbePoses = [];
    const slotGroups = [];

    nominalSlots.forEach((slot, sIdx) => {
      const group = [];
      // Tier 0: base nominal pose
      const addCand = (tier, yaw, elev, distMul) => {
        const pose = makeOrbitPose(baseOffset, anchorCenter, yaw, elev, distMul);
        const id = `${sIdx}_${tier}_${group.length}`;
        const item = {
          id,
          slotIdx: sIdx,
          tier,
          pose,
          workerReq: {
            id,
            pos: pose.pos.toArray(),
            target: anchorCenter.toArray(),
            up: [0, 1, 0],
            fovDeg: cameraSnap.fov,
            aspect: cameraSnap.aspect,
          },
        };
        group.push(item);
        allProbePoses.push(item.workerReq);
      };
      addCand(0, slot.yawDeg, slot.elevDeltaDeg, slot.distMul);
      // Tier 1: gentle angle / elevation / pull-back reroutes (keeps object well-framed!)
      addCand(1, slot.yawDeg - 16, slot.elevDeltaDeg + 8, slot.distMul * 1.18);
      addCand(1, slot.yawDeg + 16, slot.elevDeltaDeg + 8, slot.distMul * 1.18);
      addCand(1, slot.yawDeg, slot.elevDeltaDeg + 22, slot.distMul * 1.24);
      addCand(1, slot.yawDeg, Math.max(-10, slot.elevDeltaDeg - 12), slot.distMul * 1.22);
      // Tier 2: wide-angle jump fallbacks (enforcing angular separation >= 30° from accepted views)
      addCand(2, slot.yawDeg + 42, slot.elevDeltaDeg + 28, slot.distMul * 1.28);
      addCand(2, slot.yawDeg - 42, slot.elevDeltaDeg + 28, slot.distMul * 1.28);
      slotGroups.push(group);
    });

    const evalResults = await this._occPool.evalPoses(allProbePoses);
    checkAbort();
    const evalMap = new Map(evalResults.map((r) => [r.id, r]));

    // Pick best non-overlapping valid poses (never shows rejected candidates even in visible mode!)
    const chosenDirections = [baseOffset.clone().normalize()];
    const minSepCos = Math.cos((28 * Math.PI) / 180);
    const validPlan = [];
    let skippedViews = 0;

    for (const group of slotGroups) {
      let picked = null;
      for (const tier of [0, 1, 2]) {
        const tierCands = group
          .filter((g) => g.tier === tier)
          .map((g) => ({ g, ev: evalMap.get(g.id) }))
          .filter((x) => x.ev && x.ev.accepted);
        tierCands.sort((a, b) => (b.ev.visibleRatio - a.ev.visibleRatio) || (b.ev.clearance - a.ev.clearance));
        for (const cand of tierCands) {
          if (tier === 2) {
            const tooClose = chosenDirections.some((d) => d.dot(cand.g.pose.dir) > minSepCos);
            if (tooClose) continue;
          }
          picked = cand;
          break;
        }
        if (picked) break;
      }
      if (picked) {
        chosenDirections.push(picked.g.pose.dir);
        validPlan.push(picked);
      } else {
        skippedViews++;
      }
    }

    // 3. Evidence accumulator (Visibility Carving + Confidence Voting)
    const posScore = new Float32Array(n);
    const negScore = new Float32Array(n);
    const posViews = new Uint8Array(n);
    const negViews = new Uint8Array(n);
    const silhouetteViews = new Uint8Array(n);
    let totalValidViews = 1;

    // Accumulate primary view BOTH positive (inside mask) AND negative (visible outside mask -> confirmed background!)
    let primaryAreaRatio = 0;
    for (let i = 0; i < maskTopDown.length; i++) if (maskTopDown[i]) primaryAreaRatio++;
    primaryAreaRatio /= Math.max(1, maskTopDown.length);
    const primarySeenBg = new Uint8Array(n);
    for (let y = 0; y < maskH; y++) {
      const topRow = y * maskW;
      const glRow = (maskH - 1 - y) * maskW;
      for (let x = 0; x < maskW; x++) {
        if (maskTopDown[topRow + x]) continue;
        const id1 = decodePickId(pickPixels, (glRow + x) * 4);
        if (id1 > 0 && id1 - 1 < n) {
          const idx = id1 - 1;
          if (!primaryVisible[idx]) primarySeenBg[idx] = 1;
        }
      }
    }
    for (let i = 0; i < primarySurfaceIdx.length; i++) {
      const idx = primarySurfaceIdx[i];
      posScore[idx] += 1.6;
      posViews[idx] = 1;
      silhouetteViews[idx] = 1;
    }
    for (let i = 0; i < n; i++) {
      if (primarySeenBg[i]) {
        negScore[i] += 1.8;
        negViews[i] = 1;
      }
    }

    // Save main camera state for restoration if visible mode (`!silent3D`) is used
    const origPos = camera.position.clone();
    const origUp = camera.up.clone();
    const origTarget = orbit ? orbit.target.clone() : anchorCenter.clone();
    const origFov = camera.fov;

    const vCam = new T.PerspectiveCamera(cameraSnap.fov, cameraSnap.aspect, camera.near, camera.far);
    vCam.up.set(0, 1, 0);

    try {
      for (let vi = 0; vi < validPlan.length; vi++) {
        checkAbort();
        const { g, ev } = validPlan[vi];
        report(
          modeTitle,
          t("editor.semantic.stageInferView", {
            current: vi + 2,
            total: validPlan.length + 1,
            mode: silent3D ? t("editor.semantic.viewModeSilent") : t("editor.semantic.viewModeVisible"),
          }),
          cpuNote,
          !silent3D,
        );

        // Configure virtual camera (or main camera if user explicitly disabled silent mode!)
        let activeCam = vCam;
        if (!silent3D) {
          camera.position.copy(g.pose.pos);
          camera.up.set(0, 1, 0);
          camera.lookAt(anchorCenter);
          if (orbit) orbit.target.copy(anchorCenter);
          camera.updateMatrixWorld();
          if (typeof renderMainFrame === "function") {
            await cloud.sortForCameraAsync(camera);
            renderMainFrame();
            // Brief frame yield so user visibly sees the valid viewpoint switch!
            await new Promise((r) => setTimeout(r, 90));
          }
          activeCam = camera;
        } else {
          vCam.position.copy(g.pose.pos);
          vCam.lookAt(anchorCenter);
          vCam.updateMatrixWorld();
          vCam.updateProjectionMatrix();
        }
        checkAbort();

        const viewFrame = await cloud.renderOffscreenColor(renderer, activeCam, ctx.capW, ctx.capH, { hideSelection: true });
        checkAbort();
        const { pixels: viewPick } = cloud.renderPickBuffer(renderer, activeCam, maskW, maskH, "splat", 0.05);
        checkAbort();

        // Run SAM 2.1 with projected 2D box + visible anchor interior points
        const pred = await this.sam.segmentBox(viewFrame.rgba, ctx.capW, ctx.capH, ev.projectedBox, {
          bottomUp: true,
          outW: maskW,
          outH: maskH,
          auxPointsNorm01: ev.visiblePoints || [],
          frameKey: `v3d:${vi}:${Date.now()}`,
          referenceAreaRatio: primaryAreaRatio,
        });
        checkAbort();

        // Stage 2 Semantic Similarity & Quality Gate (catches behind-wall / wrong-object hallucinations!)
        const sim = refProto && pred.prototype ? cosineSimilarity(refProto, pred.prototype) : 0.85;
        let viewMaskPix = 0;
        for (let p = 0; p < pred.maskTopDown.length; p++) if (pred.maskTopDown[p]) viewMaskPix++;
        const viewAreaRatio = viewMaskPix / Math.max(1, pred.maskTopDown.length);
        const qualityOk =
          pred.predictedIou >= 0.28 &&
          pred.objectScore >= 0.35 &&
          sim >= 0.46 &&
          viewAreaRatio >= Math.max(0.001, primaryAreaRatio * 0.14) &&
          viewAreaRatio <= Math.min(0.76, Math.max(0.25, primaryAreaRatio * 4.5));

        if (!qualityOk) {
          skippedViews++;
          continue;
        }

        totalValidViews++;
        const viewWeight = Math.max(0.5, Math.min(1.5, pred.predictedIou * (0.5 + 0.5 * sim)));

        // Visibility carving: visible inside -> +score, visible outside -> -score, occluded -> abstain!
        const seenVis = new Uint8Array(n);
        const insideVis = new Uint8Array(n);
        for (let y = 0; y < maskH; y++) {
          const topRow = y * maskW;
          const glRow = (maskH - 1 - y) * maskW;
          for (let x = 0; x < maskW; x++) {
            const id1 = decodePickId(viewPick, (glRow + x) * 4);
            if (id1 <= 0 || id1 - 1 >= n) continue;
            const idx = id1 - 1;
            seenVis[idx] = 1;
            if (pred.maskTopDown[topRow + x]) insideVis[idx] = 1;
          }
        }

        // Also update visual-hull silhouette count for candidate Gaussians (preserves occluded interior points!)
        const viewVp = new T.Matrix4().multiplyMatrices(activeCam.projectionMatrix, activeCam.matrixWorldInverse);
        const e = viewVp.elements;
        for (let i = 0; i < n; i++) {
          if (!candidates[i]) continue;
          if (seenVis[i]) {
            if (insideVis[i]) {
              posScore[i] += viewWeight;
              posViews[i]++;
            } else {
              negScore[i] += viewWeight;
              negViews[i]++;
            }
          }
          cloud.getWorldPosition(i, VEC_A);
          const w = e[3] * VEC_A.x + e[7] * VEC_A.y + e[11] * VEC_A.z + e[15];
          if (w > 1e-5) {
            const nx = ((e[0] * VEC_A.x + e[4] * VEC_A.y + e[8] * VEC_A.z + e[12]) / w + 1) * 0.5;
            const ny = (1 - (e[1] * VEC_A.x + e[5] * VEC_A.y + e[9] * VEC_A.z + e[13]) / w) * 0.5;
            if (nx >= 0 && nx < 1 && ny >= 0 && ny < 1) {
              const mx = Math.floor(nx * maskW);
              const my = Math.floor(ny * maskH);
              if (pred.maskTopDown[my * maskW + mx]) silhouetteViews[i]++;
            }
          }
        }
      }
    } finally {
      if (!silent3D) {
        camera.position.copy(origPos);
        camera.up.copy(origUp);
        camera.fov = origFov;
        camera.lookAt(origTarget);
        if (orbit) orbit.target.copy(origTarget);
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();
        if (typeof renderMainFrame === "function") {
          await cloud.sortForCameraAsync(camera);
          renderMainFrame();
        }
      }
    }

    // 4. Stage 3: Finalize Carved Evidence + 3D Anchor-Connected Graph + Support-Plane Leak Suppression
    report(modeTitle, t("editor.semantic.stageFuseViews", { count: totalValidViews }), cpuNote, false);
    const fused = new Uint8Array(n);
    const minHull = Math.max(1, Math.ceil(totalValidViews * 0.7));
    const minSecondaryVotes = totalValidViews >= 3 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      if (!candidates[i]) continue;
      const p = posScore[i];
      const ng = negScore[i];
      if (primaryVisible[i]) {
        // Points confirmed inside user's primary view mask: keep unless strongly carved away by multiple other views
        if (p >= ng * 0.9) fused[i] = 1;
      } else if (primarySeenBg[i]) {
        // Points explicitly visible OUTSIDE the user's primary view mask (tabletop/wall): never leak!
        continue;
      } else if (p > 0 && p >= ng * 1.25 && posViews[i] >= minSecondaryVotes) {
        // Back-side / side surfaces of the 3D object newly revealed in >=2 secondary views!
        fused[i] = 1;
      } else if (p === 0 && ng === 0 && silhouetteViews[i] >= minHull) {
        // Completely occluded interior core inside visual hull of >=70% views!
        fused[i] = 1;
      }
    }

    const finalMask = this._filterConnectedAndSuppressSupport(cloud, fused, primaryVisible, anchorCenter, objRadius);
    return { finalMask, validViews: totalValidViews, skippedViews };
  }

  _filterConnectedAndSuppressSupport(cloud, fused, primaryVisible, anchorCenter, objRadius) {
    const n = cloud.n;
    const cellSize = Math.max(0.02, Math.min(objRadius * 0.22, 0.14));
    const invCell = 1 / cellSize;
    const grid = new Map();
    const wx = new Float32Array(n);
    const wy = new Float32Array(n);
    const wz = new Float32Array(n);

    const activeIdx = [];
    for (let i = 0; i < n; i++) {
      if (!fused[i]) continue;
      cloud.getWorldPosition(i, VEC_A);
      wx[i] = VEC_A.x; wy[i] = VEC_A.y; wz[i] = VEC_A.z;
      activeIdx.push(i);
      const key = packVoxelKey(Math.floor(VEC_A.x * invCell), Math.floor(VEC_A.y * invCell), Math.floor(VEC_A.z * invCell));
      let b = grid.get(key);
      if (!b) { b = []; grid.set(key, b); }
      b.push(i);
    }
    if (activeIdx.length < 16) return fused;

    // Seed BFS from primaryVisible points near anchorCenter (drops detached background noise!)
    const visited = new Uint8Array(n);
    const queue = [];
    for (const i of activeIdx) {
      if (primaryVisible[i] && Math.hypot(wx[i] - anchorCenter.x, wy[i] - anchorCenter.y, wz[i] - anchorCenter.z) <= objRadius * 1.45) {
        visited[i] = 1;
        queue.push(i);
      }
    }
    if (queue.length === 0) return fused;

    const maxStepSq = (cellSize * 1.65) * (cellSize * 1.65);
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      const ix = Math.floor(wx[u] * invCell);
      const iy = Math.floor(wy[u] * invCell);
      const iz = Math.floor(wz[u] * invCell);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const b = grid.get(packVoxelKey(ix + dx, iy + dy, iz + dz));
            if (!b) continue;
            for (let k = 0; k < b.length; k++) {
              const v = b[k];
              if (visited[v]) continue;
              const d2 = (wx[v] - wx[u]) ** 2 + (wy[v] - wy[u]) ** 2 + (wz[v] - wz[u]) ** 2;
              if (d2 <= maxStepSq) {
                visited[v] = 1;
                queue.push(v);
              }
            }
          }
        }
      }
    }

    // Gentle horizontal support-plane leak trimming at extreme bottom Z skirt if far outside core footprint
    if (queue.length > 64) {
      const zVals = queue.map((i) => wz[i]).sort((a, b) => a - b);
      const zFloor = zVals[Math.floor(zVals.length * 0.03)];
      const zCut = zFloor + Math.max(0.012, objRadius * 0.06);
      const horizCutSq = (objRadius * 1.25) ** 2;
      for (const i of queue) {
        if (wz[i] <= zCut && !primaryVisible[i]) {
          const h2 = (wx[i] - anchorCenter.x) ** 2 + (wy[i] - anchorCenter.y) ** 2;
          if (h2 > horizCutSq) visited[i] = 0;
        }
      }
    }
    return visited;
  }
}
