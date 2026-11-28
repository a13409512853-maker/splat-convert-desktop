#version 450

layout(location = 0) in vec4 vLineColor;
layout(location = 0) out vec4 outColor;

void main() {
  outColor = vec4(vLineColor.rgb * vLineColor.a, vLineColor.a);
}
