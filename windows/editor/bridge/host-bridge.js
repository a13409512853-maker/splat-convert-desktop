// WebView2 Host IPC Bridge & SGC3/SGC2 Binary Buffer Parser.
import { uint8ToBase64 } from "../png-writer.js";

export function postHost(msg) {
  window.chrome?.webview?.postMessage(msg);
}

export function typedArrayToB64(arr) {
  return uint8ToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

export function b64ToUint8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Parse a binary SGC3 (SoA compact 30 B/pt) or legacy SGC2 (AoS 56 B/pt) buffer
 * into Cloud constructor input + total source point count.
 */
export function parseCloudBinaryBuffer(arrayBuffer, opts = {}) {
  const view = new DataView(arrayBuffer);
  const magic =
    arrayBuffer.byteLength >= 32
      ? String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
      : "";

  if (magic === "SGC3") {
    const totalSrc = view.getUint32(8, true);
    const loaded = view.getUint32(12, true);
    const hasIdx = view.getUint32(24, true) === 1;
    let off = 32;
    const pos = new Float32Array(arrayBuffer, off, loaded * 3);
    off += loaded * 12;
    const scalesHalf = new Uint16Array(arrayBuffer, off, loaded * 3);
    off += loaded * 6;
    if ((off & 3) !== 0) off += 4 - (off & 3);
    const quatsHalf = new Uint16Array(arrayBuffer, off, loaded * 4);
    off += loaded * 8;
    const rgba = new Uint8Array(arrayBuffer, off, loaded * 4);
    off += loaded * 4;
    const srcIdx = hasIdx ? new Uint32Array(arrayBuffer, off, loaded) : null;
    return {
      format: "SGC3",
      totalSourcePoints: totalSrc || opts.totalPoints || loaded,
      cloudInput: { count: loaded, pos, scalesHalf, quatsHalf, rgba, srcIdx },
      sourceIndices: null,
    };
  }

  if (magic === "SGC2") {
    const totalSrc = view.getUint32(8, true);
    const loaded = view.getUint32(12, true);
    const hasIdx = view.getUint32(24, true) === 1;
    const floatBytes = loaded * 14 * 4;
    const floats = new Float32Array(arrayBuffer, 32, loaded * 14);
    const srcIdx = hasIdx ? new Uint32Array(arrayBuffer, 32 + floatBytes, loaded) : null;
    return {
      format: "SGC2",
      totalSourcePoints: totalSrc || opts.totalPoints || loaded,
      cloudInput: floats,
      sourceIndices: srcIdx,
    };
  }

  const floats = new Float32Array(arrayBuffer);
  const loaded = Math.floor(floats.length / 14);
  return {
    format: "RAW_F32_14",
    totalSourcePoints: opts.totalPoints || loaded,
    cloudInput: floats,
    sourceIndices: null,
  };
}
