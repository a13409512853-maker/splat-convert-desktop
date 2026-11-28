/**
 * @module smart/lama-runtime
 * @description ONNX Runtime WebGPU / WASM runner for LaMa FP32 512x512 planar inpainting (M09).
 *
 * I/O Contract (Carve/LaMa-ONNX `lama_fp32.onnx`):
 * - `image`: float32[1, 3, 512, 512] RGB in [0, 1]
 * - `mask`:  float32[1, 1, 512, 512] binary (1.0 = hole to fill, 0.0 = valid context)
 * - output:  float32[1, 3, 512, 512] RGB in [0, 255] (auto-normalized if in [0, 1])
 */

import { t } from "../i18n.js";

export const LAMA_SIZE = 512;

export class LamaRuntime {
  constructor() {
    this._ort = null;
    this._session = null;
    this.loaded = false;
    this.activeBackend = "unloaded";
    this._modelsPayload = null;
  }

  configureModels(payload) {
    this._modelsPayload = payload || null;
  }

  isInstalled() {
    const m = this._getDescriptor();
    return !!(m && m.installed && this._modelsPayload?.ortReady);
  }

  _getDescriptor() {
    const p = this._modelsPayload;
    if (!p || !Array.isArray(p.models)) return null;
    return p.models.find((m) => m.id === "lama-fp32") || null;
  }

  async ensureLoaded(onStage = null, requestBundledExtractFn = null) {
    if (this.loaded && this._session) return this.activeBackend;
    if (this._modelsPayload && !this._modelsPayload.ortReady && typeof requestBundledExtractFn === "function") {
      if (onStage) onStage(t("editor.inpaint.stagePrepareOrt"));
      const updated = await requestBundledExtractFn();
      if (updated) this._modelsPayload = updated;
    }

    const p = this._modelsPayload;
    const desc = this._getDescriptor();
    if (!p || !p.ortReady || !desc || !desc.installed || !desc.files?.["lama_fp32.onnx"]) {
      return "missing";
    }

    try {
      if (onStage) onStage(t("editor.inpaint.stageLoadLama"));
      if (!this._ort) {
        const ort = await import(/* @vite-ignore */ p.ortUrl);
        if (ort?.env?.wasm) {
          ort.env.wasm.wasmPaths = new URL(p.wasmBaseUrl, window.location.href).href;
          ort.env.wasm.numThreads = 1;
        }
        this._ort = ort;
      }
      const ort = this._ort;
      const modelUrl = desc.files["lama_fp32.onnx"];
      let session = null;
      let usedEp = "wasm";
      if ("gpu" in navigator) {
        try {
          session = await ort.InferenceSession.create(modelUrl, {
            executionProviders: ["webgpu"],
            graphOptimizationLevel: "all",
          });
          usedEp = "webgpu";
        } catch (err) {
          console.warn("[LamaRuntime] WebGPU fallback to WASM:", err);
        }
      }
      if (!session) {
        if (onStage) onStage(t("editor.inpaint.stageLoadLamaWasm"));
        session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
        usedEp = "wasm";
      }
      this._session = session;
      this.activeBackend = usedEp;
      this.loaded = true;
      return usedEp;
    } catch (err) {
      console.warn("[LamaRuntime] Failed to load LaMa ONNX:", err);
      await this.release();
      return "error";
    }
  }

  /**
   * Run 512x512 LaMa inpainting.
   * @param {Uint8Array} rgba512 Top-down RGBA8 (512 * 512 * 4)
   * @param {Uint8Array} mask512 Top-down binary mask (512 * 512, >0 means hole)
   * @returns {Promise<Uint8Array>} Top-down repaired RGBA8 (512 * 512 * 4)
   */
  async inpaint(rgba512, mask512) {
    if (!this._session || !this._ort) throw new Error(t("editor.inpaint.errLamaNotLoaded"));
    const ort = this._ort;
    const S = LAMA_SIZE;
    const plane = S * S;
    const imgF32 = new Float32Array(3 * plane);
    const mskF32 = new Float32Array(plane);

    for (let i = 0; i < plane; i++) {
      const m = mask512[i] > 0 ? 1.0 : 0.0;
      mskF32[i] = m;
      const p = i * 4;
      // Zero-out hole pixels in input image so LaMa doesn't leak background void color
      const keep = 1.0 - m;
      imgF32[i] = (rgba512[p] / 255) * keep;
      imgF32[plane + i] = (rgba512[p + 1] / 255) * keep;
      imgF32[2 * plane + i] = (rgba512[p + 2] / 255) * keep;
    }

    const inImg = new ort.Tensor("float32", imgF32, [1, 3, S, S]);
    const inMsk = new ort.Tensor("float32", mskF32, [1, 1, S, S]);
    const imgName = this._session.inputNames.find((n) => n.toLowerCase().includes("img") || n.toLowerCase().includes("image")) || this._session.inputNames[0];
    const mskName = this._session.inputNames.find((n) => n.toLowerCase().includes("mask")) || this._session.inputNames[1];

    let out = null;
    try {
      out = await this._session.run({ [imgName]: inImg, [mskName]: inMsk });
      const outT = out[this._session.outputNames[0]];
      const od = outT.data;
      // Detect [0,1] vs [0,255] output scale automatically
      let maxVal = 0;
      for (let i = 0; i < Math.min(4096, od.length); i += 17) {
        if (od[i] > maxVal) maxVal = od[i];
      }
      const scale = maxVal <= 2.0 ? 255.0 : 1.0;

      const outRgba = new Uint8Array(plane * 4);
      for (let i = 0; i < plane; i++) {
        const p = i * 4;
        const r = Math.max(0, Math.min(255, Math.round(od[i] * scale)));
        const g = Math.max(0, Math.min(255, Math.round(od[plane + i] * scale)));
        const b = Math.max(0, Math.min(255, Math.round(od[2 * plane + i] * scale)));
        outRgba[p] = r;
        outRgba[p + 1] = g;
        outRgba[p + 2] = b;
        outRgba[p + 3] = 255;
      }
      return outRgba;
    } finally {
      inImg.dispose();
      inMsk.dispose();
      if (out) for (const t of Object.values(out)) { try { t.dispose(); } catch { /* ignore */ } }
    }
  }

  async release() {
    if (this._session) {
      try { await this._session.release(); } catch { /* ignore */ }
      this._session = null;
    }
    this.loaded = false;
    this.activeBackend = "unloaded";
  }
}
