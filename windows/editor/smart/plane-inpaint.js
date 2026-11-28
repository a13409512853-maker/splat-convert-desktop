/**
 * @module smart/plane-inpaint
 * @description Smart Planar Hole Inpainting Engine supporting L1 (Fast Geometric Planar PatchMatch)
 * and L2 (Default: LaMa ONNX 512x512 Planar Reprojection) (M09).
 *
 * Design Contract (模块设计思路与架构档案.md M09):
 * - Extracts visible surrounding collar Gaussians around a user-boxed hole (or last deleted/moved gap)
 *   and fits an exact 3D support plane via RANSAC -> (origin, normal, tangentU, tangentV).
 * - L1 (0 MB model, <0.3s): Synthesizes flat plane-aligned anisotropic Gaussians spanning the hole,
 *   filling textures via multi-pass boundary diffusion + neighborhood PatchMatch grain cloning.
 * - L2 (Default, LaMa ONNX + exact analytical plane reprojection): Captures a clean 512x512 top-down
 *   orthographic view along plane normal, inpaints with LaMa ONNX, and analytically reprojects the
 *   repaired pixels onto the exact 3D support plane as flat anisotropic Gaussians (0 depth drift!).
 * - All generated splats return structured arrays (`positions`, `logScales`, `quats`, `rgba`) to be
 *   appended via `cloud.appendSyntheticPoints()` as an undoable, non-destructive Scene Object.
 */
import * as T from "three";
import { HALF_TO_FLOAT, decodePickId } from "../cloud.js";
import { LamaRuntime, LAMA_SIZE } from "./lama-runtime.js";
import { t } from "../i18n.js";

const V_TMP = new T.Vector3();

/**
 * Robust RANSAC 3D plane fitting on collar points, oriented so `normal` faces `cameraPos`.
 */
function fitSupportPlaneRansac(points, cameraPos) {
  const m = points.length;
  if (m < 3) return null;

  // Compute centroid & rough scale
  const mean = new T.Vector3();
  for (let i = 0; i < m; i++) mean.add(points[i]);
  mean.divideScalar(m);
  let avgDist = 0;
  for (let i = 0; i < m; i++) avgDist += points[i].distanceTo(mean);
  avgDist = Math.max(0.02, avgDist / m);
  const inlierThresh = Math.max(0.008, avgDist * 0.075);

  let bestNormal = new T.Vector3(0, 0, 1);
  let bestOrigin = mean.clone();
  let bestCount = -1;

  const ab = new T.Vector3();
  const ac = new T.Vector3();
  const candN = new T.Vector3();
  const iters = Math.min(140, Math.max(40, m));
  let seed = 1337;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let it = 0; it < iters; it++) {
    const i0 = Math.floor(nextRand() * m);
    const i1 = Math.floor(nextRand() * m);
    const i2 = Math.floor(nextRand() * m);
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    ab.subVectors(points[i1], points[i0]);
    ac.subVectors(points[i2], points[i0]);
    candN.crossVectors(ab, ac);
    const len = candN.length();
    if (len < 1e-6) continue;
    candN.divideScalar(len);

    const p0 = points[i0];
    let count = 0;
    for (let k = 0; k < m; k++) {
      const p = points[k];
      const d = Math.abs((p.x - p0.x) * candN.x + (p.y - p0.y) * candN.y + (p.z - p0.z) * candN.z);
      if (d <= inlierThresh) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestNormal.copy(candN);
      bestOrigin.copy(p0);
    }
  }

  // Refine plane origin to mean of inliers
  const refinedOrigin = new T.Vector3();
  let inlierN = 0;
  for (let k = 0; k < m; k++) {
    const p = points[k];
    const d = Math.abs((p.x - bestOrigin.x) * bestNormal.x + (p.y - bestOrigin.y) * bestNormal.y + (p.z - bestOrigin.z) * bestNormal.z);
    if (d <= inlierThresh * 1.4) {
      refinedOrigin.add(p);
      inlierN++;
    }
  }
  if (inlierN >= 3) refinedOrigin.divideScalar(inlierN);
  else refinedOrigin.copy(mean);

  // Orient normal toward camera
  if (cameraPos) {
    const toCam = cameraPos.clone().sub(refinedOrigin);
    if (bestNormal.dot(toCam) < 0) bestNormal.negate();
  }

  // Construct orthonormal planar basis (u, v, n)
  const ref = Math.abs(bestNormal.z) < 0.9 ? new T.Vector3(0, 0, 1) : new T.Vector3(1, 0, 0);
  const tangentU = new T.Vector3().crossVectors(ref, bestNormal).normalize();
  const tangentV = new T.Vector3().crossVectors(bestNormal, tangentU).normalize();

  // Quaternion aligning local +X -> tangentU, +Y -> tangentV, +Z -> bestNormal
  const rotMat = new T.Matrix4().makeBasis(tangentU, tangentV, bestNormal);
  const quat = new T.Quaternion().setFromRotationMatrix(rotMat);

  return {
    origin: refinedOrigin,
    normal: bestNormal,
    tangentU,
    tangentV,
    quat,
    inlierRatio: inlierN / m,
  };
}

function unprojectToPlane(ndcX, ndcY, camera, plane) {
  const ray = new T.Raycaster();
  ray.setFromCamera(new T.Vector2(ndcX, ndcY), camera);
  const threePlane = new T.Plane().setFromNormalAndCoplanarPoint(plane.normal, plane.origin);
  const hit = new T.Vector3();
  if (!ray.ray.intersectPlane(threePlane, hit)) return null;
  return hit;
}

/**
 * L1 Fast Boundary Diffusion + Neighborhood PatchMatch Cloning on a 2D planar RGB grid.
 */
function fillGridL1(rgbGrid, knownMask, gw, gh) {
  const out = new Float32Array(gw * gh * 3);
  const filled = new Uint8Array(knownMask);

  // Copy known boundary pixels & compute collar average + variance
  let sumR = 0, sumG = 0, sumB = 0, knownN = 0;
  const knownList = [];
  for (let i = 0; i < gw * gh; i++) {
    if (knownMask[i]) {
      const i3 = i * 3;
      out[i3] = rgbGrid[i3];
      out[i3 + 1] = rgbGrid[i3 + 1];
      out[i3 + 2] = rgbGrid[i3 + 2];
      sumR += out[i3]; sumG += out[i3 + 1]; sumB += out[i3 + 2];
      knownN++;
      knownList.push(i);
    }
  }
  const avgR = knownN ? sumR / knownN : 140;
  const avgG = knownN ? sumG / knownN : 140;
  const avgB = knownN ? sumB / knownN : 140;

  // Initialize unknown interior with collar mean
  for (let i = 0; i < gw * gh; i++) {
    if (!filled[i]) {
      const i3 = i * 3;
      out[i3] = avgR; out[i3 + 1] = avgG; out[i3 + 2] = avgB;
    }
  }

  // Multi-iteration harmonic/Laplace diffusion from known border inward (smooth lighting gradient!)
  const tmp = new Float32Array(out.length);
  const iters = Math.min(80, Math.max(24, Math.max(gw, gh)));
  for (let it = 0; it < iters; it++) {
    tmp.set(out);
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const idx = y * gw + x;
        if (knownMask[idx]) continue;
        const i3 = idx * 3;
        const l = (idx - 1) * 3, r = (idx + 1) * 3, u = (idx - gw) * 3, d = (idx + gw) * 3;
        tmp[i3] = 0.25 * (out[l] + out[r] + out[u] + out[d]);
        tmp[i3 + 1] = 0.25 * (out[l + 1] + out[r + 1] + out[u + 1] + out[d + 1]);
        tmp[i3 + 2] = 0.25 * (out[l + 2] + out[r + 2] + out[u + 2] + out[d + 2]);
      }
    }
    out.set(tmp);
  }

  // Subtle high-frequency texture detail transfer from random nearby known collar patches (avoids flat plastic look!)
  if (knownList.length >= 12) {
    let seed = 424242;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const idx = y * gw + x;
        if (knownMask[idx]) continue;
        const sampleIdx = knownList[Math.floor(rand() * knownList.length)];
        const sx = sampleIdx % gw, sy = (sampleIdx - sx) / gw;
        if (sx > 0 && sx < gw - 1 && sy > 0 && sy < gh - 1) {
          const s3 = sampleIdx * 3;
          const n3 = (sampleIdx - 1) * 3;
          const i3 = idx * 3;
          // High-pass residual delta blended softly (35%) onto smooth harmonic base
          const dr = (rgbGrid[s3] - rgbGrid[n3]) * 0.35;
          const dg = (rgbGrid[s3 + 1] - rgbGrid[n3 + 1]) * 0.35;
          const db = (rgbGrid[s3 + 2] - rgbGrid[n3 + 2]) * 0.35;
          out[i3] = Math.max(0, Math.min(255, out[i3] + dr));
          out[i3 + 1] = Math.max(0, Math.min(255, out[i3 + 1] + dg));
          out[i3 + 2] = Math.max(0, Math.min(255, out[i3 + 2] + db));
        }
      }
    }
  }
  return out;
}

export class PlaneInpaintEngine {
  constructor() {
    this.lama = new LamaRuntime();
    this._busy = false;
    this._lastHoleBoxNorm01 = null;
  }

  get isBusy() { return this._busy; }

  configureModels(payload) {
    this.lama.configureModels(payload);
  }

  isL2ModelInstalled() {
    return this.lama.isInstalled();
  }

  recordLastHoleBox(boxNorm01) {
    if (boxNorm01) this._lastHoleBoxNorm01 = { ...boxNorm01 };
  }

  getLastHoleBox() {
    return this._lastHoleBoxNorm01 ? { ...this._lastHoleBoxNorm01 } : null;
  }

  async release() {
    await this.lama.release();
  }

  /**
   * Execute Planar Hole Inpainting (mode = "L0" | "L1" | "L2") for a normalized screen box.
   * - L0: Pure Solid Color Fill (zero-model instant planar Gaussians filled with chosen solidColorRgb)
   * - L1: Fast Geometric Planar PatchMatch
   * - L2: LaMa ONNX 512x512 Planar Reprojection
   * Returns synthesized Gaussian patch ready for `cloud.appendSyntheticPoints(...)`.
   */
  async execute({
    cloud,
    renderer,
    camera,
    viewportW,
    viewportH,
    boxNorm01,
    mode = "L2",         // "L0" | "L1" | "L2" (default L2)
    solidColorRgb = [180, 180, 180], // Used in L0 pure-color mode ([0..255, 0..255, 0..255])
    edgeFeather = 0.18,  // [0.05..0.45] soft alpha feather fraction at patch perimeter
    requestBundledExtractFn = null,
    onProgress = null,
  }) {
    if (this._busy) return null;
    this._busy = true;
    const report = (stage, note = "") => {
      if (typeof onProgress === "function") onProgress({ mode, stage, note });
    };

    try {
      this._lastHoleBoxNorm01 = { ...boxNorm01 };
      report(t("editor.inpaint.stageFitPlane"));

      // 1. Sample collar points around the hole box using GPU ID pick buffer
      const pickScale = Math.min(1, 512 / Math.max(viewportW, viewportH, 1));
      const pw = Math.max(128, Math.round(viewportW * pickScale));
      const ph = Math.max(128, Math.round(viewportH * pickScale));
      const { pixels: pickPixels } = cloud.renderPickBuffer(renderer, camera, pw, ph, "splat", 0.06);

      const bx0 = Math.max(0, Math.floor(boxNorm01.x0 * pw));
      const by0 = Math.max(0, Math.floor(boxNorm01.y0 * ph));
      const bx1 = Math.min(pw - 1, Math.ceil(boxNorm01.x1 * pw));
      const by1 = Math.min(ph - 1, Math.ceil(boxNorm01.y1 * ph));
      const bw = Math.max(4, bx1 - bx0);
      const bh = Math.max(4, by1 - by0);
      const padX = Math.max(8, Math.min(48, Math.round(bw * 0.35)));
      const padY = Math.max(8, Math.min(48, Math.round(bh * 0.35)));

      const collarPts = [];
      const collarColors = [];
      const collarScales = [];
      const seen = new Set();
      const step = Math.max(1, Math.floor(Math.sqrt((bw + padX * 2) * (bh + padY * 2) / 1400)));

      for (let y = Math.max(0, by0 - padY); y <= Math.min(ph - 1, by1 + padY); y += step) {
        for (let x = Math.max(0, bx0 - padX); x <= Math.min(pw - 1, bx1 + padX); x += step) {
          // Only outer collar outside the hole box
          if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) continue;
          const glY = ph - 1 - y;
          const id1 = decodePickId(pickPixels, (glY * pw + x) * 4);
          if (id1 <= 0 || id1 - 1 >= cloud.n) continue;
          const idx = id1 - 1;
          if (seen.has(idx)) continue;
          seen.add(idx);
          cloud.getWorldPosition(idx, V_TMP);
          collarPts.push(V_TMP.clone());
          const i4 = idx * 4;
          collarColors.push([cloud.rgba[i4], cloud.rgba[i4 + 1], cloud.rgba[i4 + 2]]);
          const sLog = (HALF_TO_FLOAT[cloud.scaleHalf[i4]] + HALF_TO_FLOAT[cloud.scaleHalf[i4 + 1]] + HALF_TO_FLOAT[cloud.scaleHalf[i4 + 2]]) / 3;
          collarScales.push(Math.exp(Math.max(-10, Math.min(1, sLog))));
        }
      }

      if (collarPts.length < 12) {
        throw new Error(t("editor.inpaint.errInsufficientCollar"));
      }

      // 2. Fit exact 3D support plane via RANSAC
      const plane = fitSupportPlaneRansac(collarPts, camera.position);
      if (!plane) throw new Error(t("editor.inpaint.errPlaneFitFailed"));

      collarScales.sort((a, b) => a - b);
      const medScale = collarScales[collarScales.length >> 1] || 0.015;

      // 3. Project the 4 box corners onto the fitted 3D plane -> exact local 2D hole rectangle [uMin..uMax, vMin..vMax]
      const ndcCorners = [
        [boxNorm01.x0 * 2 - 1, 1 - boxNorm01.y0 * 2],
        [boxNorm01.x1 * 2 - 1, 1 - boxNorm01.y0 * 2],
        [boxNorm01.x1 * 2 - 1, 1 - boxNorm01.y1 * 2],
        [boxNorm01.x0 * 2 - 1, 1 - boxNorm01.y1 * 2],
      ];
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      const quadUV = [];
      for (const [nx, ny] of ndcCorners) {
        const hit = unprojectToPlane(nx, ny, camera, plane);
        if (!hit) continue;
        const rel = hit.clone().sub(plane.origin);
        const u = rel.dot(plane.tangentU);
        const v = rel.dot(plane.tangentV);
        quadUV.push([u, v]);
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
      }
      if (!Number.isFinite(uMin) || uMax - uMin < 1e-4 || vMax - vMin < 1e-4) {
        throw new Error(t("editor.inpaint.errViewParallel"));
      }

      const holeW = uMax - uMin;
      const holeH = vMax - vMin;
      // Match surrounding collar splat spacing cleanly (capped to [14..84] grid per axis so patches blend seamlessly!)
      const spacing = Math.max(medScale * 1.15, Math.max(holeW, holeH) / 72);
      const cellsU = Math.max(14, Math.min(84, Math.round(holeW / Math.max(1e-4, spacing))));
      const cellsV = Math.max(14, Math.min(84, Math.round(holeH / Math.max(1e-4, spacing))));
      const stepU = holeW / cellsU;
      const stepV = holeH / cellsV;

      // Exact convex quad membership test in plane (u,v) so oblique camera boxes NEVER spill outside the drawn box!
      const isInsideQuadUV = (u, v) => {
        if (quadUV.length < 3) return true;
        let sign = 0;
        for (let i = 0; i < quadUV.length; i++) {
          const [ax, ay] = quadUV[i];
          const [bx, by] = quadUV[(i + 1) % quadUV.length];
          const cross = (bx - ax) * (v - ay) - (by - ay) * (u - ax);
          if (Math.abs(cross) < 1e-9) continue;
          const s = cross > 0 ? 1 : -1;
          if (sign === 0) sign = s;
          else if (sign !== s) return false;
        }
        return true;
      };

      let effectiveMode = mode;
      let patchColorsRgb = null; // Float32Array(cellsU * cellsV * 3) in [0..255]

      if (mode === "L0") {
        // L0: Instant Pure Solid Color planar hole fill (rc12 #5)
        effectiveMode = "L0";
        report(t("editor.inpaint.stageRunL0"));
        const sr = Math.max(0, Math.min(255, Number(solidColorRgb?.[0]) || 0));
        const sg = Math.max(0, Math.min(255, Number(solidColorRgb?.[1]) || 0));
        const sb = Math.max(0, Math.min(255, Number(solidColorRgb?.[2]) || 0));
        patchColorsRgb = new Float32Array(cellsU * cellsV * 3);
        for (let i = 0; i < cellsU * cellsV; i++) {
          const d3 = i * 3;
          patchColorsRgb[d3] = sr;
          patchColorsRgb[d3 + 1] = sg;
          patchColorsRgb[d3 + 2] = sb;
        }
      } else if (mode === "L2") {
        // Check if LaMa L2 model is installed; if not, report cleanly so UI can trigger 1-click multi-mirror download!
        if (!this.lama.isInstalled()) {
          return { needDownloadL2: true, message: t("editor.inpaint.needDownloadL2") };
        }
        const ep = await this.lama.ensureLoaded((st) => report(st), requestBundledExtractFn);
        if (ep === "missing" || ep === "error") {
          return { needDownloadL2: true, message: t("editor.inpaint.lamaUnavailable") };
        }
        const cpuNote = ep === "wasm" ? t("editor.inpaint.cpuWasmNote") : "";
        report(t("editor.inpaint.stageOrthoCapture"), cpuNote);

        // Build clean orthographic camera perpendicular to fitted plane, framing 2.3x hole size for rich texture context!
        const uMid = (uMin + uMax) * 0.5;
        const vMid = (vMin + vMax) * 0.5;
        const holeCenter = plane.origin.clone()
          .addScaledVector(plane.tangentU, uMid)
          .addScaledVector(plane.tangentV, vMid);
        const span = Math.max(holeW, holeH) * 2.35;
        const halfSpan = span * 0.5;
        const camDist = Math.max(span * 1.6, 0.8);

        const orthoCam = new T.OrthographicCamera(-halfSpan, halfSpan, halfSpan, -halfSpan, 0.01, camDist * 4);
        orthoCam.position.copy(holeCenter).addScaledVector(plane.normal, camDist);
        orthoCam.up.copy(plane.tangentV);
        orthoCam.lookAt(holeCenter);
        orthoCam.updateMatrixWorld();
        orthoCam.updateProjectionMatrix();

        const off = await cloud.renderOffscreenColor(renderer, orthoCam, LAMA_SIZE, LAMA_SIZE, {
          hideSelection: true,
          clearColorHex: 0x000000,
        });

        // Flip WebGL bottom-up RGBA to top-down 512x512 + construct binary hole mask
        const S = LAMA_SIZE;
        const topRgba = new Uint8Array(S * S * 4);
        const mask512 = new Uint8Array(S * S);
        const hU0 = ((uMin - uMid) / span + 0.5) * S;
        const hU1 = ((uMax - uMid) / span + 0.5) * S;
        const hV0 = (0.5 - (vMax - vMid) / span) * S;
        const hV1 = (0.5 - (vMin - vMid) / span) * S;

        for (let y = 0; y < S; y++) {
          const srcRow = (S - 1 - y) * S;
          const dstRow = y * S;
          for (let x = 0; x < S; x++) {
            const sp = (srcRow + x) * 4;
            const dp = (dstRow + x) * 4;
            topRgba[dp] = off.rgba[sp];
            topRgba[dp + 1] = off.rgba[sp + 1];
            topRgba[dp + 2] = off.rgba[sp + 2];
            topRgba[dp + 3] = 255;
            if (x >= hU0 && x <= hU1 && y >= hV0 && y <= hV1) {
              mask512[dstRow + x] = 1;
            }
          }
        }

        report(t("editor.inpaint.stageRunLama"), cpuNote);
        const repairedRgba = await this.lama.inpaint(topRgba, mask512);

        // Sample repaired 512x512 RGB analytically onto each planar cell (u, v)
        patchColorsRgb = new Float32Array(cellsU * cellsV * 3);
        for (let iv = 0; iv < cellsV; iv++) {
          const v = vMin + (iv + 0.5) * stepV;
          const py = Math.max(0, Math.min(S - 1, Math.floor((0.5 - (v - vMid) / span) * S)));
          for (let iu = 0; iu < cellsU; iu++) {
            const u = uMin + (iu + 0.5) * stepU;
            const px = Math.max(0, Math.min(S - 1, Math.floor(((u - uMid) / span + 0.5) * S)));
            const sp = (py * S + px) * 4;
            const d3 = (iv * cellsU + iu) * 3;
            patchColorsRgb[d3] = repairedRgba[sp];
            patchColorsRgb[d3 + 1] = repairedRgba[sp + 1];
            patchColorsRgb[d3 + 2] = repairedRgba[sp + 2];
          }
        }
      } else {
        // L1: Zero-model fast planar harmonic + PatchMatch collar synthesis
        effectiveMode = "L1";
        report(t("editor.inpaint.stageRunL1"));
        const padCells = 6;
        const gw = cellsU + padCells * 2;
        const gh = cellsV + padCells * 2;
        const rgbGrid = new Float32Array(gw * gh * 3);
        const wGrid = new Float32Array(gw * gh);
        const known = new Uint8Array(gw * gh);

        const uOrigin = uMin - padCells * stepU;
        const vOrigin = vMin - padCells * stepV;
        for (let k = 0; k < collarPts.length; k++) {
          const rel = collarPts[k].clone().sub(plane.origin);
          const gx = Math.floor((rel.dot(plane.tangentU) - uOrigin) / stepU);
          const gy = Math.floor((rel.dot(plane.tangentV) - vOrigin) / stepV);
          if (gx < 0 || gx >= gw || gy < 0 || gy >= gh) continue;
          if (gx >= padCells && gx < padCells + cellsU && gy >= padCells && gy < padCells + cellsV) continue;
          const idx = gy * gw + gx;
          const i3 = idx * 3;
          rgbGrid[i3] += collarColors[k][0];
          rgbGrid[i3 + 1] += collarColors[k][1];
          rgbGrid[i3 + 2] += collarColors[k][2];
          wGrid[idx] += 1;
          known[idx] = 1;
        }
        for (let i = 0; i < gw * gh; i++) {
          if (wGrid[i] > 0) {
            const i3 = i * 3;
            rgbGrid[i3] /= wGrid[i];
            rgbGrid[i3 + 1] /= wGrid[i];
            rgbGrid[i3 + 2] /= wGrid[i];
          }
        }
        const filled = fillGridL1(rgbGrid, known, gw, gh);
        patchColorsRgb = new Float32Array(cellsU * cellsV * 3);
        for (let iv = 0; iv < cellsV; iv++) {
          for (let iu = 0; iu < cellsU; iu++) {
            const s3 = ((iv + padCells) * gw + (iu + padCells)) * 3;
            const d3 = (iv * cellsU + iu) * 3;
            patchColorsRgb[d3] = filled[s3];
            patchColorsRgb[d3 + 1] = filled[s3 + 1];
            patchColorsRgb[d3 + 2] = filled[s3 + 2];
          }
        }
      }

      // 4. Generate flat plane-aligned anisotropic 3D Gaussians strictly inside the projected box quad!
      const validCells = [];
      for (let iv = 0; iv < cellsV; iv++) {
        const v = vMin + (iv + 0.5) * stepV;
        for (let iu = 0; iu < cellsU; iu++) {
          const u = uMin + (iu + 0.5) * stepU;
          if (isInsideQuadUV(u, v)) validCells.push([iu, iv, u, v]);
        }
      }
      const total = validCells.length;
      if (total === 0) throw new Error(t("editor.inpaint.errEmptyProjection"));
      const positions = new Float32Array(total * 3);
      const logScales = new Float32Array(total * 3);
      const quats = new Float32Array(total * 4);
      const rgba = new Uint8Array(total * 4);

      const logSu = Math.log(Math.max(1e-4, stepU * 0.78));
      const logSv = Math.log(Math.max(1e-4, stepV * 0.78));
      const logSn = Math.log(Math.max(1e-5, Math.min(stepU, stepV) * 0.055));
      const qw = plane.quat.w, qx = plane.quat.x, qy = plane.quat.y, qz = plane.quat.z;
      const feather = Math.max(0.05, Math.min(0.45, edgeFeather));

      for (let k = 0; k < total; k++) {
        const [iu, iv, u, v] = validCells[k];
        const fv = Math.min((iv + 0.5) / cellsV, 1 - (iv + 0.5) / cellsV) / feather;
        const fu = Math.min((iu + 0.5) / cellsU, 1 - (iu + 0.5) / cellsU) / feather;
        const edgeAlpha = Math.max(0.42, Math.min(1.0, Math.min(fu, fv)));
        const k3 = k * 3;
        const k4 = k * 4;
        const c3 = (iv * cellsU + iu) * 3;

        positions[k3] = plane.origin.x + u * plane.tangentU.x + v * plane.tangentV.x;
        positions[k3 + 1] = plane.origin.y + u * plane.tangentU.y + v * plane.tangentV.y;
        positions[k3 + 2] = plane.origin.z + u * plane.tangentU.z + v * plane.tangentV.z;

        logScales[k3] = logSu;
        logScales[k3 + 1] = logSv;
        logScales[k3 + 2] = logSn;

        quats[k4] = qw;
        quats[k4 + 1] = qx;
        quats[k4 + 2] = qy;
        quats[k4 + 3] = qz;

        rgba[k4] = Math.max(0, Math.min(255, Math.round(patchColorsRgb[c3])));
        rgba[k4 + 1] = Math.max(0, Math.min(255, Math.round(patchColorsRgb[c3 + 1])));
        rgba[k4 + 2] = Math.max(0, Math.min(255, Math.round(patchColorsRgb[c3 + 2])));
        rgba[k4 + 3] = Math.round(edgeAlpha * 244);
      }

      return {
        needDownloadL2: false,
        mode: effectiveMode,
        count: total,
        plane,
        patchData: { positions, logScales, quats, rgba },
      };
    } finally {
      this._busy = false;
    }
  }
}
