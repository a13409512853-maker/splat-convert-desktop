#!/usr/bin/env node
/**
 * 002-A Step 1 Regression Suite:
 *   1. Historical v4 recipe coordSystem ("z-up") + source-space matrix round-trip fidelity
 *   2. Asymmetric v4 local edit + reopen + real processPlyV4 export verification
 *   3. Missing vs unrecognized coordSystem read-only protection
 *   4. Historical v3 z-up cylinder migration (rotated + non-uniform scale + nested VolumeGroup +
 *      non-cylinder controls + axial/radial boundary points + 1000-point agreement + boolean export +
 *      strict 2x save/reopen idempotency)
 *   5. Legacy v1/v2 rules.mjs cylinder predicate (z-up default vs explicit y-up)
 *
 * ZERO DOM, ZERO WebGL dependencies. Runs directly in Node.js.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EditSession } from "../windows/editor/domain/edit-session.mjs";
import {
  inspectRecipeCompatibility,
  decodeRecipeIntoSession,
  encodeProjectRecipe,
  encodeBoolRle,
  encodeIndexRanges,
  migrateLegacyZUpCylinderTrs,
  migrateRecipeVolumesToYUp,
} from "../windows/editor/domain/recipe-codec.mjs";
import { POINT_FLAG, COORD_CONTRACT } from "../windows/editor/domain/contracts.mjs";
import { compile as compileRules } from "../windows/editor/rules.mjs";
import { layout, readExact, processPlyV3, processPlyV4 } from "../windows/editor/ply.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "splat-coord-compat-"));

// Pure column-major 4x4 matrix math for exact TRS ground-truth verification (matches THREE.Matrix4)
function eulerXyzToMat4(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Rx * Ry * Rz
  const m00 = cy * cz;
  const m01 = -cy * sz;
  const m02 = sy;
  const m10 = sx * sy * cz + cx * sz;
  const m11 = -sx * sy * sz + cx * cz;
  const m12 = -sx * cy;
  const m20 = -cx * sy * cz + sx * sz;
  const m21 = cx * sy * sz + sx * cz;
  const m22 = cx * cy;
  return [
    m00, m10, m20, 0,
    m01, m11, m21, 0,
    m02, m12, m22, 0,
    0, 0, 0, 1,
  ];
}

function mulMat4(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function composeTrs(pos, rot, scale) {
  const R = eulerXyzToMat4(rot[0], rot[1], rot[2]);
  const [sx, sy, sz] = scale;
  return [
    R[0] * sx, R[1] * sx, R[2] * sx, 0,
    R[4] * sy, R[5] * sy, R[6] * sy, 0,
    R[8] * sz, R[9] * sz, R[10] * sz, 0,
    pos[0], pos[1], pos[2], 1,
  ];
}

function invertAffineMat4(m) {
  // Exact 4x4 inverse via Gauss-Jordan
  const aug = [];
  for (let r = 0; r < 4; r++) {
    aug.push([m[r], m[4 + r], m[8 + r], m[12 + r], r === 0 ? 1 : 0, r === 1 ? 1 : 0, r === 2 ? 1 : 0, r === 3 ? 1 : 0]);
  }
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[piv][col])) piv = r;
    }
    [aug[col], aug[piv]] = [aug[piv], aug[col]];
    const d = aug[col][col];
    for (let j = 0; j < 8; j++) aug[col][j] /= d;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = aug[r][col];
      for (let j = 0; j < 8; j++) aug[r][j] -= f * aug[col][j];
    }
  }
  const inv = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) inv[c * 4 + r] = aug[r][4 + c];
  }
  return inv;
}

function transformPt(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function writeTestPly(filePath, points) {
  const header = [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${points.length}`,
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
  const hb = Buffer.from(header, "latin1");
  const stride = 14 * 4;
  const body = Buffer.alloc(points.length * stride);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const off = i * stride;
    body.writeFloatLE(p[0], off + 0);
    body.writeFloatLE(p[1], off + 4);
    body.writeFloatLE(p[2], off + 8);
    body.writeFloatLE(0.2 + i * 0.01, off + 12);
    body.writeFloatLE(-0.1, off + 16);
    body.writeFloatLE(0.3, off + 20);
    body.writeFloatLE(2.0, off + 24);
    body.writeFloatLE(-2.0, off + 28);
    body.writeFloatLE(-2.5, off + 32);
    body.writeFloatLE(-3.0, off + 36);
    body.writeFloatLE(1.0, off + 40);
    body.writeFloatLE(0.0, off + 44);
    body.writeFloatLE(0.0, off + 48);
    body.writeFloatLE(0.0, off + 52);
  }
  fs.writeFileSync(filePath, Buffer.concat([hb, body]));
}

function readPlyPositions(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const l = layout(fd);
    const buf = Buffer.alloc(l.count * l.stride);
    readExact(fd, buf, buf.length, l.start);
    const rX = l.accessor("x"), rY = l.accessor("y"), rZ = l.accessor("z");
    const rDc0 = l.accessor("f_dc_0"), rDc1 = l.accessor("f_dc_1"), rDc2 = l.accessor("f_dc_2");
    const pts = [];
    for (let i = 0; i < l.count; i++) {
      const off = i * l.stride;
      pts.push({
        pos: [rX(buf, off), rY(buf, off), rZ(buf, off)],
        dc: [rDc0(buf, off), rDc1(buf, off), rDc2(buf, off)],
      });
    }
    return pts;
  } finally {
    fs.closeSync(fd);
  }
}

const results = [];
function pass(name, detail) {
  results.push({ name, passed: true, detail });
  console.log(`[PASS] ${name}: ${detail}`);
}

try {
  // -------------------------------------------------------------------------
  // 1. GPT's exact reproducible v4 round-trip case (coordSystem="z-up" + [0,0,7])
  // -------------------------------------------------------------------------
  {
    const session = new EditSession();
    session.registerAsset({ assetId: "primary", name: "pt1.ply", sha256: "aa11", pointCount: 1 });
    const matZ7 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 7, 1];
    const v4In = {
      version: 4,
      engine: "resplat",
      coordSystem: "z-up",
      pointCount: 1,
      deletedCount: 0,
      deletedRle: [],
      entityDeltaMatrix: matZ7.slice(),
      paletteMatrices: [matZ7.slice()],
    };
    const dec = decodeRecipeIntoSession(v4In, session, { primaryAssetId: "primary" });
    assert.equal(dec.compatibility.supported, true);
    assert.equal(dec.compatibility.coordSystem, "z-up");
    assert.equal(dec.compatibility.matrixSpace, "source");

    const enc = encodeProjectRecipe(session, { primaryAssetId: "primary" });
    assert.equal(enc.blocked, false);
    assert.equal(enc.recipe.version, 4);
    assert.equal(enc.recipe.coordSystem, "z-up", "v4 z-up label MUST be preserved verbatim on save!");
    assert.equal(enc.recipe.matrixSpace, "source");
    assert.deepEqual(enc.recipe.entityDeltaMatrix, matZ7);
    assert.deepEqual(enc.recipe.paletteMatrices[0], matZ7);
    session.dispose();
    pass("1_v4_gpt_repro_coord_label_fidelity", "v4 coordSystem='z-up' and both [0,0,7] matrices preserved verbatim without silent overwrite");
  }

  // -------------------------------------------------------------------------
  // 2. Asymmetric historical v4 sample: zero-edit save, local delete edit, reopen, & processPlyV4 export
  // -------------------------------------------------------------------------
  {
    const srcPts = [
      [1.0, 2.0, 3.0],
      [-0.5, 4.0, -1.5],
      [2.5, -3.0, 0.75],
      [0.0, 0.0, 10.0],
      [-3.0, 1.25, 2.5],
    ];
    const plyIn = path.join(workDir, "v4-asym-src.ply");
    writeTestPly(plyIn, srcPts);

    const entityMat = composeTrs([1.75, -2.5, 4.25], [0.35, -0.62, 0.48], [1, 1, 1]);
    const subPal1 = composeTrs([-0.4, 0.9, -1.1], [0.2, 0.3, -0.25], [1, 1, 1]);
    const idMat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    const histV4 = {
      version: 4,
      engine: "resplat",
      coordSystem: "z-up",
      pointCount: 5,
      deletedCount: 1,
      deletedRle: encodeBoolRle(5, (i) => i === 1),
      entityDeltaMatrix: entityMat,
      paletteMatrices: [idMat, subPal1],
      transformIdxRle: [0, 2, 1, 2, 0, 1], // [val, run]: pts 0..1 -> 0, pts 2..3 -> 1, pt 4 -> 0
      paintDelta: { indices: [0], dc: [0.99, -0.88, 0.77] },
      colorGrade: { enabled: false },
    };

    // Pass A: Read -> zero-edit save -> export
    const s1 = new EditSession();
    s1.registerAsset({ assetId: "primary", name: "v4-asym-src.ply", sha256: "bb22", pointCount: 5 });
    decodeRecipeIntoSession(histV4, s1, { primaryAssetId: "primary" });
    const encZero = encodeProjectRecipe(s1, { primaryAssetId: "primary" });
    assert.equal(encZero.recipe.coordSystem, "z-up");
    assert.deepEqual(encZero.recipe.paletteMatrices, histV4.paletteMatrices);
    assert.deepEqual(encZero.recipe.paintDelta, histV4.paintDelta);

    const outZero = path.join(workDir, "v4-zero-edit.ply");
    processPlyV4(plyIn, outZero, encZero.recipe);
    const exportedZero = readPlyPositions(outZero);
    assert.equal(exportedZero.length, 4);

    // Verify exact asymmetric transformed positions (ZERO axis flip!)
    const expectedIdxsA = [0, 2, 3, 4];
    const palComb1 = mulMat4(entityMat, subPal1);
    for (let k = 0; k < expectedIdxsA.length; k++) {
      const idx = expectedIdxsA[k];
      const mat = (idx === 2 || idx === 3) ? palComb1 : entityMat;
      const exp = transformPt(mat, srcPts[idx]);
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(exportedZero[k].pos[c] - exp[c]) < 1e-4, `Zero-edit pt ${idx} axis ${c} mismatch`);
      }
    }
    // Verify paintDelta on pt 0 preserved
    assert.ok(Math.abs(exportedZero[0].dc[0] - 0.99) < 1e-4);

    // Pass B: Local edit (delete pt 4) -> save -> reopen -> export
    s1.dispatch({ type: "selectPoints", op: "replace", refs: [{ assetId: "primary", sourceIndex: 4 }] });
    s1.dispatch({ type: "deleteSelected" });
    const encEdited = encodeProjectRecipe(s1, { primaryAssetId: "primary" });
    assert.equal(encEdited.recipe.coordSystem, "z-up");
    assert.equal(encEdited.recipe.deletedCount, 2);

    const s2 = new EditSession();
    s2.registerAsset({ assetId: "primary", name: "v4-asym-src.ply", sha256: "bb22", pointCount: 5 });
    const dec2 = decodeRecipeIntoSession(encEdited.recipe, s2, { primaryAssetId: "primary" });
    assert.equal(dec2.appliedDeletedCount, 2);
    const encReopened = encodeProjectRecipe(s2, { primaryAssetId: "primary" });
    assert.equal(encReopened.recipe.coordSystem, "z-up");

    const outEdited = path.join(workDir, "v4-edited.ply");
    processPlyV4(plyIn, outEdited, encReopened.recipe);
    const exportedEdited = readPlyPositions(outEdited);
    assert.equal(exportedEdited.length, 3); // pts 0, 2, 3 survive
    const expectedIdxsB = [0, 2, 3];
    for (let k = 0; k < expectedIdxsB.length; k++) {
      const idx = expectedIdxsB[k];
      const mat = (idx === 2 || idx === 3) ? palComb1 : entityMat;
      const exp = transformPt(mat, srcPts[idx]);
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(exportedEdited[k].pos[c] - exp[c]) < 1e-4, `Edited pt ${idx} axis ${c} mismatch`);
      }
    }
    s1.dispose();
    s2.dispose();
    pass("2_v4_asymmetric_roundtrip_and_export", "Zero-edit & local-delete v4 roundtrip preserved z-up tag, paletteMatrices, paintDelta, and exact 3-axis positions (<1e-4)");
  }

  // -------------------------------------------------------------------------
  // 3. Missing coordSystem inference & unrecognized coordSystem read-only block
  // -------------------------------------------------------------------------
  {
    const missingV4 = { version: 4, deletedRle: [], entityDeltaMatrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] };
    const cMiss = inspectRecipeCompatibility(missingV4);
    assert.equal(cMiss.supported, true);
    assert.equal(cMiss.coordSystem, "z-up");
    assert.equal(cMiss.coordSystemInferred, true);

    const bogusCoord = { version: 3, coordSystem: "left-handed-mystery", objects: [{ id: 0 }] };
    const cBogus = inspectRecipeCompatibility(bogusCoord);
    assert.equal(cBogus.supported, false);
    assert.equal(cBogus.readOnly, true);
    assert.equal(cBogus.requiresPreservation, true);

    const sBogus = new EditSession();
    sBogus.registerAsset({ assetId: "primary", name: "x.ply", sha256: "cc33", pointCount: 2 });
    decodeRecipeIntoSession(bogusCoord, sBogus, { primaryAssetId: "primary" });
    const encBlocked = encodeProjectRecipe(sBogus, { primaryAssetId: "primary" });
    assert.equal(encBlocked.blocked, true);
    assert.equal(encBlocked.preservedOriginal, true);
    assert.equal(encBlocked.recipe.coordSystem, "left-handed-mystery");
    sBogus.dispose();
    pass("3_missing_and_unrecognized_coord_guard", "Missing tag inferred by version evidence; unknown coordSystem opened read-only and blocked silent overwrite");
  }

  // -------------------------------------------------------------------------
  // 4. Historical v3 z-up cylinder migration: rotated + non-uniform scale + nested group +
  //    non-cylinder controls + axial/radial points + 1000-pt agreement + boolean export + 2x idempotency
  // -------------------------------------------------------------------------
  {
    const cylLoose = {
      id: "vol_1",
      kind: "cylinder",
      name: "Rotated NonUniform Cyl",
      enabled: true,
      visible: true,
      groupId: null,
      boolOp: "union",
      position: [1.2, -0.7, 2.5],
      rotation: [0.43, -0.77, 0.31],
      scale: [1.5, 2.7, 4.2], // asymmetric radial X=1.5, radial Y=2.7, axial Z=4.2!
      initialPosition: [1.2, -0.7, 2.5],
      initialRotation: [0.43, -0.77, 0.31],
      initialScale: [1.5, 2.7, 4.2],
    };
    const grpParent = {
      id: "vgrp_1",
      name: "Rotated Scaled Group",
      enabled: true,
      visible: true,
      collapsed: false,
      parentGroupId: null,
      boolOp: "union",
      position: [-2.0, 1.0, 0.5],
      rotation: [0.22, 0.51, -0.34],
      scale: [1.2, 0.8, 1.5],
      childIds: ["vol_2", "vol_3"],
    };
    const boxInGroup = {
      id: "vol_2",
      kind: "box",
      name: "Control Box",
      enabled: true,
      visible: true,
      groupId: "vgrp_1",
      boolOp: "union",
      position: [0.3, -0.2, 0.1],
      rotation: [0.15, -0.4, 0.25],
      scale: [2.4, 1.8, 3.1],
    };
    const cylInGroup = {
      id: "vol_3",
      kind: "cylinder",
      name: "Nested Subtract Cyl",
      enabled: true,
      visible: true,
      groupId: "vgrp_1",
      boolOp: "subtract",
      position: [0.25, 0.15, -0.2],
      rotation: [-0.55, 0.38, 0.72],
      scale: [0.9, 1.6, 2.5],
    };
    const ellControl = {
      id: "vol_4",
      kind: "ellipsoid",
      name: "Control Ellipsoid",
      enabled: true,
      visible: true,
      groupId: null,
      boolOp: "union",
      position: [3.0, 1.0, -2.0],
      rotation: [0.3, 0.6, -0.2],
      scale: [1.1, 2.2, 3.3],
    };

    const legacySnap = {
      topLevelOrder: ["vol_1", "vgrp_1", "vol_4"],
      groups: [grpParent],
      items: [cylLoose, boxInGroup, cylInGroup, ellControl],
    };

    // Migrate Pass 1 (z-up -> y-up)
    const mig1 = migrateRecipeVolumesToYUp(legacySnap, "z-up", 3);
    assert.equal(mig1.migratedCount, 2, "Exactly 2 cylinders migrated");
    assert.equal(mig1.volumes.primitiveCoordSystem, "y-up");

    // Verify non-cylinder controls untouched bit-for-bit!
    const boxAfter = mig1.volumes.items.find((x) => x.id === "vol_2");
    const ellAfter = mig1.volumes.items.find((x) => x.id === "vol_4");
    assert.deepEqual(boxAfter.position, boxInGroup.position);
    assert.deepEqual(boxAfter.rotation, boxInGroup.rotation);
    assert.deepEqual(boxAfter.scale, boxInGroup.scale);
    assert.deepEqual(ellAfter.position, ellControl.position);
    assert.deepEqual(ellAfter.rotation, ellControl.rotation);
    assert.deepEqual(ellAfter.scale, ellControl.scale);

    // Verify exact mathematical equivalence of old z-up cylinder vs migrated y-up cylinder
    const oldLooseM = composeTrs(cylLoose.position, cylLoose.rotation, cylLoose.scale);
    const oldLooseInv = invertAffineMat4(oldLooseM);
    const cylLooseAfter = mig1.volumes.items.find((x) => x.id === "vol_1");
    const newLooseM = composeTrs(cylLooseAfter.position, cylLooseAfter.rotation, cylLooseAfter.scale);
    const newLooseInv = invertAffineMat4(newLooseM);

    const hitOldZUp = (inv, p) => {
      const [a, b, c] = transformPt(inv, p);
      return a * a + b * b <= 1 + 1e-9 && Math.abs(c) <= 1 + 1e-9;
    };
    const hitNewYUp = (inv, p) => {
      const [a, b, c] = transformPt(inv, p);
      return a * a + c * c <= 1 + 1e-9 && Math.abs(b) <= 1 + 1e-9;
    };

    // Explicit axial & radial boundary probes in old local space transformed to world
    const probesLocalOld = [
      [0, 0, 0.95], [0, 0, -0.95], [0, 0, 1.05], [0, 0, -1.05],       // axial +/-Z
      [0.95, 0, 0], [-0.95, 0, 0], [1.05, 0, 0], [-1.05, 0, 0],       // radial +/-X (scale=1.5)
      [0, 0.95, 0], [0, -0.95, 0], [0, 1.05, 0], [0, -1.05, 0],       // radial +/-Y (scale=2.7)
      [0.68, 0.68, 0.95], [0.75, 0.75, 0.95],                         // diagonal radial in/out
    ];
    let maxCoordErr = 0;
    for (const lp of probesLocalOld) {
      const wp = transformPt(oldLooseM, lp);
      const [a, b, c] = transformPt(oldLooseInv, wp);
      const [ap, bp, cp] = transformPt(newLooseInv, wp);
      // Exact mapping invariant: (a', b', c') === (a, c, -b)
      maxCoordErr = Math.max(maxCoordErr, Math.abs(ap - a), Math.abs(bp - c), Math.abs(cp + b));
      assert.equal(hitNewYUp(newLooseInv, wp), hitOldZUp(oldLooseInv, wp), `Boundary probe mismatch at old local ${lp}`);
    }
    assert.ok(maxCoordErr < 1e-11, `Expected <1e-11 local coordinate error, got ${maxCoordErr}`);

    // Nested rotated+scaled VolumeGroup boolean test (box - cylinder) across 1,000 random points!
    const grpM = composeTrs(grpParent.position, grpParent.rotation, grpParent.scale);
    const oldBoxInv = invertAffineMat4(mulMat4(grpM, composeTrs(boxInGroup.position, boxInGroup.rotation, boxInGroup.scale)));
    const oldSubCylInv = invertAffineMat4(mulMat4(grpM, composeTrs(cylInGroup.position, cylInGroup.rotation, cylInGroup.scale)));
    const cylGroupAfter = mig1.volumes.items.find((x) => x.id === "vol_3");
    const newSubCylInv = invertAffineMat4(mulMat4(grpM, composeTrs(cylGroupAfter.position, cylGroupAfter.rotation, cylGroupAfter.scale)));

    const hitBox = (inv, p) => {
      const [a, b, c] = transformPt(inv, p);
      return Math.abs(a) <= 1 && Math.abs(b) <= 1 && Math.abs(c) <= 1;
    };

    let seed = 424242;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const testCloudPts = [];
    let looseHits = 0, groupHits = 0;
    for (let i = 0; i < 1000; i++) {
      const wp = [-6 + rand() * 12, -6 + rand() * 12, -6 + rand() * 12];
      testCloudPts.push(wp);
      const oL = hitOldZUp(oldLooseInv, wp);
      const nL = hitNewYUp(newLooseInv, wp);
      assert.equal(nL, oL, `Loose cylinder mismatch at sample ${i}`);
      if (oL) looseHits++;

      const oG = hitBox(oldBoxInv, wp) && !hitOldZUp(oldSubCylInv, wp);
      const nG = hitBox(oldBoxInv, wp) && !hitNewYUp(newSubCylInv, wp);
      assert.equal(nG, oG, `Nested boolean (box - cyl) mismatch at sample ${i}`);
      if (oG) groupHits++;
    }
    assert.ok(looseHits > 10 && groupHits > 10, `Expected non-trivial hits: loose=${looseHits}, group=${groupHits}`);

    // Boolean selection + PLY export agreement check
    const v3PlyIn = path.join(workDir, "v3-cyl-src.ply");
    writeTestPly(v3PlyIn, testCloudPts);
    const delOld = [], delNew = [];
    for (let i = 0; i < testCloudPts.length; i++) {
      const wp = testCloudPts[i];
      if (hitOldZUp(oldLooseInv, wp) || (hitBox(oldBoxInv, wp) && !hitOldZUp(oldSubCylInv, wp))) delOld.push(i);
      if (hitNewYUp(newLooseInv, wp) || (hitBox(oldBoxInv, wp) && !hitNewYUp(newSubCylInv, wp))) delNew.push(i);
    }
    assert.deepEqual(delNew, delOld);

    const v3Recipe = {
      version: 3,
      coordSystem: "y-up",
      exportObjectIds: [0],
      deletedRanges: encodeIndexRanges(delNew),
      objects: [{ id: 0, name: "main", sourceKind: "original", memberRanges: "all", excludedRanges: [], deletedRanges: encodeIndexRanges(delNew), matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], bakedGrades: [] }],
      volumes: mig1.volumes,
    };
    const v3PlyOut = path.join(workDir, "v3-cyl-out.ply");
    processPlyV3(v3PlyIn, v3PlyOut, v3Recipe);
    const v3Exported = readPlyPositions(v3PlyOut);
    assert.equal(v3Exported.length, 1000 - delOld.length);

    // Double save/reopen idempotency: Save #1 -> Reopen #1 -> Save #2 -> Reopen #2
    const sV3a = new EditSession();
    sV3a.registerAsset({ assetId: "primary", name: "v3-cyl-src.ply", sha256: "dd44", pointCount: 1000 });
    const legacyV3Full = {
      version: 3,
      coordSystem: "z-up",
      exportObjectIds: [0],
      deletedRanges: [],
      objects: [{ id: 0, name: "main", sourceKind: "original", memberRanges: "all", excludedRanges: [], deletedRanges: [], matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], bakedGrades: [] }],
      volumes: legacySnap,
    };
    const decA = decodeRecipeIntoSession(legacyV3Full, sV3a, { primaryAssetId: "primary" });
    assert.equal(decA.migratedCylinderCount, 2);
    const encA = encodeProjectRecipe(sV3a, {
      primaryAssetId: "primary",
      baseV3Payload: { ...legacyV3Full, coordSystem: "y-up", volumes: mig1.volumes },
    });
    assert.equal(encA.recipe.coordSystem, "y-up");
    assert.equal(encA.recipe.volumes.primitiveCoordSystem, "y-up");

    // Reopen #2 & Save #2 -> MUST NOT migrate a second time!
    const sV3b = new EditSession();
    sV3b.registerAsset({ assetId: "primary", name: "v3-cyl-src.ply", sha256: "dd44", pointCount: 1000 });
    const decB = decodeRecipeIntoSession(encA.recipe, sV3b, { primaryAssetId: "primary" });
    assert.equal(decB.migratedCylinderCount, 0, "Second reopen MUST migrate 0 cylinders (idempotent)!");
    const mig2 = migrateRecipeVolumesToYUp(encA.recipe.volumes, encA.recipe.coordSystem, 3);
    assert.equal(mig2.migratedCount, 0);
    assert.deepEqual(mig2.volumes.items[0].rotation, mig1.volumes.items[0].rotation);
    assert.deepEqual(mig2.volumes.items[0].scale, mig1.volumes.items[0].scale);
    sV3a.dispose();
    sV3b.dispose();

    pass(
      "4_v3_cylinder_migration_math_and_idempotency",
      `Loose+nested rotated non-uniform cylinders 1000/1000 exact match (maxCoordErr=${maxCoordErr.toExponential(2)}), box/ellipsoid untouched, export=${v3Exported.length} pts, 2x reopen migratedCount=0`,
    );
  }

  // -------------------------------------------------------------------------
  // 5. rules.mjs v1/v2 cylinder predicate check (z-up legacy default vs explicit y-up)
  // -------------------------------------------------------------------------
  {
    const idMat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // Scaled cylinder: inverse matrix scales (x,y,z) -> (x/1, y/2, z/4)
    const invM = [1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1];
    const v1ZUpRule = {
      version: 1,
      translation: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      rules: [{ op: "replace", kind: "cylinder", m: invM }],
    };
    const predZ = compileRules(v1ZUpRule);
    // In z-up: |z|<=4 is axial, x^2+(y/2)^2<=1 is radial -> (0, 0, 3.5) HIT, (0, 1.9, 0) HIT, (0, 2.2, 0) MISS
    assert.equal(predZ(0, 0, 3.5), true);
    assert.equal(predZ(0, 1.9, 0), true);
    assert.equal(predZ(0, 2.2, 0), false);
    assert.equal(predZ(0, 0, 4.2), false);

    const v2YUpRule = {
      version: 2,
      coordSystem: "y-up",
      translation: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      rules: [{ op: "replace", kind: "cylinder", m: invM }],
    };
    const predY = compileRules(v2YUpRule);
    // In y-up: |y|<=2 is axial, x^2+(z/4)^2<=1 is radial -> (0, 1.9, 0) HIT, (0, 0, 3.5) HIT, (0, 2.2, 0) MISS, (0.8, 0, 3.5) MISS (0.64+0.765>1)
    assert.equal(predY(0, 1.9, 0), true);
    assert.equal(predY(0, 0, 3.5), true);
    assert.equal(predY(0, 2.2, 0), false);
    assert.equal(predY(0.8, 0, 3.5), false);
    assert.equal(predZ(0.8, 0, 3.5), true); // contrasts z-up vs y-up cleanly!
    pass("5_rules_mjs_v1_v2_cylinder_paths", "rules.mjs preserves v1/v2 z-up axial-Z default and honors explicit y-up axial-Y");
  }

  console.log(`\nALL ${results.length} COORD & CYLINDER COMPATIBILITY CHECKS PASSED 100%!`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
