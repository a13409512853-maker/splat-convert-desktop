#pragma once
#include <cstdint>
#include <string>
#include <vector>

struct SplatPosRgba {
  float x;
  float y;
  float z;
  uint32_t rgba; // packed RGBA8 unorm (R=bits 0..7, G=8..15, B=16..23, A=24..31)
};
static_assert(sizeof(SplatPosRgba) == 16, "SplatPosRgba must be 16 bytes");

struct SplatGeomHalf {
  uint32_t scaleXY;  // half2(logSx, logSy)
  uint32_t scaleZQw; // half2(logSz, qw)
  uint32_t quatXY;   // half2(qx, qy)
  uint32_t quatZPad; // half2(qz, 0.0)
};
static_assert(sizeof(SplatGeomHalf) == 16, "SplatGeomHalf must be 16 bytes");

struct LoadedSplatAsset {
  uint32_t totalSourcePoints = 0;
  uint32_t count = 0;
  uint32_t shDegree = 0; // 0..3
  bool hasNonSequentialSrcIdx = false;

  std::vector<SplatPosRgba> posRgba;
  std::vector<SplatGeomHalf> geom;
  std::vector<uint32_t> shRestWords; // 24 uint32 per splat when shDegree > 0 (15 rest vec3 + slot 15 = exact f_dc)
  std::vector<uint32_t> srcIndices;  // only populated when hasNonSequentialSrcIdx == true
};

uint16_t float_to_half_ieee(float val);
bool load_splat_asset_file(const char* utf8_path, uint32_t max_sh_degree, LoadedSplatAsset& out, std::string& out_error);
