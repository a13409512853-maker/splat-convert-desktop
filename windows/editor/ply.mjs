import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { SHRotation } from "./sh-utils.mjs";
import {
  SH_C0,
  applyColorGradeCPU,
  applyColorGradeSHBandCPU,
  isGradeModified,
} from "./color-grade.js";

// Fast path PLY reader/writer:
// - Retains ALL vertex attributes (including f_rest_0..44 & custom columns)
// - Legacy maskPly() for v1/v2 recipes (backward compatible with tests/editor-export.mjs)
// - Full v3 processPlyV3() supporting RLE soft-deletes, multi-object splits & true duplicates,
//   per-object 4x4 affine transforms + SH Band 1-3 rotation, and GPU-exact DC + SH1-3 + 3D LUT baking!

const types = {
  char: [1, "readInt8", "writeInt8"],
  uchar: [1, "readUInt8", "writeUInt8"],
  short: [2, "readInt16LE", "writeInt16LE"],
  ushort: [2, "readUInt16LE", "writeUInt16LE"],
  int: [4, "readInt32LE", "writeInt32LE"],
  uint: [4, "readUInt32LE", "writeUInt32LE"],
  float: [4, "readFloatLE", "writeFloatLE"],
  double: [8, "readDoubleLE", "writeDoubleLE"],
};
for (const [i, k] of [
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "float32",
  "float64",
].entries()) {
  types[k] = Object.values(types)[i];
}

export function layout(fd) {
  const buf = Buffer.alloc(131072);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  const t = buf.toString("latin1", 0, n);
  const end = /^end_header\r?\n/m.exec(t);
  if (!end) return null;
  const start = end.index + end[0].length;
  const header = t.slice(0, start);
  if (!/^format binary_little_endian 1\.0\r?$/m.test(header)) return null;
  const elements = [...header.matchAll(/^element (\S+) (\d+)\r?$/gm)];
  if (elements.length !== 1 || elements[0][1] !== "vertex") return null;
  const count = Number(elements[0][2]);
  const fields = {};
  let stride = 0;
  for (const line of header.split(/\r?\n/)) {
    if (!line.startsWith("property ")) continue;
    const [, type, key] = line.split(/\s+/);
    const item = types[type];
    if (!item) return null;
    fields[key] = [stride, item[1], item[2]];
    stride += item[0];
  }
  if (!fields.x || !fields.y || !fields.z) return null;
  if (
    !Number.isSafeInteger(count * stride) ||
    start + count * stride > fs.fstatSync(fd).size
  ) {
    throw Error("Truncated PLY");
  }
  const accessor = (k, d = 0) =>
    fields[k] ? (b, i) => b[fields[k][1]](i + fields[k][0]) : () => d;
  const writer = (k) =>
    fields[k] ? (b, i, val) => b[fields[k][2]](val, i + fields[k][0]) : null;
  return { start, count, header, stride, fields, accessor, writer };
}

export function readExact(fd, b, n, offset) {
  let done = 0;
  while (done < n) {
    const v = fs.readSync(fd, b, done, n - done, offset + done);
    if (!v) throw Error("Unexpected end of input");
    done += v;
  }
}

const sigmoid = (v) => 1 / (1 + Math.exp(-v));
const invSigmoid = (v) =>
  v <= 1e-6 ? -14 : v >= 1 - 1e-6 ? 14 : -Math.log(1 / v - 1);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Minimal pure-Node PNG decoder for 256x16 8-bit RGB/RGBA LUT files
export function decodePngRgba(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 33 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idatParts = [];
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      const dataStart = off + 8;
      if (type === "IHDR") {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8];
        colorType = buf[dataStart + 9];
      } else if (type === "IDAT") {
        idatParts.push(buf.subarray(dataStart, dataStart + len));
      } else if (type === "IEND") {
        break;
      }
      off += 12 + len;
    }
    if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return null;
    const bpp = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idatParts));
    const stride = width * bpp;
    const recon = new Uint8Array(height * stride);
    const paeth = (a, b, c) => {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const rowIn = y * (stride + 1) + 1;
      const rowOut = y * stride;
      for (let x = 0; x < stride; x++) {
        const val = raw[rowIn + x];
        const a = x >= bpp ? recon[rowOut + x - bpp] : 0;
        const b = y > 0 ? recon[rowOut - stride + x] : 0;
        const c = x >= bpp && y > 0 ? recon[rowOut - stride + x - bpp] : 0;
        let r = val;
        if (filter === 1) r = (val + a) & 255;
        else if (filter === 2) r = (val + b) & 255;
        else if (filter === 3) r = (val + ((a + b) >> 1)) & 255;
        else if (filter === 4) r = (val + paeth(a, b, c)) & 255;
        recon[rowOut + x] = r;
      }
    }
    if (bpp === 4) return recon;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      rgba[i * 4] = recon[j];
      rgba[i * 4 + 1] = recon[j + 1];
      rgba[i * 4 + 2] = recon[j + 2];
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  } catch {
    return null;
  }
}

export function buildBitsetFromRanges(count, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const bits = new Uint8Array((count + 7) >> 3);
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const start = Math.max(0, r[0] | 0);
    const end = Math.min(count, start + (r[1] | 0));
    for (let i = start; i < end; i++) {
      bits[i >> 3] |= 1 << (i & 7);
    }
  }
  return bits;
}

export function hasBit(bits, idx) {
  return (bits[idx >> 3] & (1 << (idx & 7))) !== 0;
}

export function isIdentityMatrix16(m) {
  if (!m || m.length !== 16) return true;
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) {
    if (Math.abs(m[i] - id[i]) > 1e-6) return false;
  }
  return true;
}

// Decompose column-major 4x4 affine matrix M into linear 3x3 L, orthonormal rotation R (3x3 + quat [w,x,y,z]), scale signs
export function decomposeAffine(m) {
  const sx0 = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy0 = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz0 = Math.hypot(m[8], m[9], m[10]) || 1;
  // Check determinant sign for reflection
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  const sx = det < 0 ? -sx0 : sx0;
  const sy = sy0;
  const sz = sz0;

  // Orthonormal column-major 3x3 rotation matrix R
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  const rotMat3 = [r00, r10, r20, r01, r11, r21, r02, r12, r22];

  // Rotation matrix -> Hamilton quaternion [w, x, y, z]
  const tr = r00 + r11 + r22;
  let qw, qx, qy, qz;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1.0);
    qw = 0.25 / s;
    qx = (r21 - r12) * s;
    qy = (r02 - r20) * s;
    qz = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2.0 * Math.sqrt(1.0 + r00 - r11 - r22);
    qw = (r21 - r12) / s;
    qx = 0.25 * s;
    qy = (r01 + r10) / s;
    qz = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = 2.0 * Math.sqrt(1.0 + r11 - r00 - r22);
    qw = (r02 - r20) / s;
    qx = (r01 + r10) / s;
    qy = 0.25 * s;
    qz = (r12 + r21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + r22 - r00 - r11);
    qw = (r10 - r01) / s;
    qx = (r02 + r20) / s;
    qy = (r12 + r21) / s;
    qz = 0.25 * s;
  }
  const qLen = Math.hypot(qw, qx, qy, qz) || 1;
  const rotQuat = [qw / qLen, qx / qLen, qy / qLen, qz / qLen];

  const hasRotation =
    Math.abs(rotQuat[1]) > 1e-6 ||
    Math.abs(rotQuat[2]) > 1e-6 ||
    Math.abs(rotQuat[3]) > 1e-6;
  const hasScale =
    Math.abs(Math.abs(sx) - 1) > 1e-6 ||
    Math.abs(Math.abs(sy) - 1) > 1e-6 ||
    Math.abs(Math.abs(sz) - 1) > 1e-6;
  const uniformScale =
    Math.abs(Math.abs(sx) - Math.abs(sy)) < 1e-5 &&
    Math.abs(Math.abs(sx) - Math.abs(sz)) < 1e-5;

  return {
    m,
    rotMat3,
    rotQuat,
    shRot: hasRotation ? new SHRotation(rotMat3) : null,
    hasRotation,
    hasScale,
    uniformScale,
    logUniformScale: Math.log(Math.max(1e-6, Math.abs(sx))),
  };
}

// Hamilton product qA * qB where both are [w, x, y, z]
export function mulQuatWXYZ(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

// Directional scale factor of linear 3x3 part of column-major 4x4 matrix m along local axis u rotated by q=[w,x,y,z]
export function axisScaleFactor(m, q, ux, uy, uz) {
  // Rotate u by q
  const qw = q[0], qx = q[1], qy = q[2], qz = q[3];
  const tx = 2 * (qy * uz - qz * uy);
  const ty = 2 * (qz * ux - qx * uz);
  const tz = 2 * (qx * uy - qy * ux);
  const vx = ux + qw * tx + (qy * tz - qz * ty);
  const vy = uy + qw * ty + (qz * tx - qx * tz);
  const vz = uz + qw * tz + (qx * ty - qy * tx);
  // Apply linear part L of m
  const lx = m[0] * vx + m[4] * vy + m[8] * vz;
  const ly = m[1] * vx + m[5] * vy + m[9] * vz;
  const lz = m[2] * vx + m[6] * vy + m[10] * vz;
  return Math.max(1e-6, Math.hypot(lx, ly, lz));
}

/**
 * Legacy v1/v2 PLY filter (strictly preserves v1 (-x,-y,z) contract for tests/editor-export.mjs).
 */
export function maskPly(input, output, keep, colorMap = null) {
  const fd = fs.openSync(input, "r");
  let out;
  try {
    const l = layout(fd);
    if (!l) throw Error("Expected normalized binary PLY");
    const header = (n) =>
      Buffer.from(
        l.header.replace(
          /^(element vertex )\d+/m,
          (_, p) => p + String(n).padStart(16, "0"),
        ),
        "latin1",
      );
    out = fs.openSync(output, "w");
    fs.writeSync(out, header(0));
    const rows = Math.max(1, Math.floor(2 ** 20 / l.stride));
    const buf = Buffer.alloc(rows * l.stride);
    const x = l.accessor("x");
    const y = l.accessor("y");
    const z = l.accessor("z");
    const wDc0 = l.writer("f_dc_0");
    const wDc1 = l.writer("f_dc_1");
    const wDc2 = l.writer("f_dc_2");
    const wOp = l.writer("opacity");
    const wOpLin = l.writer("opacity_linear");

    let total = 0;
    for (let first = 0; first < l.count; first += rows) {
      const n = Math.min(rows, l.count - first);
      readExact(fd, buf, n * l.stride, l.start + first * l.stride);
      let used = 0;
      for (let i = 0; i < n; i++) {
        const at = i * l.stride;
        const srcIdx = first + i;
        if (keep(-x(buf, at), -y(buf, at), z(buf, at), srcIdx)) {
          if (colorMap && colorMap.has(srcIdx)) {
            const [dc0, dc1, dc2, linOp] = colorMap.get(srcIdx);
            if (wDc0) wDc0(buf, at, dc0);
            if (wDc1) wDc1(buf, at, dc1);
            if (wDc2) wDc2(buf, at, dc2);
            if (wOpLin) wOpLin(buf, at, linOp);
            else if (wOp) wOp(buf, at, invSigmoid(linOp));
          }
          if (used !== at) buf.copy(buf, used, at, at + l.stride);
          used += l.stride;
          total++;
        }
      }
      if (used) fs.writeSync(out, buf, 0, used);
    }
    if (!total) throw Error("Empty selection (0 points kept)");
    const h = header(total);
    fs.writeSync(out, h, 0, h.length, 0);
    return total;
  } finally {
    fs.closeSync(fd);
    if (out !== undefined) fs.closeSync(out);
  }
}

/**
 * Full v3 PLY Processor (+Y-up native space):
 * - Automatically strips soft-deleted vertices
 * - Supports multi-object filtering, split objects, AND true duplicated objects
 * - Applies per-object exact 4x4 affine transform (pos, quat, scale, AND SH Band 1-3 rotation)
 * - Applies per-object & per-selection baked color grades to DC, SH1-3 (f_rest_*), RGB, and opacity
 */
export function processPlyV3(input, output, recipe, lutsDir = null) {
  const fd = fs.openSync(input, "r");
  let out;
  try {
    const l = layout(fd);
    if (!l) throw Error("Expected normalized binary PLY");

    const count = l.count;
    const globalDeleted = buildBitsetFromRanges(count, recipe.deletedRanges);

    const exportIdSet =
      Array.isArray(recipe.exportObjectIds) && recipe.exportObjectIds.length > 0
        ? new Set(recipe.exportObjectIds.map((v) => Number(v)))
        : null;

    // Cache decoded 3D LUTs by filename
    const lutCache = new Map();
    const getLut = (name) => {
      if (!name || name === "默认.png" || !lutsDir) return null;
      if (lutCache.has(name)) return lutCache.get(name);
      const rgba = decodePngRgba(path.join(lutsDir, path.basename(name)));
      lutCache.set(name, rgba);
      return rgba;
    };

    // Compile object plans (source PLY objects + non-destructive synthetic planar inpaint patches)
    const rawObjects = Array.isArray(recipe.objects) ? recipe.objects : [];
    const objPlans = [];
    const syntheticObjects = [];
    for (const obj of rawObjects) {
      if (exportIdSet && !exportIdSet.has(Number(obj.id))) continue;
      if (obj.exportSkip) continue;

      if (obj.sourceKind === "synthetic-inpaint") {
        if (obj.syntheticData && obj.syntheticData.posB64) {
          const grades = [];
          if (Array.isArray(obj.bakedGrades)) {
            for (const entry of obj.bakedGrades) {
              if (!entry || !entry.grade || !isGradeModified(entry.grade)) continue;
              grades.push({ grade: entry.grade, lut: getLut(entry.grade.lutName) });
            }
          }
          syntheticObjects.push({
            obj,
            xform: !isIdentityMatrix16(obj.matrix) ? decomposeAffine(obj.matrix) : null,
            grades,
          });
        }
        continue;
      }

      const isAll = obj.memberRanges === "all" || obj.memberRanges == null;
      const memberBits = isAll ? null : buildBitsetFromRanges(count, obj.memberRanges);
      if (!isAll && !memberBits) continue; // empty object

      const excludedBits = buildBitsetFromRanges(count, obj.excludedRanges);
      const objDeletedBits = buildBitsetFromRanges(count, obj.deletedRanges);
      const hasMat = !isIdentityMatrix16(obj.matrix);
      const xform = hasMat ? decomposeAffine(obj.matrix) : null;

      const grades = [];
      if (Array.isArray(obj.bakedGrades)) {
        for (const entry of obj.bakedGrades) {
          if (!entry || !entry.grade || !isGradeModified(entry.grade)) continue;
          const gAll = entry.targetRanges === "all" || entry.targetRanges == null;
          const gBits = gAll ? null : buildBitsetFromRanges(count, entry.targetRanges);
          if (!gAll && !gBits) continue;
          grades.push({
            all: gAll,
            bits: gBits,
            grade: entry.grade,
            lut: getLut(entry.grade.lutName),
          });
        }
      }

      objPlans.push({
        id: obj.id,
        all: isAll,
        memberBits,
        excludedBits,
        objDeletedBits,
        xform,
        grades,
      });
    }

    if (objPlans.length === 0 && syntheticObjects.length === 0) {
      throw Error("No exportable scene objects");
    }

    // Detect f_rest_* spherical harmonic bands
    let shRestCount = 0;
    while (l.fields["f_rest_" + shRestCount]) shRestCount++;
    const shCoeffsPerChannel =
      shRestCount >= 45 ? 15 : shRestCount >= 24 ? 8 : shRestCount >= 9 ? 3 : 0;
    const rRest = [];
    const wRest = [];
    for (let k = 0; k < shCoeffsPerChannel * 3; k++) {
      rRest.push(l.accessor("f_rest_" + k, 0));
      wRest.push(l.writer("f_rest_" + k));
    }

    const rX = l.accessor("x"), rY = l.accessor("y"), rZ = l.accessor("z");
    const wX = l.writer("x"), wY = l.writer("y"), wZ = l.writer("z");
    const rS0 = l.accessor("scale_0", -6), rS1 = l.accessor("scale_1", -6), rS2 = l.accessor("scale_2", -6);
    const wS0 = l.writer("scale_0"), wS1 = l.writer("scale_1"), wS2 = l.writer("scale_2");
    const rQ0 = l.accessor("rot_0", 1), rQ1 = l.accessor("rot_1", 0), rQ2 = l.accessor("rot_2", 0), rQ3 = l.accessor("rot_3", 0);
    const wQ0 = l.writer("rot_0"), wQ1 = l.writer("rot_1"), wQ2 = l.writer("rot_2"), wQ3 = l.writer("rot_3");

    const hasDc = !!(l.fields.f_dc_0 && l.fields.f_dc_1 && l.fields.f_dc_2);
    const hasRgb = !!(l.fields.red && l.fields.green && l.fields.blue);
    const rDc0 = l.accessor("f_dc_0", 0), rDc1 = l.accessor("f_dc_1", 0), rDc2 = l.accessor("f_dc_2", 0);
    const wDc0 = l.writer("f_dc_0"), wDc1 = l.writer("f_dc_1"), wDc2 = l.writer("f_dc_2");
    const rRed = l.accessor("red", 128), rGrn = l.accessor("green", 128), rBlu = l.accessor("blue", 128);
    const wRed = l.writer("red"), wGrn = l.writer("green"), wBlu = l.writer("blue");

    const hasOpLin = !!l.fields.opacity_linear;
    const hasOp = !!l.fields.opacity;
    const rOpLin = l.accessor("opacity_linear", 1);
    const rOp = l.accessor("opacity", 4);
    const wOpLin = l.writer("opacity_linear");
    const wOp = l.writer("opacity");

    const header = (n) =>
      Buffer.from(
        l.header.replace(
          /^(element vertex )\d+/m,
          (_, p) => p + String(n).padStart(16, "0"),
        ),
        "latin1",
      );

    out = fs.openSync(output, "w");
    fs.writeSync(out, header(0));

    const stride = l.stride;
    const rows = Math.max(1, Math.floor((2 * 1024 * 1024) / stride));
    const inBuf = Buffer.alloc(rows * stride);
    const outBuf = Buffer.alloc(rows * stride);
    let outUsed = 0;
    let totalWritten = 0;

    const shChR = new Float32Array(15);
    const shChG = new Float32Array(15);
    const shChB = new Float32Array(15);

    const flushOut = () => {
      if (outUsed > 0) {
        fs.writeSync(out, outBuf, 0, outUsed);
        outUsed = 0;
      }
    };

    const emitVertex = (srcRowOff, srcIdx, plan) => {
      if (outUsed + stride > outBuf.length) flushOut();
      inBuf.copy(outBuf, outUsed, srcRowOff, srcRowOff + stride);
      const at = outUsed;

      // 1. Apply exact 4x4 affine transform (+Z-up native space)
      const xf = plan.xform;
      if (xf) {
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
              const fx = axisScaleFactor(m, qOrig, 1, 0, 0);
              const fy = axisScaleFactor(m, qOrig, 0, 1, 0);
              const fz = axisScaleFactor(m, qOrig, 0, 0, 1);
              wS0(outBuf, at, rS0(outBuf, at) + Math.log(fx));
              wS1(outBuf, at, rS1(outBuf, at) + Math.log(fy));
              wS2(outBuf, at, rS2(outBuf, at) + Math.log(fz));
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

        // Rotate higher-order SH bands 1-3 cleanly!
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

      // 2. Apply baked Color Grades in order (DC + SH1-3 + RGB + Opacity)
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
      totalWritten++;
    };

    for (let first = 0; first < count; first += rows) {
      const n = Math.min(rows, count - first);
      readExact(fd, inBuf, n * stride, l.start + first * stride);
      for (let i = 0; i < n; i++) {
        const srcIdx = first + i;
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
          emitVertex(rowOff, srcIdx, plan);
        }
      }
    }

    // Append any non-destructive synthetic planar inpaint Gaussian patches selected for export!
    for (const entry of syntheticObjects) {
      const od = entry.obj;
      const sd = od.syntheticData;
      const posBuf = Buffer.from(sd.posB64, "base64");
      const scBuf = Buffer.from(sd.scaleB64, "base64");
      const qtBuf = Buffer.from(sd.quatB64, "base64");
      const rgBuf = Buffer.from(sd.rgbaB64, "base64");
      const posF = new Float32Array(posBuf.buffer, posBuf.byteOffset, Math.floor(posBuf.byteLength / 4));
      const scF = new Float32Array(scBuf.buffer, scBuf.byteOffset, Math.floor(scBuf.byteLength / 4));
      const qtF = new Float32Array(qtBuf.buffer, qtBuf.byteOffset, Math.floor(qtBuf.byteLength / 4));
      const pCount = Math.min(sd.count || 0, Math.floor(posF.length / 3));
      const xf = entry.xform;
      for (let k = 0; k < pCount; k++) {
        if (outUsed + stride > outBuf.length) flushOut();
        const at = outUsed;
        outBuf.fill(0, at, at + stride);
        let x = posF[k * 3], y = posF[k * 3 + 1], z = posF[k * 3 + 2];
        if (xf) {
          const m = xf.m;
          const nx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const ny = m[1] * x + m[5] * y + m[9] * z + m[13];
          const nz = m[2] * x + m[6] * y + m[10] * z + m[14];
          x = nx; y = ny; z = nz;
        }
        wX(outBuf, at, x); wY(outBuf, at, y); wZ(outBuf, at, z);
        if (wS0 && wS1 && wS2) {
          const dLog = xf && xf.hasScale ? xf.logUniformScale : 0;
          wS0(outBuf, at, scF[k * 3] + dLog);
          wS1(outBuf, at, scF[k * 3 + 1] + dLog);
          wS2(outBuf, at, scF[k * 3 + 2] + dLog);
        }
        if (wQ0 && wQ1 && wQ2 && wQ3) {
          let q = [qtF[k * 4], qtF[k * 4 + 1], qtF[k * 4 + 2], qtF[k * 4 + 3]];
          if (xf && xf.hasRotation) q = mulQuatWXYZ(xf.rotQuat, q);
          wQ0(outBuf, at, q[0]); wQ1(outBuf, at, q[1]); wQ2(outBuf, at, q[2]); wQ3(outBuf, at, q[3]);
        }
        let r = rgBuf[k * 4] / 255, g = rgBuf[k * 4 + 1] / 255, b = rgBuf[k * 4 + 2] / 255, a = rgBuf[k * 4 + 3] / 255;
        for (const ge of entry.grades) {
          [r, g, b, a] = applyColorGradeCPU(r, g, b, a, ge.grade, ge.lut);
        }
        if (hasDc) {
          wDc0(outBuf, at, (r - 0.5) / SH_C0);
          wDc1(outBuf, at, (g - 0.5) / SH_C0);
          wDc2(outBuf, at, (b - 0.5) / SH_C0);
        } else if (hasRgb) {
          wRed(outBuf, at, Math.round(clamp01(r) * 255));
          wGrn(outBuf, at, Math.round(clamp01(g) * 255));
          wBlu(outBuf, at, Math.round(clamp01(b) * 255));
        }
        if (hasOpLin) wOpLin(outBuf, at, clamp01(a));
        else if (hasOp) wOp(outBuf, at, invSigmoid(clamp01(a)));
        outUsed += stride;
        totalWritten++;
      }
    }
    flushOut();

    if (!totalWritten) throw Error("Empty export (all Gaussians deleted or no objects selected)");
    const h = header(totalWritten);
    fs.writeSync(out, h, 0, h.length, 0);
    return totalWritten;
  } finally {
    fs.closeSync(fd);
    if (out !== undefined) fs.closeSync(out);
  }
}

export function buildBitsetFromBoolRle(count, rle) {
  if (!Array.isArray(rle) || rle.length === 0) return null;
  const bits = new Uint8Array(Math.ceil(count / 8));
  let ptr = 0;
  let flag = false;
  for (let k = 0; k < rle.length; k++) {
    const run = rle[k] | 0;
    if (flag && run > 0) {
      const end = Math.min(count, ptr + run);
      for (let i = ptr; i < end; i++) bits[i >> 3] |= 1 << (i & 7);
    }
    ptr += run;
    flag = !flag;
  }
  return bits;
}

export function decodeUint16Rle(count, rle) {
  if (!Array.isArray(rle) || rle.length === 0) return null;
  const out = new Uint16Array(count);
  let ptr = 0;
  for (let k = 0; k + 1 < rle.length; k += 2) {
    const val = rle[k] & 0xffff;
    const run = rle[k + 1] | 0;
    const end = Math.min(count, ptr + run);
    if (val !== 0) out.fill(val, ptr, end);
    ptr = end;
  }
  return out;
}

export function mulMat4Col(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/**
 * Full v4 ReSplat Non-Destructive PLY Processor:
 * - Decodes RLE deleted mask & optional per-group inclusive filter (onlyIndicesRle)
 * - Composes entityDeltaMatrix * paletteMatrices[k] per-splat (pos, scale, quat, AND SH1-3 rotation!)
 * - Applies sparse paint DC deltas (if user painted)
 * - Applies exact ReSplat ColorGrade (tint, temperature, saturation, brightness, black/white, transparency, 8-band HSL, 16^3 LUT)
 */
export function processPlyV4(input, output, recipe, lutsDir = null) {
  const fd = fs.openSync(input, "r");
  let out;
  try {
    const l = layout(fd);
    if (!l) throw Error("Expected normalized binary PLY");
    const count = l.count;

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
    const slotXforms = rawPal.map((pm) => {
      const comb = mulMat4Col(entityMat, Array.isArray(pm) && pm.length === 16 ? pm : idMat);
      return isIdentityMatrix16(comb) ? null : decomposeAffine(comb);
    });

    // Build sparse paint lookup
    let paintMap = null;
    if (recipe.paintDelta && Array.isArray(recipe.paintDelta.indices) && recipe.paintDelta.indices.length > 0) {
      paintMap = new Map();
      const ids = recipe.paintDelta.indices;
      const dcs = recipe.paintDelta.dc;
      for (let i = 0; i < ids.length; i++) {
        paintMap.set(ids[i] >>> 0, [dcs[i * 3], dcs[i * 3 + 1], dcs[i * 3 + 2]]);
      }
    }

    // Build ReSplat-equivalent ColorGrade object for color-grade.js
    let gradeObj = null;
    let lutRgba = null;
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
          path.join(path.dirname(lutsDir), "resplat", "static", "luts", path.basename(cg.lutName) + ".png"),
          path.join(path.dirname(lutsDir), "resplat", "static", "luts", path.basename(cg.lutName) + ".PNG"),
        ];
        for (const cand of candidates) {
          if (fs.existsSync(cand)) {
            lutRgba = decodePngRgba(cand);
            if (lutRgba) break;
          }
        }
      }
    }

    let shRestCount = 0;
    while (l.fields["f_rest_" + shRestCount]) shRestCount++;
    const shCoeffsPerChannel =
      shRestCount >= 45 ? 15 : shRestCount >= 24 ? 8 : shRestCount >= 9 ? 3 : 0;
    const rRest = [];
    const wRest = [];
    for (let k = 0; k < shCoeffsPerChannel * 3; k++) {
      rRest.push(l.accessor("f_rest_" + k, 0));
      wRest.push(l.writer("f_rest_" + k));
    }

    const rX = l.accessor("x"), rY = l.accessor("y"), rZ = l.accessor("z");
    const wX = l.writer("x"), wY = l.writer("y"), wZ = l.writer("z");
    const rS0 = l.accessor("scale_0", -6), rS1 = l.accessor("scale_1", -6), rS2 = l.accessor("scale_2", -6);
    const wS0 = l.writer("scale_0"), wS1 = l.writer("scale_1"), wS2 = l.writer("scale_2");
    const rQ0 = l.accessor("rot_0", 1), rQ1 = l.accessor("rot_1", 0), rQ2 = l.accessor("rot_2", 0), rQ3 = l.accessor("rot_3", 0);
    const wQ0 = l.writer("rot_0"), wQ1 = l.writer("rot_1"), wQ2 = l.writer("rot_2"), wQ3 = l.writer("rot_3");
    const hasDc = !!(l.fields.f_dc_0 && l.fields.f_dc_1 && l.fields.f_dc_2);
    const hasRgb = !!(l.fields.red && l.fields.green && l.fields.blue);
    const rDc0 = l.accessor("f_dc_0", 0), rDc1 = l.accessor("f_dc_1", 0), rDc2 = l.accessor("f_dc_2", 0);
    const wDc0 = l.writer("f_dc_0"), wDc1 = l.writer("f_dc_1"), wDc2 = l.writer("f_dc_2");
    const rRed = l.accessor("red", 128), rGrn = l.accessor("green", 128), rBlu = l.accessor("blue", 128);
    const wRed = l.writer("red"), wGrn = l.writer("green"), wBlu = l.writer("blue");
    const hasOpLin = !!l.fields.opacity_linear;
    const hasOp = !!l.fields.opacity;
    const rOpLin = l.accessor("opacity_linear", 1);
    const rOp = l.accessor("opacity", 4);
    const wOpLin = l.writer("opacity_linear");
    const wOp = l.writer("opacity");

    const header = (n) =>
      Buffer.from(
        l.header.replace(/^(element vertex )\d+/m, (_, p) => p + String(n).padStart(16, "0")),
        "latin1",
      );

    out = fs.openSync(output, "w");
    fs.writeSync(out, header(0));

    const stride = l.stride;
    const rows = Math.max(1, Math.floor((2 * 1024 * 1024) / stride));
    const inBuf = Buffer.alloc(rows * stride);
    const outBuf = Buffer.alloc(rows * stride);
    let outUsed = 0;
    let totalWritten = 0;
    const shChR = new Float32Array(15);
    const shChG = new Float32Array(15);
    const shChB = new Float32Array(15);

    const flushOut = () => {
      if (outUsed > 0) {
        fs.writeSync(out, outBuf, 0, outUsed);
        outUsed = 0;
      }
    };

    for (let first = 0; first < count; first += rows) {
      const n = Math.min(rows, count - first);
      readExact(fd, inBuf, n * stride, l.start + first * stride);
      for (let i = 0; i < n; i++) {
        const srcIdx = first + i;
        if (deletedBits && hasBit(deletedBits, srcIdx)) continue;
        if (onlyBits && !hasBit(onlyBits, srcIdx)) continue;

        if (outUsed + stride > outBuf.length) flushOut();
        const rowOff = i * stride;
        inBuf.copy(outBuf, outUsed, rowOff, rowOff + stride);
        const at = outUsed;

        // 1. Sparse paint delta
        if (paintMap && hasDc && paintMap.has(srcIdx)) {
          const pd = paintMap.get(srcIdx);
          wDc0(outBuf, at, pd[0]);
          wDc1(outBuf, at, pd[1]);
          wDc2(outBuf, at, pd[2]);
        }

        // 2. Per-splat / entity affine transform + SH rotation
        const slot = tIndices ? tIndices[srcIdx] : 0;
        const xf = slot < slotXforms.length ? slotXforms[slot] : slotXforms[0];
        if (xf) {
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

        // 3. ReSplat ColorGrade (DC + SH1-3 + opacity)
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
        totalWritten++;
      }
    }
    flushOut();

    if (!totalWritten) throw Error("Empty export (all Gaussians deleted)");
    const h = header(totalWritten);
    fs.writeSync(out, h, 0, h.length, 0);
    return totalWritten;
  } finally {
    fs.closeSync(fd);
    if (out !== undefined) fs.closeSync(out);
  }
}
