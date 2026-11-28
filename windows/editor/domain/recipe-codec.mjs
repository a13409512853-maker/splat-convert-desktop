/**
 * @module domain/recipe-codec
 * @description Graphics-device-independent Recipe Codec & Publish Snapshot Planner.
 *
 * Guarantees:
 * 1. Saving a project writes ONLY lightweight non-destructive recipes + compact RLE point sets
 *    (NEVER re-encodes full point clouds during save).
 * 2. Full compatibility with v1, v2, v3, AND v4 (3.2.2) recipes.
 * 3. Saving an opened v4 recipe NEVER implicitly downgrades it to v3 or silently drops
 *    v4-only fields (`paletteMatrices`, `transformIdxRle`, `paintDelta`, `onlyIndicesRle`).
 * 4. Unknown / future / uneditable recipe schemas return explicit warnings and preserve the
 *    original recipe untouched instead of silently overwriting.
 * 5. Distinguishes parametric operations (`parametricVolumes`) from source-version-pinned
 *    point edits (`assetBindings` with `sha256`, `pointCount`, `orderingVersion`).
 * 6. Scene-level `cameraTrack` is stored at project level (not per-point). When publishing to
 *    formats that cannot embed camera tracks, explicitly plans a sidecar `scene-manifest.json`
 *    and warns rather than silently dropping camera data.
 * 7. Multi-format publish plans on a frozen snapshot deduplicate identical compute parameters
 *    into ONE common baked intermediate (`sharedBakeKey`), then encode each format separately.
 *
 * ZERO DOM, ZERO WebGL, ZERO Three.js dependencies.
 */
import {
  COORD_CONTRACT,
  POINT_FLAG,
  FORMAT_CAPABILITIES,
  DomainError,
  UnsupportedRecipeError,
  ERROR_CODES,
  createIdentityMatrix16,
  domainT,
} from "./contracts.mjs";

/**
 * Compress sorted/unsorted integer source indices into compact [start, count] RLE ranges.
 */
export function encodeIndexRanges(indices) {
  if (!indices || indices.length === 0) return [];
  const sorted = Array.from(indices).sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0] | 0;
  let prev = start;
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i] | 0;
    if (v === prev) continue;
    if (v === prev + 1) {
      prev = v;
    } else {
      ranges.push([start, prev - start + 1]);
      start = prev = v;
    }
  }
  ranges.push([start, prev - start + 1]);
  return ranges;
}

export function decodeIndexRanges(ranges, callback) {
  if (!Array.isArray(ranges)) return;
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const s = r[0] | 0;
    const e = s + (r[1] | 0);
    for (let i = s; i < e; i++) callback(i);
  }
}

/**
 * Encode boolean flag mask (tested by `isSetFn(i)`) into alternating [falseRun, trueRun, ...] RLE
 * matching `ply.mjs` `buildBitsetFromBoolRle` (v4 format).
 */
export function encodeBoolRle(count, isSetFn) {
  const out = [];
  let flag = false;
  let run = 0;
  for (let i = 0; i < count; i++) {
    const bit = !!isSetFn(i);
    if (bit === flag) {
      run++;
    } else {
      out.push(run);
      flag = bit;
      run = 1;
    }
  }
  if (run > 0) out.push(run);
  return out;
}

export function decodeBoolRle(rle, maxCount, callback) {
  if (!Array.isArray(rle) || rle.length === 0) return;
  let ptr = 0;
  let flag = false;
  for (let k = 0; k < rle.length; k++) {
    const run = rle[k] | 0;
    if (flag && run > 0) {
      const end = Math.min(maxCount, ptr + run);
      for (let i = ptr; i < end; i++) callback(i);
    }
    ptr += run;
    flag = !flag;
    if (ptr >= maxCount) break;
  }
}

function isIdentityMatrix16(m) {
  if (!Array.isArray(m) || m.length !== 16) return true;
  const id = createIdentityMatrix16();
  for (let i = 0; i < 16; i++) {
    if (Math.abs(m[i] - id[i]) > 1e-6) return false;
  }
  return true;
}

// ============================================================================
// Pure Coordinate-Basis & Legacy z-up Cylinder TRS Migration (Zero DOM/Three.js)
// ============================================================================
// Coordinate layers:
//   1. Disk source assets (.ply/.sog) & entity/object/palette 4x4 matrices live
//      strictly in original disk source space (`matrixSpace = "source"`).
//   2. Viewport/ground/primitive convention (`coordSystem`):
//      - Current (rc11+): right-handed "y-up", ground Y=0, unit cylinder x^2+z^2<=1, |y|<=1.
//      - Legacy (<=rc10 / 3.2.1 / 3.2.2): "z-up", unit cylinder x^2+y^2<=1, |z|<=1.
//
// Exact pure-TRS identity for migrating a legacy z-up cylinder (T * R_old * diag(sx, sy, sz)):
//   M_new = T * (R_old * Rx(+90°)) * diag(sx, sz, sy) === T * R_old * diag(sx, sy, sz) * Rx(+90°)
//   Proof: S_old * Rx(+90°)(a,b,c) = (sx*a, -sy*c, sz*b) = Rx(+90°) * diag(sx, sz, sy)(a,b,c).
//   Therefore M_new^-1 * w = (a, c, -b) where (a, b, c) = M_old^-1 * w, so:
//   a'^2 + c'^2 === a^2 + b^2 and |b'| === |c| with ZERO shear for ALL rotations & non-uniform scales!

function eulerXyzToQuat(rx, ry, rz) {
  const c1 = Math.cos(rx * 0.5), s1 = Math.sin(rx * 0.5);
  const c2 = Math.cos(ry * 0.5), s2 = Math.sin(ry * 0.5);
  const c3 = Math.cos(rz * 0.5), s3 = Math.sin(rz * 0.5);
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;
  const len = Math.hypot(qx, qy, qz, qw) || 1;
  return [qx / len, qy / len, qz / len, qw / len];
}

function mulQuatXYZW(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  const qx = aw * bx + ax * bw + ay * bz - az * by;
  const qy = aw * by - ax * bz + ay * bw + az * bx;
  const qz = aw * bz + ax * by - ay * bx + az * bw;
  const qw = aw * bw - ax * bx - ay * by - az * bz;
  const len = Math.hypot(qx, qy, qz, qw) || 1;
  return [qx / len, qy / len, qz / len, qw / len];
}

function quatToEulerXyz(qx, qy, qz, qw) {
  // Matches THREE.Euler.setFromRotationMatrix(matFromQuat, "XYZ") exactly
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  const m11 = 1 - (yy + zz);
  const m12 = xy - wz;
  const m13 = xz + wy;
  const m22 = 1 - (xx + zz);
  const m23 = yz - wx;
  const m32 = yz + wx;
  const m33 = 1 - (xx + yy);

  const clamped = Math.max(-1, Math.min(1, m13));
  const ry = Math.asin(clamped);
  let rx, rz;
  if (Math.abs(clamped) < 0.9999999) {
    rx = Math.atan2(-m23, m33);
    rz = Math.atan2(-m12, m11);
  } else {
    rx = Math.atan2(m32, m22);
    rz = 0;
  }
  return [rx, ry, rz];
}

/**
 * Migrate a single legacy z-up cylinder TRS (Three.js XYZ Euler + non-uniform scale)
 * to an exact, zero-shear, mathematically equivalent y-up cylinder TRS.
 */
export function migrateLegacyZUpCylinderTrs(pos, rotEulerXyz, scale) {
  const p = Array.isArray(pos) && pos.length >= 3 ? [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(pos[2]) || 0] : [0, 0, 0];
  const r = Array.isArray(rotEulerXyz) && rotEulerXyz.length >= 3 ? [Number(rotEulerXyz[0]) || 0, Number(rotEulerXyz[1]) || 0, Number(rotEulerXyz[2]) || 0] : [0, 0, 0];
  const s = Array.isArray(scale) && scale.length >= 3 ? [Number(scale[0]) || 1, Number(scale[1]) || 1, Number(scale[2]) || 1] : [1, 1, 1];

  const qOld = eulerXyzToQuat(r[0], r[1], r[2]);
  // Rx(+90 deg) maps new local +Y -> old local +Z and new local -Z -> old local +Y
  const qRxPos90 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const qNew = mulQuatXYZW(qOld, qRxPos90);
  const rotNew = quatToEulerXyz(qNew[0], qNew[1], qNew[2], qNew[3]);
  // Permute local scale axes: (sx, sy_old, sz_old) -> (sx, sz_old, sy_old)
  const scaleNew = [s[0], s[2], s[1]];
  return { position: p, rotation: rotNew, scale: scaleNew };
}

/**
 * Idempotently migrate a volume snapshot (`{ items, groups, topLevelOrder, primitiveCoordSystem? }`)
 * from legacy z-up cylinder semantics to current y-up cylinder semantics.
 * Safe to invoke multiple times: once tagged `primitiveCoordSystem: "y-up"`, subsequent calls are a no-op.
 */
export function migrateRecipeVolumesToYUp(volumesSnap, recipeCoordSystem = null, recipeVersion = 3) {
  if (!volumesSnap || typeof volumesSnap !== "object") {
    return { volumes: volumesSnap, migratedCount: 0, primitiveCoordSystem: COORD_CONTRACT.system };
  }
  const cloned = structuredClone(volumesSnap);
  if (cloned.primitiveCoordSystem === "y-up") {
    return { volumes: cloned, migratedCount: 0, primitiveCoordSystem: "y-up" };
  }
  const fromSystem =
    cloned.primitiveCoordSystem ||
    recipeCoordSystem ||
    (recipeVersion === 3 ? "z-up" : "y-up");

  let migratedCount = 0;
  if (fromSystem === "z-up" && Array.isArray(cloned.items)) {
    for (const item of cloned.items) {
      if (!item || item.kind !== "cylinder") continue;
      if (item.primitiveCoordSystem === "y-up") continue;
      const cur = migrateLegacyZUpCylinderTrs(item.position, item.rotation, item.scale);
      item.position = cur.position;
      item.rotation = cur.rotation;
      item.scale = cur.scale;
      if (item.initialPosition || item.initialRotation || item.initialScale) {
        const init = migrateLegacyZUpCylinderTrs(
          item.initialPosition || item.position,
          item.initialRotation || [0, 0, 0],
          item.initialScale || [1, 1, 1],
        );
        item.initialPosition = init.position;
        item.initialRotation = init.rotation;
        item.initialScale = init.scale;
      }
      item.primitiveCoordSystem = "y-up";
      migratedCount++;
    }
  }
  cloned.primitiveCoordSystem = "y-up";
  return { volumes: cloned, migratedCount, primitiveCoordSystem: "y-up", fromCoordSystem: fromSystem };
}

function resolveRecipeCoordSystem(recipe, version) {
  const raw = recipe?.coordSystem;
  if (raw === undefined || raw === null || raw === "") {
    // Version-evidence inference: legacy v1/v2/v3/v4 recipes saved before rc11 omitted or used z-up
    return {
      valid: true,
      coordSystem: "z-up",
      inferred: true,
      raw: null,
    };
  }
  if (typeof raw === "string" && COORD_CONTRACT.knownSystems.includes(raw)) {
    return {
      valid: true,
      coordSystem: raw,
      inferred: false,
      raw,
    };
  }
  return {
    valid: false,
    coordSystem: String(raw),
    inferred: false,
    raw: String(raw),
  };
}

/**
 * Inspect any recipe object (v1/v2/v3/v4/unknown) and report compatibility, warnings,
 * coordinate basis status, and uneditable fields that MUST be preserved without silent loss.
 */
export function inspectRecipeCompatibility(recipe) {
  if (!recipe || typeof recipe !== "object") {
    return {
      version: 0,
      kind: "invalid",
      supported: false,
      readOnly: true,
      canEditInNativeUi: false,
      requiresPreservation: true,
      coordSystem: null,
      matrixSpace: COORD_CONTRACT.matrixSpace,
      warnings: [domainT("editor.domain.recipeInvalid", null, "Recipe is empty or not a valid JSON object.")],
      unsupportedFields: ["<root>"],
    };
  }

  const v = Number(recipe.version);
  const coordInfo = resolveRecipeCoordSystem(recipe, v);

  // Unrecognized coordSystem tag -> open read-only, warn explicitly, block silent overwrite!
  if ([1, 2, 3, 4].includes(v) && !coordInfo.valid) {
    return {
      version: v,
      kind: "unsupported-coord-system",
      supported: false,
      readOnly: true,
      canEditInNativeUi: false,
      requiresPreservation: true,
      coordSystem: coordInfo.coordSystem,
      matrixSpace: COORD_CONTRACT.matrixSpace,
      warnings: [
        domainT(
          "editor.domain.recipeUnsupportedCoord",
          { coordSystem: coordInfo.coordSystem },
          `Unrecognized recipe coordSystem ("${coordInfo.coordSystem}"); opened read-only to prevent silent coordinate corruption.`,
        ),
      ],
      unsupportedFields: ["coordSystem"],
    };
  }

  if (v === 1 || v === 2) {
    return {
      version: v,
      kind: "legacy-v1-v2",
      supported: true,
      readOnly: false,
      canEditInNativeUi: true,
      requiresPreservation: false,
      coordSystem: coordInfo.coordSystem,
      coordSystemInferred: coordInfo.inferred,
      matrixSpace: COORD_CONTRACT.matrixSpace,
      warnings: [],
      unsupportedFields: [],
    };
  }

  if (v === 3) {
    const knownV3Keys = new Set([
      "version", "coordSystem", "matrixSpace", "exportObjectIds", "deletedRanges", "objects", "groups",
      "volumes", "parametricVolumes", "rules", "translation", "rotation", "scale",
      "assetBindings", "cameraTrack", "sceneManifest", "measureScale",
    ]);
    const extraKeys = Object.keys(recipe).filter((k) => !knownV3Keys.has(k));
    const warnings = extraKeys.length > 0
      ? [domainT("editor.domain.recipeV3Extra", { keys: extraKeys.join(", ") }, `Detected v3 extension fields (${extraKeys.join(", ")}); preserved verbatim on save.`)]
      : [];
    const volItems = Array.isArray(recipe.volumes?.items) ? recipe.volumes.items : [];
    const needsCylinderMigration =
      recipe.volumes?.primitiveCoordSystem !== "y-up" &&
      (recipe.volumes?.primitiveCoordSystem === "z-up" || coordInfo.coordSystem === "z-up") &&
      volItems.some((it) => it && it.kind === "cylinder" && it.primitiveCoordSystem !== "y-up");
    return {
      version: 3,
      kind: "native-v3",
      supported: true,
      readOnly: false,
      canEditInNativeUi: true,
      requiresPreservation: extraKeys.length > 0,
      coordSystem: coordInfo.coordSystem,
      coordSystemInferred: coordInfo.inferred,
      matrixSpace: COORD_CONTRACT.matrixSpace,
      needsCylinderMigration,
      warnings,
      unsupportedFields: extraKeys,
    };
  }

  if (v === 4) {
    const unsupported = [];
    const warnings = [];
    const pal = Array.isArray(recipe.paletteMatrices) ? recipe.paletteMatrices : [];
    const hasSubPalette =
      pal.length > 1 ||
      (pal.length === 1 && !isIdentityMatrix16(pal[0])) ||
      (Array.isArray(recipe.transformIdxRle) && recipe.transformIdxRle.length > 0);
    if (hasSubPalette) {
      unsupported.push("paletteMatrices/transformIdxRle");
      warnings.push(domainT("editor.domain.recipeV4SubPalette", null, "Contains 3.2.2 sub-selection transform palette (paletteMatrices/transformIdxRle); preserved verbatim as v4 on save."));
    }
    if (recipe.paintDelta && Array.isArray(recipe.paintDelta.indices) && recipe.paintDelta.indices.length > 0) {
      unsupported.push("paintDelta");
      warnings.push(domainT("editor.domain.recipeV4PaintDelta", { count: recipe.paintDelta.indices.length }, `Contains 3.2.2 sparse brush paint data (${recipe.paintDelta.indices.length} pts paintDelta); preserved verbatim as v4 on save.`));
    }
    if (Array.isArray(recipe.onlyIndicesRle) && recipe.onlyIndicesRle.length > 0) {
      unsupported.push("onlyIndicesRle");
      warnings.push(domainT("editor.domain.recipeV4OnlyIndices", null, "Contains 3.2.2 group inclusion mask (onlyIndicesRle); preserved verbatim as v4 on save."));
    }
    const knownV4Keys = new Set([
      "version", "engine", "pointCount", "coordSystem", "matrixSpace", "deletedRle", "deletedCount",
      "onlyIndicesRle", "entityDeltaMatrix", "paletteMatrices", "transformIdxRle", "paintDelta",
      "colorGrade", "assetBindings", "parametricVolumes", "cameraTrack", "measureScale",
    ]);
    for (const k of Object.keys(recipe)) {
      if (!knownV4Keys.has(k)) {
        unsupported.push(k);
        warnings.push(domainT("editor.domain.recipeV4UnknownField", { field: k }, `Contains unknown v4 field "${k}"; preserved verbatim on save.`));
      }
    }
    if (warnings.length === 0) {
      warnings.push(domainT("editor.domain.recipeV4Loaded", null, "Loaded 3.2.2 (v4) recipe; will remain v4 on save without implicit downgrade."));
    }
    return {
      version: 4,
      kind: "resplat-v4",
      supported: true,
      readOnly: false,
      canEditInNativeUi: true,
      requiresPreservation: true,
      coordSystem: coordInfo.coordSystem,
      coordSystemInferred: coordInfo.inferred,
      matrixSpace: COORD_CONTRACT.matrixSpace,
      warnings,
      unsupportedFields: unsupported,
    };
  }

  return {
    version: Number.isFinite(v) ? v : -1,
    kind: "unsupported",
    supported: false,
    readOnly: true,
    canEditInNativeUi: false,
    requiresPreservation: true,
    coordSystem: coordInfo.raw,
    matrixSpace: COORD_CONTRACT.matrixSpace,
    warnings: [domainT("editor.domain.recipeUnsupportedVersion", { version: String(recipe.version) }, `Unsupported recipe schema (version=${String(recipe.version)}); original preserved without silent overwrite.`)],
    unsupportedFields: Object.keys(recipe),
  };
}

/**
 * Decode a JSON string or recipe object into an EditSession, checking source version bindings
 * and preserving v4 / unsupported fields cleanly.
 */
export function decodeRecipeIntoSession(recipeOrJson, session, opts = {}) {
  const recipe = typeof recipeOrJson === "string"
    ? JSON.parse(recipeOrJson.replace(/^\uFEFF/, ""))
    : recipeOrJson;
  const compat = inspectRecipeCompatibility(recipe);

  session.setPreservedRecipeMeta({
    originalVersion: compat.version,
    compatibility: compat,
    originalRecipe: structuredClone(recipe),
  });

  if (!compat.supported) {
    if (opts.throwOnUnsupported) {
      throw new UnsupportedRecipeError(compat.warnings[0], { compat });
    }
    return { compatibility: compat, appliedDeletedCount: 0, warnings: compat.warnings };
  }

  // Enforce source-asset version bindings BEFORE applying any source-pinned point index edits!
  if (recipe.assetBindings && typeof recipe.assetBindings === "object") {
    for (const [assetId, binding] of Object.entries(recipe.assetBindings)) {
      if (session.hasAsset(assetId)) {
        session.verifyAssetVersion(assetId, binding);
      }
    }
  }

  // Restore scene-level persistent objects, volumes, colorGrade, measureScale & cameraTrack into EditSession!
  if (Array.isArray(recipe.objects) && session.sceneState) {
    session.sceneState.setSceneGraph(recipe.objects, Array.isArray(recipe.groups) ? recipe.groups : []);
  }
  if (recipe.colorGrade && session.sceneState) {
    session.sceneState.setColorGrade(recipe.colorGrade);
  }
  if (recipe.measureScale && session.sceneState) {
    session.sceneState.setMeasureScale(recipe.measureScale);
  }
  let migratedCylinderCount = 0;
  if (recipe.volumes && typeof recipe.volumes === "object" && compat.version === 3) {
    const mig = migrateRecipeVolumesToYUp(recipe.volumes, compat.coordSystem, compat.version);
    migratedCylinderCount = mig.migratedCount;
    if (session.sceneState) session.sceneState.setVolumesSnapshot(mig.volumes);
    if (Array.isArray(mig.volumes?.items)) {
      session.setParametricVolumes(mig.volumes.items);
    }
  } else if (Array.isArray(recipe.parametricVolumes)) {
    const mig = migrateRecipeVolumesToYUp(
      { items: recipe.parametricVolumes, primitiveCoordSystem: recipe.volumes?.primitiveCoordSystem },
      compat.coordSystem,
      compat.version,
    );
    migratedCylinderCount = mig.migratedCount;
    if (session.sceneState) session.sceneState.setVolumesSnapshot(mig.volumes);
    session.setParametricVolumes(mig.volumes?.items || recipe.parametricVolumes);
  }
  if (recipe.cameraTrack) {
    session.setCameraTrack(recipe.cameraTrack);
  }

  let appliedDeletedCount = 0;
  const assetIds = session.getAssetIds();
  const primaryAssetId = opts.primaryAssetId || assetIds[0] || null;

  if (compat.version === 3) {
    if (recipe.assetBindings && typeof recipe.assetBindings === "object") {
      // Multi-asset source-pinned deletedRanges restore (with single-asset fallback when key differs e.g. "primary" <-> "asset-<hash>")
      const entries = Object.entries(recipe.assetBindings);
      let matchedAny = false;
      for (const [assetId, binding] of entries) {
        if (!session.hasAsset(assetId)) continue;
        matchedAny = true;
        const entry = session.getAsset(assetId);
        if (Array.isArray(binding.deletedRanges)) {
          decodeIndexRanges(binding.deletedRanges, (sIdx) => {
            if (sIdx >= 0 && sIdx < entry.flags.length) {
              entry.flags[sIdx] |= POINT_FLAG.DELETED;
              appliedDeletedCount++;
            }
          });
        }
        if (Array.isArray(binding.entityMatrix) && binding.entityMatrix.length === 16) {
          session.setEntityMatrix(assetId, binding.entityMatrix);
        }
      }
      if (!matchedAny && entries.length === 1 && primaryAssetId && session.hasAsset(primaryAssetId)) {
        const binding = entries[0][1];
        const entry = session.getAsset(primaryAssetId);
        if (binding && Array.isArray(binding.deletedRanges)) {
          decodeIndexRanges(binding.deletedRanges, (sIdx) => {
            if (sIdx >= 0 && sIdx < entry.flags.length) {
              entry.flags[sIdx] |= POINT_FLAG.DELETED;
              appliedDeletedCount++;
            }
          });
        }
        if (binding && Array.isArray(binding.entityMatrix) && binding.entityMatrix.length === 16) {
          session.setEntityMatrix(primaryAssetId, binding.entityMatrix);
        }
      }
    } else if (primaryAssetId && session.hasAsset(primaryAssetId)) {
      const entry = session.getAsset(primaryAssetId);
      const mainObj = Array.isArray(recipe.objects)
        ? recipe.objects.find((o) => o && Number(o.id) === 0)
        : null;
      const ranges = (mainObj && Array.isArray(mainObj.deletedRanges) && mainObj.deletedRanges.length > 0)
        ? mainObj.deletedRanges
        : recipe.deletedRanges;
      decodeIndexRanges(ranges, (sIdx) => {
        if (sIdx >= 0 && sIdx < entry.flags.length) {
          entry.flags[sIdx] |= POINT_FLAG.DELETED;
          appliedDeletedCount++;
        }
      });
      if (mainObj && Array.isArray(mainObj.matrix) && mainObj.matrix.length === 16) {
        session.setEntityMatrix(primaryAssetId, mainObj.matrix);
      }
    }
  } else if (compat.version === 4 && primaryAssetId && session.hasAsset(primaryAssetId)) {
    const entry = session.getAsset(primaryAssetId);
    if (Array.isArray(recipe.deletedRle)) {
      decodeBoolRle(recipe.deletedRle, entry.flags.length, (sIdx) => {
        entry.flags[sIdx] |= POINT_FLAG.DELETED;
        appliedDeletedCount++;
      });
    }
    if (Array.isArray(recipe.entityDeltaMatrix) && recipe.entityDeltaMatrix.length === 16) {
      session.setEntityMatrix(primaryAssetId, recipe.entityDeltaMatrix);
    }
  }

  for (const aid of assetIds) {
    if (typeof session.recomputeAssetCounts === "function") session.recomputeAssetCounts(aid);
  }

  return { compatibility: compat, appliedDeletedCount, migratedCylinderCount, warnings: compat.warnings };
}

/**
 * Serialize EditSession state into a lightweight non-destructive project recipe.
 * - NEVER re-encodes full point clouds.
 * - Preserves v4 recipes as v4 (no silent v4 -> v3 downgrade) unless explicitly forced.
 * - Refuses silent overwrite of unsupported future schemas by returning the preserved original
 *   with `blocked: true` unless `allowForceOverwrite` is explicitly true.
 */
export function encodeProjectRecipe(session, opts = {}) {
  const meta = session.getPreservedRecipeMeta();
  const assetIds = session.getAssetIds();
  const primaryAssetId = opts.primaryAssetId || assetIds[0] || null;

  // Guard 1: Unknown / future schema -> preserve original untouched, never silently overwrite!
  if (meta && meta.compatibility && !meta.compatibility.supported) {
    if (!opts.allowForceOverwrite) {
      return {
        recipe: structuredClone(meta.originalRecipe),
        preservedOriginal: true,
        blocked: true,
        warnings: meta.compatibility.warnings.slice(),
      };
    }
  }

  // Build per-asset source-pinned bindings (zero-alloc O(N) RLE directly from flags!)
  const assetBindings = {};
  for (const aid of assetIds) {
    const entry = session.getAsset(aid);
    const delRanges = typeof session.encodeFlagRanges === "function"
      ? session.encodeFlagRanges(aid, POINT_FLAG.DELETED)
      : encodeIndexRanges(session.getDeletedSourceIndices(aid));
    assetBindings[aid] = {
      assetId: aid,
      name: entry.identity.name,
      sha256: entry.identity.sha256,
      pointCount: entry.identity.pointCount,
      orderingVersion: entry.identity.orderingVersion,
      deletedRanges: delRanges,
      entityMatrix: entry.entityMatrix.slice(),
    };
  }

  const parametricVolumes = session.getParametricVolumes();
  const cameraTrack = session.getCameraTrack();

  // Guard 2: Opened v4 recipe -> keep version: 4 and preserve ALL untouched v4 fields!
  if (meta && meta.originalVersion === 4 && !opts.forceConvertToV3) {
    const orig = structuredClone(meta.originalRecipe);
    const primary = primaryAssetId ? session.getAsset(primaryAssetId) : null;
    if (primary) {
      const delCount = primary.counts ? primary.counts.deleted : session.getDeletedSourceIndices(primaryAssetId).length;
      orig.deletedRle = encodeBoolRle(
        primary.flags.length,
        (i) => (primary.flags[i] & POINT_FLAG.DELETED) !== 0,
      );
      orig.deletedCount = delCount;
      orig.entityDeltaMatrix = Array.isArray(opts.primaryEntityMatrix) && opts.primaryEntityMatrix.length === 16
        ? opts.primaryEntityMatrix.slice()
        : primary.entityMatrix.slice();
    }
    orig.version = 4;
    // CRITICAL (002-A): Preserve opened v4 recipe's original coordSystem tag verbatim (e.g. "z-up")!
    // entityDeltaMatrix & paletteMatrices operate strictly in disk source space (`matrixSpace = "source"`),
    // so never silently overwrite historical "z-up" -> "y-up".
    orig.coordSystem =
      (typeof meta.originalRecipe?.coordSystem === "string" && meta.originalRecipe.coordSystem)
        ? meta.originalRecipe.coordSystem
        : (meta.compatibility?.coordSystem || "z-up");
    orig.matrixSpace = COORD_CONTRACT.matrixSpace;
    orig.assetBindings = assetBindings;
    if (parametricVolumes.length > 0) orig.parametricVolumes = parametricVolumes;
    if (cameraTrack) orig.cameraTrack = cameraTrack;
    if (opts.baseV3Payload?.measureScale) orig.measureScale = structuredClone(opts.baseV3Payload.measureScale);
    return {
      recipe: orig,
      preservedOriginal: false,
      blocked: false,
      warnings: meta.compatibility?.warnings ? meta.compatibility.warnings.slice() : [],
    };
  }

  // Standard lightweight v3 recipe (preserves any unknown v3 extension fields!)
  const primaryBinding = primaryAssetId ? assetBindings[primaryAssetId] : null;
  const base = opts.baseV3Payload
    ? structuredClone(opts.baseV3Payload)
    : {
        version: 3,
        coordSystem: COORD_CONTRACT.system,
        exportObjectIds: [0],
        deletedRanges: primaryBinding ? primaryBinding.deletedRanges : [],
        objects: [
          {
            id: 0,
            name: primaryBinding ? primaryBinding.name : domainT("editor.scene.mainCloud", null, "Main Scene Cloud"),
            visible: true,
            groupId: null,
            sourceKind: "original",
            memberRanges: "all",
            excludedRanges: [],
            deletedRanges: primaryBinding ? primaryBinding.deletedRanges : [],
            matrix: primaryBinding ? primaryBinding.entityMatrix : createIdentityMatrix16(),
            bakedGrades: [],
          },
        ],
        groups: [],
        volumes: { items: [], groups: [] },
        rules: [],
        translation: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: 1,
      };

  // Re-attach preserved extra v3 extension keys if any existed in original recipe
  if (meta && meta.originalVersion === 3 && meta.compatibility?.unsupportedFields?.length) {
    for (const k of meta.compatibility.unsupportedFields) {
      if (!(k in base) && k in meta.originalRecipe) {
        base[k] = structuredClone(meta.originalRecipe[k]);
      }
    }
  }

  base.version = 3;
  base.coordSystem = COORD_CONTRACT.system;
  base.matrixSpace = COORD_CONTRACT.matrixSpace;
  if (base.volumes && typeof base.volumes === "object") {
    base.volumes.primitiveCoordSystem = COORD_CONTRACT.system;
  }
  base.assetBindings = assetBindings;
  if (parametricVolumes.length > 0) base.parametricVolumes = parametricVolumes;
  if (cameraTrack) base.cameraTrack = cameraTrack;

  return {
    recipe: base,
    preservedOriginal: false,
    blocked: false,
    warnings: [],
  };
}

/**
 * Extract an asset-specific v3 recipe suitable for `worker.mjs mask` / `ply.mjs processPlyV3`
 * on one specific source asset (so multi-asset sessions bake each asset cleanly by its own ID!).
 */
export function buildSingleAssetExportRecipe(projectRecipe, assetId) {
  if (!projectRecipe || typeof projectRecipe !== "object") {
    throw new DomainError(ERROR_CODES.INVALID_COMMAND, "Missing projectRecipe.");
  }
  if (projectRecipe.version === 4) {
    return structuredClone(projectRecipe);
  }
  const binding = projectRecipe.assetBindings?.[assetId];
  if (!binding) {
    return structuredClone(projectRecipe);
  }
  return {
    version: 3,
    coordSystem: COORD_CONTRACT.system,
    exportObjectIds: [0],
    deletedRanges: structuredClone(binding.deletedRanges || []),
    objects: [
      {
        id: 0,
        name: binding.name || assetId,
        visible: true,
        groupId: null,
        sourceKind: "original",
        memberRanges: "all",
        excludedRanges: [],
        deletedRanges: structuredClone(binding.deletedRanges || []),
        matrix: Array.isArray(binding.entityMatrix) && binding.entityMatrix.length === 16
          ? binding.entityMatrix.slice()
          : createIdentityMatrix16(),
        bakedGrades: [],
      },
    ],
    groups: [],
    volumes: { items: [], groups: [] },
    rules: [],
    translation: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: 1,
  };
}

/**
 * Freeze an immutable publish snapshot and compute a multi-format publish plan that:
 * 1. Reuses ONE common baked intermediate across targets with identical snapshot + compute params;
 * 2. Emits explicit `scene-manifest.json` sidecar + warnings when a format cannot store `cameraTrack`.
 */
export function createPublishPlan(session, recipe, targets = []) {
  const cameraTrack = session.getCameraTrack();
  const hasCameraTrack = !!(cameraTrack && Array.isArray(cameraTrack.keyframes) && cameraTrack.keyframes.length > 0);
  const snapshot = Object.freeze({
    snapshotId: `snap-${Date.now().toString(36)}`,
    createdAtUtc: new Date().toISOString(),
    recipe: structuredClone(recipe),
    cameraTrack: hasCameraTrack ? structuredClone(cameraTrack) : null,
  });

  const recipeKey = JSON.stringify(snapshot.recipe);
  const sharedBakesMap = new Map();
  const plannedTargets = [];

  for (const t of targets) {
    const suffix = String(t.formatSuffix || ".ply").toLowerCase();
    const cap = FORMAT_CAPABILITIES[suffix] || { lossless: false, supportsCameraTrack: false, label: suffix };
    const preOpsKey = JSON.stringify(t.preBakeOps || []);
    const assetKey = String(t.assetId || "primary");
    const bakeKey = `${assetKey}::${recipeKey.length}::${preOpsKey}::${recipeKey}`;

    let bakeId;
    if (!sharedBakesMap.has(bakeKey)) {
      bakeId = `bake-${sharedBakesMap.size + 1}`;
      sharedBakesMap.set(bakeKey, {
        bakeId,
        assetId: assetKey,
        preBakeOps: t.preBakeOps || [],
        consumerFormats: [suffix],
      });
    } else {
      const existing = sharedBakesMap.get(bakeKey);
      bakeId = existing.bakeId;
      existing.consumerFormats.push(suffix);
    }

    const warnings = [];
    let sceneManifestSidecar = null;
    if (hasCameraTrack && !cap.supportsCameraTrack) {
      sceneManifestSidecar = (t.outputPath || `output${suffix}`) + ".scene-manifest.json";
      warnings.push(
        domainT(
          "editor.domain.cameraTrackSidecarWarn",
          { label: cap.label, suffix, sidecar: sceneManifestSidecar },
          `Format ${cap.label} (${suffix}) does not embed camera keyframes; publishing sidecar manifest ${sceneManifestSidecar} instead.`,
        ),
      );
    }

    plannedTargets.push({
      targetId: t.targetId || `${assetKey}${suffix}`,
      assetId: assetKey,
      formatSuffix: suffix,
      outputPath: t.outputPath || "",
      lossless: cap.lossless,
      sharedBakeId: bakeId,
      supportsCameraTrack: cap.supportsCameraTrack,
      sceneManifestSidecar,
      warnings,
    });
  }

  return {
    snapshot,
    sharedBakes: Array.from(sharedBakesMap.values()),
    targets: plannedTargets,
  };
}
