#ifndef SPLAT_NATIVE_VIEWPORT_ABI_H
#define SPLAT_NATIVE_VIEWPORT_ABI_H

/**
 * Splat Convert Desktop — Versioned Native Vulkan Viewport C-ABI (v1.1)
 *
 * Design Contracts (002-A -> 002-B):
 *  1. Coordinate Space: Strict right-handed +Y-up world space (matches domain/contracts.mjs).
 *  2. Presentation Decoupling: Presentation target (HWND child swapchain, DirectComposition
 *     visual, or headless offscreen surface) is cleanly isolated from asset/camera/edit APIs.
 *  3. Zero-Copy Asset Handoff: Large point clouds (14M-35M+ Gaussians) are loaded by file path
 *     directly inside the native backend (.ply full SH0-3 or .sgc3 compact SoA) — never JSON/base64.
 *  4. Explicit Ownership: Any buffer returned by the DLL (pick results, RGBA readback) MUST be freed
 *     via `splat_nv_free_buffer(handle, ptr)` on the same instance before `splat_nv_destroy`.
 *  5. Extensibility: Every descriptor/output struct starts with `uint32_t struct_size` so minor
 *     ABI additions (v1.0 -> v1.1) remain binary-compatible across host/backend upgrades.
 */

#include <stdint.h>
#include <stddef.h>

#if defined(_WIN32)
  #if defined(SPLAT_NV_BUILD_DLL)
    #define SPLAT_NV_API __declspec(dllexport)
  #elif defined(SPLAT_NV_USE_DLL)
    #define SPLAT_NV_API __declspec(dllimport)
  #else
    #define SPLAT_NV_API
  #endif
  #define SPLAT_NV_CALL __cdecl
#else
  #define SPLAT_NV_API __attribute__((visibility("default")))
  #define SPLAT_NV_CALL
#endif

#define SPLAT_NV_ABI_MAJOR 1u
#define SPLAT_NV_ABI_MINOR 1u
#define SPLAT_NV_MAKE_ABI_VERSION(maj, min) ((((uint32_t)(maj)) << 16) | ((uint32_t)(min) & 0xFFFFu))
#define SPLAT_NV_ABI_VERSION SPLAT_NV_MAKE_ABI_VERSION(SPLAT_NV_ABI_MAJOR, SPLAT_NV_ABI_MINOR)

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SplatNvInstance_T* SplatNvHandle;
typedef uint32_t SplatNvAssetId;

typedef enum SplatNvStatus {
  SPLAT_NV_OK = 0,
  SPLAT_NV_ERR_INVALID_ARG = -1,
  SPLAT_NV_ERR_ABI_MISMATCH = -2,
  SPLAT_NV_ERR_INVALID_HANDLE = -3,
  SPLAT_NV_ERR_UNSUPPORTED = -4,
  SPLAT_NV_ERR_IO = -5,
  SPLAT_NV_ERR_GPU_DEVICE = -6,
  SPLAT_NV_ERR_OUT_OF_MEMORY = -7,
  SPLAT_NV_ERR_ASSET_NOT_FOUND = -8,
  SPLAT_NV_ERR_DEVICE_LOST = -9,
  SPLAT_NV_ERR_INTERNAL = -99
} SplatNvStatus;

typedef enum SplatNvPresentMode {
  SPLAT_NV_PRESENT_NONE = 0,
  SPLAT_NV_PRESENT_HWND = 1,               /* Phase 002-B: native Vulkan Win32 HWND child swapchain */
  SPLAT_NV_PRESENT_DIRECT_COMPOSITION = 2, /* Future: WinForms/WebView2 layered DirectComposition visual */
  SPLAT_NV_PRESENT_OFFSCREEN_HEADLESS = 3  /* Automated benchmark & deterministic readback */
} SplatNvPresentMode;

typedef enum SplatNvCoordSystem {
  SPLAT_NV_COORD_Y_UP = 1,
  SPLAT_NV_COORD_Z_UP = 2
} SplatNvCoordSystem;

typedef enum SplatNvDisplayMode {
  SPLAT_NV_DISPLAY_SPLAT = 0,
  SPLAT_NV_DISPLAY_CENTERS = 1,
  SPLAT_NV_DISPLAY_RINGS = 2
} SplatNvDisplayMode;

typedef enum SplatNvCommandType {
  SPLAT_NV_CMD_SET_DISPLAY_MODE = 1,
  SPLAT_NV_CMD_APPLY_SPARSE_FLAGS = 2,
  SPLAT_NV_CMD_SET_OBJECT_MATRIX = 3,
  SPLAT_NV_CMD_REQUEST_SORT = 4,
  SPLAT_NV_CMD_SET_SH_DEGREE = 5,          /* v1.1: live SH evaluation degree 0..3 */
  SPLAT_NV_CMD_SET_BOUNDING_SPHERE = 6,    /* v1.1: real-time GPU adjustable bounding sphere */
  SPLAT_NV_CMD_SIMULATE_DEVICE_LOST = 7    /* v1.1: deterministic device-loss fallback test hook */
} SplatNvCommandType;

typedef enum SplatNvInputType {
  SPLAT_NV_INPUT_POINTER_MOVE = 1,
  SPLAT_NV_INPUT_POINTER_DOWN = 2,
  SPLAT_NV_INPUT_POINTER_UP = 3,
  SPLAT_NV_INPUT_WHEEL = 4,
  SPLAT_NV_INPUT_KEY_DOWN = 5,
  SPLAT_NV_INPUT_KEY_UP = 6
} SplatNvInputType;

typedef struct SplatNvCapabilities {
  uint32_t struct_size;
  uint32_t abi_version;
  char     backend_name[64];
  uint32_t max_sh_degree;                  /* 0..3 (0 = SH0 SGC3, 3 = full SH3) */
  uint32_t supports_gpu_radix_sort;        /* 1 if Vulkan compute radix sort available */
  uint32_t supports_gpu_picking;           /* 1 if native rect picking available */
  uint32_t supports_hwnd_present;          /* 1 if Win32 VK_KHR_win32_surface supported */
  uint32_t supports_dcomp_present;         /* 1 if DirectComposition interop supported */
  uint32_t supports_offscreen_present;     /* 1 if headless offscreen render supported */
  uint32_t supports_sparse_flag_delta;     /* 1 if O(changed) SSBO flag updates supported */
  uint64_t max_splats_hint;                /* Advisory capacity hint (e.g. 40,000,000) */
  uint64_t vram_budget_bytes;              /* Detected device-local VRAM budget in bytes */
} SplatNvCapabilities;

typedef struct SplatNvPresentTarget {
  uint32_t struct_size;
  uint32_t mode;                           /* SplatNvPresentMode */
  void*    hwnd;                           /* Win32 HWND when mode == SPLAT_NV_PRESENT_HWND */
  void*    dcomp_visual;                   /* IDCompositionVisual* when mode == DIRECT_COMPOSITION */
  uint32_t width;
  uint32_t height;
  float    dpi_scale;
} SplatNvPresentTarget;

typedef struct SplatNvCreateDesc {
  uint32_t             struct_size;
  uint32_t             abi_version;        /* Caller passes SPLAT_NV_ABI_VERSION */
  uint32_t             coord_system;       /* SplatNvCoordSystem (default: SPLAT_NV_COORD_Y_UP) */
  uint32_t             enable_validation;  /* 1 to enable Vulkan validation layers in debug */
  SplatNvPresentTarget present_target;     /* Initial presentation target (can be changed later) */
} SplatNvCreateDesc;

typedef struct SplatNvAssetDesc {
  uint32_t    struct_size;
  const char* utf8_path;                   /* Path to .sgc3 / .ply source file */
  const char* asset_key;                   /* Logical domain assetId (e.g. "primary") */
  uint32_t    max_sh_degree;               /* Requested SH degree (0..3) */
  uint32_t    reserved;
} SplatNvAssetDesc;

typedef struct SplatNvCamera {
  uint32_t struct_size;
  float    position[3];                    /* World +Y-up camera position */
  float    target[3];                      /* World +Y-up look-at target */
  float    up[3];                          /* Typically [0, 1, 0] */
  float    fov_y_deg;                      /* Perspective vertical FOV in degrees */
  float    near_plane;
  float    far_plane;
  uint32_t is_ortho;                       /* 0 = perspective, 1 = orthographic */
  float    ortho_half_height;
} SplatNvCamera;

typedef struct SplatNvInputEvent {
  uint32_t struct_size;
  uint32_t type;                           /* SplatNvInputType */
  float    x;                              /* Viewport client X (logical px) */
  float    y;                              /* Viewport client Y (logical px) */
  float    delta_x;
  float    delta_y;
  uint32_t button;                         /* 0=left, 1=middle, 2=right */
  uint32_t modifiers;                      /* bit0=Shift, bit1=Ctrl, bit2=Alt */
  uint32_t key_code;
} SplatNvInputEvent;

typedef struct SplatNvSparseFlagDelta {
  SplatNvAssetId  asset_id;
  uint32_t        count;
  const uint32_t* source_indices;          /* Canonical source indices */
  const uint8_t*  flags;                   /* bit0=selected, bit1=deleted, bit2=hidden */
} SplatNvSparseFlagDelta;

typedef struct SplatNvObjectMatrixCmd {
  SplatNvAssetId asset_id;
  uint32_t       object_id;
  float          matrix16[16];             /* Column-major 4x4 world transform */
} SplatNvObjectMatrixCmd;

typedef struct SplatNvBoundingSphereCmd {
  float    center[3];                      /* World +Y-up sphere center */
  float    radius;                         /* Sphere radius (> 0) */
  uint32_t enabled;                        /* 1 = active scope & GPU tint/overlay */
  uint32_t invert;                         /* 1 = select outside sphere instead of inside */
} SplatNvBoundingSphereCmd;

typedef struct SplatNvCommand {
  uint32_t struct_size;
  uint32_t type;                           /* SplatNvCommandType */
  union {
    uint32_t                 display_mode; /* SplatNvDisplayMode */
    SplatNvSparseFlagDelta   sparse_flags;
    SplatNvObjectMatrixCmd   object_matrix;
    uint32_t                 force_sort;
    uint32_t                 sh_degree;    /* 0..3 for SPLAT_NV_CMD_SET_SH_DEGREE */
    SplatNvBoundingSphereCmd bounding_sphere;
  } payload;
} SplatNvCommand;

typedef struct SplatNvPickRectDesc {
  uint32_t       struct_size;
  SplatNvAssetId asset_id;                 /* 0 = all loaded assets */
  float          min_ndc_x;
  float          max_ndc_x;
  float          min_ndc_y;
  float          max_ndc_y;
  uint32_t       only_visible;             /* 1 = front-surface visible picking only */
  uint32_t       whole_gaussian;           /* 1 = include projected Gaussian ellipse extents */
} SplatNvPickRectDesc;

typedef struct SplatNvPickResult {
  uint32_t       struct_size;
  SplatNvAssetId asset_id;
  uint32_t       hit_count;
  uint32_t*      source_indices;           /* Backend-owned buffer; MUST free via splat_nv_free_buffer() */
} SplatNvPickResult;

typedef struct SplatNvFrameStats {
  uint32_t struct_size;
  double   frame_time_ms;                  /* End-to-end wall time of render_frame */
  double   sort_time_ms;                   /* GPU timestamp: depth key-gen + radix sort */
  double   raster_time_ms;                 /* GPU timestamp: Gaussian + overlay rasterization */
  uint64_t total_splats;
  uint64_t visible_splats;
  uint64_t vram_used_bytes;
  /* v1.1 additive fields (checked via struct_size) */
  double   present_wait_ms;                /* CPU wait + swapchain acquire/present overhead */
  uint32_t active_sh_degree;               /* 0..3 currently evaluated in shader */
  uint32_t gpu_sort_active;                /* 1 if GPU radix sort ran on device */
} SplatNvFrameStats;

typedef struct SplatNvErrorInfo {
  uint32_t struct_size;
  int32_t  status_code;
  char     message[256];
} SplatNvErrorInfo;

/* --- Version & Capability Queries (safe without an active instance) --- */
SPLAT_NV_API uint32_t      SPLAT_NV_CALL splat_nv_get_abi_version(void);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_query_capabilities(SplatNvCapabilities* out_caps);

/* --- Instance Lifecycle & Presentation Target --- */
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_create(const SplatNvCreateDesc* desc, SplatNvHandle* out_handle);
SPLAT_NV_API void          SPLAT_NV_CALL splat_nv_destroy(SplatNvHandle handle);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_set_present_target(SplatNvHandle handle, const SplatNvPresentTarget* target);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_resize(SplatNvHandle handle, uint32_t width, uint32_t height, float dpi_scale);

/* --- Asset Management (Path/Handle-Based, Zero JSON Point Marshaling) --- */
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_load_asset(SplatNvHandle handle, const SplatNvAssetDesc* desc, SplatNvAssetId* out_asset_id);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_unload_asset(SplatNvHandle handle, SplatNvAssetId asset_id);

/* --- Camera, Input, Lightweight Edit Commands & Picking --- */
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_set_camera(SplatNvHandle handle, const SplatNvCamera* cam);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_push_input(SplatNvHandle handle, const SplatNvInputEvent* ev);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_submit_command(SplatNvHandle handle, const SplatNvCommand* cmd);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_pick_rect(SplatNvHandle handle, const SplatNvPickRectDesc* desc, SplatNvPickResult* out_result);

/* --- Explicit Buffer Disposal, Frame Render, Readback & Error Query --- */
SPLAT_NV_API void          SPLAT_NV_CALL splat_nv_free_buffer(SplatNvHandle handle, void* ptr);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_render_frame(SplatNvHandle handle, SplatNvFrameStats* out_stats);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_readback_rgba(SplatNvHandle handle, uint32_t* out_width, uint32_t* out_height, uint8_t** out_rgba_pixels);
SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_get_last_error(SplatNvHandle handle, SplatNvErrorInfo* out_error);

#ifdef __cplusplus
}
#endif

#endif /* SPLAT_NATIVE_VIEWPORT_ABI_H */
