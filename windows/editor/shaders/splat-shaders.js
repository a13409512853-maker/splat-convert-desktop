// Extracted WebGL2 GLSL Shaders for 3D Gaussian Splatting Renderer (Splat / Rings / Centers / 32-bit Pick).
// Pure shader template strings — ZERO DOM, ZERO renderer side effects.
import { MAX_SCENE_OBJECTS } from "../constants.js";

export const COMMON_GLSL_HELPERS = /* glsl */ `
  vec3 rgb2hsl(vec3 c) {
    float maxc = max(max(c.r, c.g), c.b);
    float minc = min(min(c.r, c.g), c.b);
    float l = (maxc + minc) * 0.5;
    float d = maxc - minc;
    float h = 0.0;
    float s = 0.0;
    if (d > 1e-6) {
      s = l < 0.5 ? d / (maxc + minc) : d / (2.0 - maxc - minc);
      if (maxc == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
      else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
      else h = (c.r - c.g) / d + 4.0;
      h *= 0.16666667;
    }
    return vec3(h, s, l);
  }
  float hue2rgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 0.16666667) return p + (q - p) * 6.0 * t;
    if (t < 0.5) return q;
    if (t < 0.66666667) return p + (q - p) * (0.66666667 - t) * 6.0;
    return p;
  }
  vec3 hsl2rgb(vec3 hsl) {
    if (hsl.y < 1e-6) return vec3(hsl.z);
    float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
    float p = 2.0 * hsl.z - q;
    return vec3(
      hue2rgb(p, q, hsl.x + 0.33333333),
      hue2rgb(p, q, hsl.x),
      hue2rgb(p, q, hsl.x - 0.33333333)
    );
  }
`;

export const PROJECT_ELLIPSE_GLSL = /* glsl */ `
  vec4 ls = texelFetch(uScaleTex, tc, 0);
  vec4 q = texelFetch(uQuatTex, tc, 0);
  vec3 sc = exp(clamp(ls.xyz, -18.0, 10.0));

  float x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z;
  float xx = q.x * x2, xy = q.x * y2, xz = q.x * z2;
  float yy = q.y * y2, yz = q.y * z2, zz = q.z * z2;
  float wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;

  // M = R * diag(sc) in GLSL column-major order
  mat3 M = mat3(
    vec3(1.0 - (yy + zz), xy + wz, xz - wy) * sc.x,
    vec3(xy - wz, 1.0 - (xx + zz), yz + wx) * sc.y,
    vec3(xz + wy, yz - wx, 1.0 - (xx + yy)) * sc.z
  );

  float fx = projectionMatrix[0][0] * uResolution.x * 0.5;
  float fy = projectionMatrix[1][1] * uResolution.y * 0.5;

  mat3 J;
  if (uIsOrtho == 1) {
    J = mat3(
      fx, 0.0, 0.0,
      0.0, fy, 0.0,
      0.0, 0.0, 0.0
    );
  } else {
    float z = -camPos.z;
    float invZ = 1.0 / max(0.02, z);
    float invZ2 = invZ * invZ;
    float tanHalfX = 1.0 / max(1e-4, projectionMatrix[0][0]);
    float tanHalfY = 1.0 / max(1e-4, projectionMatrix[1][1]);
    float tx = clamp(camPos.x * invZ, -1.3 * tanHalfX, 1.3 * tanHalfX) * z;
    float ty = clamp(camPos.y * invZ, -1.3 * tanHalfY, 1.3 * tanHalfY) * z;
    J = mat3(
      fx * invZ, 0.0, -fx * tx * invZ2,
      0.0, fy * invZ, -fy * ty * invZ2,
      0.0, 0.0, 0.0
    );
  }

  // TM = (transpose(J) * W) * M  =>  cov2d = TM * transpose(TM)
  mat3 TM = (transpose(J) * mat3(mvMat)) * M;
  mat3 cov2d = TM * transpose(TM);

  float a = cov2d[0][0] + 0.3;
  float b = cov2d[0][1];
  float c = cov2d[1][1] + 0.3;

  float mid = 0.5 * (a + c);
  float disc = sqrt(max(0.01, (a - c) * (a - c) * 0.25 + b * b));
  float lambda1 = max(0.1, mid + disc);
  float lambda2 = max(0.1, mid - disc);

  float maxPx = uRenderMode == 2
    ? min(uMaxSplatPx * 0.85, max(uResolution.x, uResolution.y) * 0.18)
    : min(uMaxSplatPx, max(uResolution.x, uResolution.y) * 0.28);
  float tightK = (uRenderMode == 1)
    ? clamp(sqrt(max(0.0, log(max(1.01, baseCol.a * 255.0)) * 0.25)), 0.18, 1.0)
    : 1.0;
  float rad1 = min(maxPx, 2.828427 * sqrt(lambda1) * tightK);
  float rad2 = min(maxPx, 2.828427 * sqrt(lambda2) * tightK);
  if (uRenderMode != 0 && (rad1 < (uRenderMode == 2 ? 0.65 : 0.45) || (rad1 * rad2 < 0.18 && baseCol.a < 0.25))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 diagVec = normalize(vec2(b, lambda1 - a) + vec2(1e-6, 0.0));
  if (abs(b) < 1e-6 && a >= c) diagVec = vec2(1.0, 0.0);
  else if (abs(b) < 1e-6 && a < c) diagVec = vec2(0.0, 1.0);
  vec2 axis1 = diagVec * rad1;
  vec2 axis2 = vec2(-diagVec.y, diagVec.x) * rad2;

  vec2 pxOffset = corner.x * axis1 + corner.y * axis2;
  vec2 ndcCenter = clipPos.xy / clipPos.w;
  vec2 ndcOffset = (pxOffset * 2.0) / uResolution;
  vUv = corner * tightK;
  gl_Position = vec4(ndcCenter + ndcOffset, clipPos.z / clipPos.w, 1.0);
`;

export const COLOR_GRADE_UNIFORMS_GLSL = /* glsl */ `
  uniform float uGradeEnabled;
  uniform float uExposure;
  uniform float uBrightness;
  uniform float uContrast;
  uniform float uBlackPoint;
  uniform float uWhitePoint;
  uniform float uOutBlack;
  uniform float uOutWhite;
  uniform float uHighlights;
  uniform float uShadows;
  uniform float uWhites;
  uniform float uBlacks;
  uniform float uSaturation;
  uniform float uVibrance;
  uniform float uTemperature;
  uniform float uTintShift;
  uniform vec3 uTint;
  uniform float uGamma;
  uniform float uTransparency;
  uniform float uHslActive;
  uniform float uHslCenters[8];
  uniform float uHslHalfWidths[8];
  uniform float uHslHue[8];
  uniform float uHslSat[8];
  uniform float uHslLight[8];
  uniform float uPointColorActive;
  uniform vec3 uPointColorTarget;
  uniform vec4 uPointColorParams; // (tolerance, colorRange, visualizeRange, 0)
  uniform vec3 uPointColorShift;  // (hue, sat, light)
  uniform sampler2D uLutTex;
  uniform float uLutIntensity;

  // Non-destructive 3DGS Heap Measurement Temporary View Modes (rc9: 0=Std, 1=Translucent, 2=Heatmap, 3=GridCompare)
  uniform int uMeasureVizMode;
  uniform vec3 uMeasureOrigin;
  uniform vec3 uMeasureNormal;
  uniform vec3 uMeasureAxisU;
  uniform vec3 uMeasureAxisV;
  uniform vec4 uMeasurePolyBounds;     // (minU, minV, maxU, maxV)
  uniform vec4 uMeasureVizParams;      // (maxHeight, translucentAlpha, gridGhostAlpha, 0)
  uniform int uMeasurePolyCount;       // up to 48 vertices packed 2 per vec4
  uniform vec4 uMeasurePolyPacked[24]; // xy = vertex 2k, zw = vertex 2k+1

  // Real-Time GPU Active Bounding Volume Containment Highlight (rc12 #4.3: 120 FPS zero-CPU-stall!)
  uniform int uVolScopeActive;
  uniform int uVolPrimCount;
  uniform int uVolOpCount;
  uniform int uVolPrimKind[24];
  uniform float uVolPlaneSigns[24];
  uniform mat4 uVolInvMats[24];
  uniform int uVolOps[48];
  uniform float uVolSelectableObj[${MAX_SCENE_OBJECTS}];
`;

export const COLOR_GRADE_FUNCTIONS_GLSL = /* glsl */ `
  bool evalVolScopePrim(int idx, vec3 wp) {
    vec3 p = (uVolInvMats[idx] * vec4(wp, 1.0)).xyz;
    int k = uVolPrimKind[idx];
    if (k == 0) return abs(p.x) <= 1.0 && abs(p.y) <= 1.0 && abs(p.z) <= 1.0;
    if (k == 1) return dot(p, p) <= 1.0;
    if (k == 2) return (p.x * p.x + p.z * p.z) <= 1.0 && abs(p.y) <= 1.0;
    return (p.z * uVolPlaneSigns[idx]) >= 0.0;
  }

  bool evalActiveVolScope(vec3 wp) {
    if (uVolScopeActive == 0 || uVolPrimCount <= 0 || uVolOpCount <= 0) return false;
    bool st[16];
    int sp = 0;
    for (int i = 0; i < 48; i++) {
      if (i >= uVolOpCount) break;
      int packed = uVolOps[i];
      int op = packed & 3;
      if (op == 0) {
        if (sp < 16) st[sp++] = evalVolScopePrim(packed >> 2, wp);
      } else if (sp >= 2) {
        bool b = st[--sp];
        bool a = st[--sp];
        if (op == 1) st[sp++] = a || b;
        else if (op == 2) st[sp++] = a && !b;
        else st[sp++] = a && b;
      }
    }
    return sp > 0 ? st[sp - 1] : false;
  }
  vec2 fetchMeasureVertex(int idx) {
    int slot = idx >> 1;
    vec4 packed = uMeasurePolyPacked[slot];
    return (idx & 1) == 0 ? packed.xy : packed.zw;
  }

  bool pointInMeasurePoly(vec2 p) {
    if (uMeasurePolyCount < 3) return false;
    if (p.x < uMeasurePolyBounds.x || p.x > uMeasurePolyBounds.z || p.y < uMeasurePolyBounds.y || p.y > uMeasurePolyBounds.w) {
      return false;
    }
    int wn = 0;
    vec2 vPrev = fetchMeasureVertex(uMeasurePolyCount - 1);
    for (int i = 0; i < 48; i++) {
      if (i >= uMeasurePolyCount) break;
      vec2 vCur = fetchMeasureVertex(i);
      if (vPrev.y <= p.y) {
        if (vCur.y > p.y && (vCur.x - vPrev.x) * (p.y - vPrev.y) - (p.x - vPrev.x) * (vCur.y - vPrev.y) > 0.0) {
          wn++;
        }
      } else {
        if (vCur.y <= p.y && (vCur.x - vPrev.x) * (p.y - vPrev.y) - (p.x - vPrev.x) * (vCur.y - vPrev.y) < 0.0) {
          wn--;
        }
      }
      vPrev = vCur;
    }
    return wn != 0;
  }

  vec3 heightHeatmapRamp(float t) {
    float x = clamp(t, 0.0, 1.0);
    vec3 c0 = vec3(0.11, 0.34, 0.96);
    vec3 c1 = vec3(0.06, 0.78, 0.92);
    vec3 c2 = vec3(0.20, 0.86, 0.36);
    vec3 c3 = vec3(0.98, 0.82, 0.14);
    vec3 c4 = vec3(0.96, 0.18, 0.16);
    if (x < 0.25) return mix(c0, c1, x * 4.0);
    if (x < 0.50) return mix(c1, c2, (x - 0.25) * 4.0);
    if (x < 0.75) return mix(c2, c3, (x - 0.50) * 4.0);
    return mix(c3, c4, (x - 0.75) * 4.0);
  }

  vec4 applyMeasureVizOverride(vec4 col, vec3 worldPos) {
    if (uMeasureVizMode == 0 || uMeasurePolyCount < 3) return col;
    vec3 rel = worldPos - uMeasureOrigin;
    vec2 uv = vec2(dot(rel, uMeasureAxisU), dot(rel, uMeasureAxisV));
    if (!pointInMeasurePoly(uv)) return col;
    float h = dot(rel, uMeasureNormal);
    float maxH = max(0.02, uMeasureVizParams.x);
    if (h < -maxH * 0.22) return col;
    if (uMeasureVizMode == 1) {
      return vec4(col.rgb, col.a * uMeasureVizParams.y);
    } else if (uMeasureVizMode == 2) {
      vec3 heat = heightHeatmapRamp(h / maxH);
      return vec4(mix(col.rgb, heat, 0.78), col.a);
    } else if (uMeasureVizMode == 3) {
      return vec4(col.rgb, col.a * uMeasureVizParams.z);
    }
    return col;
  }
  vec3 sampleLut(vec3 c) {
    vec3 cl = clamp(c, 0.0, 1.0);
    float bScaled = cl.b * 15.0;
    float b0 = floor(bScaled);
    float b1 = min(15.0, b0 + 1.0);
    float fb = bScaled - b0;

    float uOffset = (cl.r * 15.0 + 0.5) / 256.0;
    float vCoord = (cl.g * 15.0 + 0.5) / 16.0;
    vec3 col0 = texture2D(uLutTex, vec2(b0 / 16.0 + uOffset, vCoord)).rgb;
    vec3 col1 = texture2D(uLutTex, vec2(b1 / 16.0 + uOffset, vCoord)).rgb;
    return mix(col0, col1, fb);
  }

  float smooth01(float t) {
    float c = clamp(t, 0.0, 1.0);
    return c * c * (3.0 - 2.0 * c);
  }

  vec4 applyLiveGrade(vec3 c, float a) {
    float expGain = exp2(uExposure);
    float invSpan = 1.0 / max(0.001, uWhitePoint - uBlackPoint);
    vec3 tintVec = uTint * vec3(1.0 + uTintShift * 0.22, 1.0 - uTintShift * 0.45, 1.0 + uTintShift * 0.22);
    vec3 s = expGain * invSpan * tintVec * vec3(1.0 + uTemperature, 1.0, 1.0 - uTemperature);
    vec3 cr = (c - vec3(uBlackPoint)) * s + vec3(uBrightness);
    cr = (cr - 0.5) * uContrast + 0.5;

    if (abs(uShadows) > 0.0001 || abs(uHighlights) > 0.0001 || abs(uBlacks) > 0.0001 || abs(uWhites) > 0.0001) {
      float lum = clamp(dot(cr, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
      float invL = 1.0 - lum;
      float shW = invL * invL;
      float hiW = lum * lum;
      float blW = shW * invL;
      float whW = hiW * lum;
      cr += vec3(uShadows * 0.34 * shW + uHighlights * 0.34 * hiW + uBlacks * 0.28 * blW + uWhites * 0.28 * whW);
    }

    if (abs(uVibrance) > 0.0001) {
      float cMax = max(max(cr.r, cr.g), cr.b);
      float cMin = min(min(cr.r, cr.g), cr.b);
      float curSat = clamp(cMax - cMin, 0.0, 1.0);
      float greyV = dot(cr, vec3(0.299, 0.587, 0.114));
      float vibGain = 1.0 + uVibrance * (1.0 - curSat) * 0.85;
      cr = mix(vec3(greyV), cr, vibGain);
    }

    float grey = dot(cr, vec3(0.299, 0.587, 0.114));
    cr = clamp(mix(vec3(grey), cr, uSaturation), 0.0, 1.0);

    if (abs(uGamma - 1.0) > 0.001) {
      cr = pow(max(cr, vec3(0.0001)), vec3(1.0 / max(0.1, uGamma)));
    }

    if (uHslActive > 0.5) {
      vec3 hsl = rgb2hsl(cr);
      float tw = 0.0, sh = 0.0, ss = 0.0, sl = 0.0;
      for (int i = 0; i < 8; i++) {
        float d = abs(hsl.x - uHslCenters[i]);
        d = min(d, 1.0 - d);
        float hw = uHslHalfWidths[i];
        if (d < hw) {
          float t = 1.0 - d / hw;
          float w = t * t * (3.0 - 2.0 * t);
          tw += w;
          sh += w * uHslHue[i];
          ss += w * uHslSat[i];
          sl += w * uHslLight[i];
        }
      }
      if (tw > 0.0001) {
        float invW = 1.0 / tw;
        hsl.x = fract(hsl.x + sh * invW + 1.0);
        hsl.y = clamp(hsl.y + ss * invW, 0.0, 1.0);
        hsl.z = clamp(hsl.z + sl * invW, 0.0, 1.0);
        cr = hsl2rgb(hsl);
      }
    }

    if (uPointColorActive > 0.5) {
      vec3 hsl = rgb2hsl(cr);
      float dh = abs(hsl.x - uPointColorTarget.x);
      dh = min(dh, 1.0 - dh);
      float hw = max(0.015, uPointColorParams.x * 0.36);
      float wh = smooth01(1.0 - dh / hw);

      float colorRange = uPointColorParams.y;
      float satTol = 0.14 + colorRange * 0.86;
      float ds = abs(hsl.y - uPointColorTarget.y);
      float ws = smooth01(1.0 - max(0.0, ds - satTol * 0.32) / (satTol * 0.68 + 0.0001));

      float lumTol = 0.18 + colorRange * 0.82;
      float dl = abs(hsl.z - uPointColorTarget.z);
      float wl = smooth01(1.0 - max(0.0, dl - lumTol * 0.32) / (lumTol * 0.68 + 0.0001));

      float wpPc = wh * ws * wl;
      if (uPointColorParams.z > 0.5) {
        float lumVis = dot(cr, vec3(0.299, 0.587, 0.114)) * 0.45;
        cr = mix(vec3(lumVis), cr, wpPc);
      } else if (wpPc > 0.0001) {
        hsl.x = fract(hsl.x + uPointColorShift.x * wpPc + 1.0);
        hsl.y = clamp(hsl.y + uPointColorShift.y * wpPc, 0.0, 1.0);
        hsl.z = clamp(hsl.z + uPointColorShift.z * wpPc, 0.0, 1.0);
        cr = hsl2rgb(hsl);
      }
    }

    if (uLutIntensity > 0.0001) {
      vec3 lc = sampleLut(cr);
      cr = mix(cr, lc, clamp(uLutIntensity, 0.0, 1.0));
    }

    if (abs(uOutBlack) > 0.0001 || abs(uOutWhite - 1.0) > 0.0001) {
      cr = mix(vec3(uOutBlack), vec3(uOutWhite), clamp(cr, 0.0, 1.0));
    }

    return vec4(clamp(cr, 0.0, 1.0), clamp(a * uTransparency, 0.0, 1.0));
  }
`;

export const VERTEX_SHADER = /* glsl */ `
  precision highp float;
  precision highp int;

  attribute vec2 aSplatIdx2; // (lo16, hi16) bit-exact up to 2.1B splats!

  uniform sampler2D uPosTex;
  uniform sampler2D uScaleTex;
  uniform sampler2D uQuatTex;
  uniform sampler2D uColorTex;
  uniform sampler2D uStateTex;
  uniform int uTexWidth;

  uniform mat4 uObjectMatrices[${MAX_SCENE_OBJECTS}];
  uniform int uRenderMode; // 0=centers, 1=splat, 2=rings
  uniform vec2 uResolution;
  uniform float uPointSize;
  uniform float uMaxSplatPx;
  uniform int uIsOrtho;
  uniform float uHideSelectionHighlight;

  ${COLOR_GRADE_UNIFORMS_GLSL}

  varying vec2 vUv;
  varying vec4 vGradedColor;
  varying vec4 vOrigColor;
  varying float vSelected;
  varying float vInVolume;
  varying float vGradeMask;

  ${COMMON_GLSL_HELPERS}
  ${COLOR_GRADE_FUNCTIONS_GLSL}

  void main() {
    int idx = int(aSplatIdx2.x + 0.5) + (int(aSplatIdx2.y + 0.5) << 16);
    ivec2 tc = ivec2(idx % uTexWidth, idx / uTexWidth);

    vec4 st = texelFetch(uStateTex, tc, 0);
    int flags = int(st.r * 255.0 + 0.5);
    if ((flags & 6) != 0 || st.b < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    int objId = clamp(int(st.a * 255.0 + 0.5), 0, ${MAX_SCENE_OBJECTS - 1});
    vec4 posObj = texelFetch(uPosTex, tc, 0);
    vec4 worldPos4 = uObjectMatrices[objId] * vec4(posObj.xyz, 1.0);
    mat4 mvMat = modelViewMatrix * uObjectMatrices[objId];

    vec4 camPos = mvMat * vec4(posObj.xyz, 1.0);
    vec4 clipPos = projectionMatrix * camPos;

    if (uIsOrtho == 0 && camPos.z > -0.005) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    if (abs(clipPos.x) > clipPos.w * 1.18 || abs(clipPos.y) > clipPos.w * 1.18 || abs(clipPos.z) > clipPos.w * 1.02) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec4 baseCol = texelFetch(uColorTex, tc, 0);
    if ((uRenderMode == 1 && baseCol.a < 0.008) || (uRenderMode == 2 && baseCol.a < 0.02)) {
      if ((flags & 1) == 0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
    }
    vOrigColor = baseCol;
    vGradeMask = (uGradeEnabled > 0.5 && st.g > 0.5) ? 1.0 : 0.0;
    vec4 graded = vGradeMask > 0.5 ? applyLiveGrade(baseCol.rgb, baseCol.a) : baseCol;
    if (uMeasureVizMode != 0) {
      graded = applyMeasureVizOverride(graded, worldPos4.xyz);
      vOrigColor = applyMeasureVizOverride(vOrigColor, worldPos4.xyz);
    }
    vGradedColor = graded;
    vSelected = ((flags & 1) != 0 && uHideSelectionHighlight < 0.5) ? 1.0 : 0.0;
    vInVolume =
      (uVolScopeActive == 1 &&
        uHideSelectionHighlight < 0.5 &&
        uVolSelectableObj[objId] > 0.5 &&
        evalActiveVolScope(worldPos4.xyz))
        ? 1.0
        : 0.0;

    vec2 corner = position.xy;
    vUv = corner;

    if (uRenderMode == 0) {
      float dotPx = max(1.3, uPointSize * (vSelected > 0.5 ? 1.35 : 1.0));
      vec2 ndcOffset = corner * (dotPx * 2.0 / uResolution);
      gl_Position = vec4(clipPos.xy / clipPos.w + ndcOffset, clipPos.z / clipPos.w, 1.0);
      return;
    }

    ${PROJECT_ELLIPSE_GLSL}
  }
`;

export const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform int uRenderMode; // 0=points, 1=splat, 2=rings
  uniform float uRingSize; // 0.04 (ReSplat default)
  uniform vec2 uResolution;
  uniform float uCompareOriginal;
  uniform float uSplitX;

  varying vec2 vUv;
  varying vec4 vGradedColor;
  varying vec4 vOrigColor;
  varying float vSelected;
  varying float vInVolume;
  varying float vGradeMask;

  const float EXP4 = 0.01831563888873418;
  const float INV_EXP4 = 1.018657360363774;

  float normExp(float x) {
    return (exp(-4.0 * x) - EXP4) * INV_EXP4;
  }

  void main() {
    float A = dot(vUv, vUv);
    if (A > 1.0) discard;

    bool showOriginal = false;
    if (vGradeMask > 0.5) {
      if (uCompareOriginal > 0.5) {
        showOriginal = true;
      } else if (uSplitX >= 0.0) {
        float fragNormX = gl_FragCoord.x / max(1.0, uResolution.x);
        if (fragNormX < uSplitX) showOriginal = true;
      }
    }

    vec4 col = showOriginal ? vOrigColor : vGradedColor;

    if (uRenderMode == 0) {
      vec3 rgb = col.rgb;
      if (vSelected > 0.5) rgb = mix(rgb, vec3(1.0, 0.74, 0.08), 0.88);
      else if (vInVolume > 0.5) rgb = mix(rgb, vec3(0.22, 0.84, 1.0), 0.36);
      gl_FragColor = vec4(rgb, 1.0);
      return;
    }

    float norm = normExp(A);
    float alpha = norm * col.a;
    vec3 rgb = col.rgb;

    if (uRenderMode == 2) {
      if (A < 1.0 - uRingSize) {
        alpha = max(0.04, alpha * 0.85);
      } else {
        alpha = 0.62;
        rgb = mix(rgb, vec3(1.0, 0.96, 0.88), 0.30);
      }
    }

    if (vSelected > 0.5) {
      rgb = mix(rgb, vec3(1.0, 0.72, 0.06), uRenderMode == 2 ? 0.82 : 0.76);
    } else if (vInVolume > 0.5) {
      rgb = mix(rgb, vec3(0.20, 0.82, 0.98), uRenderMode == 2 ? 0.28 : 0.24);
    }

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(rgb * alpha, alpha);
  }
`;

export const CENTERS_VERTEX_SHADER = /* glsl */ `
  precision highp float;
  precision highp int;

  attribute vec2 aSplatIdx2;

  uniform sampler2D uPosTex;
  uniform sampler2D uColorTex;
  uniform sampler2D uStateTex;
  uniform int uTexWidth;

  uniform mat4 uObjectMatrices[${MAX_SCENE_OBJECTS}];
  uniform vec2 uResolution;
  uniform float uPointSize;
  uniform int uIsOrtho;
  uniform float uHideSelectionHighlight;

  ${COLOR_GRADE_UNIFORMS_GLSL}

  varying vec4 vGradedColor;
  varying vec4 vOrigColor;
  varying float vSelected;
  varying float vInVolume;
  varying float vGradeMask;

  ${COMMON_GLSL_HELPERS}
  ${COLOR_GRADE_FUNCTIONS_GLSL}

  void main() {
    int idx = int(aSplatIdx2.x + 0.5) + (int(aSplatIdx2.y + 0.5) << 16);
    ivec2 tc = ivec2(idx % uTexWidth, idx / uTexWidth);

    vec4 st = texelFetch(uStateTex, tc, 0);
    int flags = int(st.r * 255.0 + 0.5);
    if ((flags & 6) != 0 || st.b < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    int objId = clamp(int(st.a * 255.0 + 0.5), 0, ${MAX_SCENE_OBJECTS - 1});
    vec4 posObj = texelFetch(uPosTex, tc, 0);
    vec4 worldPos4 = uObjectMatrices[objId] * vec4(posObj.xyz, 1.0);
    vec4 camPos = (modelViewMatrix * uObjectMatrices[objId]) * vec4(posObj.xyz, 1.0);
    vec4 clipPos = projectionMatrix * camPos;
    if (uIsOrtho == 0 && camPos.z > -0.005) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec4 baseCol = texelFetch(uColorTex, tc, 0);
    vOrigColor = baseCol;
    vGradeMask = (uGradeEnabled > 0.5 && st.g > 0.5) ? 1.0 : 0.0;
    vec4 graded = vGradeMask > 0.5 ? applyLiveGrade(baseCol.rgb, baseCol.a) : baseCol;
    if (uMeasureVizMode != 0) {
      graded = applyMeasureVizOverride(graded, worldPos4.xyz);
      if (uMeasureVizMode == 3 && graded.a < baseCol.a * 0.25) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
    }
    vGradedColor = graded;
    vSelected = ((flags & 1) != 0 && uHideSelectionHighlight < 0.5) ? 1.0 : 0.0;
    vInVolume =
      (uVolScopeActive == 1 &&
        uHideSelectionHighlight < 0.5 &&
        uVolSelectableObj[objId] > 0.5 &&
        evalActiveVolScope(worldPos4.xyz))
        ? 1.0
        : 0.0;

    gl_Position = clipPos;
    gl_PointSize = max(2.2, uPointSize * (vSelected > 0.5 ? 1.55 : 1.15));
  }
`;

export const CENTERS_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform vec2 uResolution;
  uniform float uCompareOriginal;
  uniform float uSplitX;
  varying vec4 vGradedColor;
  varying vec4 vOrigColor;
  varying float vSelected;
  varying float vInVolume;
  varying float vGradeMask;

  void main() {
    vec2 p = abs(gl_PointCoord - vec2(0.5));
    if (p.x + p.y > 0.52) discard;

    bool showOriginal = false;
    if (vGradeMask > 0.5) {
      if (uCompareOriginal > 0.5) showOriginal = true;
      else if (uSplitX >= 0.0 && (gl_FragCoord.x / max(1.0, uResolution.x)) < uSplitX) showOriginal = true;
    }
    vec4 col = showOriginal ? vOrigColor : vGradedColor;
    vec3 rgb = col.rgb;
    if (vSelected > 0.5) rgb = mix(rgb, vec3(1.0, 0.74, 0.08), 0.88);
    else if (vInVolume > 0.5) rgb = mix(rgb, vec3(0.22, 0.84, 1.0), 0.36);
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

export const PICK_VERTEX_SHADER = /* glsl */ `
  precision highp float;
  precision highp int;

  attribute vec2 aSplatIdx2;

  uniform sampler2D uPosTex;
  uniform sampler2D uScaleTex;
  uniform sampler2D uQuatTex;
  uniform sampler2D uColorTex;
  uniform sampler2D uStateTex;
  uniform int uTexWidth;

  uniform mat4 uObjectMatrices[${MAX_SCENE_OBJECTS}];
  uniform int uRenderMode;
  uniform vec2 uResolution;
  uniform float uPointSize;
  uniform float uMaxSplatPx;
  uniform int uIsOrtho;
  uniform float uPickAlphaThreshold;

  varying vec2 vUv;
  varying vec4 vPickId;
  varying float vOpacity;

  void main() {
    int idx = int(aSplatIdx2.x + 0.5) + (int(aSplatIdx2.y + 0.5) << 16);
    ivec2 tc = ivec2(idx % uTexWidth, idx / uTexWidth);

    vec4 st = texelFetch(uStateTex, tc, 0);
    int flags = int(st.r * 255.0 + 0.5);
    if ((flags & 6) != 0 || st.b < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec4 baseCol = texelFetch(uColorTex, tc, 0);
    if (uRenderMode != 0 && uRenderMode != 2 && baseCol.a < uPickAlphaThreshold) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    int objId = clamp(int(st.a * 255.0 + 0.5), 0, ${MAX_SCENE_OBJECTS - 1});
    vec4 posObj = texelFetch(uPosTex, tc, 0);
    mat4 mvMat = modelViewMatrix * uObjectMatrices[objId];
    vec4 camPos = mvMat * vec4(posObj.xyz, 1.0);
    vec4 clipPos = projectionMatrix * camPos;

    if (uIsOrtho == 0 && camPos.z > -0.005) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    if (abs(clipPos.x) > clipPos.w * 1.45 || abs(clipPos.y) > clipPos.w * 1.45 || abs(clipPos.z) > clipPos.w * 1.05) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    uint id1 = uint(idx + 1);
    vPickId = vec4(
      float(id1 & 255u) / 255.0,
      float((id1 >> 8u) & 255u) / 255.0,
      float((id1 >> 16u) & 255u) / 255.0,
      float((id1 >> 24u) & 255u) / 255.0
    );
    vOpacity = baseCol.a;

    vec2 corner = position.xy;
    vUv = corner;

    if (uRenderMode == 0) {
      float dotPx = max(2.2, uPointSize * 1.3);
      vec2 ndcOffset = corner * (dotPx * 2.0 / uResolution);
      gl_Position = vec4(clipPos.xy / clipPos.w + ndcOffset, clipPos.z / clipPos.w, 1.0);
      return;
    }

    ${PROJECT_ELLIPSE_GLSL}
  }
`;

export const PICK_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform int uRenderMode;
  uniform float uPickAlphaThreshold;
  varying vec2 vUv;
  varying vec4 vPickId;
  varying float vOpacity;

  const float EXP4 = 0.01831563888873418;
  const float INV_EXP4 = 1.018657360363774;

  void main() {
    float A = dot(vUv, vUv);
    if (A > 1.0) discard;
    if (uRenderMode == 1 && uPickAlphaThreshold > 0.0) {
      float norm = (exp(-4.0 * A) - EXP4) * INV_EXP4;
      if (norm * vOpacity < uPickAlphaThreshold) discard;
    }
    gl_FragColor = vPickId;
  }
`;
