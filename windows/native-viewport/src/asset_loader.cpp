#include "asset_loader.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <unordered_map>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

static constexpr float SH_C0 = 0.28209479177387814f;

uint16_t float_to_half_ieee(float val) {
  if (!std::isfinite(val)) return 0;
  uint32_t x = 0;
  std::memcpy(&x, &val, 4);
  const uint32_t sign = (x >> 16) & 0x8000u;
  const int32_t exp = static_cast<int32_t>((x >> 23) & 0xFFu) - 112;
  uint32_t mant = x & 0x007FFFFFu;
  if (exp <= 0) {
    if (exp < -10) return static_cast<uint16_t>(sign);
    mant = (mant | 0x00800000u) >> (1 - exp);
    return static_cast<uint16_t>(sign | ((mant + 0x00001000u) >> 13));
  }
  if (exp >= 31) return static_cast<uint16_t>(sign | 0x7BFFu);
  return static_cast<uint16_t>(sign | (static_cast<uint32_t>(exp) << 10) | ((mant + 0x00001000u) >> 13));
}

static inline uint32_t pack_half2(uint16_t lo, uint16_t hi) {
  return static_cast<uint32_t>(lo) | (static_cast<uint32_t>(hi) << 16);
}

static inline uint32_t pack_half2f(float a, float b) {
  return pack_half2(float_to_half_ieee(a), float_to_half_ieee(b));
}

static inline uint8_t clamp_u8(float v) {
  if (!std::isfinite(v) || v <= 0.0f) return 0u;
  if (v >= 1.0f) return 255u;
  return static_cast<uint8_t>(std::lround(v * 255.0f));
}

static FILE* fopen_utf8_rb(const char* utf8_path) {
#if defined(_WIN32)
  if (!utf8_path || !utf8_path[0]) return nullptr;
  int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, nullptr, 0);
  if (wlen <= 0) return nullptr;
  std::wstring wpath(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, &wpath[0], wlen);
  FILE* f = nullptr;
  if (_wfopen_s(&f, wpath.c_str(), L"rb") != 0) return nullptr;
  return f;
#else
  return std::fopen(utf8_path, "rb");
#endif
}

static bool fread_exact(FILE* f, void* dst, size_t bytes) {
  auto* ptr = static_cast<uint8_t*>(dst);
  size_t done = 0;
  while (done < bytes) {
    const size_t n = std::fread(ptr + done, 1, bytes - done, f);
    if (n == 0) return false;
    done += n;
  }
  return true;
}

static bool load_sgc3_file(FILE* f, LoadedSplatAsset& out, std::string& out_error) {
  uint32_t hdr[8] = {};
  if (!fread_exact(f, hdr, sizeof(hdr))) {
    out_error = "Truncated SGC3 header";
    return false;
  }
  if (std::memcmp(&hdr[0], "SGC3", 4) != 0 || hdr[1] != 3u) {
    out_error = "Invalid SGC3 magic or version";
    return false;
  }
  const uint32_t totalSrc = hdr[2];
  const uint32_t used = hdr[3];
  const uint32_t hasSrcIdx = hdr[6];
  if (used == 0 || used > 50000000u) {
    out_error = "Invalid SGC3 point count";
    return false;
  }

  out.totalSourcePoints = totalSrc > 0 ? totalSrc : used;
  out.count = used;
  out.shDegree = 0;
  out.hasNonSequentialSrcIdx = (hasSrcIdx != 0);
  out.posRgba.resize(used);
  out.geom.resize(used);
  out.shRestWords.clear();

  // Stream SGC3 sections directly into packed GPU-ready buffers to keep host RAM minimal
  // Section 1: float32 pos[used * 3]
  {
    const size_t chunkPts = 1u << 18; // 262,144 pts = 3 MiB temp
    std::vector<float> tmp(chunkPts * 3);
    uint32_t done = 0;
    while (done < used) {
      const uint32_t take = std::min<uint32_t>(static_cast<uint32_t>(chunkPts), used - done);
      if (!fread_exact(f, tmp.data(), static_cast<size_t>(take) * 12u)) {
        out_error = "Truncated SGC3 pos section";
        return false;
      }
      for (uint32_t i = 0; i < take; ++i) {
        out.posRgba[done + i].x = tmp[i * 3 + 0];
        out.posRgba[done + i].y = tmp[i * 3 + 1];
        out.posRgba[done + i].z = tmp[i * 3 + 2];
        out.posRgba[done + i].rgba = 0xFFFFFFFFu;
      }
      done += take;
    }
  }

  // Section 2: uint16 scalesHalf[used * 3] + 4-byte padding
  {
    const size_t chunkPts = 1u << 18;
    std::vector<uint16_t> tmp(chunkPts * 3);
    uint32_t done = 0;
    while (done < used) {
      const uint32_t take = std::min<uint32_t>(static_cast<uint32_t>(chunkPts), used - done);
      if (!fread_exact(f, tmp.data(), static_cast<size_t>(take) * 6u)) {
        out_error = "Truncated SGC3 scales section";
        return false;
      }
      for (uint32_t i = 0; i < take; ++i) {
        out.geom[done + i].scaleXY = pack_half2(tmp[i * 3 + 0], tmp[i * 3 + 1]);
        out.geom[done + i].scaleZQw = static_cast<uint32_t>(tmp[i * 3 + 2]);
      }
      done += take;
    }
    const size_t scaleBytes = static_cast<size_t>(used) * 6u;
    if ((scaleBytes & 3u) != 0u) {
      uint8_t pad[4];
      if (!fread_exact(f, pad, 4u - (scaleBytes & 3u))) {
        out_error = "Truncated SGC3 scales padding";
        return false;
      }
    }
  }

  // Section 3: uint16 quatsHalf[used * 4] stored as (qx, qy, qz, qw)
  {
    const size_t chunkPts = 1u << 18;
    std::vector<uint16_t> tmp(chunkPts * 4);
    uint32_t done = 0;
    while (done < used) {
      const uint32_t take = std::min<uint32_t>(static_cast<uint32_t>(chunkPts), used - done);
      if (!fread_exact(f, tmp.data(), static_cast<size_t>(take) * 8u)) {
        out_error = "Truncated SGC3 quats section";
        return false;
      }
      for (uint32_t i = 0; i < take; ++i) {
        const uint16_t qx = tmp[i * 4 + 0];
        const uint16_t qy = tmp[i * 4 + 1];
        const uint16_t qz = tmp[i * 4 + 2];
        const uint16_t qw = tmp[i * 4 + 3];
        const uint16_t sz = static_cast<uint16_t>(out.geom[done + i].scaleZQw & 0xFFFFu);
        out.geom[done + i].scaleZQw = pack_half2(sz, qw);
        out.geom[done + i].quatXY = pack_half2(qx, qy);
        out.geom[done + i].quatZPad = pack_half2(qz, 0u);
      }
      done += take;
    }
  }

  // Section 4: uint8 rgba[used * 4]
  {
    const size_t chunkPts = 1u << 18;
    std::vector<uint32_t> tmp(chunkPts);
    uint32_t done = 0;
    while (done < used) {
      const uint32_t take = std::min<uint32_t>(static_cast<uint32_t>(chunkPts), used - done);
      if (!fread_exact(f, tmp.data(), static_cast<size_t>(take) * 4u)) {
        out_error = "Truncated SGC3 rgba section";
        return false;
      }
      for (uint32_t i = 0; i < take; ++i) {
        out.posRgba[done + i].rgba = tmp[i];
      }
      done += take;
    }
  }

  if (hasSrcIdx) {
    out.srcIndices.resize(used);
    if (!fread_exact(f, out.srcIndices.data(), static_cast<size_t>(used) * 4u)) {
      out_error = "Truncated SGC3 srcIndices section";
      return false;
    }
  }
  return true;
}

enum class PlyPropType { F32, F64, U8, I8, U16, I16, U32, I32 };

struct PlyProp {
  PlyPropType type;
  uint32_t offset;
};

static inline float read_prop_f32(const uint8_t* row, const PlyProp& p) {
  switch (p.type) {
    case PlyPropType::F32: { float v; std::memcpy(&v, row + p.offset, 4); return v; }
    case PlyPropType::F64: { double v; std::memcpy(&v, row + p.offset, 8); return static_cast<float>(v); }
    case PlyPropType::U8:  return static_cast<float>(row[p.offset]);
    case PlyPropType::I8:  return static_cast<float>(static_cast<int8_t>(row[p.offset]));
    case PlyPropType::U16: { uint16_t v; std::memcpy(&v, row + p.offset, 2); return static_cast<float>(v); }
    case PlyPropType::I16: { int16_t v; std::memcpy(&v, row + p.offset, 2); return static_cast<float>(v); }
    case PlyPropType::U32: { uint32_t v; std::memcpy(&v, row + p.offset, 4); return static_cast<float>(v); }
    case PlyPropType::I32: { int32_t v; std::memcpy(&v, row + p.offset, 4); return static_cast<float>(v); }
  }
  return 0.0f;
}

static bool load_ply_file(FILE* f, uint32_t max_sh_degree, LoadedSplatAsset& out, std::string& out_error) {
  std::string header;
  header.reserve(4096);
  char buf[512];
  bool foundEnd = false;
  while (std::fgets(buf, sizeof(buf), f) != nullptr) {
    header.append(buf);
    if (std::strncmp(buf, "end_header", 10) == 0 && (buf[10] == '\n' || buf[10] == '\r' || buf[10] == '\0')) {
      foundEnd = true;
      break;
    }
    if (header.size() > 262144) break;
  }
  if (!foundEnd) {
    out_error = "PLY end_header not found";
    return false;
  }

  std::istringstream iss(header);
  std::string line;
  bool isBinaryLE = false;
  bool inVertex = false;
  uint32_t vertexCount = 0;
  uint32_t stride = 0;
  std::unordered_map<std::string, PlyProp> props;

  while (std::getline(iss, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) line.pop_back();
    if (line.empty()) continue;
    std::istringstream ls(line);
    std::string tok;
    ls >> tok;
    if (tok == "format") {
      std::string fmt;
      ls >> fmt;
      isBinaryLE = (fmt == "binary_little_endian");
    } else if (tok == "element") {
      std::string elem;
      uint32_t cnt = 0;
      ls >> elem >> cnt;
      inVertex = (elem == "vertex");
      if (inVertex) vertexCount = cnt;
    } else if (tok == "property" && inVertex) {
      std::string ptype, pname;
      ls >> ptype >> pname;
      if (ptype == "list") {
        out_error = "PLY list property on vertex not supported";
        return false;
      }
      PlyPropType pt = PlyPropType::F32;
      uint32_t sz = 4;
      if (ptype == "float" || ptype == "float32") { pt = PlyPropType::F32; sz = 4; }
      else if (ptype == "double" || ptype == "float64") { pt = PlyPropType::F64; sz = 8; }
      else if (ptype == "uchar" || ptype == "uint8") { pt = PlyPropType::U8; sz = 1; }
      else if (ptype == "char" || ptype == "int8") { pt = PlyPropType::I8; sz = 1; }
      else if (ptype == "ushort" || ptype == "uint16") { pt = PlyPropType::U16; sz = 2; }
      else if (ptype == "short" || ptype == "int16") { pt = PlyPropType::I16; sz = 2; }
      else if (ptype == "uint" || ptype == "uint32") { pt = PlyPropType::U32; sz = 4; }
      else if (ptype == "int" || ptype == "int32") { pt = PlyPropType::I32; sz = 4; }
      props[pname] = PlyProp{pt, stride};
      stride += sz;
    }
  }

  if (!isBinaryLE || vertexCount == 0 || stride == 0 || !props.count("x") || !props.count("y") || !props.count("z")) {
    out_error = "Unsupported or invalid binary_little_endian PLY header";
    return false;
  }

  // Count f_rest_* properties (standard planar 3DGS layout: 9=SH1, 24=SH2, 45=SH3)
  uint32_t restProps = 0;
  for (uint32_t k = 0; k < 45; ++k) {
    if (props.count("f_rest_" + std::to_string(k))) restProps = k + 1;
    else break;
  }
  uint32_t fileShDeg = 0;
  uint32_t restPerChan = 0;
  if (restProps >= 45) { fileShDeg = 3; restPerChan = 15; }
  else if (restProps >= 24) { fileShDeg = 2; restPerChan = 8; }
  else if (restProps >= 9) { fileShDeg = 1; restPerChan = 3; }

  const uint32_t activeShDeg = std::min(fileShDeg, std::min<uint32_t>(3u, max_sh_degree));

  const auto pX = props["x"], pY = props["y"], pZ = props["z"];
  const bool hasDc = props.count("f_dc_0") && props.count("f_dc_1") && props.count("f_dc_2");
  const bool hasRgb = props.count("red") && props.count("green") && props.count("blue");
  const bool hasOpLin = props.count("opacity_linear") > 0;
  const bool hasOp = props.count("opacity") > 0;
  const bool hasScale = props.count("scale_0") && props.count("scale_1") && props.count("scale_2");
  const bool hasRot = props.count("rot_0") && props.count("rot_1") && props.count("rot_2") && props.count("rot_3");

  PlyProp pRest[45] = {};
  for (uint32_t k = 0; k < restPerChan * 3; ++k) {
    pRest[k] = props["f_rest_" + std::to_string(k)];
  }

  out.totalSourcePoints = vertexCount;
  out.count = vertexCount;
  out.shDegree = activeShDeg;
  out.hasNonSequentialSrcIdx = false;
  out.posRgba.resize(vertexCount);
  out.geom.resize(vertexCount);
  if (activeShDeg > 0) {
    out.shRestWords.assign(static_cast<size_t>(vertexCount) * 24u, 0u);
  } else {
    out.shRestWords.clear();
  }

  const uint32_t chunkPts = std::max<uint32_t>(1u, (8u * 1024u * 1024u) / stride);
  std::vector<uint8_t> rawBuf(static_cast<size_t>(chunkPts) * stride);

  uint32_t done = 0;
  while (done < vertexCount) {
    const uint32_t take = std::min(chunkPts, vertexCount - done);
    if (!fread_exact(f, rawBuf.data(), static_cast<size_t>(take) * stride)) {
      out_error = "Truncated PLY vertex data";
      return false;
    }
    for (uint32_t i = 0; i < take; ++i) {
      const uint8_t* row = rawBuf.data() + static_cast<size_t>(i) * stride;
      const uint32_t idx = done + i;

      float x = read_prop_f32(row, pX);
      float y = read_prop_f32(row, pY);
      float z = read_prop_f32(row, pZ);
      if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)) {
        x = y = z = 0.0f;
      }

      float dc0 = 0.0f, dc1 = 0.0f, dc2 = 0.0f;
      float r = 0.5f, g = 0.5f, b = 0.5f;
      if (hasDc) {
        dc0 = read_prop_f32(row, props["f_dc_0"]);
        dc1 = read_prop_f32(row, props["f_dc_1"]);
        dc2 = read_prop_f32(row, props["f_dc_2"]);
        r = 0.5f + SH_C0 * dc0;
        g = 0.5f + SH_C0 * dc1;
        b = 0.5f + SH_C0 * dc2;
      } else if (hasRgb) {
        r = read_prop_f32(row, props["red"]) / 255.0f;
        g = read_prop_f32(row, props["green"]) / 255.0f;
        b = read_prop_f32(row, props["blue"]) / 255.0f;
        dc0 = (r - 0.5f) / SH_C0;
        dc1 = (g - 0.5f) / SH_C0;
        dc2 = (b - 0.5f) / SH_C0;
      }

      float alpha = 1.0f;
      if (hasOpLin) {
        alpha = read_prop_f32(row, props["opacity_linear"]);
      } else if (hasOp) {
        const float op = read_prop_f32(row, props["opacity"]);
        alpha = 1.0f / (1.0f + std::exp(-std::max(-30.0f, std::min(30.0f, op))));
      }

      const uint32_t rgba8 =
          static_cast<uint32_t>(clamp_u8(r)) |
          (static_cast<uint32_t>(clamp_u8(g)) << 8) |
          (static_cast<uint32_t>(clamp_u8(b)) << 16) |
          (static_cast<uint32_t>(clamp_u8(alpha)) << 24);
      out.posRgba[idx] = SplatPosRgba{x, y, z, rgba8};

      float sx = -6.0f, sy = -6.0f, sz = -6.0f;
      if (hasScale) {
        sx = read_prop_f32(row, props["scale_0"]);
        sy = read_prop_f32(row, props["scale_1"]);
        sz = read_prop_f32(row, props["scale_2"]);
      }

      float qw = 1.0f, qx = 0.0f, qy = 0.0f, qz = 0.0f;
      if (hasRot) {
        qw = read_prop_f32(row, props["rot_0"]);
        qx = read_prop_f32(row, props["rot_1"]);
        qy = read_prop_f32(row, props["rot_2"]);
        qz = read_prop_f32(row, props["rot_3"]);
        const float ql = std::sqrt(qw * qw + qx * qx + qy * qy + qz * qz);
        if (ql > 1e-8f && std::isfinite(ql)) {
          const float inv = 1.0f / ql;
          qw *= inv; qx *= inv; qy *= inv; qz *= inv;
        } else {
          qw = 1.0f; qx = qy = qz = 0.0f;
        }
      }
      out.geom[idx] = SplatGeomHalf{
        pack_half2f(sx, sy),
        pack_half2f(sz, qw),
        pack_half2f(qx, qy),
        pack_half2f(qz, 0.0f)
      };

      if (activeShDeg > 0) {
        uint16_t shHalf[48] = {};
        const uint32_t coeffsToLoad = (activeShDeg == 3) ? 15u : (activeShDeg == 2 ? 8u : 3u);
        for (uint32_t c = 0; c < coeffsToLoad; ++c) {
          shHalf[c * 3 + 0] = float_to_half_ieee(read_prop_f32(row, pRest[c]));
          shHalf[c * 3 + 1] = float_to_half_ieee(read_prop_f32(row, pRest[restPerChan + c]));
          shHalf[c * 3 + 2] = float_to_half_ieee(read_prop_f32(row, pRest[restPerChan * 2 + c]));
        }
        // Slot 15 (half indices 45, 46, 47) = exact float16 f_dc RGB!
        shHalf[45] = float_to_half_ieee(dc0);
        shHalf[46] = float_to_half_ieee(dc1);
        shHalf[47] = float_to_half_ieee(dc2);
        uint32_t* dst = &out.shRestWords[static_cast<size_t>(idx) * 24u];
        for (uint32_t w = 0; w < 24u; ++w) {
          dst[w] = pack_half2(shHalf[w * 2], shHalf[w * 2 + 1]);
        }
      }
    }
    done += take;
  }
  return true;
}

bool load_splat_asset_file(const char* utf8_path, uint32_t max_sh_degree, LoadedSplatAsset& out, std::string& out_error) {
  FILE* f = fopen_utf8_rb(utf8_path);
  if (!f) {
    out_error = std::string("Cannot open asset file: ") + (utf8_path ? utf8_path : "(null)");
    return false;
  }
  char magic[4] = {};
  const size_t n = std::fread(magic, 1, 4, f);
  std::rewind(f);
  bool ok = false;
  if (n == 4 && std::memcmp(magic, "SGC3", 4) == 0) {
    ok = load_sgc3_file(f, out, out_error);
  } else if (n >= 3 && std::memcmp(magic, "ply", 3) == 0) {
    ok = load_ply_file(f, max_sh_degree, out, out_error);
  } else {
    out_error = "Unsupported binary asset format (expected SGC3 or binary PLY)";
    ok = false;
  }
  std::fclose(f);
  return ok;
}
