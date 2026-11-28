#version 450

layout(location = 0) in vec2 vUv;
layout(location = 1) in vec4 vColor;
layout(location = 2) flat in uint vMode;

layout(location = 0) out vec4 outColor;

void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;

  float alpha = vColor.a;
  if (vMode == 0u) {
    // Full 3DGS Gaussian falloff matching 2.8284*sqrt(lambda) radius (sigma^2 = 1/8)
    float w = exp(-4.0 * r2);
    alpha *= w;
    if (alpha < (1.0 / 255.0)) discard;
  } else if (vMode == 1u) {
    // Crisp circular center points
    float edge = 1.0 - smoothstep(0.65, 1.0, r2);
    alpha = max(alpha, 0.85) * edge;
    if (alpha < 0.02) discard;
  } else {
    // ReSplat-style contour rings
    float r = sqrt(r2);
    float ring = smoothstep(0.68, 0.82, r) * (1.0 - smoothstep(0.90, 1.0, r));
    alpha = clamp(alpha * 1.15, 0.15, 1.0) * ring;
    if (alpha < 0.02) discard;
  }

  // Premultiplied output for back-to-front blending (ONE, ONE_MINUS_SRC_ALPHA)
  outColor = vec4(vColor.rgb * alpha, alpha);
}
