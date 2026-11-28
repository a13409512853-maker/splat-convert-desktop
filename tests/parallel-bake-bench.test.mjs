#!/usr/bin/env node
/**
 * 002-A Step 4 Verification & 1/2/4/8-Thread Benchmark Suite:
 *  1. Bit-exact equivalence vs serial processPlyV4 across multi-chunk boundaries (with SH3 + LUT + paint)
 *  2. Bit-exact equivalence vs serial processPlyV3 on main + split object recipes
 *  3. Mixed v3 recipe (duplicate + synthetic-inpaint) fallback point-order & attribute equivalence
 *  4. Repeat determinism across runs
 *  5. AbortSignal cancellation -> zero partial output & zero leftover .tmp files
 *  6. Simulated disk write failure (ENOSPC) -> zero partial output & zero leftover .tmp files
 *  7. Optional `--bench [--out=path.json]` 1/2/4/8-thread benchmark on 500k full-SH3 PLY (~124 MB):
 *     filter-only, heavy transform+SH3+LUT, and concurrent main-thread event-loop stall latency.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processPlyV3, processPlyV4, layout } from "../windows/editor/ply.mjs";
import {
  processPlyV3Parallel,
  processPlyV4Parallel,
  isV3RecipeParallelEligible,
  resolveDefaultBakeThreads,
} from "../windows/editor/ply-parallel.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lutsDir = path.join(repoRoot, "windows", "editor", "luts");

function sha256File(p) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  const buf = Buffer.alloc(4 * 1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function findFirstLutName() {
  if (!fs.existsSync(lutsDir)) return null;
  const files = fs.readdirSync(lutsDir).filter((f) => f.toLowerCase().endsWith(".png") && f !== "默认.png");
  return files[0] || null;
}

/**
 * Generate a deterministic binary little-endian 3DGS PLY with full SH3 (f_rest_0..44) => 62 floats = 248 bytes/vertex!
 */
function writeSyntheticSh3Ply(filePath, count) {
  const props = [
    "x", "y", "z",
    "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
    ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
  ];
  const header = [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${count}`,
    ...props.map((p) => `property float ${p}`),
    "end_header\n",
  ].join("\n");

  const strideFloats = props.length; // 62 floats = 248 B
  const strideBytes = strideFloats * 4;
  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeSync(fd, Buffer.from(header, "ascii"));
    const blockRows = Math.min(count, 16384);
    const block = Buffer.alloc(blockRows * strideBytes);
    const f32 = new Float32Array(block.buffer, block.byteOffset, blockRows * strideFloats);
    for (let first = 0; first < count; first += blockRows) {
      const n = Math.min(blockRows, count - first);
      for (let i = 0; i < n; i++) {
        const idx = first + i;
        const base = i * strideFloats;
        const t = (idx % 1024) * 0.01;
        f32[base + 0] = Math.sin(t) * 5.0 + (idx % 17) * 0.1;
        f32[base + 1] = Math.cos(t * 0.7) * 3.0;
        f32[base + 2] = ((idx % 251) - 125) * 0.04;
        f32[base + 3] = 0; f32[base + 4] = 1; f32[base + 5] = 0;
        f32[base + 6] = ((idx % 31) - 15) * 0.08;
        f32[base + 7] = ((idx % 29) - 14) * 0.08;
        f32[base + 8] = ((idx % 23) - 11) * 0.08;
        for (let k = 0; k < 45; k++) {
          f32[base + 9 + k] = (((idx + k * 7) % 19) - 9) * 0.015;
        }
        f32[base + 54] = ((idx % 13) - 4) * 0.35; // opacity logit
        f32[base + 55] = -3.2 + (idx % 5) * 0.15;
        f32[base + 56] = -3.0 + (idx % 7) * 0.12;
        f32[base + 57] = -3.4 + (idx % 3) * 0.18;
        // normalized quat
        const qw = 0.85, qx = 0.25, qy = -0.35, qz = 0.3041381265;
        f32[base + 58] = qw;
        f32[base + 59] = qx;
        f32[base + 60] = qy;
        f32[base + 61] = qz;
      }
      fs.writeSync(fd, block, 0, n * strideBytes);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Non-uniform scale + arbitrary 3D rotation + translation column-major 4x4 matrix
function makeComplexMat4(tx, ty, tz, sx, sy, sz, angleY, angleX) {
  const cy = Math.cos(angleY), syA = Math.sin(angleY);
  const cx = Math.cos(angleX), sxA = Math.sin(angleX);
  // R = Ry * Rx, M = T * R * S
  const r00 = cy, r01 = syA * sxA, r02 = syA * cx;
  const r10 = 0, r11 = cx, r12 = -sxA;
  const r20 = -syA, r21 = cy * sxA, r22 = cy * cx;
  return [
    r00 * sx, r10 * sx, r20 * sx, 0,
    r01 * sy, r11 * sy, r21 * sy, 0,
    r02 * sz, r12 * sz, r22 * sz, 0,
    tx, ty, tz, 1,
  ];
}

function makeHeavyV4Recipe(count, lutName) {
  // Delete ~25% in alternating spans to exercise bitset & chunk boundaries
  const deletedRle = [100, 50, 200, 80, 150, 120, Math.max(0, count - 700)];
  const entityDeltaMatrix = makeComplexMat4(1.25, -0.75, 2.5, 1.15, 0.9, 1.05, 0.42, -0.28);
  const pal0 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const pal1 = makeComplexMat4(-0.5, 0.3, 0.8, 1.2, 1.2, 1.2, -0.35, 0.19);
  const half = Math.floor(count / 2);
  return {
    version: 4,
    coordSystem: "y-up",
    deletedRle,
    entityDeltaMatrix,
    paletteMatrices: [pal0, pal1],
    transformIdxRle: [0, half, 1, count - half],
    paintDelta: {
      indices: [5, 105, Math.min(count - 1, 512)],
      dc: [0.4, -0.2, 0.1, -0.3, 0.5, 0.2, 0.1, 0.1, -0.4],
    },
    colorGrade: {
      enabled: true,
      brightness: 0.08,
      saturation: 1.18,
      temperature: 0.12,
      tint: [1.03, 0.99, 0.96],
      blackPoint: 0.02,
      whitePoint: 0.96,
      transparency: 0.95,
      hslHue: [4, -3, 2, 0, -5, 3, 1, -2],
      hslSat: [8, 4, -2, 0, 6, 5, -3, 2],
      hslLight: [2, 0, -1, 1, 0, -2, 2, 0],
      lutName: lutName || "",
      lutIntensity: lutName ? 0.65 : 0,
    },
  };
}

function makeFilterOnlyV4Recipe(count) {
  const step = Math.max(100, Math.floor(count / 10));
  const deletedRle = [];
  let rem = count;
  while (rem > 0) {
    const keep = Math.min(rem, Math.floor(step * 0.7));
    deletedRle.push(keep);
    rem -= keep;
    if (rem > 0) {
      const del = Math.min(rem, step - keep);
      deletedRle.push(del);
      rem -= del;
    }
  }
  return {
    version: 4,
    coordSystem: "y-up",
    deletedRle,
    entityDeltaMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    paletteMatrices: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
    colorGrade: null,
  };
}

function makeHeavyV3Recipe(count, lutName) {
  const splitStart = Math.floor(count * 0.6);
  const splitLen = Math.floor(count * 0.25);
  const grade = {
    exposure: 0.2,
    brightness: 0.05,
    contrast: 1.08,
    blackPoint: 0.01,
    whitePoint: 0.98,
    highlights: -0.05,
    shadows: 0.08,
    saturation: 1.15,
    temperature: 0.1,
    tint: [1.02, 1.0, 0.97],
    gamma: 1.0,
    transparency: 0.96,
    hslHue: [3, -2, 1, 0, -4, 2, 0, 0],
    hslSat: [6, 3, -2, 0, 4, 3, 0, 0],
    hslLight: [1, 0, 0, 0, 0, -1, 0, 0],
    lutName: lutName || "",
    lutIntensity: lutName ? 0.55 : 0,
  };
  return {
    version: 3,
    coordSystem: "y-up",
    deletedRanges: [[20, 45], [Math.floor(count * 0.3), Math.floor(count * 0.1)]],
    objects: [
      {
        id: 0,
        name: "Main",
        visible: true,
        sourceKind: "original",
        memberRanges: "all",
        excludedRanges: [[splitStart, splitLen]],
        matrix: makeComplexMat4(0.8, -0.4, 1.5, 1.1, 0.95, 1.05, 0.31, -0.17),
        bakedGrades: [{ targetRanges: "all", grade }],
      },
      {
        id: 1,
        name: "SplitPiece",
        visible: true,
        sourceKind: "split",
        memberRanges: [[splitStart, splitLen]],
        matrix: makeComplexMat4(-1.2, 0.6, -0.3, 1.25, 1.25, 1.25, -0.52, 0.24),
        bakedGrades: [{ targetRanges: "all", grade }],
      },
    ],
  };
}

function makeFilterOnlyV3Recipe(count) {
  return {
    version: 3,
    coordSystem: "y-up",
    deletedRanges: [[0, Math.floor(count * 0.15)], [Math.floor(count * 0.5), Math.floor(count * 0.15)]],
    objects: [
      {
        id: 0,
        name: "Main",
        visible: true,
        sourceKind: "original",
        memberRanges: "all",
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        bakedGrades: [],
      },
    ],
  };
}

async function runCorrectnessSuite() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "splat-par-test-"));
  const lutName = findFirstLutName();
  const checks = [];
  try {
    const N = 3200;
    const inPly = path.join(tmpDir, "small_sh3.ply");
    writeSyntheticSh3Ply(inPly, N);

    // Check 1: v4 bit-exact parity across > 25 chunks
    {
      const recipe = makeHeavyV4Recipe(N, lutName);
      const outSerial = path.join(tmpDir, "v4_serial.ply");
      const outPar = path.join(tmpDir, "v4_par.ply");
      const keptSerial = processPlyV4(inPly, outSerial, recipe, lutsDir);
      const resPar = await processPlyV4Parallel(inPly, outPar, recipe, lutsDir, {
        threads: 4,
        forceParallel: true,
        chunkTargetBytes: 32 * 1024, // force many tiny chunks!
      });
      assert.equal(resPar.mode, "parallel");
      assert.equal(resPar.kept, keptSerial);
      const hS = sha256File(outSerial);
      const hP = sha256File(outPar);
      assert.equal(hP, hS, "v4 parallel output MUST be bit-exact with serial gold processPlyV4");
      checks.push({ name: "1_v4_bit_exact_multi_chunk", ok: true, kept: keptSerial, chunks: resPar.chunks, sha256: hP.slice(0, 16) });
    }

    // Check 2: v3 main + split bit-exact parity across > 25 chunks
    {
      const recipe = makeHeavyV3Recipe(N, lutName);
      assert.equal(isV3RecipeParallelEligible(recipe), true);
      const outSerial = path.join(tmpDir, "v3_serial.ply");
      const outPar = path.join(tmpDir, "v3_par.ply");
      const keptSerial = processPlyV3(inPly, outSerial, recipe, lutsDir);
      const resPar = await processPlyV3Parallel(inPly, outPar, recipe, lutsDir, {
        threads: 4,
        forceParallel: true,
        chunkTargetBytes: 32 * 1024,
      });
      assert.equal(resPar.mode, "parallel");
      assert.equal(resPar.kept, keptSerial);
      const hS = sha256File(outSerial);
      const hP = sha256File(outPar);
      assert.equal(hP, hS, "v3 parallel main+split output MUST be bit-exact with serial gold processPlyV3");
      checks.push({ name: "2_v3_main_split_bit_exact", ok: true, kept: keptSerial, chunks: resPar.chunks, sha256: hP.slice(0, 16) });
    }

    // Check 3: Mixed v3 recipe (main + split + duplicate + synthetic-inpaint) -> clean serial fallback & bit-exact parity
    {
      const mixed = makeHeavyV3Recipe(N, lutName);
      mixed.objects.push({
        id: 2,
        name: "DupObj",
        visible: true,
        sourceKind: "duplicate",
        memberRanges: [[100, 120]],
        matrix: makeComplexMat4(3, 0, 0, 1, 1, 1, 0, 0),
        bakedGrades: [],
      });
      const synthPos = new Float32Array([1, 2, 3, 4, 5, 6]);
      const synthSc = new Float32Array([-3, -3, -3, -3, -3, -3]);
      const synthQt = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]);
      const synthRg = new Uint8Array([200, 100, 50, 255, 80, 180, 220, 255]);
      mixed.objects.push({
        id: 3,
        name: "InpaintPatch",
        visible: true,
        sourceKind: "synthetic-inpaint",
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        syntheticData: {
          count: 2,
          posB64: Buffer.from(synthPos.buffer).toString("base64"),
          scaleB64: Buffer.from(synthSc.buffer).toString("base64"),
          quatB64: Buffer.from(synthQt.buffer).toString("base64"),
          rgbaB64: Buffer.from(synthRg.buffer).toString("base64"),
        },
        bakedGrades: [],
      });
      assert.equal(isV3RecipeParallelEligible(mixed), false, "Mixed duplicate+synthetic recipe must route to serial");
      const outSerial = path.join(tmpDir, "v3_mixed_serial.ply");
      const outPar = path.join(tmpDir, "v3_mixed_par.ply");
      const keptSerial = processPlyV3(inPly, outSerial, mixed, lutsDir);
      const resPar = await processPlyV3Parallel(inPly, outPar, mixed, lutsDir, { threads: 4, forceParallel: true });
      assert.equal(resPar.mode, "serial");
      assert.equal(resPar.kept, keptSerial);
      assert.equal(sha256File(outPar), sha256File(outSerial), "Mixed recipe fallback must match serial bit-for-bit");
      checks.push({ name: "3_v3_mixed_extended_fallback_exact", ok: true, kept: keptSerial, mode: resPar.mode });
    }

    // Check 4: Repeat determinism across consecutive parallel runs
    {
      const recipe = makeHeavyV4Recipe(N, lutName);
      const outA = path.join(tmpDir, "det_a.ply");
      const outB = path.join(tmpDir, "det_b.ply");
      await processPlyV4Parallel(inPly, outA, recipe, lutsDir, { threads: 4, forceParallel: true, chunkTargetBytes: 32 * 1024 });
      await processPlyV4Parallel(inPly, outB, recipe, lutsDir, { threads: 4, forceParallel: true, chunkTargetBytes: 32 * 1024 });
      assert.equal(sha256File(outA), sha256File(outB), "Repeated parallel runs must be 100% deterministic");
      checks.push({ name: "4_repeat_determinism", ok: true });
    }

    // Check 5: AbortSignal cancellation cleans up tmp & leaves zero partial target
    {
      const cancelDir = path.join(tmpDir, "cancel_case");
      fs.mkdirSync(cancelDir);
      const outCancel = path.join(cancelDir, "cancelled.ply");
      const ac = new AbortController();
      let rejectedAsAbort = false;
      try {
        await processPlyV4Parallel(inPly, outCancel, makeHeavyV4Recipe(N, lutName), lutsDir, {
          threads: 4,
          forceParallel: true,
          chunkTargetBytes: 32 * 1024,
          signal: ac.signal,
          writeHookForTest: (chunkId) => {
            if (chunkId >= 1) ac.abort("user-cancel");
          },
        });
      } catch (err) {
        rejectedAsAbort = err?.name === "AbortError" || err?.code === "ABORT_ERR";
      }
      assert.equal(rejectedAsAbort, true, "Cancellation must reject with AbortError");
      assert.equal(fs.existsSync(outCancel), false, "Cancelled bake must NEVER create output file");
      assert.deepEqual(fs.readdirSync(cancelDir), [], "Cancelled bake must leave zero leftover .tmp files");
      checks.push({ name: "5_cancel_cleanup_zero_partial", ok: true });
    }

    // Check 6: Disk write error (ENOSPC) cleans up tmp & leaves zero partial target
    {
      const errDir = path.join(tmpDir, "err_case");
      fs.mkdirSync(errDir);
      const outErr = path.join(errDir, "diskfull.ply");
      let sawEnospc = false;
      try {
        await processPlyV3Parallel(inPly, outErr, makeHeavyV3Recipe(N, lutName), lutsDir, {
          threads: 4,
          forceParallel: true,
          chunkTargetBytes: 32 * 1024,
          writeHookForTest: (chunkId) => {
            if (chunkId >= 2) {
              const e = new Error("ENOSPC: no space left on device");
              e.code = "ENOSPC";
              throw e;
            }
          },
        });
      } catch (err) {
        sawEnospc = err?.code === "ENOSPC";
      }
      assert.equal(sawEnospc, true, "Simulated write error must propagate ENOSPC");
      assert.equal(fs.existsSync(outErr), false, "Failed bake must NEVER leave partial output file");
      assert.deepEqual(fs.readdirSync(errDir), [], "Failed bake must leave zero leftover .tmp files");
      checks.push({ name: "6_write_error_cleanup_zero_partial", ok: true });
    }

    // Check 7 (002-A Revision #1): Slow disk writer backpressure enforces strict maxInFlightBytes!
    {
      const recipe = makeHeavyV4Recipe(N, lutName);
      const refOut = path.join(tmpDir, "budget_ref_v4.ply");
      processPlyV4(inPly, refOut, recipe, lutsDir);
      const refSha = sha256File(refOut);

      const budget = 320 * 1024; // 320 KiB tight budget
      const outSlow = path.join(tmpDir, "slow_disk_v4.ply");
      const resSlow = await processPlyV4Parallel(inPly, outSlow, recipe, lutsDir, {
        threads: 4,
        forceParallel: true,
        chunkTargetBytes: 64 * 1024, // 256 rows * 248 B = 63,488 B in + 63,488 B out = 126,976 B per chunk -> max 2 chunks in flight!
        maxInFlightBytes: budget,
        writeHookForTest: async () => {
          await new Promise((r) => setTimeout(r, 15));
        },
      });
      assert.equal(sha256File(outSlow), refSha, "Slow-disk backpressure output MUST remain bit-exact");
      assert.ok(resSlow.peakReservedBytes <= budget, `peakReservedBytes (${resSlow.peakReservedBytes}) exceeded budget (${budget})`);
      assert.ok(resSlow.peakActualBufferBytes <= budget, `peakActualBufferBytes (${resSlow.peakActualBufferBytes}) exceeded budget (${budget})`);
      assert.ok(resSlow.backpressurePauses > 0, "Expected backpressure pauses under slow disk");
      checks.push({
        name: "7_budget_slow_disk_backpressure",
        ok: true,
        budgetBytes: budget,
        peakReservedBytes: resSlow.peakReservedBytes,
        peakActualBufferBytes: resSlow.peakActualBufferBytes,
        backpressurePauses: resSlow.backpressurePauses,
      });

      // Check 8 (002-A Revision #1): First-chunk delay forcing out-of-order completion -> reorderMap MUST stay strictly inside budget!
      const outOoo = path.join(tmpDir, "ooo_first_delay_v4.ply");
      const resOoo = await processPlyV4Parallel(inPly, outOoo, recipe, lutsDir, {
        threads: 4,
        forceParallel: true,
        chunkTargetBytes: 64 * 1024,
        maxInFlightBytes: budget,
        chunkDelayForTest: (cid) => (cid === 0 ? 110 : 0),
      });
      assert.equal(sha256File(outOoo), refSha, "Out-of-order completion output MUST be strictly ordered & bit-exact");
      assert.ok(resOoo.peakReservedBytes <= budget, `OOO peakReservedBytes (${resOoo.peakReservedBytes}) exceeded budget (${budget})`);
      assert.ok(resOoo.peakActualBufferBytes <= budget, `OOO peakActualBufferBytes (${resOoo.peakActualBufferBytes}) exceeded budget (${budget})`);
      assert.ok(resOoo.peakReorderEntries >= 1, "Expected out-of-order chunks buffered in reorderMap while chunk 0 delayed");
      assert.ok(resOoo.backpressurePauses > 0, "Expected budget gate to halt dispatch while chunk 0 blocked reorderMap");
      checks.push({
        name: "8_budget_first_chunk_delay_ooo",
        ok: true,
        budgetBytes: budget,
        peakReservedBytes: resOoo.peakReservedBytes,
        peakActualBufferBytes: resOoo.peakActualBufferBytes,
        peakReorderEntries: resOoo.peakReorderEntries,
        backpressurePauses: resOoo.backpressurePauses,
      });

      // Check 9 (002-A Revision #1): Large chunk approaching budget (~85% of budget for in+out -> strictly 1 chunk at a time, zero overshoot even when inFlightChunks===0 while writer holds buffer!)
      const tightBudget = 300 * 1024;
      const outLarge = path.join(tmpDir, "large_chunk_budget_v3.ply");
      const v3Recipe = makeHeavyV3Recipe(N, lutName);
      const refV3 = path.join(tmpDir, "budget_ref_v3.ply");
      processPlyV3(inPly, refV3, v3Recipe, lutsDir);
      const resLarge = await processPlyV3Parallel(inPly, outLarge, v3Recipe, lutsDir, {
        threads: 4,
        forceParallel: true,
        chunkTargetBytes: 130 * 1024, // ~128 KiB in + ~128 KiB out = ~256 KiB (~85% of 300 KiB budget!)
        maxInFlightBytes: tightBudget,
        writeHookForTest: async () => {
          await new Promise((r) => setTimeout(r, 12));
        },
      });
      assert.equal(sha256File(outLarge), sha256File(refV3), "Large-chunk near-budget v3 output MUST be bit-exact");
      assert.ok(resLarge.peakReservedBytes <= tightBudget, `Large-chunk peakReservedBytes (${resLarge.peakReservedBytes}) exceeded budget (${tightBudget})`);
      assert.ok(resLarge.peakActualBufferBytes <= tightBudget, `Large-chunk peakActualBufferBytes (${resLarge.peakActualBufferBytes}) exceeded budget (${tightBudget})`);
      assert.ok(resLarge.backpressurePauses > 0, "Expected backpressure pause while writer held large chunk output buffer");
      checks.push({
        name: "9_budget_large_chunk_near_cap",
        ok: true,
        budgetBytes: tightBudget,
        peakReservedBytes: resLarge.peakReservedBytes,
        peakActualBufferBytes: resLarge.peakActualBufferBytes,
        backpressurePauses: resLarge.backpressurePauses,
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return checks;
}

async function measureOneBake(fn, outPath) {
  let maxTickGapMs = 0;
  let lastTick = performance.now();
  let peakRssBytes = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - lastTick;
    if (gap > maxTickGapMs) maxTickGapMs = gap;
    lastTick = now;
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  }, 16);

  const t0 = performance.now();
  const res = await fn();
  const nowEnd = performance.now();
  const wallMs = nowEnd - t0;
  const finalGap = nowEnd - lastTick;
  if (finalGap > maxTickGapMs) maxTickGapMs = finalGap;
  clearInterval(timer);

  const finalRss = process.memoryUsage().rss;
  if (finalRss > peakRssBytes) peakRssBytes = finalRss;
  const sha = sha256File(outPath);
  const outBytes = fs.statSync(outPath).size;
  return {
    kept: res.kept,
    mode: res.mode,
    threads: res.threads,
    wallMs: Number(wallMs.toFixed(1)),
    peakRssMiB: Number((peakRssBytes / 1048576).toFixed(1)),
    peakReservedMiB: res.peakReservedBytes != null ? Number((res.peakReservedBytes / 1048576).toFixed(2)) : null,
    peakActualBufferMiB: res.peakActualBufferBytes != null ? Number((res.peakActualBufferBytes / 1048576).toFixed(2)) : null,
    maxInFlightMiB: res.maxInFlightBytes != null ? Number((res.maxInFlightBytes / 1048576).toFixed(2)) : null,
    backpressurePauses: res.backpressurePauses ?? 0,
    maxEventLoopGapMs: Number(maxTickGapMs.toFixed(1)),
    outBytes,
    sha256: sha,
  };
}

async function runBenchmarkSuite(outJsonPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "splat-par-bench-"));
  const lutName = findFirstLutName();
  const BENCH_POINTS = 500000; // 500k full-SH3 vertices = ~124 MB PLY on disk
  const inPly = path.join(tmpDir, "bench_500k_sh3.ply");
  try {
    const tGen0 = performance.now();
    writeSyntheticSh3Ply(inPly, BENCH_POINTS);
    const genMs = Number((performance.now() - tGen0).toFixed(1));
    const inBytes = fs.statSync(inPly).size;

    const threadCounts = [1, 2, 4, 8];
    const workloads = [
      { id: "v4_filter_only", kind: "v4", recipe: makeFilterOnlyV4Recipe(BENCH_POINTS) },
      { id: "v4_heavy_xform_sh3_lut", kind: "v4", recipe: makeHeavyV4Recipe(BENCH_POINTS, lutName) },
      { id: "v3_filter_only", kind: "v3", recipe: makeFilterOnlyV3Recipe(BENCH_POINTS) },
      { id: "v3_heavy_xform_sh3_lut", kind: "v3", recipe: makeHeavyV3Recipe(BENCH_POINTS, lutName) },
    ];

    const benchResults = {};
    for (const wl of workloads) {
      const rows = [];
      let baseWallMs = 0;
      let baseSha = null;
      for (const tc of threadCounts) {
        const outPly = path.join(tmpDir, `${wl.id}_t${tc}.ply`);
        const runner = wl.kind === "v4"
          ? () => processPlyV4Parallel(inPly, outPly, wl.recipe, lutsDir, { threads: tc, forceParallel: tc > 1 })
          : () => processPlyV3Parallel(inPly, outPly, wl.recipe, lutsDir, { threads: tc, forceParallel: tc > 1 });
        const m = await measureOneBake(runner, outPly);
        try { fs.rmSync(outPly, { force: true }); } catch { /* ignore */ }
        if (tc === 1) {
          baseWallMs = m.wallMs;
          baseSha = m.sha256;
        }
        assert.equal(m.sha256, baseSha, `${wl.id} threads=${tc} SHA-256 mismatch vs serial 1-thread!`);
        rows.push({
          requestedThreads: tc,
          ...m,
          speedupVs1T: Number((baseWallMs / Math.max(0.1, m.wallMs)).toFixed(2)),
          bitExactVs1T: m.sha256 === baseSha,
        });
      }
      benchResults[wl.id] = rows;
    }

    const report = {
      timestamp: new Date().toISOString(),
      machine: {
        cpu: os.cpus()?.[0]?.model || "unknown",
        logicalCores: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
        totalRamGiB: Number((os.totalmem() / (1024 ** 3)).toFixed(1)),
        nodeVersion: process.version,
        defaultBakeThreads: resolveDefaultBakeThreads(),
      },
      fixture: {
        vertexCount: BENCH_POINTS,
        strideBytes: 248,
        shDegree: 3,
        inputSizeMiB: Number((inBytes / 1048576).toFixed(2)),
        lutUsed: lutName,
        generateMs: genMs,
      },
      workloads: benchResults,
    };

    if (outJsonPath) {
      fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
      fs.writeFileSync(outJsonPath, JSON.stringify(report, null, 2), "utf8");
    }
    return report;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const doBench = args.includes("--bench");
const outArg = args.find((a) => a.startsWith("--out="));
const outJsonPath = outArg ? path.resolve(outArg.slice("--out=".length)) : null;

const checks = await runCorrectnessSuite();
const summary = { ok: true, passed: checks.length, total: checks.length, checks };
if (doBench) {
  summary.benchmark = await runBenchmarkSuite(outJsonPath);
}
console.log(JSON.stringify(summary, null, 2));
