/**
 * @module ply-chunk-worker
 * @description Worker thread processor for bounded parallel PLY baking (v4 pilot + v3 main/split path).
 * - Uses the EXACT shared math & color-grade functions from ply.mjs / color-grade.js (zero drift vs serial gold path).
 * - Reads read-only bitsets/palettes from SharedArrayBuffers (zero-copy across workers).
 * - Writes each contiguous source vertex chunk into a chunk-exclusive output buffer and transfers it zero-copy back
 *   to the coordinator for strictly ordered sequential disk writes.
 */
import { parentPort, workerData } from "node:worker_threads";
import {
  decomposeAffine,
  mulQuatWXYZ,
  axisScaleFactor,
  hasBit,
} from "./ply.mjs";
import {
  SH_C0,
  applyColorGradeCPU,
  applyColorGradeSHBandCPU,
} from "./color-grade.js";

const sigmoid = (v) => 1 / (1 + Math.exp(-v));
const invSigmoid = (v) =>
  v <= 1e-6 ? -14 : v >= 1 - 1e-6 ? 14 : -Math.log(1 / v - 1);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const cfg = workerData;
const stride = cfg.stride;
const fields = cfg.fields;
const shCoeffsPerChannel = cfg.shCoeffsPerChannel;

const accessor = (k, d = 0) =>
  fields[k] ? (b, i) => b[fields[k][1]](i + fields[k][0]) : () => d;
const writer = (k) =>
  fields[k] ? (b, i, val) => b[fields[k][2]](val, i + fields[k][0]) : null;

const rRest = [];
const wRest = [];
for (let k = 0; k < shCoeffsPerChannel * 3; k++) {
  rRest.push(accessor("f_rest_" + k, 0));
  wRest.push(writer("f_rest_" + k));
}

const rX = accessor("x"), rY = accessor("y"), rZ = accessor("z");
const wX = writer("x"), wY = writer("y"), wZ = writer("z");
const rS0 = accessor("scale_0", -6), rS1 = accessor("scale_1", -6), rS2 = accessor("scale_2", -6);
const wS0 = writer("scale_0"), wS1 = writer("scale_1"), wS2 = writer("scale_2");
const rQ0 = accessor("rot_0", 1), rQ1 = accessor("rot_1", 0), rQ2 = accessor("rot_2", 0), rQ3 = accessor("rot_3", 0);
const wQ0 = writer("rot_0"), wQ1 = writer("rot_1"), wQ2 = writer("rot_2"), wQ3 = writer("rot_3");
const hasDc = !!(fields.f_dc_0 && fields.f_dc_1 && fields.f_dc_2);
const hasRgb = !!(fields.red && fields.green && fields.blue);
const rDc0 = accessor("f_dc_0", 0), rDc1 = accessor("f_dc_1", 0), rDc2 = accessor("f_dc_2", 0);
const wDc0 = writer("f_dc_0"), wDc1 = writer("f_dc_1"), wDc2 = writer("f_dc_2");
const rRed = accessor("red", 128), rGrn = accessor("green", 128), rBlu = accessor("blue", 128);
const wRed = writer("red"), wGrn = writer("green"), wBlu = writer("blue");
const hasOpLin = !!fields.opacity_linear;
const hasOp = !!fields.opacity;
const rOpLin = accessor("opacity_linear", 1);
const rOp = accessor("opacity", 4);
const wOpLin = writer("opacity_linear");
const wOp = writer("opacity");

const shChR = new Float32Array(15);
const shChG = new Float32Array(15);
const shChB = new Float32Array(15);

function applyAffineAndSh(outBuf, at, xf) {
  const m = xf.m;
  const x = rX(outBuf, at), y = rY(outBuf, at), z = rZ(outBuf, at);
  wX(outBuf, at, m[0] * x + m[4] * y + m[8] * z + m[12]);
  wY(outBuf, at, m[1] * x + m[5] * y + m[9] * z + m[13]);
  wZ(outBuf, at, m[2] * x + m[6] * y + m[10] * z + m[14]);

  if (wQ0 && wQ1 && wQ2 && wQ3) {
    const q0 = rQ0(outBuf, at), q1 = rQ1(outBuf, at), q2 = rQ2(outBuf, at), q3 = rQ3(outBuf, at);
    const ql = Math.hypot(q0, q1, q2, q3) || 1;
    const qOrig = [q0 / ql, q1 / ql, q2 / ql, q3 / ql];
    if (xf.hasScale && wS0 && wS1 && wS2) {
      if (xf.uniformScale) {
        wS0(outBuf, at, rS0(outBuf, at) + xf.logUniformScale);
        wS1(outBuf, at, rS1(outBuf, at) + xf.logUniformScale);
        wS2(outBuf, at, rS2(outBuf, at) + xf.logUniformScale);
      } else {
        wS0(outBuf, at, rS0(outBuf, at) + Math.log(axisScaleFactor(m, qOrig, 1, 0, 0)));
        wS1(outBuf, at, rS1(outBuf, at) + Math.log(axisScaleFactor(m, qOrig, 0, 1, 0)));
        wS2(outBuf, at, rS2(outBuf, at) + Math.log(axisScaleFactor(m, qOrig, 0, 0, 1)));
      }
    }
    if (xf.hasRotation) {
      const qNew = mulQuatWXYZ(xf.rotQuat, qOrig);
      wQ0(outBuf, at, qNew[0]);
      wQ1(outBuf, at, qNew[1]);
      wQ2(outBuf, at, qNew[2]);
      wQ3(outBuf, at, qNew[3]);
    }
  } else if (xf.hasScale && wS0 && wS1 && wS2) {
    wS0(outBuf, at, rS0(outBuf, at) + xf.logUniformScale);
    wS1(outBuf, at, rS1(outBuf, at) + xf.logUniformScale);
    wS2(outBuf, at, rS2(outBuf, at) + xf.logUniformScale);
  }

  if (xf.shRot && shCoeffsPerChannel > 0) {
    const K = shCoeffsPerChannel;
    for (let d = 0; d < K; d++) {
      shChR[d] = rRest[d](outBuf, at);
      shChG[d] = rRest[d + K](outBuf, at);
      shChB[d] = rRest[d + 2 * K](outBuf, at);
    }
    xf.shRot.apply(shChR, K);
    xf.shRot.apply(shChG, K);
    xf.shRot.apply(shChB, K);
    for (let d = 0; d < K; d++) {
      wRest[d](outBuf, at, shChR[d]);
      wRest[d + K](outBuf, at, shChG[d]);
      wRest[d + 2 * K](outBuf, at, shChB[d]);
    }
  }
}

// ---------------------------------------------------------------------------
// Mode-specific static compiled state (built ONCE per worker!)
// ---------------------------------------------------------------------------
let processChunk;

if (cfg.mode === "v4") {
  const deletedBits = cfg.deletedBitsSab ? new Uint8Array(cfg.deletedBitsSab) : null;
  const onlyBits = cfg.onlyBitsSab ? new Uint8Array(cfg.onlyBitsSab) : null;
  const tIndices = cfg.tIndicesSab ? new Uint16Array(cfg.tIndicesSab) : null;
  const slotXforms = cfg.slotMatrices.map((m) => (m ? decomposeAffine(m) : null));
  const gradeObj = cfg.gradeObj || null;
  const lutRgba = cfg.lutRgbaSab ? new Uint8Array(cfg.lutRgbaSab) : null;

  let paintMap = null;
  if (cfg.paintIndicesSab && cfg.paintDcSab) {
    const ids = new Uint32Array(cfg.paintIndicesSab);
    const dcs = new Float32Array(cfg.paintDcSab);
    paintMap = new Map();
    for (let i = 0; i < ids.length; i++) {
      paintMap.set(ids[i] >>> 0, [dcs[i * 3], dcs[i * 3 + 1], dcs[i * 3 + 2]]);
    }
  }

  processChunk = ({ chunkId, startIdx, count, inArrayBuffer, inByteLength }) => {
    const inBuf = Buffer.from(inArrayBuffer, 0, inByteLength);
    // Chunk-exclusive output ArrayBuffer (max size = count * stride)
    const outArrayBuffer = new ArrayBuffer(count * stride);
    const outBuf = Buffer.from(outArrayBuffer);
    let outUsed = 0;
    let kept = 0;

    for (let i = 0; i < count; i++) {
      const srcIdx = startIdx + i;
      if (deletedBits && hasBit(deletedBits, srcIdx)) continue;
      if (onlyBits && !hasBit(onlyBits, srcIdx)) continue;

      const rowOff = i * stride;
      inBuf.copy(outBuf, outUsed, rowOff, rowOff + stride);
      const at = outUsed;

      if (paintMap && hasDc && paintMap.has(srcIdx)) {
        const pd = paintMap.get(srcIdx);
        wDc0(outBuf, at, pd[0]);
        wDc1(outBuf, at, pd[1]);
        wDc2(outBuf, at, pd[2]);
      }

      const slot = tIndices ? tIndices[srcIdx] : 0;
      const xf = slot < slotXforms.length ? slotXforms[slot] : slotXforms[0];
      if (xf) applyAffineAndSh(outBuf, at, xf);

      if (gradeObj) {
        let r = hasDc ? 0.5 + SH_C0 * rDc0(outBuf, at) : hasRgb ? rRed(outBuf, at) / 255 : 0.5;
        let g = hasDc ? 0.5 + SH_C0 * rDc1(outBuf, at) : hasRgb ? rGrn(outBuf, at) / 255 : 0.5;
        let b = hasDc ? 0.5 + SH_C0 * rDc2(outBuf, at) : hasRgb ? rBlu(outBuf, at) / 255 : 0.5;
        let alpha = hasOpLin ? rOpLin(outBuf, at) : hasOp ? sigmoid(rOp(outBuf, at)) : 1;
        [r, g, b, alpha] = applyColorGradeCPU(r, g, b, alpha, gradeObj, lutRgba);
        if (hasDc) {
          wDc0(outBuf, at, (r - 0.5) / SH_C0);
          wDc1(outBuf, at, (g - 0.5) / SH_C0);
          wDc2(outBuf, at, (b - 0.5) / SH_C0);
        } else if (hasRgb) {
          wRed(outBuf, at, Math.round(clamp01(r) * 255));
          wGrn(outBuf, at, Math.round(clamp01(g) * 255));
          wBlu(outBuf, at, Math.round(clamp01(b) * 255));
        }
        if (hasOpLin) wOpLin(outBuf, at, clamp01(alpha));
        else if (hasOp) wOp(outBuf, at, invSigmoid(clamp01(alpha)));

        if (shCoeffsPerChannel > 0) {
          const K = shCoeffsPerChannel;
          for (let d = 0; d < K; d++) {
            const [nr, ng, nb] = applyColorGradeSHBandCPU(
              rRest[d](outBuf, at),
              rRest[d + K](outBuf, at),
              rRest[d + 2 * K](outBuf, at),
              gradeObj,
            );
            wRest[d](outBuf, at, nr);
            wRest[d + K](outBuf, at, ng);
            wRest[d + 2 * K](outBuf, at, nb);
          }
        }
      }

      outUsed += stride;
      kept++;
    }

    // Shrink buffer if heavy filtering dropped > 50% so reorder queue stays compact
    let transferBuf = outArrayBuffer;
    if (outUsed === 0) {
      transferBuf = new ArrayBuffer(0);
    } else if (outUsed < outArrayBuffer.byteLength * 0.5) {
      transferBuf = outArrayBuffer.slice(0, outUsed);
    }
    return { chunkId, kept, byteLength: outUsed, outArrayBuffer: transferBuf };
  };
} else if (cfg.mode === "v3") {
  const globalDeleted = cfg.globalDeletedSab ? new Uint8Array(cfg.globalDeletedSab) : null;
  const objPlans = cfg.objPlans.map((p) => ({
    id: p.id,
    all: p.all,
    memberBits: p.memberBitsSab ? new Uint8Array(p.memberBitsSab) : null,
    excludedBits: p.excludedBitsSab ? new Uint8Array(p.excludedBitsSab) : null,
    objDeletedBits: p.objDeletedBitsSab ? new Uint8Array(p.objDeletedBitsSab) : null,
    xform: p.matrix16 ? decomposeAffine(p.matrix16) : null,
    grades: p.grades.map((g) => ({
      all: g.all,
      bits: g.bitsSab ? new Uint8Array(g.bitsSab) : null,
      grade: g.grade,
      lut: g.lutRgbaSab ? new Uint8Array(g.lutRgbaSab) : null,
    })),
  }));

  processChunk = ({ chunkId, startIdx, count, inArrayBuffer, inByteLength }) => {
    const inBuf = Buffer.from(inArrayBuffer, 0, inByteLength);
    let outArrayBuffer = new ArrayBuffer(count * stride);
    let outBuf = Buffer.from(outArrayBuffer);
    let outUsed = 0;
    let kept = 0;

    const ensureCapacity = (need) => {
      if (need <= outArrayBuffer.byteLength) return;
      const nextCap = Math.max(need, outArrayBuffer.byteLength * 2);
      const nextAb = new ArrayBuffer(nextCap);
      const nextBuf = Buffer.from(nextAb);
      outBuf.copy(nextBuf, 0, 0, outUsed);
      outArrayBuffer = nextAb;
      outBuf = nextBuf;
    };

    for (let i = 0; i < count; i++) {
      const srcIdx = startIdx + i;
      const rowOff = i * stride;
      const isGloballyDeleted = globalDeleted && hasBit(globalDeleted, srcIdx);

      for (let p = 0; p < objPlans.length; p++) {
        const plan = objPlans[p];
        if (plan.objDeletedBits) {
          if (hasBit(plan.objDeletedBits, srcIdx)) continue;
        } else if (isGloballyDeleted) {
          continue;
        }
        if (!plan.all && !hasBit(plan.memberBits, srcIdx)) continue;
        if (plan.excludedBits && hasBit(plan.excludedBits, srcIdx)) continue;

        ensureCapacity(outUsed + stride);
        inBuf.copy(outBuf, outUsed, rowOff, rowOff + stride);
        const at = outUsed;

        if (plan.xform) applyAffineAndSh(outBuf, at, plan.xform);

        if (plan.grades.length > 0) {
          let matchedAny = false;
          let r = hasDc ? 0.5 + SH_C0 * rDc0(outBuf, at) : hasRgb ? rRed(outBuf, at) / 255 : 0.5;
          let g = hasDc ? 0.5 + SH_C0 * rDc1(outBuf, at) : hasRgb ? rGrn(outBuf, at) / 255 : 0.5;
          let b = hasDc ? 0.5 + SH_C0 * rDc2(outBuf, at) : hasRgb ? rBlu(outBuf, at) / 255 : 0.5;
          let alpha = hasOpLin ? rOpLin(outBuf, at) : hasOp ? sigmoid(rOp(outBuf, at)) : 1;

          const K = shCoeffsPerChannel;
          let loadedSh = false;

          for (const ge of plan.grades) {
            if (!ge.all && !hasBit(ge.bits, srcIdx)) continue;
            matchedAny = true;
            [r, g, b, alpha] = applyColorGradeCPU(r, g, b, alpha, ge.grade, ge.lut);
            if (K > 0) {
              if (!loadedSh) {
                for (let d = 0; d < K; d++) {
                  shChR[d] = rRest[d](outBuf, at);
                  shChG[d] = rRest[d + K](outBuf, at);
                  shChB[d] = rRest[d + 2 * K](outBuf, at);
                }
                loadedSh = true;
              }
              for (let d = 0; d < K; d++) {
                const [nr, ng, nb] = applyColorGradeSHBandCPU(shChR[d], shChG[d], shChB[d], ge.grade);
                shChR[d] = nr;
                shChG[d] = ng;
                shChB[d] = nb;
              }
            }
          }

          if (matchedAny) {
            if (hasDc) {
              wDc0(outBuf, at, (r - 0.5) / SH_C0);
              wDc1(outBuf, at, (g - 0.5) / SH_C0);
              wDc2(outBuf, at, (b - 0.5) / SH_C0);
            } else if (hasRgb) {
              wRed(outBuf, at, Math.round(clamp01(r) * 255));
              wGrn(outBuf, at, Math.round(clamp01(g) * 255));
              wBlu(outBuf, at, Math.round(clamp01(b) * 255));
            }
            if (hasOpLin) wOpLin(outBuf, at, clamp01(alpha));
            else if (hasOp) wOp(outBuf, at, invSigmoid(clamp01(alpha)));

            if (loadedSh && K > 0) {
              for (let d = 0; d < K; d++) {
                wRest[d](outBuf, at, shChR[d]);
                wRest[d + K](outBuf, at, shChG[d]);
                wRest[d + 2 * K](outBuf, at, shChB[d]);
              }
            }
          }
        }

        outUsed += stride;
        kept++;
      }
    }

    let transferBuf = outArrayBuffer;
    if (outUsed === 0) {
      transferBuf = new ArrayBuffer(0);
    } else if (outUsed < outArrayBuffer.byteLength * 0.5) {
      transferBuf = outArrayBuffer.slice(0, outUsed);
    }
    return { chunkId, kept, byteLength: outUsed, outArrayBuffer: transferBuf };
  };
} else {
  throw new Error(`Unsupported ply-chunk-worker mode: ${cfg.mode}`);
}

parentPort.on("message", (msg) => {
  if (!msg || msg.type === "shutdown") {
    process.exit(0);
  }
  const run = () => {
    try {
      const res = processChunk(msg);
      const capacityBytes = res.outArrayBuffer ? res.outArrayBuffer.byteLength : 0;
      parentPort.postMessage(
        {
          type: "result",
          chunkId: res.chunkId,
          kept: res.kept,
          byteLength: res.byteLength,
          capacityBytes,
          outArrayBuffer: res.outArrayBuffer,
        },
        [res.outArrayBuffer],
      );
    } catch (err) {
      parentPort.postMessage({
        type: "error",
        chunkId: msg.chunkId,
        message: err?.message || String(err),
        stack: err?.stack || "",
      });
    }
  };
  const delayMs = Number(msg.delayMsForTest || 0);
  if (delayMs > 0) {
    setTimeout(run, delayMs);
  } else {
    run();
  }
});
