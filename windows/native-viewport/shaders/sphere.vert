#version 450

// Procedural 3-great-circle + latitude-ring wireframe for adjustable bounding sphere (0 vertex buffers!)
// Draw 9 circles x 64 segments x 2 vertices = 1152 line vertices
layout(std140, binding = 5) uniform FrameUBO {
  mat4 viewMat;
  mat4 projMat;
  mat4 objMat;
  vec4 camPos;
  vec4 viewport;
  vec4 sphereParams; // xyz = center, w = radius
  uvec4 flagsMeta;
} ubo;

layout(location = 0) out vec4 vLineColor;

const float TWO_PI = 6.28318530718;

void main() {
  uint segs = 64u;
  uint vertsPerCircle = segs * 2u;
  uint circleIdx = gl_VertexIndex / vertsPerCircle;
  uint localVert = gl_VertexIndex % vertsPerCircle;
  uint segIdx = (localVert >> 1u) + (localVert & 1u);
  float ang = (float(segIdx) / float(segs)) * TWO_PI;
  float ca = cos(ang);
  float sa = sin(ang);

  vec3 localPt = vec3(0.0);
  vec3 col = vec3(0.28, 0.82, 1.0);
  if (circleIdx == 0u) {
    localPt = vec3(ca, 0.0, sa); // Equator XZ
    col = vec3(0.35, 0.88, 1.0);
  } else if (circleIdx == 1u) {
    localPt = vec3(ca, sa, 0.0); // XY meridian
  } else if (circleIdx == 2u) {
    localPt = vec3(0.0, sa, ca); // YZ meridian
  } else if (circleIdx == 3u) {
    float c45 = 0.70710678;
    localPt = vec3(ca * c45, sa, ca * c45);
    col = vec3(0.22, 0.66, 0.88);
  } else if (circleIdx == 4u) {
    float c45 = 0.70710678;
    localPt = vec3(ca * c45, sa, -ca * c45);
    col = vec3(0.22, 0.66, 0.88);
  } else if (circleIdx == 5u) {
    float y = 0.5;
    float r = 0.8660254;
    localPt = vec3(ca * r, y, sa * r);
    col = vec3(0.22, 0.66, 0.88);
  } else {
    float y = -0.5;
    float r = 0.8660254;
    localPt = vec3(ca * r, y, sa * r);
    col = vec3(0.22, 0.66, 0.88);
  }

  vec3 worldPos = ubo.sphereParams.xyz + localPt * ubo.sphereParams.w;
  gl_Position = ubo.projMat * ubo.viewMat * vec4(worldPos, 1.0);
  vLineColor = vec4(col, 0.72);
}
