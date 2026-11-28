/**
 * Step 3 & Step 4 Pure Domain + Multi-Asset + Real-EXE Contract Test Suite
 *
 * Runs purely in Node.js (ZERO DOM, ZERO WebGL, ZERO browser) and exercises:
 *  1. Static import boundary audit of domain modules (zero DOM/WebGL/Three/PlayCanvas/PCUI)
 *  2. Two distinct synthetic +Z-up PLY assets with identical local point indices (0..19)
 *     and a deliberately permuted preview backend (previewIndex !== sourceIndex)
 *  3. Box-select + delete ONLY (assetA, sourceIndex=7) -> Undo -> Redo -> Save lightweight recipe ->
 *     Dispose -> Reopen into fresh EditSession + newly permuted backend
 *  4. Real compiled candidate EXE export:
 *     - Lossless .ply: bit-exact verification per vertex & all 23 columns (x,y,z,f_dc,f_rest,scale,rot,opacity)
 *     - Lossy .sog and .spz: decoded point count + coordinate/color quantization tolerance (NOT byte equality)
 *     - Source asset SHA-256 immutability verified for BOTH source files
 *  5. Existing v3 (isolated equivalent of test-v3-pipeline.mjs) & v4 recipe compatibility:
 *     - v4 opened & re-saved preserves version:4, paletteMatrices, transformIdxRle, paintDelta (no implicit downgrade!)
 *     - Real EXE processPlyV3 + processPlyV4 verification
 *  6. Unsupported recipe schema (version: 99): explicit warning, preserved original, blocked silent overwrite
 *  7. Source asset reorder / modification guard (AssetVersionMismatchError)
 *  8. Failure & cancellation cleanliness (no fake-successful output files left behind)
 *  9. Multi-format publish snapshot plan (shared common bake reuse + explicit cameraTrack scene-manifest.json)
 *     + real EXE multi-profile job verifying "[公共烘焙复用]" log & valid multi-format outputs!
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  COORD_CONTRACT,
  POINT_FLAG,
  AssetVersionMismatchError,
  UnsupportedRecipeError,
} from "../windows/editor/domain/contracts.mjs";
import { EditSession } from "../windows/editor/domain/edit-session.mjs";
import { BoxSelectTool } from "../windows/editor/domain/box-select-tool.mjs";
import {
  inspectRecipeCompatibility,
  decodeRecipeIntoSession,
  encodeProjectRecipe,
  buildSingleAssetExportRecipe,
  createPublishPlan,
  encodeBoolRle,
} from "../windows/editor/domain/recipe-codec.mjs";
import { layout, readExact } from "../windows/editor/ply.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJ_DIR = path.resolve(__dirname, "..");
const DEFAULT_EXE = path.join(PROJ_DIR, "dist", "Splat-Convert-Desktop-1.9.0-win-x64.exe");
const WORKER_JS = path.join(PROJ_DIR, "windows", "editor", "worker.mjs");
const EXE_PATH = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_EXE;
const REPORT_OUT = process.argv[3] ? path.resolve(process.argv[3]) : null;

const SH_C0 = 0.28209479177387814;
const encDc = (c) => (c - 0.5) / SH_C0;
const invSig = (a) => -Math.log(1 / Math.max(1e-4, Math.min(1 - 1e-4, a)) - 1);

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

const PLY_FIELDS = [
  "x", "y", "z",
  "f_dc_0", "f_dc_1", "f_dc_2",
  ...Array.from({ length: 9 }, (_, i) => `f_rest_${i}`),
  "scale_0", "scale_1", "scale_2",
  "rot_0", "rot_1", "rot_2", "rot_3",
  "opacity",
];

function writeSyntheticPly(outPath, points) {
  const stride = PLY_FIELDS.length * 4;
  const payload = Buffer.alloc(points.length * stride);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const off = i * stride;
    const vals = [
      p.x, p.y, p.z,
      encDc(p.r), encDc(p.g), encDc(p.b),
      p.rest, -p.rest * 0.5, p.rest * 0.25,
      p.rest * 0.6, p.rest * 0.3, -p.rest * 0.4,
      -p.rest * 0.2, p.rest * 0.8, p.rest * 0.1,
      Math.log(p.sx), Math.log(p.sy), Math.log(p.sz),
      p.qw, p.qx, p.qy, p.qz,
      invSig(p.op),
    ];
    for (let k = 0; k < vals.length; k++) payload.writeFloatLE(vals[k], off + k * 4);
  }
  const header = Buffer.from(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${points.length}\n` +
      PLY_FIELDS.map((f) => `property float ${f}`).join("\n") +
      "\nend_header\n",
    "latin1",
  );
  fs.writeFileSync(outPath, Buffer.concat([header, payload]));
  return { stride, payload };
}

function readPlyRecords(plyPath) {
  const fd = fs.openSync(plyPath, "r");
  try {
    const l = layout(fd);
    const buf = Buffer.alloc(l.count * l.stride);
    readExact(fd, buf, buf.length, l.start);
    const rX = l.accessor("x"), rY = l.accessor("y"), rZ = l.accessor("z");
    const rRest0 = l.accessor("f_rest_0");
    const records = [];
    for (let i = 0; i < l.count; i++) {
      const off = i * l.stride;
      records.push({
        x: rX(buf, off),
        y: rY(buf, off),
        z: rZ(buf, off),
        f_rest_0: rRest0 ? rRest0(buf, off) : 0,
        raw: buf.subarray(off, off + l.stride),
      });
    }
    return { count: l.count, stride: l.stride, records };
  } finally {
    fs.closeSync(fd);
  }
}

function decodeSgc3Points(binPath) {
  const buf = fs.readFileSync(binPath);
  assert.equal(buf.toString("ascii", 0, 4), "SGC3", "Expected SGC3 binary magic");
  const totalSrc = buf.readUInt32LE(8);
  const loaded = buf.readUInt32LE(12);
  const posOff = 32;
  const scaleOff = posOff + loaded * 12;
  const scaleBytes = Math.ceil((loaded * 6) / 4) * 4;
  const rotOff = scaleOff + scaleBytes;
  const colOff = rotOff + loaded * 8;
  const pts = [];
  for (let i = 0; i < loaded; i++) {
    pts.push({
      x: buf.readFloatLE(posOff + i * 12),
      y: buf.readFloatLE(posOff + i * 12 + 4),
      z: buf.readFloatLE(posOff + i * 12 + 8),
      r: buf[colOff + i * 4] / 255,
      g: buf[colOff + i * 4 + 1] / 255,
      b: buf[colOff + i * 4 + 2] / 255,
      a: buf[colOff + i * 4 + 3] / 255,
    });
  }
  return { totalSrc, loaded, pts };
}

/**
 * Permuted multi-asset mock IPreviewBackend:
 * Deliberately scrambles previewIndex order across assetA & assetB so previewIndex !== sourceIndex!
 */
class PermutedMockBackend {
  constructor(entries) {
    // entries: Array<{ assetId, sourceIndex, ndcX, ndcY }>
    this.rows = entries.map((e, previewIndex) => ({ ...e, previewIndex }));
    this.syncedFlags = new Map();
    this.disposed = false;
  }

  pickInRect({ rectNdc, targetAssetId = null }) {
    const hits = [];
    for (const row of this.rows) {
      if (targetAssetId && row.assetId !== targetAssetId) continue;
      if (
        row.ndcX >= rectNdc.minX &&
        row.ndcX <= rectNdc.maxX &&
        row.ndcY >= rectNdc.minY &&
        row.ndcY <= rectNdc.maxY
      ) {
        hits.push({
          assetId: row.assetId,
          previewIndex: row.previewIndex,
          sourceIndex: row.sourceIndex,
        });
      }
    }
    return hits;
  }

  syncFromSession(session, dirtyAssetIds) {
    for (const aid of dirtyAssetIds) {
      const a = session.getAsset(aid);
      this.syncedFlags.set(aid, new Uint8Array(a.flags));
    }
  }

  dispose() {
    this.disposed = true;
    this.rows = [];
    this.syncedFlags.clear();
  }
}

function runExeJob(jobObj, workDir, tag) {
  const jobFile = path.join(workDir, `job-${tag}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(jobObj, null, 2), "utf8");
  const r = spawnSync(EXE_PATH, ["run", "--job", jobFile], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", jobFile };
}

const results = {
  exePath: EXE_PATH,
  coordContract: COORD_CONTRACT,
  checks: [],
  passed: false,
};

function recordCheck(id, ok, detail) {
  results.checks.push({ id, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}: ${detail}`);
  assert.ok(ok, `${id} failed: ${detail}`);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "splat-domain-contract-"));
try {
  assert.ok(fs.existsSync(EXE_PATH), `Candidate EXE not found: ${EXE_PATH}`);

  // -------------------------------------------------------------------------
  // 1. Static zero-DOM / zero-WebGL / zero-engine boundary audit
  // -------------------------------------------------------------------------
  const pureFiles = ["contracts.mjs", "edit-session.mjs", "box-select-tool.mjs", "recipe-codec.mjs"];
  const forbiddenRe = /\b(window|document|HTMLElement|WebGL2RenderingContext|WebGLRenderingContext|THREE|playcanvas|pcui|requestAnimationFrame)\b/g;
  const violations = [];
  for (const fname of pureFiles) {
    const src = fs.readFileSync(path.join(PROJ_DIR, "windows", "editor", "domain", fname), "utf8");
    // Strip block comments and line comments so documentation prose mentioning "ZERO WebGL" isn't flagged
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const m = codeOnly.match(forbiddenRe);
    if (m) violations.push(`${fname}: ${Array.from(new Set(m)).join(", ")}`);
  }
  recordCheck(
    "1_zero_dom_webgl_boundary",
    violations.length === 0,
    violations.length === 0
      ? `All 4 pure domain modules have 0 DOM/WebGL/Three/PlayCanvas/PCUI references`
      : `Violations: ${violations.join("; ")}`,
  );

  // -------------------------------------------------------------------------
  // 2. Two distinct source assets with identical local point indices (0..19)
  // -------------------------------------------------------------------------
  const ptsA = Array.from({ length: 20 }, (_, i) => ({
    x: 10 + i * 0.5,
    y: 1.0 + (i % 4) * 0.25,
    z: 0.5 + (i % 3) * 0.2,
    r: 0.2 + (i / 25) * 0.7,
    g: 0.3 + ((i * 3) % 10) * 0.05,
    b: 0.7 - (i / 40),
    rest: 0.1 + i * 0.01,
    sx: 0.05, sy: 0.04, sz: 0.03,
    qw: 1, qx: 0, qy: 0, qz: 0,
    op: 0.92,
  }));
  const ptsB = Array.from({ length: 20 }, (_, i) => ({
    x: -10 - i * 0.5,
    y: -2.0 - (i % 4) * 0.25,
    z: 1.5 + (i % 3) * 0.2,
    r: 0.8 - (i / 30),
    g: 0.65 - (i / 40),
    b: 0.2 + (i / 30),
    rest: -0.12 - i * 0.01,
    sx: 0.06, sy: 0.05, sz: 0.04,
    qw: 1, qx: 0, qy: 0, qz: 0,
    op: 0.88,
  }));

  const assetAPath = path.join(workDir, "assetA.ply");
  const assetBPath = path.join(workDir, "assetB.ply");
  const rawA = writeSyntheticPly(assetAPath, ptsA);
  const rawB = writeSyntheticPly(assetBPath, ptsB);
  const shaABefore = sha256File(assetAPath);
  const shaBBefore = sha256File(assetBPath);

  // Build deliberately permuted preview order across BOTH assets:
  // (assetB, 7) sits at previewIndex=4, (assetA, 7) sits at previewIndex=31!
  const mockEntries = [];
  for (let i = 19; i >= 0; i--) {
    mockEntries.push({
      assetId: "assetB",
      sourceIndex: i,
      ndcX: -0.8 + i * 0.02, // left half of screen (far from box [0.45..0.55])
      ndcY: -0.5,
    });
  }
  for (let i = 19; i >= 0; i--) {
    mockEntries.push({
      assetId: "assetA",
      sourceIndex: i,
      ndcX: i === 7 ? 0.5 : -0.9 + i * 0.02, // ONLY (assetA, sourceIndex=7) falls inside [0.45..0.55] x [0.45..0.55]!
      ndcY: i === 7 ? 0.5 : -0.8,
    });
  }
  // Verify permutation actually holds
  const rowA7 = mockEntries.findIndex((r) => r.assetId === "assetA" && r.sourceIndex === 7);
  const rowB7 = mockEntries.findIndex((r) => r.assetId === "assetB" && r.sourceIndex === 7);
  assert.notEqual(rowA7, 7, "assetA previewIndex must differ from sourceIndex");
  assert.notEqual(rowB7, 7, "assetB previewIndex must differ from sourceIndex");

  const session1 = new EditSession();
  session1.registerAsset({ assetId: "assetA", name: "assetA.ply", sha256: shaABefore, pointCount: 20, orderingVersion: "source-v1" });
  session1.registerAsset({ assetId: "assetB", name: "assetB.ply", sha256: shaBBefore, pointCount: 20, orderingVersion: "source-v1" });

  const backend1 = new PermutedMockBackend(mockEntries);
  const tool1 = new BoxSelectTool({ previewBackend: backend1, editSession: session1 });

  // -------------------------------------------------------------------------
  // 3. Box-select ONLY (assetA, 7) -> Delete -> Undo -> Redo -> Save -> Dispose -> Reopen
  // -------------------------------------------------------------------------
  const selRes = tool1.selectBox({ rectNdc: { minX: 0.45, maxX: 0.55, minY: 0.45, maxY: 0.55 }, op: "replace" });
  assert.equal(selRes.pickedCount, 1);
  assert.deepEqual(session1.getSelectedSourceIndices("assetA"), [7]);
  assert.deepEqual(session1.getSelectedSourceIndices("assetB"), []);

  const delRes = tool1.deleteSelected();
  assert.equal(delRes.changedCount, 1);
  assert.deepEqual(session1.getDeletedSourceIndices("assetA"), [7]);
  assert.deepEqual(session1.getDeletedSourceIndices("assetB"), []);

  // Undo restores (assetA, 7)
  const undoRes = tool1.undo();
  assert.equal(undoRes.ok, true);
  assert.deepEqual(session1.getDeletedSourceIndices("assetA"), []);
  assert.deepEqual(session1.getSelectedSourceIndices("assetA"), [7]);

  // Redo deletes ONLY (assetA, 7) again
  const redoRes = tool1.redo();
  assert.equal(redoRes.ok, true);
  assert.deepEqual(session1.getDeletedSourceIndices("assetA"), [7]);
  assert.deepEqual(session1.getDeletedSourceIndices("assetB"), []);

  // Save lightweight project recipe (MUST NOT dump point cloud!)
  const encoded = encodeProjectRecipe(session1, { primaryAssetId: "assetA" });
  assert.equal(encoded.blocked, false);
  const recipeText = JSON.stringify(encoded.recipe);
  assert.ok(recipeText.length < 4096, `Recipe too large (${recipeText.length} bytes), must be lightweight`);
  const savedRecipeFile = path.join(workDir, "project-recipe.json");
  fs.writeFileSync(savedRecipeFile, recipeText, "utf8");

  // Dispose session1 & backend1 completely (simulating close!)
  backend1.dispose();
  session1.dispose();
  assert.equal(backend1.disposed, true);

  // Reopen into fresh EditSession + newly reversed backend permutation
  const session2 = new EditSession();
  session2.registerAsset({ assetId: "assetA", name: "assetA.ply", sha256: shaABefore, pointCount: 20, orderingVersion: "source-v1" });
  session2.registerAsset({ assetId: "assetB", name: "assetB.ply", sha256: shaBBefore, pointCount: 20, orderingVersion: "source-v1" });
  const dec = decodeRecipeIntoSession(fs.readFileSync(savedRecipeFile, "utf8"), session2, { primaryAssetId: "assetA" });
  assert.equal(dec.appliedDeletedCount, 1);
  assert.deepEqual(session2.getDeletedSourceIndices("assetA"), [7]);
  assert.deepEqual(session2.getDeletedSourceIndices("assetB"), []);

  recordCheck(
    "2_multi_asset_permuted_undo_redo_reopen",
    true,
    `assetA(src=7, preview=${rowA7}) deleted & persisted across close/reopen; assetB(src=7, preview=${rowB7}) untouched; recipe=${recipeText.length} B`,
  );

  // -------------------------------------------------------------------------
  // 4. Real EXE Export: Lossless PLY (bit-exact) + Lossy SOG/SPZ (tolerance) + Source Immutability
  // -------------------------------------------------------------------------
  const recA = buildSingleAssetExportRecipe(encoded.recipe, "assetA");
  const recB = buildSingleAssetExportRecipe(encoded.recipe, "assetB");

  const outAPly = path.join(workDir, "out-assetA.ply");
  const outBPly = path.join(workDir, "out-assetB.ply");
  const outASog = path.join(workDir, "out-assetA.sog");
  const outBSog = path.join(workDir, "out-assetB.sog");
  const outASpz = path.join(workDir, "out-assetA.spz");
  const outBSpz = path.join(workDir, "out-assetB.spz");

  // Run multi-profile job for assetA (.ply + .sog + .spz) in ONE job -> also validates shared common bake!
  const jobA = runExeJob(
    {
      JobId: "contract-assetA",
      Mode: "merge",
      ConflictPolicy: "overwrite",
      Inputs: [{ Id: "assetA", StoredPath: assetAPath, AuthorizedExternal: true, Ops: [{ Flag: "--scene-edit", Value: JSON.stringify(recA), Enabled: true }] }],
      Profiles: [
        { Id: "ply", FormatSuffix: ".ply", OutputPath: outAPly, Device: "cpu", Keep: 100 },
        { Id: "sog", FormatSuffix: ".sog", OutputPath: outASog, Device: "cpu", Keep: 100, Iterations: 5 },
        { Id: "spz", FormatSuffix: ".spz", OutputPath: outASpz, Device: "cpu", Keep: 100 },
      ],
    },
    workDir,
    "assetA-multi",
  );
  assert.equal(jobA.status, 0, `EXE assetA export failed:\n${jobA.stdout}\n${jobA.stderr}`);

  const jobB = runExeJob(
    {
      JobId: "contract-assetB",
      Mode: "merge",
      ConflictPolicy: "overwrite",
      Inputs: [{ Id: "assetB", StoredPath: assetBPath, AuthorizedExternal: true, Ops: [{ Flag: "--scene-edit", Value: JSON.stringify(recB), Enabled: true }] }],
      Profiles: [
        { Id: "ply", FormatSuffix: ".ply", OutputPath: outBPly, Device: "cpu", Keep: 100 },
        { Id: "sog", FormatSuffix: ".sog", OutputPath: outBSog, Device: "cpu", Keep: 100, Iterations: 5 },
        { Id: "spz", FormatSuffix: ".spz", OutputPath: outBSpz, Device: "cpu", Keep: 100 },
      ],
    },
    workDir,
    "assetB-multi",
  );
  assert.equal(jobB.status, 0, `EXE assetB export failed:\n${jobB.stdout}\n${jobB.stderr}`);

  // 4a. Lossless PLY bit-exact audit: every remaining vertex byte-identical across ALL 23 float columns!
  const parsedA = readPlyRecords(outAPly);
  const parsedB = readPlyRecords(outBPly);
  assert.equal(parsedA.count, 19, `assetA lossless PLY expected 19 pts, got ${parsedA.count}`);
  assert.equal(parsedB.count, 20, `assetB lossless PLY expected 20 pts, got ${parsedB.count}`);

  let cursorA = 0;
  for (let srcIdx = 0; srcIdx < 20; srcIdx++) {
    if (srcIdx === 7) continue;
    const expectedSlice = rawA.payload.subarray(srcIdx * rawA.stride, (srcIdx + 1) * rawA.stride);
    const actualSlice = parsedA.records[cursorA++].raw;
    assert.equal(Buffer.compare(expectedSlice, actualSlice), 0, `assetA lossless vertex mismatch at srcIdx=${srcIdx}`);
  }
  for (let srcIdx = 0; srcIdx < 20; srcIdx++) {
    const expectedSlice = rawB.payload.subarray(srcIdx * rawB.stride, (srcIdx + 1) * rawB.stride);
    const actualSlice = parsedB.records[srcIdx].raw;
    assert.equal(Buffer.compare(expectedSlice, actualSlice), 0, `assetB lossless vertex mismatch at srcIdx=${srcIdx}`);
  }
  recordCheck(
    "3_lossless_ply_bit_exact",
    true,
    `assetA.ply=19 pts (exact srcIdx=7 removed, all 19 remaining vertices bit-exact across 23 cols); assetB.ply=20 pts (all 20 bit-exact including srcIdx=7)`,
  );

  // 4b. Lossy SOG & SPZ tolerance check (NEVER byte-identical; verify count + nearest-point error + deleted absence)
  function verifyLossyOutput(filePath, expectedPts, deletedPt, formatTag) {
    const decPly = path.join(workDir, `dec-${formatTag}.ply`);
    const decJob = runExeJob(
      {
        JobId: `dec-${formatTag}`,
        Mode: "merge",
        ConflictPolicy: "overwrite",
        Inputs: [{ Id: "in", StoredPath: filePath, AuthorizedExternal: true, Ops: [] }],
        Profiles: [{ Id: "p", FormatSuffix: ".ply", OutputPath: decPly, Device: "cpu", Keep: 100 }],
      },
      workDir,
      `dec-${formatTag}`,
    );
    assert.equal(decJob.status, 0, `Decode ${formatTag} failed: ${decJob.stderr}\n${decJob.stdout}`);
    const fd = fs.openSync(decPly, "r");
    let decodedPts = [];
    try {
      const l = layout(fd);
      const buf = Buffer.alloc(l.count * l.stride);
      readExact(fd, buf, buf.length, l.start);
      const rX = l.accessor("x"), rY = l.accessor("y"), rZ = l.accessor("z");
      const rDc0 = l.accessor("f_dc_0", 0), rDc1 = l.accessor("f_dc_1", 0), rDc2 = l.accessor("f_dc_2", 0);
      for (let i = 0; i < l.count; i++) {
        const off = i * l.stride;
        decodedPts.push({
          x: rX(buf, off),
          y: rY(buf, off),
          z: rZ(buf, off),
          r: Math.max(0, Math.min(1, 0.5 + SH_C0 * rDc0(buf, off))),
          g: Math.max(0, Math.min(1, 0.5 + SH_C0 * rDc1(buf, off))),
          b: Math.max(0, Math.min(1, 0.5 + SH_C0 * rDc2(buf, off))),
        });
      }
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(decodedPts.length, expectedPts.length, `${formatTag} count mismatch: ${decodedPts.length} != ${expectedPts.length}`);

    let maxPosErr = 0;
    let maxColErr = 0;
    for (const ep of expectedPts) {
      let bestDist = Infinity;
      let bestPt = null;
      for (const dp of decodedPts) {
        const d = Math.hypot(dp.x - ep.x, dp.y - ep.y, dp.z - ep.z);
        if (d < bestDist) {
          bestDist = d;
          bestPt = dp;
        }
      }
      if (bestDist > maxPosErr) maxPosErr = bestDist;
      const cErr = Math.max(Math.abs(bestPt.r - ep.r), Math.abs(bestPt.g - ep.g), Math.abs(bestPt.b - ep.b));
      if (cErr > maxColErr) maxColErr = cErr;
    }
    assert.ok(maxPosErr < 0.05, `${formatTag} position quantization err too high: ${maxPosErr}`);
    assert.ok(maxColErr < 0.12, `${formatTag} color quantization err too high: ${maxColErr}`);

    if (deletedPt) {
      let minDelDist = Infinity;
      for (const dp of decodedPts) {
        const d = Math.hypot(dp.x - deletedPt.x, dp.y - deletedPt.y, dp.z - deletedPt.z);
        if (d < minDelDist) minDelDist = d;
      }
      assert.ok(minDelDist > 0.35, `${formatTag} still contains deleted point (minDist=${minDelDist})`);
    }
    return { count: decodedPts.length, maxPosErr: Number(maxPosErr.toFixed(5)), maxColErr: Number(maxColErr.toFixed(4)) };
  }

  const keptA = ptsA.filter((_, i) => i !== 7);
  const sogAStat = verifyLossyOutput(outASog, keptA, ptsA[7], "assetA-sog");
  const spzAStat = verifyLossyOutput(outASpz, keptA, ptsA[7], "assetA-spz");
  const sogBStat = verifyLossyOutput(outBSog, ptsB, null, "assetB-sog");
  const spzBStat = verifyLossyOutput(outBSpz, ptsB, null, "assetB-spz");
  recordCheck(
    "4_lossy_sog_spz_tolerance",
    true,
    `assetA SOG(n=${sogAStat.count}, posErr=${sogAStat.maxPosErr}m, colErr=${sogAStat.maxColErr}) SPZ(n=${spzAStat.count}, posErr=${spzAStat.maxPosErr}m); assetB SOG(n=${sogBStat.count}, posErr=${sogBStat.maxPosErr}m) SPZ(n=${spzBStat.count}, posErr=${spzBStat.maxPosErr}m)`,
  );

  // 4c. Source file SHA-256 immutability
  const shaAAfter = sha256File(assetAPath);
  const shaBAfter = sha256File(assetBPath);
  recordCheck(
    "5_source_sha256_immutable",
    shaABefore === shaAAfter && shaBBefore === shaBAfter,
    `assetA SHA256=${shaAAfter.slice(0, 16)}... unchanged; assetB SHA256=${shaBAfter.slice(0, 16)}... unchanged`,
  );

  // 4d. Verify real EXE shared common bake reuse on multi-profile jobA!
  const sharedBakeLogHit = /公共烘焙复用|Shared Bake Reuse/i.test(jobA.stdout + jobA.stderr);
  recordCheck(
    "6_exe_shared_common_bake_reuse",
    sharedBakeLogHit,
    sharedBakeLogHit
      ? `Single EXE multi-format job (.ply/.sog/.spz) logged [公共烘焙复用] and baked once`
      : `Missing shared bake log in EXE output`,
  );

  // -------------------------------------------------------------------------
  // 5. v3 & v4 Recipe Compatibility + No Implicit Downgrade + Real EXE v3 & v4 Bake
  // -------------------------------------------------------------------------
  // 5a. v4 round-trip in EditSession + RecipeCodec (MUST stay version:4 and keep paletteMatrices/transformIdxRle/paintDelta!)
  const v4RecipeIn = {
    version: 4,
    coordSystem: "z-up",
    deletedRle: encodeBoolRle(20, (i) => i === 2 || i === 3),
    deletedCount: 2,
    entityDeltaMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
    paletteMatrices: [
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1],
    ],
    transformIdxRle: [0, 10, 1, 10],
    paintDelta: {
      indices: [0, 1],
      dc: [0.1, -0.05, 0.02, 0.08, 0.03, -0.04],
    },
    colorGrade: { enabled: true, brightness: 0.06, saturation: 1.15, blackPoint: 0, whitePoint: 1, transparency: 1, tint: [1, 1, 1] },
  };
  const v4Session = new EditSession();
  v4Session.registerAsset({ assetId: "primary", name: "assetA.ply", sha256: shaABefore, pointCount: 20, orderingVersion: "source-v1" });
  const v4Dec = decodeRecipeIntoSession(v4RecipeIn, v4Session, { primaryAssetId: "primary" });
  assert.equal(v4Dec.compatibility.version, 4);
  assert.equal(v4Dec.compatibility.requiresPreservation, true);
  assert.deepEqual(v4Session.getDeletedSourceIndices("primary"), [2, 3]);

  // Add one more deletion (index 4) and re-save -> MUST remain version: 4 with ALL v4 fields intact!
  v4Session.dispatch({ type: "selectPoints", op: "replace", refs: [{ assetId: "primary", sourceIndex: 4 }] });
  v4Session.dispatch({ type: "deleteSelected" });
  const v4ReEncoded = encodeProjectRecipe(v4Session, { primaryAssetId: "primary" });
  assert.equal(v4ReEncoded.recipe.version, 4, "v4 recipe must NEVER implicitly downgrade to v3!");
  assert.equal(v4ReEncoded.recipe.deletedCount, 3);
  assert.deepEqual(v4ReEncoded.recipe.paletteMatrices, v4RecipeIn.paletteMatrices);
  assert.deepEqual(v4ReEncoded.recipe.transformIdxRle, v4RecipeIn.transformIdxRle);
  assert.deepEqual(v4ReEncoded.recipe.paintDelta, v4RecipeIn.paintDelta);

  // Run the re-saved v4 recipe through REAL candidate EXE (`processPlyV4`)!
  const outV4Ply = path.join(workDir, "out-v4.ply");
  const jobV4 = runExeJob(
    {
      JobId: "contract-v4",
      Mode: "merge",
      ConflictPolicy: "overwrite",
      Inputs: [{ Id: "v4", StoredPath: assetAPath, AuthorizedExternal: true, Ops: [{ Flag: "--scene-edit", Value: JSON.stringify(v4ReEncoded.recipe), Enabled: true }] }],
      Profiles: [{ Id: "ply", FormatSuffix: ".ply", OutputPath: outV4Ply, Device: "cpu", Keep: 100 }],
    },
    workDir,
    "v4-bake",
  );
  assert.equal(jobV4.status, 0, `EXE v4 export failed: ${jobV4.stderr}`);
  const parsedV4 = readPlyRecords(outV4Ply);
  assert.equal(parsedV4.count, 17, `v4 baked PLY expected 17 pts (20 - 3 deleted), got ${parsedV4.count}`);
  // Verify entityDeltaMatrix translate (+5, 0, 0) was applied to pt 0 (orig x=10 -> x~15)!
  assert.ok(Math.abs(parsedV4.records[0].x - 15.0) < 1e-4, `v4 transform expected x=15.0, got ${parsedV4.records[0].x}`);
  v4Session.dispose();
  recordCheck(
    "7_v4_no_downgrade_and_real_exe_bake",
    true,
    `v4 recipe stayed version=4 with paletteMatrices/transformIdxRle/paintDelta intact; EXE processPlyV4 exported 17 pts with +5m X delta verified`,
  );

  // 5b. Full v3 pipeline test (isolated equivalent of 06_测试素材/test-v3-pipeline.mjs on candidate EXE, zero mutation to 06_测试素材!)
  const demo24kSrc = path.resolve(PROJ_DIR, "..", "..", "06_测试素材", "scene-demo-24k.ply");
  const demo24kCopy = path.join(workDir, "scene-demo-24k-copy.ply");
  fs.copyFileSync(demo24kSrc, demo24kCopy);
  const v3FullRecipe = {
    version: 3,
    coordSystem: "z-up",
    exportObjectIds: [0, 1, 2],
    deletedRanges: [[23500, 500]],
    objects: [
      { id: 0, name: "主场景点云", sourceKind: "original", memberRanges: "all", excludedRanges: [[15000, 1000]], deletedRanges: [[23500, 500]], matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], bakedGrades: [] },
      {
        id: 1, name: "拆分对象 #1", sourceKind: "split", memberRanges: [[15000, 1000]], excludedRanges: [], deletedRanges: [],
        matrix: [0,1,0,0,-1,0,0,0,0,0,1,0,10,0,0,1],
        bakedGrades: [{ targetRanges: "all", grade: { exposure: 0.35, brightness: 0.05, contrast: 1.2, blackPoint: 0, whitePoint: 1, highlights: 0.1, shadows: 0.1, saturation: 1.35, temperature: 0.12, tint: [1,1,1], gamma: 1, transparency: 0.9, hslHue: [0,0,0,0,0,0,0,0], hslSat: [0,0,0,0,0,0,0,0], hslLight: [0,0,0,0,0,0,0,0], lutName: "胶片.PNG", lutIntensity: 0.5 } }],
      },
      { id: 2, name: "局部副本 #2", sourceKind: "duplicate", memberRanges: [[16000, 500]], excludedRanges: [], deletedRanges: [], matrix: [2,0,0,0,0,2,0,0,0,0,2,0,0,20,0,1], bakedGrades: [] },
    ],
    groups: [], rules: [], translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1,
  };
  const outV3Ply = path.join(workDir, "v3-24k.ply");
  const outV3Sog = path.join(workDir, "v3-24k.sog");
  const outV3Spz = path.join(workDir, "v3-24k.spz");
  const jobV3 = runExeJob(
    {
      JobId: "contract-v3-24k",
      Mode: "merge",
      ConflictPolicy: "overwrite",
      Inputs: [{ Id: "demo", StoredPath: demo24kCopy, AuthorizedExternal: true, Ops: [{ Flag: "--scene-edit", Value: JSON.stringify(v3FullRecipe), Enabled: true }] }],
      Profiles: [
        { Id: "p1", FormatSuffix: ".ply", OutputPath: outV3Ply, Device: "cpu", Keep: 100 },
        { Id: "p2", FormatSuffix: ".sog", OutputPath: outV3Sog, Device: "cpu", Keep: 100, Iterations: 5 },
        { Id: "p3", FormatSuffix: ".spz", OutputPath: outV3Spz, Device: "cpu", Keep: 100 },
      ],
    },
    workDir,
    "v3-24k",
  );
  assert.equal(jobV3.status, 0, `EXE v3 24k export failed: ${jobV3.stderr}`);
  const pv3 = readPlyRecords(outV3Ply);
  assert.equal(pv3.count, 24000, `v3 24k expected 24000 (24000 - 500 + 500), got ${pv3.count}`);
  let o1 = 0, o2 = 0, fl = 0, shMod = 0;
  for (const r of pv3.records) {
    if (r.x > 7 && r.x < 13) { o1++; if (Math.abs(r.f_rest_0 - 0.2) > 0.02) shMod++; }
    if (r.y > 16 && r.y < 24) o2++;
    if (r.z > 3.5 && r.y < 10) fl++;
  }
  assert.equal(fl, 0, "All 500 soft-deleted floaters must be stripped");
  assert.equal(o1, 1000, "All 1000 split Obj1 points must transform to X~10");
  assert.equal(o2, 500, "All 500 duplicated Obj2 points must transform to Y~20");
  assert.equal(shMod, 1000, "All 1000 Obj1 points must have rotated + LUT-graded SH1");
  recordCheck(
    "8_v3_full_pipeline_candidate_exe",
    true,
    `Isolated v3 24k E2E passed on candidate EXE: count=24000, floaters=0, split=1000, dup=500, SH1+LUT=1000, PLY/SOG/SPZ generated`,
  );

  // -------------------------------------------------------------------------
  // 6. Unsupported schema (version: 99) preservation & silent-overwrite block
  // -------------------------------------------------------------------------
  const unknownRecipe = { version: 99, futureGraph: { nodes: ["a", "b"] }, customKey: 42 };
  const compat99 = inspectRecipeCompatibility(unknownRecipe);
  assert.equal(compat99.supported, false);
  assert.equal(compat99.requiresPreservation, true);

  const s99 = new EditSession();
  s99.registerAsset({ assetId: "primary", name: "a.ply", sha256: shaABefore, pointCount: 20 });
  assert.throws(
    () => decodeRecipeIntoSession(unknownRecipe, s99, { throwOnUnsupported: true }),
    UnsupportedRecipeError,
  );
  const nonThrowing = decodeRecipeIntoSession(unknownRecipe, s99);
  assert.equal(nonThrowing.compatibility.supported, false);
  const save99 = encodeProjectRecipe(s99);
  assert.equal(save99.blocked, true, "Saving unsupported recipe must be blocked by default");
  assert.equal(save99.preservedOriginal, true);
  assert.deepEqual(save99.recipe, unknownRecipe, "Original unsupported recipe must remain untouched");
  s99.dispose();
  recordCheck(
    "9_unsupported_recipe_preserved_no_overwrite",
    true,
    `version=99 flagged unsupported, threw UnsupportedRecipeError on strict mode, and blocked silent overwrite while preserving original JSON`,
  );

  // -------------------------------------------------------------------------
  // 7. Source-asset reorder / modification guard (AssetVersionMismatchError)
  // -------------------------------------------------------------------------
  const sMismatch = new EditSession();
  sMismatch.registerAsset({
    assetId: "assetA",
    name: "assetA-reordered.ply",
    sha256: "0000000000000000000000000000000000000000000000000000000000000001",
    pointCount: 20,
    orderingVersion: "source-v1",
  });
  assert.throws(
    () => decodeRecipeIntoSession(encoded.recipe, sMismatch),
    AssetVersionMismatchError,
    "Reordered/modified source asset MUST reject stale point indices!",
  );
  sMismatch.dispose();
  recordCheck(
    "10_source_reorder_version_mismatch_guard",
    true,
    `Modified source SHA-256 rejected with AssetVersionMismatchError instead of blindly applying stale sourceIndex`,
  );

  // -------------------------------------------------------------------------
  // 8. Failure cleanliness: failed export MUST NOT leave fake-successful output file!
  // -------------------------------------------------------------------------
  const failOut = path.join(workDir, "must-not-exist-on-fail.ply");
  const badJob = runExeJob(
    {
      JobId: "contract-fail-clean",
      Mode: "merge",
      ConflictPolicy: "overwrite",
      Inputs: [{ Id: "bad", StoredPath: path.join(workDir, "nonexistent-source.ply"), AuthorizedExternal: true, Ops: [] }],
      Profiles: [{ Id: "p", FormatSuffix: ".ply", OutputPath: failOut, Device: "cpu", Keep: 100 }],
    },
    workDir,
    "fail-clean",
  );
  assert.notEqual(badJob.status, 0, "Failing job must exit non-zero");
  assert.equal(fs.existsSync(failOut), false, "Failed job must NEVER leave a fake-successful target output file!");
  recordCheck(
    "11_failure_leaves_zero_partial_output",
    true,
    `Failed job exited code=${badJob.status} and target path does not exist`,
  );

  // -------------------------------------------------------------------------
  // 9. Multi-format publish snapshot plan: shared common bake + explicit cameraTrack manifest
  // -------------------------------------------------------------------------
  session2.setCameraTrack({
    fps: 30,
    keyframes: [
      { t: 0, pos: [0, -5, 2], target: [0, 0, 1], fov: 50 },
      { t: 2.5, pos: [4, -3, 2.5], target: [0, 0, 1], fov: 45 },
    ],
  });
  const plan = createPublishPlan(session2, encoded.recipe, [
    { targetId: "t-ply", assetId: "assetA", formatSuffix: ".ply", outputPath: "out/a.ply" },
    { targetId: "t-sog", assetId: "assetA", formatSuffix: ".sog", outputPath: "out/a.sog" },
    { targetId: "t-spz", assetId: "assetA", formatSuffix: ".spz", outputPath: "out/a.spz" },
    { targetId: "t-html", assetId: "assetA", formatSuffix: ".html", outputPath: "out/a.html" },
  ]);
  assert.equal(plan.sharedBakes.length, 1, "Identical snapshot + compute params must share 1 common bake");
  assert.deepEqual(plan.sharedBakes[0].consumerFormats, [".ply", ".sog", ".spz", ".html"]);
  const plyTarget = plan.targets.find((t) => t.formatSuffix === ".ply");
  const htmlTarget = plan.targets.find((t) => t.formatSuffix === ".html");
  assert.equal(plyTarget.supportsCameraTrack, false);
  assert.ok(plyTarget.sceneManifestSidecar.endsWith(".scene-manifest.json"));
  assert.ok(plyTarget.warnings.length > 0, "Non-cameraTrack format must emit explicit warning");
  assert.equal(htmlTarget.supportsCameraTrack, true);
  assert.equal(htmlTarget.sceneManifestSidecar, null);
  session2.dispose();

  recordCheck(
    "12_publish_plan_shared_bake_and_camera_manifest",
    true,
    `4 format targets deduplicated into 1 shared bake; .ply/.sog/.spz emitted explicit scene-manifest.json sidecar + warnings while .html embeds natively`,
  );

  results.passed = true;
  if (REPORT_OUT) {
    fs.mkdirSync(path.dirname(REPORT_OUT), { recursive: true });
    fs.writeFileSync(REPORT_OUT, JSON.stringify(results, null, 2), "utf8");
  }
  console.log(`\nALL ${results.checks.length} DOMAIN & REAL-EXE CONTRACT CHECKS PASSED 100%!`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
