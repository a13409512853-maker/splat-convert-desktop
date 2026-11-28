// Complete Selection & Semantic Segmentation Engine:
// - Basic 2D selections: rect, lasso, ellipse, polygon, brush
// - Exact "只选可见点" (GPU ID Picking Pass) & "整个高斯点" (exact 2*sqrt(2)*sigma projected 2D ellipse matching ReSplat Rings)
// - Special selections: Eyedropper (RGB/HSV), Opacity, Size (max/mean/ratio), fast zero-GC Voxel Floater Detector
// - Lazy-loaded Local SAM 2 ONNX (WebGPU/WASM) with immediate VRAM unload on exit + Built-in 2D/3D Edge-Aware & Spatial-Graph + Ground-Leak-Suppressed Semantic Engine
// - Automatic global enforcement of active Bounding Volumes & Camera-Side Infinite Occlusion Planes
import { t } from "./i18n.js";
import * as T from "three";
import { FLAG_SELECTED, FLAG_DELETED, FLAG_HIDDEN, HALF_TO_FLOAT, decodePickId } from "./cloud.js";
import { rgb2hsl } from "./color-grade.js";

const VEC_TMP = new T.Vector3();

/**
 * Apply unified boolean operation ("replace" | "add" | "subtract" | "intersect")
 * between existing FLAG_SELECTED bits and a hit predicate, enforcing volume/plane scope.
 */
export function applyBooleanSelection(cloud, op, hitFn, scopeFn = null, activeObjectIds = null) {
  const n = cloud.n;
  const flags = cloud.flags;
  const objIds = cloud.objectIds;
  const vis = cloud.objectVisibility;

  const before = new Uint8Array(flags);
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if ((f & FLAG_DELETED) || (f & FLAG_HIDDEN) || vis.get(objIds[i]) === false) continue;
    if (activeObjectIds && activeObjectIds.size > 0 && !activeObjectIds.has(objIds[i])) continue;

    let hit = false;
    if (scopeFn) {
      if (scopeFn(i)) hit = hitFn(i);
    } else {
      hit = hitFn(i);
    }

    const was = (f & FLAG_SELECTED) !== 0;
    let next = was;
    if (op === "replace") next = hit;
    else if (op === "add") next = was || hit;
    else if (op === "subtract") next = was && !hit;
    else if (op === "intersect") next = was && hit;

    if (next) flags[i] = f | FLAG_SELECTED;
    else flags[i] = f & ~FLAG_SELECTED;
  }
  return before;
}

function makeScopeByIndex(cloud, worldScopeFn) {
  if (!worldScopeFn) return null;
  const pos = cloud.pos;
  const objIds = cloud.objectIds;
  const mats = cloud.objectMatrices;
  return (i) => {
    const j = i * 3;
    const lx = pos[j], ly = pos[j + 1], lz = pos[j + 2];
    const m = mats[objIds[i]]?.elements;
    if (!m) return worldScopeFn(lx, ly, lz);
    return worldScopeFn(
      m[0] * lx + m[4] * ly + m[8] * lz + m[12],
      m[1] * lx + m[5] * ly + m[9] * lz + m[13],
      m[2] * lx + m[6] * ly + m[10] * lz + m[14],
    );
  };
}

// Exact Dan Sunday Non-Zero Winding Number test — 100% mathematically identical to SVG
// <polygon fill-rule="nonzero"> so self-intersecting Lasso / Polygon strokes NEVER disagree with preview!
function pointInPolygon(px, py, poly) {
  let wn = 0;
  const len = poly.length;
  for (let i = 0, j = len - 1; i < len; j = i++) {
    const x1 = poly[j][0], y1 = poly[j][1];
    const x2 = poly[i][0], y2 = poly[i][1];
    if (y1 <= py) {
      if (y2 > py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) > 0) {
        wn++;
      }
    } else {
      if (y2 <= py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) < 0) {
        wn--;
      }
    }
  }
  return wn !== 0;
}

function distToSegmentSq(px, py, x1, y1, x2, y2, aspect) {
  const dx = (x2 - x1) * aspect;
  const dy = y2 - y1;
  const rx = (px - x1) * aspect;
  const ry = py - y1;
  const t = Math.max(0, Math.min(1, (rx * dx + ry * dy) / (dx * dx + dy * dy || 1)));
  const ex = rx - t * dx;
  const ey = ry - t * dy;
  return ex * ex + ey * ey;
}

/**
 * Compute exact projected 2D screen ellipse NDC half-extents (ex, ey) and bounding radius
 * matching ReSplat Ring Mode's A = dot(uv, uv) <= 1.0 (2*sqrt(2)*sigma = 2.828427*sigma).
 */
export function projectedGaussianEllipseExtentsNdc(cloud, i, e, cx, cy, cw, isOrtho) {
  const i4 = i * 4;
  const sh = cloud.scaleHalf;
  const qh = cloud.quatHalf;
  const sx = Math.exp(Math.max(-18, Math.min(10, HALF_TO_FLOAT[sh[i4]])));
  const sy = Math.exp(Math.max(-18, Math.min(10, HALF_TO_FLOAT[sh[i4 + 1]])));
  const sz = Math.exp(Math.max(-18, Math.min(10, HALF_TO_FLOAT[sh[i4 + 2]])));

  const qx = HALF_TO_FLOAT[qh[i4]];
  const qy = HALF_TO_FLOAT[qh[i4 + 1]];
  const qz = HALF_TO_FLOAT[qh[i4 + 2]];
  const qw = HALF_TO_FLOAT[qh[i4 + 3]];

  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  // Columns of R * diag(sx, sy, sz) computed inline (zero permanent 36 B/pt RAM!)
  const a0x = (1 - (yy + zz)) * sx, a0y = (xy + wz) * sx, a0z = (xz - wy) * sx;
  const a1x = (xy - wz) * sy,       a1y = (1 - (xx + zz)) * sy, a1z = (yz + wx) * sy;
  const a2x = (xz + wy) * sz,       a2y = (yz - wx) * sz,       a2z = (1 - (xx + yy)) * sz;

  let sxx = 0, sxy = 0, syy = 0;
  for (let k = 0; k < 3; k++) {
    const vx = k === 0 ? a0x : k === 1 ? a1x : a2x;
    const vy = k === 0 ? a0y : k === 1 ? a1y : a2y;
    const vz = k === 0 ? a0z : k === 1 ? a1z : a2z;
    const dx = isOrtho
      ? (e[0] * vx + e[4] * vy + e[8] * vz)
      : (e[0] * vx + e[4] * vy + e[8] * vz - cx * (e[3] * vx + e[7] * vy + e[11] * vz)) / cw;
    const dy = isOrtho
      ? (e[1] * vx + e[5] * vy + e[9] * vz)
      : (e[1] * vx + e[5] * vy + e[9] * vz - cy * (e[3] * vx + e[7] * vy + e[11] * vz)) / cw;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const ex = Math.min(0.8, 2.828427 * Math.sqrt(Math.max(0, sxx)));
  const ey = Math.min(0.8, 2.828427 * Math.sqrt(Math.max(0, syy)));
  const mid = 0.5 * (sxx + syy);
  const disc = Math.sqrt(Math.max(0, (sxx - syy) * (sxx - syy) * 0.25 + sxy * sxy));
  const major = Math.min(0.8, 2.828427 * Math.sqrt(Math.max(0, mid + disc)));
  return { ex, ey, major };
}

/**
 * Execute 2D screen selection (rect, lasso, ellipse, poly, brush).
 * When onlyVisible=true, uses real GPU ID Picking Pass (honoring opacity, occlusion & exact A<=1.0 footprints)!
 */
export function runScreenSelection({
  cloud,
  renderer,
  camera,
  viewportW,
  viewportH,
  displayMode,
  kind,
  path,
  op,
  aspect,
  brushRadiusNdc = 0.04,
  onlyVisible = false,
  wholeGaussian = false,
  worldScopeFn = null,
  activeObjectIds = null,
}) {
  const scopeByIndex = makeScopeByIndex(cloud, worldScopeFn);

  // Precompute NDC bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of path) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const ellCx = (minX + maxX) * 0.5;
  const ellCy = (minY + maxY) * 0.5;
  const ellRx = Math.max(1e-5, (maxX - minX) * 0.5);
  const ellRy = Math.max(1e-5, (maxY - minY) * 0.5);

  // Fast Path A: GPU ID Picking Pass for "只选可见点" (exact visibility + exact ring footprint!)
  if (onlyVisible && renderer) {
    const scale = Math.min(1, 960 / Math.max(viewportW, viewportH, 1));
    const pw = Math.max(64, Math.round(viewportW * scale));
    const ph = Math.max(64, Math.round(viewportH * scale));
    const pickMode = wholeGaussian ? (displayMode === "points" ? "rings" : displayMode) : displayMode;
    const { pixels } = cloud.renderPickBuffer(
      renderer,
      camera,
      pw,
      ph,
      pickMode,
      pickMode === "splat" ? 0.04 : 0.0,
    );

    const padX = kind === "brush" ? brushRadiusNdc / Math.max(0.1, aspect) : 0;
    const padY = kind === "brush" ? brushRadiusNdc : 0;
    const px0 = Math.max(0, Math.floor(((minX - padX) * 0.5 + 0.5) * pw));
    const px1 = Math.min(pw - 1, Math.ceil(((maxX + padX) * 0.5 + 0.5) * pw));
    const py0 = Math.max(0, Math.floor(((minY - padY) * 0.5 + 0.5) * ph));
    const py1 = Math.min(ph - 1, Math.ceil(((maxY + padY) * 0.5 + 0.5) * ph));

    const visibleHit = new Uint8Array(cloud.n);
    const brushR2 = brushRadiusNdc * brushRadiusNdc;

    for (let py = py0; py <= py1; py++) {
      const ndcY = ((py + 0.5) / ph) * 2 - 1;
      for (let px = px0; px <= px1; px++) {
        const off = (py * pw + px) * 4;
        const id1 = decodePickId(pixels, off);
        if (id1 === 0) continue;
        const idx = id1 - 1;
        if (idx >= cloud.n || visibleHit[idx]) continue;

        const ndcX = ((px + 0.5) / pw) * 2 - 1;
        let inside = false;
        if (kind === "rect") {
          inside = ndcX >= minX && ndcX <= maxX && ndcY >= minY && ndcY <= maxY;
        } else if (kind === "ellipse") {
          const dx = (ndcX - ellCx) / ellRx;
          const dy = (ndcY - ellCy) / ellRy;
          inside = dx * dx + dy * dy <= 1.0;
        } else if (kind === "lasso" || kind === "poly") {
          inside = pointInPolygon(ndcX, ndcY, path);
        } else if (kind === "brush") {
          for (let k = 0; k < path.length; k++) {
            const p0 = path[Math.max(0, k - 1)];
            const p1 = path[k];
            if (distToSegmentSq(ndcX, ndcY, p0[0], p0[1], p1[0], p1[1], aspect) <= brushR2) {
              inside = true;
              break;
            }
          }
        }
        if (inside) visibleHit[idx] = 1;
      }
    }

    // If wholeGaussian is OFF while onlyVisible is ON, verify visible hit's center is inside the shape
    if (!wholeGaussian) {
      const vpMat = new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const mvpByObj = cloud.objectMatrices.map((om) => new T.Matrix4().multiplyMatrices(vpMat, om).elements);
      const pos = cloud.pos;
      const oids = cloud.objectIds;
      for (let i = 0; i < cloud.n; i++) {
        if (!visibleHit[i]) continue;
        const e = mvpByObj[oids[i]] || mvpByObj[0];
        const j = i * 3;
        const x = pos[j], y = pos[j + 1], z = pos[j + 2];
        const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (cw <= 1e-5) { visibleHit[i] = 0; continue; }
        const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
        const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
        let inCenter = false;
        if (kind === "rect") inCenter = cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
        else if (kind === "ellipse") inCenter = ((cx - ellCx) / ellRx) ** 2 + ((cy - ellCy) / ellRy) ** 2 <= 1;
        else if (kind === "lasso" || kind === "poly") inCenter = pointInPolygon(cx, cy, path);
        else if (kind === "brush") {
          for (let k = 0; k < path.length; k++) {
            const p0 = path[Math.max(0, k - 1)];
            const p1 = path[k];
            if (distToSegmentSq(cx, cy, p0[0], p0[1], p1[0], p1[1], aspect) <= brushR2) { inCenter = true; break; }
          }
        }
        if (!inCenter) visibleHit[i] = 0;
      }
    }

    return applyBooleanSelection(cloud, op, (i) => visibleHit[i] === 1, scopeByIndex, activeObjectIds);
  }

  // Path B: Through-selection with per-object world matrices & exact ReSplat 2*sqrt(2)*sigma wholeGaussian ellipse overlap
  const vpMat = new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const mvpByObj = cloud.objectMatrices.map((om) => new T.Matrix4().multiplyMatrices(vpMat, om).elements);
  const isOrtho = !!camera.isOrthographicCamera;
  const pos = cloud.pos;
  const oids = cloud.objectIds;

  const padX = (kind === "brush" ? brushRadiusNdc / Math.max(0.1, aspect) : 0) + (wholeGaussian ? 0.8 : 0);
  const padY = (kind === "brush" ? brushRadiusNdc : 0) + (wholeGaussian ? 0.8 : 0);

  const hitFn = (i) => {
    const e = mvpByObj[oids[i]] || mvpByObj[0];
    const j = i * 3;
    const x = pos[j], y = pos[j + 1], z = pos[j + 2];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (!isOrtho && cw <= 1e-5) return false;
    const invW = isOrtho ? 1 : 1 / cw;
    const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) * invW;
    const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) * invW;
    const cz = (e[2] * x + e[6] * y + e[10] * z + e[14]) * invW;
    if (cz < -1 || cz > 1) return false;

    if (cx < minX - padX || cx > maxX + padX || cy < minY - padY || cy > maxY + padY) {
      return false;
    }

    let ex = 0, ey = 0, major = 0;
    if (wholeGaussian) {
      const ext = projectedGaussianEllipseExtentsNdc(cloud, i, e, cx, cy, isOrtho ? 1 : cw, isOrtho);
      ex = ext.ex;
      ey = ext.ey;
      major = ext.major;
    }

    if (kind === "rect") {
      return cx + ex >= minX && cx - ex <= maxX && cy + ey >= minY && cy - ey <= maxY;
    }
    if (kind === "ellipse") {
      const rx = ellRx + ex;
      const ry = ellRy + ey;
      const dx = (cx - ellCx) / rx;
      const dy = (cy - ellCy) / ry;
      return dx * dx + dy * dy <= 1.0;
    }
    if (kind === "lasso" || kind === "poly") {
      if (pointInPolygon(cx, cy, path)) return true;
      if (major > 0) {
        // Test 4 ellipse cardinal boundary points + edge proximity
        if (
          pointInPolygon(cx + ex, cy, path) ||
          pointInPolygon(cx - ex, cy, path) ||
          pointInPolygon(cx, cy + ey, path) ||
          pointInPolygon(cx, cy - ey, path)
        ) {
          return true;
        }
        const r2 = major * major;
        for (let k = 0, p = path.length - 1; k < path.length; p = k++) {
          if (distToSegmentSq(cx, cy, path[p][0], path[p][1], path[k][0], path[k][1], 1) <= r2) {
            return true;
          }
        }
      }
      return false;
    }
    if (kind === "brush") {
      const effR = brushRadiusNdc + major;
      const effR2 = effR * effR;
      for (let k = 0; k < path.length; k++) {
        const p0 = path[Math.max(0, k - 1)];
        const p1 = path[k];
        if (distToSegmentSq(cx, cy, p0[0], p0[1], p1[0], p1[1], aspect) <= effR2) {
          return true;
        }
      }
      return false;
    }
    return false;
  };

  return applyBooleanSelection(cloud, op, hitFn, scopeByIndex, activeObjectIds);
}

// ============================================================================
// Special Selection 1: Eyedropper (RGB / HSV tolerance)
// ============================================================================
export function runEyedropperSelection({
  cloud,
  targetRgb,
  tolerance = 0.15,
  colorSpace = "rgb",
  op = "replace",
  worldScopeFn = null,
  activeObjectIds = null,
}) {
  const scopeByIndex = makeScopeByIndex(cloud, worldScopeFn);
  const rgba = cloud.rgba;
  const [tr, tg, tb] = targetRgb;
  const [th, ts, tl] = rgb2hsl(tr, tg, tb);
  const tolSq = tolerance * tolerance * 3;
  const inv255 = 1 / 255;

  const hitFn = (i) => {
    const i4 = i * 4;
    const r = rgba[i4] * inv255, g = rgba[i4 + 1] * inv255, b = rgba[i4 + 2] * inv255;
    if (colorSpace === "hsv") {
      const [h, s, l] = rgb2hsl(r, g, b);
      let dh = Math.abs(h - th);
      dh = Math.min(dh, 1 - dh);
      const ds = Math.abs(s - ts);
      const dl = Math.abs(l - tl);
      return dh <= tolerance * 0.45 && ds <= tolerance * 1.4 && dl <= tolerance * 1.4;
    }
    const dr = r - tr, dg = g - tg, db = b - tb;
    return dr * dr + dg * dg + db * db <= tolSq;
  };
  return applyBooleanSelection(cloud, op, hitFn, scopeByIndex, activeObjectIds);
}

// ============================================================================
// Special Selection 2: Opacity Range Selection
// ============================================================================
export function runOpacitySelection({
  cloud,
  minOpacity = 0.0,
  maxOpacity = 0.15,
  op = "replace",
  worldScopeFn = null,
  activeObjectIds = null,
}) {
  const scopeByIndex = makeScopeByIndex(cloud, worldScopeFn);
  const rgba = cloud.rgba;
  const lo = Math.min(minOpacity, maxOpacity) * 255;
  const hi = Math.max(minOpacity, maxOpacity) * 255;
  return applyBooleanSelection(cloud, op, (i) => {
    const a = rgba[i * 4 + 3];
    return a >= lo && a <= hi;
  }, scopeByIndex, activeObjectIds);
}

// ============================================================================
// Special Selection 3: Size / Scale Selection (world-space scaled!)
// ============================================================================
export function runSizeSelection({
  cloud,
  minSize = 0.0,
  maxSize = 0.5,
  mode = "max", // "max" | "mean" | "ratio"
  op = "replace",
  worldScopeFn = null,
  activeObjectIds = null,
}) {
  const scopeByIndex = makeScopeByIndex(cloud, worldScopeFn);
  const scaleHalf = cloud.scaleHalf;
  const oids = cloud.objectIds;
  // Precompute per-object world scale multiplier
  const objScaleMul = cloud.objectMatrices.map((m) => {
    const e = m.elements;
    const sx = Math.hypot(e[0], e[1], e[2]) || 1;
    const sy = Math.hypot(e[4], e[5], e[6]) || 1;
    const sz = Math.hypot(e[8], e[9], e[10]) || 1;
    return (sx + sy + sz) / 3;
  });

  const lo = Math.min(minSize, maxSize);
  const hi = Math.max(minSize, maxSize);

  const hitFn = (i) => {
    const i4 = i * 4;
    const mul = objScaleMul[oids[i]] || 1;
    const sx = Math.exp(Math.max(-18, Math.min(10, HALF_TO_FLOAT[scaleHalf[i4]]))) * mul;
    const sy = Math.exp(Math.max(-18, Math.min(10, HALF_TO_FLOAT[scaleHalf[i4 + 1]]))) * mul;
    const sz = Math.exp(Math.max(-18, Math.min(10, HALF_TO_FLOAT[scaleHalf[i4 + 2]]))) * mul;
    let val;
    if (mode === "mean") val = (sx + sy + sz) / 3;
    else if (mode === "ratio") val = Math.max(sx, sy, sz) / Math.max(1e-6, Math.min(sx, sy, sz));
    else val = Math.max(sx, sy, sz);
    return val >= lo && val <= hi;
  };
  return applyBooleanSelection(cloud, op, hitFn, scopeByIndex, activeObjectIds);
}

// ============================================================================
// Special Selection 4: Fast Zero-GC Numeric Voxel Floater Detector (World Space!)
// ============================================================================
const HASH_BIAS = 65536;
const HASH_STRIDE_Y = 131072; // 2^17
const HASH_STRIDE_Z = 17179869184; // 2^34 (fits safely within 2^53 JS Number!)

function packVoxelKey(ix, iy, iz) {
  const bx = Math.max(0, Math.min(131071, ix + HASH_BIAS));
  const by = Math.max(0, Math.min(131071, iy + HASH_BIAS));
  const bz = Math.max(0, Math.min(131071, iz + HASH_BIAS));
  return bx + by * HASH_STRIDE_Y + bz * HASH_STRIDE_Z;
}

export function runFloaterSelection({
  cloud,
  voxelSize = 0.12,
  maxNeighbors = 5,
  maxOpacity = 0.95,
  op = "replace",
  worldScopeFn = null,
  activeObjectIds = null,
}) {
  const scopeByIndex = makeScopeByIndex(cloud, worldScopeFn);
  const n = cloud.n;
  const pos = cloud.pos;
  const oids = cloud.objectIds;
  const mats = cloud.objectMatrices;
  const flags = cloud.flags;
  const rgba = cloud.rgba;
  const invV = 1 / Math.max(1e-4, voxelSize);

  const cellCounts = new Map();
  const wxArr = new Int32Array(n);
  const wyArr = new Int32Array(n);
  const wzArr = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    if (flags[i] & (FLAG_DELETED | FLAG_HIDDEN)) continue;
    const j = i * 3;
    const lx = pos[j], ly = pos[j + 1], lz = pos[j + 2];
    const m = mats[oids[i]]?.elements;
    const wx = m ? m[0] * lx + m[4] * ly + m[8] * lz + m[12] : lx;
    const wy = m ? m[1] * lx + m[5] * ly + m[9] * lz + m[13] : ly;
    const wz = m ? m[2] * lx + m[6] * ly + m[10] * lz + m[14] : lz;
    const ix = Math.floor(wx * invV);
    const iy = Math.floor(wy * invV);
    const iz = Math.floor(wz * invV);
    wxArr[i] = ix;
    wyArr[i] = iy;
    wzArr[i] = iz;
    const key = packVoxelKey(ix, iy, iz);
    cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
  }

  const maxAlphaU8 = maxOpacity * 255;
  const hitFn = (i) => {
    if (rgba[i * 4 + 3] > maxAlphaU8) return false;
    const ix = wxArr[i], iy = wyArr[i], iz = wzArr[i];
    let neighbors = -1; // exclude self
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = cellCounts.get(packVoxelKey(ix + dx, iy + dy, iz + dz));
          if (c) {
            neighbors += c;
            if (neighbors > maxNeighbors) return false;
          }
        }
      }
    }
    return neighbors <= maxNeighbors;
  };

  return applyBooleanSelection(cloud, op, hitFn, scopeByIndex, activeObjectIds);
}

// ============================================================================
// Special Selection 5: Lazy-Loaded Local SAM 2 ONNX (WebGPU/WASM)
// + Built-In 2D Bilateral Edge-Aware Flood + 3D Spatial-Graph + Ground-Leak Suppression
// ============================================================================

// Exact ReSplat SAM2 encoder patch (sam2-model.ts): removes invalid empty-shape ValueInfoProto
// records so ONNX Runtime Web accepts vietanhdev/segment-anything-2-onnx-models cleanly.
function patchSam2EncoderForOrtWeb(bytes) {
  const names = ["/conv_s0/Conv_output_0", "/conv_s1/Conv_output_0"];
  const suffix = new Uint8Array([0x12, 0x06, 0x0a, 0x04, 0x08, 0x01, 0x12, 0x00]);
  const enc = new TextEncoder();
  const tailStart = Math.max(0, bytes.length - 1024 * 1024);

  const matchAt = (arr, off) => {
    if (off < 0 || off + arr.length > bytes.length) return false;
    for (let i = 0; i < arr.length; i++) if (bytes[off + i] !== arr[i]) return false;
    return true;
  };

  for (const nameStr of names) {
    const nameBytes = enc.encode(nameStr);
    for (let off = bytes.length - nameBytes.length - suffix.length; off >= tailStart; off--) {
      if (!matchAt(nameBytes, off)) continue;
      const sOff = off + nameBytes.length;
      if (!matchAt(suffix, sOff)) continue;
      bytes[sOff + suffix.length - 2] = 0x7a;
      break;
    }
  }
  return bytes;
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

function prepareSam2Tensor1024(rgba, srcW, srcH) {
  const S = 1024;
  const tensor = new Float32Array(3 * S * S);
  const planeSize = S * S;
  const scaleX = srcW / S;
  const scaleY = srcH / S;
  for (let y = 0; y < S; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y * scaleY));
    // WebGL readPixels is bottom-up, flip vertically to top-down
    const webglRow = (srcH - 1 - sy) * srcW;
    for (let x = 0; x < S; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x * scaleX));
      const p = (webglRow + sx) * 4;
      const dst = y * S + x;
      tensor[dst] = (rgba[p] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
      tensor[planeSize + dst] = (rgba[p + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
      tensor[2 * planeSize + dst] = (rgba[p + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    }
  }
  return tensor;
}

export class SemanticSelectionEngine {
  constructor() {
    this.loaded = false;
    this.engineKind = "unloaded"; // "unloaded" | "sam2-webgpu" | "sam2-wasm" | "builtin-3d"
    this.sam2Config = null;
    this._ort = null;
    this._encoder = null;
    this._decoder = null;
    this._embedding = null;
    this._embeddingKey = "";
    this.prompts = []; // [{ nx, ny, worldPos: Vector3, rgb: [r,g,b], pointIdx, label: 1 | 0 }]
  }

  configureSam2(cfg) {
    this.sam2Config = cfg || null;
  }

  getStatusLabel() {
    if (!this.loaded) return t("editor.semantic.legacyUnloaded");
    if (this.engineKind === "sam2-webgpu") return t("editor.semantic.legacyWebgpu");
    if (this.engineKind === "sam2-wasm") return t("editor.semantic.legacyWasm");
    return t("editor.semantic.legacyBuiltin");
  }

  /**
   * Lazy load ONLY when user activates Semantic Selection tool!
   */
  async ensureLoaded(onProgress = null) {
    if (this.loaded) return this.engineKind;
    const cfg = this.sam2Config;

    if (cfg && cfg.available && cfg.ortUrl && cfg.encoderUrl && cfg.decoderUrl) {
      try {
        if (onProgress) onProgress(t("editor.semantic.legacyLoading"));
        const ort = await import(/* @vite-ignore */ cfg.ortUrl);
        if (ort?.env?.wasm) {
          ort.env.wasm.wasmPaths = cfg.wasmBaseUrl;
          ort.env.wasm.numThreads = 1;
        }
        const [encRes, decRes] = await Promise.all([
          fetch(cfg.encoderUrl),
          fetch(cfg.decoderUrl),
        ]);
        if (!encRes.ok || !decRes.ok) throw new Error(t("editor.semantic.legacyReadFailed"));
        const encBytes = patchSam2EncoderForOrtWeb(new Uint8Array(await encRes.arrayBuffer()));
        const decBytes = new Uint8Array(await decRes.arrayBuffer());

        const tryBackend = async (ep) => {
          const opts = { executionProviders: [ep], graphOptimizationLevel: "all" };
          const encoder = await ort.InferenceSession.create(encBytes, opts);
          try {
            const decoder = await ort.InferenceSession.create(decBytes, opts);
            return { encoder, decoder };
          } catch (err) {
            await encoder.release();
            throw err;
          }
        };

        let sessions = null;
        let usedKind = "sam2-wasm";
        if ("gpu" in navigator) {
          try {
            sessions = await tryBackend("webgpu");
            usedKind = "sam2-webgpu";
          } catch {
            sessions = null;
          }
        }
        if (!sessions) {
          sessions = await tryBackend("wasm");
          usedKind = "sam2-wasm";
        }
        this._ort = ort;
        this._encoder = sessions.encoder;
        this._decoder = sessions.decoder;
        this.engineKind = usedKind;
        this.loaded = true;
        return this.engineKind;
      } catch (err) {
        console.warn("[Semantic] Local SAM2 init fell back to built-in 3D engine:", err);
        await this.release();
      }
    }

    this.engineKind = "builtin-3d";
    this.loaded = true;
    return this.engineKind;
  }

  /**
   * Immediate VRAM release when exiting Semantic Selection tool or clicking manual unload!
   */
  async release() {
    this.prompts.length = 0;
    this._embeddingKey = "";
    if (this._embedding) {
      for (const t of Object.values(this._embedding)) {
        try { t.dispose(); } catch { }
      }
      this._embedding = null;
    }
    const rels = [];
    if (this._encoder) rels.push(this._encoder.release());
    if (this._decoder) rels.push(this._decoder.release());
    this._encoder = null;
    this._decoder = null;
    if (rels.length > 0) await Promise.allSettled(rels);
    this.loaded = false;
    this.engineKind = "unloaded";
  }

  clearPrompts() {
    this.prompts.length = 0;
  }

  addPrompt({ nx, ny, worldPos, rgb, pointIdx, label = 1 }) {
    this.prompts.push({
      nx,
      ny,
      worldPos: worldPos.clone(),
      rgb: [...rgb],
      pointIdx,
      label: label ? 1 : 0,
    });
  }

  /**
   * Run 2D SAM2 ONNX mask prediction (returns Uint8Array(pw * ph) binary mask at pick resolution).
   */
  async _runSam2Mask(glRgba, glW, glH, pw, ph) {
    const ort = this._ort;
    // Hash sampled pixels for embedding cache key
    let h = 2166136261;
    const step = Math.max(4, Math.floor(glRgba.length / 4096)) * 4;
    for (let i = 0; i < glRgba.length; i += step) {
      h = Math.imul(h ^ glRgba[i], 16777619) >>> 0;
    }
    const key = `${glW}x${glH}:${h}`;
    if (!this._embedding || this._embeddingKey !== key) {
      if (this._embedding) {
        for (const t of Object.values(this._embedding)) { try { t.dispose(); } catch { } }
        this._embedding = null;
      }
      const tensorData = prepareSam2Tensor1024(glRgba, glW, glH);
      const imgTensor = new ort.Tensor("float32", tensorData, [1, 3, 1024, 1024]);
      try {
        this._embedding = await this._encoder.run({ [this._encoder.inputNames[0]]: imgTensor });
        this._embeddingKey = key;
      } finally {
        imgTensor.dispose();
      }
    }

    const ptCount = this.prompts.length;
    const coords = new Float32Array(ptCount * 2);
    const labels = new Float32Array(ptCount);
    for (let i = 0; i < ptCount; i++) {
      coords[i * 2] = this.prompts[i].nx * 1024;
      coords[i * 2 + 1] = this.prompts[i].ny * 1024;
      labels[i] = this.prompts[i].label;
    }

    const feeds = {};
    const temps = [];
    const findEmb = (name) => {
      if (this._embedding[name]) return this._embedding[name];
      if (name === "image_embed" && this._embedding.image_embeddings) return this._embedding.image_embeddings;
      if (name === "image_embeddings" && this._embedding.image_embed) return this._embedding.image_embed;
      return null;
    };
    for (const name of this._decoder.inputNames) {
      const emb = findEmb(name);
      if (emb) feeds[name] = emb;
      else if (name === "point_coords") {
        feeds[name] = new ort.Tensor("float32", coords, [1, ptCount, 2]);
        temps.push(feeds[name]);
      } else if (name === "point_labels") {
        feeds[name] = new ort.Tensor("float32", labels, [1, ptCount]);
        temps.push(feeds[name]);
      } else if (name === "mask_input") {
        feeds[name] = new ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]);
        temps.push(feeds[name]);
      } else if (name === "has_mask_input") {
        feeds[name] = new ort.Tensor("float32", new Float32Array([0]), [1]);
        temps.push(feeds[name]);
      } else if (name === "orig_im_size" || name === "img_size") {
        feeds[name] = new ort.Tensor("float32", new Float32Array([1024, 1024]), [2]);
        temps.push(feeds[name]);
      }
    }

    let out;
    try {
      out = await this._decoder.run(feeds);
    } finally {
      for (const t of temps) t.dispose();
    }

    // Pick best mask by IoU prediction
    const masksT = out.masks || out[this._decoder.outputNames[0]];
    const iouT = out.iou_predictions || out[this._decoder.outputNames[1]];
    const dims = masksT.dims; // [1, numMasks, H, W]
    const numMasks = dims[1] || 1;
    const mh = dims[2] || 256;
    const mw = dims[3] || 256;
    let bestM = 0;
    if (iouT && iouT.data) {
      let bestIou = -Infinity;
      for (let m = 0; m < numMasks; m++) {
        if (iouT.data[m] > bestIou) { bestIou = iouT.data[m]; bestM = m; }
      }
    }
    const maskData = masksT.data;
    const mOffset = bestM * mh * mw;
    const outMask = new Uint8Array(pw * ph);
    for (let y = 0; y < ph; y++) {
      // outMask uses WebGL bottom-up row index y matching pickPixels!
      const topDownY = ph - 1 - y;
      const my = Math.min(mh - 1, Math.floor((topDownY / ph) * mh));
      for (let x = 0; x < pw; x++) {
        const mx = Math.min(mw - 1, Math.floor((x / pw) * mw));
        if (maskData[mOffset + my * mw + mx] > 0) outMask[y * pw + x] = 1;
      }
    }
    for (const t of Object.values(out)) { try { t.dispose(); } catch { } }
    return outMask;
  }

  /**
   * Built-in 2D bilateral edge-aware flood fill at pick resolution (instant offline fallback).
   */
  _runBuiltin2DMask(glRgba, glW, glH, pw, ph, similarity) {
    const mask = new Uint8Array(pw * ph);
    const visited = new Uint8Array(pw * ph);
    // Color distance threshold inversely proportional to similarity [0.1..0.95]
    const colorThresh = Math.max(14, (1.05 - similarity) * 145);
    const edgeThresh = colorThresh * 0.65;

    const sampleRgb = (px, py) => {
      const gx = Math.min(glW - 1, Math.floor((px / pw) * glW));
      const gy = Math.min(glH - 1, Math.floor((py / ph) * glH));
      const off = (gy * glW + gx) * 4;
      return [glRgba[off], glRgba[off + 1], glRgba[off + 2]];
    };

    // Block radius around negative prompts
    const negPx = this.prompts
      .filter((p) => p.label === 0)
      .map((p) => [Math.round(p.nx * (pw - 1)), Math.round((1 - p.ny) * (ph - 1))]);

    const queue = new Int32Array(pw * ph);
    for (const pr of this.prompts) {
      if (pr.label !== 1) continue;
      const sx = Math.min(pw - 1, Math.max(0, Math.round(pr.nx * (pw - 1))));
      const sy = Math.min(ph - 1, Math.max(0, Math.round((1 - pr.ny) * (ph - 1))));
      const seedRgb = sampleRgb(sx, sy);
      let head = 0, tail = 0;
      const startIdx = sy * pw + sx;
      if (visited[startIdx]) continue;
      visited[startIdx] = 1;
      mask[startIdx] = 1;
      queue[tail++] = startIdx;

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % pw;
        const cy = (cur - cx) / pw;
        const curRgb = sampleRgb(cx, cy);

        const neighbors = [
          cx > 0 ? cur - 1 : -1,
          cx + 1 < pw ? cur + 1 : -1,
          cy > 0 ? cur - pw : -1,
          cy + 1 < ph ? cur + pw : -1,
        ];
        for (const nb of neighbors) {
          if (nb < 0 || visited[nb]) continue;
          const nx = nb % pw;
          const ny = (nb - nx) / pw;
          let nearNeg = false;
          for (const np of negPx) {
            if ((nx - np[0]) ** 2 + (ny - np[1]) ** 2 <= 64) { nearNeg = true; break; }
          }
          if (nearNeg) continue;
          const nbRgb = sampleRgb(nx, ny);
          const dSeed = Math.hypot(nbRgb[0] - seedRgb[0], nbRgb[1] - seedRgb[1], nbRgb[2] - seedRgb[2]);
          const dEdge = Math.hypot(nbRgb[0] - curRgb[0], nbRgb[1] - curRgb[1], nbRgb[2] - curRgb[2]);
          if (dSeed <= colorThresh && dEdge <= edgeThresh) {
            visited[nb] = 1;
            mask[nb] = 1;
            queue[tail++] = nb;
          }
        }
      }
    }
    return mask;
  }

  /**
   * 3D Anchor-Connected Spatial Graph BFS + Shortest-Axis Ground-Plane Leak Suppression (ReSplat methodology).
   */
  _expand3DSpatialGraph(cloud, seedHits, similarity, maxRadius, suppressGround, activeObjectIds) {
    const posSeeds = this.prompts.filter((p) => p.label === 1);
    const negSeeds = this.prompts.filter((p) => p.label === 0);
    if (posSeeds.length === 0) return seedHits;

    const n = cloud.n;
    const flags = cloud.flags;
    const rgba = cloud.rgba;
    const scaleHalf = cloud.scaleHalf;

    // Estimate median Gaussian scale near seeds to set adaptive spatial hash cell size
    const seedScales = [];
    for (let i = 0; i < n; i++) {
      if (seedHits[i]) {
        const i4 = i * 4;
        const avgLog = (HALF_TO_FLOAT[scaleHalf[i4]] + HALF_TO_FLOAT[scaleHalf[i4 + 1]] + HALF_TO_FLOAT[scaleHalf[i4 + 2]]) / 3;
        seedScales.push(Math.exp(Math.max(-12, Math.min(4, avgLog))));
        if (seedScales.length >= 256) break;
      }
    }
    seedScales.sort((a, b) => a - b);
    const medianScale = seedScales.length ? seedScales[seedScales.length >> 1] : 0.03;
    const cellSize = Math.max(0.02, Math.min(maxRadius * 0.25, medianScale * 5.5));
    const invCell = 1 / cellSize;

    // Bounding box around positive seeds padded by maxRadius
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const s of posSeeds) {
      minX = Math.min(minX, s.worldPos.x - maxRadius);
      minY = Math.min(minY, s.worldPos.y - maxRadius);
      minZ = Math.min(minZ, s.worldPos.z - maxRadius);
      maxX = Math.max(maxX, s.worldPos.x + maxRadius);
      maxY = Math.max(maxY, s.worldPos.y + maxRadius);
      maxZ = Math.max(maxZ, s.worldPos.z + maxRadius);
    }

    // Hash eligible Gaussians inside padded AABB into uniform 3D spatial grid
    const grid = new Map();
    const worldX = new Float32Array(n);
    const worldY = new Float32Array(n);
    const worldZ = new Float32Array(n);
    const inAabb = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      if (flags[i] & (FLAG_DELETED | FLAG_HIDDEN)) continue;
      if (activeObjectIds && activeObjectIds.size > 0 && !activeObjectIds.has(cloud.objectIds[i])) continue;
      cloud.getWorldPosition(i, VEC_TMP);
      if (VEC_TMP.x < minX || VEC_TMP.x > maxX || VEC_TMP.y < minY || VEC_TMP.y > maxY || VEC_TMP.z < minZ || VEC_TMP.z > maxZ) {
        continue;
      }
      worldX[i] = VEC_TMP.x;
      worldY[i] = VEC_TMP.y;
      worldZ[i] = VEC_TMP.z;
      inAabb[i] = 1;
      const key = packVoxelKey(Math.floor(VEC_TMP.x * invCell), Math.floor(VEC_TMP.y * invCell), Math.floor(VEC_TMP.z * invCell));
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push(i);
    }

    // BFS from initial 2D-mask-lifted seeds + explicit click anchors
    const result = new Uint8Array(seedHits);
    const queue = [];
    for (let i = 0; i < n; i++) {
      if (result[i] && inAabb[i]) queue.push(i);
    }
    for (const s of posSeeds) {
      if (s.pointIdx >= 0 && s.pointIdx < n && !result[s.pointIdx]) {
        result[s.pointIdx] = 1;
        if (inAabb[s.pointIdx]) queue.push(s.pointIdx);
      }
    }

    const colorMaxSq255 = Math.pow(Math.max(0.08, (1.05 - similarity) * 0.72) * 255, 2);
    const distMaxSq = (cellSize * 1.45) * (cellSize * 1.45);
    const negRadSq = (maxRadius * 0.28) * (maxRadius * 0.28);
    const maxTotal = Math.min(n, Math.max(8000, queue.length * 8));

    let head = 0;
    let totalAccepted = queue.length;
    while (head < queue.length && totalAccepted < maxTotal) {
      const u = queue[head++];
      const ux = worldX[u], uy = worldY[u], uz = worldZ[u];
      const u4 = u * 4;
      const ur = rgba[u4], ug = rgba[u4 + 1], ub = rgba[u4 + 2];
      const ix = Math.floor(ux * invCell), iy = Math.floor(uy * invCell), iz = Math.floor(uz * invCell);

      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = grid.get(packVoxelKey(ix + dx, iy + dy, iz + dz));
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const v = bucket[b];
              if (result[v]) continue;
              const d2 = (worldX[v] - ux) ** 2 + (worldY[v] - uy) ** 2 + (worldZ[v] - uz) ** 2;
              if (d2 > distMaxSq) continue;
              const v4 = v * 4;
              const dr = rgba[v4] - ur, dg = rgba[v4 + 1] - ug, db = rgba[v4 + 2] - ub;
              if (dr * dr + dg * dg + db * db > colorMaxSq255) continue;

              // Check negative exclusion seeds
              let blocked = false;
              for (const ns of negSeeds) {
                const nd2 = (worldX[v] - ns.worldPos.x) ** 2 + (worldY[v] - ns.worldPos.y) ** 2 + (worldZ[v] - ns.worldPos.z) ** 2;
                if (nd2 <= negRadSq) { blocked = true; break; }
              }
              if (blocked) continue;

              result[v] = 1;
              queue.push(v);
              totalAccepted++;
              if (totalAccepted >= maxTotal) break;
            }
          }
        }
      }
    }

    // Optional ground-plane leak suppression (remove flat horizontal floor points at the bottom Z envelope)
    if (suppressGround && totalAccepted > 64) {
      const seedMinZ = Math.min(...posSeeds.map((s) => s.worldPos.z));
      const zVals = [];
      for (let i = 0; i < n; i++) {
        if (result[i] && inAabb[i]) zVals.push(worldZ[i]);
      }
      zVals.sort((a, b) => a - b);
      const zFloor = zVals[Math.floor(zVals.length * 0.04)];
      if (seedMinZ - zFloor > cellSize * 1.5) {
        const zCut = zFloor + Math.max(medianScale * 2.5, cellSize * 0.5);
        for (let i = 0; i < n; i++) {
          if (result[i] && inAabb[i] && worldZ[i] <= zCut && !seedHits[i]) {
            result[i] = 0;
          }
        }
      }
    }

    return result;
  }

  /**
   * Execute semantic selection!
   */
  async run({
    cloud,
    renderer,
    camera,
    viewportW,
    viewportH,
    displayMode,
    op = "replace",
    similarity = 0.65,
    maxRadius = 1.2,
    mode3D = true,
    suppressGround = true,
    worldScopeFn = null,
    activeObjectIds = null,
  }) {
    await this.ensureLoaded();
    const posSeeds = this.prompts.filter((p) => p.label === 1);
    if (posSeeds.length === 0) return null;

    const scopeByIndex = makeScopeByIndex(cloud, worldScopeFn);
    const scale = Math.min(1, 512 / Math.max(viewportW, viewportH, 1));
    const pw = Math.max(64, Math.round(viewportW * scale));
    const ph = Math.max(64, Math.round(viewportH * scale));

    // 1. Capture live rendered RGBA + GPU ID Pick Buffer
    const gl = renderer.getContext();
    const glW = gl.drawingBufferWidth;
    const glH = gl.drawingBufferHeight;
    const glRgba = new Uint8Array(glW * glH * 4);
    gl.readPixels(0, 0, glW, glH, gl.RGBA, gl.UNSIGNED_BYTE, glRgba);

    const { pixels: pickPixels } = cloud.renderPickBuffer(
      renderer,
      camera,
      pw,
      ph,
      displayMode === "points" ? "rings" : displayMode,
      0.04,
    );

    // 2. Obtain 2D mask (Local SAM 2 ONNX if loaded, else built-in bilateral edge-aware flood!)
    let mask2D;
    if (this._encoder && this._decoder) {
      mask2D = await this._runSam2Mask(glRgba, glW, glH, pw, ph);
    } else {
      mask2D = this._runBuiltin2DMask(glRgba, glW, glH, pw, ph, similarity);
    }

    // 3. Lift 2D mask to visible 3D Gaussians via ID buffer
    const hitMask = new Uint8Array(cloud.n);
    for (let i = 0; i < pw * ph; i++) {
      if (!mask2D[i]) continue;
      const off = i * 4;
      const id1 = decodePickId(pickPixels, off);
      if (id1 > 0 && id1 - 1 < cloud.n) hitMask[id1 - 1] = 1;
    }
    for (const p of posSeeds) {
      if (p.pointIdx >= 0 && p.pointIdx < cloud.n) hitMask[p.pointIdx] = 1;
    }

    // 4. In 3D mode, expand cleanly into 3D interior & backface via spatial connectivity graph + ground suppression!
    const finalMask = mode3D
      ? this._expand3DSpatialGraph(cloud, hitMask, similarity, maxRadius, suppressGround, activeObjectIds)
      : hitMask;

    return applyBooleanSelection(cloud, op, (i) => finalMask[i] === 1, scopeByIndex, activeObjectIds);
  }
}
