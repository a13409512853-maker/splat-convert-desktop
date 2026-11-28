/**
 * @module measure/geometry-engine
 * @description Pure 3DGS measurement mathematics:
 * - Non-destructive global scale factor & m/cm/mm formatting (length / area / volume)
 * - Progressive metrics: 2-point distance (straight, horizontal, ΔH, slope), >=3-point polyline
 * - PCA best-fit plane & reference base plane builders (fit / lowest / horizontal / 3-point)
 * - 2.5D height-field grid integration for Area Mode (projected, surface, fitted plane, perimeter)
 *   and Stockpile Volume Mode (volume, max height, mean height, anti-floater peak detection)
 * - One-Click Smart Edge Snapping (resample + local height/normal/density edge attraction + smoothing)
 * - Soft-selection rubber-band vertex dragging for dense snapped polygons
 */
import * as T from "three";
import { FLAG_DELETED, FLAG_HIDDEN } from "../cloud.js";

const Y_UP = new T.Vector3(0, 1, 0);

export const UNIT_CONFIG = Object.freeze({
  m:  { label: "m",  mul: 1,    areaLabel: "m²",  areaMul: 1,    volLabel: "m³",  volMul: 1,    lenDec: 3, areaDec: 3, volDec: 3 },
  cm: { label: "cm", mul: 100,  areaLabel: "cm²", areaMul: 1e4,  volLabel: "cm³", volMul: 1e6,  lenDec: 2, areaDec: 1, volDec: 1 },
  mm: { label: "mm", mul: 1000, areaLabel: "mm²", areaMul: 1e6,  volLabel: "mm³", volMul: 1e9,  lenDec: 1, areaDec: 0, volDec: 0 },
});

export function formatLength(rawLen, globalScale = 1, unit = "m") {
  const u = UNIT_CONFIG[unit] || UNIT_CONFIG.m;
  const v = rawLen * globalScale * u.mul;
  return `${v.toFixed(u.lenDec)} ${u.label}`;
}

export function formatArea(rawArea, globalScale = 1, unit = "m") {
  const u = UNIT_CONFIG[unit] || UNIT_CONFIG.m;
  const v = rawArea * globalScale * globalScale * u.areaMul;
  return `${v.toFixed(u.areaDec)} ${u.areaLabel}`;
}

export function formatVolume(rawVol, globalScale = 1, unit = "m") {
  const u = UNIT_CONFIG[unit] || UNIT_CONFIG.m;
  const v = rawVol * globalScale * globalScale * globalScale * u.volMul;
  return `${v.toFixed(u.volDec)} ${u.volLabel}`;
}

export function computeTwoPointMetrics(p0, p1) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;
  const straight = Math.hypot(dx, dy, dz);
  const horiz = Math.hypot(dx, dz);
  const deltaH = dy;
  const slopeRad = Math.atan2(Math.abs(deltaH), Math.max(1e-6, horiz));
  const slopeDeg = (slopeRad * 180) / Math.PI;
  const slopePct = horiz > 1e-5 ? (Math.abs(deltaH) / horiz) * 100 : Infinity;
  return { straight, horiz, deltaH, slopeDeg, slopePct, dx, dy, dz };
}

export function computePolylineMetrics(points, closed = false) {
  const segments = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = points[i - 1].distanceTo(points[i]);
    segments.push(d);
    total += d;
  }
  if (closed && points.length >= 3) {
    const d = points[points.length - 1].distanceTo(points[0]);
    segments.push(d);
    total += d;
  }
  return { segments, total };
}

function pointInPoly2D(px, py, poly) {
  let wn = 0;
  const len = poly.length;
  for (let i = 0, j = len - 1; i < len; j = i++) {
    const x1 = poly[j][0], y1 = poly[j][1];
    const x2 = poly[i][0], y2 = poly[i][1];
    if (y1 <= py) {
      if (y2 > py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) > 0) wn++;
    } else {
      if (y2 <= py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) < 0) wn--;
    }
  }
  return wn !== 0;
}

function shoelaceArea2D(poly2d) {
  let sum = 0;
  for (let i = 0, j = poly2d.length - 1; i < poly2d.length; j = i++) {
    sum += poly2d[j][0] * poly2d[i][1] - poly2d[i][0] * poly2d[j][1];
  }
  return Math.abs(sum) * 0.5;
}

export function buildOrthonormalBasis(normal) {
  const n = normal.clone().normalize();
  const ref = Math.abs(n.y) < 0.9 ? Y_UP : new T.Vector3(1, 0, 0);
  const u = new T.Vector3().crossVectors(ref, n).normalize();
  const v = new T.Vector3().crossVectors(n, u).normalize();
  return { normal: n, u, v };
}

/**
 * Fit best plane to 3D points via Jacobi 3x3 covariance PCA.
 * Guarantees normal oriented toward +Y (when not vertical).
 */
export function fitPlaneFromPoints(pts) {
  if (!pts || pts.length < 3) {
    return { origin: new T.Vector3(), ...buildOrthonormalBasis(Y_UP) };
  }
  let mx = 0, my = 0, mz = 0;
  for (const p of pts) { mx += p.x; my += p.y; mz += p.z; }
  const inv = 1 / pts.length;
  mx *= inv; my *= inv; mz *= inv;

  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my, dz = p.z - mz;
    c00 += dx * dx; c01 += dx * dy; c02 += dx * dz;
    c11 += dy * dy; c12 += dy * dz; c22 += dz * dz;
  }

  const A = [[c00, c01, c02], [c01, c11, c12], [c02, c12, c22]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iter = 0; iter < 16; iter++) {
    let p = 0, q = 1, maxOff = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > maxOff) { p = 0; q = 2; maxOff = Math.abs(A[0][2]); }
    if (Math.abs(A[1][2]) > maxOff) { p = 1; q = 2; maxOff = Math.abs(A[1][2]); }
    if (maxOff < 1e-11) break;
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
  const nrm = new T.Vector3(V[0][minIdx], V[1][minIdx], V[2][minIdx]).normalize();
  if (nrm.y < -1e-4) nrm.negate();
  return {
    origin: new T.Vector3(mx, my, mz),
    ...buildOrthonormalBasis(nrm),
  };
}

/**
 * Construct reference base plane according to mode:
 * - "fit" (default): PCA best-fit through boundary vertices
 * - "lowest": horizontal (+Y) plane at lowest boundary Y
 * - "horizontal": horizontal (+Y) plane at mean boundary Y
 * - "threePoint": exact plane through 3 user-picked points
 */
export function buildBasePlane(boundaryPts, mode = "fit", heightOffset = 0, threePts = null) {
  let base;
  if (mode === "threePoint" && Array.isArray(threePts) && threePts.length === 3) {
    const e1 = new T.Vector3().subVectors(threePts[1], threePts[0]);
    const e2 = new T.Vector3().subVectors(threePts[2], threePts[0]);
    const nrm = new T.Vector3().crossVectors(e1, e2);
    if (nrm.lengthSq() > 1e-10) {
      nrm.normalize();
      if (nrm.y < -1e-4) nrm.negate();
      const orig = new T.Vector3().add(threePts[0]).add(threePts[1]).add(threePts[2]).divideScalar(3);
      base = { origin: orig, ...buildOrthonormalBasis(nrm) };
    }
  }
  if (!base) {
    if (mode === "lowest" || mode === "horizontal") {
      let mx = 0, my = 0, mz = 0, minY = Infinity;
      for (const p of boundaryPts) {
        mx += p.x; my += p.y; mz += p.z;
        if (p.y < minY) minY = p.y;
      }
      const inv = 1 / Math.max(1, boundaryPts.length);
      base = {
        origin: new T.Vector3(mx * inv, mode === "lowest" ? minY : my * inv, mz * inv),
        ...buildOrthonormalBasis(Y_UP),
      };
    } else {
      base = fitPlaneFromPoints(boundaryPts);
    }
  }

  // Apply manual vertical shift along base plane normal
  if (Math.abs(heightOffset) > 1e-7) {
    base.origin.addScaledVector(base.normal, heightOffset);
  }
  return base;
}

/**
 * Compute full Area Mode & Stockpile Volume Mode measurements via 2.5D grid height integration.
 */
export function computePolygonAreaAndVolume(cloud, boundaryPts, {
  basePlaneMode = "fit",
  baseHeightOffset = 0,
  customBasePts = null,
  noiseFilter = true,
  manualPeakWorld = null,
  gridRes = 44,
} = {}) {
  const nVerts = boundaryPts.length;
  if (!cloud || nVerts < 3) return null;

  const { total: perimeter } = computePolylineMetrics(boundaryPts, true);
  const projectedPolyXZ = boundaryPts.map((p) => [p.x, p.z]);
  const projectedArea = shoelaceArea2D(projectedPolyXZ);

  const fittedPlane = fitPlaneFromPoints(boundaryPts);
  const fittedPoly2D = boundaryPts.map((p) => {
    const d = p.clone().sub(fittedPlane.origin);
    return [d.dot(fittedPlane.u), d.dot(fittedPlane.v)];
  });
  const fittedPlaneArea = shoelaceArea2D(fittedPoly2D);

  const basePlane = buildBasePlane(boundaryPts, basePlaneMode, baseHeightOffset, customBasePts);
  const { origin, normal, u, v } = basePlane;

  // Project boundary vertices onto basePlane (u, v) frame
  const polyUV = [];
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of boundaryPts) {
    const dx = p.x - origin.x, dy = p.y - origin.y, dz = p.z - origin.z;
    const pu = dx * u.x + dy * u.y + dz * u.z;
    const pv = dx * v.x + dy * v.y + dz * v.z;
    polyUV.push([pu, pv]);
    if (pu < minU) minU = pu;
    if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv;
    if (pv > maxV) maxV = pv;
  }

  const spanU = Math.max(1e-4, maxU - minU);
  const spanV = Math.max(1e-4, maxV - minV);
  const maxSpan = Math.max(spanU, spanV);

  const nx = Math.max(14, Math.min(gridRes, Math.round((spanU / maxSpan) * gridRes)));
  const ny = Math.max(14, Math.min(gridRes, Math.round((spanV / maxSpan) * gridRes)));
  const cellW = spanU / nx;
  const cellH = spanV / ny;
  const cellArea = cellW * cellH;
  const totalCells = nx * ny;

  // Precompute which grid cells lie inside the closed polygon
  const insideMask = new Uint8Array(totalCells);
  for (let iy = 0; iy < ny; iy++) {
    const cv = minV + (iy + 0.5) * cellH;
    for (let ix = 0; ix < nx; ix++) {
      const cu = minU + (ix + 0.5) * cellW;
      if (pointInPoly2D(cu, cv, polyUV)) insideMask[iy * nx + ix] = 1;
    }
  }

  // Bucket real solid cloud points inside polygon prism into 2.5D grid cells
  const cellBuckets = new Array(totalCells);
  const n = cloud.n;
  const flags = cloud.flags;
  const pos = cloud.pos;
  const rgba = cloud.rgba;
  const oids = cloud.objectIds;
  const vis = cloud.objectVisibility;
  const mats = cloud.objectMatrices;

  const alphaCutoff = noiseFilter ? 96 : 24; // ~0.38 opacity when anti-floater ON vs ~0.09 OFF
  const stride = n > 1200000 ? Math.max(1, Math.floor(n / 600000)) : 1;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const ux = u.x, uy = u.y, uz = u.z;
  const vx = v.x, vy = v.y, vz = v.z;
  const nxv = normal.x, nyv = normal.y, nzv = normal.z;
  const maxAllowedH = maxSpan * 3.0;
  const minAllowedH = -maxSpan * 0.5;

  let insidePointCount = 0;
  for (let i = 0; i < n; i += stride) {
    if (flags[i] & (FLAG_DELETED | FLAG_HIDDEN)) continue;
    if (rgba && rgba[i * 4 + 3] < alphaCutoff) continue;
    const oid = oids[i];
    if (vis.get(oid) === false) continue;

    const j = i * 3;
    const lx = pos[j], ly = pos[j + 1], lz = pos[j + 2];
    const m = mats[oid]?.elements;
    let wx = lx, wy = ly, wz = lz;
    if (m) {
      wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
      wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    }
    const dx = wx - ox, dy = wy - oy, dz = wz - oz;
    const pu = dx * ux + dy * uy + dz * uz;
    if (pu < minU || pu > maxU) continue;
    const pv = dx * vx + dy * vy + dz * vz;
    if (pv < minV || pv > maxV) continue;

    const ix = Math.min(nx - 1, Math.max(0, Math.floor((pu - minU) / cellW)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((pv - minV) / cellH)));
    const cIdx = iy * nx + ix;
    if (!insideMask[cIdx]) continue;

    const ph = dx * nxv + dy * nyv + dz * nzv;
    if (ph < minAllowedH || ph > maxAllowedH) continue;

    let b = cellBuckets[cIdx];
    if (!b) {
      b = [];
      cellBuckets[cIdx] = b;
    }
    if (b.length < 48) b.push(ph);
    insidePointCount++;
  }

  // Resolve robust cell surface elevation h[cIdx]
  const heights = new Float32Array(totalCells);
  const validCell = new Uint8Array(totalCells);
  const minCellPts = noiseFilter ? 2 : 1;

  for (let cIdx = 0; cIdx < totalCells; cIdx++) {
    if (!insideMask[cIdx]) continue;
    const b = cellBuckets[cIdx];
    if (!b || b.length < minCellPts) continue;
    b.sort((a, c) => a - c);
    // Robust upper surface estimate: P78 when noiseFilter ON (rejects floaters above pile), P95 when OFF
    const qIdx = Math.min(b.length - 1, Math.floor(b.length * (noiseFilter ? 0.78 : 0.95)));
    heights[cIdx] = b[qIdx];
    validCell[cIdx] = 1;
  }

  // Smoothly fill small unpopulated interior cells via neighbor averaging (up to 4 passes)
  for (let pass = 0; pass < 4; pass++) {
    let filledAny = false;
    const nextH = new Float32Array(heights);
    const nextV = new Uint8Array(validCell);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const cIdx = iy * nx + ix;
        if (!insideMask[cIdx] || validCell[cIdx]) continue;
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const nyi = iy + dy;
          if (nyi < 0 || nyi >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nxi = ix + dx;
            if (nxi < 0 || nxi >= nx) continue;
            const ni = nyi * nx + nxi;
            if (validCell[ni]) {
              sum += heights[ni];
              cnt++;
            }
          }
        }
        if (cnt >= 2) {
          nextH[cIdx] = sum / cnt;
          nextV[cIdx] = 1;
          filledAny = true;
        }
      }
    }
    heights.set(nextH);
    validCell.set(nextV);
    if (!filledAny) break;
  }

  // Optional 1-pass gentle median/spike suppression for peak detection when noiseFilter ON
  const peakHeights = new Float32Array(heights);
  if (noiseFilter) {
    for (let iy = 1; iy < ny - 1; iy++) {
      for (let ix = 1; ix < nx - 1; ix++) {
        const cIdx = iy * nx + ix;
        if (!validCell[cIdx]) continue;
        const nVals = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ni = (iy + dy) * nx + (ix + dx);
            if (validCell[ni]) nVals.push(heights[ni]);
          }
        }
        if (nVals.length >= 4) {
          nVals.sort((a, b) => a - b);
          const med = nVals[Math.floor(nVals.length * 0.5)];
          if (heights[cIdx] > med + maxSpan * 0.14) {
            peakHeights[cIdx] = med;
          }
        }
      }
    }
  }

  // Integrate Volume, Mean Height, Max Height, Peak Position & 3D Surface Area
  let volume = 0;
  let posHeightSum = 0;
  let validInsideCount = 0;
  let autoMaxH = 0;
  let peakU = (minU + maxU) * 0.5;
  let peakV = (minV + maxV) * 0.5;

  for (let iy = 0; iy < ny; iy++) {
    const cv = minV + (iy + 0.5) * cellH;
    for (let ix = 0; ix < nx; ix++) {
      const cIdx = iy * nx + ix;
      if (!insideMask[cIdx]) continue;
      const h = validCell[cIdx] ? peakHeights[cIdx] : 0;
      const posH = Math.max(0, h);
      volume += posH * cellArea;
      posHeightSum += posH;
      validInsideCount++;
      if (posH > autoMaxH) {
        autoMaxH = posH;
        peakU = minU + (ix + 0.5) * cellW;
        peakV = cv;
      }
    }
  }

  const meanHeight = validInsideCount > 0 ? posHeightSum / validInsideCount : 0;

  // Compute 3D surface area from height-field triangles & emit wireframe segments for Grid Comparison view!
  let surfaceArea = 0;
  const gridLinePositions = [];
  const toWorld = (cu, cv, ch) => new T.Vector3(
    ox + cu * ux + cv * vx + ch * nxv,
    oy + cu * uy + cv * vy + ch * nyv,
    oz + cu * uz + cv * vz + ch * nzv,
  );
  const pA = new T.Vector3(), pB = new T.Vector3(), pC = new T.Vector3(), pD = new T.Vector3();
  const e1 = new T.Vector3(), e2 = new T.Vector3(), cr = new T.Vector3();

  for (let iy = 0; iy < ny; iy++) {
    const cv0 = minV + (iy + 0.5) * cellH;
    const cv1 = minV + (iy + 1.5) * cellH;
    for (let ix = 0; ix < nx; ix++) {
      const c00 = iy * nx + ix;
      if (!insideMask[c00] || !validCell[c00]) continue;
      const cu0 = minU + (ix + 0.5) * cellW;
      const cu1 = minU + (ix + 1.5) * cellW;
      const h00 = peakHeights[c00];
      pA.set(ox + cu0 * ux + cv0 * vx + h00 * nxv, oy + cu0 * uy + cv0 * vy + h00 * nyv, oz + cu0 * uz + cv0 * vz + h00 * nzv);

      const hasRight = ix + 1 < nx && insideMask[c00 + 1] && validCell[c00 + 1];
      const hasUp = iy + 1 < ny && insideMask[c00 + nx] && validCell[c00 + nx];
      const hasDiag = ix + 1 < nx && iy + 1 < ny && insideMask[c00 + nx + 1] && validCell[c00 + nx + 1];

      if (hasRight) {
        const h10 = peakHeights[c00 + 1];
        pB.set(ox + cu1 * ux + cv0 * vx + h10 * nxv, oy + cu1 * uy + cv0 * vy + h10 * nyv, oz + cu1 * uz + cv0 * vz + h10 * nzv);
        gridLinePositions.push(pA.x, pA.y, pA.z, pB.x, pB.y, pB.z);
      }
      if (hasUp) {
        const h01 = peakHeights[c00 + nx];
        pC.set(ox + cu0 * ux + cv1 * vx + h01 * nxv, oy + cu0 * uy + cv1 * vy + h01 * nyv, oz + cu0 * uz + cv1 * vz + h01 * nzv);
        gridLinePositions.push(pA.x, pA.y, pA.z, pC.x, pC.y, pC.z);
      }
      if (hasRight && hasUp && hasDiag) {
        const h11 = peakHeights[c00 + nx + 1];
        pD.set(ox + cu1 * ux + cv1 * vx + h11 * nxv, oy + cu1 * uy + cv1 * vy + h11 * nyv, oz + cu1 * uz + cv1 * vz + h11 * nzv);
        e1.subVectors(pB, pA); e2.subVectors(pD, pA);
        surfaceArea += cr.crossVectors(e1, e2).length() * 0.5;
        e1.subVectors(pD, pA); e2.subVectors(pC, pA);
        surfaceArea += cr.crossVectors(e1, e2).length() * 0.5;
      }
    }
  }
  if (surfaceArea < fittedPlaneArea * 0.95) {
    surfaceArea = Math.max(surfaceArea, fittedPlaneArea);
  }

  // Resolve peak position (respect manual user pole drag override if set!)
  let peakWorldPos;
  let peakBasePos;
  let maxHeight;
  if (manualPeakWorld) {
    peakWorldPos = manualPeakWorld.clone();
    const dp = peakWorldPos.clone().sub(origin);
    maxHeight = Math.max(0, dp.dot(normal));
    peakBasePos = peakWorldPos.clone().addScaledVector(normal, -maxHeight);
  } else {
    maxHeight = autoMaxH;
    peakWorldPos = toWorld(peakU, peakV, autoMaxH);
    peakBasePos = toWorld(peakU, peakV, 0);
  }

  // Project boundary vertices onto base plane for crisp 3D base plane rendering
  const baseBoundary3D = polyUV.map(([pu, pv]) => toWorld(pu, pv, 0));

  return {
    perimeter,
    projectedArea,
    fittedPlaneArea,
    surfaceArea,
    volume,
    maxHeight,
    meanHeight,
    peakWorldPos,
    peakBasePos,
    basePlane,
    baseBoundary3D,
    polyUV,
    polyBoundsUV: [minU, minV, maxU, maxV],
    gridLinePositions: new Float32Array(gridLinePositions),
    insidePointCount,
  };
}

/**
 * One-Click Smart Edge Snapping:
 * Resamples the coarse closed polygon into smooth dense vertices (up to 40) and attracts each vertex
 * along its local inward/outward perpendicular strip to the strongest geometric edge:
 * - Heap toe slope break (|d²h/dr²|) OR pipe/opening depth discontinuity (|dh/dr| + occupancy edge),
 * followed by gentle curve relaxation and nearest real surface projection!
 */
export function smartSnapPolygonToEdges(cloud, coarsePts, targetVertexCount = 36) {
  if (!cloud || !coarsePts || coarsePts.length < 3) return coarsePts ? coarsePts.map((p) => p.clone()) : [];

  const plane = fitPlaneFromPoints(coarsePts);
  const { origin, normal, u, v } = plane;

  // 1. Uniform arc-length resampling along closed coarse polygon
  const cumLen = [0];
  let totalPerim = 0;
  for (let i = 0; i < coarsePts.length; i++) {
    const a = coarsePts[i];
    const b = coarsePts[(i + 1) % coarsePts.length];
    totalPerim += a.distanceTo(b);
    cumLen.push(totalPerim);
  }
  const N = Math.max(18, Math.min(44, targetVertexCount));
  const resampled = [];
  for (let k = 0; k < N; k++) {
    const targetD = (k / N) * totalPerim;
    let seg = 0;
    while (seg < coarsePts.length - 1 && cumLen[seg + 1] < targetD) seg++;
    const segLen = Math.max(1e-6, cumLen[seg + 1] - cumLen[seg]);
    const t = Math.max(0, Math.min(1, (targetD - cumLen[seg]) / segLen));
    const a = coarsePts[seg];
    const b = coarsePts[(seg + 1) % coarsePts.length];
    resampled.push(new T.Vector3().lerpVectors(a, b, t));
  }

  // Project resampled polygon into plane (u, v) and determine average radius
  const uvPts = resampled.map((p) => {
    const d = p.clone().sub(origin);
    return [d.dot(u), d.dot(v), d.dot(normal)];
  });
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [pu, pv] of uvPts) {
    if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
  }
  const radius = Math.max(0.05, Math.hypot(maxU - minU, maxV - minV) * 0.5);
  const searchHalf = radius * 0.18;
  const pad = searchHalf * 1.4;

  // 2. Collect solid cloud samples in padded local band around polygon
  const sampleU = [];
  const sampleV = [];
  const sampleH = [];
  const n = cloud.n;
  const stride = n > 600000 ? Math.max(1, Math.floor(n / 400000)) : 1;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const ux = u.x, uy = u.y, uz = u.z;
  const vx = v.x, vy = v.y, vz = v.z;
  const nxv = normal.x, nyv = normal.y, nzv = normal.z;

  for (let i = 0; i < n; i += stride) {
    if (cloud.flags[i] & (FLAG_DELETED | FLAG_HIDDEN)) continue;
    if (cloud.rgba && cloud.rgba[i * 4 + 3] < 90) continue;
    const oid = cloud.objectIds[i];
    if (cloud.objectVisibility.get(oid) === false) continue;
    const j = i * 3;
    const lx = cloud.pos[j], ly = cloud.pos[j + 1], lz = cloud.pos[j + 2];
    const m = cloud.objectMatrices[oid]?.elements;
    let wx = lx, wy = ly, wz = lz;
    if (m) {
      wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
      wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    }
    const dx = wx - ox, dy = wy - oy, dz = wz - oz;
    const pu = dx * ux + dy * uy + dz * uz;
    if (pu < minU - pad || pu > maxU + pad) continue;
    const pv = dx * vx + dy * vy + dz * vz;
    if (pv < minV - pad || pv > maxV + pad) continue;
    const ph = dx * nxv + dy * nyv + dz * nzv;
    if (Math.abs(ph) > radius * 2.5) continue;
    sampleU.push(pu);
    sampleV.push(pv);
    sampleH.push(ph);
  }

  if (sampleU.length < 30) {
    return resampled;
  }

  // Build coarse 2D spatial grid for O(1) strip queries
  const gridN = 40;
  const gMinU = minU - pad, gMaxU = maxU + pad;
  const gMinV = minV - pad, gMaxV = maxV + pad;
  const gStepU = (gMaxU - gMinU) / gridN;
  const gStepV = (gMaxV - gMinV) / gridN;
  const gridH = new Float32Array(gridN * gridN);
  const gridCnt = new Uint16Array(gridN * gridN);
  for (let i = 0; i < sampleU.length; i++) {
    const gx = Math.min(gridN - 1, Math.max(0, Math.floor((sampleU[i] - gMinU) / gStepU)));
    const gy = Math.min(gridN - 1, Math.max(0, Math.floor((sampleV[i] - gMinV) / gStepV)));
    const idx = gy * gridN + gx;
    gridH[idx] += sampleH[i];
    gridCnt[idx]++;
  }
  for (let i = 0; i < gridN * gridN; i++) {
    if (gridCnt[i] > 0) gridH[i] /= gridCnt[i];
  }

  const queryGrid = (qu, qv) => {
    const gx = Math.min(gridN - 1, Math.max(0, Math.floor((qu - gMinU) / gStepU)));
    const gy = Math.min(gridN - 1, Math.max(0, Math.floor((qv - gMinV) / gStepV)));
    const idx = gy * gridN + gx;
    return { h: gridH[idx], cnt: gridCnt[idx] };
  };

  // 3. Snap each resampled vertex along its perpendicular normal strip to maximum geometric edge energy
  const snappedUV = uvPts.map((p) => [p[0], p[1], p[2]]);
  const bins = 11;
  for (let k = 0; k < N; k++) {
    const prev = uvPts[(k - 1 + N) % N];
    const cur = uvPts[k];
    const next = uvPts[(k + 1) % N];
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const tl = Math.hypot(tx, ty) || 1;
    // Perpendicular unit vector in (u, v) plane
    const perpU = -ty / tl;
    const perpV = tx / tl;

    const stripH = new Float32Array(bins);
    const stripOcc = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      const s = ((b / (bins - 1)) * 2 - 1) * searchHalf;
      const q = queryGrid(cur[0] + perpU * s, cur[1] + perpV * s);
      stripH[b] = q.h;
      stripOcc[b] = q.cnt > 0 ? 1 : 0;
    }

    let bestScore = -1;
    let bestOffset = 0;
    let bestH = cur[2];
    for (let b = 1; b < bins - 1; b++) {
      if (stripOcc[b] < 0.5) continue;
      // Combine depth/height slope change (pile toe), gradient jump (rim), and occupancy boundary (pipe edge)
      const grad = Math.abs(stripH[b + 1] - stripH[b - 1]);
      const curv = Math.abs(stripH[b + 1] - 2 * stripH[b] + stripH[b - 1]);
      const occEdge = Math.abs(stripOcc[b + 1] - stripOcc[b - 1]) * radius * 0.25;
      const distPenalty = 1.0 - 0.35 * Math.abs((b / (bins - 1)) * 2 - 1);
      const score = (grad * 0.6 + curv * 1.4 + occEdge) * distPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestOffset = ((b / (bins - 1)) * 2 - 1) * searchHalf;
        bestH = stripH[b];
      }
    }
    if (bestScore > 1e-4) {
      snappedUV[k][0] = cur[0] + perpU * bestOffset;
      snappedUV[k][1] = cur[1] + perpV * bestOffset;
      snappedUV[k][2] = bestH;
    }
  }

  // 4. Two-pass gentle Laplacian smoothing along closed contour to keep edges sleek & natural
  for (let pass = 0; pass < 2; pass++) {
    const copy = snappedUV.map((p) => [p[0], p[1], p[2]]);
    for (let k = 0; k < N; k++) {
      const p0 = copy[(k - 1 + N) % N];
      const p1 = copy[k];
      const p2 = copy[(k + 1) % N];
      snappedUV[k][0] = p1[0] * 0.55 + (p0[0] + p2[0]) * 0.225;
      snappedUV[k][1] = p1[1] * 0.55 + (p0[1] + p2[1]) * 0.225;
      const q = queryGrid(snappedUV[k][0], snappedUV[k][1]);
      snappedUV[k][2] = q.cnt > 0 ? q.h : (p1[2] * 0.55 + (p0[2] + p2[2]) * 0.225);
    }
  }

  return snappedUV.map(([pu, pv, ph]) => new T.Vector3(
    ox + pu * ux + pv * vx + ph * nxv,
    oy + pu * uy + pv * vy + ph * nyv,
    oz + pu * uz + pv * vz + ph * nzv,
  ));
}

/**
 * Apply vertex drag with automatic Gaussian rubber-band soft selection when polygon is dense (> 10 verts).
 */
export function applySoftVertexDrag(originalPts, dragIdx, deltaWorld, closed = true) {
  const N = originalPts.length;
  const out = originalPts.map((p) => p.clone());
  if (dragIdx < 0 || dragIdx >= N) return out;

  if (N <= 10 || !closed) {
    out[dragIdx].add(deltaWorld);
    return out;
  }

  // Soft-selection radius = ~18% of vertex ring (Gaussian falloff)
  const radiusIdx = Math.max(2, Math.round(N * 0.16));
  const sigma = radiusIdx * 0.52;
  for (let i = 0; i < N; i++) {
    let dIdx = Math.abs(i - dragIdx);
    dIdx = Math.min(dIdx, N - dIdx);
    if (dIdx > radiusIdx) continue;
    const w = Math.exp(-(dIdx * dIdx) / (2 * sigma * sigma));
    out[i].addScaledVector(deltaWorld, w);
  }
  return out;
}
