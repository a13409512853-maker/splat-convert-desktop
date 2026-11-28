/**
 * @module domain/edit-session
 * @description Pure, graphics-free EditSession owning:
 *  - Registered source assets (`assetId`, `sha256`, `pointCount`, `orderingVersion`)
 *  - Per-asset source-indexed compact flags (`Uint8Array(pointCount)` indexed strictly by `sourceIndex`)
 *  - Parametric scene volumes (re-evaluated from parameters, distinct from source-pinned point edits)
 *  - Scene-level camera keyframe track (belongs to scene, NOT per-point attributes)
 *  - Preserved legacy/unsupported recipe metadata (prevents silent v4->v3 downgrade or field loss)
 *  - Compact sparse-delta Undo/Redo command history
 *
 * ZERO DOM, ZERO WebGL, ZERO Three.js dependencies.
 */
import {
  POINT_FLAG,
  BOOL_OP_SET,
  ERROR_CODES,
  DomainError,
  AssetVersionMismatchError,
  assertValidAssetIdentity,
  createIdentityMatrix16,
  domainT,
} from "./contracts.mjs";
import { SceneStateStore } from "./scene-state.mjs";

function applyFlagTransitionToCounts(counts, oldF, newF) {
  if (oldF === newF) return;
  const wasDel = (oldF & POINT_FLAG.DELETED) !== 0;
  const nowDel = (newF & POINT_FLAG.DELETED) !== 0;
  const wasSel = !wasDel && (oldF & POINT_FLAG.SELECTED) !== 0;
  const nowSel = !nowDel && (newF & POINT_FLAG.SELECTED) !== 0;
  const wasHid = !wasDel && (oldF & POINT_FLAG.HIDDEN) !== 0;
  const nowHid = !nowDel && (newF & POINT_FLAG.HIDDEN) !== 0;
  if (nowDel !== wasDel) counts.deleted += nowDel ? 1 : -1;
  if (nowSel !== wasSel) counts.selected += nowSel ? 1 : -1;
  if (nowHid !== wasHid) counts.hidden += nowHid ? 1 : -1;
}

export class EditSession {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxHistorySteps=50]
   */
  constructor(opts = {}) {
    this.maxHistorySteps = Math.max(10, Math.min(300, Number(opts.maxHistorySteps) || 50));
    /** @type {Map<string, { identity: object, flags: Uint8Array, entityMatrix: number[], counts: { selected: number, deleted: number, hidden: number } }>} */
    this._assets = new Map();
    this._assetOrder = [];
    this._parametricVolumes = [];
    this._cameraTrack = null;
    this._preservedRecipeMeta = null;
    this.sceneState = new SceneStateStore();
    this._undoStack = [];
    this._redoStack = [];
    this._disposed = false;
  }

  _ensureAlive() {
    if (this._disposed) {
      throw new DomainError(ERROR_CODES.INVALID_COMMAND, "EditSession has already been disposed.");
    }
  }

  /**
   * Register a source asset with its immutable identity & allocate its source-indexed state buffer.
   * Ownership: EditSession allocates & owns `flags: Uint8Array(pointCount)` until `dispose()`.
   */
  registerAsset(identity) {
    this._ensureAlive();
    assertValidAssetIdentity(identity);
    const id = identity.assetId;
    const normalized = Object.freeze({
      assetId: id,
      name: String(identity.name || id),
      uri: String(identity.uri || ""),
      sha256: identity.sha256 ? String(identity.sha256).toLowerCase() : "",
      pointCount: identity.pointCount,
      orderingVersion: String(identity.orderingVersion || "source-v1"),
    });
    const entry = {
      identity: normalized,
      flags: new Uint8Array(normalized.pointCount),
      entityMatrix: Array.isArray(identity.entityMatrix) && identity.entityMatrix.length === 16
        ? identity.entityMatrix.slice()
        : createIdentityMatrix16(),
      counts: { selected: 0, deleted: 0, hidden: 0 },
    };
    if (!this._assets.has(id)) {
      this._assetOrder.push(id);
    }
    this._assets.set(id, entry);
    return entry;
  }

  recomputeAssetCounts(assetId) {
    const entry = this.getAsset(assetId);
    const flags = entry.flags;
    let selected = 0, deleted = 0, hidden = 0;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f & POINT_FLAG.DELETED) deleted++;
      else {
        if (f & POINT_FLAG.SELECTED) selected++;
        if (f & POINT_FLAG.HIDDEN) hidden++;
      }
    }
    entry.counts = { selected, deleted, hidden };
    return entry.counts;
  }

  /**
   * Zero-allocation O(N) RLE range encoder directly from the asset's flags Uint8Array.
   * Eliminates building multi-million-element JS Arrays & O(N log N) sorting on 35M scenes!
   */
  encodeFlagRanges(assetId, flagMask = POINT_FLAG.DELETED) {
    const entry = this.getAsset(assetId);
    const flags = entry.flags;
    const n = flags.length;
    const ranges = [];
    let i = 0;
    while (i < n) {
      if ((flags[i] & flagMask) === 0) {
        i++;
        continue;
      }
      const start = i;
      i++;
      while (i < n && (flags[i] & flagMask) !== 0) i++;
      ranges.push([start, i - start]);
    }
    return ranges;
  }

  getAssetIds() {
    return this._assetOrder.slice();
  }

  getAsset(assetId) {
    this._ensureAlive();
    const entry = this._assets.get(assetId);
    if (!entry) {
      throw new DomainError(ERROR_CODES.UNKNOWN_ASSET, `Unknown assetId "${assetId}".`);
    }
    return entry;
  }

  hasAsset(assetId) {
    return this._assets.has(assetId);
  }

  /**
   * Guard against blindly applying source-pinned point indices to a modified or reordered asset.
   */
  verifyAssetVersion(assetId, expectedBinding) {
    this._ensureAlive();
    if (!expectedBinding) return true;
    const entry = this.getAsset(assetId);
    const id = entry.identity;

    if (
      typeof expectedBinding.pointCount === "number" &&
      expectedBinding.pointCount >= 0 &&
      expectedBinding.pointCount !== id.pointCount
    ) {
      throw new AssetVersionMismatchError(
        domainT(
          "editor.domain.mismatchPointCount",
          { name: id.name, expected: expectedBinding.pointCount, actual: id.pointCount },
          `Source asset "${id.name}" point count changed (recipe ${expectedBinding.pointCount}, current ${id.pointCount}); refused stale indices.`,
        ),
        { assetId, expected: expectedBinding, actual: id },
      );
    }
    if (
      expectedBinding.sha256 &&
      id.sha256 &&
      String(expectedBinding.sha256).toLowerCase() !== id.sha256
    ) {
      throw new AssetVersionMismatchError(
        domainT(
          "editor.domain.mismatchFingerprint",
          { name: id.name },
          `Source asset "${id.name}" content fingerprint changed; refused stale indices.`,
        ),
        { assetId, expected: expectedBinding, actual: id },
      );
    }
    if (
      expectedBinding.orderingVersion &&
      id.orderingVersion &&
      String(expectedBinding.orderingVersion) !== id.orderingVersion
    ) {
      throw new AssetVersionMismatchError(
        domainT(
          "editor.domain.mismatchOrdering",
          { name: id.name, expected: expectedBinding.orderingVersion, actual: id.orderingVersion },
          `Source asset "${id.name}" ordering version changed (recipe ${expectedBinding.orderingVersion}, current ${id.orderingVersion}); refused stale indices.`,
        ),
        { assetId, expected: expectedBinding, actual: id },
      );
    }
    return true;
  }

  setEntityMatrix(assetId, matrix16) {
    const entry = this.getAsset(assetId);
    if (!Array.isArray(matrix16) || matrix16.length !== 16) {
      throw new DomainError(ERROR_CODES.INVALID_COMMAND, "entityMatrix must be a 16-number column-major array.");
    }
    entry.entityMatrix = matrix16.slice();
  }

  setParametricVolumes(volumes) {
    this._ensureAlive();
    this._parametricVolumes = Array.isArray(volumes) ? structuredClone(volumes) : [];
  }

  getParametricVolumes() {
    return structuredClone(this._parametricVolumes);
  }

  /**
   * Camera track belongs strictly to the Scene/Project document, NEVER as a per-point attribute.
   */
  setCameraTrack(track) {
    this._ensureAlive();
    this._cameraTrack = track ? structuredClone(track) : null;
  }

  getCameraTrack() {
    return this._cameraTrack ? structuredClone(this._cameraTrack) : null;
  }

  setPreservedRecipeMeta(meta) {
    this._ensureAlive();
    this._preservedRecipeMeta = meta ? structuredClone(meta) : null;
  }

  getPreservedRecipeMeta() {
    return this._preservedRecipeMeta ? structuredClone(this._preservedRecipeMeta) : null;
  }

  /**
   * Directly sync a source-indexed flag array from legacy non-migrated tools without breaking history.
   */
  replaceAssetFlagsSilent(assetId, nextFlags) {
    const entry = this.getAsset(assetId);
    const len = Math.min(entry.flags.length, nextFlags.length);
    for (let i = 0; i < len; i++) entry.flags[i] = nextFlags[i];
    this.recomputeAssetCounts(assetId);
  }

  /**
   * Sparse O(changed) mirror for legacy non-migrated tools (no O(N) full scan).
   */
  syncExternalDelta(assetId, sourceIndices, nextFlags) {
    const entry = this.getAsset(assetId);
    const flags = entry.flags;
    const counts = entry.counts;
    const maxN = flags.length;
    for (let i = 0; i < sourceIndices.length; i++) {
      const si = sourceIndices[i] >>> 0;
      if (si >= maxN) continue;
      const oldF = flags[si];
      const newF = nextFlags[i];
      if (oldF !== newF) {
        flags[si] = newF;
        applyFlagTransitionToCounts(counts, oldF, newF);
      }
    }
  }

  /**
   * Dispatch a pure domain editing command (point selection/deletion OR persistent scene state).
   * Supported commands:
   *  - { type: 'selectPoints', op: 'replace'|'add'|'subtract'|'intersect', refs, targetAssetId?, label? }
   *  - { type: 'deleteSelected', targetAssetId?, label? }
   *  - { type: 'clearSelection', targetAssetId?, label? }
   *  - { type: 'applyFlagDelta', assetId, indices: Uint32Array, before: Uint8Array, after: Uint8Array, label? }
   *  - { type: 'setObjectTransform', objectId, matrix16, label? }
   *  - { type: 'setSceneGraph', objects, objectGroups, label? }
   *  - { type: 'setVolumesSnapshot', snapshot, label? }
   *  - { type: 'setColorGrade', grade, label? }
   *  - { type: 'setMeasureScale', scaleConfig, label? }
   */
  dispatch(command) {
    this._ensureAlive();
    if (!command || typeof command !== "object" || typeof command.type !== "string") {
      throw new DomainError(ERROR_CODES.INVALID_COMMAND, "Command must be an object with a string type.");
    }

    if (command.type === "selectPoints") {
      return this._execSelectPoints(command);
    }
    if (command.type === "deleteSelected") {
      return this._execDeleteSelected(command);
    }
    if (command.type === "clearSelection") {
      return this._execSelectPoints({
        type: "selectPoints",
        op: "replace",
        refs: [],
        targetAssetId: command.targetAssetId || null,
        label: command.label || domainT("editor.domain.deselect", null, "Deselect"),
      });
    }
    if (command.type === "applyFlagDelta") {
      return this._execApplyFlagDelta(command);
    }
    if (command.type === "setObjectTransform") {
      const { before, after } = this.sceneState.setObjectTransform(command.objectId, command.matrix16);
      if (Number(command.objectId) === 0 && this._assetOrder.length > 0) {
        this.setEntityMatrix(this._assetOrder[0], after);
      }
      const label = command.label || "Transform Object";
      this._pushUndoRecord({
        label,
        type: "setObjectTransform",
        objectId: Number(command.objectId),
        before,
        after,
      });
      return { ok: true, changedCount: 1, dirtyAssetIds: [], deltas: [], label };
    }
    if (command.type === "setSceneGraph") {
      const before = { objects: this.sceneState.getObjects(), objectGroups: this.sceneState.getObjectGroups() };
      this.sceneState.setSceneGraph(command.objects, command.objectGroups);
      const after = { objects: this.sceneState.getObjects(), objectGroups: this.sceneState.getObjectGroups() };
      const label = command.label || "Update Scene Graph";
      this._pushUndoRecord({ label, type: "setSceneGraph", before, after });
      return { ok: true, changedCount: 1, dirtyAssetIds: [], deltas: [], label };
    }
    if (command.type === "setVolumesSnapshot") {
      const { before, after } = this.sceneState.setVolumesSnapshot(command.snapshot);
      this._parametricVolumes = Array.isArray(after.items) ? structuredClone(after.items) : [];
      const label = command.label || "Update Volumes";
      this._pushUndoRecord({ label, type: "setVolumesSnapshot", before, after });
      return { ok: true, changedCount: 1, dirtyAssetIds: [], deltas: [], label };
    }
    if (command.type === "setColorGrade") {
      const { before, after } = this.sceneState.setColorGrade(command.grade);
      const label = command.label || "Color Grade";
      this._pushUndoRecord({ label, type: "setColorGrade", before, after });
      return { ok: true, changedCount: 1, dirtyAssetIds: [], deltas: [], label };
    }
    if (command.type === "setMeasureScale") {
      const { before, after } = this.sceneState.setMeasureScale(command.scaleConfig);
      const label = command.label || "Measure Scale Calibration";
      this._pushUndoRecord({ label, type: "setMeasureScale", before, after });
      return { ok: true, changedCount: 1, dirtyAssetIds: [], deltas: [], label };
    }
    throw new DomainError(ERROR_CODES.INVALID_COMMAND, `Unsupported command type "${command.type}".`);
  }

  _execApplyFlagDelta(cmd) {
    const entry = this.getAsset(cmd.assetId);
    const flags = entry.flags;
    const counts = entry.counts;
    const indices = cmd.indices;
    const beforeIn = cmd.before;
    const afterIn = cmd.after;
    const len = indices ? indices.length : 0;
    if (len === 0) {
      return { ok: true, changedCount: 0, dirtyAssetIds: [], deltas: [], label: cmd.label || "" };
    }
    const outIdx = new Uint32Array(len);
    const outBefore = new Uint8Array(len);
    const outAfter = new Uint8Array(len);
    let ptr = 0;
    for (let i = 0; i < len; i++) {
      const si = indices[i] >>> 0;
      if (si >= flags.length) continue;
      const oldF = beforeIn ? beforeIn[i] : flags[si];
      const newF = afterIn[i];
      if (oldF !== newF) {
        flags[si] = newF;
        applyFlagTransitionToCounts(counts, oldF, newF);
        outIdx[ptr] = si;
        outBefore[ptr] = oldF;
        outAfter[ptr] = newF;
        ptr++;
      }
    }
    const label = cmd.label || "Flag Delta";
    if (ptr === 0) {
      return { ok: true, changedCount: 0, dirtyAssetIds: [], deltas: [], label };
    }
    const delta = {
      assetId: cmd.assetId,
      indices: ptr === len ? outIdx : outIdx.subarray(0, ptr),
      before: ptr === len ? outBefore : outBefore.subarray(0, ptr),
      after: ptr === len ? outAfter : outAfter.subarray(0, ptr),
    };
    this._pushUndoRecord({ label, type: "applyFlagDelta", deltas: [delta] });
    return {
      ok: true,
      changedCount: ptr,
      dirtyAssetIds: [cmd.assetId],
      deltas: [delta],
      label,
    };
  }

  _resolveTargetAssetIds(targetAssetId) {
    if (targetAssetId) {
      this.getAsset(targetAssetId); // validates existence
      return [targetAssetId];
    }
    return this._assetOrder.slice();
  }

  _execSelectPoints(cmd) {
    const op = cmd.op || "replace";
    if (!BOOL_OP_SET.has(op)) {
      throw new DomainError(ERROR_CODES.INVALID_COMMAND, `Invalid boolean selection op "${op}".`);
    }
    const targetIds = this._resolveTargetAssetIds(cmd.targetAssetId || null);
    const targetSet = new Set(targetIds);

    // Collect incoming refs grouped by assetId (zero bitset allocation for sparse fast-paths!)
    /** @type {Map<string, Uint32Array[]>} */
    const refArraysByAsset = new Map();
    for (const aid of targetIds) refArraysByAsset.set(aid, []);

    if (cmd.refs && cmd.refs.kind === "packed" && Array.isArray(cmd.refs.batches)) {
      for (const batch of cmd.refs.batches) {
        if (!batch || !targetSet.has(batch.assetId) || !batch.sourceIndices) continue;
        this.getAsset(batch.assetId);
        if (batch.sourceIndices.length > 0) {
          refArraysByAsset.get(batch.assetId).push(batch.sourceIndices);
        }
      }
    } else if (Array.isArray(cmd.refs) && cmd.refs.length > 0) {
      /** @type {Map<string, number[]>} */
      const tmpByAsset = new Map();
      for (const ref of cmd.refs) {
        if (!ref || typeof ref.assetId !== "string" || !targetSet.has(ref.assetId)) continue;
        this.getAsset(ref.assetId);
        let list = tmpByAsset.get(ref.assetId);
        if (!list) {
          list = [];
          tmpByAsset.set(ref.assetId, list);
        }
        list.push(ref.sourceIndex | 0);
      }
      for (const [aid, list] of tmpByAsset.entries()) {
        refArraysByAsset.get(aid).push(Uint32Array.from(list));
      }
    }

    const deltas = [];
    let totalChanged = 0;

    for (const aid of targetIds) {
      const entry = this._assets.get(aid);
      const flags = entry.flags;
      const counts = entry.counts;
      const n = flags.length;
      const batches = refArraysByAsset.get(aid);
      let rawHitLen = 0;
      for (let b = 0; b < batches.length; b++) rawHitLen += batches[b].length;

      // O(1) no-op fast-paths
      if (rawHitLen === 0 && (op === "add" || op === "subtract" || ((op === "replace" || op === "intersect") && counts.selected === 0))) {
        continue;
      }

      // Sparse O(hitCount) fast-path: ZERO 4.3 MB bitset, ZERO 35M full-cloud scan!
      // Applies to:
      //  - op === "add"
      //  - op === "subtract"
      //  - op === "replace" when current selected === 0
      const canSparseAdd = op === "add" || (op === "replace" && counts.selected === 0);
      const canSparseSub = op === "subtract";
      if ((canSparseAdd || canSparseSub) && rawHitLen <= n * 0.25) {
        const indices = new Uint32Array(rawHitLen);
        const before = new Uint8Array(rawHitLen);
        const after = new Uint8Array(rawHitLen);
        let ptr = 0;
        if (canSparseAdd) {
          for (let b = 0; b < batches.length; b++) {
            const arr = batches[b];
            for (let k = 0; k < arr.length; k++) {
              const sIdx = arr[k] >>> 0;
              if (sIdx >= n) continue;
              const f = flags[sIdx];
              if (f & (POINT_FLAG.DELETED | POINT_FLAG.HIDDEN | POINT_FLAG.SELECTED)) continue;
              const nf = f | POINT_FLAG.SELECTED;
              flags[sIdx] = nf;
              counts.selected++;
              indices[ptr] = sIdx;
              before[ptr] = f;
              after[ptr] = nf;
              ptr++;
            }
          }
        } else {
          for (let b = 0; b < batches.length; b++) {
            const arr = batches[b];
            for (let k = 0; k < arr.length; k++) {
              const sIdx = arr[k] >>> 0;
              if (sIdx >= n) continue;
              const f = flags[sIdx];
              if ((f & (POINT_FLAG.DELETED | POINT_FLAG.HIDDEN)) || !(f & POINT_FLAG.SELECTED)) continue;
              const nf = f & ~POINT_FLAG.SELECTED;
              flags[sIdx] = nf;
              counts.selected--;
              indices[ptr] = sIdx;
              before[ptr] = f;
              after[ptr] = nf;
              ptr++;
            }
          }
        }
        if (ptr > 0) {
          totalChanged += ptr;
          deltas.push({
            assetId: aid,
            indices: ptr === rawHitLen ? indices : indices.subarray(0, ptr),
            before: ptr === rawHitLen ? before : before.subarray(0, ptr),
            after: ptr === rawHitLen ? after : after.subarray(0, ptr),
          });
        }
        continue;
      }

      // Compact per-asset hit bitset (4.3 MB for 35M points) for dense replace / intersect
      const bits = new Uint8Array((n + 7) >> 3);
      for (let b = 0; b < batches.length; b++) {
        const arr = batches[b];
        for (let k = 0; k < arr.length; k++) {
          const sIdx = arr[k] >>> 0;
          if (sIdx < n) bits[sIdx >> 3] |= 1 << (sIdx & 7);
        }
      }

      // Pass 1: count exact changes so TypedArrays allocate once with ZERO JS array growth!
      let changed = 0;
      for (let sIdx = 0; sIdx < n; sIdx++) {
        const f = flags[sIdx];
        if (f & (POINT_FLAG.DELETED | POINT_FLAG.HIDDEN)) continue;
        const was = (f & POINT_FLAG.SELECTED) !== 0;
        const hit = (bits[sIdx >> 3] & (1 << (sIdx & 7))) !== 0;
        let next = was;
        if (op === "replace") next = hit;
        else if (op === "add") next = was || hit;
        else if (op === "subtract") next = was && !hit;
        else if (op === "intersect") next = was && hit;
        if (next !== was) changed++;
      }

      if (changed > 0) {
        const indices = new Uint32Array(changed);
        const before = new Uint8Array(changed);
        const after = new Uint8Array(changed);
        let ptr = 0;
        for (let sIdx = 0; sIdx < n; sIdx++) {
          const f = flags[sIdx];
          if (f & (POINT_FLAG.DELETED | POINT_FLAG.HIDDEN)) continue;
          const was = (f & POINT_FLAG.SELECTED) !== 0;
          const hit = (bits[sIdx >> 3] & (1 << (sIdx & 7))) !== 0;
          let next = was;
          if (op === "replace") next = hit;
          else if (op === "add") next = was || hit;
          else if (op === "subtract") next = was && !hit;
          else if (op === "intersect") next = was && hit;
          if (next !== was) {
            const nf = next ? (f | POINT_FLAG.SELECTED) : (f & ~POINT_FLAG.SELECTED);
            flags[sIdx] = nf;
            counts.selected += next ? 1 : -1;
            indices[ptr] = sIdx;
            before[ptr] = f;
            after[ptr] = nf;
            ptr++;
          }
        }
        totalChanged += changed;
        deltas.push({ assetId: aid, indices, before, after });
      }
    }

    const label = cmd.label || domainT("editor.domain.selectOpFallback", { op }, `Selection (${op})`);
    if (totalChanged > 0) {
      this._pushUndoRecord({ label, type: "selectPoints", deltas });
    }
    return {
      ok: true,
      changedCount: totalChanged,
      dirtyAssetIds: deltas.map((d) => d.assetId),
      deltas,
      label,
    };
  }

  _execDeleteSelected(cmd) {
    const targetIds = this._resolveTargetAssetIds(cmd.targetAssetId || null);
    const deltas = [];
    let totalChanged = 0;

    for (const aid of targetIds) {
      const entry = this._assets.get(aid);
      const flags = entry.flags;
      const counts = entry.counts;
      const n = flags.length;

      if (counts.selected <= 0) continue;

      // Exact pre-allocation using O(1) cached selected count (single pass instead of 2 passes over 35M points!)
      const expected = counts.selected;
      const indices = new Uint32Array(expected);
      const before = new Uint8Array(expected);
      const after = new Uint8Array(expected);
      let ptr = 0;
      for (let sIdx = 0; sIdx < n; sIdx++) {
        const f = flags[sIdx];
        if (!(f & POINT_FLAG.DELETED) && (f & POINT_FLAG.SELECTED)) {
          const nf = (f | POINT_FLAG.DELETED) & ~POINT_FLAG.SELECTED;
          flags[sIdx] = nf;
          if (ptr < expected) {
            indices[ptr] = sIdx;
            before[ptr] = f;
            after[ptr] = nf;
          }
          ptr++;
        }
      }
      if (ptr > expected) {
        // Safety fallback if cached count ever drifted: recompute exact delta
        this.recomputeAssetCounts(aid);
        continue;
      }
      if (ptr > 0) {
        counts.deleted += ptr;
        counts.selected -= ptr;
        totalChanged += ptr;
        deltas.push({
          assetId: aid,
          indices: ptr === expected ? indices : indices.subarray(0, ptr),
          before: ptr === expected ? before : before.subarray(0, ptr),
          after: ptr === expected ? after : after.subarray(0, ptr),
        });
      }
    }

    const label = cmd.label || domainT("editor.domain.softDelete", null, "Soft Delete");
    if (totalChanged > 0) {
      this._pushUndoRecord({ label, type: "deleteSelected", deltas });
    }
    return {
      ok: true,
      changedCount: totalChanged,
      dirtyAssetIds: deltas.map((d) => d.assetId),
      deltas,
      label,
    };
  }

  _pushUndoRecord(rec) {
    this._undoStack.push(rec);
    this._redoStack.length = 0;
    while (this._undoStack.length > this.maxHistorySteps) {
      this._undoStack.shift();
    }
  }

  _applyRecord(rec, forward) {
    if (rec.deltas) {
      let changedCount = 0;
      const dirtyAssetIds = [];
      for (const d of rec.deltas) {
        const entry = this._assets.get(d.assetId);
        if (!entry) continue;
        const src = forward ? d.after : d.before;
        const prev = forward ? d.before : d.after;
        const idx = d.indices;
        const flags = entry.flags;
        const counts = entry.counts;
        for (let i = 0; i < idx.length; i++) {
          const si = idx[i];
          const oldF = flags[si];
          const newF = src[i];
          flags[si] = newF;
          applyFlagTransitionToCounts(counts, oldF, newF);
        }
        changedCount += idx.length;
        dirtyAssetIds.push(d.assetId);
        void prev;
      }
      return { changedCount, dirtyAssetIds, deltas: rec.deltas };
    }
    if (rec.type === "setObjectTransform") {
      const m = forward ? rec.after : rec.before;
      this.sceneState.setObjectTransform(rec.objectId, m);
      if (rec.objectId === 0 && this._assetOrder.length > 0) this.setEntityMatrix(this._assetOrder[0], m);
      return { changedCount: 1, dirtyAssetIds: [], deltas: [] };
    }
    if (rec.type === "setSceneGraph") {
      const s = forward ? rec.after : rec.before;
      this.sceneState.setSceneGraph(s.objects, s.objectGroups);
      return { changedCount: 1, dirtyAssetIds: [], deltas: [] };
    }
    if (rec.type === "setVolumesSnapshot") {
      const s = forward ? rec.after : rec.before;
      this.sceneState.setVolumesSnapshot(s);
      this._parametricVolumes = Array.isArray(s?.items) ? structuredClone(s.items) : [];
      return { changedCount: 1, dirtyAssetIds: [], deltas: [] };
    }
    if (rec.type === "setColorGrade") {
      this.sceneState.setColorGrade(forward ? rec.after : rec.before);
      return { changedCount: 1, dirtyAssetIds: [], deltas: [] };
    }
    if (rec.type === "setMeasureScale") {
      this.sceneState.setMeasureScale(forward ? rec.after : rec.before);
      return { changedCount: 1, dirtyAssetIds: [], deltas: [] };
    }
    return { changedCount: 0, dirtyAssetIds: [], deltas: [] };
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }

  undo() {
    this._ensureAlive();
    const rec = this._undoStack.pop();
    if (!rec) return { ok: false, changedCount: 0, dirtyAssetIds: [], deltas: [], label: "" };
    const { changedCount, dirtyAssetIds, deltas } = this._applyRecord(rec, false);
    this._redoStack.push(rec);
    return { ok: true, changedCount, dirtyAssetIds, deltas, label: rec.label };
  }

  redo() {
    this._ensureAlive();
    const rec = this._redoStack.pop();
    if (!rec) return { ok: false, changedCount: 0, dirtyAssetIds: [], deltas: [], label: "" };
    const { changedCount, dirtyAssetIds, deltas } = this._applyRecord(rec, true);
    this._undoStack.push(rec);
    return { ok: true, changedCount, dirtyAssetIds, deltas, label: rec.label };
  }

  getDeletedSourceIndices(assetId) {
    const entry = this.getAsset(assetId);
    const out = [];
    const flags = entry.flags;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] & POINT_FLAG.DELETED) out.push(i);
    }
    return out;
  }

  getSelectedSourceIndices(assetId) {
    const entry = this.getAsset(assetId);
    const out = [];
    const flags = entry.flags;
    for (let i = 0; i < flags.length; i++) {
      if (!(flags[i] & POINT_FLAG.DELETED) && (flags[i] & POINT_FLAG.SELECTED)) out.push(i);
    }
    return out;
  }

  getStats(assetId = null) {
    this._ensureAlive();
    const ids = assetId ? [assetId] : this._assetOrder;
    let total = 0, selected = 0, deleted = 0, hidden = 0;
    for (const aid of ids) {
      const entry = this.getAsset(aid);
      total += entry.flags.length;
      selected += entry.counts.selected;
      deleted += entry.counts.deleted;
      hidden += entry.counts.hidden;
    }
    return {
      total,
      selected,
      deleted,
      hidden,
      undoCount: this._undoStack.length,
      redoCount: this._redoStack.length,
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const entry of this._assets.values()) {
      entry.flags = null;
    }
    this._assets.clear();
    this._assetOrder.length = 0;
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._parametricVolumes = [];
    this._cameraTrack = null;
    this._preservedRecipeMeta = null;
    this.sceneState.dispose();
  }
}
