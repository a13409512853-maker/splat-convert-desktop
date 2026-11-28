/**
 * @module ply-parallel
 * @description Bounded Multi-Threaded PLY Baker (002-A Step 4: v4 pilot + v3 main/split object path).
 *
 * Guarantees:
 *  1. Gold serial equivalence: exact same source vertex ordering & bit-exact float output as serial ply.mjs.
 *  2. Bounded resources: capped worker pool (1..8), bounded in-flight chunk count & byte budget (default 64 MB).
 *  3. Zero-copy chunk transfers & read-only SharedArrayBuffer bitsets (scales smoothly to 35M+ scenes).
 *  4. Strictly ordered sequential disk writer into a sibling `.tmp` file with atomic final rename.
 *  5. Cancellation (AbortSignal) & disk/worker error cleanup: immediately terminates workers and removes `.tmp`,
 *     never leaving partial or corrupt target files.
 *  6. Scope boundary per 002-A ruling: extended v3 paths (`duplicate`, `synthetic-inpaint`, `mergedPieces`)
 *     cleanly delegate to gold serial `processPlyV3` until verified equivalent.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  layout,
  processPlyV3,
  processPlyV4,
  decodePngRgba,
  buildBitsetFromRanges,
  buildBitsetFromBoolRle,
  decodeUint16Rle,
  isIdentityMatrix16,
  mulMat4Col,
} from "./ply.mjs";
import { isGradeModified } from "./color-grade.js";

export const DEFAULT_SERIAL_THRESHOLD = 65536;
export const DEFAULT_FILTER_ONLY_SERIAL_THRESHOLD = 2000000;
export const DEFAULT_MAX_INFLIGHT_BYTES = 64 * 1024 * 1024; // 64 MB strict memory cap
export const DEFAULT_CHUNK_TARGET_BYTES = 4 * 1024 * 1024;  // ~4 MB raw PLY per chunk

const WORKER_URL = new URL("./ply-chunk-worker.mjs", import.meta.url);

export function resolveDefaultBakeThreads(requested = null) {
  const cpuCount = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : (os.cpus()?.length || 4);
  const envVal = process.env.SPLAT_BAKE_THREADS ? Number(process.env.SPLAT_BAKE_THREADS) : NaN;
  const raw = requested != null && Number.isFinite(Number(requested))
    ? Number(requested)
    : Number.isFinite(envVal) && envVal > 0
      ? envVal
      : Math.min(6, Math.max(1, cpuCount - 2)); // Evidence-backed sweet spot: ~3x+ compute speedup while reserving cores for UI/OS
  return Math.max(1, Math.min(8, Math.floor(raw)));
}

function toReadOnlySab(typedArr) {
  if (!typedArr || typedArr.byteLength === 0) return null;
  const sab = new SharedArrayBuffer(typedArr.byteLength);
  new Uint8Array(sab).set(new Uint8Array(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength));
  return sab;
}

function makeAbortError(reason) {
  const err = new Error(reason ? `Bake cancelled: ${reason}` : "Bake cancelled");
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

/**
 * Check whether a v3 recipe qualifies for the parallel main/split object path.
 * Extended paths (`duplicate`, `synthetic-inpaint`, `mergedPieces`) safely delegate to gold serial `processPlyV3`.
 */
export function isV3RecipeParallelEligible(recipe) {
  const rawObjects = Array.isArray(recipe?.objects) ? recipe.objects : [];
  if (rawObjects.length === 0) return false;
  const exportIdSet =
    Array.isArray(recipe.exportObjectIds) && recipe.exportObjectIds.length > 0
      ? new Set(recipe.exportObjectIds.map((v) => Number(v)))
      : null;

  let activeCount = 0;
  for (const obj of rawObjects) {
    if (exportIdSet && !exportIdSet.has(Number(obj.id))) continue;
    if (obj.exportSkip) continue;
    activeCount++;
    const kind = obj.sourceKind || "original";
    if (kind === "duplicate" || kind === "synthetic-inpaint") return false;
    if (Array.isArray(obj.mergedPieces) && obj.mergedPieces.length > 0) return false;
  }
  return activeCount > 0;
}

function buildTmpOutputPath(output) {
  const dir = path.dirname(output);
  const base = path.basename(output);
  const tag = crypto.randomBytes(6).toString("hex");
  return path.join(dir, `.${base}.bake-${process.pid}-${tag}.tmp`);
}

/**
 * Atomic serial fallback wrapper (ensures even serial fallback NEVER leaves partial output on failure/cancel).
 */
function runSerialAtomic(serialFn, input, output, recipe, lutsDir, signal) {
  if (signal?.aborted) throw makeAbortError(signal.reason);
  const tmpPath = buildTmpOutputPath(output);
  try {
    const kept = serialFn(input, tmpPath, recipe, lutsDir);
    if (signal?.aborted) throw makeAbortError(signal.reason);
    fs.renameSync(tmpPath, output);
    return { kept, mode: "serial", threads: 1 };
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Core bounded parallel chunk pipeline:
 *  - Strict pre-allocation buffer budget (`maxInFlightBytes`, default 64 MiB) covering ALL live transient
 *    buffers across the pipeline:
 *      1) input ArrayBuffers being read or processed by active workers,
 *      2) worst-case output capacity reserved BEFORE worker dispatch,
 *      3) actual underlying `outArrayBuffer.byteLength` held in `reorderMap` and the active sequential writer.
 *  - Never dispatches a new chunk when `reservedBytes + nextChunkNeed > maxInFlightBytes` (except when the
 *    entire pipeline — workers, reorderMap, AND writer — is 100% idle, preventing deadlock if a caller
 *    explicitly requests a single chunk exceeding budget).
 *  - Strictly ordered sequential async writes -> `.tmp` atomic commit -> full cancel/error cleanup.
 */
async function executeParallelPipeline({
  input,
  output,
  plyLayout,
  workerDataBase,
  threads,
  chunkTargetBytes,
  maxInFlightBytes,
  signal,
  onProgress,
  writeHookForTest,
  chunkDelayForTest,
}) {
  if (signal?.aborted) throw makeAbortError(signal.reason);

  const count = plyLayout.count;
  const stride = plyLayout.stride;
  const budgetCap = Math.max(stride * 2, Math.floor(maxInFlightBytes || DEFAULT_MAX_INFLIGHT_BYTES));
  const rowsPerChunk = Math.max(1, Math.min(count, Math.max(256, Math.floor(chunkTargetBytes / stride))));
  const totalChunks = Math.ceil(count / rowsPerChunk);
  const effectiveThreads = Math.max(1, Math.min(threads, totalChunks));
  const maxInFlightChunks = Math.max(effectiveThreads * 2, 2);

  const makeHeader = (n) =>
    Buffer.from(
      plyLayout.header.replace(/^(element vertex )\d+/m, (_, p) => p + String(n).padStart(16, "0")),
      "latin1",
    );

  const tmpPath = buildTmpOutputPath(output);
  let inHandle = null;
  let outHandle = null;
  const workers = [];
  let abortedOrFailed = null;
  let totalWritten = 0;

  // Strict budget telemetry (verifiable in tests & benchmark reports)
  let peakReservedBytes = 0;
  let peakActualBufferBytes = 0;
  let peakReorderEntries = 0;
  let backpressurePauses = 0;

  const terminateAllWorkers = async () => {
    await Promise.allSettled(workers.map((w) => w.terminate()));
    workers.length = 0;
  };

  try {
    inHandle = await fsp.open(input, "r");
    outHandle = await fsp.open(tmpPath, "w");
    const initHeader = makeHeader(0);
    await outHandle.write(initHeader, 0, initHeader.length, 0);
    let writeFileOffset = initHeader.length;

    // Spawn bounded worker pool
    const idleWorkers = [];
    for (let t = 0; t < effectiveThreads; t++) {
      const w = new Worker(WORKER_URL, { workerData: workerDataBase });
      workers.push(w);
      idleWorkers.push(w);
    }

    await new Promise((resolve, reject) => {
      let nextDispatchChunkId = 0;
      let nextWriteChunkId = 0;
      let inFlightChunks = 0;
      let reservedInputBytes = 0;
      let reservedOutputBytes = 0;
      let actualOutputHeldBytes = 0; // actual outArrayBuffer.byteLength in reorderMap + active writer
      let reading = false;
      let dispatchPending = false;
      let writing = false;
      let settled = false;
      const reorderMap = new Map(); // chunkId -> { kept, byteLength, capacityBytes, outArrayBuffer }

      const recordPeaks = () => {
        const totalRes = reservedInputBytes + reservedOutputBytes;
        if (totalRes > peakReservedBytes) peakReservedBytes = totalRes;
        if (totalRes > peakActualBufferBytes) peakActualBufferBytes = totalRes;
        if (reorderMap.size > peakReorderEntries) peakReorderEntries = reorderMap.size;
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        abortedOrFailed = err;
        reject(err);
      };

      const onAbort = () => fail(makeAbortError(signal?.reason));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const cleanupListeners = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      const maybeFinish = () => {
        if (settled) return;
        if (nextWriteChunkId >= totalChunks && !writing && inFlightChunks === 0 && reorderMap.size === 0) {
          settled = true;
          cleanupListeners();
          resolve();
        }
      };

      const drainWriter = async () => {
        if (writing || settled) return;
        writing = true;
        try {
          while (!settled && reorderMap.has(nextWriteChunkId)) {
            const item = reorderMap.get(nextWriteChunkId);
            reorderMap.delete(nextWriteChunkId);
            nextWriteChunkId++;

            try {
              if (item.byteLength > 0) {
                if (typeof writeHookForTest === "function") {
                  await writeHookForTest(nextWriteChunkId - 1, item.byteLength, item.capacityBytes);
                }
                if (settled) return;
                const buf = Buffer.from(item.outArrayBuffer, 0, item.byteLength);
                let off = 0;
                while (off < item.byteLength) {
                  const { bytesWritten } = await outHandle.write(buf, off, item.byteLength - off, writeFileOffset);
                  if (!bytesWritten) throw new Error("Short write to temporary PLY output");
                  off += bytesWritten;
                  writeFileOffset += bytesWritten;
                }
                totalWritten += item.kept;
              }
            } finally {
              // Release exact underlying ArrayBuffer capacity ONLY after disk write finishes!
              reservedOutputBytes = Math.max(0, reservedOutputBytes - item.capacityBytes);
              actualOutputHeldBytes = Math.max(0, actualOutputHeldBytes - item.capacityBytes);
            }

            if (typeof onProgress === "function") {
              onProgress(Math.min(99, Math.round((nextWriteChunkId / totalChunks) * 100)));
            }
            pumpDispatch();
          }
        } catch (err) {
          fail(err);
        } finally {
          writing = false;
          if (!settled) {
            pumpDispatch();
            maybeFinish();
          }
        }
      };

      const pumpDispatch = async () => {
        if (settled) return;
        if (reading) {
          dispatchPending = true;
          return;
        }
        reading = true;
        try {
          do {
            dispatchPending = false;
            while (
              !settled &&
              nextDispatchChunkId < totalChunks &&
              idleWorkers.length > 0 &&
              inFlightChunks < maxInFlightChunks
            ) {
              const chunkId = nextDispatchChunkId;
              const startIdx = chunkId * rowsPerChunk;
              const n = Math.min(rowsPerChunk, count - startIdx);
              const inBytes = n * stride;
              const outReserveBytes = n * stride; // worst-case output capacity for this chunk
              const needBytes = inBytes + outReserveBytes;
              const currentReserved = reservedInputBytes + reservedOutputBytes;
              const pipelineCompletelyIdle =
                inFlightChunks === 0 && reorderMap.size === 0 && !writing && currentReserved === 0;

              if (currentReserved + needBytes > budgetCap && !pipelineCompletelyIdle) {
                backpressurePauses++;
                break;
              }

              // Reserve BOTH input & worst-case output capacity BEFORE allocating ArrayBuffer!
              nextDispatchChunkId++;
              const worker = idleWorkers.pop();
              inFlightChunks++;
              reservedInputBytes += inBytes;
              reservedOutputBytes += outReserveBytes;
              worker._assignedInBytes = inBytes;
              worker._assignedOutReserve = outReserveBytes;
              recordPeaks();

              let inAb;
              try {
                inAb = new ArrayBuffer(inBytes);
                const inView = Buffer.from(inAb);
                let readDone = 0;
                const fileOffset = plyLayout.start + startIdx * stride;
                while (readDone < inBytes) {
                  const { bytesRead } = await inHandle.read(inView, readDone, inBytes - readDone, fileOffset + readDone);
                  if (!bytesRead) throw new Error("Unexpected end of input PLY");
                  readDone += bytesRead;
                }
              } catch (readErr) {
                inFlightChunks = Math.max(0, inFlightChunks - 1);
                reservedInputBytes = Math.max(0, reservedInputBytes - inBytes);
                reservedOutputBytes = Math.max(0, reservedOutputBytes - outReserveBytes);
                worker._assignedInBytes = 0;
                worker._assignedOutReserve = 0;
                idleWorkers.push(worker);
                throw readErr;
              }

              if (settled) return;
              const delayMsForTest =
                typeof chunkDelayForTest === "function" ? Number(chunkDelayForTest(chunkId) || 0) : 0;
              worker.postMessage(
                {
                  chunkId,
                  startIdx,
                  count: n,
                  inArrayBuffer: inAb,
                  inByteLength: inBytes,
                  delayMsForTest,
                },
                [inAb],
              );
            }
          } while (!settled && dispatchPending);
        } catch (err) {
          fail(err);
        } finally {
          reading = false;
        }
      };

      for (const worker of workers) {
        worker.on("message", (msg) => {
          if (settled) return;
          const prevIn = worker._assignedInBytes || 0;
          const prevOutRes = worker._assignedOutReserve || 0;
          worker._assignedInBytes = 0;
          worker._assignedOutReserve = 0;
          inFlightChunks = Math.max(0, inFlightChunks - 1);
          // Input buffer has been consumed and released in worker
          reservedInputBytes = Math.max(0, reservedInputBytes - prevIn);

          if (msg.type === "error") {
            reservedOutputBytes = Math.max(0, reservedOutputBytes - prevOutRes);
            fail(new Error(`Worker chunk ${msg.chunkId} failed: ${msg.message}`));
            return;
          }

          // Reconcile reserved output capacity against ACTUAL transferred ArrayBuffer.byteLength!
          const actualCap = msg.outArrayBuffer ? msg.outArrayBuffer.byteLength : 0;
          reservedOutputBytes = Math.max(0, reservedOutputBytes - prevOutRes + actualCap);
          actualOutputHeldBytes += actualCap;
          reorderMap.set(msg.chunkId, {
            kept: msg.kept,
            byteLength: msg.byteLength,
            capacityBytes: actualCap,
            outArrayBuffer: msg.outArrayBuffer,
          });
          recordPeaks();

          idleWorkers.push(worker);
          drainWriter();
          pumpDispatch();
        });

        worker.on("error", (err) => fail(err));
        worker.on("exit", (code) => {
          if (!settled && code !== 0) {
            fail(new Error(`Bake worker exited unexpectedly with code ${code}`));
          }
        });
      }

      pumpDispatch();
    });

    if (abortedOrFailed) throw abortedOrFailed;
    if (totalWritten <= 0) {
      throw new Error("Empty export (all Gaussians deleted)");
    }

    const finalHeader = makeHeader(totalWritten);
    await outHandle.write(finalHeader, 0, finalHeader.length, 0);
    await outHandle.close();
    outHandle = null;
    await inHandle.close();
    inHandle = null;

    await terminateAllWorkers();
    await fsp.rename(tmpPath, output);
    if (typeof onProgress === "function") onProgress(100);
    return {
      kept: totalWritten,
      mode: "parallel",
      threads: effectiveThreads,
      chunks: totalChunks,
      maxInFlightBytes: budgetCap,
      peakReservedBytes,
      peakActualBufferBytes,
      peakReorderEntries,
      backpressurePauses,
    };
  } catch (err) {
    await terminateAllWorkers();
    if (outHandle) {
      try { await outHandle.close(); } catch { /* ignore */ }
    }
    if (inHandle) {
      try { await inHandle.close(); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Bounded multi-threaded v4 PLY processor (with automatic serial fallback for small clouds or threads <= 1).
 */
export async function processPlyV4Parallel(input, output, recipe, lutsDir = null, opts = {}) {
  const threads = resolveDefaultBakeThreads(opts.threads);
  const serialThreshold = opts.serialThreshold ?? DEFAULT_SERIAL_THRESHOLD;
  const forceParallel = !!opts.forceParallel;
  const signal = opts.signal || null;

  const fd = fs.openSync(input, "r");
  let plyLayout;
  try {
    plyLayout = layout(fd);
    if (!plyLayout) throw new Error("Expected normalized binary PLY");
  } finally {
    fs.closeSync(fd);
  }

  if ((!forceParallel && plyLayout.count < serialThreshold) || threads <= 1) {
    return runSerialAtomic(processPlyV4, input, output, recipe, lutsDir, signal);
  }

  const count = plyLayout.count;
  const deletedBits = buildBitsetFromBoolRle(count, recipe.deletedRle);
  const onlyBits = buildBitsetFromBoolRle(count, recipe.onlyIndicesRle);
  const tIndices = decodeUint16Rle(count, recipe.transformIdxRle);

  const idMat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const entityMat = Array.isArray(recipe.entityDeltaMatrix) && recipe.entityDeltaMatrix.length === 16
    ? recipe.entityDeltaMatrix
    : idMat;
  const rawPal = Array.isArray(recipe.paletteMatrices) && recipe.paletteMatrices.length > 0
    ? recipe.paletteMatrices
    : [idMat];
  const slotMatrices = rawPal.map((pm) => {
    const comb = mulMat4Col(entityMat, Array.isArray(pm) && pm.length === 16 ? pm : idMat);
    return isIdentityMatrix16(comb) ? null : Array.from(comb);
  });

  let paintIndicesSab = null;
  let paintDcSab = null;
  if (recipe.paintDelta && Array.isArray(recipe.paintDelta.indices) && recipe.paintDelta.indices.length > 0) {
    const ids = Uint32Array.from(recipe.paintDelta.indices);
    const dcs = Float32Array.from(recipe.paintDelta.dc);
    paintIndicesSab = toReadOnlySab(ids);
    paintDcSab = toReadOnlySab(dcs);
  }

  let gradeObj = null;
  let lutRgbaSab = null;
  const cg = recipe.colorGrade;
  if (cg && cg.enabled) {
    gradeObj = {
      exposure: 0,
      brightness: Number(cg.brightness) || 0,
      contrast: 1,
      blackPoint: Number(cg.blackPoint) || 0,
      whitePoint: typeof cg.whitePoint === "number" ? cg.whitePoint : 1,
      highlights: 0,
      shadows: 0,
      saturation: typeof cg.saturation === "number" ? cg.saturation : 1,
      temperature: Number(cg.temperature) || 0,
      tint: Array.isArray(cg.tint) && cg.tint.length === 3 ? cg.tint : [1, 1, 1],
      gamma: 1,
      transparency: typeof cg.transparency === "number" ? cg.transparency : 1,
      hslHue: Array.isArray(cg.hslHue) ? cg.hslHue : [0, 0, 0, 0, 0, 0, 0, 0],
      hslSat: Array.isArray(cg.hslSat) ? cg.hslSat : [0, 0, 0, 0, 0, 0, 0, 0],
      hslLight: Array.isArray(cg.hslLight) ? cg.hslLight : [0, 0, 0, 0, 0, 0, 0, 0],
      lutIntensity: Number(cg.lutIntensity) || 0,
    };
    if (cg.lutName && cg.lutIntensity > 1e-4 && lutsDir) {
      const candidates = [
        path.join(lutsDir, path.basename(cg.lutName)),
        path.join(lutsDir, path.basename(cg.lutName) + ".png"),
        path.join(lutsDir, path.basename(cg.lutName) + ".PNG"),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          const rgba = decodePngRgba(cand);
          if (rgba) {
            lutRgbaSab = toReadOnlySab(rgba);
            break;
          }
        }
      }
    }
  }

  let shRestCount = 0;
  while (plyLayout.fields["f_rest_" + shRestCount]) shRestCount++;
  const shCoeffsPerChannel =
    shRestCount >= 45 ? 15 : shRestCount >= 24 ? 8 : shRestCount >= 9 ? 3 : 0;

  const hasCompute = slotMatrices.some((m) => m !== null) || gradeObj !== null || paintIndicesSab !== null;
  if (!forceParallel && !hasCompute && plyLayout.count < (opts.filterOnlyThreshold ?? DEFAULT_FILTER_ONLY_SERIAL_THRESHOLD)) {
    return runSerialAtomic(processPlyV4, input, output, recipe, lutsDir, signal);
  }

  return executeParallelPipeline({
    input,
    output,
    plyLayout,
    threads,
    chunkTargetBytes: opts.chunkTargetBytes ?? DEFAULT_CHUNK_TARGET_BYTES,
    maxInFlightBytes: opts.maxInFlightBytes ?? DEFAULT_MAX_INFLIGHT_BYTES,
    signal,
    onProgress: opts.onProgress,
    writeHookForTest: opts.writeHookForTest,
    chunkDelayForTest: opts.chunkDelayForTest,
    workerDataBase: {
      mode: "v4",
      stride: plyLayout.stride,
      fields: plyLayout.fields,
      shCoeffsPerChannel,
      deletedBitsSab: toReadOnlySab(deletedBits),
      onlyBitsSab: toReadOnlySab(onlyBits),
      tIndicesSab: toReadOnlySab(tIndices),
      slotMatrices,
      paintIndicesSab,
      paintDcSab,
      gradeObj,
      lutRgbaSab,
    },
  });
}

/**
 * Bounded multi-threaded v3 PLY processor for main/split object recipes.
 * Extended/mixed paths (`duplicate`, `synthetic-inpaint`, `mergedPieces`) safely delegate
 * to the gold serial `processPlyV3` implementation (atomic commit preserved).
 */
export async function processPlyV3Parallel(input, output, recipe, lutsDir = null, opts = {}) {
  const threads = resolveDefaultBakeThreads(opts.threads);
  const serialThreshold = opts.serialThreshold ?? DEFAULT_SERIAL_THRESHOLD;
  const forceParallel = !!opts.forceParallel;
  const signal = opts.signal || null;

  if (!isV3RecipeParallelEligible(recipe)) {
    return runSerialAtomic(processPlyV3, input, output, recipe, lutsDir, signal);
  }

  const fd = fs.openSync(input, "r");
  let plyLayout;
  try {
    plyLayout = layout(fd);
    if (!plyLayout) throw new Error("Expected normalized binary PLY");
  } finally {
    fs.closeSync(fd);
  }

  if ((!forceParallel && plyLayout.count < serialThreshold) || threads <= 1) {
    return runSerialAtomic(processPlyV3, input, output, recipe, lutsDir, signal);
  }

  const count = plyLayout.count;
  const globalDeleted = buildBitsetFromRanges(count, recipe.deletedRanges);
  const exportIdSet =
    Array.isArray(recipe.exportObjectIds) && recipe.exportObjectIds.length > 0
      ? new Set(recipe.exportObjectIds.map((v) => Number(v)))
      : null;

  const lutSabCache = new Map();
  const getLutSab = (name) => {
    if (!name || name === "默认.png" || !lutsDir) return null;
    if (lutSabCache.has(name)) return lutSabCache.get(name);
    const rgba = decodePngRgba(path.join(lutsDir, path.basename(name)));
    const sab = rgba ? toReadOnlySab(rgba) : null;
    lutSabCache.set(name, sab);
    return sab;
  };

  const rawObjects = Array.isArray(recipe.objects) ? recipe.objects : [];
  const objPlans = [];
  for (const obj of rawObjects) {
    if (exportIdSet && !exportIdSet.has(Number(obj.id))) continue;
    if (obj.exportSkip) continue;

    const isAll = obj.memberRanges === "all" || obj.memberRanges == null;
    const memberBits = isAll ? null : buildBitsetFromRanges(count, obj.memberRanges);
    if (!isAll && !memberBits) continue;

    const excludedBits = buildBitsetFromRanges(count, obj.excludedRanges);
    const objDeletedBits = buildBitsetFromRanges(count, obj.deletedRanges);
    const matrix16 = !isIdentityMatrix16(obj.matrix) ? Array.from(obj.matrix) : null;

    const grades = [];
    if (Array.isArray(obj.bakedGrades)) {
      for (const entry of obj.bakedGrades) {
        if (!entry || !entry.grade || !isGradeModified(entry.grade)) continue;
        const gAll = entry.targetRanges === "all" || entry.targetRanges == null;
        const gBits = gAll ? null : buildBitsetFromRanges(count, entry.targetRanges);
        if (!gAll && !gBits) continue;
        grades.push({
          all: gAll,
          bitsSab: toReadOnlySab(gBits),
          grade: entry.grade,
          lutRgbaSab: getLutSab(entry.grade.lutName),
        });
      }
    }

    objPlans.push({
      id: obj.id,
      all: isAll,
      memberBitsSab: toReadOnlySab(memberBits),
      excludedBitsSab: toReadOnlySab(excludedBits),
      objDeletedBitsSab: toReadOnlySab(objDeletedBits),
      matrix16,
      grades,
    });
  }

  if (objPlans.length === 0) {
    throw new Error("No exportable scene objects");
  }

  const hasCompute = objPlans.some((p) => p.matrix16 !== null || p.grades.length > 0);
  if (!forceParallel && !hasCompute && plyLayout.count < (opts.filterOnlyThreshold ?? DEFAULT_FILTER_ONLY_SERIAL_THRESHOLD)) {
    return runSerialAtomic(processPlyV3, input, output, recipe, lutsDir, signal);
  }

  let shRestCount = 0;
  while (plyLayout.fields["f_rest_" + shRestCount]) shRestCount++;
  const shCoeffsPerChannel =
    shRestCount >= 45 ? 15 : shRestCount >= 24 ? 8 : shRestCount >= 9 ? 3 : 0;

  return executeParallelPipeline({
    input,
    output,
    plyLayout,
    threads,
    chunkTargetBytes: opts.chunkTargetBytes ?? DEFAULT_CHUNK_TARGET_BYTES,
    maxInFlightBytes: opts.maxInFlightBytes ?? DEFAULT_MAX_INFLIGHT_BYTES,
    signal,
    onProgress: opts.onProgress,
    writeHookForTest: opts.writeHookForTest,
    chunkDelayForTest: opts.chunkDelayForTest,
    workerDataBase: {
      mode: "v3",
      stride: plyLayout.stride,
      fields: plyLayout.fields,
      shCoeffsPerChannel,
      globalDeletedSab: toReadOnlySab(globalDeleted),
      objPlans,
    },
  });
}
