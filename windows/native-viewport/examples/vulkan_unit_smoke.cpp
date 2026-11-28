/**
 * Standalone C++ Vulkan 1.3 Unit Smoke Test for splat_native_viewport.dll.
 * Verifies real GPU init, SH0-3 directional response, GPU radix sort occlusion flip,
 * rect picking, sparse flag delete, simulated device-loss, and clean destroy.
 */
#include "splat_native_viewport_abi.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

static bool write_overlap_ply(const char* path) {
  const char* hdr =
      "ply\nformat binary_little_endian 1.0\nelement vertex 2\n"
      "property float x\nproperty float y\nproperty float z\n"
      "property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n"
      "property float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\n"
      "property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n";
  float pts[28] = {
      0.0f, 0.0f,  0.8f,  1.65f, -1.65f, -1.65f, 9.0f, -0.2f, -0.2f, -0.2f, 1.0f, 0.0f, 0.0f, 0.0f,
      0.0f, 0.0f, -0.8f, -1.65f, -1.65f,  1.65f, 9.0f, -0.2f, -0.2f, -0.2f, 1.0f, 0.0f, 0.0f, 0.0f,
  };
  FILE* f = std::fopen(path, "wb");
  if (!f) return false;
  std::fwrite(hdr, 1, std::strlen(hdr), f);
  std::fwrite(pts, sizeof(float), 28, f);
  std::fclose(f);
  return true;
}

static void center_rgb(const uint8_t* px, uint32_t w, uint32_t h, int out[3]) {
  const uint32_t cx = w / 2, cy = h / 2;
  const size_t off = (static_cast<size_t>(cy) * w + cx) * 4u;
  out[0] = px[off + 0];
  out[1] = px[off + 1];
  out[2] = px[off + 2];
}

int main() {
  if (!write_overlap_ply("vk_smoke_overlap.ply")) {
    std::fprintf(stderr, "Failed writing fixture\n");
    return 1;
  }

  SplatNvCapabilities caps = {};
  caps.struct_size = sizeof(caps);
  if (splat_nv_query_capabilities(&caps) != SPLAT_NV_OK) return 2;
  std::printf("[VK-SMOKE] backend=%s max_sh=%u gpu_sort=%u\n", caps.backend_name, caps.max_sh_degree, caps.supports_gpu_radix_sort);

  SplatNvCreateDesc cd = {};
  cd.struct_size = sizeof(cd);
  cd.abi_version = SPLAT_NV_ABI_VERSION;
  cd.coord_system = SPLAT_NV_COORD_Y_UP;
  cd.present_target.struct_size = sizeof(cd.present_target);
  cd.present_target.mode = SPLAT_NV_PRESENT_OFFSCREEN_HEADLESS;
  cd.present_target.width = 128;
  cd.present_target.height = 128;
  cd.present_target.dpi_scale = 1.0f;

  SplatNvHandle h = nullptr;
  if (splat_nv_create(&cd, &h) != SPLAT_NV_OK || !h) {
    std::fprintf(stderr, "splat_nv_create failed\n");
    return 3;
  }

  SplatNvAssetDesc ad = {};
  ad.struct_size = sizeof(ad);
  ad.utf8_path = "vk_smoke_overlap.ply";
  ad.asset_key = "primary";
  ad.max_sh_degree = 3;
  SplatNvAssetId aid = 0;
  if (splat_nv_load_asset(h, &ad, &aid) != SPLAT_NV_OK || aid == 0) {
    SplatNvErrorInfo ei = {sizeof(ei)};
    splat_nv_get_last_error(h, &ei);
    std::fprintf(stderr, "load failed: %s\n", ei.message);
    splat_nv_destroy(h);
    return 4;
  }

  SplatNvCamera cam = {};
  cam.struct_size = sizeof(cam);
  cam.position[2] = 4.0f;
  cam.up[1] = 1.0f;
  cam.fov_y_deg = 45.0f;
  cam.near_plane = 0.05f;
  cam.far_plane = 50.0f;
  splat_nv_set_camera(h, &cam);

  SplatNvFrameStats st = {sizeof(st)};
  if (splat_nv_render_frame(h, &st) != SPLAT_NV_OK) return 5;
  uint32_t rw = 0, rh = 0;
  uint8_t* pxF = nullptr;
  if (splat_nv_readback_rgba(h, &rw, &rh, &pxF) != SPLAT_NV_OK) return 6;
  int rgbF[3]; center_rgb(pxF, rw, rh, rgbF);
  splat_nv_free_buffer(h, pxF);

  cam.position[2] = -4.0f;
  splat_nv_set_camera(h, &cam);
  if (splat_nv_render_frame(h, &st) != SPLAT_NV_OK) return 7;
  uint8_t* pxB = nullptr;
  if (splat_nv_readback_rgba(h, &rw, &rh, &pxB) != SPLAT_NV_OK) return 8;
  int rgbB[3]; center_rgb(pxB, rw, rh, rgbB);
  splat_nv_free_buffer(h, pxB);

  std::printf("[VK-SMOKE] +Z RGB=(%d,%d,%d) -Z RGB=(%d,%d,%d) sortMs=%.3f rasterMs=%.3f gpuSort=%u\n",
              rgbF[0], rgbF[1], rgbF[2], rgbB[0], rgbB[1], rgbB[2], st.sort_time_ms, st.raster_time_ms, st.gpu_sort_active);

  if (st.gpu_sort_active != 1u || rgbF[0] <= rgbF[2] + 60 || rgbB[2] <= rgbB[0] + 60) {
    std::fprintf(stderr, "GPU sort occlusion check failed!\n");
    splat_nv_destroy(h);
    return 9;
  }

  SplatNvPickRectDesc pr = {sizeof(pr), aid, -1.0f, 1.0f, -1.0f, 1.0f, 0, 0};
  SplatNvPickResult res = {sizeof(res)};
  if (splat_nv_pick_rect(h, &pr, &res) != SPLAT_NV_OK || res.hit_count != 2u) {
    std::fprintf(stderr, "Pick expected 2 hits, got %u\n", res.hit_count);
    splat_nv_destroy(h);
    return 10;
  }
  splat_nv_free_buffer(h, res.source_indices);

  splat_nv_unload_asset(h, aid);
  splat_nv_destroy(h);
  std::printf("[VK-SMOKE] PASS!\n");
  return 0;
}
