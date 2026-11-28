/**
 * @module domain/three-preview-adapter
 * @description Thin preview-backend adapter implementing IPreviewBackend on top of the
 * existing Three.js WebGL2 `Cloud` + `selection.js` engine.
 *
 * Architectural Boundary:
 * - This adapter is the ONLY file in `domain/` permitted to interact with Three.js / `Cloud`.
 * - It owns the fast O(1) mapping between backend-internal `previewIndex` (which is
 *   64-splat block-permuted in `Cloud`, so `previewIndex !== sourceIndex`) and the domain's
 *   canonical `(assetId, sourceIndex)` identity.
 * - `pickInRect()` NEVER mutates `EditSession`; it only returns `PreviewPointRef[]`.
 * - `syncFromSession()` consumes read-only flags from `EditSession` and updates GPU textures.
 */
import * as T from "three";
import { FLAG_SELECTED, FLAG_DELETED, FLAG_HIDDEN, decodePickId } from "../cloud.js";
import { projectedGaussianEllipseExtentsNdc } from "../selection.js";
import { POINT_FLAG } from "./contracts.mjs";

export class ThreePreviewAdapter {
  /**
   * @param {object} opts
   * @param {import("../cloud.js").Cloud} opts.cloud
   * @param {string} opts.assetId
   * @param {T.WebGLRenderer} opts.renderer
   * @param {() => T.Camera} opts.getCamera
   * @param {() => { w: number, h: number }} opts.getViewportSize
   * @param {() => string} opts.getDisplayMode
   * @param {() => Set<number>|null} [opts.getActiveObjectIds]
   * @param {(stats: object) => void} [opts.onStatsUpdated]
   */
  constructor(opts) {
    this.cloud = opts.cloud;
    this.assetId = opts.assetId;
    this.renderer = opts.renderer;
    this.getCamera = opts.getCamera;
    this.getViewportSize = opts.getViewportSize;
    this.getDisplayMode = opts.getDisplayMode;
    this.getActiveObjectIds = opts.getActiveObjectIds || (() => null);
    this.onStatsUpdated = opts.onStatsUpdated || null;

    this._srcToPreview = null;
    this._rebuildSourceIndexMap();
    this._telemetry = {
      syncToSessionCalls: 0,
      syncFromSessionCalls: 0,
      deltaToSessionCalls: 0,
      sparseSyncCalls: 0,
      bulkSyncCalls: 0,
      totalScannedPoints: 0,
      totalCopiedBytes: 0,
      totalSyncMs: 0,
      lastOp: null,
      recentOps: [],
    };
  }

  resetTelemetry() {
    this._telemetry = {
      syncToSessionCalls: 0,
      syncFromSessionCalls: 0,
      deltaToSessionCalls: 0,
      sparseSyncCalls: 0,
      bulkSyncCalls: 0,
      totalScannedPoints: 0,
      totalCopiedBytes: 0,
      totalSyncMs: 0,
      lastOp: null,
      recentOps: [],
    };
  }

  getTelemetry() {
    return structuredClone(this._telemetry);
  }

  _recordTel(opName, mode, scannedPoints, copiedBytes, elapsedMs) {
    const t = this._telemetry;
    t.totalScannedPoints += scannedPoints;
    t.totalCopiedBytes += copiedBytes;
    t.totalSyncMs = Number((t.totalSyncMs + elapsedMs).toFixed(3));
    const entry = {
      op: opName,
      mode,
      scannedPoints,
      copiedBytes,
      ms: Number(elapsedMs.toFixed(3)),
    };
    t.lastOp = entry;
    t.recentOps.push(entry);
    if (t.recentOps.length > 30) t.recentOps.shift();
  }

  _rebuildSourceIndexMap() {
    if (!this.cloud) {
      this._srcToPreview = null;
      return;
    }
    const origN = this.cloud.originalCount | 0;
    let maxSrc = origN;
    const srcIdx = this.cloud.srcIdx;
    for (let i = 0; i < origN; i++) {
      if (srcIdx[i] >= maxSrc) maxSrc = srcIdx[i] + 1;
    }
    const map = new Int32Array(maxSrc);
    map.fill(-1);
    for (let i = 0; i < origN; i++) {
      map[srcIdx[i]] = i;
    }
    this._srcToPreview = map;
  }

  getPointMapping(previewIndex) {
    if (!this.cloud || previewIndex < 0 || previewIndex >= this.cloud.n) return null;
    return {
      assetId: this.assetId,
      previewIndex,
      sourceIndex: this.cloud.srcIdx[previewIndex] >>> 0,
    };
  }

  /**
   * Pick all non-deleted, non-hidden points inside `rectNdc = { minX, maxX, minY, maxY }`
   * and return asset-qualified canonical `{ assetId, previewIndex, sourceIndex }` references.
   * Does NOT mutate `cloud.flags` or `EditSession`.
   */
  pickInRect({
    rectNdc,
    onlyVisible = false,
    wholeGaussian = false,
    targetAssetId = null,
    worldScopeFn = null,
    activeObjectIds = null,
  }) {
    if (!this.cloud) return [];
    if (targetAssetId && targetAssetId !== this.assetId) return [];

    const cloud = this.cloud;
    const camera = this.getCamera();
    const { w: viewportW, h: viewportH } = this.getViewportSize();
    const displayMode = this.getDisplayMode();
    const minX = Math.min(rectNdc.minX, rectNdc.maxX);
    const maxX = Math.max(rectNdc.minX, rectNdc.maxX);
    const minY = Math.min(rectNdc.minY, rectNdc.maxY);
    const maxY = Math.max(rectNdc.minY, rectNdc.maxY);

    const flags = cloud.flags;
    const oids = cloud.objectIds;
    const vis = cloud.objectVisibility;
    const pos = cloud.pos;
    const mats = cloud.objectMatrices;
    const effActive = activeObjectIds || this.getActiveObjectIds();

    const passesFilter = (i) => {
      const f = flags[i];
      if ((f & FLAG_DELETED) || (f & FLAG_HIDDEN) || vis.get(oids[i]) === false) return false;
      if (effActive && effActive.size > 0 && !effActive.has(oids[i])) return false;
      if (worldScopeFn) {
        const j = i * 3;
        const lx = pos[j], ly = pos[j + 1], lz = pos[j + 2];
        const m = mats[oids[i]]?.elements;
        const ok = m
          ? worldScopeFn(
              m[0] * lx + m[4] * ly + m[8] * lz + m[12],
              m[1] * lx + m[5] * ly + m[9] * lz + m[13],
              m[2] * lx + m[6] * ly + m[10] * lz + m[14],
            )
          : worldScopeFn(lx, ly, lz);
        if (!ok) return false;
      }
      return true;
    };

    // Packed zero-GC columnar result scales cleanly to 35M+ Gaussians (no 30M JS objects!)
    let hitBuf = new Uint32Array(Math.min(Math.max(1024, cloud.n >> 4), 1048576));
    let hitCount = 0;
    const pushHit = (sIdx) => {
      if (hitCount >= hitBuf.length) {
        const next = new Uint32Array(Math.min(cloud.n, hitBuf.length * 2));
        next.set(hitBuf);
        hitBuf = next;
      }
      hitBuf[hitCount++] = sIdx;
    };

    if (onlyVisible && this.renderer) {
      const scale = Math.min(1, 960 / Math.max(viewportW, viewportH, 1));
      const pw = Math.max(64, Math.round(viewportW * scale));
      const ph = Math.max(64, Math.round(viewportH * scale));
      const pickMode = wholeGaussian ? (displayMode === "points" ? "rings" : displayMode) : displayMode;
      const { pixels } = cloud.renderPickBuffer(
        this.renderer, camera, pw, ph, pickMode, pickMode === "splat" ? 0.04 : 0.0,
      );
      const px0 = Math.max(0, Math.floor((minX * 0.5 + 0.5) * pw));
      const px1 = Math.min(pw - 1, Math.ceil((maxX * 0.5 + 0.5) * pw));
      const py0 = Math.max(0, Math.floor((minY * 0.5 + 0.5) * ph));
      const py1 = Math.min(ph - 1, Math.ceil((maxY * 0.5 + 0.5) * ph));
      const seen = new Uint8Array((cloud.n + 7) >> 3);
      const vpMat = !wholeGaussian
        ? new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        : null;
      const mvpByObj = vpMat
        ? mats.map((om) => new T.Matrix4().multiplyMatrices(vpMat, om).elements)
        : null;

      for (let py = py0; py <= py1; py++) {
        const ndcY = ((py + 0.5) / ph) * 2 - 1;
        if (ndcY < minY || ndcY > maxY) continue;
        for (let px = px0; px <= px1; px++) {
          const ndcX = ((px + 0.5) / pw) * 2 - 1;
          if (ndcX < minX || ndcX > maxX) continue;
          const id1 = decodePickId(pixels, (py * pw + px) * 4);
          if (id1 === 0) continue;
          const idx = id1 - 1;
          if (idx >= cloud.n || (seen[idx >> 3] & (1 << (idx & 7)))) continue;
          seen[idx >> 3] |= 1 << (idx & 7);
          if (!passesFilter(idx)) continue;
          if (!wholeGaussian && mvpByObj) {
            const e = mvpByObj[oids[idx]] || mvpByObj[0];
            const j = idx * 3;
            const x = pos[j], y = pos[j + 1], z = pos[j + 2];
            const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
            if (cw <= 1e-5) continue;
            const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
            const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
            if (cx < minX || cx > maxX || cy < minY || cy > maxY) continue;
          }
          pushHit(cloud.srcIdx[idx] >>> 0);
        }
      }
      return {
        kind: "packed",
        batches: [{ assetId: this.assetId, sourceIndices: hitBuf.subarray(0, hitCount) }],
        count: hitCount,
      };
    }

    // Through-selection path (honors wholeGaussian 2*sqrt(2)*sigma projected ellipse parity!)
    const vpMat = new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const mvpByObj = mats.map((om) => new T.Matrix4().multiplyMatrices(vpMat, om).elements);
    const isOrtho = !!camera.isOrthographicCamera;
    const n = cloud.n;
    const srcIdx = cloud.srcIdx;
    const pad = wholeGaussian ? 0.8 : 0;

    for (let i = 0; i < n; i++) {
      if (!passesFilter(i)) continue;
      const e = mvpByObj[oids[i]] || mvpByObj[0];
      const j = i * 3;
      const x = pos[j], y = pos[j + 1], z = pos[j + 2];
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (!isOrtho && cw <= 1e-5) continue;
      const invW = isOrtho ? 1 : 1 / cw;
      const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) * invW;
      const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) * invW;
      const cz = (e[2] * x + e[6] * y + e[10] * z + e[14]) * invW;
      if (cz < -1 || cz > 1) continue;
      if (cx < minX - pad || cx > maxX + pad || cy < minY - pad || cy > maxY + pad) continue;
      let ex = 0, ey = 0;
      if (wholeGaussian) {
        const ext = projectedGaussianEllipseExtentsNdc(cloud, i, e, cx, cy, isOrtho ? 1 : cw, isOrtho);
        ex = ext.ex;
        ey = ext.ey;
      }
      if (cx + ex >= minX && cx - ex <= maxX && cy + ey >= minY && cy - ey <= maxY) {
        pushHit(srcIdx[i] >>> 0);
      }
    }
    return {
      kind: "packed",
      batches: [{ assetId: this.assetId, sourceIndices: hitBuf.subarray(0, hitCount) }],
      count: hitCount,
    };
  }

  /**
   * Consume canonical source-indexed flags from EditSession and push to GPU state texture.
   * Uses O(changed) sparse delta sync + dirty texture row uploads whenever delta density <= 12%,
   * transparently switching to bulk O(origN) full sync for dense edits or `forceFull: true`.
   */
  syncFromSession(editSession, dirtyAssetIds = null, deltas = null, opts = {}) {
    if (!this.cloud || !editSession || !editSession.hasAsset(this.assetId)) return null;
    if (dirtyAssetIds && !dirtyAssetIds.includes(this.assetId)) return null;

    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    this._telemetry.syncFromSessionCalls++;

    const entry = editSession.getAsset(this.assetId);
    const sFlags = entry.flags;
    const cFlags = this.cloud.flags;
    const srcIdx = this.cloud.srcIdx;
    const origN = this.cloud.originalCount | 0;
    const forceFull = !!opts.forceFull;

    // Locate sparse delta for this asset if supplied
    let assetDelta = null;
    if (!forceFull && Array.isArray(deltas)) {
      for (let k = 0; k < deltas.length; k++) {
        if (deltas[k] && deltas[k].assetId === this.assetId && deltas[k].indices) {
          assetDelta = deltas[k];
          break;
        }
      }
    }

    const map = this._srcToPreview;
    if (!forceFull && assetDelta && map && assetDelta.indices.length <= origN * 0.12) {
      const idxArr = assetDelta.indices;
      const changedPreview = new Uint32Array(idxArr.length);
      let written = 0;
      for (let j = 0; j < idxArr.length; j++) {
        const si = idxArr[j] >>> 0;
        if (si < map.length) {
          const pi = map[si];
          if (pi >= 0 && pi < origN) {
            cFlags[pi] = sFlags[si];
            changedPreview[written++] = pi;
          }
        }
      }
      const sub = written === changedPreview.length ? changedPreview : changedPreview.subarray(0, written);
      const stats = typeof this.cloud.syncVisualStateSparse === "function"
        ? this.cloud.syncVisualStateSparse(sub, this.getActiveObjectIds())
        : this.cloud.syncVisualState(this.getActiveObjectIds());
      const dt = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
      if (stats?.syncMode && stats.syncMode.startsWith("sparse")) {
        this._telemetry.sparseSyncCalls++;
      } else {
        this._telemetry.bulkSyncCalls++;
      }
      this._recordTel("syncFromSession", stats?.syncMode || "sparse", idxArr.length, (stats?.copiedBytes ?? written), dt);
      if (typeof this.onStatsUpdated === "function") this.onStatsUpdated(stats);
      return stats;
    }

    // Bulk path (high density >12%, no delta, or explicit forceFull reference sync)
    for (let i = 0; i < origN; i++) {
      const si = srcIdx[i];
      if (si < sFlags.length) {
        cFlags[i] = sFlags[si];
      }
    }
    const stats = typeof this.cloud.syncVisualStateFull === "function"
      ? this.cloud.syncVisualStateFull(this.getActiveObjectIds())
      : this.cloud.syncVisualState(this.getActiveObjectIds());
    const dt = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    this._telemetry.bulkSyncCalls++;
    this._recordTel("syncFromSession", stats?.syncMode || "bulk-full", origN, (stats?.copiedBytes ?? origN * 4), dt);
    if (typeof this.onStatsUpdated === "function") this.onStatsUpdated(stats);
    return stats;
  }

  /**
   * Sparse O(changed) mirror from a legacy Cloud delta `{ indices, before, after }` into EditSession.
   * Eliminates O(origN) full-cloud scans when non-migrated tools (lasso/brush/eyedropper/etc.) commit!
   */
  syncDeltaToSession(editSession, cloudDelta, forward = true) {
    if (!this.cloud || !editSession || !editSession.hasAsset(this.assetId) || !cloudDelta?.indices) return 0;
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    this._telemetry.deltaToSessionCalls++;

    const origN = this.cloud.originalCount | 0;
    const srcIdx = this.cloud.srcIdx;
    const idxArr = cloudDelta.indices;
    const vals = forward ? cloudDelta.after : cloudDelta.before;
    const mask = POINT_FLAG.SELECTED | POINT_FLAG.DELETED | POINT_FLAG.HIDDEN;

    const srcIndices = new Uint32Array(idxArr.length);
    const nextFlags = new Uint8Array(idxArr.length);
    let count = 0;
    for (let j = 0; j < idxArr.length; j++) {
      const pi = idxArr[j] >>> 0;
      if (pi >= origN) continue; // ignore duplicated/synthetic appended points
      srcIndices[count] = srcIdx[pi] >>> 0;
      nextFlags[count] = vals[j] & mask;
      count++;
    }
    if (count > 0 && typeof editSession.syncExternalDelta === "function") {
      editSession.syncExternalDelta(
        this.assetId,
        count === srcIndices.length ? srcIndices : srcIndices.subarray(0, count),
        count === nextFlags.length ? nextFlags : nextFlags.subarray(0, count),
      );
    }
    const dt = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    this._recordTel("syncDeltaToSession", "sparse-delta", count, count * 5, dt);
    return count;
  }

  /**
   * Full O(origN) fallback mirror from Cloud back into EditSession (used ONLY on full restore/explicit verify).
   */
  syncCloudToSession(editSession) {
    if (!this.cloud || !editSession || !editSession.hasAsset(this.assetId)) return;
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    this._telemetry.syncToSessionCalls++;
    const entry = editSession.getAsset(this.assetId);
    const sFlags = entry.flags;
    const cFlags = this.cloud.flags;
    const srcIdx = this.cloud.srcIdx;
    const origN = this.cloud.originalCount | 0;
    const mask = POINT_FLAG.SELECTED | POINT_FLAG.DELETED | POINT_FLAG.HIDDEN;
    for (let i = 0; i < origN; i++) {
      const si = srcIdx[i];
      if (si < sFlags.length) {
        sFlags[si] = cFlags[i] & mask;
      }
    }
    if (typeof editSession.recomputeAssetCounts === "function") {
      editSession.recomputeAssetCounts(this.assetId);
    }
    const dt = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    this._recordTel("syncCloudToSession", "bulk-full", origN, origN, dt);
  }

  dispose() {
    this._srcToPreview = null;
    this.cloud = null;
    this.renderer = null;
  }
}
