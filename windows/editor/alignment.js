// Strict +Y-up Alignment & Measurement Engine (inspired by spirula-studio):
// 1. Auto Align: RANSAC ground plane + PCA normal refinement -> +Y (Y=0), dominant wall -> X/Z, XZ centered at origin
// 2. Vertical Line Alignment: bottom -> top segment aligned to +Y (with 180-deg flip)
// 3. 3-Point Ground Alignment: 3 non-collinear points -> Y=0, denser side facing +Y (with confirm/reset/flip)
// 4. Quick OpenCV (-Y up) -> +Y-up rigid 180-deg helper
import * as T from "three";
import { FLAG_DELETED } from "./cloud.js";
import { t } from "./i18n.js";

const Y_UP = new T.Vector3(0, 1, 0);

function sampleWorldPoints(cloud, targetObjectIds = null, maxSamples = 18000, minAlphaU8 = 0) {
  const n = cloud.n;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const pts = [];
  const v = new T.Vector3();
  const rgba = cloud.rgba;
  for (let i = 0; i < n; i += step) {
    if (cloud.flags[i] & FLAG_DELETED) continue;
    if (minAlphaU8 > 0 && rgba && rgba[i * 4 + 3] < minAlphaU8) continue;
    if (targetObjectIds && targetObjectIds.size > 0 && !targetObjectIds.has(cloud.objectIds[i])) continue;
    cloud.getWorldPosition(i, v);
    pts.push(v.clone());
  }
  return pts;
}

// Compute smallest eigenvector of a symmetric 3x3 covariance matrix via Jacobi iterations (PCA plane normal refinement)
function refinePlaneNormalPCA(inliers, fallbackNormal) {
  if (inliers.length < 6) return fallbackNormal.clone().normalize();
  let mx = 0, my = 0, mz = 0;
  for (const p of inliers) { mx += p.x; my += p.y; mz += p.z; }
  const invN = 1 / inliers.length;
  mx *= invN; my *= invN; mz *= invN;

  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
  for (const p of inliers) {
    const dx = p.x - mx, dy = p.y - my, dz = p.z - mz;
    c00 += dx * dx; c01 += dx * dy; c02 += dx * dz;
    c11 += dy * dy; c12 += dy * dz; c22 += dz * dz;
  }
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
  for (let iter = 0; iter < 18; iter++) {
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
  const nrm = new T.Vector3(V[0][minIdx], V[1][minIdx], V[2][minIdx]).normalize();
  if (nrm.dot(fallbackNormal) < 0) nrm.negate();
  return { normal: nrm, centroid: new T.Vector3(mx, my, mz) };
}

/**
 * 3-Point Ground Leveling (Section VIII.3):
 * Levels the plane through p0, p1, p2 onto Z=0 with the denser side facing +Z by default.
 */
export function computeGroundAlignment(p0, p1, p2, cloud, targetObjectIds = null, flip = false) {
  const e1 = new T.Vector3().subVectors(p1, p0);
  const e2 = new T.Vector3().subVectors(p2, p0);
  const normal = new T.Vector3().crossVectors(e1, e2);
  if (normal.lengthSq() < 1e-10) {
    throw new Error(t("editor.align.errCollinear"));
  }
  normal.normalize();

  let above = 0;
  let below = 0;
  const v = new T.Vector3();
  const step = Math.max(1, Math.floor(cloud.n / 25000));
  for (let i = 0; i < cloud.n; i += step) {
    if (cloud.flags[i] & FLAG_DELETED) continue;
    if (targetObjectIds && targetObjectIds.size > 0 && !targetObjectIds.has(cloud.objectIds[i])) continue;
    cloud.getWorldPosition(i, v);
    if (v.sub(p0).dot(normal) >= 0) above++;
    else below++;
  }
  if (below > above) normal.negate();
  if (flip) normal.negate();

  const q = new T.Quaternion().setFromUnitVectors(normal, Y_UP);
  const center = new T.Vector3().add(p0).add(p1).add(p2).divideScalar(3);
  const rotatedCenter = center.clone().applyQuaternion(q);
  const deltaMat = new T.Matrix4()
    .makeTranslation(0, -rotatedCenter.y, 0)
    .multiply(new T.Matrix4().makeRotationFromQuaternion(q));
  return { deltaMat, normal, above, below };
}

/**
 * Vertical Line Alignment (Section VIII.2):
 * Aligns segment (pBottom -> pTop) to +Y (or -Y if flipped).
 */
export function computeVerticalAlignment(pBottom, pTop, flip = false) {
  const dir = new T.Vector3().subVectors(pTop, pBottom);
  if (dir.lengthSq() < 1e-10) {
    throw new Error(t("editor.align.errCoincident"));
  }
  dir.normalize();
  if (flip) dir.negate();
  const q = new T.Quaternion().setFromUnitVectors(dir, Y_UP);
  const pivot = pBottom.clone();
  const deltaMat = new T.Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new T.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new T.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  return { deltaMat, dir };
}

/**
 * Auto Align (inspired by spirula-studio, Section VIII.1):
 * 1. RANSAC ground plane (preferring lower-envelope major planes) + PCA normal refinement -> +Z at Z=0
 * 2. Detect dominant vertical walls above ground -> rotate around Z to align with X / Y axes
 * 3. Center XY median above origin (0, 0, 0)
 */
export function computeAutoAlign(cloud, targetObjectIds = null) {
  // Sample opaque core points first so faint sky/fog floaters never corrupt ground detection
  let rawPts = sampleWorldPoints(cloud, targetObjectIds, 24000, 64);
  if (rawPts.length < 60) rawPts = sampleWorldPoints(cloud, targetObjectIds, 18000, 0);
  if (rawPts.length < 30) {
    throw new Error(t("editor.align.errInsufficientPoints"));
  }

  // Trim extreme 2%-98% spatial outliers so distant background sky/horizon never bloats span/tol
  const rxs = rawPts.map((p) => p.x).sort((a, b) => a - b);
  const rys = rawPts.map((p) => p.y).sort((a, b) => a - b);
  const rzs = rawPts.map((p) => p.z).sort((a, b) => a - b);
  const lo2 = Math.floor(rawPts.length * 0.02);
  const hi98 = Math.min(rawPts.length - 1, Math.floor(rawPts.length * 0.98));
  const pts = rawPts.filter(
    (p) =>
      p.x >= rxs[lo2] && p.x <= rxs[hi98] &&
      p.y >= rys[lo2] && p.y <= rys[hi98] &&
      p.z >= rzs[lo2] && p.z <= rzs[hi98],
  );
  if (pts.length < 30) pts.push(...rawPts);

  const xs = pts.map((p) => p.x).sort((a, b) => a - b);
  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  const zs = pts.map((p) => p.z).sort((a, b) => a - b);
  const q10 = Math.floor(pts.length * 0.1);
  const q90 = Math.floor(pts.length * 0.9);
  const span = Math.max(
    1e-3,
    Math.hypot(xs[q90] - xs[q10], ys[q90] - ys[q10], zs[q90] - zs[q10]),
  );
  const tol = span * 0.016;

  let seed = 4219;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Collect top distinct candidate planes so we can distinguish a FLOOR from a flat ROOF/CEILING!
  const candidates = [];
  const e1 = new T.Vector3();
  const e2 = new T.Vector3();
  const nrm = new T.Vector3();

  const stride = Math.max(1, Math.floor(pts.length / 2600));
  for (let it = 0; it < 380; it++) {
    const a = pts[(rand() * pts.length) | 0];
    const b = pts[(rand() * pts.length) | 0];
    const c = pts[(rand() * pts.length) | 0];
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    nrm.crossVectors(e1, e2);
    const len = nrm.length();
    if (len < 1e-6) continue;
    nrm.divideScalar(len);

    let inliers = 0;
    let posSide = 0;
    let negSide = 0;
    const d0 = nrm.dot(a);
    const slab = tol * 1.5;
    for (let i = 0; i < pts.length; i += stride) {
      const sd = nrm.dot(pts[i]) - d0;
      if (Math.abs(sd) <= tol) inliers++;
      if (sd > slab) posSide++;
      else if (sd < -slab) negSide++;
    }
    if (inliers < 18) continue;

    // Orient candidate normal toward the side containing MORE points (inward into scene)
    const candNormal = nrm.clone();
    if (negSide > posSide) candNormal.negate();
    const totalSide = posSide + negSide || 1;
    const oneSidedness = Math.max(posSide, negSide) / totalSide;
    // Gravity-consistent bonus: strongly prefer a ground plane whose inward normal does NOT invert an upright scene!
    // (Prevents an indoor ceiling / flat roof at +Y from flipping an already +Y-up building upside down!)
    const upAlign = candNormal.y; // +1 = already facing +Y, 0 = 90deg tilted (e.g. +Z-up scan), -1 = roof/ceiling or OpenCV -Y
    const uprightBonus = upAlign >= -0.25 ? 1.0 + 0.35 * Math.max(0, upAlign) : 0.42;
    const score = inliers * (0.6 + 0.55 * oneSidedness) * uprightBonus;

    // Deduplicate against already stored distinct planes
    const dSigned = candNormal.dot(a);
    let merged = false;
    for (const prev of candidates) {
      if (prev.normal.dot(candNormal) > 0.96 && Math.abs(prev.d - dSigned) < tol * 4) {
        if (score > prev.score) {
          prev.score = score;
          prev.inliers = inliers;
          prev.normal.copy(candNormal);
          prev.anchor.copy(a);
          prev.d = dSigned;
          prev.oneSidedness = oneSidedness;
        }
        merged = true;
        break;
      }
    }
    if (!merged) {
      candidates.push({
        score,
        inliers,
        normal: candNormal,
        anchor: a.clone(),
        d: dSigned,
        oneSidedness,
      });
    }
  }

  candidates.sort((u, v) => v.score - u.score);
  const picked = candidates[0] || {
    inliers: 0,
    normal: new T.Vector3(0, 1, 0),
    anchor: new T.Vector3(0, ys[Math.floor(ys.length * 0.08)], 0),
  };
  const bestCount = picked.inliers;
  const bestNormal = picked.normal.clone();
  const bestAnchor = picked.anchor.clone();

  // Gather full inliers and refine normal via PCA for sub-degree precision
  const dBest = bestNormal.dot(bestAnchor);
  const groundInliers = [];
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(bestNormal.dot(pts[i]) - dBest) <= tol * 1.25) {
      groundInliers.push(pts[i]);
    }
  }
  const refined = refinePlaneNormalPCA(groundInliers, bestNormal);
  bestNormal.copy(refined.normal);
  bestAnchor.copy(refined.centroid);

  // Verify inward normal side (excluding points inside the ground slab itself)
  let above = 0;
  let below = 0;
  const dGround = bestNormal.dot(bestAnchor);
  const slabCheck = tol * 1.5;
  for (let i = 0; i < pts.length; i++) {
    const sd = bestNormal.dot(pts[i]) - dGround;
    if (sd > slabCheck) above++;
    else if (sd < -slabCheck) below++;
  }
  if (below > above) bestNormal.negate();

  // If the winning plane is still a flat roof/ceiling with normal ≈ -Y while significant geometry sits on the bottom,
  // check if there is a strong parallel floor plane at the lower Y envelope and prefer it!
  if (bestNormal.y < -0.7) {
    const floorAlt = candidates.find(
      (c) => c.normal.y > 0.7 && c.inliers >= bestCount * 0.22,
    );
    if (floorAlt) {
      const fInliers = [];
      const df = floorAlt.normal.dot(floorAlt.anchor);
      for (let i = 0; i < pts.length; i++) {
        if (Math.abs(floorAlt.normal.dot(pts[i]) - df) <= tol * 1.4) fInliers.push(pts[i]);
      }
      const refF = refinePlaneNormalPCA(fInliers, floorAlt.normal);
      bestNormal.copy(refF.normal);
      bestAnchor.copy(refF.centroid);
      if (bestNormal.y < 0) bestNormal.negate();
    }
  }

  const qGround = new T.Quaternion().setFromUnitVectors(bestNormal, Y_UP);
  const leveled = pts.map((p) => p.clone().applyQuaternion(qGround));
  const groundY = bestAnchor.clone().applyQuaternion(qGround).y;

  // Step 2: Dominant vertical wall detection above ground (with 90-degree angle histogram voting in XZ plane)
  const wallPts = leveled.filter((p) => p.y > groundY + tol * 2.2);
  let yawAngle = 0;
  let wallDetected = false;

  if (wallPts.length >= 60) {
    const angleBins = new Float32Array(90); // 1-degree bins in [0, 90)
    const wStride = Math.max(1, Math.floor(wallPts.length / 2000));
    for (let it = 0; it < 220; it++) {
      const a = wallPts[(rand() * wallPts.length) | 0];
      const b = wallPts[(rand() * wallPts.length) | 0];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz);
      if (l < span * 0.03) continue;
      const nx = -dz / l;
      const nz = dx / l;
      const d = nx * a.x + nz * a.z;
      let count = 0;
      for (let i = 0; i < wallPts.length; i += wStride) {
        if (Math.abs(nx * wallPts[i].x + nz * wallPts[i].z - d) <= tol * 1.2) count++;
      }
      if (count > Math.min(wallPts.length, 2000) * 0.06) {
        let deg = (Math.atan2(nz, nx) * 180) / Math.PI;
        deg = ((deg % 90) + 90) % 90;
        const bin = Math.min(89, Math.floor(deg));
        angleBins[bin] += count * count;
      }
    }
    let bestBin = -1, bestVote = 0;
    for (let b = 0; b < 90; b++) {
      // Smooth over 3-degree neighborhood
      const v = angleBins[(b + 89) % 90] * 0.5 + angleBins[b] + angleBins[(b + 1) % 90] * 0.5;
      if (v > bestVote) {
        bestVote = v;
        bestBin = b;
      }
    }
    if (bestBin >= 0 && bestVote > 0) {
      wallDetected = true;
      const rawRad = ((bestBin + 0.5) * Math.PI) / 180;
      const snap = Math.round(rawRad / (Math.PI / 2)) * (Math.PI / 2);
      yawAngle = -(snap - rawRad);
    }
  }

  const qYaw = new T.Quaternion().setFromAxisAngle(Y_UP, yawAngle);
  const qTotal = qYaw.clone().multiply(qGround);

  // Step 3: Center XZ median at (0, 0) and rest ground on Y = 0
  const finalXs = [];
  const finalZs = [];
  const tmp = new T.Vector3();
  for (let i = 0; i < pts.length; i++) {
    tmp.copy(pts[i]).applyQuaternion(qTotal);
    finalXs.push(tmp.x);
    finalZs.push(tmp.z);
  }
  finalXs.sort((a, b) => a - b);
  finalZs.sort((a, b) => a - b);
  const medX = finalXs[Math.floor(finalXs.length * 0.5)];
  const medZ = finalZs[Math.floor(finalZs.length * 0.5)];
  const anchorAfter = bestAnchor.clone().applyQuaternion(qTotal);

  const deltaMat = new T.Matrix4()
    .makeTranslation(-medX, -anchorAfter.y, -medZ)
    .multiply(new T.Matrix4().makeRotationFromQuaternion(qTotal));

  return {
    deltaMat,
    wallDetected,
    groundInlierRatio: bestCount / Math.max(1, Math.min(pts.length, 2800)),
  };
}

/**
 * Rigid 180deg rotation around X to convert OpenCV (-Y up) scans into right-handed +Y-up cleanly.
 */
export function computeOpenCvToYUp(cloud, targetObjectIds = null) {
  const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), Math.PI);
  const pts = sampleWorldPoints(cloud, targetObjectIds, 4000);
  if (pts.length === 0) return new T.Matrix4().makeRotationFromQuaternion(q);
  const ys = pts.map((p) => p.clone().applyQuaternion(q).y).sort((a, b) => a - b);
  const floorY = ys[Math.floor(ys.length * 0.05)];
  return new T.Matrix4()
    .makeTranslation(0, -floorY, 0)
    .multiply(new T.Matrix4().makeRotationFromQuaternion(q));
}

// Legacy alias kept for backwards compatibility
export const computeOpenCvToZUp = computeOpenCvToYUp;

/**
 * Smart Conditional Scene-Ground Tilt Detector (rc8 #3):
 * Only flags models that strongly resemble a real captured SCENE with a clear one-sided ground plane
 * AND a significant tilt deviation from +Z (filtering out figurines, busts, props, and already-leveled scenes!).
 */
export function detectTiltedSceneCandidate(cloud, targetObjectIds = null) {
  if (!cloud || cloud.n < 10000) {
    return { shouldPrompt: false, reason: "point-count-too-small" };
  }
  let rawPts = sampleWorldPoints(cloud, targetObjectIds, 16000, 64);
  if (rawPts.length < 300) rawPts = sampleWorldPoints(cloud, targetObjectIds, 12000, 0);
  if (rawPts.length < 300) {
    return { shouldPrompt: false, reason: "insufficient-valid-samples" };
  }

  // Trim 2%..98% extreme outliers to measure core scene geometry
  const rxs = rawPts.map((p) => p.x).sort((a, b) => a - b);
  const rys = rawPts.map((p) => p.y).sort((a, b) => a - b);
  const rzs = rawPts.map((p) => p.z).sort((a, b) => a - b);
  const lo = Math.floor(rawPts.length * 0.02);
  const hi = Math.min(rawPts.length - 1, Math.floor(rawPts.length * 0.98));
  const pts = rawPts.filter(
    (p) =>
      p.x >= rxs[lo] && p.x <= rxs[hi] &&
      p.y >= rys[lo] && p.y <= rys[hi] &&
      p.z >= rzs[lo] && p.z <= rzs[hi],
  );
  if (pts.length < 200) return { shouldPrompt: false, reason: "trimmed-empty" };

  // Compute principal axis extents via sorted spans + RANSAC dominant plane
  const dx = Math.max(1e-4, rxs[hi] - rxs[lo]);
  const dy = Math.max(1e-4, rys[hi] - rys[lo]);
  const dz = Math.max(1e-4, rzs[hi] - rzs[lo]);
  const spansSorted = [dx, dy, dz].sort((a, b) => a - b); // [thin, mid, wide]
  const flatnessRatio = spansSorted[2] / Math.max(1e-4, spansSorted[0]);
  const midToThin = spansSorted[1] / Math.max(1e-4, spansSorted[0]);
  const totalSpan = Math.hypot(dx, dy, dz);

  // Must have a relatively large, distinctly flat/extended scene silhouette (not a tall narrow figurine/object!)
  if (totalSpan < 2.2 || flatnessRatio < 1.55 || midToThin < 1.2) {
    return {
      shouldPrompt: false,
      reason: "not-scene-like-aspect",
      totalSpan,
      flatnessRatio,
      midToThin,
    };
  }

  const tol = totalSpan * 0.017;
  let seed = 9173;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const stride = Math.max(1, Math.floor(pts.length / 2200));
  const sampleTotal = Math.ceil(pts.length / stride);
  const e1 = new T.Vector3();
  const e2 = new T.Vector3();
  const nrm = new T.Vector3();

  let bestScore = 0;
  let bestInliers = 0;
  let bestOneSided = 0;
  let bestNormal = null;
  let bestAnchor = null;

  for (let it = 0; it < 260; it++) {
    const a = pts[(rand() * pts.length) | 0];
    const b = pts[(rand() * pts.length) | 0];
    const c = pts[(rand() * pts.length) | 0];
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    nrm.crossVectors(e1, e2);
    const len = nrm.length();
    if (len < 1e-6) continue;
    nrm.divideScalar(len);

    let inliers = 0;
    let posSide = 0;
    let negSide = 0;
    const d0 = nrm.dot(a);
    const slab = tol * 1.5;
    for (let i = 0; i < pts.length; i += stride) {
      const sd = nrm.dot(pts[i]) - d0;
      if (Math.abs(sd) <= tol) inliers++;
      else if (sd > slab) posSide++;
      else if (sd < -slab) negSide++;
    }
    const inlierRatio = inliers / Math.max(1, sampleTotal);
    if (inlierRatio < 0.11) continue;
    const offTotal = posSide + negSide;
    if (offTotal < 40) continue;
    const oneSided = Math.max(posSide, negSide) / offTotal;
    if (oneSided < 0.78) continue;

    const candN = nrm.clone();
    if (negSide > posSide) candN.negate();
    const score = inlierRatio * (0.4 + 0.6 * oneSided);
    if (score > bestScore) {
      bestScore = score;
      bestInliers = inliers;
      bestOneSided = oneSided;
      bestNormal = candN;
      bestAnchor = a.clone();
    }
  }

  if (!bestNormal) {
    return { shouldPrompt: false, reason: "no-dominant-one-sided-ground" };
  }

  // Refine plane normal via PCA on full inliers for accurate tilt angle
  const dBest = bestNormal.dot(bestAnchor);
  const inlierPts = [];
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(bestNormal.dot(pts[i]) - dBest) <= tol * 1.25) inlierPts.push(pts[i]);
  }
  const refined = refinePlaneNormalPCA(inlierPts, bestNormal);
  const finalN = refined.normal;
  let posFull = 0, negFull = 0;
  const dRef = finalN.dot(refined.centroid);
  for (let i = 0; i < pts.length; i++) {
    const sd = finalN.dot(pts[i]) - dRef;
    if (sd > tol * 1.5) posFull++;
    else if (sd < -tol * 1.5) negFull++;
  }
  if (negFull > posFull) finalN.negate();
  const finalOneSided = Math.max(posFull, negFull) / Math.max(1, posFull + negFull);
  const finalInlierRatio = inlierPts.length / Math.max(1, pts.length);

  // Measure thickness along the plane normal vs lateral spread on the plane -> confirms scene flatness!
  const qAlign = new T.Quaternion().setFromUnitVectors(finalN, Y_UP);
  let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity, pMinZ = Infinity, pMaxZ = -Infinity;
  const tmp = new T.Vector3();
  for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 4000))) {
    tmp.copy(pts[i]).applyQuaternion(qAlign);
    if (tmp.x < pMinX) pMinX = tmp.x;
    if (tmp.x > pMaxX) pMaxX = tmp.x;
    if (tmp.y < pMinY) pMinY = tmp.y;
    if (tmp.y > pMaxY) pMaxY = tmp.y;
    if (tmp.z < pMinZ) pMinZ = tmp.z;
    if (tmp.z > pMaxZ) pMaxZ = tmp.z;
  }
  const groundSpanXZ = Math.max(pMaxX - pMinX, pMaxZ - pMinZ);
  const heightAlongN = Math.max(1e-4, pMaxY - pMinY);
  const groundAspect = groundSpanXZ / heightAlongN;

  // Angle between inward ground normal and world +Y
  const tiltDeg = (Math.acos(Math.max(-1, Math.min(1, finalN.y))) * 180) / Math.PI;
  const shouldPrompt =
    finalInlierRatio >= 0.12 &&
    finalOneSided >= 0.80 &&
    groundAspect >= 1.45 &&
    tiltDeg >= 3.5;

  return {
    shouldPrompt,
    tiltDeg: Number(tiltDeg.toFixed(1)),
    inlierRatio: Number(finalInlierRatio.toFixed(3)),
    oneSidedRatio: Number(finalOneSided.toFixed(3)),
    groundAspect: Number(groundAspect.toFixed(2)),
    totalSpan: Number(totalSpan.toFixed(2)),
    reason: shouldPrompt ? "tilted-scene-detected" : (tiltDeg < 3.5 ? "already-level" : "criteria-not-met"),
  };
}
