#version 450

struct PosRgba {
  vec3 pos;
  uint rgba;
};

layout(std430, binding = 0) readonly buffer PosBuf { PosRgba splats[]; };
layout(std430, binding = 1) readonly buffer GeomBuf { uvec4 geoms[]; };
layout(std430, binding = 2) readonly buffer FlagBuf { uint packedFlags[]; };
layout(std430, binding = 3) readonly buffer SortedValsBuf { uint sortedVals[]; };
// Optional full SH0..SH3 buffer: 24 uint32 = 48 half floats = 16 vec3s per splat
// Slot 0..14 = f_rest[0..14] (RGB), Slot 15 = exact float16 f_dc (RGB)
layout(std430, binding = 4) readonly buffer ShRestBuf { uint shWords[]; };

layout(std140, binding = 5) uniform FrameUBO {
  mat4 viewMat;
  mat4 projMat;
  mat4 objMat;
  vec4 camPos;       // xyz = world camera position, w = fovYRad
  vec4 viewport;     // x = width, y = height, z = maxSplatPx, w = isOrtho
  vec4 sphereParams; // xyz = sphere center, w = radius
  uvec4 flagsMeta;   // x = displayMode (0=splat,1=centers,2=rings), y = activeShDegree (0..3), z = assetShDegree (0..3), w = sphereFlags (bit0=enabled, bit1=invert)
} ubo;

layout(location = 0) out vec2 vUv;
layout(location = 1) out vec4 vColor;
layout(location = 2) flat out uint vMode;

const vec2 QUAD_CORNERS[6] = vec2[6](
  vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
  vec2(-1.0, -1.0), vec2( 1.0,  1.0), vec2(-1.0,  1.0)
);

const float SH_C0 = 0.28209479177387814;
const float SH_C1 = 0.4886025119029199;
const float SH_C2_0 = 1.0925484305920792;
const float SH_C2_1 = -1.0925484305920792;
const float SH_C2_2 = 0.31539156525252005;
const float SH_C2_3 = -1.0925484305920792;
const float SH_C2_4 = 0.5462742152960396;
const float SH_C3_0 = -0.5900435899266435;
const float SH_C3_1 = 2.890611442640554;
const float SH_C3_2 = -0.4570457994644658;
const float SH_C3_3 = 0.3731763325901154;
const float SH_C3_4 = -0.4570457994644658;
const float SH_C3_5 = 1.445305721320277;
const float SH_C3_6 = -0.5900435899266435;

float readShHalf(uint baseWord, uint elemIdx) {
  uint w = shWords[baseWord + (elemIdx >> 1u)];
  vec2 pair = unpackHalf2x16(w);
  return (elemIdx & 1u) == 0u ? pair.x : pair.y;
}

vec3 readShVec3(uint baseWord, uint coeffSlot) {
  uint e = coeffSlot * 3u;
  return vec3(readShHalf(baseWord, e), readShHalf(baseWord, e + 1u), readShHalf(baseWord, e + 2u));
}

void main() {
  uint splatIdx = sortedVals[gl_InstanceIndex];
  PosRgba sp = splats[splatIdx];
  vec4 baseCol = unpackUnorm4x8(sp.rgba);
  if (baseCol.a <= 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec3 worldPos = (ubo.objMat * vec4(sp.pos, 1.0)).xyz;
  mat4 mvMat = ubo.viewMat * ubo.objMat;
  vec4 camPos = mvMat * vec4(sp.pos, 1.0);
  vec4 clipPos = ubo.projMat * camPos;
  if (clipPos.w <= 1e-5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Evaluate SH0 / SH1 / SH2 / SH3 when asset has SH coefficients
  vec3 rgb = baseCol.rgb;
  uint assetSh = ubo.flagsMeta.z;
  uint evalSh = min(ubo.flagsMeta.y, assetSh);
  if (assetSh > 0u) {
    uint baseWord = splatIdx * 24u;
    vec3 fdc = readShVec3(baseWord, 15u);
    rgb = vec3(0.5) + SH_C0 * fdc;
    if (evalSh >= 1u) {
      vec3 dir = normalize(worldPos - ubo.camPos.xyz);
      float x = dir.x, y = dir.y, z = dir.z;
      vec3 c0 = readShVec3(baseWord, 0u);
      vec3 c1 = readShVec3(baseWord, 1u);
      vec3 c2 = readShVec3(baseWord, 2u);
      rgb += SH_C1 * (-y * c0 + z * c1 - x * c2);
      if (evalSh >= 2u) {
        float xx = x * x, yy = y * y, zz = z * z;
        float xy = x * y, yz = y * z, xz = x * z;
        rgb += SH_C2_0 * xy * readShVec3(baseWord, 3u)
             + SH_C2_1 * yz * readShVec3(baseWord, 4u)
             + SH_C2_2 * (2.0 * zz - xx - yy) * readShVec3(baseWord, 5u)
             + SH_C2_3 * xz * readShVec3(baseWord, 6u)
             + SH_C2_4 * (xx - yy) * readShVec3(baseWord, 7u);
        if (evalSh >= 3u) {
          rgb += SH_C3_0 * y * (3.0 * xx - yy) * readShVec3(baseWord, 8u)
               + SH_C3_1 * xy * z * readShVec3(baseWord, 9u)
               + SH_C3_2 * y * (4.0 * zz - xx - yy) * readShVec3(baseWord, 10u)
               + SH_C3_3 * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * readShVec3(baseWord, 11u)
               + SH_C3_4 * x * (4.0 * zz - xx - yy) * readShVec3(baseWord, 12u)
               + SH_C3_5 * z * (xx - yy) * readShVec3(baseWord, 13u)
               + SH_C3_6 * x * (xx - 3.0 * yy) * readShVec3(baseWord, 14u);
        }
      }
    }
    rgb = clamp(rgb, 0.0, 1.0);
  }

  // Real-time GPU adjustable bounding sphere highlight (cool sky-cyan)
  uint spFlags = ubo.flagsMeta.w;
  if ((spFlags & 1u) != 0u) {
    float distToSphere = length(worldPos - ubo.sphereParams.xyz);
    bool inside = distToSphere <= ubo.sphereParams.w;
    bool inScope = ((spFlags & 2u) != 0u) ? !inside : inside;
    if (inScope) {
      rgb = mix(rgb, vec3(0.28, 0.80, 1.0), 0.28);
    }
  }

  // Selection highlight (warm gold-orange, distinct from bounding sphere tint)
  uint fWord = packedFlags[splatIdx >> 2u];
  uint flag = (fWord >> ((splatIdx & 3u) * 8u)) & 0xFFu;
  if ((flag & 1u) != 0u) {
    rgb = mix(rgb, vec3(1.0, 0.58, 0.12), 0.56);
  }

  vec2 corner = QUAD_CORNERS[gl_VertexIndex];
  uint mode = ubo.flagsMeta.x;
  vMode = mode;
  vColor = vec4(rgb, baseCol.a);

  vec2 res = max(ubo.viewport.xy, vec2(1.0));
  vec2 ndcCenter = clipPos.xy / clipPos.w;
  float ndcZ = clipPos.z / clipPos.w;

  if (mode == 1u) {
    // Centers mode: crisp 2.5px circular points
    float ptRad = 2.5;
    vec2 pxOffset = corner * ptRad;
    vec2 ndcOffset = vec2(pxOffset.x * 2.0 / res.x, -pxOffset.y * 2.0 / res.y);
    vUv = corner;
    gl_Position = vec4(ndcCenter + ndcOffset, ndcZ, 1.0);
    return;
  }

  // Unpack half-precision log-scale & unit quaternion (qx, qy, qz, qw)
  uvec4 gm = geoms[splatIdx];
  vec2 lsXY = unpackHalf2x16(gm.x);
  vec2 lsZ_qw = unpackHalf2x16(gm.y);
  vec2 qXY = unpackHalf2x16(gm.z);
  vec2 qZ_pad = unpackHalf2x16(gm.w);
  vec3 sc = exp(clamp(vec3(lsXY, lsZ_qw.x), -18.0, 10.0));
  vec4 q = vec4(qXY.x, qXY.y, qZ_pad.x, lsZ_qw.y);

  float x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z;
  float xx = q.x * x2, xy = q.x * y2, xz = q.x * z2;
  float yy = q.y * y2, yz = q.y * z2, zz = q.z * z2;
  float wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;

  mat3 M = mat3(
    vec3(1.0 - (yy + zz), xy + wz, xz - wy) * sc.x,
    vec3(xy - wz, 1.0 - (xx + zz), yz + wx) * sc.y,
    vec3(xz + wy, yz - wx, 1.0 - (xx + yy)) * sc.z
  );

  // Positive focal lengths matching +Y-up camera space (projMat[1][1] is negated for Vulkan clip Y)
  float fx = abs(ubo.projMat[0][0]) * res.x * 0.5;
  float fy = abs(ubo.projMat[1][1]) * res.y * 0.5;

  float z = max(0.02, -camPos.z);
  float invZ = 1.0 / z;
  float invZ2 = invZ * invZ;
  float tanHalfX = 1.0 / max(1e-4, abs(ubo.projMat[0][0]));
  float tanHalfY = 1.0 / max(1e-4, abs(ubo.projMat[1][1]));
  float tx = clamp(camPos.x * invZ, -1.3 * tanHalfX, 1.3 * tanHalfX) * z;
  float ty = clamp(camPos.y * invZ, -1.3 * tanHalfY, 1.3 * tanHalfY) * z;

  mat3 J = mat3(
    fx * invZ, 0.0, -fx * tx * invZ2,
    0.0, fy * invZ, -fy * ty * invZ2,
    0.0, 0.0, 0.0
  );

  mat3 TM = (transpose(J) * mat3(mvMat)) * M;
  mat3 cov2d = TM * transpose(TM);

  float a = cov2d[0][0] + 0.3;
  float b = cov2d[0][1];
  float c = cov2d[1][1] + 0.3;
  float mid = 0.5 * (a + c);
  float disc = sqrt(max(0.01, (a - c) * (a - c) * 0.25 + b * b));
  float lambda1 = max(0.1, mid + disc);
  float lambda2 = max(0.1, mid - disc);

  float maxPx = min(ubo.viewport.z, max(res.x, res.y) * 0.28);
  float tightK = (mode == 0u)
    ? clamp(sqrt(max(0.0, log(max(1.01, baseCol.a * 255.0)) * 0.25)), 0.18, 1.0)
    : 1.0;
  float rad1 = min(maxPx, 2.828427 * sqrt(lambda1) * tightK);
  float rad2 = min(maxPx, 2.828427 * sqrt(lambda2) * tightK);
  if (rad1 < 0.45 || (rad1 * rad2 < 0.18 && baseCol.a < 0.25)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 diagVec = normalize(vec2(b, lambda1 - a) + vec2(1e-6, 0.0));
  if (abs(b) < 1e-6 && a >= c) diagVec = vec2(1.0, 0.0);
  else if (abs(b) < 1e-6 && a < c) diagVec = vec2(0.0, 1.0);
  vec2 axis1 = diagVec * rad1;
  vec2 axis2 = vec2(-diagVec.y, diagVec.x) * rad2;

  vec2 pxOffset = corner.x * axis1 + corner.y * axis2;
  // Negate Y offset for Vulkan clip space (+Y down)
  vec2 ndcOffset = vec2(pxOffset.x * 2.0 / res.x, -pxOffset.y * 2.0 / res.y);
  vUv = corner * tightK;
  gl_Position = vec4(ndcCenter + ndcOffset, ndcZ, 1.0);
}
