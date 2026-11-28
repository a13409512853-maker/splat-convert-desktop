/**
 * Compilable Smoke Harness for splat_native_viewport_abi.h (v1.1).
 * Prints exact C++ struct sizes so cross-language C# Marshal.SizeOf tests verify 1:1 binary layout.
 */
#include "splat_native_viewport_abi.h"

#include <cassert>
#include <cstdio>
#include <cstring>

int main() {
  const uint32_t ver = splat_nv_get_abi_version();
  assert(ver == SPLAT_NV_ABI_VERSION);

  SplatNvCapabilities caps = {};
  caps.struct_size = sizeof(caps);
  assert(splat_nv_query_capabilities(&caps) == SPLAT_NV_OK);
  assert(caps.abi_version == SPLAT_NV_ABI_VERSION);

  SplatNvCreateDesc bad_desc = {};
  bad_desc.struct_size = sizeof(bad_desc);
  bad_desc.abi_version = SPLAT_NV_MAKE_ABI_VERSION(99, 0);
  SplatNvHandle bad_handle = nullptr;
  assert(splat_nv_create(&bad_desc, &bad_handle) == SPLAT_NV_ERR_ABI_MISMATCH);

  SplatNvCreateDesc desc = {};
  desc.struct_size = sizeof(desc);
  desc.abi_version = SPLAT_NV_ABI_VERSION;
  desc.coord_system = SPLAT_NV_COORD_Y_UP;
  desc.present_target.struct_size = sizeof(SplatNvPresentTarget);
  desc.present_target.mode = SPLAT_NV_PRESENT_OFFSCREEN_HEADLESS;
  desc.present_target.width = 128;
  desc.present_target.height = 128;
  desc.present_target.dpi_scale = 1.0f;

  SplatNvHandle inst = nullptr;
  assert(splat_nv_create(&desc, &inst) == SPLAT_NV_OK);

  SplatNvAssetDesc ad = {};
  ad.struct_size = sizeof(ad);
  ad.utf8_path = "scene_sample.ply";
  ad.asset_key = "primary";
  ad.max_sh_degree = 3;
  SplatNvAssetId aid = 0;
  assert(splat_nv_load_asset(inst, &ad, &aid) == SPLAT_NV_OK);

  const uint32_t del_idx[2] = {0u, 32u};
  const uint8_t del_flags[2] = {0x02u, 0x02u};
  SplatNvCommand cmd = {};
  cmd.struct_size = sizeof(cmd);
  cmd.type = SPLAT_NV_CMD_APPLY_SPARSE_FLAGS;
  cmd.payload.sparse_flags.asset_id = aid;
  cmd.payload.sparse_flags.count = 2;
  cmd.payload.sparse_flags.source_indices = del_idx;
  cmd.payload.sparse_flags.flags = del_flags;
  assert(splat_nv_submit_command(inst, &cmd) == SPLAT_NV_OK);

  SplatNvCommand sh_cmd = {};
  sh_cmd.struct_size = sizeof(sh_cmd);
  sh_cmd.type = SPLAT_NV_CMD_SET_SH_DEGREE;
  sh_cmd.payload.sh_degree = 3;
  assert(splat_nv_submit_command(inst, &sh_cmd) == SPLAT_NV_OK);

  SplatNvPickRectDesc pick_desc = {};
  pick_desc.struct_size = sizeof(pick_desc);
  pick_desc.asset_id = aid;
  SplatNvPickResult pick_res = {};
  pick_res.struct_size = sizeof(pick_res);
  assert(splat_nv_pick_rect(inst, &pick_desc, &pick_res) == SPLAT_NV_OK);
  assert(pick_res.hit_count == 16 && pick_res.source_indices[0] == 64u);
  splat_nv_free_buffer(inst, pick_res.source_indices);

  SplatNvFrameStats stats = {};
  stats.struct_size = sizeof(stats);
  assert(splat_nv_render_frame(inst, &stats) == SPLAT_NV_OK);
  assert(stats.visible_splats == 1022 && stats.active_sh_degree == 3);

  uint32_t rw = 0, rh = 0;
  uint8_t* rgba = nullptr;
  assert(splat_nv_readback_rgba(inst, &rw, &rh, &rgba) == SPLAT_NV_OK);
  assert(rw == 128 && rh == 128 && rgba != nullptr && rgba[0] == 140);
  splat_nv_free_buffer(inst, rgba);

  assert(splat_nv_unload_asset(inst, aid) == SPLAT_NV_OK);
  splat_nv_destroy(inst);

  std::printf(
    "{\"ok\":true,\"abi\":\"%u.%u\",\"sizes\":{\"SplatNvCapabilities\":%zu,\"SplatNvPresentTarget\":%zu,\"SplatNvCreateDesc\":%zu,\"SplatNvAssetDesc\":%zu,\"SplatNvCamera\":%zu,\"SplatNvInputEvent\":%zu,\"SplatNvCommand\":%zu,\"SplatNvPickRectDesc\":%zu,\"SplatNvPickResult\":%zu,\"SplatNvFrameStats\":%zu,\"SplatNvErrorInfo\":%zu}}\n",
    SPLAT_NV_ABI_MAJOR, SPLAT_NV_ABI_MINOR,
    sizeof(SplatNvCapabilities), sizeof(SplatNvPresentTarget), sizeof(SplatNvCreateDesc),
    sizeof(SplatNvAssetDesc), sizeof(SplatNvCamera), sizeof(SplatNvInputEvent),
    sizeof(SplatNvCommand), sizeof(SplatNvPickRectDesc), sizeof(SplatNvPickResult),
    sizeof(SplatNvFrameStats), sizeof(SplatNvErrorInfo));
  return 0;
}
