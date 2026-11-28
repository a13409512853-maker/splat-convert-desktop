// Disposable headless Node.js worker for 3D Gaussian Editor (v3.2.0).
// - sample: outputs ultra-compact lossless SGC3 binary file (~30 B/pt SoA: Float32 pos + Float16 log-scale
//           + Float16 quat + Uint8 RGBA + optional Uint32 srcIdx only when subsampled), supporting up to
//           40,000,000 Gaussians losslessly with real-time PROGRESS:<0..100> reporting and low peak RAM.
// - mask:   dispatches v3 full multi-object/duplicate/4x4+SH-rot/SH-color-bake processor OR legacy v1/v2 maskPly.
// - probe:  checks if input is a standard binary little-endian PLY.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { compile } from "./rules.mjs";
import { layout, readExact, maskPly } from "./ply.mjs";
import { processPlyV3Parallel, processPlyV4Parallel } from "./ply-parallel.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [mode, input, out, arg, engine] = process.argv.slice(2);

registerHooks({
  resolve(spec, ctx, next) {
    return spec === "playcanvas"
      ? {
          url: new URL("./vendor/playcanvas.min.mjs", import.meta.url).href,
          shortCircuit: true,
        }
      : next(spec, ctx);
  },
});

const SH_C0 = 0.28209479177387814;
const MAX_SAFE_POINTS = 40000000;

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function f32ToF16(val) {
  if (!Number.isFinite(val)) return 0;
  _f32[0] = val;
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 112;
  let mant = x & 0x007fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x00800000) >>> (1 - exp);
    return sign | ((mant + 0x00001000) >>> 13);
  }
  if (exp >= 31) return sign | 0x7bff;
  return sign | ((exp << 10) + ((mant + 0x00001000) >>> 13));
}

function clampU8(v) {
  const n = Math.round(v * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

let lastPct = -1;
function reportProgress(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  if (p !== lastPct) {
    lastPct = p;
    process.stderr.write(`PROGRESS:${p}\n`);
  }
}

function writeBufferChunked(fd, typedArray, byteLength) {
  const CHUNK = 64 * 1024 * 1024; // 64 MB chunks keep writes fast & safe on Windows
  const buf = Buffer.from(typedArray.buffer, typedArray.byteOffset, byteLength);
  for (let off = 0; off < byteLength; off += CHUNK) {
    const len = Math.min(CHUNK, byteLength - off);
    fs.writeSync(fd, buf, off, len);
  }
}

async function sample() {
  // 0 or "full" => 100% lossless full load (up to MAX_SAFE_POINTS)
  const reqCap =
    arg === "full" || Number(arg) === 0
      ? MAX_SAFE_POINTS
      : Math.min(MAX_SAFE_POINTS, Math.max(1024, Number(arg) || 500000));
  reportProgress(2);

  let pos = null;        // Float32Array(n * 3)
  let scalesHalf = null; // Uint16Array(n * 3)
  let quatsHalf = null;  // Uint16Array(n * 4)
  let rgba = null;       // Uint8Array(n * 4)
  let srcIndices = null; // Uint32Array(n) or null when sequential 0..total-1
  let used = 0;
  let totalSourceCount = 0;
  let isContiguousSequential = true;

  function alloc(n, needSrcIdx) {
    pos = new Float32Array(n * 3);
    scalesHalf = new Uint16Array(n * 3);
    quatsHalf = new Uint16Array(n * 4);
    rgba = new Uint8Array(n * 4);
    srcIndices = needSrcIdx ? new Uint32Array(n) : null;
  }

  function add(srcIdx, x, y, z, r, g, b, sx, sy, sz, w, qx, qy, qz, alpha) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      isContiguousSequential = false;
      return;
    }
    const u = used;
    if (!pos || u * 3 >= pos.length) return;
    if (srcIndices) srcIndices[u] = srcIdx >>> 0;
    else if (srcIdx !== u) isContiguousSequential = false;
    used = u + 1;

    const p3 = u * 3;
    pos[p3] = x;
    pos[p3 + 1] = y;
    pos[p3 + 2] = z;

    scalesHalf[p3] = f32ToF16(Number.isFinite(sx) ? sx : -6);
    scalesHalf[p3 + 1] = f32ToF16(Number.isFinite(sy) ? sy : -6);
    scalesHalf[p3 + 2] = f32ToF16(Number.isFinite(sz) ? sz : -6);

    const p4 = u * 4;
    const ql = Math.hypot(qx, qy, qz, w);
    if (ql > 1e-8 && Number.isFinite(ql)) {
      const inv = 1 / ql;
      quatsHalf[p4] = f32ToF16(qx * inv);
      quatsHalf[p4 + 1] = f32ToF16(qy * inv);
      quatsHalf[p4 + 2] = f32ToF16(qz * inv);
      quatsHalf[p4 + 3] = f32ToF16(w * inv);
    } else {
      quatsHalf[p4] = 0;
      quatsHalf[p4 + 1] = 0;
      quatsHalf[p4 + 2] = 0;
      quatsHalf[p4 + 3] = 0x3c00; // 1.0 in IEEE 754 float16
    }

    rgba[p4] = clampU8(r);
    rgba[p4 + 1] = clampU8(g);
    rgba[p4 + 2] = clampU8(b);
    rgba[p4 + 3] = clampU8(Number.isFinite(alpha) ? alpha : 1);
  }

  const fd = fs.openSync(input, "r");
  let simple;
  try {
    simple = /\.ply$/i.test(input) && layout(fd);
    if (simple) {
      const l = simple;
      totalSourceCount = l.count;
      const n = Math.min(reqCap, l.count);
      const isFull = n >= l.count;
      alloc(n, !isFull);

      const rX = l.accessor("x"), rY = l.accessor("y"), rZ = l.accessor("z");
      const rDc0 = l.accessor("f_dc_0", 0), rDc1 = l.accessor("f_dc_1", 0), rDc2 = l.accessor("f_dc_2", 0);
      const rRed = l.accessor("red", 128), rGrn = l.accessor("green", 128), rBlu = l.accessor("blue", 128);
      const rS0 = l.accessor("scale_0", -6), rS1 = l.accessor("scale_1", -6), rS2 = l.accessor("scale_2", -6);
      const rQ0 = l.accessor("rot_0", 1), rQ1 = l.accessor("rot_1", 0), rQ2 = l.accessor("rot_2", 0), rQ3 = l.accessor("rot_3", 0);
      const rOp = l.accessor("opacity", 4);
      const rOpLin = l.accessor("opacity_linear", 1);
      const hasRed = !!l.fields.red;
      const hasOpLin = !!l.fields.opacity_linear;

      if (isFull) {
        const rows = Math.max(1, Math.floor((8 * 1024 * 1024) / l.stride));
        const buf = Buffer.alloc(rows * l.stride);
        for (let first = 0; first < l.count; first += rows) {
          const cnt = Math.min(rows, l.count - first);
          readExact(fd, buf, cnt * l.stride, l.start + first * l.stride);
          for (let i = 0; i < cnt; i++) {
            const off = i * l.stride;
            const r = hasRed ? rRed(buf, off) / 255 : 0.5 + SH_C0 * rDc0(buf, off);
            const g = hasRed ? rGrn(buf, off) / 255 : 0.5 + SH_C0 * rDc1(buf, off);
            const b = hasRed ? rBlu(buf, off) / 255 : 0.5 + SH_C0 * rDc2(buf, off);
            const op = hasOpLin ? rOpLin(buf, off) : 1 / (1 + Math.exp(-rOp(buf, off)));
            add(
              first + i,
              rX(buf, off), rY(buf, off), rZ(buf, off),
              r, g, b,
              rS0(buf, off), rS1(buf, off), rS2(buf, off),
              rQ0(buf, off), rQ1(buf, off), rQ2(buf, off), rQ3(buf, off),
              op,
            );
          }
          reportProgress(5 + ((first + cnt) / l.count) * 85);
        }
        // If any NaN skipped a point during full read, fall back to storing exact indices
        if (!isContiguousSequential && !srcIndices) {
          // Re-scan indices cheaply only in rare NaN PLY case
          srcIndices = new Uint32Array(used);
          let k = 0;
          for (let first = 0; first < l.count; first += rows) {
            const cnt = Math.min(rows, l.count - first);
            readExact(fd, buf, cnt * l.stride, l.start + first * l.stride);
            for (let i = 0; i < cnt; i++) {
              const off = i * l.stride;
              if (Number.isFinite(rX(buf, off)) && Number.isFinite(rY(buf, off)) && Number.isFinite(rZ(buf, off))) {
                srcIndices[k++] = first + i;
              }
            }
          }
        }
      } else {
        const groups = Math.min(n, 8192);
        for (let j = 0; j < groups; j++) {
          const a = Math.floor((j * n) / groups);
          const b = Math.floor(((j + 1) * n) / groups);
          const cnt = b - a;
          const window = Math.max(cnt, Math.min(Math.floor(l.count / groups), cnt * 4));
          const first = Math.max(
            0,
            Math.min(l.count - window, Math.floor(((j + 0.5) * l.count) / groups - window / 2)),
          );
          const buf = Buffer.alloc(window * l.stride);
          readExact(fd, buf, buf.length, l.start + first * l.stride);
          for (let i = 0; i < cnt; i++) {
            const localRow = Math.floor((i * window) / cnt);
            const off = localRow * l.stride;
            const r = hasRed ? rRed(buf, off) / 255 : 0.5 + SH_C0 * rDc0(buf, off);
            const g = hasRed ? rGrn(buf, off) / 255 : 0.5 + SH_C0 * rDc1(buf, off);
            const b = hasRed ? rBlu(buf, off) / 255 : 0.5 + SH_C0 * rDc2(buf, off);
            const op = hasOpLin ? rOpLin(buf, off) : 1 / (1 + Math.exp(-rOp(buf, off)));
            add(
              first + localRow,
              rX(buf, off), rY(buf, off), rZ(buf, off),
              r, g, b,
              rS0(buf, off), rS1(buf, off), rS2(buf, off),
              rQ0(buf, off), rQ1(buf, off), rQ2(buf, off), rQ3(buf, off),
              op,
            );
          }
          if ((j & 127) === 0) reportProgress(5 + (j / groups) * 85);
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  if (!simple) {
    const lib = await import(
      pathToFileURL(
        path.join(
          engine,
          "node_modules/@playcanvas/splat-transform/dist/index.mjs",
        ),
      )
    );
    const format = lib.getInputFormat(input);
    if (!["sog", "ply", "splat", "spz"].includes(format)) {
      throw Error("This format is not supported for 3D editing preview");
    }
    const fileSystem = {
      async createSource(name) {
        if (path.resolve(name) !== path.resolve(input))
          throw Error("Unexpected external resource");
        const f = fs.openSync(name, "r");
        const size = fs.fstatSync(f).size;
        return {
          size,
          seekable: true,
          close: () => fs.closeSync(f),
          read(start = 0, end = size) {
            let posCursor = start;
            return new (class extends lib.ReadStream {
              constructor() {
                super(end - start);
              }
              async pull(target) {
                let n = Math.min(end - posCursor, target.length);
                if (!n) return 0;
                n = fs.readSync(f, target, 0, n, posCursor);
                posCursor += n;
                this.bytesRead += n;
                return n;
              }
            })();
          },
        };
      },
    };

    if (format === "sog") {
      if (!input.toLowerCase().endsWith(".sog"))
        throw Error("Please select a bundled .sog file");
      const zip = new lib.ZipReadFileSystem(
        await fileSystem.createSource(input),
      );
      const read = async (name) => {
        const s = await zip.createSource(name);
        try {
          return await s.read().readAll();
        } finally {
          s.close();
        }
      };
      try {
        const m = JSON.parse(new TextDecoder().decode(await read("meta.json")));
        if (![2, 3].includes(m.version) || !Number.isSafeInteger(m.count) || m.count < 1)
          throw Error("Unsupported SOG metadata");
        totalSourceCount = m.count;
        const decoder = await lib.WebPCodec.create();
        const n = Math.min(m.count, reqCap);
        const isFull = n === m.count;
        alloc(n, !isFull);
        used = n;

        // Build index map only when subsampling (zero-alloc sequential when 100% full!)
        if (!isFull) {
          for (let i = 0; i < n; i++) {
            srcIndices[i] = Math.floor(((i + 0.5) * m.count) / n);
          }
        }

        async function decodeTexRaw(name) {
          const src = await read(name);
          const { rgba: raw, width, height } = decoder.decodeRGBA(src);
          if (width * height < m.count) throw Error("Truncated SOG texture");
          return raw;
        }

        // Stream-decode SOG textures one section at a time -> keeps peak Node RAM minimal even at 35M points!
        // 1. Positions (means_l + means_u)
        {
          const lo = await decodeTexRaw(m.means.files[0]);
          reportProgress(16);
          const hi = await decodeTexRaw(m.means.files[1]);
          reportProgress(32);
          const min0 = m.means.mins[0], span0 = (m.means.maxs[0] - min0) / 65535;
          const min1 = m.means.mins[1], span1 = (m.means.maxs[1] - min1) / 65535;
          const min2 = m.means.mins[2], span2 = (m.means.maxs[2] - min2) / 65535;

          for (let i = 0; i < n; i++) {
            const v = (isFull ? i : srcIndices[i]) * 4;
            const p3 = i * 3;
            const t0 = min0 + span0 * ((hi[v] << 8) | lo[v]);
            const t1 = min1 + span1 * ((hi[v + 1] << 8) | lo[v + 1]);
            const t2 = min2 + span2 * ((hi[v + 2] << 8) | lo[v + 2]);
            pos[p3] = t0 < 0 ? -Math.expm1(-t0) : Math.expm1(t0);
            pos[p3 + 1] = t1 < 0 ? -Math.expm1(-t1) : Math.expm1(t1);
            pos[p3 + 2] = t2 < 0 ? -Math.expm1(-t2) : Math.expm1(t2);
          }
        }
        reportProgress(46);

        // 2. Scales (pre-encode 256-entry codebook directly into float16 -> zero math in 35M loop!)
        {
          const sRaw = await decodeTexRaw(m.scales.files[0]);
          const cb16 = new Uint16Array(256);
          for (let k = 0; k < 256; k++) {
            cb16[k] = f32ToF16(m.scales.codebook[k] ?? -6);
          }
          for (let i = 0; i < n; i++) {
            const v = (isFull ? i : srcIndices[i]) * 4;
            const p3 = i * 3;
            scalesHalf[p3] = cb16[sRaw[v]];
            scalesHalf[p3 + 1] = cb16[sRaw[v + 1]];
            scalesHalf[p3 + 2] = cb16[sRaw[v + 2]];
          }
        }
        reportProgress(62);

        // 3. Quaternions (zero-allocation tight loop, direct float16 output)
        {
          const qRaw = await decodeTexRaw(m.quats.files[0]);
          const isV3 = m.version === 3;
          const invSqrt2 = Math.SQRT1_2;
          const halfPi = Math.PI * 0.5;
          for (let i = 0; i < n; i++) {
            const v = (isFull ? i : srcIndices[i]) * 4;
            const p4 = i * 4;
            let rw = 1, rx = 0, ry = 0, rz = 0;
            if (isV3) {
              const vx = (qRaw[v] - 128) / 127;
              const vy = (qRaw[v + 1] - 128) / 127;
              const vz = (qRaw[v + 2] - 128) / 127;
              const r = Math.hypot(vx, vy, vz);
              rw = Math.cos(r * halfPi);
              if (r > 1e-8) {
                const k = Math.sin(r * halfPi) / r;
                rx = vx * k;
                ry = vy * k;
                rz = vz * k;
              }
            } else {
              const k = qRaw[v + 3] - 252;
              if (k >= 0 && k < 4) {
                const c0 = ((qRaw[v] / 255) * 2 - 1) * invSqrt2;
                const c1 = ((qRaw[v + 1] / 255) * 2 - 1) * invSqrt2;
                const c2 = ((qRaw[v + 2] / 255) * 2 - 1) * invSqrt2;
                const rem = Math.sqrt(Math.max(0, 1 - (c0 * c0 + c1 * c1 + c2 * c2)));
                if (k === 0) { rw = rem; rx = c0; ry = c1; rz = c2; }
                else if (k === 1) { rw = c0; rx = rem; ry = c1; rz = c2; }
                else if (k === 2) { rw = c0; rx = c1; ry = rem; rz = c2; }
                else { rw = c0; rx = c1; ry = c2; rz = rem; }
              }
            }
            // Three.js quaternion order is (x, y, z, w)
            quatsHalf[p4] = f32ToF16(rx);
            quatsHalf[p4 + 1] = f32ToF16(ry);
            quatsHalf[p4 + 2] = f32ToF16(rz);
            quatsHalf[p4 + 3] = f32ToF16(rw);
          }
        }
        reportProgress(78);

        // 4. Colors & Opacity (pre-baked 256-entry RGB & alpha LUTs -> blazingly fast!)
        {
          const cRaw = await decodeTexRaw(m.sh0.files[0]);
          const rgbLut = new Uint8Array(256);
          const aLut = new Uint8Array(256);
          for (let k = 0; k < 256; k++) {
            rgbLut[k] = clampU8(0.5 + SH_C0 * (m.sh0.codebook[k] ?? 0));
            aLut[k] = m.version === 2 ? k : clampU8(Math.min(1, (k / 204) ** 2));
          }
          for (let i = 0; i < n; i++) {
            const v = (isFull ? i : srcIndices[i]) * 4;
            const p4 = i * 4;
            rgba[p4] = rgbLut[cRaw[v]];
            rgba[p4 + 1] = rgbLut[cRaw[v + 1]];
            rgba[p4 + 2] = rgbLut[cRaw[v + 2]];
            rgba[p4 + 3] = aLut[cRaw[v + 3]];
          }
        }
        reportProgress(90);
      } finally {
        zip.close();
      }
    } else {
      const [src] = await lib.readFile({
        filename: input,
        inputFormat: format,
        fileSystem,
      });
      try {
        const m = src.meta;
        totalSourceCount = m.numGaussians;
        const n = Math.min(reqCap, m.numGaussians);
        const isFull = n === m.numGaussians;
        alloc(n, !isFull);
        const pool = lib.createChunkDataPool({ chunkSize: 1024 });
        const idx = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
          idx[i] = isFull ? i : Math.floor(((i + 0.5) * m.numGaussians) / n);
        }
        for (let off = 0; off < n; off += 1024) {
          const count = Math.min(1024, n - off);
          const req = { indices: idx, indexOffset: off, count };
          for (const k of ["position", "color", "geometric"]) {
            if (m.layouts[k]) req[k] = pool.acquire(k, m.layouts[k], count);
          }
          await src.read(req);
          const p = req.position.field("position");
          const c = req.color?.field("dc");
          const g = req.geometric && new Float32Array(req.geometric.data);
          for (let i = 0; i < count; i++) {
            const j = i * 3;
            const h = i * 8;
            add(
              idx[off + i],
              p[j], p[j + 1], p[j + 2],
              0.5 + SH_C0 * (c?.[j] || 0),
              0.5 + SH_C0 * (c?.[j + 1] || 0),
              0.5 + SH_C0 * (c?.[j + 2] || 0),
              g ? g[h + 4] : -6, g ? g[h + 5] : -6, g ? g[h + 6] : -6,
              g ? g[h] : 1, g ? g[h + 1] : 0, g ? g[h + 2] : 0, g ? g[h + 3] : 0,
              g ? g[h + 7] : 1,
            );
          }
          for (const k of ["position", "color", "geometric"]) req[k]?.release();
          reportProgress(5 + ((off + count) / n) * 85);
        }
      } finally {
        await src.close();
      }
    }
  }

  if (!used) throw Error("No valid Gaussian coordinates found");
  reportProgress(94);

  // Write SGC3 compact SoA container (~30 B/pt lossless, 4-byte aligned sections)
  const hasSrcIdx = srcIndices ? 1 : 0;
  const headerBuf = Buffer.alloc(32);
  headerBuf.write("SGC3", 0, 4, "ascii");
  headerBuf.writeUInt32LE(3, 4);                  // format version 3 (compact SoA)
  headerBuf.writeUInt32LE(totalSourceCount >>> 0, 8);
  headerBuf.writeUInt32LE(used >>> 0, 12);
  headerBuf.writeUInt32LE(1, 16);                 // coordSpace: 1 = native +Y-up
  headerBuf.writeUInt32LE(0, 20);
  headerBuf.writeUInt32LE(hasSrcIdx, 24);
  headerBuf.writeUInt32LE(0, 28);

  const outFd = fs.openSync(out, "w");
  try {
    fs.writeSync(outFd, headerBuf);
    writeBufferChunked(outFd, pos, used * 12);
    const scaleBytes = used * 6;
    writeBufferChunked(outFd, scalesHalf, scaleBytes);
    if ((scaleBytes & 3) !== 0) {
      fs.writeSync(outFd, Buffer.alloc(4 - (scaleBytes & 3)));
    }
    writeBufferChunked(outFd, quatsHalf, used * 8);
    writeBufferChunked(outFd, rgba, used * 4);
    if (hasSrcIdx) {
      writeBufferChunked(outFd, srcIndices, used * 4);
    }
  } finally {
    fs.closeSync(outFd);
  }

  process.stderr.write(`TOTAL_POINTS:${totalSourceCount}\n`);
  process.stderr.write(`LOADED_POINTS:${used}\n`);
  reportProgress(100);
}

async function runMask() {
  const recipe = JSON.parse(fs.readFileSync(arg, "utf8").replace(/^\uFEFF/, ""));
  const lutsDir = path.join(__dirname, "luts");
  const threadsFlag = process.argv.find((a) => typeof a === "string" && a.startsWith("--threads="));
  const reqThreads = threadsFlag ? Number(threadsFlag.split("=")[1]) : null;
  if (recipe.version === 4) {
    await processPlyV4Parallel(input, out, recipe, lutsDir, {
      threads: reqThreads,
      onProgress: (p) => reportProgress(p),
    });
    return;
  }
  if (recipe.version === 3) {
    await processPlyV3Parallel(input, out, recipe, lutsDir, {
      threads: reqThreads,
      onProgress: (p) => reportProgress(p),
    });
    return;
  }

  // Legacy v1 / v2 path (100% compatible with existing tests/editor-export.mjs)
  const hasRules = Array.isArray(recipe.rules) && recipe.rules.length > 0;
  const rulePred = hasRules ? compile(recipe) : null;
  const deletedSet =
    Array.isArray(recipe.deletedIndices) && recipe.deletedIndices.length > 0
      ? new Set(recipe.deletedIndices)
      : null;
  const keepSet =
    Array.isArray(recipe.keepIndices) && recipe.keepIndices.length > 0
      ? new Set(recipe.keepIndices)
      : null;
  const colorMap =
    Array.isArray(recipe.bakedColors) && recipe.bakedColors.length > 0
      ? new Map(recipe.bakedColors.map((row) => [row[0], row.slice(1)]))
      : null;
  const keep = (x, y, z, srcIdx) => {
    if (deletedSet && deletedSet.has(srcIdx)) return false;
    if (keepSet && !keepSet.has(srcIdx)) return false;
    if (rulePred && !rulePred(x, y, z)) return false;
    return true;
  };
  maskPly(input, out, keep, colorMap);
}

if (mode === "sample") {
  sample().catch((e) => {
    process.stderr.write((e?.stack || String(e)) + "\n");
    process.exit(1);
  });
} else if (mode === "mask") {
  runMask().catch((e) => {
    process.stderr.write((e?.stack || String(e)) + "\n");
    process.exit(1);
  });
} else if (mode === "probe") {
  const fd = fs.openSync(input, "r");
  try {
    process.exit(layout(fd) ? 0 : 2);
  } finally {
    fs.closeSync(fd);
  }
} else {
  process.stderr.write("Unknown mode: " + mode + "\n");
  process.exit(1);
}
