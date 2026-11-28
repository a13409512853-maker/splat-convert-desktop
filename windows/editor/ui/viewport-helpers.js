/**
 * @module ui/viewport-helpers
 * @description Infinite +Y-up analytical anti-aliased ground grid (Y=0 plane) and
 * ReSplat-style 8-corner L-bracket bounding box helper for Gaussian models (Fig 7).
 *
 * Design Contract:
 * - Strictly adheres to global +Y-up coordinate system (ground plane is Y = 0, XZ axes).
 * - InfiniteGroundGrid computes exact 64-bit frustum near/mid ray planes on CPU (avoiding Float32
 *   matrix-inversion singularity when camera.far is large!) and renders Ben Golus's analytical
 *   pristineGrid shader (MIT, adapted from ReSplat/SuperSplat) with colored X/Z axes and exact gl_FragDepth.
 * - ModelCornerBounds renders 24 crisp orthogonal L-bracket corner ticks (8 corners × 3 axes) around the
 *   visible non-deleted Gaussian model bounds without obstructing interior detail.
 */
import * as T from "three";

const GRID_VERTEX_SHADER = /* glsl */ `
  uniform vec3 uOrigin00;
  uniform vec3 uOriginX;
  uniform vec3 uOriginY;
  uniform vec3 uDir00;
  uniform vec3 uDirX;
  uniform vec3 uDirY;

  varying vec3 vRayOrigin;
  varying vec3 vRayDir;

  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
    vec2 p = position.xy * 0.5 + 0.5;
    vRayOrigin = uOrigin00 + uOriginX * p.x + uOriginY * p.y;
    vRayDir    = uDir00    + uDirX    * p.x + uDirY    * p.y;
  }
`;

const GRID_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform mat4 uViewProj;
  uniform vec3 uCamPos;
  uniform float uGridFadeDist;
  uniform float uGridLevel;
  uniform float uGridFrac;

  varying vec3 vRayOrigin;
  varying vec3 vRayDir;

  // Multi-decade Nyquist-safe analytical grid line: fades fine cells smoothly to 0 BEFORE
  // they drop below ~3 pixels, completely eliminating far-zoom moire/snow at any distance!
  float gridScaleAlpha(vec2 pos, vec2 ddx, vec2 ddy, float scale, float halfLinePx) {
    vec2 invScale = vec2(1.0 / scale);
    vec2 coord = pos * invScale;
    vec2 deriv = vec2(length(vec2(ddx.x, ddy.x)), length(vec2(ddx.y, ddy.y))) * invScale;
    float maxDeriv = max(deriv.x, deriv.y);
    float nyquist = 1.0 - smoothstep(0.10, 0.26, maxDeriv);
    if (nyquist <= 0.001) return 0.0;

    vec2 cellDist = abs(fract(coord - 0.5) - 0.5) / max(deriv, vec2(1e-5));
    float dMin = min(cellDist.x, cellDist.y);
    float line = 1.0 - smoothstep(max(0.0, halfLinePx - 0.55), halfLinePx + 0.55, dMin);
    return line * nyquist;
  }

  void main() {
    // Full-precision ray direction precomputed in 64-bit JS (ZERO Float32 near/mid cancellation even at 10km!)
    vec3 rayDir = normalize(vRayDir);

    // Intersect ray with strict +Y-up XZ ground plane (Y = 0)
    if (abs(rayDir.y) < 1e-6) discard;
    float t = -vRayOrigin.y / rayDir.y;
    if (t < 0.0) discard;

    vec3 worldPos = vRayOrigin + rayDir * t;
    vec2 pos = worldPos.xz;
    vec2 ddx = dFdx(pos);
    vec2 ddy = dFdy(pos);

    float dist = length(worldPos - uCamPos);
    float fadeDist = max(80.0, uGridFadeDist);
    float fade = 1.0 - smoothstep(fadeDist * 0.20, fadeDist, dist);
    float grazing = smoothstep(0.012, 0.095, abs(rayDir.y));
    fade *= mix(0.18, 1.0, grazing);
    if (fade < 0.004) discard;

    // Exact clip-space depth so Gaussians & geometry intersect Y=0 cleanly!
    vec4 clip = uViewProj * vec4(worldPos, 1.0);
    float ndcDepth = clip.z / clip.w;
    if (ndcDepth < -1.0 || ndcDepth > 1.0) discard;
    gl_FragDepth = ndcDepth * 0.5 + 0.5;

    // Subtle colored +X (soft crimson, z=0) and +Z (soft cobalt-blue, x=0) origin axes
    vec2 axisDeriv = vec2(length(vec2(ddx.x, ddy.x)), length(vec2(ddx.y, ddy.y)));
    float xAxisMask = 1.0 - smoothstep(axisDeriv.y * 0.65, axisDeriv.y * 1.9, abs(pos.y));
    float zAxisMask = 1.0 - smoothstep(axisDeriv.x * 0.65, axisDeriv.x * 1.9, abs(pos.x));

    // Continuous logarithmic 3-decade progressive LOD:
    // As camera pulls away, fine grid fades out cleanly while 10x / 100x coarser cells step in!
    float sFine = pow(10.0, uGridLevel);
    float sMid  = sFine * 10.0;
    float sMaj  = sFine * 100.0;

    float fineFade = 1.0 - smoothstep(0.15, 0.92, uGridFrac);
    float aFine = gridScaleAlpha(pos, ddx, ddy, sFine, 0.62) * 0.24 * fineFade;
    float aMid  = gridScaleAlpha(pos, ddx, ddy, sMid,  0.72) * mix(0.46, 0.26, uGridFrac);
    float aMaj  = gridScaleAlpha(pos, ddx, ddy, sMaj,  0.88) * mix(0.32, 0.56, uGridFrac);

    vec3 col = vec3(0.56, 0.60, 0.68);
    float alpha = max(aMaj, max(aMid, aFine));
    if (aMaj >= aMid && aMaj > 0.04) col = vec3(0.76, 0.80, 0.88);
    else if (aMid >= aFine && aMid > 0.04) col = vec3(0.66, 0.70, 0.78);

    if (xAxisMask > 0.02) {
      col = mix(col, vec3(0.86, 0.34, 0.34), xAxisMask * 0.92);
      alpha = max(alpha, xAxisMask * 0.72);
    }
    if (zAxisMask > 0.02) {
      col = mix(col, vec3(0.35, 0.56, 0.90), zAxisMask * 0.92);
      alpha = max(alpha, zAxisMask * 0.72);
    }

    alpha *= fade;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

export class InfiniteGroundGrid extends T.Mesh {
  constructor() {
    const geo = new T.BufferGeometry();
    geo.setAttribute(
      "position",
      new T.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    const mat = new T.ShaderMaterial({
      uniforms: {
        uOrigin00: { value: new T.Vector3() },
        uOriginX: { value: new T.Vector3() },
        uOriginY: { value: new T.Vector3() },
        uDir00: { value: new T.Vector3() },
        uDirX: { value: new T.Vector3() },
        uDirY: { value: new T.Vector3() },
        uViewProj: { value: new T.Matrix4() },
        uCamPos: { value: new T.Vector3() },
        uGridFadeDist: { value: 450.0 },
        uGridLevel: { value: -1.0 },
        uGridFrac: { value: 0.0 },
      },
      vertexShader: GRID_VERTEX_SHADER,
      fragmentShader: GRID_FRAGMENT_SHADER,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: T.DoubleSide,
    });
    super(geo, mat);
    this.frustumCulled = false;
    this.renderOrder = -5;
    this._vp = new T.Matrix4();
    this._n00 = new T.Vector3();
    this._n10 = new T.Vector3();
    this._n01 = new T.Vector3();
    this._m00 = new T.Vector3();
    this._m10 = new T.Vector3();
    this._m01 = new T.Vector3();
  }

  /**
   * Update exact 64-bit frustum near/mid ray corners from current camera (perspective or orthographic).
   * @param {T.Camera} camera
   * @param {number} [sceneRadius=10]
   */
  update(camera, sceneRadius = 10) {
    if (!this.visible || !camera) return;
    camera.updateMatrixWorld();
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.material.uniforms.uViewProj.value.copy(this._vp);
    this.material.uniforms.uCamPos.value.copy(camera.position);

    // Compute exact 64-bit ray origins & perspective-invariant directions in CPU JS!
    // Perspective: constant ray origin = camera.position; rayDir linearly interpolated on z=1 plane (exact!).
    // Orthographic: ray origin interpolated on near plane; constant rayDir = camera forward!
    const u = this.material.uniforms;
    if (camera.isOrthographicCamera) {
      this._n00.set(-1, -1, -1).unproject(camera);
      this._n10.set(1, -1, -1).unproject(camera);
      this._n01.set(-1, 1, -1).unproject(camera);
      camera.getWorldDirection(this._m00);
      u.uOrigin00.value.copy(this._n00);
      u.uOriginX.value.subVectors(this._n10, this._n00);
      u.uOriginY.value.subVectors(this._n01, this._n00);
      u.uDir00.value.copy(this._m00);
      u.uDirX.value.set(0, 0, 0);
      u.uDirY.value.set(0, 0, 0);
    } else {
      // Unproject frustum corners at z_ndc = 0.5 (well away from near plane) and subtract camera.position in 64-bit!
      this._m00.set(-1, -1, 0.5).unproject(camera).sub(camera.position);
      this._m10.set(1, -1, 0.5).unproject(camera).sub(camera.position);
      this._m01.set(-1, 1, 0.5).unproject(camera).sub(camera.position);
      // Scale all 3 vectors uniformly so their length is ~1.0 (preserves exact linear screen interpolation!)
      const invLen = 1 / Math.max(1e-6, this._m00.length());
      this._m00.multiplyScalar(invLen);
      this._m10.multiplyScalar(invLen);
      this._m01.multiplyScalar(invLen);

      u.uOrigin00.value.copy(camera.position);
      u.uOriginX.value.set(0, 0, 0);
      u.uOriginY.value.set(0, 0, 0);
      u.uDir00.value.copy(this._m00);
      u.uDirX.value.subVectors(this._m10, this._m00);
      u.uDirY.value.subVectors(this._m01, this._m00);
    }

    const camHeight = Math.abs(camera.position.y);
    let refDist;
    if (camera.isOrthographicCamera) {
      refDist = Math.max(0.2, Math.abs(camera.top - camera.bottom) / Math.max(0.01, camera.zoom) * 0.6);
    } else {
      refDist = Math.max(0.2, camHeight, camera.position.length() * 0.32);
    }
    const logD = Math.log10(Math.max(0.12, refDist * 0.42));
    const level = Math.floor(logD) - 1;
    const frac = logD - Math.floor(logD);
    u.uGridLevel.value = level;
    u.uGridFrac.value = frac;
    u.uGridFadeDist.value = Math.max(120, sceneRadius * 18, refDist * 26);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const BOUNDS_FRONT_VERT = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BOUNDS_FRONT_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform sampler2D uSplatDepthTex;
  uniform vec2 uResolution;
  uniform float uHasDepthTex;
  void main() {
    float op = uOpacity;
    if (uHasDepthTex > 0.5) {
      vec2 uv = gl_FragCoord.xy / max(vec2(1.0), uResolution);
      float splatZ = texture2D(uSplatDepthTex, uv).r;
      if (splatZ < 0.9999 && gl_FragCoord.z > splatZ + 0.0006) {
        discard;
      }
    }
    gl_FragColor = vec4(uColor, op);
  }
`;

/**
 * Full-Extent 8-corner L-bracket wireframe bounding box (M05).
 * Draws 24 orthogonal corner ticks (3 ticks per corner × 8 corners) at the TRUE outermost
 * extent of ALL active (non-deleted, non-hidden) Gaussian points, following every edit & transform,
 * and supporting real foreground Gaussian occlusion!
 *
 * Performance & Precision Contract:
 * - `recomputeLocalBoxes(cloud)` scans 100% of active points in a single zero-allocation O(N)
 *   min/max pass (NO subsampling, NO percentile trimming, NO alpha skipping).
 * - Real-time transforms (`syncFromSceneObjects`) transform ONLY the 8 cached local corners in O(K).
 * - Occlusion: back-half corners render before transparent splats (`renderOrder = -2`) so foreground
 *   splats naturally alpha-occlude them at 0ms GPU cost; front-half corners render at `renderOrder = 16`
 *   with hardware depthTest (Centers mode) + optional Gaussian core depth-texture occlusion (Splat/Ring).
 */
export class ModelCornerBounds extends T.Group {
  constructor() {
    super();
    this.frustumCulled = false;

    const backPos = new Float32Array(48 * 3);
    this._backGeo = new T.BufferGeometry();
    this._backGeo.setAttribute("position", new T.BufferAttribute(backPos, 3));
    this._backGeo.setDrawRange(0, 0);
    this._backMat = new T.LineBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.78,
      depthTest: true,
      depthWrite: false,
    });
    this.backLines = new T.LineSegments(this._backGeo, this._backMat);
    this.backLines.frustumCulled = false;
    this.backLines.renderOrder = -2; // Drawn BEFORE transparent splats -> naturally occluded by foreground splats!
    this.add(this.backLines);

    const frontPos = new Float32Array(48 * 3);
    this._frontGeo = new T.BufferGeometry();
    this._frontGeo.setAttribute("position", new T.BufferAttribute(frontPos, 3));
    this._frontGeo.setDrawRange(0, 0);
    this._frontMat = new T.ShaderMaterial({
      uniforms: {
        uColor: { value: new T.Color(0xe2e8f0) },
        uOpacity: { value: 0.84 },
        uSplatDepthTex: { value: null },
        uResolution: { value: new T.Vector2(1, 1) },
        uHasDepthTex: { value: 0.0 },
      },
      vertexShader: BOUNDS_FRONT_VERT,
      fragmentShader: BOUNDS_FRONT_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    this.frontLines = new T.LineSegments(this._frontGeo, this._frontMat);
    this.frontLines.frustumCulled = false;
    this.frontLines.renderOrder = 16;
    this.add(this.frontLines);

    // Alias for backward compatibility with any external geometry accessor
    this.geometry = this._frontGeo;
    this.material = this._frontMat;

    this.userEnabled = true;
    this.hasValidBounds = false;
    this.min = new T.Vector3();
    this.max = new T.Vector3();
    this._center = new T.Vector3();
    this._camFwd = new T.Vector3();
    this._tmpDiff = new T.Vector3();
    /** @type {T.Vector3[]} Deterministic 8 world-space corners indexed by (ix<<2)|(iy<<1)|iz */
    this.worldCorners = Array.from({ length: 8 }, () => new T.Vector3());
    /** @type {Map<number, { min: T.Vector3, max: T.Vector3, corners: T.Vector3[] }>} */
    this._localBoxes = new Map();
    this._lastMatrixSig = "";
    this._lastBaseSig = "";
    this._lastWasExact = false;
    this.recomputeScanCount = 0;
  }

  _writeCornerBrackets(corners8) {
    this.min.set(Infinity, Infinity, Infinity);
    this.max.set(-Infinity, -Infinity, -Infinity);
    for (let idx = 0; idx < 8; idx++) {
      const c = corners8[idx];
      this.worldCorners[idx].copy(c);
      this.min.min(c);
      this.max.max(c);
    }
    this._center.addVectors(this.min, this.max).multiplyScalar(0.5);
    this._writeAllToFrontDefault();
    this.hasValidBounds = true;
    this.visible = this.userEnabled;
  }

  _writeAllToFrontDefault() {
    const fArr = this._frontGeo.attributes.position.array;
    const tickFrac = 0.16;
    let fPtr = 0;
    const pushSeg = (arr, ptr, a, b) => {
      arr[ptr++] = a.x; arr[ptr++] = a.y; arr[ptr++] = a.z;
      arr[ptr++] = a.x + (b.x - a.x) * tickFrac;
      arr[ptr++] = a.y + (b.y - a.y) * tickFrac;
      arr[ptr++] = a.z + (b.z - a.z) * tickFrac;
      return ptr;
    };
    for (let idx = 0; idx < 8; idx++) {
      const c = this.worldCorners[idx];
      fPtr = pushSeg(fArr, fPtr, c, this.worldCorners[idx ^ 4]);
      fPtr = pushSeg(fArr, fPtr, c, this.worldCorners[idx ^ 2]);
      fPtr = pushSeg(fArr, fPtr, c, this.worldCorners[idx ^ 1]);
    }
    this._frontGeo.attributes.position.needsUpdate = true;
    this._frontGeo.setDrawRange(0, fPtr / 3);
    this._backGeo.setDrawRange(0, 0);
  }

  /**
   * Split the 24 corner ticks into back-half (occluded by transparent splats via renderOrder = -2)
   * and front-half (occluded by hardware depth buffer or Gaussian core depth texture).
   * Costs < 0.005 ms per frame (only 8 corners / 24 segments).
   */
  updateOcclusion(camera, { displayMode = "splat", splatDepthTex = null, viewportW = 1, viewportH = 1 } = {}) {
    if (!this.hasValidBounds || !this.visible || !camera) return;
    const u = this._frontMat.uniforms;
    u.uResolution.value.set(Math.max(1, viewportW), Math.max(1, viewportH));

    if (displayMode === "centers") {
      // Centers mode writes hardware depth directly -> single crisp depth-tested pass!
      u.uSplatDepthTex.value = null;
      u.uHasDepthTex.value = 0.0;
      this._writeAllToFrontDefault();
      return;
    }

    u.uSplatDepthTex.value = splatDepthTex || null;
    u.uHasDepthTex.value = splatDepthTex ? 1.0 : 0.0;

    camera.getWorldDirection(this._camFwd);
    const bArr = this._backGeo.attributes.position.array;
    const fArr = this._frontGeo.attributes.position.array;
    const tickFrac = 0.16;
    let bPtr = 0;
    let fPtr = 0;
    const pushSeg = (arr, ptr, a, b) => {
      arr[ptr++] = a.x; arr[ptr++] = a.y; arr[ptr++] = a.z;
      arr[ptr++] = a.x + (b.x - a.x) * tickFrac;
      arr[ptr++] = a.y + (b.y - a.y) * tickFrac;
      arr[ptr++] = a.z + (b.z - a.z) * tickFrac;
      return ptr;
    };

    for (let idx = 0; idx < 8; idx++) {
      const c = this.worldCorners[idx];
      const depthRel = this._tmpDiff.subVectors(c, this._center).dot(this._camFwd);
      const isBack = depthRel >= 0;
      const neighbors = [this.worldCorners[idx ^ 4], this.worldCorners[idx ^ 2], this.worldCorners[idx ^ 1]];
      for (let k = 0; k < 3; k++) {
        if (isBack) bPtr = pushSeg(bArr, bPtr, c, neighbors[k]);
        else fPtr = pushSeg(fArr, fPtr, c, neighbors[k]);
      }
    }
    this._backGeo.attributes.position.needsUpdate = true;
    this._backGeo.setDrawRange(0, bPtr / 3);
    this._frontGeo.attributes.position.needsUpdate = true;
    this._frontGeo.setDrawRange(0, fPtr / 3);
  }

  setBox(minVec, maxVec) {
    const sx = maxVec.x - minVec.x;
    const sy = maxVec.y - minVec.y;
    const sz = maxVec.z - minVec.z;
    if (!(sx > 1e-6 || sy > 1e-6 || sz > 1e-6)) {
      this.hasValidBounds = false;
      this.visible = false;
      return;
    }
    const xs = [minVec.x, maxVec.x];
    const ys = [minVec.y, maxVec.y];
    const zs = [minVec.z, maxVec.z];
    const corners = [];
    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let iz = 0; iz < 2; iz++) {
          corners.push(new T.Vector3(xs[ix], ys[iy], zs[iz]));
        }
      }
    }
    this._writeCornerBrackets(corners);
  }

  setOrientedBox(localMin, localMax, worldMatrix4) {
    const sx = localMax.x - localMin.x;
    const sy = localMax.y - localMin.y;
    const sz = localMax.z - localMin.z;
    if (!(sx > 1e-6 || sy > 1e-6 || sz > 1e-6)) {
      this.hasValidBounds = false;
      this.visible = false;
      return;
    }
    const xs = [localMin.x, localMax.x];
    const ys = [localMin.y, localMax.y];
    const zs = [localMin.z, localMax.z];
    const corners = [];
    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let iz = 0; iz < 2; iz++) {
          corners.push(new T.Vector3(xs[ix], ys[iy], zs[iz]).applyMatrix4(worldMatrix4));
        }
      }
    }
    this._writeCornerBrackets(corners);
  }

  /**
   * Recompute per-object LOCAL bounding boxes from 100% of active (non-deleted, non-hidden) points.
   * Zero subsampling, zero percentile trimming -> brackets always mark true outermost model extent!
   */
  recomputeLocalBoxes(cloud) {
    this._localBoxes.clear();
    this._lastMatrixSig = "";
    this._lastBaseSig = "";
    this._lastWasExact = false;
    if (!cloud || cloud.n === 0) {
      this.hasValidBounds = false;
      this.visible = false;
      return;
    }
    this.recomputeScanCount++;
    const n = cloud.n;
    const flags = cloud.flags;
    const objIds = cloud.objectIds;
    const pos = cloud.pos;

    /** @type {Map<number, Float64Array>} [minX, minY, minZ, maxX, maxY, maxZ] */
    const extrema = new Map();
    for (let i = 0; i < n; i++) {
      if (flags[i] & 6) continue; // skip FLAG_DELETED (2) | FLAG_HIDDEN (4)
      const j = i * 3;
      const x = pos[j], y = pos[j + 1], z = pos[j + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const oid = objIds[i];
      let b = extrema.get(oid);
      if (!b) {
        b = new Float64Array([x, y, z, x, y, z]);
        extrema.set(oid, b);
      } else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (z < b[2]) b[2] = z;
        if (x > b[3]) b[3] = x;
        if (y > b[4]) b[4] = y;
        if (z > b[5]) b[5] = z;
      }
    }

    for (const [oid, b] of extrema.entries()) {
      const min = new T.Vector3(b[0], b[1], b[2]);
      const max = new T.Vector3(b[3], b[4], b[5]);
      const xs = [min.x, max.x], ys = [min.y, max.y], zs = [min.z, max.z];
      const corners = [];
      for (let ix = 0; ix < 2; ix++) {
        for (let iy = 0; iy < 2; iy++) {
          for (let iz = 0; iz < 2; iz++) {
            corners.push(new T.Vector3(xs[ix], ys[iy], zs[iz]));
          }
        }
      }
      this._localBoxes.set(oid, { min, max, corners });
    }
  }

  /**
   * Always-Horizontal/Vertical World AABB corner update (rc8 #2A):
   * - Edges stay strictly parallel to world X/Z ground and vertical along +Y (NEVER tilted OBB!).
   * - Fast mode (during drag): O(K) transforms of cached 8 local corners -> world min/max at 0ms/120FPS.
   * - Exact mode (on drag end / selection change / model edits): full 100% point scan in world space
   *   so rotated models get an exact tight World AABB with zero 45° slack!
   */
  syncFromSceneObjects(sceneObjects, activeObjectIds = null, { cloud = null, exactScan = false } = {}) {
    if (!sceneObjects || sceneObjects.length === 0 || this._localBoxes.size === 0) {
      this.hasValidBounds = false;
      this.visible = false;
      return;
    }
    const filterActive = activeObjectIds && activeObjectIds.size > 0;
    const activeEntries = [];
    for (const obj of sceneObjects) {
      if (obj.visible === false) continue;
      if (filterActive && !activeObjectIds.has(obj.id)) continue;
      const lb = this._localBoxes.get(obj.id);
      if (!lb) continue;
      activeEntries.push({ obj, lb });
    }
    if (activeEntries.length === 0) {
      this.hasValidBounds = false;
      this.visible = false;
      return;
    }

    // Build transform + selection signature; preserve exact scan result when matrices haven't changed!
    let baseSig = `${activeEntries.length}|`;
    for (const { obj } of activeEntries) {
      const e = obj.node.matrixWorld.elements;
      baseSig += `${obj.id}:${e[0].toFixed(5)},${e[1].toFixed(5)},${e[2].toFixed(5)},${e[4].toFixed(5)},${e[5].toFixed(5)},${e[6].toFixed(5)},${e[8].toFixed(5)},${e[9].toFixed(5)},${e[10].toFixed(5)},${e[12].toFixed(5)},${e[13].toFixed(5)},${e[14].toFixed(5)}|`;
    }
    const wantExact = !!(exactScan && cloud && cloud.n > 0);
    if (this.hasValidBounds && baseSig === this._lastBaseSig && (!wantExact || this._lastWasExact)) {
      this.visible = this.userEnabled;
      return;
    }
    this._lastBaseSig = baseSig;
    this._lastMatrixSig = baseSig;

    if (wantExact) {
      this._lastWasExact = true;
      const activeSet = new Set(activeEntries.map((x) => x.obj.id));
      const matElems = new Map();
      for (const { obj } of activeEntries) {
        matElems.set(obj.id, obj.node.matrixWorld.elements);
      }
      const n = cloud.n;
      const flags = cloud.flags;
      const objIds = cloud.objectIds;
      const pos = cloud.pos;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let found = false;
      for (let i = 0; i < n; i++) {
        if (flags[i] & 6) continue;
        const oid = objIds[i];
        if (!activeSet.has(oid)) continue;
        const m = matElems.get(oid);
        const j = i * 3;
        const lx = pos[j], ly = pos[j + 1], lz = pos[j + 2];
        const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
        const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
        const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
        if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) continue;
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
        if (wz > maxZ) maxZ = wz;
        found = true;
      }
      if (found) {
        this.recomputeScanCount++;
        this.setBox(new T.Vector3(minX, minY, minZ), new T.Vector3(maxX, maxY, maxZ));
        return;
      }
    }

    // Fast O(K) World AABB from K*8 cached local corners (strictly parallel/perpendicular to ground!)
    this._lastWasExact = false;
    const wMin = new T.Vector3(Infinity, Infinity, Infinity);
    const wMax = new T.Vector3(-Infinity, -Infinity, -Infinity);
    const tmp = new T.Vector3();
    for (const { obj, lb } of activeEntries) {
      const m = obj.node.matrixWorld;
      for (let k = 0; k < 8; k++) {
        tmp.copy(lb.corners[k]).applyMatrix4(m);
        wMin.min(tmp);
        wMax.max(tmp);
      }
    }
    this.setBox(wMin, wMax);
  }

  updateFromCloud(cloud, activeObjectIds = null) {
    this.recomputeLocalBoxes(cloud);
    if (!cloud || this._localBoxes.size === 0) return;
    const pseudoObjects = [];
    for (const oid of this._localBoxes.keys()) {
      if (cloud.objectVisibility.get(oid) === false) continue;
      const mat = cloud.objectMatrices[oid] || new T.Matrix4();
      pseudoObjects.push({ id: oid, visible: true, node: { matrixWorld: mat } });
    }
    this.syncFromSceneObjects(pseudoObjects, activeObjectIds);
  }

  getWorldCorners() {
    if (!this.hasValidBounds) return [];
    return this.worldCorners.map((c) => [c.x, c.y, c.z]);
  }

  getCenter(outVec = new T.Vector3()) {
    if (!this.hasValidBounds) return null;
    return outVec.copy(this._center);
  }

  getLocalBox(objId = 0) {
    const lb = this._localBoxes.get(objId);
    if (!lb) return null;
    return {
      min: [lb.min.x, lb.min.y, lb.min.z],
      max: [lb.max.x, lb.max.y, lb.max.z],
      corners: lb.corners.map((c) => [c.x, c.y, c.z]),
    };
  }

  setUserEnabled(enabled) {
    this.userEnabled = !!enabled;
    this.visible = this.userEnabled && this.hasValidBounds;
  }

  dispose() {
    this._localBoxes.clear();
    this._backGeo.dispose();
    this._backMat.dispose();
    this._frontGeo.dispose();
    this._frontMat.dispose();
  }
}
