// Dedicated background Web Worker for O(N) 16-bit counting depth sort of 3D Gaussians.
// Uses ping-pong ArrayBuffer recycling to eliminate per-sort 140 MB GC stalls on 35M+ scenes!

let positions = null;   // Float32Array (n * 3)
let objectIds = null;   // Uint8Array (n)
let pointCount = 0;

let depths = new Float32Array(0);
let counts = new Uint32Array(65536);
let recycledBuffer = null; // Reused ArrayBuffer returned from main thread (zero-allocation ping-pong!)

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === "recycle") {
    if (msg.buffer instanceof ArrayBuffer && msg.buffer.byteLength > 0) {
      recycledBuffer = msg.buffer;
    }
    return;
  }

  if (msg.type === "setData") {
    positions = msg.positions;
    objectIds = msg.objectIds;
    pointCount = msg.count | 0;
    if (depths.length < pointCount) {
      depths = new Float32Array(pointCount);
    }
    return;
  }

  if (msg.type === "updateObjectIds") {
    objectIds = msg.objectIds;
    return;
  }

  if (msg.type === "sort") {
    const tSort0 = performance.now();
    if (!positions || !objectIds || pointCount === 0) {
      self.postMessage({ type: "sorted", jobId: msg.jobId, drawCount: 0, sortMs: 0, order: new Uint32Array(0) });
      return;
    }

    const drawCount = Math.min(pointCount, msg.drawCount | 0);
    const viewZ = msg.viewZ; // [vx, vy, vz, vw] — 3rd row of view matrix (camera forward depth)
    const objMats = msg.objectMatrices; // Float32Array (MAX_OBJ * 16)
    const numObjs = (objMats.length / 16) | 0;

    // Precompute combined depth linear functional per object: d_o(x,y,z) = ax*x + ay*y + az*z + aw
    const dCoef = new Float32Array(numObjs * 4);
    const vx = viewZ[0], vy = viewZ[1], vz = viewZ[2], vw = viewZ[3];
    for (let o = 0; o < numObjs; o++) {
      const m = o * 16;
      dCoef[o * 4] = vx * objMats[m] + vy * objMats[m + 1] + vz * objMats[m + 2];
      dCoef[o * 4 + 1] = vx * objMats[m + 4] + vy * objMats[m + 5] + vz * objMats[m + 6];
      dCoef[o * 4 + 2] = vx * objMats[m + 8] + vy * objMats[m + 9] + vz * objMats[m + 10];
      dCoef[o * 4 + 3] = vx * objMats[m + 12] + vy * objMats[m + 13] + vz * objMats[m + 14] + vw;
    }

    let minD = Infinity;
    let maxD = -Infinity;
    const pos = positions;
    const oids = objectIds;

    if (numObjs <= 1) {
      const a0 = dCoef[0], a1 = dCoef[1], a2 = dCoef[2], a3 = dCoef[3];
      for (let i = 0; i < drawCount; i++) {
        const j = i * 3;
        const d = a0 * pos[j] + a1 * pos[j + 1] + a2 * pos[j + 2] + a3;
        depths[i] = d;
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
      }
    } else {
      for (let i = 0; i < drawCount; i++) {
        const j = i * 3;
        const ob = (oids[i] < numObjs ? oids[i] : 0) * 4;
        const d = dCoef[ob] * pos[j] + dCoef[ob + 1] * pos[j + 1] + dCoef[ob + 2] * pos[j + 2] + dCoef[ob + 3];
        depths[i] = d;
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
      }
    }

    // Reuse ping-pong buffer if large enough (eliminates 140 MB per-sort allocation!)
    const neededBytes = drawCount * 4;
    let order;
    if (recycledBuffer && recycledBuffer.byteLength >= neededBytes) {
      order = new Uint32Array(recycledBuffer, 0, drawCount);
      recycledBuffer = null;
    } else {
      order = new Uint32Array(drawCount);
    }

    const range = maxD - minD;
    if (!(range > 1e-6)) {
      for (let i = 0; i < drawCount; i++) order[i] = i;
      self.postMessage({ type: "sorted", jobId: msg.jobId, drawCount, sortMs: performance.now() - tSort0, order }, [order.buffer]);
      return;
    }

    const BUCKETS = 65536;
    counts.fill(0);
    const inv = (BUCKETS - 1) / range;

    // Back-to-front ordering: more negative viewZ = farther -> bucket 0 first
    for (let i = 0; i < drawCount; i++) {
      let b = ((depths[i] - minD) * inv) | 0;
      if (b < 0) b = 0;
      else if (b >= BUCKETS) b = BUCKETS - 1;
      counts[b]++;
    }

    let sum = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const c = counts[b];
      counts[b] = sum;
      sum += c;
    }

    for (let i = 0; i < drawCount; i++) {
      let b = ((depths[i] - minD) * inv) | 0;
      if (b < 0) b = 0;
      else if (b >= BUCKETS) b = BUCKETS - 1;
      order[counts[b]++] = i;
    }

    self.postMessage(
      { type: "sorted", jobId: msg.jobId, drawCount, sortMs: performance.now() - tSort0, order },
      [order.buffer],
    );
  }
};
