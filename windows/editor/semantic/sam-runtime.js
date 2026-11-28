/**
 * @module semantic/sam-runtime
 * @description Unified ONNX Runtime WebGPU / WASM inference layer for SAM 2.1 (Tiny/Small FP16)
 * and MobileSAM with native Box Prompt support and 256-D masked semantic prototype extraction (M08).
 *
 * Design Contract (模块设计思路与架构档案.md M08):
 * - Supports both `sam21-hf` (onnx-community SAM 2.1 with `input_boxes` + `object_score_logits` +
 *   `image_embeddings.0/1/2`) and `mobilesam` (SAM1 schema with box corners `point_labels=[2,3]`).
 * - Prefers WebGPU; transparently falls back to WASM and exposes `activeBackend` so UI can warn user.
 * - Extracts L2-normalized 256-D pooled embedding directly from encoder output (`<0.1ms`, 0 extra model!)
 *   for cross-view semantic similarity verification (catching behind-wall / wrong-object views).
 */

import { t } from "../i18n.js";

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
const SAM_INPUT_SIZE = 1024;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))));
}

/**
 * Convert WebGL bottom-up (or canvas top-down) RGBA pixels into NCHW float32 [1,3,1024,1024].
 */
export function prepareSamInputTensor(rgba, srcW, srcH, bottomUp = true) {
  const S = SAM_INPUT_SIZE;
  const plane = S * S;
  const tensor = new Float32Array(3 * plane);
  const scaleX = srcW / S;
  const scaleY = srcH / S;
  for (let y = 0; y < S; y++) {
    const syTop = Math.min(srcH - 1, Math.floor((y + 0.5) * scaleY));
    const srcRow = (bottomUp ? (srcH - 1 - syTop) : syTop) * srcW;
    const dstRow = y * S;
    for (let x = 0; x < S; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * scaleX));
      const p = (srcRow + sx) * 4;
      const dst = dstRow + x;
      tensor[dst] = (rgba[p] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
      tensor[plane + dst] = (rgba[p + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
      tensor[2 * plane + dst] = (rgba[p + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    }
  }
  return tensor;
}

/**
 * Extract L2-normalized 256-D semantic prototype by masked average pooling over [1, 256, 64, 64] feature map.
 * Costs < 0.1 ms, zero extra network inference!
 */
export function extractMaskedPrototype(embedTensor, maskTopDown, maskW, maskH) {
  if (!embedTensor || !embedTensor.data || !embedTensor.dims) return null;
  const dims = embedTensor.dims;
  const C = dims[1] || 256;
  const fh = dims[2] || 64;
  const fw = dims[3] || 64;
  const data = embedTensor.data;
  const proto = new Float32Array(C);
  const plane = fh * fw;
  let count = 0;

  for (let fy = 0; fy < fh; fy++) {
    const my = Math.min(maskH - 1, Math.floor(((fy + 0.5) / fh) * maskH));
    for (let fx = 0; fx < fw; fx++) {
      const mx = Math.min(maskW - 1, Math.floor(((fx + 0.5) / fw) * maskW));
      if (!maskTopDown[my * maskW + mx]) continue;
      const pix = fy * fw + fx;
      for (let c = 0; c < C; c++) {
        proto[c] += data[c * plane + pix];
      }
      count++;
    }
  }
  if (count === 0) return null;
  let normSq = 0;
  for (let c = 0; c < C; c++) {
    proto[c] /= count;
    normSq += proto[c] * proto[c];
  }
  const invNorm = normSq > 1e-12 ? 1 / Math.sqrt(normSq) : 0;
  for (let c = 0; c < C; c++) proto[c] *= invNorm;
  return proto;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function projectLogitsToMask(logits, mw, mh, dstW, dstH) {
  const maskTopDown = new Uint8Array(dstW * dstH);
  const confidenceTopDown = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const my = Math.max(0, Math.min(mh - 1, ((y + 0.5) / dstH) * mh - 0.5));
    const y0 = Math.floor(my);
    const y1 = Math.min(mh - 1, y0 + 1);
    const fy = my - y0;
    for (let x = 0; x < dstW; x++) {
      const mx = Math.max(0, Math.min(mw - 1, ((x + 0.5) / dstW) * mw - 0.5));
      const x0 = Math.floor(mx);
      const x1 = Math.min(mw - 1, x0 + 1);
      const fx = mx - x0;
      const top = logits[y0 * mw + x0] * (1 - fx) + logits[y0 * mw + x1] * fx;
      const bot = logits[y1 * mw + x0] * (1 - fx) + logits[y1 * mw + x1] * fx;
      const v = top * (1 - fy) + bot * fy;
      const idx = y * dstW + x;
      if (v > 0) maskTopDown[idx] = 1;
      confidenceTopDown[idx] = Math.round(255 * sigmoid(v));
    }
  }
  return { maskTopDown, confidenceTopDown };
}

export class SamRuntime {
  constructor() {
    this._ort = null;
    this._encoder = null;
    this._decoder = null;
    this.loaded = false;
    this.activeBackend = "unloaded"; // "unloaded" | "webgpu" | "wasm" | "fallback"
    this.activeModelId = null;
    this.activeSchema = null;
    this._modelsPayload = null;
    this._cachedEmbed = null;
    this._cachedKey = "";
    this._loadPromise = null;
  }

  configureModels(payload) {
    const prevId = this.activeModelId;
    this._modelsPayload = payload || null;
    const nextId = payload?.activeSemanticModel || "sam21-tiny-fp16";
    if (this.loaded && prevId && prevId !== nextId) {
      // Model switched by user -> release old ONNX sessions immediately so next box loads new model!
      this.release().catch(() => {});
    }
  }

  getModelDescriptor(modelId = null) {
    const p = this._modelsPayload;
    if (!p || !Array.isArray(p.models)) return null;
    const targetId = modelId || p.activeSemanticModel || "sam21-tiny-fp16";
    return p.models.find((m) => m.id === targetId) || p.models.find((m) => m.id === "sam21-tiny-fp16") || null;
  }

  getStatusSummary() {
    const m = this.getModelDescriptor();
    const name = m ? m.displayName : "SAM 2.1 Hiera Tiny (FP16)";
    if (!this.loaded) return t("editor.semantic.samStandby", { name });
    if (this.activeBackend === "webgpu") return `${name} · WebGPU`;
    if (this.activeBackend === "wasm") return `${name} · CPU (WASM)`;
    return t("editor.semantic.samFallbackEngine");
  }

  async ensureLoaded(onStage = null, requestBundledExtractFn = null) {
    const targetModel = this.getModelDescriptor();
    const targetId = targetModel?.id || "sam21-tiny-fp16";
    if (this.loaded && this.activeModelId === targetId) {
      return this.activeBackend;
    }
    if (this._loadPromise) {
      return this._loadPromise;
    }
    this._loadPromise = this._doEnsureLoaded(targetId, targetModel, onStage, requestBundledExtractFn).finally(() => {
      this._loadPromise = null;
    });
    return this._loadPromise;
  }

  async _doEnsureLoaded(targetId, targetModel, onStage, requestBundledExtractFn) {
    if (this.loaded) await this.release();

    // If bundled SAM 2.1 or ORT isn't extracted yet, ask host to extract from EXE embedded zip!
    if (this._modelsPayload && (!this._modelsPayload.ortReady || (targetModel?.bundled && !targetModel.installed))) {
      if (typeof requestBundledExtractFn === "function") {
        if (onStage) onStage(t("editor.semantic.samExtractingBundled"));
        const updated = await requestBundledExtractFn();
        if (updated) this._modelsPayload = updated;
      }
    }

    const p = this._modelsPayload;
    let model = this.getModelDescriptor(targetId);
    if (model && !model.installed) {
      // If user selected an undownloaded model, fall back safely to built-in SAM 2.1 Tiny
      model = this.getModelDescriptor("sam21-tiny-fp16");
    }

    if (!p || !p.ortReady || !model || !model.installed) {
      this.activeBackend = "fallback";
      this.activeModelId = "fallback";
      this.activeSchema = "fallback";
      this.loaded = true;
      return this.activeBackend;
    }

    try {
      if (onStage) onStage(t("editor.semantic.samLoadingModel", { name: model.displayName }));
      if (!this._ort) {
        const ort = await import(/* @vite-ignore */ p.ortUrl);
        if (ort?.env?.wasm) {
          ort.env.wasm.wasmPaths = new URL(p.wasmBaseUrl, window.location.href).href;
          ort.env.wasm.numThreads = 1;
        }
        this._ort = ort;
      }
      const ort = this._ort;

      const buildOpts = (ep, extFileKey) => {
        const o = { executionProviders: [ep], graphOptimizationLevel: "all" };
        if (extFileKey && model.files[extFileKey]) {
          o.externalData = [{ path: extFileKey, data: model.files[extFileKey] }];
        }
        return o;
      };

      let encUrl = "";
      let decUrl = "";
      let encExt = null;
      let decExt = null;
      if (model.schema === "sam21-hf") {
        encUrl = model.files["vision_encoder_fp16.onnx"];
        encExt = "vision_encoder_fp16.onnx_data";
        decUrl = model.files["prompt_encoder_mask_decoder_fp16.onnx"];
        decExt = "prompt_encoder_mask_decoder_fp16.onnx_data";
      } else if (model.schema === "mobilesam") {
        encUrl = model.files["mobile_sam_image_encoder.onnx"];
        decUrl = model.files["sam_mask_decoder_multi.onnx"];
      } else {
        throw new Error(`Unsupported semantic schema: ${model.schema}`);
      }

      const tryEp = async (ep) => {
        const enc = await ort.InferenceSession.create(encUrl, buildOpts(ep, encExt));
        try {
          const dec = await ort.InferenceSession.create(decUrl, buildOpts(ep, decExt));
          return { enc, dec };
        } catch (err) {
          await enc.release();
          throw err;
        }
      };

      let sessions = null;
      let usedEp = "wasm";
      if ("gpu" in navigator) {
        try {
          sessions = await tryEp("webgpu");
          usedEp = "webgpu";
        } catch (err) {
          console.warn("[SamRuntime] WebGPU init failed, falling back to CPU WASM:", err);
          sessions = null;
        }
      }
      if (!sessions) {
        if (onStage) onStage(t("editor.semantic.samFallbackWasm"));
        sessions = await tryEp("wasm");
        usedEp = "wasm";
      }

      this._encoder = sessions.enc;
      this._decoder = sessions.dec;
      this.activeBackend = usedEp;
      this.activeModelId = model.id;
      this.activeSchema = model.schema;
      this.loaded = true;
      return usedEp;
    } catch (err) {
      console.warn("[SamRuntime] ONNX load failed, falling back to built-in mask:", err);
      await this.release();
      this.activeBackend = "fallback";
      this.activeModelId = "fallback";
      this.activeSchema = "fallback";
      this.loaded = true;
      return "fallback";
    }
  }

  _disposeCachedEmbed() {
    if (this._cachedEmbed) {
      for (const t of Object.values(this._cachedEmbed)) {
        try { t.dispose(); } catch { /* ignore */ }
      }
      this._cachedEmbed = null;
    }
    this._cachedKey = "";
  }

  async release() {
    this._disposeCachedEmbed();
    const tasks = [];
    if (this._encoder) tasks.push(this._encoder.release());
    if (this._decoder) tasks.push(this._decoder.release());
    this._encoder = null;
    this._decoder = null;
    if (tasks.length) await Promise.allSettled(tasks);
    this.loaded = false;
    this.activeBackend = "unloaded";
    this.activeModelId = null;
    this.activeSchema = null;
  }

  /**
   * Run encoder + box-prompt decoder on an RGBA frame.
   * @param {Uint8Array} rgba
   * @param {number} srcW
   * @param {number} srcH
   * @param {{ x0: number, y0: number, x1: number, y1: number }} boxNorm01 Top-down normalized [0..1]
   * @param {Object} [opts]
   * @returns {Promise<{ maskTopDown: Uint8Array, confidenceTopDown: Uint8Array, predictedIou: number, objectScore: number, prototype: Float32Array|null, width: number, height: number }>}
   */
  async segmentBox(rgba, srcW, srcH, boxNorm01, {
    bottomUp = true,
    outW = srcW,
    outH = srcH,
    auxPointsNorm01 = [],
    frameKey = "",
    referenceAreaRatio = 0,
  } = {}) {
    if (!this._encoder || !this._decoder) {
      return this._segmentBoxFallback(rgba, srcW, srcH, boxNorm01, bottomUp, outW, outH);
    }
    const ort = this._ort;
    const key = frameKey || `${srcW}x${srcH}:${rgba[0]}:${rgba[rgba.length >> 1]}:${rgba[rgba.length - 4]}`;
    if (!this._cachedEmbed || this._cachedKey !== key) {
      this._disposeCachedEmbed();
      const inputData = prepareSamInputTensor(rgba, srcW, srcH, bottomUp);
      const imgT = new ort.Tensor("float32", inputData, [1, 3, SAM_INPUT_SIZE, SAM_INPUT_SIZE]);
      try {
        const inName = this._encoder.inputNames[0];
        this._cachedEmbed = await this._encoder.run({ [inName]: imgT });
        this._cachedKey = key;
      } finally {
        imgT.dispose();
      }
    }

    const bx0 = Math.max(0, Math.min(SAM_INPUT_SIZE, boxNorm01.x0 * SAM_INPUT_SIZE));
    const by0 = Math.max(0, Math.min(SAM_INPUT_SIZE, boxNorm01.y0 * SAM_INPUT_SIZE));
    const bx1 = Math.max(0, Math.min(SAM_INPUT_SIZE, boxNorm01.x1 * SAM_INPUT_SIZE));
    const by1 = Math.max(0, Math.min(SAM_INPUT_SIZE, boxNorm01.y1 * SAM_INPUT_SIZE));

    const feeds = {};
    const temps = [];
    if (this.activeSchema === "sam21-hf") {
      feeds["image_embeddings.0"] = this._cachedEmbed["image_embeddings.0"];
      feeds["image_embeddings.1"] = this._cachedEmbed["image_embeddings.1"];
      feeds["image_embeddings.2"] = this._cachedEmbed["image_embeddings.2"];
      feeds.input_boxes = new ort.Tensor("float32", new Float32Array([bx0, by0, bx1, by1]), [1, 1, 4]);
      temps.push(feeds.input_boxes);

      const nPts = auxPointsNorm01.length;
      if (nPts > 0) {
        const pts = new Float32Array(nPts * 2);
        const lbls = new BigInt64Array(nPts);
        for (let i = 0; i < nPts; i++) {
          pts[i * 2] = auxPointsNorm01[i].x * SAM_INPUT_SIZE;
          pts[i * 2 + 1] = auxPointsNorm01[i].y * SAM_INPUT_SIZE;
          lbls[i] = 1n;
        }
        feeds.input_points = new ort.Tensor("float32", pts, [1, 1, nPts, 2]);
        feeds.input_labels = new ort.Tensor("int64", lbls, [1, 1, nPts]);
      } else {
        feeds.input_points = new ort.Tensor("float32", new Float32Array(0), [1, 1, 0, 2]);
        feeds.input_labels = new ort.Tensor("int64", new BigInt64Array(0), [1, 1, 0]);
      }
      temps.push(feeds.input_points, feeds.input_labels);
    } else {
      // MobileSAM / SAM1 decoder schema: box corners encoded as point_labels = [2, 3]
      const embKey = Object.keys(this._cachedEmbed)[0];
      const nPts = 2 + auxPointsNorm01.length;
      const pts = new Float32Array(nPts * 2);
      const lbls = new Float32Array(nPts);
      pts[0] = bx0; pts[1] = by0; lbls[0] = 2;
      pts[2] = bx1; pts[3] = by1; lbls[1] = 3;
      for (let i = 0; i < auxPointsNorm01.length; i++) {
        pts[(2 + i) * 2] = auxPointsNorm01[i].x * SAM_INPUT_SIZE;
        pts[(2 + i) * 2 + 1] = auxPointsNorm01[i].y * SAM_INPUT_SIZE;
        lbls[2 + i] = 1;
      }
      for (const name of this._decoder.inputNames) {
        if (name.includes("embed")) feeds[name] = this._cachedEmbed[embKey];
        else if (name === "point_coords") { feeds[name] = new ort.Tensor("float32", pts, [1, nPts, 2]); temps.push(feeds[name]); }
        else if (name === "point_labels") { feeds[name] = new ort.Tensor("float32", lbls, [1, nPts]); temps.push(feeds[name]); }
        else if (name === "mask_input") { feeds[name] = new ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]); temps.push(feeds[name]); }
        else if (name === "has_mask_input") { feeds[name] = new ort.Tensor("float32", new Float32Array([0]), [1]); temps.push(feeds[name]); }
        else if (name === "orig_im_size" || name === "img_size") { feeds[name] = new ort.Tensor("float32", new Float32Array([SAM_INPUT_SIZE, SAM_INPUT_SIZE]), [2]); temps.push(feeds[name]); }
      }
    }

    let out = null;
    try {
      out = await this._decoder.run(feeds);
      const maskT = out.pred_masks || out.masks || out.low_res_masks || out[this._decoder.outputNames[0]];
      const iouT = out.iou_scores || out.iou_predictions || out[this._decoder.outputNames[1]];
      const objT = out.object_score_logits || null;
      const dims = maskT.dims;
      const mh = dims[dims.length - 2];
      const mw = dims[dims.length - 1];
      const plane = mh * mw;
      const allLogits = maskT.data;
      const scores = iouT ? iouT.data : new Float32Array([0.8]);
      const numCand = Math.min(scores.length, Math.floor(allLogits.length / plane));

      // Rank SAM multimask candidates by IoU * box-containment (prevents loose boxes from spilling onto room walls/floor!)
      const mbx0 = Math.max(0, Math.floor((boxNorm01.x0 - 0.05) * mw));
      const mby0 = Math.max(0, Math.floor((boxNorm01.y0 - 0.05) * mh));
      const mbx1 = Math.min(mw - 1, Math.ceil((boxNorm01.x1 + 0.05) * mw));
      const mby1 = Math.min(mh - 1, Math.ceil((boxNorm01.y1 + 0.05) * mh));

      let bestK = 0;
      let bestScore = -Infinity;
      for (let k = 0; k < numCand; k++) {
        let pos = 0;
        let inBox = 0;
        const off = k * plane;
        for (let my = 0; my < mh; my++) {
          const yIn = my >= mby0 && my <= mby1;
          const rowOff = off + my * mw;
          for (let mx = 0; mx < mw; mx++) {
            if (allLogits[rowOff + mx] > 0) {
              pos++;
              if (yIn && mx >= mbx0 && mx <= mbx1) inBox++;
            }
          }
        }
        const ratio = pos / plane;
        if (referenceAreaRatio > 0 && (ratio < referenceAreaRatio * 0.14 || ratio > Math.min(0.75, referenceAreaRatio * 4.5))) {
          continue;
        }
        const inBoxFrac = pos > 0 ? inBox / pos : 0;
        const rankedScore = Number(scores[k] || 0) * (0.35 + 0.65 * inBoxFrac);
        if (rankedScore > bestScore) { bestScore = rankedScore; bestK = k; }
      }
      if (bestScore === -Infinity) {
        for (let k = 0; k < numCand; k++) {
          if (scores[k] > bestScore) { bestScore = scores[k]; bestK = k; }
        }
      }

      const bestLogits = allLogits.subarray(bestK * plane, (bestK + 1) * plane);
      const { maskTopDown, confidenceTopDown } = projectLogitsToMask(bestLogits, mw, mh, outW, outH);
      const mainEmb = this._cachedEmbed["image_embeddings.2"] || Object.values(this._cachedEmbed)[0];
      const prototype = extractMaskedPrototype(mainEmb, maskTopDown, outW, outH);
      const objectScore = objT && objT.data && objT.data.length > 0 ? sigmoid(objT.data[0]) : 0.95;

      return {
        maskTopDown,
        confidenceTopDown,
        predictedIou: Number(scores[bestK] || 0),
        objectScore,
        prototype,
        width: outW,
        height: outH,
      };
    } finally {
      for (const t of temps) { try { t.dispose(); } catch { /* ignore */ } }
      if (out) for (const t of Object.values(out)) { try { t.dispose(); } catch { /* ignore */ } }
    }
  }

  /**
   * Clean offline fallback (GrabCut-style center-vs-border color likelihood inside box)
   * used ONLY if ONNX models are completely unavailable in a stripped test harness.
   */
  _segmentBoxFallback(rgba, srcW, srcH, boxNorm01, bottomUp, outW, outH) {
    const maskTopDown = new Uint8Array(outW * outH);
    const confidenceTopDown = new Uint8Array(outW * outH);
    const x0 = Math.max(0, Math.floor(boxNorm01.x0 * outW));
    const y0 = Math.max(0, Math.floor(boxNorm01.y0 * outH));
    const x1 = Math.min(outW - 1, Math.ceil(boxNorm01.x1 * outW));
    const y1 = Math.min(outH - 1, Math.ceil(boxNorm01.y1 * outH));
    const cx = (x0 + x1) * 0.5;
    const cy = (y0 + y1) * 0.5;
    const rx = Math.max(1, (x1 - x0) * 0.5);
    const ry = Math.max(1, (y1 - y0) * 0.5);

    const sample = (x, y) => {
      const sx = Math.min(srcW - 1, Math.floor((x / outW) * srcW));
      const syTop = Math.min(srcH - 1, Math.floor((y / outH) * srcH));
      const sy = bottomUp ? (srcH - 1 - syTop) : syTop;
      const p = (sy * srcW + sx) * 4;
      return [rgba[p], rgba[p + 1], rgba[p + 2]];
    };

    // Estimate center foreground RGB vs box-border background RGB
    let fgR = 0, fgG = 0, fgB = 0, fgN = 0;
    let bgR = 0, bgG = 0, bgB = 0, bgN = 0;
    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        const r2 = dx * dx + dy * dy;
        const c = sample(x, y);
        if (r2 < 0.25) { fgR += c[0]; fgG += c[1]; fgB += c[2]; fgN++; }
        else if (r2 > 0.85) { bgR += c[0]; bgG += c[1]; bgB += c[2]; bgN++; }
      }
    }
    if (fgN > 0) { fgR /= fgN; fgG /= fgN; fgB /= fgN; }
    if (bgN > 0) { bgR /= bgN; bgG /= bgN; bgB /= bgN; }

    const proto = new Float32Array(3);
    proto[0] = fgR / 255; proto[1] = fgG / 255; proto[2] = fgB / 255;
    const pn = Math.hypot(proto[0], proto[1], proto[2]) || 1;
    proto[0] /= pn; proto[1] /= pn; proto[2] /= pn;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        const r2 = dx * dx + dy * dy;
        if (r2 > 1.0) continue;
        const c = sample(x, y);
        const dFg = Math.hypot(c[0] - fgR, c[1] - fgG, c[2] - fgB);
        const dBg = Math.hypot(c[0] - bgR, c[1] - bgG, c[2] - bgB);
        if (dFg <= dBg * 1.15 || r2 < 0.32) {
          const idx = y * outW + x;
          maskTopDown[idx] = 1;
          confidenceTopDown[idx] = Math.round(255 * Math.max(0.55, 1 - r2 * 0.4));
        }
      }
    }
    return { maskTopDown, confidenceTopDown, predictedIou: 0.75, objectScore: 0.9, prototype: proto, width: outW, height: outH };
  }
}
