#!/usr/bin/env node
/**
 * 002-A Step 3 Verification Suite:
 *  1. EditSession single-writer O(1) counts & sparse O(hitCount) fast paths
 *  2. Zero-alloc encodeFlagRanges parity vs legacy range encoding
 *  3. Real ThreePreviewAdapter sparse vs bulk GPU stateTex upload parity on permuted & subsampled indices,
 *     proving syncToSessionCalls === 0 during normal box-select / delete / undo / redo & external sparse deltas
 *  4. Persistent SceneStateStore commands (objects, groups, volumes, colorGrade, measureScale)
 *     + Undo/Redo + Recipe encode/decode + PLY v4 bake round-trip!
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threeUrl = pathToFileURL(path.join(repoRoot, "windows", "editor", "vendor", "three.module.min.js")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "three") return { url: threeUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { POINT_FLAG } = await import("../windows/editor/domain/contracts.mjs");
const { EditSession } = await import("../windows/editor/domain/edit-session.mjs");
const { ThreePreviewAdapter } = await import("../windows/editor/domain/three-preview-adapter.mjs");
const { encodeProjectRecipe, decodeRecipeIntoSession } = await import("../windows/editor/domain/recipe-codec.mjs");
const { encodeIndexRanges } = await import("../windows/editor/history.js");
const { processPlyV3, layout } = await import("../windows/editor/ply.mjs");

const results = [];
function runCheck(name, fn) {
  fn();
  results.push({ name, ok: true });
}

// Mock Cloud implementing exact syncVisualStateSparse / syncVisualStateFull pixel packing
function createMockCloud(srcIdx, objectIds = null) {
  const n = srcIdx.length;
  const texW = 64;
  const texH = Math.max(1, Math.ceil(n / texW));
  const stateData = new Uint8Array(texW * texH * 4);
  const flags = new Uint8Array(n);
  const objIds = objectIds ? new Uint16Array(objectIds) : new Uint16Array(n);
  const objectVisibility = new Map([[0, true], [1, true]]);
  const rowUploads = [];

  const packState = (i, activeObjs) => {
    const f = flags[i];
    const oid = objIds[i];
    const objVis = objectVisibility.get(oid) !== false;
    const isActive = !activeObjs || activeObjs.size === 0 || activeObjs.has(oid);
    const o = i * 4;
    stateData[o] = (f & POINT_FLAG.SELECTED) ? 255 : 0;
    stateData[o + 1] = ((f & (POINT_FLAG.DELETED | POINT_FLAG.HIDDEN)) || !objVis) ? 255 : 0;
    stateData[o + 2] = isActive ? 255 : 0;
    stateData[o + 3] = 0;
  };

  let lastSelectedCount = 0;
  let lastDeletedCount = 0;
  let lastHiddenCount = 0;

  return {
    n,
    originalCount: n,
    srcIdx: new Uint32Array(srcIdx),
    flags,
    objectIds: objIds,
    objectVisibility,
    texW,
    texH,
    stateData,
    material: { uniforms: { uHasSelection: { value: 0.0 } } },
    rowUploads,
    syncVisualStateFull(activeObjs = null) {
      let sel = 0, del = 0, hid = 0;
      for (let i = 0; i < n; i++) {
        const f = flags[i];
        if (f & POINT_FLAG.DELETED) del++;
        else if (f & POINT_FLAG.HIDDEN) hid++;
        else if (f & POINT_FLAG.SELECTED) sel++;
        packState(i, activeObjs);
      }
      lastSelectedCount = sel;
      lastDeletedCount = del;
      lastHiddenCount = hid;
      this.material.uniforms.uHasSelection.value = sel > 0 ? 1.0 : 0.0;
      rowUploads.push({ mode: "full", rows: texH });
      return { total: n, selected: sel, deleted: del, hidden: hid, syncMode: "bulk-full", copiedBytes: texW * texH * 4 };
    },
    syncVisualStateSparse(changedIndices, activeObjs = null) {
      if (!changedIndices || changedIndices.length === 0) {
        return { total: n, selected: lastSelectedCount, deleted: lastDeletedCount, hidden: lastHiddenCount, syncMode: "sparse-noop", copiedBytes: 0 };
      }
      if (changedIndices.length > n * 0.12) {
        return this.syncVisualStateFull(activeObjs);
      }
      const dirtyRows = new Uint8Array(texH);
      let dirtyRowCount = 0;
      for (let k = 0; k < changedIndices.length; k++) {
        const idx = changedIndices[k];
        if (idx < 0 || idx >= n) continue;
        packState(idx, activeObjs);
        const row = (idx / texW) | 0;
        if (!dirtyRows[row]) {
          dirtyRows[row] = 1;
          dirtyRowCount++;
        }
      }
      if (dirtyRowCount > texH * 0.35) {
        return this.syncVisualStateFull(activeObjs);
      }
      let sel = 0, del = 0, hid = 0;
      for (let i = 0; i < n; i++) {
        const f = flags[i];
        if (f & POINT_FLAG.DELETED) del++;
        else if (f & POINT_FLAG.HIDDEN) hid++;
        else if (f & POINT_FLAG.SELECTED) sel++;
      }
      lastSelectedCount = sel;
      lastDeletedCount = del;
      lastHiddenCount = hid;
      this.material.uniforms.uHasSelection.value = sel > 0 ? 1.0 : 0.0;
      const copiedBytes = dirtyRowCount * texW * 4;
      rowUploads.push({ mode: "sparse", rows: dirtyRowCount, points: changedIndices.length });
      return { total: n, selected: sel, deleted: del, hidden: hid, syncMode: "sparse-rows", copiedBytes };
    },
    syncVisualState(activeObjs = null) {
      return this.syncVisualStateFull(activeObjs);
    },
  };
}

function assertStateTexParity(cloud, label) {
  const snapshot = new Uint8Array(cloud.stateData);
  const prevUniform = cloud.material.uniforms.uHasSelection.value;
  cloud.syncVisualStateFull(null);
  assert.equal(cloud.material.uniforms.uHasSelection.value, prevUniform, `${label}: uHasSelection mismatch`);
  for (let i = 0; i < snapshot.length; i++) {
    if (snapshot[i] !== cloud.stateData[i]) {
      assert.fail(`${label}: stateData byte ${i} mismatch (sparse=${snapshot[i]} vs full=${cloud.stateData[i]})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 1: EditSession single-writer O(1) counts, sparse select paths & encodeFlagRanges
// ---------------------------------------------------------------------------
runCheck("EditSession sparse select paths + O(1) counts + zero-alloc encodeFlagRanges", () => {
  const N = 20000;
  const session = new EditSession({ maxHistorySteps: 50 });
  session.registerAsset({ assetId: "primary", pointCount: N });

  const r1 = session.dispatch({
    type: "selectPoints",
    op: "replace",
    refs: [10, 11, 12, 500, 501, 502, 19999].map((si) => ({ assetId: "primary", sourceIndex: si })),
  });
  assert.equal(r1.changedCount, 7);
  assert.equal(session.getStats("primary").selected, 7);
  assert.equal(r1.deltas.length, 1);
  assert.equal(r1.deltas[0].indices.length, 7);

  const r2 = session.dispatch({
    type: "selectPoints",
    op: "add",
    refs: { kind: "packed", batches: [{ assetId: "primary", sourceIndices: new Uint32Array([12, 13, 14, 15000]) }] },
  });
  assert.equal(r2.changedCount, 3);
  assert.equal(session.getStats("primary").selected, 10);

  const r3 = session.dispatch({
    type: "selectPoints",
    op: "subtract",
    refs: { kind: "packed", batches: [{ assetId: "primary", sourceIndices: new Uint32Array([11, 12, 9999]) }] },
  });
  assert.equal(r3.changedCount, 2);
  assert.equal(session.getStats("primary").selected, 8);

  const r4 = session.dispatch({ type: "deleteSelected", targetAssetId: "primary" });
  assert.equal(r4.changedCount, 8);
  const st4 = session.getStats("primary");
  assert.equal(st4.selected, 0);
  assert.equal(st4.deleted, 8);
  assert.equal(st4.hidden, 0);

  const fastRanges = session.encodeFlagRanges("primary", POINT_FLAG.DELETED);
  const legacyRanges = encodeIndexRanges(session.getDeletedSourceIndices("primary"));
  assert.deepEqual(fastRanges, legacyRanges, "encodeFlagRanges must match encodeIndexRanges exactly");

  const u1 = session.undo();
  assert.equal(u1.ok, true);
  assert.equal(u1.deltas.length, 1);
  const stU = session.getStats("primary");
  assert.equal(stU.selected, 8);
  assert.equal(stU.deleted, 0);

  const red1 = session.redo();
  assert.equal(red1.ok, true);
  const stR = session.getStats("primary");
  assert.equal(stR.selected, 0);
  assert.equal(stR.deleted, 8);
});

// ---------------------------------------------------------------------------
// Check 2: Real ThreePreviewAdapter sparse vs bulk parity + syncToSessionCalls === 0
// ---------------------------------------------------------------------------
runCheck("ThreePreviewAdapter sparse sync parity on permuted subsampled cloud (syncToSessionCalls===0)", () => {
  const totalSource = 4096;
  const srcIdx = [];
  for (let i = 0; i < totalSource; i += 2) srcIdx.push((i * 17 + 5) % totalSource);
  const cloud = createMockCloud(srcIdx);
  cloud.syncVisualStateFull(null);

  const session = new EditSession({ maxHistorySteps: 30 });
  session.registerAsset({ assetId: "a0", pointCount: totalSource });

  const adapter = new ThreePreviewAdapter({
    cloud,
    assetId: "a0",
    renderer: null,
    getCamera: () => null,
    getViewportSize: () => ({ w: 800, h: 600 }),
    getDisplayMode: () => "splat",
    getActiveObjectIds: () => null,
  });
  adapter.resetTelemetry();

  // 2a. Small sparse box select (5 hits -> sparse row upload!)
  const hits1 = new Uint32Array([srcIdx[3], srcIdx[4], srcIdx[5], srcIdx[120], srcIdx[121]]);
  const res1 = session.dispatch({
    type: "selectPoints",
    op: "replace",
    refs: { kind: "packed", batches: [{ assetId: "a0", sourceIndices: hits1 }] },
    label: "box1",
  });
  adapter.syncFromSession(session, res1.dirtyAssetIds, res1.deltas);
  assert.equal(res1.changedCount, 5);
  assertStateTexParity(cloud, "after sparse box1");

  const tel1 = adapter.getTelemetry();
  assert.equal(tel1.syncToSessionCalls, 0, "MUST NEVER scan cloud back to session on normal box-select");
  assert.equal(tel1.sparseSyncCalls, 1, "Expected 1 sparse sync call");
  assert.equal(tel1.bulkSyncCalls, 0, "Expected 0 bulk sync calls for small hit set");

  // 2b. Sparse delete + undo + redo
  const delRes = session.dispatch({ type: "deleteSelected", targetAssetId: "a0" });
  adapter.syncFromSession(session, delRes.dirtyAssetIds, delRes.deltas);
  assertStateTexParity(cloud, "after sparse delete");

  const undoRes = session.undo();
  adapter.syncFromSession(session, undoRes.dirtyAssetIds, undoRes.deltas);
  assertStateTexParity(cloud, "after sparse undo");

  const redoRes = session.redo();
  adapter.syncFromSession(session, redoRes.dirtyAssetIds, redoRes.deltas);
  assertStateTexParity(cloud, "after sparse redo");

  const tel2 = adapter.getTelemetry();
  assert.equal(tel2.syncToSessionCalls, 0);
  assert.equal(tel2.sparseSyncCalls, 4);
  assert.equal(tel2.bulkSyncCalls, 0);

  // 2c. Dense edit (> 12% of cloud) -> seamless automatic bulk upload fallback + exact parity!
  const bigHits = new Uint32Array(srcIdx.slice(0, Math.floor(srcIdx.length * 0.4)));
  const resBig = session.dispatch({
    type: "selectPoints",
    op: "replace",
    refs: { kind: "packed", batches: [{ assetId: "a0", sourceIndices: bigHits }] },
    label: "bigBox",
  });
  adapter.syncFromSession(session, resBig.dirtyAssetIds, resBig.deltas);
  assertStateTexParity(cloud, "after large bulk box");
  const tel3 = adapter.getTelemetry();
  assert.equal(tel3.syncToSessionCalls, 0);
  assert.ok(tel3.bulkSyncCalls >= 1, "Dense edit must automatically use bulk upload");

  // 2d. External sparse delta (e.g. brush / eyedropper) via syncDeltaToSession
  const preFlag = cloud.flags[10];
  cloud.flags[10] |= POINT_FLAG.HIDDEN;
  adapter.syncDeltaToSession(session, {
    indices: new Uint32Array([10]),
    before: new Uint8Array([preFlag]),
    after: new Uint8Array([cloud.flags[10]]),
  }, true);
  assert.equal(session.getAsset("a0").flags[srcIdx[10]] & POINT_FLAG.HIDDEN, POINT_FLAG.HIDDEN);
  assert.equal(adapter.getTelemetry().syncToSessionCalls, 0, "syncDeltaToSession must NOT trigger full scan");
});

// ---------------------------------------------------------------------------
// Check 3: Persistent SceneStateStore commands + undo/redo + Recipe -> PLY v4 bake round-trip
// ---------------------------------------------------------------------------
runCheck("SceneStateStore commands + undo/redo + recipe save/reopen + PLY v4 bake round-trip", () => {
  const N = 12;
  const session = new EditSession({ maxHistorySteps: 40 });
  session.registerAsset({ assetId: "primary", name: "scene.ply", sha256: "abc123", pointCount: N });

  const shiftedMat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, -2, 4, 1];
  session.dispatch({ type: "setObjectTransform", objectId: 0, matrix16: shiftedMat, label: "Move main" });
  assert.deepEqual(session.sceneState.getObjects()[0].matrix, shiftedMat);

  const volSnap = {
    primitiveCoordSystem: "y-up",
    items: [{ id: 1, kind: "cylinder", pos: [0, 1, 0], quat: [0, 0, 0, 1], scale: [1, 2, 1], enabled: true }],
    groups: [],
  };
  session.dispatch({ type: "setVolumesSnapshot", snapshot: volSnap, label: "Add cylinder" });
  assert.equal(session.sceneState.getVolumesSnapshot().items.length, 1);

  session.dispatch({ type: "setColorGrade", grade: { enabled: true, brightness: 0.15, saturation: 1.2 }, label: "Grade" });
  assert.equal(session.sceneState.getColorGrade().brightness, 0.15);

  session.dispatch({ type: "setMeasureScale", scaleConfig: { factor: 2.5, unit: "cm", calibrated: true }, label: "Calibrate" });
  assert.equal(session.sceneState.getMeasureScale().factor, 2.5);
  assert.equal(session.sceneState.getMeasureScale().unit, "cm");

  session.undo();
  assert.equal(session.sceneState.getMeasureScale().factor, 1.0);
  session.redo();
  assert.equal(session.sceneState.getMeasureScale().factor, 2.5);

  session.dispatch({
    type: "selectPoints",
    op: "replace",
    refs: { kind: "packed", batches: [{ assetId: "primary", sourceIndices: new Uint32Array([0, 1]) }] },
  });
  session.dispatch({ type: "deleteSelected", targetAssetId: "primary" });

  const { recipe } = encodeProjectRecipe(session, {
    primaryAssetId: "primary",
    baseV3Payload: {
      objects: [{
        id: 0,
        name: "Main",
        visible: true,
        sourceKind: "original",
        memberRanges: "all",
        matrix: session.sceneState.getObjects()[0].matrix,
        deletedRanges: session.encodeFlagRanges("primary", POINT_FLAG.DELETED),
        bakedGrades: [{ targetRanges: "all", grade: session.sceneState.getColorGrade() }],
      }],
      volumes: session.sceneState.getVolumesSnapshot(),
      measureScale: session.sceneState.getMeasureScale(),
    },
  });
  assert.equal(recipe.version, 3);
  assert.equal(recipe.coordSystem, "y-up");

  const session2 = new EditSession();
  session2.registerAsset({ assetId: "primary", name: "scene.ply", sha256: "abc123", pointCount: N });
  const decoded = decodeRecipeIntoSession(recipe, session2, { primaryAssetId: "primary" });
  assert.equal(decoded.compatibility.supported, true);
  assert.equal(decoded.appliedDeletedCount, 2);
  assert.deepEqual(session2.getDeletedSourceIndices("primary"), [0, 1]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "splat-state-rt-"));
  try {
    const inPly = path.join(tmpDir, "in.ply");
    const outPly = path.join(tmpDir, "out.ply");
    const header = [
      "ply",
      "format binary_little_endian 1.0",
      `element vertex ${N}`,
      "property float x",
      "property float y",
      "property float z",
      "property float f_dc_0",
      "property float f_dc_1",
      "property float f_dc_2",
      "property float opacity",
      "property float scale_0",
      "property float scale_1",
      "property float scale_2",
      "property float rot_0",
      "property float rot_1",
      "property float rot_2",
      "property float rot_3",
      "end_header\n",
    ].join("\n");
    const buf = Buffer.alloc(N * 14 * 4);
    for (let i = 0; i < N; i++) {
      const o = i * 56;
      buf.writeFloatLE(i, o + 0);
      buf.writeFloatLE(i * 0.5, o + 4);
      buf.writeFloatLE(-i, o + 8);
      buf.writeFloatLE(0.0, o + 12);
      buf.writeFloatLE(0.0, o + 16);
      buf.writeFloatLE(0.0, o + 20);
      buf.writeFloatLE(2.0, o + 24);
      buf.writeFloatLE(-2.0, o + 28);
      buf.writeFloatLE(-2.0, o + 32);
      buf.writeFloatLE(-2.0, o + 36);
      buf.writeFloatLE(1.0, o + 40);
      buf.writeFloatLE(0.0, o + 44);
      buf.writeFloatLE(0.0, o + 48);
      buf.writeFloatLE(0.0, o + 52);
    }
    fs.writeFileSync(inPly, Buffer.concat([Buffer.from(header, "ascii"), buf]));
    const kept = processPlyV3(inPly, outPly, recipe, null);
    assert.equal(kept, N - 2);
    const outFd = fs.openSync(outPly, "r");
    try {
      const outLayout = layout(outFd);
      assert.equal(outLayout.count, N - 2);
      const firstPt = Buffer.alloc(12);
      fs.readSync(outFd, firstPt, 0, 12, outLayout.start);
      // Original pt 2 was (2, 1, -2), shifted by (+3, -2, +4) -> (5, -1, 2)
      assert.ok(Math.abs(firstPt.readFloatLE(0) - 5.0) < 1e-4);
      assert.ok(Math.abs(firstPt.readFloatLE(4) - (-1.0)) < 1e-4);
      assert.ok(Math.abs(firstPt.readFloatLE(8) - 2.0) < 1e-4);
    } finally {
      fs.closeSync(outFd);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({ ok: true, passed: results.length, total: results.length, checks: results }, null, 2));
