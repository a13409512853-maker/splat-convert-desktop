/**
 * @module measure/surface-picker
 * @description Anti-floater GPU solid-surface picking & smooth local normal estimation
 * plus 3D surface-aligned circular ring cursor for 3DGS Smart Measurement Suite.
 *
 * Strategy:
 * - Renders & caches a downsampled GPU ID pick buffer with elevated alpha threshold (default 0.45)
 *   to ignore sparse semi-transparent floaters (automatically invalidated on camera/matrix change).
 * - Samples a 5x5 pixel window around the pointer and chooses the robust median-depth hit among
 *   foreground solid splats, eliminating single-splat floater spikes.
 * - Estimates a smooth local surface normal via 3x3 covariance PCA over nearby depth-coherent
 *   3D points in a 7x7 pixel window so the surface-aligned cursor ring glides smoothly without jitter.
 */
import * as T from "three";
import { decodePickId } from "../cloud.js";

const Z_AXIS = new T.Vector3(0, 0, 1);

function smallestEigenvector3x3(c00, c01, c02, c11, c12, c22) {
  const A = [
    [c00, c01, c02],
    [c01, c11, c12],
    [c02, c12, c22],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 12; iter++) {
    let p = 0, q = 1, maxOff = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > maxOff) { p = 0; q = 2; maxOff = Math.abs(A[0][2]); }
    if (Math.abs(A[1][2]) > maxOff) { p = 1; q = 2; maxOff = Math.abs(A[1][2]); }
    if (maxOff < 1e-10) break;
    const tau = (A[q][q] - A[p][p]) / (2 * A[p][q]);
    const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : -1 / (-tau + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const app = A[p][p], aqq = A[q][q], apq = A[p][q];
    A[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    A[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    A[p][q] = A[q][p] = 0;
    const r = 3 - p - q;
    const arp = A[r][p], arq = A[r][q];
    A[r][p] = A[p][r] = c * arp - s * arq;
    A[r][q] = A[q][r] = s * arp + c * arq;
    for (let k = 0; k < 3; k++) {
      const vkp = V[k][p], vkq = V[k][q];
      V[k][p] = c * vkp - s * vkq;
      V[k][q] = s * vkp + c * vkq;
    }
  }
  let minIdx = 0;
  if (A[1][1] < A[minIdx][minIdx]) minIdx = 1;
  if (A[2][2] < A[minIdx][minIdx]) minIdx = 2;
  return new T.Vector3(V[0][minIdx], V[1][minIdx], V[2][minIdx]).normalize();
}

export class SolidSurfacePicker {
  constructor() {
    this._cache = null;
    this._fallbackCache = null;
    this._tmpV = new T.Vector3();
    this._tmpCam = new T.Vector3();
  }

  invalidate() {
    this._cache = null;
    this._fallbackCache = null;
  }

  _buildSig(cloud, camera, viewportW, viewportH, displayMode) {
    camera.updateMatrixWorld();
    const vm = camera.matrixWorldInverse.elements;
    const pm = camera.projectionMatrix.elements;
    const om0 = cloud.objectMatrices[0]?.elements;
    return (
      `${displayMode}|${viewportW}x${viewportH}|${cloud.n}|${camera.isOrthographicCamera ? 1 : 0}|` +
      `${vm[0].toFixed(3)},${vm[4].toFixed(3)},${vm[8].toFixed(3)},${vm[12].toFixed(2)},${vm[13].toFixed(2)},${vm[14].toFixed(2)}|` +
      `${pm[0].toFixed(3)},${pm[5].toFixed(3)}|` +
      `${om0 ? om0[0].toFixed(3) + "," + om0[12].toFixed(2) + "," + om0[14].toFixed(2) : ""}`
    );
  }

  _getSolidBuffer(cloud, renderer, camera, viewportW, viewportH, displayMode, alphaThreshold, isFallback = false) {
    const sig = this._buildSig(cloud, camera, viewportW, viewportH, displayMode) + `|a${alphaThreshold}`;
    const scale = Math.min(1, 512 / Math.max(viewportW, viewportH, 1));
    const pw = Math.max(64, Math.round(viewportW * scale));
    const ph = Math.max(64, Math.round(viewportH * scale));
    const slot = isFallback ? "_fallbackCache" : "_cache";
    if (!this[slot] || this[slot].sig !== sig || this[slot].pw !== pw || this[slot].ph !== ph) {
      const { pixels } = cloud.renderPickBuffer(renderer, camera, pw, ph, displayMode, alphaThreshold);
      this[slot] = { sig, pw, ph, scale, pixels };
    }
    return this[slot];
  }

  /**
   * Anti-floater median-depth solid surface pick + smooth 7x7 PCA surface normal.
   * @returns {{ idx: number, worldPos: T.Vector3, normal: T.Vector3 } | null}
   */
  pickSurface(cloud, renderer, camera, viewportW, viewportH, nx, ny, displayMode) {
    if (!cloud || cloud.n === 0) return null;

    // Pass 1: Strict alpha cutoff (0.45) rejects translucent floating noise haze!
    const primaryThresh = displayMode === "splat" ? 0.45 : 0.0;
    let buf = this._getSolidBuffer(cloud, renderer, camera, viewportW, viewportH, displayMode, primaryThresh, false);
    let res = this._sampleWindow(cloud, camera, buf, nx, ny);

    // Pass 2: Graceful fallback for ultra-soft / low-opacity regions (still filters <0.16 fog)
    if (!res && primaryThresh > 0.16) {
      buf = this._getSolidBuffer(cloud, renderer, camera, viewportW, viewportH, displayMode, 0.16, true);
      res = this._sampleWindow(cloud, camera, buf, nx, ny);
    }
    return res;
  }

  _sampleWindow(cloud, camera, buf, nx, ny) {
    const { pw, ph, pixels } = buf;
    const cx = Math.min(pw - 1, Math.max(0, Math.round(nx * (pw - 1))));
    const cy = Math.min(ph - 1, Math.max(0, Math.round((1 - ny) * (ph - 1))));
    const viewMat = camera.matrixWorldInverse;

    // 1. Collect solid hits in 5x5 core window for robust median-depth selection (rejects closer single-splat floaters!)
    const coreHits = [];
    const seen = new Set();
    for (let dy = -2; dy <= 2; dy++) {
      const py = cy + dy;
      if (py < 0 || py >= ph) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const px = cx + dx;
        if (px < 0 || px >= pw) continue;
        const off = (py * pw + px) * 4;
        const id1 = decodePickId(pixels, off);
        if (id1 === 0) continue;
        const idx = id1 - 1;
        if (idx >= cloud.n || seen.has(idx)) continue;
        seen.add(idx);
        const wp = new T.Vector3();
        cloud.getWorldPosition(idx, wp);
        const camZ = this._tmpCam.copy(wp).applyMatrix4(viewMat).z;
        const depth = -camZ; // positive distance in front of camera
        coreHits.push({ idx, wp, depth, d2: dx * dx + dy * dy });
      }
    }
    if (coreHits.length === 0) return null;

    // Median-depth pick: sort by camera depth and take 45th percentile (ignores closer stray floaters & far background holes!)
    coreHits.sort((a, b) => a.depth - b.depth);
    let chosen = coreHits[Math.min(coreHits.length - 1, Math.floor(coreHits.length * 0.45))];
    // Prefer center pixel if its depth is consistent with the median cluster!
    const centerHit = coreHits.find((h) => h.d2 === 0);
    if (centerHit) {
      const spread = Math.max(0.03, chosen.depth * 0.035);
      if (Math.abs(centerHit.depth - chosen.depth) <= spread) {
        chosen = centerHit;
      }
    }

    // 2. Gather depth-coherent neighborhood in 7x7 window for smooth PCA normal estimation
    const neigh = [];
    const depthTol = Math.max(0.06, chosen.depth * 0.08);
    const seenN = new Set();
    for (let dy = -4; dy <= 4; dy++) {
      const py = cy + dy;
      if (py < 0 || py >= ph) continue;
      for (let dx = -4; dx <= 4; dx++) {
        const px = cx + dx;
        if (px < 0 || px >= pw) continue;
        const off = (py * pw + px) * 4;
        const id1 = decodePickId(pixels, off);
        if (id1 === 0) continue;
        const idx = id1 - 1;
        if (idx >= cloud.n || seenN.has(idx)) continue;
        seenN.add(idx);
        const wp = new T.Vector3();
        cloud.getWorldPosition(idx, wp);
        const d = -this._tmpCam.copy(wp).applyMatrix4(viewMat).z;
        if (Math.abs(d - chosen.depth) <= depthTol) {
          neigh.push(wp);
        }
      }
    }

    const toCam = new T.Vector3().subVectors(camera.position, chosen.wp).normalize();
    let normal = toCam.clone();
    if (neigh.length >= 5) {
      let mx = 0, my = 0, mz = 0;
      for (const p of neigh) { mx += p.x; my += p.y; mz += p.z; }
      const inv = 1 / neigh.length;
      mx *= inv; my *= inv; mz *= inv;
      let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
      for (const p of neigh) {
        const rx = p.x - mx, ry = p.y - my, rz = p.z - mz;
        c00 += rx * rx; c01 += rx * ry; c02 += rx * rz;
        c11 += ry * ry; c12 += ry * rz; c22 += rz * rz;
      }
      const nrm = smallestEigenvector3x3(c00, c01, c02, c11, c12, c22);
      if (nrm.lengthSq() > 0.5) {
        if (nrm.dot(toCam) < 0) nrm.negate();
        normal = nrm;
      }
    }

    return {
      idx: chosen.idx,
      worldPos: chosen.wp,
      normal,
    };
  }
}

/**
 * 3D Surface-Aligned Circular Ring Cursor (lies tangent to hovered surface normal!).
 */
export class SurfaceRingCursor extends T.Group {
  constructor() {
    super();
    this.name = "MeasureSurfaceCursor";
    this.visible = false;
    this.renderOrder = 42;

    const ringGeo = new T.RingGeometry(0.74, 1.0, 40);
    this._ringMat = new T.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.94,
      side: T.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this._ringMesh = new T.Mesh(ringGeo, this._ringMat);
    this._ringMesh.renderOrder = 42;

    const haloGeo = new T.RingGeometry(0.55, 1.18, 40);
    this._haloMat = new T.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.36,
      side: T.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this._haloMesh = new T.Mesh(haloGeo, this._haloMat);
    this._haloMesh.renderOrder = 41;

    const dotGeo = new T.CircleGeometry(0.24, 20);
    this._dotMat = new T.MeshBasicMaterial({
      color: 0xef4444,
      transparent: true,
      opacity: 0.95,
      side: T.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this._dotMesh = new T.Mesh(dotGeo, this._dotMat);
    this._dotMesh.renderOrder = 43;

    // Subtle normal needle indicator
    const normGeo = new T.BufferGeometry().setFromPoints([
      new T.Vector3(0, 0, 0),
      new T.Vector3(0, 0, 1.5),
    ]);
    this._normLine = new T.Line(
      normGeo,
      new T.LineBasicMaterial({ color: 0xfdba74, transparent: true, opacity: 0.8, depthTest: false }),
    );
    this._normLine.renderOrder = 42;

    this.add(this._haloMesh, this._ringMesh, this._dotMesh, this._normLine);
    this._q = new T.Quaternion();
  }

  update(hit, camera, { snapHighlight = false } = {}) {
    if (!hit || !camera) {
      this.visible = false;
      return;
    }
    this.visible = true;
    this.position.copy(hit.worldPos);
    const nrm = hit.normal.clone().normalize();
    if (nrm.z < -0.9999) {
      this._q.setFromAxisAngle(new T.Vector3(1, 0, 0), Math.PI);
    } else {
      this._q.setFromUnitVectors(Z_AXIS, nrm);
    }
    this.quaternion.copy(this._q);

    const dist = Math.max(0.15, camera.position.distanceTo(hit.worldPos));
    const scale = camera.isOrthographicCamera
      ? Math.max(0.015, (camera.top - camera.bottom) * 0.014)
      : dist * 0.022;
    this.scale.setScalar(scale * (snapHighlight ? 1.32 : 1.0));
    this._haloMat.color.setHex(snapHighlight ? 0xfacc15 : 0xf97316);
    this._dotMat.color.setHex(snapHighlight ? 0xfacc15 : 0xef4444);
  }

  hide() {
    this.visible = false;
  }

  dispose() {
    this.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
