/**
 * @module semantic/occlusion-worker
 * @description Multi-threaded CPU candidate-view occlusion & clearance evaluator (M08 §4).
 *
 * Implements the user's exact 5.1 occlusion algorithm at < 1 ms per candidate view across parallel workers:
 * - Receives primary-view high-confidence anchor points (`anchors`), target center/radius, and a
 *   stratified sample of non-target scene points (`scenePos`, `sceneRadius`).
 * - Projects non-target scene points into a compact 128×96 Z-buffer, runs fast 2D depth-discontinuity
 *   connected-component labeling, and tests each camera→anchor ray:
 *   1) Camera clearance guard (rejects cameras inside walls / extreme close foreground);
 *   2) Large depth deviation (`anchorDepth - frontDepth > max(1.15 * objRadius, 0.08)`) -> distinguishes
 *      external foreground occluders from target self-occlusion on back views;
 *   3) 2D depth-component disconnectivity between blocking foreground pixels and visible anchor pixels
 *      (plus full-occlusion fast reject when virtually all anchors are behind an external wall!).
 */

const W = 128;
const H = 96;
const PIX = W * H;

let scenePos = null;     // Float32Array (M * 3) world positions of non-target scene points
let sceneScale = null;   // Float32Array (M) approximate world radius
let anchors = null;      // Float32Array (K * 3) primary-view base anchor points
let objCenter = [0, 0, 0];
let objRadius = 0.5;
let objMin = [-0.5, -0.5, -0.5];
let objMax = [0.5, 0.5, 0.5];

const depthBuf = new Float32Array(PIX);
const compId = new Int32Array(PIX);
const bfsQueue = new Int32Array(PIX);
const anchorPixMask = new Uint8Array(PIX);

function buildCameraBasis(pos, target, up) {
  // Right-handed camera basis: forward = normalize(target - pos)
  let fx = target[0] - pos[0];
  let fy = target[1] - pos[1];
  let fz = target[2] - pos[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;

  // right = normalize(forward x up)
  let rx = fy * up[2] - fz * up[1];
  let ry = fz * up[0] - fx * up[2];
  let rz = fx * up[1] - fy * up[0];
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-5) {
    rx = 1; ry = 0; rz = 0; rl = 1;
  }
  rx /= rl; ry /= rl; rz /= rl;

  // trueUp = right x forward
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  return { fx, fy, fz, rx, ry, rz, ux, uy, uz, dist: fl };
}

function projectPoint(px, py, pz, pos, basis, fLenY, aspect) {
  const dx = px - pos[0];
  const dy = py - pos[1];
  const dz = pz - pos[2];
  const depth = dx * basis.fx + dy * basis.fy + dz * basis.fz;
  if (depth <= 1e-4) return null;
  const cx = dx * basis.rx + dy * basis.ry + dz * basis.rz;
  const cy = dx * basis.ux + dy * basis.uy + dz * basis.uz;
  const ndcX = (cx / depth) * (fLenY / aspect);
  const ndcY = (cy / depth) * fLenY;
  const nx = (ndcX + 1) * 0.5;
  const ny = (1 - ndcY) * 0.5;
  return { nx, ny, depth };
}

function evaluatePose(pose) {
  const { id, pos, target, up, fovDeg, aspect } = pose;
  const basis = buildCameraBasis(pos, target, up);
  const fLenY = 1 / Math.tan(((fovDeg || 50) * Math.PI) / 360);
  const asp = Math.max(0.25, aspect || 1.333);

  depthBuf.fill(Infinity);
  anchorPixMask.fill(0);

  // 1. Splat non-target scene points into fast 128x96 Z-buffer
  const m = scenePos ? scenePos.length / 3 : 0;
  const minClearDist = Math.max(0.08, Math.min(objRadius * 0.35, basis.dist * 0.14));
  let cameraBlockedHits = 0;
  let nearestFront = Infinity;

  for (let i = 0; i < m; i++) {
    const i3 = i * 3;
    const dx = scenePos[i3] - pos[0];
    const dy = scenePos[i3 + 1] - pos[1];
    const dz = scenePos[i3 + 2] - pos[2];
    const depth = dx * basis.fx + dy * basis.fy + dz * basis.fz;
    if (depth <= 1e-4 || depth > basis.dist + objRadius * 2.5) continue;

    const cx = dx * basis.rx + dy * basis.ry + dz * basis.rz;
    const cy = dx * basis.ux + dy * basis.uy + dz * basis.uz;
    const ndcX = (cx / depth) * (fLenY / asp);
    const ndcY = (cy / depth) * fLenY;
    if (ndcX < -1.05 || ndcX > 1.05 || ndcY < -1.05 || ndcY > 1.05) continue;

    if (depth < minClearDist && Math.abs(ndcX) < 0.7 && Math.abs(ndcY) < 0.7) {
      cameraBlockedHits++;
    }
    if (depth < nearestFront) nearestFront = depth;

    const gx = Math.max(0, Math.min(W - 1, Math.floor((ndcX + 1) * 0.5 * W)));
    const gy = Math.max(0, Math.min(H - 1, Math.floor((1 - ndcY) * 0.5 * H)));
    const sc = sceneScale ? sceneScale[i] : 0.03;
    const pxRad = Math.max(0, Math.min(3, Math.round((sc * fLenY * H * 0.5) / depth)));

    for (let oy = -pxRad; oy <= pxRad; oy++) {
      const py = gy + oy;
      if (py < 0 || py >= H) continue;
      const row = py * W;
      for (let ox = -pxRad; ox <= pxRad; ox++) {
        const px = gx + ox;
        if (px < 0 || px >= W) continue;
        const idx = row + px;
        if (depth < depthBuf[idx]) depthBuf[idx] = depth;
      }
    }
  }

  if (cameraBlockedHits >= 6) {
    return {
      id,
      accepted: false,
      reason: "camera-inside",
      visibleRatio: 0,
      occludedRatio: 1,
      clearance: nearestFront,
      projectedBox: null,
    };
  }

  // 2. Project target 3D bounding box to compute expected 2D framing & box prompt
  let minNx = Infinity, minNy = Infinity, maxNx = -Infinity, maxNy = -Infinity;
  for (let ix = 0; ix < 2; ix++) {
    const x = ix ? objMax[0] : objMin[0];
    for (let iy = 0; iy < 2; iy++) {
      const y = iy ? objMax[1] : objMin[1];
      for (let iz = 0; iz < 2; iz++) {
        const z = iz ? objMax[2] : objMin[2];
        const pr = projectPoint(x, y, z, pos, basis, fLenY, asp);
        if (!pr) continue;
        if (pr.nx < minNx) minNx = pr.nx;
        if (pr.ny < minNy) minNy = pr.ny;
        if (pr.nx > maxNx) maxNx = pr.nx;
        if (pr.ny > maxNy) maxNy = pr.ny;
      }
    }
  }
  if (!Number.isFinite(minNx) || maxNx < 0.02 || minNx > 0.98 || maxNy < 0.02 || minNy > 0.98) {
    return { id, accepted: false, reason: "out-of-view", visibleRatio: 0, occludedRatio: 1, clearance: nearestFront, projectedBox: null };
  }

  // 3. Project base anchor points & mark anchor depth pixels alongside scene Z-buffer
  const kCount = anchors ? anchors.length / 3 : 0;
  const anchorProj = [];
  const depthDevThresh = Math.max(objRadius * 1.12, 0.08);
  let inViewCount = 0;

  for (let k = 0; k < kCount; k++) {
    const k3 = k * 3;
    const pr = projectPoint(anchors[k3], anchors[k3 + 1], anchors[k3 + 2], pos, basis, fLenY, asp);
    if (!pr || pr.nx < 0.01 || pr.nx > 0.99 || pr.ny < 0.01 || pr.ny > 0.99) continue;
    inViewCount++;
    const gx = Math.max(0, Math.min(W - 1, Math.floor(pr.nx * W)));
    const gy = Math.max(0, Math.min(H - 1, Math.floor(pr.ny * H)));
    const idx = gy * W + gx;
    const sceneZ = depthBuf[idx];
    const hasFrontDev = Number.isFinite(sceneZ) && (pr.depth - sceneZ > depthDevThresh);
    // If no external closer occluder occupies this pixel, write anchor depth so connected-component sees target surface
    if (!hasFrontDev && pr.depth < depthBuf[idx]) {
      depthBuf[idx] = pr.depth;
      anchorPixMask[idx] = 1;
    }
    anchorProj.push({ idx, gx, gy, depth: pr.depth, sceneZ, hasFrontDev, nx: pr.nx, ny: pr.ny });
  }

  if (inViewCount === 0) {
    return { id, accepted: false, reason: "out-of-view", visibleRatio: 0, occludedRatio: 1, clearance: nearestFront, projectedBox: null };
  }

  // 4. Fast 2D Depth-Discontinuity Connected Component Labeling on 128x96 projection
  compId.fill(-1);
  let nextComp = 0;
  const neighborJump = Math.max(objRadius * 0.42, 0.07);
  for (let start = 0; start < PIX; start++) {
    if (compId[start] !== -1 || !Number.isFinite(depthBuf[start])) continue;
    const cid = nextComp++;
    let head = 0, tail = 0;
    compId[start] = cid;
    bfsQueue[tail++] = start;
    while (head < tail) {
      const cur = bfsQueue[head++];
      const cz = depthBuf[cur];
      const cx = cur % W;
      const cy = (cur - cx) / W;
      const tol = Math.max(neighborJump, cz * 0.08);
      const tryNb = (nb) => {
        if (compId[nb] !== -1) return;
        const nz = depthBuf[nb];
        if (Number.isFinite(nz) && Math.abs(nz - cz) <= tol) {
          compId[nb] = cid;
          bfsQueue[tail++] = nb;
        }
      };
      if (cx > 0) tryNb(cur - 1);
      if (cx + 1 < W) tryNb(cur + 1);
      if (cy > 0) tryNb(cur - W);
      if (cy + 1 < H) tryNb(cur + W);
    }
  }

  // Collect connected component IDs that contain unoccluded visible anchors
  const anchorComps = new Set();
  for (let i = 0; i < PIX; i++) {
    if (anchorPixMask[i] && compId[i] >= 0) anchorComps.add(compId[i]);
  }

  // 5. Evaluate each anchor: occluded iff closer scene hit has large depth deviation AND is disconnected from anchor components!
  let occludedCount = 0;
  let visibleCount = 0;
  const visiblePoints = [];
  for (const a of anchorProj) {
    if (a.hasFrontDev) {
      const frontComp = compId[a.idx];
      const disconnected = anchorComps.size === 0 || !anchorComps.has(frontComp);
      if (disconnected) {
        occludedCount++;
        continue;
      }
    }
    visibleCount++;
    visiblePoints.push({ x: a.nx, y: a.ny });
  }

  const visibleRatio = visibleCount / inViewCount;
  const occludedRatio = occludedCount / inViewCount;

  // Pad projected 2D box slightly so object isn't clipped at edges
  const padX = Math.max(0.03, (maxNx - minNx) * 0.12);
  const padY = Math.max(0.03, (maxNy - minNy) * 0.12);
  const projectedBox = {
    x0: Math.max(0.01, minNx - padX),
    y0: Math.max(0.01, minNy - padY),
    x1: Math.min(0.99, maxNx + padX),
    y1: Math.min(0.99, maxNy + padY),
  };
  const boxArea = (projectedBox.x1 - projectedBox.x0) * (projectedBox.y1 - projectedBox.y0);
  const clippedOut = (minNx < -0.15 || maxNx > 1.15 || minNy < -0.15 || maxNy > 1.15);

  const accepted = occludedRatio <= 0.38 && visibleRatio >= 0.55 && boxArea >= 0.002 && boxArea <= 0.92;
  const reason = accepted
    ? (clippedOut ? "ok-tight" : "ok")
    : (occludedRatio > 0.38 ? "foreground-occluded" : boxArea > 0.92 ? "too-close" : "low-visibility");

  return {
    id,
    accepted,
    reason,
    clippedOut,
    visibleRatio,
    occludedRatio,
    clearance: Number.isFinite(nearestFront) ? nearestFront : basis.dist,
    projectedBox,
    visiblePoints: visiblePoints.slice(0, 4),
  };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "init") {
    scenePos = msg.scenePos;
    sceneScale = msg.sceneScale;
    anchors = msg.anchors;
    objCenter = msg.objCenter;
    objRadius = Math.max(0.02, msg.objRadius || 0.5);
    objMin = msg.objMin;
    objMax = msg.objMax;
    self.postMessage({ type: "ready", jobId: msg.jobId });
    return;
  }
  if (msg.type === "evalBatch") {
    const results = [];
    for (const p of msg.poses) {
      results.push(evaluatePose(p));
    }
    self.postMessage({ type: "batchResult", jobId: msg.jobId, results });
  }
};
