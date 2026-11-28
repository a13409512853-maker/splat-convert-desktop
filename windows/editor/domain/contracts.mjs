/**
 * @module domain/contracts
 * @description Pure domain contracts, invariants, resource-ownership rules, coordinate/unit
 * guarantees, and error types for the native 3D Gaussian Splatting editing pipeline.
 *
 * ZERO DOM, ZERO WebGL, ZERO Three.js, ZERO PlayCanvas dependencies.
 * Can be imported and verified directly in headless Node.js.
 *
 * ============================================================================
 * ARCHITECTURAL INVARIANTS & OWNERSHIP CONTRACTS
 * ============================================================================
 * 1. Coordinate System & Units:
 *    - Right-handed +Y-up (`up = [0, 1, 0]`, ground plane `Y = 0`).
 *    - Native source units (typically meters), preserved 1:1 from source to lossless export.
 *    - UI angles are degrees; internal matrices are 16-element column-major Float64/Number arrays.
 *    - World-space 8-corner OBB validation tolerance: <= 1e-4 source units (Float32 GPU precision).
 *
 * 2. Point Identity & Index Ownership:
 *    - Every source point is globally identified by `(assetId, sourceIndex)` where
 *      `0 <= sourceIndex < asset.pointCount` is fixed to a specific source file version
 *      (`sha256`, `pointCount`, `orderingVersion`).
 *    - Preview backends MAY permute, block-shuffle, subsample, or concatenate buffers;
 *      therefore `previewIndex` is strictly backend-private and MUST NEVER be persisted into
 *      recipes or assumed equal to `sourceIndex`.
 *    - Source-pinned point edits (box-select/delete/sparse selection) MUST check source version
 *      identity before re-applying; reordered/modified source assets MUST NOT receive stale indices.
 *    - Parametric operations (bounding box/ellipsoid/cylinder/plane volumes) are re-evaluated
 *      dynamically from their parameters rather than frozen to stale point indices.
 *    - Scene-level camera tracks belong on the Scene/Project document (`cameraTrack`), NEVER
 *      as per-Gaussian vertex attributes.
 *
 * 3. Large Array Ownership & Disposal:
 *    - EditSession owns per-asset compact state (`Uint8Array(pointCount)` flags) and sparse
 *      command deltas (`Uint32Array` + `Uint8Array`); caller MUST invoke `session.dispose()`
 *      when closing a scene to release references.
 *    - IPreviewBackend owns GPU textures/buffers and its `previewIndex <-> (assetId, sourceIndex)`
 *      mapping tables; it NEVER mutates EditSession directly, only consumes read-only state via
 *      `syncFromSession()` and returns `PreviewPointRef[]` from pick queries; caller MUST invoke
 *      `backend.dispose()` to free GPU/CPU shadow buffers.
 *    - IBackgroundJob (host-scheduled) owns temporary staging folders, progress reporting,
 *      cancellation tokens, and atomic final publishing. On failure or cancellation, staging
 *      is cleaned up and the final destination file MUST NOT be created or overwritten with
 *      partial data. Source assets are strictly read-only.
 */

export const COORD_CONTRACT = Object.freeze({
  system: "y-up",
  matrixSpace: "source",
  handedness: "right-handed",
  upAxis: Object.freeze([0, 1, 0]),
  groundPlaneY: 0,
  cylinderLocalAxis: "y",
  knownSystems: Object.freeze(["y-up", "z-up"]),
  units: "source-native-meters",
  obbWorldCornerTolerance: 1e-4,
});

export const POINT_FLAG = Object.freeze({
  SELECTED: 1,
  DELETED: 2,
  HIDDEN: 4,
});

export const BOOL_OP_SET = Object.freeze(new Set(["replace", "add", "subtract", "intersect"]));

export const ERROR_CODES = Object.freeze({
  UNKNOWN_ASSET: "UNKNOWN_ASSET",
  INVALID_ASSET_IDENTITY: "INVALID_ASSET_IDENTITY",
  ASSET_VERSION_MISMATCH: "ASSET_VERSION_MISMATCH",
  UNSUPPORTED_RECIPE_VERSION: "UNSUPPORTED_RECIPE_VERSION",
  UNSAFE_RECIPE_DOWNGRADE: "UNSAFE_RECIPE_DOWNGRADE",
  INVALID_COMMAND: "INVALID_COMMAND",
  INVALID_BACKEND: "INVALID_BACKEND",
  JOB_CANCELED: "JOB_CANCELED",
  JOB_FAILED: "JOB_FAILED",
});

export const FORMAT_CAPABILITIES = Object.freeze({
  ".ply": Object.freeze({ lossless: true, supportsCameraTrack: false, label: "PLY" }),
  ".compressed.ply": Object.freeze({ lossless: false, supportsCameraTrack: false, label: "Compressed PLY" }),
  ".sog": Object.freeze({ lossless: false, supportsCameraTrack: false, label: "SOG" }),
  ".spz": Object.freeze({ lossless: false, supportsCameraTrack: false, label: "SPZ" }),
  ".csv": Object.freeze({ lossless: false, supportsCameraTrack: false, label: "CSV" }),
  ".html": Object.freeze({ lossless: false, supportsCameraTrack: true, label: "HTML Viewer" }),
  ".voxel.zip": Object.freeze({ lossless: false, supportsCameraTrack: false, label: "Voxel ZIP" }),
});

export class DomainError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export class AssetVersionMismatchError extends DomainError {
  constructor(message, details = null) {
    super(ERROR_CODES.ASSET_VERSION_MISMATCH, message, details);
    this.name = "AssetVersionMismatchError";
  }
}

export class UnsupportedRecipeError extends DomainError {
  constructor(message, details = null) {
    super(ERROR_CODES.UNSUPPORTED_RECIPE_VERSION, message, details);
    this.name = "UnsupportedRecipeError";
  }
}

/**
 * Validate a source asset identity descriptor before registering into an EditSession.
 * @param {object} asset
 */
export function assertValidAssetIdentity(asset) {
  if (!asset || typeof asset !== "object") {
    throw new DomainError(ERROR_CODES.INVALID_ASSET_IDENTITY, "Asset identity must be an object.");
  }
  if (typeof asset.assetId !== "string" || asset.assetId.trim().length === 0) {
    throw new DomainError(ERROR_CODES.INVALID_ASSET_IDENTITY, "Asset identity requires a non-empty string assetId.");
  }
  if (!Number.isInteger(asset.pointCount) || asset.pointCount < 0) {
    throw new DomainError(
      ERROR_CODES.INVALID_ASSET_IDENTITY,
      `Asset "${asset.assetId}" requires a non-negative integer pointCount.`,
    );
  }
}

/**
 * Validate that a preview backend adapter satisfies the minimal IPreviewBackend contract.
 * @param {object} backend
 */
export function assertPreviewBackend(backend) {
  if (!backend || typeof backend !== "object") {
    throw new DomainError(ERROR_CODES.INVALID_BACKEND, "Preview backend must be provided.");
  }
  for (const method of ["pickInRect", "syncFromSession", "dispose"]) {
    if (typeof backend[method] !== "function") {
      throw new DomainError(
        ERROR_CODES.INVALID_BACKEND,
        `Preview backend missing required method "${method}()".`,
      );
    }
  }
}

export function createIdentityMatrix16() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// Pure zero-DOM translator hook (wired by browser UI layer at boot; falls back cleanly in Node CLI/tests).
let _domainTranslator = null;

export function setDomainTranslator(fn) {
  _domainTranslator = typeof fn === "function" ? fn : null;
}

export function domainT(key, vars = null, fallback = "") {
  if (_domainTranslator) {
    try {
      const translated = _domainTranslator(key, vars);
      if (typeof translated === "string" && translated.length > 0 && translated !== key) {
        return translated;
      }
    } catch {
      // Fall back safely
    }
  }
  const tpl = fallback || key;
  if (!vars || typeof tpl !== "string") return tpl;
  return tpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
      ? String(vars[name])
      : match,
  );
}
