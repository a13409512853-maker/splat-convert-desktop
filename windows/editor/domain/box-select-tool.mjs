/**
 * @module domain/box-select-tool
 * @description Backend-agnostic Box-Select & Delete vertical slice tool.
 *
 * Contract:
 * - Tool ONLY queries `previewBackend.pickInRect(...)` for asset-qualified source refs
 *   (`Array<{ assetId, previewIndex, sourceIndex }>`) and submits pure domain commands
 *   to `editSession.dispatch(...)`.
 * - Tool NEVER touches DOM, WebGL, Three.js, PlayCanvas, or GPU buffers directly.
 * - Swapping the rendering backend (Three.js -> Vulkan / PlayCanvas / Mock) requires
 *   ZERO changes to this tool, EditSession, or RecipeCodec.
 */
import { assertPreviewBackend, DomainError, ERROR_CODES, domainT } from "./contracts.mjs";

const OP_LABEL_KEYS = Object.freeze({
  replace: ["editor.domain.boxReplace", "Box Replace"],
  add: ["editor.domain.boxAdd", "Box Add"],
  subtract: ["editor.domain.boxSubtract", "Box Subtract"],
  intersect: ["editor.domain.boxIntersect", "Box Intersect"],
});

export class BoxSelectTool {
  /**
   * @param {object} opts
   * @param {object} opts.previewBackend - IPreviewBackend implementation
   * @param {import("./edit-session.mjs").EditSession} opts.editSession
   */
  constructor({ previewBackend, editSession }) {
    assertPreviewBackend(previewBackend);
    if (!editSession || typeof editSession.dispatch !== "function") {
      throw new DomainError(ERROR_CODES.INVALID_COMMAND, "BoxSelectTool requires a valid EditSession.");
    }
    this.previewBackend = previewBackend;
    this.editSession = editSession;
  }

  /**
   * Execute a screen-space box selection through the injected preview backend and commit
   * strictly source-indexed point refs into EditSession.
   *
   * @param {object} params
   * @param {{ minX: number, maxX: number, minY: number, maxY: number }} params.rectNdc
   * @param {"replace"|"add"|"subtract"|"intersect"} [params.op="replace"]
   * @param {boolean} [params.onlyVisible=false]
   * @param {boolean} [params.wholeGaussian=false]
   * @param {string|null} [params.targetAssetId=null]
   * @param {Function|null} [params.worldScopeFn=null]
   * @param {Set<number>|null} [params.activeObjectIds=null]
   */
  selectBox({
    rectNdc,
    op = "replace",
    onlyVisible = false,
    wholeGaussian = false,
    targetAssetId = null,
    worldScopeFn = null,
    activeObjectIds = null,
  }) {
    const refs = this.previewBackend.pickInRect({
      rectNdc,
      onlyVisible,
      wholeGaussian,
      targetAssetId,
      worldScopeFn,
      activeObjectIds,
    });

    const opSpec = OP_LABEL_KEYS[op];
    const result = this.editSession.dispatch({
      type: "selectPoints",
      op,
      refs,
      targetAssetId,
      label: opSpec ? domainT(opSpec[0], null, opSpec[1]) : domainT("editor.domain.boxOpFallback", { op }, `Box (${op})`),
    });

    if (result.dirtyAssetIds.length > 0) {
      this.previewBackend.syncFromSession(this.editSession, result.dirtyAssetIds, result.deltas || null);
    }

    const pickedCount = refs && refs.kind === "packed"
      ? (refs.count | 0)
      : (Array.isArray(refs) ? refs.length : 0);

    return {
      ...result,
      pickedCount,
    };
  }

  /**
   * Soft-delete currently selected points (optionally scoped to one targetAssetId).
   */
  deleteSelected({ targetAssetId = null, label = null } = {}) {
    const effectiveLabel = label || domainT("editor.domain.softDelete", null, "Soft Delete");
    const result = this.editSession.dispatch({
      type: "deleteSelected",
      targetAssetId,
      label: effectiveLabel,
    });
    if (result.dirtyAssetIds.length > 0) {
      this.previewBackend.syncFromSession(this.editSession, result.dirtyAssetIds, result.deltas || null);
    }
    return result;
  }

  undo() {
    const result = this.editSession.undo();
    if (result.ok && result.dirtyAssetIds.length > 0) {
      this.previewBackend.syncFromSession(this.editSession, result.dirtyAssetIds, result.deltas || null);
    }
    return result;
  }

  redo() {
    const result = this.editSession.redo();
    if (result.ok && result.dirtyAssetIds.length > 0) {
      this.previewBackend.syncFromSession(this.editSession, result.dirtyAssetIds, result.deltas || null);
    }
    return result;
  }
}
