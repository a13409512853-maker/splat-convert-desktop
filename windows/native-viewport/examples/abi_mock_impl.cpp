/**
 * Reference Mock Implementation of splat_native_viewport_abi.h (v1.1 ABI Validation).
 * Used to verify cross-language C# P/Invoke struct layout, calling convention, error propagation,
 * asset lifecycle, sparse flags, SH/sphere commands, readback, and explicit buffer disposal.
 */
#include "splat_native_viewport_abi.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

struct MockAsset {
  SplatNvAssetId id;
  std::string path;
  std::string key;
  uint32_t point_count;
  std::vector<uint8_t> flags;
};

struct SplatNvInstance_T {
  uint32_t coord_system = SPLAT_NV_COORD_Y_UP;
  SplatNvPresentTarget present_target = {};
  SplatNvCamera camera = {};
  uint32_t display_mode = SPLAT_NV_DISPLAY_SPLAT;
  uint32_t sh_degree = 3;
  SplatNvBoundingSphereCmd sphere = {{0.0f, 0.0f, 0.0f}, 1.0f, 0u, 0u};
  bool device_lost = false;
  uint32_t next_asset_id = 1;
  uint64_t frames_rendered = 0;
  std::unordered_map<SplatNvAssetId, MockAsset> assets;
  std::unordered_set<void*> owned_buffers;
  int32_t last_error_code = SPLAT_NV_OK;
  std::string last_error_msg;

  SplatNvStatus set_err(SplatNvStatus code, const char* msg) {
    last_error_code = static_cast<int32_t>(code);
    last_error_msg = msg ? msg : "";
    return code;
  }
};

static bool check_abi_compatible(uint32_t caller_abi) {
  const uint32_t caller_major = caller_abi >> 16;
  return caller_major == SPLAT_NV_ABI_MAJOR;
}

extern "C" {

SPLAT_NV_API uint32_t SPLAT_NV_CALL splat_nv_get_abi_version(void) {
  return SPLAT_NV_ABI_VERSION;
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_query_capabilities(SplatNvCapabilities* out_caps) {
  if (!out_caps || out_caps->struct_size < sizeof(SplatNvCapabilities)) {
    return SPLAT_NV_ERR_INVALID_ARG;
  }
  const uint32_t sz = out_caps->struct_size;
  std::memset(out_caps, 0, sz);
  out_caps->struct_size = sz;
  out_caps->abi_version = SPLAT_NV_ABI_VERSION;
  std::snprintf(out_caps->backend_name, sizeof(out_caps->backend_name), "SplatNV-Mock-ABI-v1.1");
  out_caps->max_sh_degree = 3;
  out_caps->supports_gpu_radix_sort = 1;
  out_caps->supports_gpu_picking = 1;
  out_caps->supports_hwnd_present = 1;
  out_caps->supports_dcomp_present = 1;
  out_caps->supports_offscreen_present = 1;
  out_caps->supports_sparse_flag_delta = 1;
  out_caps->max_splats_hint = 40000000ULL;
  out_caps->vram_budget_bytes = 16ULL * 1024ULL * 1024ULL * 1024ULL;
  return SPLAT_NV_OK;
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_create(const SplatNvCreateDesc* desc, SplatNvHandle* out_handle) {
  if (!desc || !out_handle || desc->struct_size < sizeof(SplatNvCreateDesc)) {
    return SPLAT_NV_ERR_INVALID_ARG;
  }
  if (!check_abi_compatible(desc->abi_version)) {
    *out_handle = nullptr;
    return SPLAT_NV_ERR_ABI_MISMATCH;
  }
  auto* inst = new (std::nothrow) SplatNvInstance_T();
  if (!inst) {
    *out_handle = nullptr;
    return SPLAT_NV_ERR_OUT_OF_MEMORY;
  }
  inst->coord_system = desc->coord_system ? desc->coord_system : static_cast<uint32_t>(SPLAT_NV_COORD_Y_UP);
  inst->present_target = desc->present_target;
  inst->present_target.struct_size = sizeof(SplatNvPresentTarget);
  if (inst->present_target.width == 0) inst->present_target.width = 256;
  if (inst->present_target.height == 0) inst->present_target.height = 256;
  *out_handle = inst;
  return SPLAT_NV_OK;
}

SPLAT_NV_API void SPLAT_NV_CALL splat_nv_destroy(SplatNvHandle handle) {
  if (!handle) return;
  for (void* ptr : handle->owned_buffers) {
    std::free(ptr);
  }
  handle->owned_buffers.clear();
  delete handle;
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_set_present_target(SplatNvHandle handle, const SplatNvPresentTarget* target) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!target || target->struct_size < sizeof(SplatNvPresentTarget)) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "Invalid SplatNvPresentTarget descriptor");
  }
  if (target->mode == SPLAT_NV_PRESENT_HWND && target->hwnd == nullptr) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "HWND present mode requires non-null hwnd");
  }
  if (target->mode == SPLAT_NV_PRESENT_DIRECT_COMPOSITION && target->dcomp_visual == nullptr) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "DirectComposition mode requires non-null dcomp_visual");
  }
  handle->present_target = *target;
  return handle->set_err(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_resize(SplatNvHandle handle, uint32_t width, uint32_t height, float dpi_scale) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (width == 0 || height == 0 || dpi_scale <= 0.0f) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "Resize requires positive width, height and dpi_scale");
  }
  handle->present_target.width = width;
  handle->present_target.height = height;
  handle->present_target.dpi_scale = dpi_scale;
  return handle->set_err(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_load_asset(SplatNvHandle handle, const SplatNvAssetDesc* desc, SplatNvAssetId* out_asset_id) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!desc || !out_asset_id || desc->struct_size < sizeof(SplatNvAssetDesc) || !desc->utf8_path || !desc->utf8_path[0]) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "Asset descriptor requires valid utf8_path");
  }
  const SplatNvAssetId id = handle->next_asset_id++;
  MockAsset a;
  a.id = id;
  a.path = desc->utf8_path;
  a.key = desc->asset_key ? desc->asset_key : "primary";
  a.point_count = 1024;
  a.flags.assign(a.point_count, 0);
  handle->assets.emplace(id, std::move(a));
  *out_asset_id = id;
  return handle->set_err(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_unload_asset(SplatNvHandle handle, SplatNvAssetId asset_id) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  auto it = handle->assets.find(asset_id);
  if (it == handle->assets.end()) {
    return handle->set_err(SPLAT_NV_ERR_ASSET_NOT_FOUND, "Unknown asset_id on unload");
  }
  handle->assets.erase(it);
  return handle->set_err(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_set_camera(SplatNvHandle handle, const SplatNvCamera* cam) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!cam || cam->struct_size < sizeof(SplatNvCamera)) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "Invalid SplatNvCamera struct");
  }
  handle->camera = *cam;
  return handle->set_err(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_push_input(SplatNvHandle handle, const SplatNvInputEvent* ev) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!ev || ev->struct_size < sizeof(SplatNvInputEvent)) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "Invalid SplatNvInputEvent struct");
  }
  return handle->set_err(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_submit_command(SplatNvHandle handle, const SplatNvCommand* cmd) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!cmd || cmd->struct_size < sizeof(SplatNvCommand)) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "Invalid SplatNvCommand struct");
  }
  switch (cmd->type) {
    case SPLAT_NV_CMD_SET_DISPLAY_MODE:
      handle->display_mode = cmd->payload.display_mode;
      return handle->set_err(SPLAT_NV_OK, "");
    case SPLAT_NV_CMD_SET_SH_DEGREE:
      handle->sh_degree = cmd->payload.sh_degree > 3u ? 3u : cmd->payload.sh_degree;
      return handle->set_err(SPLAT_NV_OK, "");
    case SPLAT_NV_CMD_SET_BOUNDING_SPHERE:
      handle->sphere = cmd->payload.bounding_sphere;
      return handle->set_err(SPLAT_NV_OK, "");
    case SPLAT_NV_CMD_SIMULATE_DEVICE_LOST:
      handle->device_lost = true;
      return handle->set_err(SPLAT_NV_ERR_DEVICE_LOST, "Simulated Vulkan VK_ERROR_DEVICE_LOST");
    case SPLAT_NV_CMD_APPLY_SPARSE_FLAGS: {
      const auto& d = cmd->payload.sparse_flags;
      auto it = handle->assets.find(d.asset_id);
      if (it == handle->assets.end()) {
        return handle->set_err(SPLAT_NV_ERR_ASSET_NOT_FOUND, "Asset not found for sparse flag delta");
      }
      if (d.count > 0 && (!d.source_indices || !d.flags)) {
        return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "Null pointer in sparse flag delta");
      }
      auto& dst = it->second.flags;
      for (uint32_t i = 0; i < d.count; ++i) {
        const uint32_t si = d.source_indices[i];
        if (si < dst.size()) dst[si] = d.flags[i];
      }
      return handle->set_err(SPLAT_NV_OK, "");
    }
    case SPLAT_NV_CMD_SET_OBJECT_MATRIX:
    case SPLAT_NV_CMD_REQUEST_SORT:
      return handle->set_err(SPLAT_NV_OK, "");
    default:
      return handle->set_err(SPLAT_NV_ERR_UNSUPPORTED, "Unknown command type");
  }
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_pick_rect(SplatNvHandle handle, const SplatNvPickRectDesc* desc, SplatNvPickResult* out_result) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!desc || !out_result || desc->struct_size < sizeof(SplatNvPickRectDesc) || out_result->struct_size < sizeof(SplatNvPickResult)) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "Invalid pick rect arguments");
  }
  auto it = handle->assets.find(desc->asset_id);
  if (it == handle->assets.end()) {
    return handle->set_err(SPLAT_NV_ERR_ASSET_NOT_FOUND, "Asset not found for pick_rect");
  }
  std::vector<uint32_t> hits;
  for (uint32_t i = 0; i < it->second.point_count && hits.size() < 16; i += 32) {
    if ((it->second.flags[i] & 0x02u) == 0) hits.push_back(i);
  }
  uint32_t* buf = nullptr;
  if (!hits.empty()) {
    buf = static_cast<uint32_t*>(std::malloc(hits.size() * sizeof(uint32_t)));
    if (!buf) return handle->set_err(SPLAT_NV_ERR_OUT_OF_MEMORY, "Failed to allocate pick buffer");
    std::memcpy(buf, hits.data(), hits.size() * sizeof(uint32_t));
    handle->owned_buffers.insert(buf);
  }
  out_result->asset_id = desc->asset_id;
  out_result->hit_count = static_cast<uint32_t>(hits.size());
  out_result->source_indices = buf;
  return handle->set_err(SPLAT_NV_OK, "");
}

SPLAT_NV_API void SPLAT_NV_CALL splat_nv_free_buffer(SplatNvHandle handle, void* ptr) {
  if (!handle || !ptr) return;
  auto it = handle->owned_buffers.find(ptr);
  if (it != handle->owned_buffers.end()) {
    handle->owned_buffers.erase(it);
    std::free(ptr);
  }
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_render_frame(SplatNvHandle handle, SplatNvFrameStats* out_stats) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (handle->device_lost) {
    return handle->set_err(SPLAT_NV_ERR_DEVICE_LOST, "Device is in lost state");
  }
  handle->frames_rendered++;
  uint64_t total = 0;
  uint64_t vis = 0;
  for (const auto& kv : handle->assets) {
    total += kv.second.point_count;
    for (uint8_t f : kv.second.flags) {
      if ((f & 0x06u) == 0) vis++;
    }
  }
  if (out_stats && out_stats->struct_size >= offsetof(SplatNvFrameStats, present_wait_ms)) {
    out_stats->frame_time_ms = 1.25;
    out_stats->sort_time_ms = 0.40;
    out_stats->raster_time_ms = 0.85;
    out_stats->total_splats = total;
    out_stats->visible_splats = vis;
    out_stats->vram_used_bytes = total * 48ULL;
    if (out_stats->struct_size >= sizeof(SplatNvFrameStats)) {
      out_stats->present_wait_ms = 0.05;
      out_stats->active_sh_degree = handle->sh_degree;
      out_stats->gpu_sort_active = 1u;
    }
  }
  return handle->set_err(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_readback_rgba(SplatNvHandle handle, uint32_t* out_width, uint32_t* out_height, uint8_t** out_rgba_pixels) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!out_width || !out_height || !out_rgba_pixels) {
    return handle->set_err(SPLAT_NV_ERR_INVALID_ARG, "Null out parameter in readback_rgba");
  }
  const uint32_t w = handle->present_target.width ? handle->present_target.width : 64u;
  const uint32_t h = handle->present_target.height ? handle->present_target.height : 64u;
  const size_t bytes = static_cast<size_t>(w) * static_cast<size_t>(h) * 4u;
  auto* buf = static_cast<uint8_t*>(std::malloc(bytes));
  if (!buf) return handle->set_err(SPLAT_NV_ERR_OUT_OF_MEMORY, "Failed to allocate readback buffer");
  for (size_t i = 0; i < bytes; i += 4) {
    buf[i + 0] = static_cast<uint8_t>(20 + handle->sh_degree * 40);
    buf[i + 1] = 24;
    buf[i + 2] = 30;
    buf[i + 3] = 255;
  }
  handle->owned_buffers.insert(buf);
  *out_width = w;
  *out_height = h;
  *out_rgba_pixels = buf;
  return handle->set_err(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_get_last_error(SplatNvHandle handle, SplatNvErrorInfo* out_error) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!out_error || out_error->struct_size < sizeof(SplatNvErrorInfo)) return SPLAT_NV_ERR_INVALID_ARG;
  out_error->status_code = handle->last_error_code;
  std::snprintf(out_error->message, sizeof(out_error->message), "%s", handle->last_error_msg.c_str());
  return SPLAT_NV_OK;
}

}  // extern "C"
