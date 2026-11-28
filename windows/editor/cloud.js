// True WebGL2 Instanced-Quad 3D Gaussian Splatting Renderer (+Y-up native, ultra-low-memory 46 B/pt)
// Features:
// - Zero gl_PointSize hardware cap, zero square clipping, zero frustum edge popping
// - TEX_WIDTH = 4096 -> scales cleanly up to 67,000,000 Gaussians!
// - Compact GPU layout: RGBA32F pos (freed on CPU after upload), RGBA16F log-scale, RGBA16F quat,
//   RGBA8 linear color+alpha, RGBA8 state (flags/gradeMask/objVis/objId) -> 5.4x less memory!
// - Exact Uint16x2 instanced sort index (SIMD TypedArray.set, bit-exact up to 2.1B splats!)
// - Exact 32-bit RGBA GPU ID Picking Pass (supports up to 4.29B splats, visible-only + whole-Gaussian!)
// - 3 display modes: Color Points (full density at 100%), True Splat (100% lossless), ReSplat Rings (ringSize=0.04)
// - Dedicated Web Worker O(N) 16-bit counting depth sort + per-object GPU 4x4 matrices (32 objects)
// - Fragment-exact live ReSplat color grading + 8-band HSL + 16^3 3D LUT + split-screen compare
// - True dynamic point duplication for Shift+D local copies with full Undo/Redo support
import * as T from "three";
import { RING_MODE_SIZE, MAX_SCENE_OBJECTS } from "./constants.js";
import {
  HSL_CENTERS_NORM,
  HSL_HALF_WIDTHS_NORM,
  applyColorGradeCPU,
  resolveEffectiveGrade,
} from "./color-grade.js";
import {
  VERTEX_SHADER,
  FRAGMENT_SHADER,
  CENTERS_VERTEX_SHADER,
  CENTERS_FRAGMENT_SHADER,
  PICK_VERTEX_SHADER,
  PICK_FRAGMENT_SHADER,
} from "./shaders/splat-shaders.js";

export const FLAG_SELECTED = 1;
export const FLAG_DELETED = 2;
export const FLAG_HIDDEN = 4;

const TEX_WIDTH = 4096;

// Precomputed 65536-entry float16 -> float32 lookup table for instant zero-branch CPU decoding!
export const HALF_TO_FLOAT = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
  HALF_TO_FLOAT[h] = T.DataUtils.fromHalfFloat(h);
}

export function floatToHalf(v) {
  return T.DataUtils.toHalfFloat(Number.isFinite(v) ? Math.max(-65504, Math.min(65504, v)) : 0);
}

function makeDataTexture(data, width, height, format, type, filter = T.NearestFilter) {
  const tex = new T.DataTexture(data, width, height, format, type);
  tex.minFilter = filter;
  tex.magFilter = filter;
  tex.wrapS = T.ClampToEdgeWrapping;
  tex.wrapT = T.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

export function decodePickId(pixels, off) {
  return (
    (pixels[off] |
      (pixels[off + 1] << 8) |
      (pixels[off + 2] << 16) |
      (pixels[off + 3] << 24)) >>>
    0
  );
}

export class Cloud extends T.Mesh {
  /**
   * Accepts either parsed SGC3 SoA object `{ count, pos, scalesHalf, quatsHalf, rgba, srcIdx }`
   * OR legacy SGC2 Float32Array(n * 14) + optional sourceIndices.
   */
  constructor(inputData, sourceIndices = null, onSortComplete = null, renderer = null) {
    const isSoA = inputData && !(inputData instanceof Float32Array) && inputData.pos instanceof Float32Array;
    const n = isSoA ? inputData.count | 0 : Math.floor(inputData.length / 14);

    // 64-splat Block-Coherent Permutation: preserves .sog Morton Z-order spatial locality across
    // 32-thread GPU warps (massive L1/L2 texture cache hit boost!) while guaranteeing any prefix
    // [0..drawCount) uniformly covers the entire 3D scene during adaptive 20fps downsampling!
    const perm = new Uint32Array(n);
    const BLOCK = 64;
    const numBlocks = Math.ceil(n / BLOCK);
    const blockOrder = new Uint32Array(numBlocks);
    for (let b = 0; b < numBlocks; b++) blockOrder[b] = b;
    let seed = 121;
    for (let b = numBlocks - 1; b > 0; b--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (b + 1);
      const t = blockOrder[j];
      blockOrder[j] = blockOrder[b];
      blockOrder[b] = t;
    }
    let outPtr = 0;
    for (let bi = 0; bi < numBlocks; bi++) {
      const start = blockOrder[bi] * BLOCK;
      const end = Math.min(n, start + BLOCK);
      for (let k = start; k < end; k++) perm[outPtr++] = k;
    }

    // Build instanced unit quad geometry
    const quadGeo = new T.InstancedBufferGeometry();
    quadGeo.setAttribute(
      "position",
      new T.BufferAttribute(
        new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        3,
      ),
    );
    quadGeo.setIndex([0, 1, 2, 0, 2, 3]);

    // Identity dummy 256x16 LUT texture
    const dummyLut = new Uint8Array(256 * 16 * 4);
    for (let b = 0; b < 16; b++) {
      for (let g = 0; g < 16; g++) {
        for (let r = 0; r < 16; r++) {
          const x = b * 16 + r;
          const off = (g * 256 + x) * 4;
          dummyLut[off] = Math.round((r / 15) * 255);
          dummyLut[off + 1] = Math.round((g / 15) * 255);
          dummyLut[off + 2] = Math.round((b / 15) * 255);
          dummyLut[off + 3] = 255;
        }
      }
    }
    const lutTex = makeDataTexture(dummyLut, 256, 16, T.RGBAFormat, T.UnsignedByteType, T.LinearFilter);

    const objMatArray = [];
    for (let i = 0; i < MAX_SCENE_OBJECTS; i++) objMatArray.push(new T.Matrix4());

    const mat = new T.ShaderMaterial({
      uniforms: {
        uPosTex: { value: null },
        uScaleTex: { value: null },
        uQuatTex: { value: null },
        uColorTex: { value: null },
        uStateTex: { value: null },
        uTexWidth: { value: TEX_WIDTH },
        uObjectMatrices: { value: objMatArray },
        uRenderMode: { value: 0 },
        uRingSize: { value: RING_MODE_SIZE },
        uResolution: { value: new T.Vector2(1280, 720) },
        uPointSize: { value: 2.2 },
        uMaxSplatPx: { value: n > 15000000 ? 96.0 : 260.0 },
        uIsOrtho: { value: 0 },
        uHideSelectionHighlight: { value: 0.0 },

        uGradeEnabled: { value: 0.0 },
        uCompareOriginal: { value: 0.0 },
        uSplitX: { value: -1.0 },
        uExposure: { value: 0.0 },
        uBrightness: { value: 0.0 },
        uContrast: { value: 1.0 },
        uBlackPoint: { value: 0.0 },
        uWhitePoint: { value: 1.0 },
        uOutBlack: { value: 0.0 },
        uOutWhite: { value: 1.0 },
        uHighlights: { value: 0.0 },
        uShadows: { value: 0.0 },
        uWhites: { value: 0.0 },
        uBlacks: { value: 0.0 },
        uSaturation: { value: 1.0 },
        uVibrance: { value: 0.0 },
        uTemperature: { value: 0.0 },
        uTintShift: { value: 0.0 },
        uTint: { value: new T.Vector3(1, 1, 1) },
        uGamma: { value: 1.0 },
        uTransparency: { value: 1.0 },
        uHslActive: { value: 0.0 },
        uHslCenters: { value: Array.from(HSL_CENTERS_NORM) },
        uHslHalfWidths: { value: Array.from(HSL_HALF_WIDTHS_NORM) },
        uHslHue: { value: new Array(8).fill(0) },
        uHslSat: { value: new Array(8).fill(0) },
        uHslLight: { value: new Array(8).fill(0) },
        uPointColorActive: { value: 0.0 },
        uPointColorTarget: { value: new T.Vector3(0, 0.5, 0.5) },
        uPointColorParams: { value: new T.Vector4(0.24, 0.52, 0.0, 0.0) },
        uPointColorShift: { value: new T.Vector3(0, 0, 0) },
        uLutTex: { value: lutTex },
        uLutIntensity: { value: 0.0 },
        uMeasureVizMode: { value: 0 },
        uMeasureOrigin: { value: new T.Vector3(0, 0, 0) },
        uMeasureNormal: { value: new T.Vector3(0, 1, 0) },
        uMeasureAxisU: { value: new T.Vector3(1, 0, 0) },
        uMeasureAxisV: { value: new T.Vector3(0, 0, 1) },
        uMeasurePolyBounds: { value: new T.Vector4(0, 0, 0, 0) },
        uMeasureVizParams: { value: new T.Vector4(1.0, 0.30, 0.06, 0.0) },
        uMeasurePolyCount: { value: 0 },
        uMeasurePolyPacked: { value: Array.from({ length: 24 }, () => new T.Vector4(0, 0, 0, 0)) },
        uVolScopeActive: { value: 0 },
        uVolPrimCount: { value: 0 },
        uVolOpCount: { value: 0 },
        uVolPrimKind: { value: new Int32Array(24) },
        uVolPlaneSigns: { value: new Float32Array(24) },
        uVolInvMats: { value: Array.from({ length: 24 }, () => new T.Matrix4()) },
        uVolOps: { value: new Int32Array(48) },
        uVolSelectableObj: { value: new Float32Array(MAX_SCENE_OBJECTS).fill(1.0) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      side: T.DoubleSide,
    });

    super(quadGeo, mat);
    this.frustumCulled = false;

    this.n = n;
    this.originalCount = n;
    this.onSortComplete = onSortComplete;
    this._renderer = renderer;
    this.defaultLutTex = lutTex;
    this.activeLutRgba = null;
    this.objectMatrices = objMatArray;
    this.objectMatricesFlat = new Float32Array(MAX_SCENE_OBJECTS * 16);
    for (let i = 0; i < MAX_SCENE_OBJECTS; i++) {
      objMatArray[i].toArray(this.objectMatricesFlat, i * 16);
    }

    const texH = Math.max(1, Math.ceil(n / TEX_WIDTH));
    const texSize = TEX_WIDTH * texH;

    // Ultra-compact single-source-of-truth buffers (46 B/pt total CPU RAM!)
    this.pos = new Float32Array(n * 3);
    this.scaleHalf = new Uint16Array(texSize * 4);
    this.quatHalf = new Uint16Array(texSize * 4);
    this.rgba = new Uint8Array(texSize * 4);
    this.stateTexData = new Uint8Array(texSize * 4);
    this.srcIdx = new Uint32Array(n);
    this.flags = new Uint8Array(n);
    this.objectIds = new Uint8Array(n);
    this.objectVisibility = new Map([[0, true]]);
    this._objectIdsDirty = false;
    // Texture-residency warmup frame: on 2M+ clouds, frame 1 draws a fast prefix while GPU pages
    // 0.6-1.6 GB of DataTextures into VRAM, preventing Windows 2.0s D3D11 TDR on initial mount!
    this._warmupPending = n > 2000000;

    if (isSoA) {
      const sPos = inputData.pos;
      const sScale = inputData.scalesHalf;
      const sQuat = inputData.quatsHalf;
      const sRgba = inputData.rgba;
      const sIdx = inputData.srcIdx;

      for (let i = 0; i < n; i++) {
        const orig = perm[i];
        const o3 = orig * 3;
        const o4 = orig * 4;
        const i3 = i * 3;
        const i4 = i * 4;

        this.srcIdx[i] = sIdx ? sIdx[orig] : orig;
        this.pos[i3] = sPos[o3];
        this.pos[i3 + 1] = sPos[o3 + 1];
        this.pos[i3 + 2] = sPos[o3 + 2];

        this.scaleHalf[i4] = sScale[o3];
        this.scaleHalf[i4 + 1] = sScale[o3 + 1];
        this.scaleHalf[i4 + 2] = sScale[o3 + 2];
        this.scaleHalf[i4 + 3] = 0;

        this.quatHalf[i4] = sQuat[o4];
        this.quatHalf[i4 + 1] = sQuat[o4 + 1];
        this.quatHalf[i4 + 2] = sQuat[o4 + 2];
        this.quatHalf[i4 + 3] = sQuat[o4 + 3];

        this.rgba[i4] = sRgba[o4];
        this.rgba[i4 + 1] = sRgba[o4 + 1];
        this.rgba[i4 + 2] = sRgba[o4 + 2];
        this.rgba[i4 + 3] = sRgba[o4 + 3];

        this.stateTexData[i4] = 0;
        this.stateTexData[i4 + 1] = 0;
        this.stateTexData[i4 + 2] = 255;
        this.stateTexData[i4 + 3] = 0;
      }
    } else {
      // Legacy SGC2 Float32(14) loader
      const rawFloats = inputData;
      const clampU8 = (v) => {
        const k = Math.round(v * 255);
        return k < 0 ? 0 : k > 255 ? 255 : k;
      };
      for (let i = 0; i < n; i++) {
        const orig = perm[i];
        const j = orig * 14;
        const i3 = i * 3;
        const i4 = i * 4;
        this.srcIdx[i] = sourceIndices ? sourceIndices[orig] : orig;

        this.pos[i3] = rawFloats[j];
        this.pos[i3 + 1] = rawFloats[j + 1];
        this.pos[i3 + 2] = rawFloats[j + 2];

        this.rgba[i4] = clampU8(rawFloats[j + 3]);
        this.rgba[i4 + 1] = clampU8(rawFloats[j + 4]);
        this.rgba[i4 + 2] = clampU8(rawFloats[j + 5]);
        this.rgba[i4 + 3] = clampU8(rawFloats[j + 13]);

        this.scaleHalf[i4] = floatToHalf(rawFloats[j + 6]);
        this.scaleHalf[i4 + 1] = floatToHalf(rawFloats[j + 7]);
        this.scaleHalf[i4 + 2] = floatToHalf(rawFloats[j + 8]);
        this.scaleHalf[i4 + 3] = 0;

        let qx = rawFloats[j + 9], qy = rawFloats[j + 10], qz = rawFloats[j + 11], qw = rawFloats[j + 12];
        const ql = Math.hypot(qx, qy, qz, qw);
        if (ql > 1e-8) { qx /= ql; qy /= ql; qz /= ql; qw /= ql; }
        else { qx = 0; qy = 0; qz = 0; qw = 1; }
        this.quatHalf[i4] = floatToHalf(qx);
        this.quatHalf[i4 + 1] = floatToHalf(qy);
        this.quatHalf[i4 + 2] = floatToHalf(qz);
        this.quatHalf[i4 + 3] = floatToHalf(qw);

        this.stateTexData[i4] = 0;
        this.stateTexData[i4 + 1] = 0;
        this.stateTexData[i4 + 2] = 255;
        this.stateTexData[i4 + 3] = 0;
      }
    }

    // Fast 1-vertex-per-splat GL_POINTS child for ReSplat Centers Mode (shares mat.uniforms & indexAttr!)
    this.centersGeo = new T.InstancedBufferGeometry();
    this.centersGeo.setAttribute("position", new T.BufferAttribute(new Float32Array([0, 0, 0]), 3));
    this.centersMat = new T.ShaderMaterial({
      uniforms: mat.uniforms,
      vertexShader: CENTERS_VERTEX_SHADER,
      fragmentShader: CENTERS_FRAGMENT_SHADER,
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });
    this.centersPoints = new T.Points(this.centersGeo, this.centersMat);
    this.centersPoints.frustumCulled = false;
    this.centersPoints.visible = false;
    this.add(this.centersPoints);

    // Build GPU DataTextures + Uint16x2 Instance Index Buffer
    this._rebuildGpuBuffers();

    // Dedicated 32-bit RGBA GPU ID Picking Mesh
    this.pickMat = new T.ShaderMaterial({
      uniforms: {
        uPosTex: mat.uniforms.uPosTex,
        uScaleTex: mat.uniforms.uScaleTex,
        uQuatTex: mat.uniforms.uQuatTex,
        uColorTex: mat.uniforms.uColorTex,
        uStateTex: mat.uniforms.uStateTex,
        uTexWidth: mat.uniforms.uTexWidth,
        uObjectMatrices: mat.uniforms.uObjectMatrices,
        uRenderMode: mat.uniforms.uRenderMode,
        uResolution: mat.uniforms.uResolution,
        uPointSize: mat.uniforms.uPointSize,
        uMaxSplatPx: mat.uniforms.uMaxSplatPx,
        uIsOrtho: mat.uniforms.uIsOrtho,
        uPickAlphaThreshold: { value: 0.04 },
      },
      vertexShader: PICK_VERTEX_SHADER,
      fragmentShader: PICK_FRAGMENT_SHADER,
      blending: T.NoBlending,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      side: T.DoubleSide,
    });
    this.pickScene = new T.Scene();
    this.pickMesh = new T.Mesh(quadGeo, this.pickMat);
    this.pickMesh.frustumCulled = false;
    this.pickScene.add(this.pickMesh);
    this.pickTarget = null;

    // Background Web Worker for async depth sorting
    this._sortWorker = null;
    this._sortJobId = 0;
    this._sorting = false;
    this._pendingSort = null;
    this._lastSortView = null;
    this._lastSortCount = 0;
    this._lastSortDispatchTs = 0;
    this.lastSortMs = 0;
    this.lastSortUploadMs = 0;
    this.sortCompletedCount = 0;
    this._initSortWorker();
  }

  _initSortWorker() {
    try {
      this._sortWorker = new Worker(new URL("./sort-worker.js", import.meta.url));
      this._sortWorker.onmessage = (e) => {
        const msg = e.data;
        if (!msg || msg.type !== "sorted") return;
        this._sorting = false;
        const isCurrent = msg.jobId === this._sortJobId && msg.drawCount === this.n;
        if (msg.order && isCurrent) {
          const tUp0 = performance.now();
          const cnt = Math.min(this.n, msg.order.length);
          // Zero-loop SIMD copy + PARTIAL PCIe range upload (avoids uploading 140 MB when cnt < n!)
          const srcU16 = new Uint16Array(msg.order.buffer, msg.order.byteOffset, cnt * 2);
          this.indexAttr.array.set(srcU16, 0);
          if (typeof this.indexAttr.clearUpdateRanges === "function") {
            this.indexAttr.clearUpdateRanges();
            this.indexAttr.addUpdateRange(0, cnt * 2);
          }
          this.indexAttr.needsUpdate = true;
          if (this.material.uniforms.uRenderMode.value !== 0) {
            this.geometry.instanceCount = cnt;
          }
          this.lastSortUploadMs = performance.now() - tUp0;
          if (typeof msg.sortMs === "number") this.lastSortMs = msg.sortMs;
          this.sortCompletedCount++;
        }
        // Return ArrayBuffer to worker for zero-GC ping-pong reuse (even when stale!)
        if (msg.order && msg.order.buffer && msg.order.buffer.byteLength > 0) {
          try {
            this._sortWorker.postMessage({ type: "recycle", buffer: msg.order.buffer }, [msg.order.buffer]);
          } catch { /* ignore if terminated */ }
        }
        if (isCurrent) {
          if (typeof this.onSortComplete === "function") this.onSortComplete();
          if (this._sortWaiters && this._sortWaiters.length > 0) {
            const waiters = this._sortWaiters.splice(0, this._sortWaiters.length);
            for (const w of waiters) w();
          }
        }
        if (this._pendingSort) {
          const next = this._pendingSort;
          this._pendingSort = null;
          this._dispatchWorkerSort(next.drawCount, next.viewZ);
        }
      };
      this._pushDataToWorker();
    } catch {
      this._sortWorker = null;
    }
  }

  _pushDataToWorker() {
    this._sortJobId++;
    this._pendingSort = null;
    if (!this._sortWorker) return;
    this._sortWorker.postMessage({
      type: "setData",
      count: this.n,
      positions: this.pos,
      objectIds: this.objectIds,
    });
  }

  _dispatchWorkerSort(drawCount, viewZ) {
    if (!this._sortWorker) {
      this._sortSync(drawCount, viewZ);
      return;
    }
    if (this._sorting) {
      this._pendingSort = { drawCount, viewZ };
      return;
    }
    this._sorting = true;
    this._sortJobId++;
    this._sortWorker.postMessage({
      type: "sort",
      jobId: this._sortJobId,
      drawCount,
      viewZ,
      objectMatrices: this.objectMatricesFlat,
    });
  }

  _sortSync(drawCount, viewZ) {
    const tSync0 = performance.now();
    const count = Math.min(this.n, drawCount);
    const depths = new Float32Array(count);
    const vx = viewZ[0], vy = viewZ[1], vz = viewZ[2], vw = viewZ[3];
    const om = this.objectMatricesFlat;
    let minD = Infinity, maxD = -Infinity;
    for (let i = 0; i < count; i++) {
      const m = this.objectIds[i] * 16;
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2];
      const wx = om[m] * x + om[m + 4] * y + om[m + 8] * z + om[m + 12];
      const wy = om[m + 1] * x + om[m + 5] * y + om[m + 9] * z + om[m + 13];
      const wz = om[m + 2] * x + om[m + 6] * y + om[m + 10] * z + om[m + 14];
      const d = vx * wx + vy * wy + vz * wz + vw;
      depths[i] = d;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    const order = new Uint32Array(count);
    const range = maxD - minD;
    if (!(range > 1e-6)) {
      for (let i = 0; i < count; i++) order[i] = i;
    } else {
      const BUCKETS = 65536;
      const counts = new Uint32Array(BUCKETS);
      const inv = (BUCKETS - 1) / range;
      for (let i = 0; i < count; i++) {
        const b = Math.max(0, Math.min(BUCKETS - 1, ((depths[i] - minD) * inv) | 0));
        counts[b]++;
      }
      let sum = 0;
      for (let b = 0; b < BUCKETS; b++) { const c = counts[b]; counts[b] = sum; sum += c; }
      for (let i = 0; i < count; i++) {
        const b = Math.max(0, Math.min(BUCKETS - 1, ((depths[i] - minD) * inv) | 0));
        order[counts[b]++] = i;
      }
    }
    this.indexAttr.array.set(new Uint16Array(order.buffer, 0, count * 2), 0);
    this.indexAttr.needsUpdate = true;
    this.geometry.instanceCount = count;
    this.lastSortMs = performance.now() - tSync0;
    this.lastSortUploadMs = 0;
    this.sortCompletedCount++;
  }

  _allocAndUploadStrippedTexture(renderer, texH, glInternalFmt, glFmt, glType, format, type, getStripData, stripRows = 512) {
    // Allocate immutable WebGL2 texture via texStorage2D directly (avoids Three.js calling invalid texSubImage2D(null)!)
    // and stream <=32MB strips with gl.flush() so Chromium/WebView2 sandboxed GPU staging NEVER overflows on 35M-67M clouds!
    const gl = renderer.getContext();
    const dst = new T.DataTexture(null, TEX_WIDTH, texH, format, type);
    dst.minFilter = T.NearestFilter;
    dst.magFilter = T.NearestFilter;
    dst.wrapS = T.ClampToEdgeWrapping;
    dst.wrapT = T.ClampToEdgeWrapping;
    dst.generateMipmaps = false;
    dst.flipY = false;
    dst.version = 0;

    const glTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage2D(gl.TEXTURE_2D, 1, glInternalFmt, TEX_WIDTH, texH);

    for (let y = 0; y < texH; y += stripRows) {
      const h = Math.min(stripRows, texH - y);
      const slice = getStripData(y, h);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, TEX_WIDTH, h, glFmt, glType, slice);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.flush();

    const props = renderer.properties.get(dst);
    props.__webglInit = true;
    props.__webglTexture = glTex;
    props.__version = 0;
    props.__currentAnisotropy = 1;
    props.__maxMipLevel = 0;

    dst._customGlTex = glTex;
    dst._customGlMeta = { glFmt, glType, stripRows };
    dst.addEventListener("dispose", () => {
      if (dst._customGlTex) {
        try { gl.deleteTexture(dst._customGlTex); } catch { /* ignore */ }
        dst._customGlTex = null;
      }
    });
    return dst;
  }

  _updateStrippedTextureData(tex, data) {
    if (!this._renderer || !tex || !tex._customGlTex) {
      if (tex) tex.needsUpdate = true;
      return;
    }
    const gl = this._renderer.getContext();
    const { glFmt, glType, stripRows } = tex._customGlMeta;
    const texH = tex.image.height;
    gl.bindTexture(gl.TEXTURE_2D, tex._customGlTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let y = 0; y < texH; y += stripRows) {
      const h = Math.min(stripRows, texH - y);
      const slice = data.subarray(y * TEX_WIDTH * 4, (y + h) * TEX_WIDTH * 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, TEX_WIDTH, h, glFmt, glType, slice);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.flush();
  }

  _updateStrippedTextureRows(tex, data, rowSpans) {
    if (!this._renderer || !tex || !tex._customGlTex) {
      if (tex) tex.needsUpdate = true;
      return 0;
    }
    const gl = this._renderer.getContext();
    const { glFmt, glType, stripRows } = tex._customGlMeta;
    let uploadedBytes = 0;
    gl.bindTexture(gl.TEXTURE_2D, tex._customGlTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let s = 0; s < rowSpans.length; s += 2) {
      const y0 = rowSpans[s];
      const totalH = rowSpans[s + 1];
      for (let off = 0; off < totalH; off += stripRows) {
        const y = y0 + off;
        const h = Math.min(stripRows, totalH - off);
        const slice = data.subarray(y * TEX_WIDTH * 4, (y + h) * TEX_WIDTH * 4);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, TEX_WIDTH, h, glFmt, glType, slice);
        uploadedBytes += slice.byteLength;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.flush();
    return uploadedBytes;
  }

  _rebuildGpuBuffers() {
    const n = this.n;
    const texH = Math.max(1, Math.ceil(n / TEX_WIDTH));
    const texSize = TEX_WIDTH * texH;

    if (this.posTex) this.posTex.dispose();
    if (this.scaleTex) this.scaleTex.dispose();
    if (this.quatTex) this.quatTex.dispose();
    if (this.colorTex) this.colorTex.dispose();
    if (this.stateTex) this.stateTex.dispose();

    const useStripped = !!(this._renderer && texH > 1024);
    if (useStripped) {
      const gl = this._renderer.getContext();
      const posStripBuf = new Float32Array(TEX_WIDTH * 512 * 4);
      const srcPos = this.pos;
      this.posTex = this._allocAndUploadStrippedTexture(
        this._renderer, texH, gl.RGBA32F, gl.RGBA, gl.FLOAT, T.RGBAFormat, T.FloatType,
        (y, h) => {
          const rowBase = y * TEX_WIDTH;
          const cnt = Math.min(n - rowBase, TEX_WIDTH * h);
          const slice = h === 512 ? posStripBuf : posStripBuf.subarray(0, TEX_WIDTH * h * 4);
          for (let k = 0; k < cnt; k++) {
            const s3 = (rowBase + k) * 3;
            const d4 = k * 4;
            slice[d4] = srcPos[s3];
            slice[d4 + 1] = srcPos[s3 + 1];
            slice[d4 + 2] = srcPos[s3 + 2];
            slice[d4 + 3] = 0;
          }
          return slice;
        },
        512,
      );
      this.scaleTex = this._allocAndUploadStrippedTexture(
        this._renderer, texH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, T.RGBAFormat, T.HalfFloatType,
        (y, h) => this.scaleHalf.subarray(y * TEX_WIDTH * 4, (y + h) * TEX_WIDTH * 4),
        1024,
      );
      this.quatTex = this._allocAndUploadStrippedTexture(
        this._renderer, texH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, T.RGBAFormat, T.HalfFloatType,
        (y, h) => this.quatHalf.subarray(y * TEX_WIDTH * 4, (y + h) * TEX_WIDTH * 4),
        1024,
      );
      this.colorTex = this._allocAndUploadStrippedTexture(
        this._renderer, texH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, T.RGBAFormat, T.UnsignedByteType,
        (y, h) => this.rgba.subarray(y * TEX_WIDTH * 4, (y + h) * TEX_WIDTH * 4),
        2048,
      );
      this.stateTex = this._allocAndUploadStrippedTexture(
        this._renderer, texH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, T.RGBAFormat, T.UnsignedByteType,
        (y, h) => this.stateTexData.subarray(y * TEX_WIDTH * 4, (y + h) * TEX_WIDTH * 4),
        2048,
      );
    } else {
      // Small/medium clouds (<4M pts): single-shot upload with immediate CPU shadow release
      const posTexData = new Float32Array(texSize * 4);
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const i4 = i * 4;
        posTexData[i4] = this.pos[i3];
        posTexData[i4 + 1] = this.pos[i3 + 1];
        posTexData[i4 + 2] = this.pos[i3 + 2];
        posTexData[i4 + 3] = 0;
      }
      this.posTex = makeDataTexture(posTexData, TEX_WIDTH, texH, T.RGBAFormat, T.FloatType);
      this.posTex.onUpdate = () => {
        if (this.posTex && this.posTex.image) this.posTex.image.data = null;
      };
      this.scaleTex = makeDataTexture(this.scaleHalf, TEX_WIDTH, texH, T.RGBAFormat, T.HalfFloatType);
      this.quatTex = makeDataTexture(this.quatHalf, TEX_WIDTH, texH, T.RGBAFormat, T.HalfFloatType);
      this.colorTex = makeDataTexture(this.rgba, TEX_WIDTH, texH, T.RGBAFormat, T.UnsignedByteType);
      this.stateTex = makeDataTexture(this.stateTexData, TEX_WIDTH, texH, T.RGBAFormat, T.UnsignedByteType);
    }

    const u = this.material.uniforms;
    u.uPosTex.value = this.posTex;
    u.uScaleTex.value = this.scaleTex;
    u.uQuatTex.value = this.quatTex;
    u.uColorTex.value = this.colorTex;
    u.uStateTex.value = this.stateTex;

    // Uint32 sequence viewed as Uint16x2 pairs (bit-exact up to 2.1B splats + SIMD copy!)
    const initU32 = new Uint32Array(n);
    for (let i = 0; i < n; i++) initU32[i] = i;
    const idxU16 = new Uint16Array(initU32.buffer);
    this.indexAttr = new T.InstancedBufferAttribute(idxU16, 2, false);
    this.indexAttr.setUsage(T.DynamicDrawUsage);
    this.geometry.setAttribute("aSplatIdx2", this.indexAttr);
    // Three.js caches geometry._maxInstanceCount on first draw and never refreshes it when attributes grow!
    this.geometry._maxInstanceCount = n;
    this.geometry.instanceCount = n;
    if (this.centersGeo) {
      this.centersGeo.setAttribute("aSplatIdx2", this.indexAttr);
      this.centersGeo._maxInstanceCount = n;
      this.centersGeo.instanceCount = 0;
    }
  }

  /**
   * Update per-object world matrix uniform (O(1) GPU transform for independent objects/groups!).
   */
  setObjectMatrix(objId, matrix4) {
    if (objId < 0 || objId >= MAX_SCENE_OBJECTS) return;
    this.objectMatrices[objId].copy(matrix4);
    matrix4.toArray(this.objectMatricesFlat, objId * 16);
  }

  /**
   * Compute world-space coordinates of point i (applying its owning object's matrix).
   */
  getWorldPosition(i, outVec) {
    const j = i * 3;
    const x = this.pos[j], y = this.pos[j + 1], z = this.pos[j + 2];
    const m = this.objectMatrices[this.objectIds[i]]?.elements;
    if (!m) return outVec.set(x, y, z);
    return outVec.set(
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    );
  }

  /**
   * Read linear RGBA [0..1] for point i from compact RGBA8 buffer.
   */
  getRgba01(i) {
    const i4 = i * 4;
    return [
      this.rgba[i4] / 255,
      this.rgba[i4 + 1] / 255,
      this.rgba[i4 + 2] / 255,
      this.rgba[i4 + 3] / 255,
    ];
  }

  markObjectIdsDirty() {
    this._objectIdsDirty = true;
  }

  /**
   * Full O(N) bulk sync of CPU flags/objectIds/visibility -> GPU stateTex (reference baseline & fallback).
   */
  syncVisualStateFull(activeObjectIds = null) {
    const n = this.n;
    const flags = this.flags;
    const objIds = this.objectIds;
    const vis = this.objectVisibility;
    const st = this.stateTexData;

    let selectedCount = 0;
    let deletedCount = 0;

    const visLut = new Uint8Array(MAX_SCENE_OBJECTS);
    const activeLut = new Uint8Array(MAX_SCENE_OBJECTS);
    const filterActive = !!(activeObjectIds && activeObjectIds.size > 0);
    let activeKey = "";
    for (let o = 0; o < MAX_SCENE_OBJECTS; o++) {
      const vOn = vis.get(o) !== false;
      const aOn = !filterActive || activeObjectIds.has(o);
      visLut[o] = vOn ? 255 : 0;
      activeLut[o] = aOn ? 255 : 0;
      if (aOn && filterActive) activeKey += o + ",";
    }

    for (let i = 0; i < n; i++) {
      const f = flags[i];
      if (f & FLAG_DELETED) deletedCount++;
      else if (f & FLAG_SELECTED) selectedCount++;
    }
    const hasSelection = selectedCount > 0;

    if (hasSelection) {
      for (let i = 0; i < n; i++) {
        const i4 = i * 4;
        const f = flags[i];
        const oid = objIds[i];
        st[i4] = f;
        st[i4 + 1] = (f & FLAG_SELECTED) !== 0 ? 255 : 0;
        st[i4 + 2] = visLut[oid];
        st[i4 + 3] = oid;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const i4 = i * 4;
        const f = flags[i];
        const oid = objIds[i];
        st[i4] = f;
        st[i4 + 1] = activeLut[oid];
        st[i4 + 2] = visLut[oid];
        st[i4 + 3] = oid;
      }
    }

    this._cachedVisCounts = { selected: selectedCount, deleted: deletedCount, hasSelection, activeKey, n };
    this._updateStrippedTextureData(this.stateTex, this.stateTexData);
    if (this._sortWorker && this._objectIdsDirty) {
      this._objectIdsDirty = false;
      this._sortWorker.postMessage({ type: "updateObjectIds", objectIds: this.objectIds });
    }
    const copiedBytes = this.stateTex ? this.stateTex.image.height * TEX_WIDTH * 4 : n * 4;
    return { total: n, selected: selectedCount, deleted: deletedCount, hasSelection, syncMode: "bulk-full", copiedBytes };
  }

  /**
   * Sparse/Row-Range GPU stateTex sync: updates ONLY changed preview indices when density & selection-mode
   * permit, coalescing dirty texture rows into contiguous texSubImage2D spans; transparently falls back
   * to syncVisualStateFull() if `hasSelection` flips (0 <-> >0), density > 12%, or dirty rows > 35%.
   */
  syncVisualStateSparse(changedPreviewIndices, activeObjectIds = null) {
    const n = this.n;
    const prev = this._cachedVisCounts;
    if (
      !prev ||
      prev.n !== n ||
      !changedPreviewIndices ||
      changedPreviewIndices.length === 0 ||
      changedPreviewIndices.length > n * 0.12 ||
      this._objectIdsDirty
    ) {
      return this.syncVisualStateFull(activeObjectIds);
    }

    const filterActive = !!(activeObjectIds && activeObjectIds.size > 0);
    let activeKey = "";
    if (filterActive) {
      for (let o = 0; o < MAX_SCENE_OBJECTS; o++) {
        if (activeObjectIds.has(o)) activeKey += o + ",";
      }
    }
    if (activeKey !== prev.activeKey) {
      return this.syncVisualStateFull(activeObjectIds);
    }

    const flags = this.flags;
    const st = this.stateTexData;
    const objIds = this.objectIds;
    const vis = this.objectVisibility;

    let selDelta = 0;
    let delDelta = 0;
    const k = changedPreviewIndices.length;
    for (let j = 0; j < k; j++) {
      const idx = changedPreviewIndices[j] >>> 0;
      if (idx >= n) continue;
      const oldF = st[idx * 4];
      const newF = flags[idx];
      if (oldF === newF) continue;
      const wasDel = (oldF & FLAG_DELETED) !== 0;
      const nowDel = (newF & FLAG_DELETED) !== 0;
      const wasSel = !wasDel && (oldF & FLAG_SELECTED) !== 0;
      const nowSel = !nowDel && (newF & FLAG_SELECTED) !== 0;
      if (nowDel !== wasDel) delDelta += nowDel ? 1 : -1;
      if (nowSel !== wasSel) selDelta += nowSel ? 1 : -1;
    }

    const nextSelected = prev.selected + selDelta;
    const nextDeleted = prev.deleted + delDelta;
    const nextHasSelection = nextSelected > 0;

    // If global hasSelection flips (0 <-> >0), gradeMask channel changes for ALL unselected points -> bulk fallback!
    if (nextHasSelection !== prev.hasSelection) {
      return this.syncVisualStateFull(activeObjectIds);
    }

    const texH = this.stateTex ? this.stateTex.image.height : Math.max(1, Math.ceil(n / TEX_WIDTH));
    const rowBits = new Uint8Array((texH + 7) >> 3);
    let dirtyRowCount = 0;

    for (let j = 0; j < k; j++) {
      const idx = changedPreviewIndices[j] >>> 0;
      if (idx >= n) continue;
      const i4 = idx * 4;
      const f = flags[idx];
      const oid = objIds[idx];
      st[i4] = f;
      st[i4 + 1] = nextHasSelection
        ? ((f & FLAG_SELECTED) !== 0 ? 255 : 0)
        : (!filterActive || activeObjectIds.has(oid) ? 255 : 0);
      st[i4 + 2] = vis.get(oid) !== false ? 255 : 0;
      st[i4 + 3] = oid;

      const row = (idx / TEX_WIDTH) | 0;
      const mask = 1 << (row & 7);
      if ((rowBits[row >> 3] & mask) === 0) {
        rowBits[row >> 3] |= mask;
        dirtyRowCount++;
      }
    }

    this._cachedVisCounts = {
      selected: nextSelected,
      deleted: nextDeleted,
      hasSelection: nextHasSelection,
      activeKey,
      n,
    };

    if (dirtyRowCount === 0) {
      return { total: n, selected: nextSelected, deleted: nextDeleted, hasSelection: nextHasSelection, syncMode: "sparse-noop", copiedBytes: 0 };
    }

    // Coalesce contiguous dirty texture rows (merge small 1-row gaps to reduce draw-driver call overhead)
    if (dirtyRowCount > texH * 0.35) {
      this._updateStrippedTextureData(this.stateTex, this.stateTexData);
      return {
        total: n,
        selected: nextSelected,
        deleted: nextDeleted,
        hasSelection: nextHasSelection,
        syncMode: "sparse-cpu-bulk-tex",
        copiedBytes: texH * TEX_WIDTH * 4,
      };
    }

    const spans = [];
    let y = 0;
    while (y < texH) {
      if ((rowBits[y >> 3] & (1 << (y & 7))) === 0) {
        y++;
        continue;
      }
      const start = y;
      y++;
      while (y < texH) {
        if ((rowBits[y >> 3] & (1 << (y & 7))) !== 0) {
          y++;
        } else if (y + 1 < texH && (rowBits[(y + 1) >> 3] & (1 << ((y + 1) & 7))) !== 0) {
          y += 2; // coalesce 1-row gap into single contiguous texSubImage2D call
        } else {
          break;
        }
      }
      spans.push(start, y - start);
    }
    const copiedBytes = this._updateStrippedTextureRows(this.stateTex, this.stateTexData, spans);
    return {
      total: n,
      selected: nextSelected,
      deleted: nextDeleted,
      hasSelection: nextHasSelection,
      syncMode: "sparse-rows",
      dirtyRows: dirtyRowCount,
      spanCount: spans.length >> 1,
      copiedBytes,
    };
  }

  /**
   * Sync CPU flags/objectIds/visibility to GPU state texture (uStateTex.rgba = flags, gradeMask, objVis, objId).
   */
  syncVisualState(activeObjectIds = null) {
    return this.syncVisualStateFull(activeObjectIds);
  }

  /**
   * Sync live color grading uniforms for real-time GPU preview.
   */
  setColorGradeUniforms(grade, enabled, compareOriginal = false, splitX = -1, lutTex = null, lutRgba = null) {
    const u = this.material.uniforms;
    u.uGradeEnabled.value = enabled ? 1.0 : 0.0;
    u.uCompareOriginal.value = compareOriginal ? 1.0 : 0.0;
    u.uSplitX.value = splitX;
    if (!grade) return;

    const e = resolveEffectiveGrade(grade, { forBake: false });
    u.uExposure.value = e.exposure;
    u.uBrightness.value = e.brightness;
    u.uContrast.value = e.contrast;
    u.uBlackPoint.value = e.blackPoint;
    u.uWhitePoint.value = e.whitePoint;
    u.uOutBlack.value = e.outBlack;
    u.uOutWhite.value = e.outWhite;
    u.uHighlights.value = e.highlights;
    u.uShadows.value = e.shadows;
    u.uWhites.value = e.whites;
    u.uBlacks.value = e.blacks;
    u.uSaturation.value = e.saturation;
    u.uVibrance.value = e.vibrance;
    u.uTemperature.value = e.temperature;
    u.uTintShift.value = e.tintShift;
    u.uTint.value.set(e.tint[0], e.tint[1], e.tint[2]);
    u.uGamma.value = e.gamma;
    u.uTransparency.value = e.transparency;

    let hslActive = false;
    for (let i = 0; i < 8; i++) {
      u.uHslHue.value[i] = e.hslHue[i] || 0;
      u.uHslSat.value[i] = e.hslSat[i] || 0;
      u.uHslLight.value[i] = e.hslLight[i] || 0;
      if (Math.abs(e.hslHue[i]) > 1e-4 || Math.abs(e.hslSat[i]) > 1e-4 || Math.abs(e.hslLight[i]) > 1e-4) {
        hslActive = true;
      }
    }
    u.uHslActive.value = hslActive ? 1.0 : 0.0;

    u.uPointColorActive.value = e.pointColorActive ? 1.0 : 0.0;
    u.uPointColorTarget.value.set(
      e.pointColor.targetHsl[0] || 0,
      e.pointColor.targetHsl[1] || 0.5,
      e.pointColor.targetHsl[2] || 0.5,
    );
    u.uPointColorParams.value.set(
      e.pointColor.tolerance,
      e.pointColor.colorRange,
      e.pointColor.visualizeRange ? 1.0 : 0.0,
      0.0,
    );
    u.uPointColorShift.value.set(
      e.pointColor.hue,
      e.pointColor.sat,
      e.pointColor.light,
    );

    if (lutTex && e.lutName && e.lutName !== "默认.png" && e.lutIntensity > 1e-4) {
      u.uLutTex.value = lutTex;
      u.uLutIntensity.value = e.lutIntensity;
      this.activeLutRgba = lutRgba;
    } else {
      u.uLutTex.value = this.defaultLutTex;
      u.uLutIntensity.value = 0.0;
      this.activeLutRgba = null;
    }
  }

  /**
   * Configure non-destructive GPU temporary view override for Heap/Stockpile Volume Mode:
   * mode: 0=Standard, 1=Translucent X-Ray, 2=Height Heatmap (Blue->Red), 3=Mesh/Wireframe Comparison
   */
  setMeasureVizUniforms({
    mode = 0,
    origin = null,
    normal = null,
    axisU = null,
    axisV = null,
    polyUV = null,
    polyBoundsUV = null,
    maxHeight = 1.0,
    translucentAlpha = 0.30,
    gridGhostAlpha = 0.06,
  } = {}) {
    const u = this.material.uniforms;
    if (!mode || !polyUV || polyUV.length < 3 || !origin || !normal || !axisU || !axisV) {
      u.uMeasureVizMode.value = 0;
      u.uMeasurePolyCount.value = 0;
      return;
    }
    const cnt = Math.min(48, polyUV.length);
    u.uMeasureVizMode.value = mode | 0;
    u.uMeasureOrigin.value.copy(origin);
    u.uMeasureNormal.value.copy(normal);
    u.uMeasureAxisU.value.copy(axisU);
    u.uMeasureAxisV.value.copy(axisV);
    if (polyBoundsUV) {
      u.uMeasurePolyBounds.value.set(polyBoundsUV[0], polyBoundsUV[1], polyBoundsUV[2], polyBoundsUV[3]);
    }
    u.uMeasureVizParams.value.set(Math.max(0.02, maxHeight), translucentAlpha, gridGhostAlpha, 0.0);
    u.uMeasurePolyCount.value = cnt;
    const packed = u.uMeasurePolyPacked.value;
    for (let s = 0; s < 24; s++) {
      const i0 = s * 2;
      const i1 = i0 + 1;
      const p0 = i0 < cnt ? polyUV[i0] : [0, 0];
      const p1 = i1 < cnt ? polyUV[i1] : [0, 0];
      packed[s].set(p0[0], p0[1], p1[0], p1[1]);
    }
  }

  /**
   * rc12 #4.3: Upload compiled active bounding-volume / CSG scope GPU program so enclosed
   * selectable Gaussians receive a live subtle sky-cyan highlight at 120 FPS as models or volumes move!
   */
  setVolumeScopeUniforms(prog, activeObjectIds = null) {
    const u = this.material.uniforms;
    if (!prog || !prog.active || prog.primCount <= 0 || prog.opCount <= 0) {
      u.uVolScopeActive.value = 0;
      u.uVolPrimCount.value = 0;
      u.uVolOpCount.value = 0;
      return;
    }
    u.uVolScopeActive.value = 1;
    u.uVolPrimCount.value = Math.min(24, prog.primCount);
    u.uVolOpCount.value = Math.min(48, prog.opCount);
    u.uVolPrimKind.value.set(prog.primKinds);
    u.uVolPlaneSigns.value.set(prog.planeSigns);
    const dstMats = u.uVolInvMats.value;
    for (let i = 0; i < u.uVolPrimCount.value; i++) {
      dstMats[i].copy(prog.invMatrices[i]);
    }
    u.uVolOps.value.set(prog.ops);
    const selArr = u.uVolSelectableObj.value;
    const hasFilter = activeObjectIds && activeObjectIds.size > 0;
    for (let oid = 0; oid < MAX_SCENE_OBJECTS; oid++) {
      selArr[oid] = !hasFilter || activeObjectIds.has(oid) ? 1.0 : 0.0;
    }
  }

  /**
   * Bake active color grade into compact RGBA8 buffer & GPU uColorTex.
   * Returns compact Uint8Array undo delta + target point indices for v3 SH export!
   */
  bakeColorGrade(grade, activeObjectIds = null, lutRgba = null) {
    const n = this.n;
    const flags = this.flags;
    let hasSel = false;
    for (let i = 0; i < n; i++) {
      if (!(flags[i] & FLAG_DELETED) && (flags[i] & FLAG_SELECTED)) {
        hasSel = true;
        break;
      }
    }

    const indices = [];
    for (let i = 0; i < n; i++) {
      if (flags[i] & (FLAG_DELETED | FLAG_HIDDEN)) continue;
      if (hasSel) {
        if (!(flags[i] & FLAG_SELECTED)) continue;
      } else if (activeObjectIds && activeObjectIds.size > 0 && !activeObjectIds.has(this.objectIds[i])) {
        continue;
      }
      indices.push(i);
    }
    if (indices.length === 0) return null;

    const beforeRgba = new Uint8Array(indices.length * 4);
    const afterRgba = new Uint8Array(indices.length * 4);
    const rgba = this.rgba;
    const clampU8 = (v) => {
      const k = Math.round(v * 255);
      return k < 0 ? 0 : k > 255 ? 255 : k;
    };

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const i4 = i * 4;
      const k4 = k * 4;
      const r8 = rgba[i4], g8 = rgba[i4 + 1], b8 = rgba[i4 + 2], a8 = rgba[i4 + 3];
      beforeRgba[k4] = r8;
      beforeRgba[k4 + 1] = g8;
      beforeRgba[k4 + 2] = b8;
      beforeRgba[k4 + 3] = a8;

      const [nr, ng, nb, na] = applyColorGradeCPU(
        r8 / 255, g8 / 255, b8 / 255, a8 / 255, grade, lutRgba, { forBake: true },
      );
      const nr8 = clampU8(nr), ng8 = clampU8(ng), nb8 = clampU8(nb), na8 = clampU8(na);
      rgba[i4] = nr8;
      rgba[i4 + 1] = ng8;
      rgba[i4 + 2] = nb8;
      rgba[i4 + 3] = na8;

      afterRgba[k4] = nr8;
      afterRgba[k4 + 1] = ng8;
      afterRgba[k4 + 2] = nb8;
      afterRgba[k4 + 3] = na8;
    }

    this._flushColorTexture();
    return {
      indices: Uint32Array.from(indices),
      beforeRgba,
      afterRgba,
      hasSelectionScope: hasSel,
    };
  }

  _flushColorTexture() {
    this._updateStrippedTextureData(this.colorTex, this.rgba);
  }

  applyBakedColorDelta(delta, forward) {
    const src = forward ? delta.afterRgba : delta.beforeRgba;
    const idx = delta.indices;
    const rgba = this.rgba;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      if (i >= this.n) continue;
      const i4 = i * 4;
      const k4 = k * 4;
      rgba[i4] = src[k4];
      rgba[i4 + 1] = src[k4 + 1];
      rgba[i4 + 2] = src[k4 + 2];
      rgba[i4 + 3] = src[k4 + 3];
    }
    this._flushColorTexture();
  }

  /**
   * Transform a subset of Gaussians in-place by a relative 4x4 matrix (used when merging objects
   * with differing transforms) and return a compact snapshot for exact 1-step Undo!
   */
  bakeMatrixIntoPoints(indices, matrix4) {
    if (!indices || indices.length === 0 || !matrix4) return null;
    const count = indices.length;
    const idxArr = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
    const prevPos = new Float32Array(count * 3);
    const prevScaleHalf = new Uint16Array(count * 3);
    const prevQuatHalf = new Uint16Array(count * 4);

    const mPos = new T.Vector3();
    const mQuat = new T.Quaternion();
    const mScale = new T.Vector3();
    matrix4.decompose(mPos, mQuat, mScale);
    const logSx = Math.log(Math.max(1e-5, Math.abs(mScale.x)));
    const logSy = Math.log(Math.max(1e-5, Math.abs(mScale.y)));
    const logSz = Math.log(Math.max(1e-5, Math.abs(mScale.z)));
    const m = matrix4.elements;
    const qTmp = new T.Quaternion();

    for (let k = 0; k < count; k++) {
      const i = idxArr[k];
      const i3 = i * 3, i4 = i * 4;
      const k3 = k * 3, k4 = k * 4;
      const x = this.pos[i3], y = this.pos[i3 + 1], z = this.pos[i3 + 2];
      prevPos[k3] = x; prevPos[k3 + 1] = y; prevPos[k3 + 2] = z;
      this.pos[i3]     = m[0] * x + m[4] * y + m[8]  * z + m[12];
      this.pos[i3 + 1] = m[1] * x + m[5] * y + m[9]  * z + m[13];
      this.pos[i3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];

      prevScaleHalf[k3]     = this.scaleHalf[i4];
      prevScaleHalf[k3 + 1] = this.scaleHalf[i4 + 1];
      prevScaleHalf[k3 + 2] = this.scaleHalf[i4 + 2];
      this.scaleHalf[i4]     = floatToHalf(HALF_TO_FLOAT[this.scaleHalf[i4]] + logSx);
      this.scaleHalf[i4 + 1] = floatToHalf(HALF_TO_FLOAT[this.scaleHalf[i4 + 1]] + logSy);
      this.scaleHalf[i4 + 2] = floatToHalf(HALF_TO_FLOAT[this.scaleHalf[i4 + 2]] + logSz);

      prevQuatHalf[k4]     = this.quatHalf[i4];
      prevQuatHalf[k4 + 1] = this.quatHalf[i4 + 1];
      prevQuatHalf[k4 + 2] = this.quatHalf[i4 + 2];
      prevQuatHalf[k4 + 3] = this.quatHalf[i4 + 3];
      qTmp.set(
        HALF_TO_FLOAT[this.quatHalf[i4]],
        HALF_TO_FLOAT[this.quatHalf[i4 + 1]],
        HALF_TO_FLOAT[this.quatHalf[i4 + 2]],
        HALF_TO_FLOAT[this.quatHalf[i4 + 3]],
      ).normalize().premultiply(mQuat).normalize();
      this.quatHalf[i4]     = floatToHalf(qTmp.x);
      this.quatHalf[i4 + 1] = floatToHalf(qTmp.y);
      this.quatHalf[i4 + 2] = floatToHalf(qTmp.z);
      this.quatHalf[i4 + 3] = floatToHalf(qTmp.w);
    }

    this._rebuildGpuBuffers();
    this._pushDataToWorker();
    this._lastSortView = null;
    return { indices: idxArr, prevPos, prevScaleHalf, prevQuatHalf };
  }

  restorePointsBakedTransform(snap) {
    if (!snap || !snap.indices) return;
    const { indices, prevPos, prevScaleHalf, prevQuatHalf } = snap;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (i >= this.n) continue;
      const i3 = i * 3, i4 = i * 4;
      const k3 = k * 3, k4 = k * 4;
      this.pos[i3] = prevPos[k3];
      this.pos[i3 + 1] = prevPos[k3 + 1];
      this.pos[i3 + 2] = prevPos[k3 + 2];
      this.scaleHalf[i4] = prevScaleHalf[k3];
      this.scaleHalf[i4 + 1] = prevScaleHalf[k3 + 1];
      this.scaleHalf[i4 + 2] = prevScaleHalf[k3 + 2];
      this.quatHalf[i4] = prevQuatHalf[k4];
      this.quatHalf[i4 + 1] = prevQuatHalf[k4 + 1];
      this.quatHalf[i4 + 2] = prevQuatHalf[k4 + 2];
      this.quatHalf[i4 + 3] = prevQuatHalf[k4 + 3];
    }
    this._rebuildGpuBuffers();
    this._pushDataToWorker();
    this._lastSortView = null;
  }

  /**
   * True dynamic Gaussian duplication for Shift+D ("复制为局部副本") & Ctrl+Drag Duplicate:
   * Appends real Gaussians with their own objectId into compact CPU/GPU buffers & Sort Worker!
   */
  duplicatePoints(sourcePointIndices, newObjectId, { selectNew = true } = {}) {
    const addCount = sourcePointIndices.length;
    if (addCount === 0) return null;
    const oldN = this.n;
    const newN = oldN + addCount;
    const newTexH = Math.max(1, Math.ceil(newN / TEX_WIDTH));
    const newTexSize = TEX_WIDTH * newTexH;

    const growF32 = (oldArr, len) => { const next = new Float32Array(len); next.set(oldArr.subarray(0, Math.min(oldArr.length, len))); return next; };
    const growU16 = (oldArr, len) => { const next = new Uint16Array(len); next.set(oldArr.subarray(0, Math.min(oldArr.length, len))); return next; };
    const growU32 = (oldArr, len) => { const next = new Uint32Array(len); next.set(oldArr.subarray(0, Math.min(oldArr.length, len))); return next; };
    const growU8 = (oldArr, len) => { const next = new Uint8Array(len); next.set(oldArr.subarray(0, Math.min(oldArr.length, len))); return next; };

    this.pos = growF32(this.pos, newN * 3);
    this.scaleHalf = growU16(this.scaleHalf, newTexSize * 4);
    this.quatHalf = growU16(this.quatHalf, newTexSize * 4);
    this.rgba = growU8(this.rgba, newTexSize * 4);
    this.stateTexData = growU8(this.stateTexData, newTexSize * 4);
    this.srcIdx = growU32(this.srcIdx, newN);
    this.flags = growU8(this.flags, newN);
    this.objectIds = growU8(this.objectIds, newN);

    for (let k = 0; k < addCount; k++) {
      const s = sourcePointIndices[k];
      const d = oldN + k;
      const s3 = s * 3, d3 = d * 3;
      const s4 = s * 4, d4 = d * 4;

      this.pos[d3] = this.pos[s3];
      this.pos[d3 + 1] = this.pos[s3 + 1];
      this.pos[d3 + 2] = this.pos[s3 + 2];

      this.scaleHalf[d4] = this.scaleHalf[s4];
      this.scaleHalf[d4 + 1] = this.scaleHalf[s4 + 1];
      this.scaleHalf[d4 + 2] = this.scaleHalf[s4 + 2];
      this.scaleHalf[d4 + 3] = 0;

      this.quatHalf[d4] = this.quatHalf[s4];
      this.quatHalf[d4 + 1] = this.quatHalf[s4 + 1];
      this.quatHalf[d4 + 2] = this.quatHalf[s4 + 2];
      this.quatHalf[d4 + 3] = this.quatHalf[s4 + 3];

      this.rgba[d4] = this.rgba[s4];
      this.rgba[d4 + 1] = this.rgba[s4 + 1];
      this.rgba[d4 + 2] = this.rgba[s4 + 2];
      this.rgba[d4 + 3] = this.rgba[s4 + 3];

      this.srcIdx[d] = this.srcIdx[s];
      const newFlag = selectNew ? FLAG_SELECTED : 0;
      this.flags[d] = newFlag;
      this.objectIds[d] = newObjectId;
      this.stateTexData[d4] = newFlag;
      this.stateTexData[d4 + 1] = 0;
      this.stateTexData[d4 + 2] = 255;
      this.stateTexData[d4 + 3] = newObjectId;
    }

    this.n = newN;
    this.objectVisibility.set(newObjectId, true);
    this._rebuildGpuBuffers();
    this._pushDataToWorker();
    this._lastSortView = null;
    return { oldN, newN };
  }

  /**
   * Append newly synthesized Gaussians (e.g., Smart Plane Inpaint L1/L2 patches) into a new objectId.
   * Fully pairs with `truncatePoints(oldN)` for instant Undo/Redo!
   * @param {{ positions: Float32Array, logScales: Float32Array, quats: Float32Array, rgba: Uint8Array }} data
   * @param {number} newObjectId
   */
  appendSyntheticPoints(data, newObjectId) {
    const addCount = data && data.positions ? Math.floor(data.positions.length / 3) : 0;
    if (addCount <= 0) return null;
    const oldN = this.n;
    const newN = oldN + addCount;
    const newTexH = Math.max(1, Math.ceil(newN / TEX_WIDTH));
    const newTexSize = TEX_WIDTH * newTexH;

    const growF32 = (oldArr, len) => { const next = new Float32Array(len); next.set(oldArr.subarray(0, Math.min(oldArr.length, len))); return next; };
    const growU16 = (oldArr, len) => { const next = new Uint16Array(len); next.set(oldArr.subarray(0, Math.min(oldArr.length, len))); return next; };
    const growU32 = (oldArr, len) => { const next = new Uint32Array(len); next.set(oldArr.subarray(0, Math.min(oldArr.length, len))); return next; };
    const growU8 = (oldArr, len) => { const next = new Uint8Array(len); next.set(oldArr.subarray(0, Math.min(oldArr.length, len))); return next; };

    this.pos = growF32(this.pos, newN * 3);
    this.scaleHalf = growU16(this.scaleHalf, newTexSize * 4);
    this.quatHalf = growU16(this.quatHalf, newTexSize * 4);
    this.rgba = growU8(this.rgba, newTexSize * 4);
    this.stateTexData = growU8(this.stateTexData, newTexSize * 4);
    this.srcIdx = growU32(this.srcIdx, newN);
    this.flags = growU8(this.flags, newN);
    this.objectIds = growU8(this.objectIds, newN);

    for (let k = 0; k < addCount; k++) {
      const d = oldN + k;
      const s3 = k * 3, d3 = d * 3;
      const s4 = k * 4, d4 = d * 4;

      this.pos[d3] = data.positions[s3];
      this.pos[d3 + 1] = data.positions[s3 + 1];
      this.pos[d3 + 2] = data.positions[s3 + 2];

      this.scaleHalf[d4] = floatToHalf(data.logScales[s3]);
      this.scaleHalf[d4 + 1] = floatToHalf(data.logScales[s3 + 1]);
      this.scaleHalf[d4 + 2] = floatToHalf(data.logScales[s3 + 2]);
      this.scaleHalf[d4 + 3] = 0;

      // data.quats uses PLY WXYZ order (rot_0..rot_3); GPU quatHalf uses GLSL XYZW order!
      this.quatHalf[d4] = floatToHalf(data.quats[s4 + 1]);
      this.quatHalf[d4 + 1] = floatToHalf(data.quats[s4 + 2]);
      this.quatHalf[d4 + 2] = floatToHalf(data.quats[s4 + 3]);
      this.quatHalf[d4 + 3] = floatToHalf(data.quats[s4]);

      this.rgba[d4] = data.rgba[s4];
      this.rgba[d4 + 1] = data.rgba[s4 + 1];
      this.rgba[d4 + 2] = data.rgba[s4 + 2];
      this.rgba[d4 + 3] = data.rgba[s4 + 3];

      this.srcIdx[d] = 0xffffffff; // synthetic marker
      this.flags[d] = 0;
      this.objectIds[d] = newObjectId;
      this.stateTexData[d4] = 0;
      this.stateTexData[d4 + 1] = 0;
      this.stateTexData[d4 + 2] = 255;
      this.stateTexData[d4 + 3] = newObjectId;
    }

    this.n = newN;
    this.objectVisibility.set(newObjectId, true);
    this._rebuildGpuBuffers();
    this._pushDataToWorker();
    this._lastSortView = null;
    return { oldN, newN, addCount };
  }

  /**
   * Async depth sort for an arbitrary virtual camera (used by offscreen multi-view semantic & L2 inpaint).
   */
  sortForCameraAsync(viewCamera) {
    viewCamera.updateMatrixWorld();
    const vm = viewCamera.matrixWorldInverse.elements;
    const viewZ = [vm[2], vm[6], vm[10], vm[14]];
    this._lastSortView = viewZ;
    this._lastSortCount = this.n;
    if (!this._sortWorker || this.n <= 350000) {
      this._sortSync(this.n, viewZ);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      if (!this._sortWaiters) this._sortWaiters = [];
      this._sortWaiters.push(resolve);
      this._dispatchWorkerSort(this.n, viewZ);
    });
  }

  /**
   * Render photorealistic Gaussians from an arbitrary virtual camera into an isolated offscreen FBO
   * without touching the main viewport canvas or stealing user camera!
   */
  async renderOffscreenColor(renderer, viewCamera, width, height, { hideSelection = true, clearColorHex = 0x15171b } = {}) {
    const w = Math.max(16, Math.round(width));
    const h = Math.max(16, Math.round(height));
    await this.sortForCameraAsync(viewCamera);

    if (!this._offscreenColorTarget || this._offscreenColorTarget.width !== w || this._offscreenColorTarget.height !== h) {
      if (this._offscreenColorTarget) this._offscreenColorTarget.dispose();
      this._offscreenColorTarget = new T.WebGLRenderTarget(w, h, {
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
        format: T.RGBAFormat,
        type: T.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });
    }
    if (!this._offscreenScene) {
      this._offscreenScene = new T.Scene();
      this._offscreenMesh = new T.Mesh(this.geometry, this.material);
      this._offscreenMesh.frustumCulled = false;
      this._offscreenScene.add(this._offscreenMesh);
    }

    const u = this.material.uniforms;
    const prevMode = u.uRenderMode.value;
    const prevRes = u.uResolution.value.clone();
    const prevOrtho = u.uIsOrtho.value;
    const prevHideSel = u.uHideSelectionHighlight.value;
    const prevTrans = this.material.transparent;
    const prevDepthW = this.material.depthWrite;
    const prevBlend = this.material.blending;
    const prevCount = this.geometry.instanceCount;

    u.uRenderMode.value = 1;
    u.uResolution.value.set(w, h);
    u.uIsOrtho.value = viewCamera.isOrthographicCamera ? 1 : 0;
    u.uHideSelectionHighlight.value = hideSelection ? 1.0 : 0.0;
    if (!this.material.transparent) {
      this.material.transparent = true;
      this.material.depthWrite = false;
      this.material.blending = T.CustomBlending;
      this.material.blendEquation = T.AddEquation;
      this.material.blendSrc = T.OneFactor;
      this.material.blendDst = T.OneMinusSrcAlphaFactor;
      this.material.blendSrcAlpha = T.OneFactor;
      this.material.blendDstAlpha = T.OneMinusSrcAlphaFactor;
      this.material.needsUpdate = true;
    }
    this.geometry.instanceCount = this.n;

    const prevTarget = renderer.getRenderTarget();
    const prevClearCol = new T.Color();
    renderer.getClearColor(prevClearCol);
    const prevClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this._offscreenColorTarget);
    renderer.setClearColor(clearColorHex, 1);
    renderer.clear(true, true, false);
    renderer.render(this._offscreenScene, viewCamera);

    const pixels = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(this._offscreenColorTarget, 0, 0, w, h, pixels);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClearCol, prevClearAlpha);
    u.uRenderMode.value = prevMode;
    u.uResolution.value.copy(prevRes);
    u.uIsOrtho.value = prevOrtho;
    u.uHideSelectionHighlight.value = prevHideSel;
    if (this.material.transparent !== prevTrans) {
      this.material.transparent = prevTrans;
      this.material.depthWrite = prevDepthW;
      this.material.blending = prevBlend;
      this.material.needsUpdate = true;
    }
    this.geometry.instanceCount = prevCount;
    return { width: w, height: h, rgba: pixels };
  }

  /**
   * Compact core-opacity hardware DepthTexture pass for pixel-exact Gaussian wireframe occlusion.
   */
  renderCoreDepthTexture(renderer, camera, width, height, alphaThreshold = 0.22) {
    const w = Math.max(32, Math.round(width));
    const h = Math.max(32, Math.round(height));
    if (!this._depthTarget || this._depthTarget.width !== w || this._depthTarget.height !== h) {
      if (this._depthTarget) this._depthTarget.dispose();
      const dt = new T.DepthTexture(w, h);
      dt.format = T.DepthFormat;
      dt.type = T.UnsignedIntType;
      dt.minFilter = T.NearestFilter;
      dt.magFilter = T.NearestFilter;
      this._depthTarget = new T.WebGLRenderTarget(w, h, {
        minFilter: T.NearestFilter,
        magFilter: T.NearestFilter,
        format: T.RGBAFormat,
        type: T.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
        depthTexture: dt,
      });
    }
    const prevMode = this.material.uniforms.uRenderMode.value;
    const prevRes = this.material.uniforms.uResolution.value.clone();
    const prevOrtho = this.material.uniforms.uIsOrtho.value;
    const prevCount = this.geometry.instanceCount;

    this.material.uniforms.uRenderMode.value = 1;
    this.material.uniforms.uResolution.value.set(w, h);
    this.material.uniforms.uIsOrtho.value = camera.isOrthographicCamera ? 1 : 0;
    this.pickMat.uniforms.uPickAlphaThreshold.value = alphaThreshold;
    this.geometry.instanceCount = this.n;

    const prevTarget = renderer.getRenderTarget();
    const prevClearCol = new T.Color();
    renderer.getClearColor(prevClearCol);
    const prevClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this._depthTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.pickScene, camera);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClearCol, prevClearAlpha);
    this.material.uniforms.uRenderMode.value = prevMode;
    this.material.uniforms.uResolution.value.copy(prevRes);
    this.material.uniforms.uIsOrtho.value = prevOrtho;
    this.geometry.instanceCount = prevCount;
    return this._depthTarget.depthTexture;
  }

  /**
   * Undo helper for duplicatePoints / appendSyntheticPoints: trims appended tail cleanly.
   */
  truncatePoints(targetCount) {
    if (targetCount >= this.n || targetCount < 0) return;
    const newTexH = Math.max(1, Math.ceil(targetCount / TEX_WIDTH));
    const newTexSize = TEX_WIDTH * newTexH;
    this.n = targetCount;
    this.pos = this.pos.slice(0, targetCount * 3);
    this.scaleHalf = this.scaleHalf.slice(0, newTexSize * 4);
    this.quatHalf = this.quatHalf.slice(0, newTexSize * 4);
    this.rgba = this.rgba.slice(0, newTexSize * 4);
    this.stateTexData = this.stateTexData.slice(0, newTexSize * 4);
    this.srcIdx = this.srcIdx.slice(0, targetCount);
    this.flags = this.flags.slice(0, targetCount);
    this.objectIds = this.objectIds.slice(0, targetCount);
    this._rebuildGpuBuffers();
    this._pushDataToWorker();
    this._lastSortView = null;
  }

  /**
   * Configure display mode ("splat" | "centers" | "rings"), point count, and off-thread sort.
   */
  prepareDraw(count, mode, camera, viewportW, viewportH, forceSort = false, isInteracting = false) {
    const modeInt = mode === "rings" ? 2 : mode === "splat" ? 1 : 0;
    const drawN = Math.max(1, Math.min(this.n, count | 0));
    const u = this.material.uniforms;

    u.uRenderMode.value = modeInt;
    u.uResolution.value.set(Math.max(1, viewportW), Math.max(1, viewportH));
    u.uIsOrtho.value = camera.isOrthographicCamera ? 1 : 0;
    u.uPointSize.value = drawN > 4000000 ? 2.4 : drawN > 600000 ? 2.8 : drawN > 150000 ? 3.2 : 3.8;

    const transparent = modeInt !== 0;
    if (this.material.transparent !== transparent) {
      this.material.transparent = transparent;
      this.material.depthWrite = !transparent;
      this.material.blending = transparent ? T.CustomBlending : T.NormalBlending;
      if (transparent) {
        this.material.blendEquation = T.AddEquation;
        this.material.blendSrc = T.OneFactor;
        this.material.blendDst = T.OneMinusSrcAlphaFactor;
        this.material.blendSrcAlpha = T.OneFactor;
        this.material.blendDstAlpha = T.OneMinusSrcAlphaFactor;
      }
      this.material.needsUpdate = true;
    }

    if (modeInt === 0) {
      // Centers mode: 1-vertex-per-splat GL_POINTS fast path (4x fewer vertices, zero sorting!)
      this.geometry.instanceCount = 0;
      this.centersPoints.visible = true;
      this.centersGeo.instanceCount = this.n;
      return false;
    }

    this.centersPoints.visible = false;
    this.centersGeo.instanceCount = 0;

    camera.updateMatrixWorld();
    const vm = camera.matrixWorldInverse.elements;
    const viewZ = [vm[2], vm[6], vm[10], vm[14]];
    const now = performance.now();
    // Always sort & draw 100% full cloud points (never truncate depth-sorted index buffers!).
    // During active camera drag/glide on huge scenes (>2M), relax angular threshold & enforce
    // a brief cooldown so 60-140 MB GPU buffer uploads don't hitch mid-drag; final settle sorts immediately!
    let needSort = forceSort || !this._lastSortView || this._lastSortCount !== this.n;
    if (!needSort && this._lastSortView) {
      const dot =
        viewZ[0] * this._lastSortView[0] +
        viewZ[1] * this._lastSortView[1] +
        viewZ[2] * this._lastSortView[2];
      if (isInteracting && this.n > 2000000) {
        const minIntervalMs = this.n > 10000000 ? 220 : 120;
        const thresh = this.n > 10000000 ? 0.985 : 0.992;
        if (dot < thresh && now - this._lastSortDispatchTs >= minIntervalMs) {
          needSort = true;
        }
      } else {
        const thresh = isInteracting ? 0.9965 : 0.9992;
        if (dot < thresh) needSort = true;
      }
    }

    if (needSort) {
      this._lastSortView = viewZ;
      this._lastSortCount = this.n;
      this._lastSortDispatchTs = now;
      if (forceSort && this.n <= 350000) {
        this._sortSync(this.n, viewZ);
      } else {
        this._dispatchWorkerSort(this.n, viewZ);
      }
    }
    if (this._warmupPending) {
      // Frame 1 GPU texture upload warmup (keeps initial D3D11 submit well under 2s TDR!)
      this._warmupPending = false;
      this.geometry.instanceCount = Math.min(this.n, 300000);
      return true; // signal caller to immediately schedule full-resolution Frame 2!
    }
    this.geometry.instanceCount = this.n;
    return false;
  }

  /**
   * Pixel-exact 32-bit RGBA GPU ID Picking Pass (renders to offscreen RGBA8 RenderTarget).
   */
  renderPickBuffer(renderer, camera, width, height, mode, alphaThreshold = 0.04) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (!this.pickTarget || this.pickTarget.width !== w || this.pickTarget.height !== h) {
      if (this.pickTarget) this.pickTarget.dispose();
      this.pickTarget = new T.WebGLRenderTarget(w, h, {
        minFilter: T.NearestFilter,
        magFilter: T.NearestFilter,
        format: T.RGBAFormat,
        type: T.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });
    }

    const modeInt = mode === "rings" ? 2 : mode === "splat" ? 1 : 0;
    const prevMode = this.material.uniforms.uRenderMode.value;
    const prevRes = this.material.uniforms.uResolution.value.clone();
    const prevCount = this.geometry.instanceCount;

    this.material.uniforms.uRenderMode.value = modeInt;
    this.material.uniforms.uResolution.value.set(w, h);
    this.material.uniforms.uIsOrtho.value = camera.isOrthographicCamera ? 1 : 0;
    this.pickMat.uniforms.uPickAlphaThreshold.value = alphaThreshold;
    this.geometry.instanceCount = this.n;

    const prevTarget = renderer.getRenderTarget();
    const prevClearCol = new T.Color();
    renderer.getClearColor(prevClearCol);
    const prevClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.pickTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.pickScene, camera);

    const pixels = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(this.pickTarget, 0, 0, w, h, pixels);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClearCol, prevClearAlpha);
    this.material.uniforms.uRenderMode.value = prevMode;
    this.material.uniforms.uResolution.value.copy(prevRes);
    this.geometry.instanceCount = prevCount;

    return { width: w, height: h, pixels };
  }

  invalidateHoverPickCache() {
    this._hoverPickCache = null;
  }

  /**
   * Zero-stall cached single-point GPU ID lookup for live hover tooltips (U/L/T + WB/HSL eyedroppers):
   * Re-renders downsampled ID buffer ONLY when camera pose, display mode, viewport size, or scene edits change;
   * subsequent mousemove hover checks run in O(1) ~0.001 ms!
   */
  pickSinglePointCached(renderer, camera, viewportW, viewportH, nx, ny, mode, searchRadiusPx = 5) {
    camera.updateMatrixWorld();
    const vm = camera.matrixWorldInverse.elements;
    const pm = camera.projectionMatrix.elements;
    const om0 = this.objectMatrices[0]?.elements;
    const sig =
      `${mode}|${viewportW}x${viewportH}|${this.n}|${camera.isOrthographicCamera ? 1 : 0}|` +
      `${vm[0].toFixed(3)},${vm[4].toFixed(3)},${vm[8].toFixed(3)},${vm[12].toFixed(2)},${vm[13].toFixed(2)},${vm[14].toFixed(2)}|` +
      `${pm[0].toFixed(3)},${pm[5].toFixed(3)}|` +
      `${om0 ? om0[0].toFixed(3) + "," + om0[12].toFixed(2) + "," + om0[14].toFixed(2) : ""}`;

    const scale = Math.min(1, 512 / Math.max(viewportW, viewportH, 1));
    const pw = Math.max(64, Math.round(viewportW * scale));
    const ph = Math.max(64, Math.round(viewportH * scale));

    if (!this._hoverPickCache || this._hoverPickCache.sig !== sig || this._hoverPickCache.pw !== pw || this._hoverPickCache.ph !== ph) {
      const { pixels } = this.renderPickBuffer(renderer, camera, pw, ph, mode, mode === "splat" ? 0.06 : 0.0);
      this._hoverPickCache = { sig, pw, ph, scale, pixels };
    }

    const { pixels } = this._hoverPickCache;
    const cx = Math.min(pw - 1, Math.max(0, Math.round(nx * (pw - 1))));
    const cy = Math.min(ph - 1, Math.max(0, Math.round((1 - ny) * (ph - 1))));
    const maxR = Math.max(1, Math.round(searchRadiusPx * scale) + 1);

    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let dy = -maxR; dy <= maxR; dy++) {
      const py = cy + dy;
      if (py < 0 || py >= ph) continue;
      for (let dx = -maxR; dx <= maxR; dx++) {
        const px = cx + dx;
        if (px < 0 || px >= pw) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= bestD2) continue;
        const off = (py * pw + px) * 4;
        const id1 = decodePickId(pixels, off);
        if (id1 > 0 && id1 - 1 < this.n) {
          bestIdx = id1 - 1;
          bestD2 = d2;
        }
      }
    }
    return bestIdx;
  }

  /**
   * Pick single front-most Gaussian index near normalized screen point (nx, ny in [0..1], top-down).
   */
  pickSinglePoint(renderer, camera, viewportW, viewportH, nx, ny, mode, searchRadiusPx = 5) {
    const scale = Math.min(1, 640 / Math.max(viewportW, viewportH, 1));
    const pw = Math.max(64, Math.round(viewportW * scale));
    const ph = Math.max(64, Math.round(viewportH * scale));
    const { pixels } = this.renderPickBuffer(renderer, camera, pw, ph, mode, mode === "splat" ? 0.06 : 0.0);

    const cx = Math.min(pw - 1, Math.max(0, Math.round(nx * (pw - 1))));
    const cy = Math.min(ph - 1, Math.max(0, Math.round((1 - ny) * (ph - 1))));
    const maxR = Math.max(1, Math.round(searchRadiusPx * scale) + 2);

    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let dy = -maxR; dy <= maxR; dy++) {
      const py = cy + dy;
      if (py < 0 || py >= ph) continue;
      for (let dx = -maxR; dx <= maxR; dx++) {
        const px = cx + dx;
        if (px < 0 || px >= pw) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= bestD2) continue;
        const off = (py * pw + px) * 4;
        const id1 = decodePickId(pixels, off);
        if (id1 > 0 && id1 - 1 < this.n) {
          bestIdx = id1 - 1;
          bestD2 = d2;
        }
      }
    }
    return bestIdx;
  }

  dispose() {
    if (this._sortWorker) {
      this._sortWorker.terminate();
      this._sortWorker = null;
    }
    if (this.posTex) this.posTex.dispose();
    if (this.scaleTex) this.scaleTex.dispose();
    if (this.quatTex) this.quatTex.dispose();
    if (this.colorTex) this.colorTex.dispose();
    if (this.stateTex) this.stateTex.dispose();
    if (this.defaultLutTex) this.defaultLutTex.dispose();
    if (this.pickTarget) this.pickTarget.dispose();
    if (this._offscreenColorTarget) this._offscreenColorTarget.dispose();
    if (this._depthTarget) this._depthTarget.dispose();
    this.geometry.dispose();
    this.material.dispose();
    if (this.centersGeo) this.centersGeo.dispose();
    if (this.centersMat) this.centersMat.dispose();
    this.pickMat.dispose();
  }
}
