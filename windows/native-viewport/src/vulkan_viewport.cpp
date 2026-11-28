/**
 * Splat Convert Desktop — Real Vulkan 1.3 Native Bypass Viewport DLL (C-ABI v1.1)
 *
 * Original MIT implementation (ZERO GPL/LGPL code, ZERO heavy external frameworks):
 *  - Win32 child HWND swapchain (VK_KHR_win32_surface) + OFFSCREEN_HEADLESS + RGBA readback
 *  - Direct device-local SSBO upload (32 B/splat SH0 + optional 96 B/splat full SH0..SH3)
 *  - 8-pass 4-bit Bitmask-Stable 32-bit GPU Radix Sort (compute shaders, 1..40M+ splats)
 *  - Hardware VkQueryPool GPU timestamps cleanly separating sort_time_ms, raster_time_ms, present_wait_ms
 *  - Full SH0/SH1/SH2/SH3 view-dependent evaluation, Splat/Centers/Rings modes, sparse flag SSBO,
 *    GPU adjustable bounding sphere + procedural wireframe overlay, multi-threaded rect picking,
 *    and deterministic device init failure / VK_ERROR_DEVICE_LOST fallback hooks.
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#define VK_USE_PLATFORM_WIN32_KHR
#include <vulkan/vulkan.h>

#include "splat_native_viewport_abi.h"
#include "asset_loader.h"
#include "generated_shaders.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {

constexpr uint32_t NUM_RADIX_BLOCKS = 512u;
constexpr float DEG2RAD = 3.14159265358979323846f / 180.0f;

struct Mat4 {
  float m[16]; // column-major
};

struct Vec3 {
  float x, y, z;
};

static inline Vec3 vsub(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
static inline float vdot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static inline Vec3 vcross(Vec3 a, Vec3 b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
static inline Vec3 vnorm(Vec3 v) {
  const float l = std::sqrt(vdot(v, v));
  if (l < 1e-8f) return {0.0f, 0.0f, -1.0f};
  const float inv = 1.0f / l;
  return {v.x * inv, v.y * inv, v.z * inv};
}

static Mat4 mat4_identity() {
  Mat4 r = {};
  r.m[0] = r.m[5] = r.m[10] = r.m[15] = 1.0f;
  return r;
}

static Mat4 mat4_mul(const Mat4& a, const Mat4& b) {
  Mat4 out = {};
  for (int col = 0; col < 4; ++col) {
    for (int row = 0; row < 4; ++row) {
      float sum = 0.0f;
      for (int k = 0; k < 4; ++k) sum += a.m[k * 4 + row] * b.m[col * 4 + k];
      out.m[col * 4 + row] = sum;
    }
  }
  return out;
}

// Right-handed +Y-up look-at (camera looks down -Z)
static Mat4 mat4_look_at(Vec3 eye, Vec3 target, Vec3 up) {
  Vec3 f = vnorm(vsub(target, eye));
  Vec3 s = vnorm(vcross(f, up));
  if (std::sqrt(vdot(s, s)) < 1e-5f) s = {1.0f, 0.0f, 0.0f};
  Vec3 u = vcross(s, f);
  Mat4 r = mat4_identity();
  r.m[0] = s.x;  r.m[4] = s.y;  r.m[8]  = s.z;  r.m[12] = -vdot(s, eye);
  r.m[1] = u.x;  r.m[5] = u.y;  r.m[9]  = u.z;  r.m[13] = -vdot(u, eye);
  r.m[2] = -f.x; r.m[6] = -f.y; r.m[10] = -f.z; r.m[14] = vdot(f, eye);
  return r;
}

// Vulkan right-handed perspective [0, 1] depth, Y-flipped for Vulkan clip space (+Y down)
static Mat4 mat4_perspective_vk(float fovYDeg, float aspect, float nearP, float farP) {
  const float fov = std::max(5.0f, std::min(160.0f, fovYDeg)) * DEG2RAD;
  const float f = 1.0f / std::tan(fov * 0.5f);
  const float n = std::max(0.005f, nearP);
  const float fa = std::max(n + 1.0f, farP);
  Mat4 r = {};
  r.m[0] = f / std::max(0.05f, aspect);
  r.m[5] = -f; // Flip Y for Vulkan clip space so +Y-up world maps to top of screen!
  r.m[10] = -fa / (fa - n);
  r.m[11] = -1.0f;
  r.m[14] = -(fa * n) / (fa - n);
  return r;
}

struct KeygenPushConst {
  Mat4 modelView;
  Mat4 proj;
  uint32_t totalCount;
  float nearPlane;
  float farPlane;
  uint32_t pad0;
};

struct FrameUboData {
  Mat4 viewMat;
  Mat4 projMat;
  Mat4 objMat;
  float camPos[4];
  float viewport[4];
  float sphereParams[4];
  uint32_t flagsMeta[4];
};

struct GpuBuffer {
  VkBuffer buf = VK_NULL_HANDLE;
  VkDeviceMemory mem = VK_NULL_HANDLE;
  VkDeviceSize size = 0;
  void* mapped = nullptr;
};

struct GpuAsset {
  SplatNvAssetId id = 0;
  std::string key;
  uint32_t count = 0;
  uint32_t totalSource = 0;
  uint32_t shDegree = 0;
  bool hasNonSeqSrcIdx = false;

  Mat4 objectMatrix = mat4_identity();
  std::vector<float> cpuPos;       // count * 3 (fast multi-threaded pick_rect)
  std::vector<uint8_t> cpuFlags;   // count (source-indexed flags)
  std::vector<uint32_t> srcIndices;

  GpuBuffer bufPosRgba;
  GpuBuffer bufGeom;
  GpuBuffer bufFlags;
  GpuBuffer bufShRest;
  uint64_t vramBytes = 0;
};

} // namespace

struct SplatNvInstance_T {
  // Vulkan core
  VkInstance instance = VK_NULL_HANDLE;
  VkPhysicalDevice physDev = VK_NULL_HANDLE;
  VkDevice device = VK_NULL_HANDLE;
  VkQueue queue = VK_NULL_HANDLE;
  uint32_t queueFamily = 0;
  float timestampPeriodNs = 1.0f;
  std::string gpuName;
  uint64_t vramBudgetBytes = 0;

  VkCommandPool cmdPool = VK_NULL_HANDLE;
  VkCommandBuffer cmdBuf = VK_NULL_HANDLE;
  VkFence frameFence = VK_NULL_HANDLE;
  VkSemaphore semImageAvail = VK_NULL_HANDLE;
  VkSemaphore semRenderDone = VK_NULL_HANDLE;
  VkQueryPool queryPool = VK_NULL_HANDLE;

  // Offscreen color attachment (always rendered here -> readback OR blit to HWND swapchain)
  uint32_t width = 256;
  uint32_t height = 256;
  float dpiScale = 1.0f;
  VkImage colorImage = VK_NULL_HANDLE;
  VkDeviceMemory colorMem = VK_NULL_HANDLE;
  VkImageView colorView = VK_NULL_HANDLE;
  VkRenderPass renderPass = VK_NULL_HANDLE;
  VkFramebuffer framebuffer = VK_NULL_HANDLE;

  // Optional Win32 HWND swapchain
  SplatNvPresentTarget presentTarget = {};
  VkSurfaceKHR surface = VK_NULL_HANDLE;
  VkSwapchainKHR swapchain = VK_NULL_HANDLE;
  std::vector<VkImage> swapImages;
  VkExtent2D swapExtent = {0, 0};
  VkFormat swapFormat = VK_FORMAT_B8G8R8A8_UNORM;
  std::string presentModeName = "OFFSCREEN";

  // Pipelines & layouts
  VkDescriptorPool descPool = VK_NULL_HANDLE;
  VkDescriptorSetLayout dslKeygen = VK_NULL_HANDLE;
  VkDescriptorSetLayout dslHist = VK_NULL_HANDLE;
  VkDescriptorSetLayout dslScan = VK_NULL_HANDLE;
  VkDescriptorSetLayout dslScatter = VK_NULL_HANDLE;
  VkDescriptorSetLayout dslRender = VK_NULL_HANDLE;

  VkPipelineLayout plKeygen = VK_NULL_HANDLE;
  VkPipelineLayout plHist = VK_NULL_HANDLE;
  VkPipelineLayout plScan = VK_NULL_HANDLE;
  VkPipelineLayout plScatter = VK_NULL_HANDLE;
  VkPipelineLayout plRender = VK_NULL_HANDLE;

  VkPipeline pipeKeygen = VK_NULL_HANDLE;
  VkPipeline pipeHist = VK_NULL_HANDLE;
  VkPipeline pipeScan = VK_NULL_HANDLE;
  VkPipeline pipeScatter = VK_NULL_HANDLE;
  VkPipeline pipeSplat = VK_NULL_HANDLE;
  VkPipeline pipeSphere = VK_NULL_HANDLE;

  VkDescriptorSet dsKeygen = VK_NULL_HANDLE;
  VkDescriptorSet dsHistA = VK_NULL_HANDLE;
  VkDescriptorSet dsHistB = VK_NULL_HANDLE;
  VkDescriptorSet dsScan = VK_NULL_HANDLE;
  VkDescriptorSet dsScatterA2B = VK_NULL_HANDLE;
  VkDescriptorSet dsScatterB2A = VK_NULL_HANDLE;
  VkDescriptorSet dsRender = VK_NULL_HANDLE;

  // Dynamic sort & frame buffers
  GpuBuffer bufDummy;
  GpuBuffer bufFrameUbo;
  GpuBuffer bufIndirect;
  GpuBuffer bufIndirectReadback;
  GpuBuffer bufBlockHist;
  GpuBuffer bufBinTotals;
  GpuBuffer bufKeysA;
  GpuBuffer bufKeysB;
  GpuBuffer bufValsA;
  GpuBuffer bufValsB;
  uint32_t sortCapacity = 0;

  // Scene state
  uint32_t coordSystem = SPLAT_NV_COORD_Y_UP;
  SplatNvCamera camera = {};
  uint32_t displayMode = SPLAT_NV_DISPLAY_SPLAT;
  uint32_t activeShDegree = 3;
  SplatNvBoundingSphereCmd sphere = {{0, 0, 0}, 1.0f, 0u, 0u};
  bool deviceLost = false;
  uint32_t nextAssetId = 1;
  SplatNvAssetId activeAssetId = 0;
  std::unordered_map<SplatNvAssetId, GpuAsset> assets;
  std::unordered_set<void*> ownedBuffers;
  uint64_t dynamicVramBytes = 0;
  bool descriptorsDirty = true;

  int32_t lastErrorCode = SPLAT_NV_OK;
  std::string lastErrorMsg;

  SplatNvStatus setErr(SplatNvStatus code, const std::string& msg) {
    lastErrorCode = static_cast<int32_t>(code);
    lastErrorMsg = msg;
    return code;
  }

  uint32_t findMemoryType(uint32_t typeBits, VkMemoryPropertyFlags props) const {
    VkPhysicalDeviceMemoryProperties mp = {};
    vkGetPhysicalDeviceMemoryProperties(physDev, &mp);
    for (uint32_t i = 0; i < mp.memoryTypeCount; ++i) {
      if ((typeBits & (1u << i)) && ((mp.memoryTypes[i].propertyFlags & props) == props)) {
        return i;
      }
    }
    for (uint32_t i = 0; i < mp.memoryTypeCount; ++i) {
      if (typeBits & (1u << i)) return i;
    }
    return 0;
  }

  bool createBuffer(VkDeviceSize size, VkBufferUsageFlags usage, VkMemoryPropertyFlags memProps, GpuBuffer& out, bool mapPersistent = false) {
    destroyBuffer(out);
    VkDeviceSize allocSz = std::max<VkDeviceSize>(16, size);
    VkBufferCreateInfo bi = {VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
    bi.size = allocSz;
    bi.usage = usage;
    bi.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    if (vkCreateBuffer(device, &bi, nullptr, &out.buf) != VK_SUCCESS) return false;

    VkMemoryRequirements mr = {};
    vkGetBufferMemoryRequirements(device, out.buf, &mr);
    VkMemoryAllocateInfo ai = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    ai.allocationSize = mr.size;
    ai.memoryTypeIndex = findMemoryType(mr.memoryTypeBits, memProps);
    if (vkAllocateMemory(device, &ai, nullptr, &out.mem) != VK_SUCCESS) {
      vkDestroyBuffer(device, out.buf, nullptr);
      out.buf = VK_NULL_HANDLE;
      return false;
    }
    if (vkBindBufferMemory(device, out.buf, out.mem, 0) != VK_SUCCESS) {
      destroyBuffer(out);
      return false;
    }
    out.size = allocSz;
    if (mapPersistent) {
      if (vkMapMemory(device, out.mem, 0, allocSz, 0, &out.mapped) != VK_SUCCESS) {
        destroyBuffer(out);
        return false;
      }
    }
    return true;
  }

  void destroyBuffer(GpuBuffer& b) {
    if (!device) return;
    if (b.mapped && b.mem) {
      vkUnmapMemory(device, b.mem);
      b.mapped = nullptr;
    }
    if (b.buf) { vkDestroyBuffer(device, b.buf, nullptr); b.buf = VK_NULL_HANDLE; }
    if (b.mem) { vkFreeMemory(device, b.mem, nullptr); b.mem = VK_NULL_HANDLE; }
    b.size = 0;
  }

  bool submitOneShot(const std::function<void(VkCommandBuffer)>& fn) {
    VkCommandBufferAllocateInfo ai = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    ai.commandPool = cmdPool;
    ai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    ai.commandBufferCount = 1;
    VkCommandBuffer cb = VK_NULL_HANDLE;
    if (vkAllocateCommandBuffers(device, &ai, &cb) != VK_SUCCESS) return false;
    VkCommandBufferBeginInfo bi = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(cb, &bi);
    fn(cb);
    vkEndCommandBuffer(cb);
    VkSubmitInfo si = {VK_STRUCTURE_TYPE_SUBMIT_INFO};
    si.commandBufferCount = 1;
    si.pCommandBuffers = &cb;
    VkResult r = vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE);
    if (r == VK_SUCCESS) r = vkQueueWaitIdle(queue);
    vkFreeCommandBuffers(device, cmdPool, 1, &cb);
    return r == VK_SUCCESS;
  }

  bool uploadToDeviceBufferChunked(const void* srcData, VkDeviceSize totalBytes, GpuBuffer& dst) {
    if (totalBytes == 0) return true;
    const VkDeviceSize chunkMax = std::min<VkDeviceSize>(totalBytes, 64ULL << 20);
    GpuBuffer staging;
    if (!createBuffer(chunkMax, VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                      staging, true)) {
      return false;
    }
    const auto* src = static_cast<const uint8_t*>(srcData);
    VkDeviceSize off = 0;
    bool ok = true;
    while (off < totalBytes && ok) {
      const VkDeviceSize take = std::min(chunkMax, totalBytes - off);
      std::memcpy(staging.mapped, src + off, static_cast<size_t>(take));
      ok = submitOneShot([&](VkCommandBuffer cb) {
        VkBufferCopy reg = {};
        reg.srcOffset = 0;
        reg.dstOffset = off;
        reg.size = take;
        vkCmdCopyBuffer(cb, staging.buf, dst.buf, 1, &reg);
      });
      off += take;
    }
    destroyBuffer(staging);
    return ok;
  }

  bool ensureSortCapacity(uint32_t needed) {
    if (needed <= sortCapacity && sortCapacity > 0) return true;
    vkDeviceWaitIdle(device);
    const uint32_t cap = std::max<uint32_t>(1024u, needed);
    const VkDeviceSize bytes = static_cast<VkDeviceSize>(cap) * sizeof(uint32_t);
    const VkBufferUsageFlags usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    if (!createBuffer(bytes, usage, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, bufKeysA) ||
        !createBuffer(bytes, usage, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, bufKeysB) ||
        !createBuffer(bytes, usage, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, bufValsA) ||
        !createBuffer(bytes, usage, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, bufValsB)) {
      return false;
    }
    sortCapacity = cap;
    dynamicVramBytes = bytes * 4ULL + bufBlockHist.size + bufBinTotals.size + bufIndirect.size + static_cast<uint64_t>(width) * height * 4ULL;
    descriptorsDirty = true;
    return true;
  }

  void destroyOffscreenTarget() {
    if (!device) return;
    if (framebuffer) { vkDestroyFramebuffer(device, framebuffer, nullptr); framebuffer = VK_NULL_HANDLE; }
    if (colorView) { vkDestroyImageView(device, colorView, nullptr); colorView = VK_NULL_HANDLE; }
    if (colorImage) { vkDestroyImage(device, colorImage, nullptr); colorImage = VK_NULL_HANDLE; }
    if (colorMem) { vkFreeMemory(device, colorMem, nullptr); colorMem = VK_NULL_HANDLE; }
  }

  bool createOffscreenTarget(uint32_t w, uint32_t h) {
    destroyOffscreenTarget();
    width = std::max<uint32_t>(16u, w);
    height = std::max<uint32_t>(16u, h);

    VkImageCreateInfo ii = {VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
    ii.imageType = VK_IMAGE_TYPE_2D;
    ii.format = VK_FORMAT_R8G8B8A8_UNORM;
    ii.extent = {width, height, 1};
    ii.mipLevels = 1;
    ii.arrayLayers = 1;
    ii.samples = VK_SAMPLE_COUNT_1_BIT;
    ii.tiling = VK_IMAGE_TILING_OPTIMAL;
    ii.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
    ii.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    ii.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    if (vkCreateImage(device, &ii, nullptr, &colorImage) != VK_SUCCESS) return false;

    VkMemoryRequirements mr = {};
    vkGetImageMemoryRequirements(device, colorImage, &mr);
    VkMemoryAllocateInfo ai = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    ai.allocationSize = mr.size;
    ai.memoryTypeIndex = findMemoryType(mr.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    if (vkAllocateMemory(device, &ai, nullptr, &colorMem) != VK_SUCCESS) return false;
    if (vkBindImageMemory(device, colorImage, colorMem, 0) != VK_SUCCESS) return false;

    VkImageViewCreateInfo vi = {VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
    vi.image = colorImage;
    vi.viewType = VK_IMAGE_VIEW_TYPE_2D;
    vi.format = VK_FORMAT_R8G8B8A8_UNORM;
    vi.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    if (vkCreateImageView(device, &vi, nullptr, &colorView) != VK_SUCCESS) return false;

    VkFramebufferCreateInfo fi = {VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};
    fi.renderPass = renderPass;
    fi.attachmentCount = 1;
    fi.pAttachments = &colorView;
    fi.width = width;
    fi.height = height;
    fi.layers = 1;
    if (vkCreateFramebuffer(device, &fi, nullptr, &framebuffer) != VK_SUCCESS) return false;
    return true;
  }

  void destroySwapchain(bool destroySurfaceToo) {
    if (!device) return;
    vkDeviceWaitIdle(device);
    swapImages.clear();
    if (swapchain) { vkDestroySwapchainKHR(device, swapchain, nullptr); swapchain = VK_NULL_HANDLE; }
    if (destroySurfaceToo && surface) {
      vkDestroySurfaceKHR(instance, surface, nullptr);
      surface = VK_NULL_HANDLE;
    }
    if (destroySurfaceToo) presentModeName = "OFFSCREEN";
  }

  bool createSwapchainForSurface(uint32_t reqW, uint32_t reqH) {
    if (!surface) return false;
    VkSurfaceCapabilitiesKHR sc = {};
    if (vkGetPhysicalDeviceSurfaceCapabilitiesKHR(physDev, surface, &sc) != VK_SUCCESS) return false;
    if (sc.maxImageExtent.width == 0 || sc.maxImageExtent.height == 0) return false;

    uint32_t fmtCount = 0;
    vkGetPhysicalDeviceSurfaceFormatsKHR(physDev, surface, &fmtCount, nullptr);
    std::vector<VkSurfaceFormatKHR> fmts(fmtCount);
    vkGetPhysicalDeviceSurfaceFormatsKHR(physDev, surface, &fmtCount, fmts.data());
    VkSurfaceFormatKHR chosenFmt = fmts.empty() ? VkSurfaceFormatKHR{VK_FORMAT_B8G8R8A8_UNORM, VK_COLOR_SPACE_SRGB_NONLINEAR_KHR} : fmts[0];
    for (const auto& f : fmts) {
      if (f.format == VK_FORMAT_B8G8R8A8_UNORM && f.colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR) {
        chosenFmt = f;
        break;
      }
    }

    uint32_t pmCount = 0;
    vkGetPhysicalDeviceSurfacePresentModesKHR(physDev, surface, &pmCount, nullptr);
    std::vector<VkPresentModeKHR> pms(pmCount);
    vkGetPhysicalDeviceSurfacePresentModesKHR(physDev, surface, &pmCount, pms.data());
    // Prefer IMMEDIATE (uncapped real frame latency) -> MAILBOX -> FIFO
    VkPresentModeKHR chosenPm = VK_PRESENT_MODE_FIFO_KHR;
    presentModeName = "FIFO";
    for (auto pm : pms) {
      if (pm == VK_PRESENT_MODE_MAILBOX_KHR) { chosenPm = pm; presentModeName = "MAILBOX"; }
    }
    for (auto pm : pms) {
      if (pm == VK_PRESENT_MODE_IMMEDIATE_KHR) { chosenPm = pm; presentModeName = "IMMEDIATE"; break; }
    }

    VkExtent2D ext = sc.currentExtent;
    if (ext.width == 0xFFFFFFFFu || ext.height == 0xFFFFFFFFu) {
      ext.width = std::max(sc.minImageExtent.width, std::min(sc.maxImageExtent.width, std::max<uint32_t>(16u, reqW)));
      ext.height = std::max(sc.minImageExtent.height, std::min(sc.maxImageExtent.height, std::max<uint32_t>(16u, reqH)));
    }
    if (ext.width == 0 || ext.height == 0) return false;

    uint32_t imgCount = std::max(2u, sc.minImageCount);
    if (sc.maxImageCount > 0 && imgCount > sc.maxImageCount) imgCount = sc.maxImageCount;

    VkSwapchainKHR oldSc = swapchain;
    VkSwapchainCreateInfoKHR ci = {VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};
    ci.surface = surface;
    ci.minImageCount = imgCount;
    ci.imageFormat = chosenFmt.format;
    ci.imageColorSpace = chosenFmt.colorSpace;
    ci.imageExtent = ext;
    ci.imageArrayLayers = 1;
    ci.imageUsage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
    ci.imageSharingMode = VK_SHARING_MODE_EXCLUSIVE;
    ci.preTransform = sc.currentTransform;
    ci.compositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
    ci.presentMode = chosenPm;
    ci.clipped = VK_TRUE;
    ci.oldSwapchain = oldSc;

    VkSwapchainKHR newSc = VK_NULL_HANDLE;
    if (vkCreateSwapchainKHR(device, &ci, nullptr, &newSc) != VK_SUCCESS) return false;
    if (oldSc) vkDestroySwapchainKHR(device, oldSc, nullptr);
    swapchain = newSc;
    swapExtent = ext;
    swapFormat = chosenFmt.format;

    uint32_t actualCount = 0;
    vkGetSwapchainImagesKHR(device, swapchain, &actualCount, nullptr);
    swapImages.resize(actualCount);
    vkGetSwapchainImagesKHR(device, swapchain, &actualCount, swapImages.data());
    return true;
  }

  bool createShaderModule(const uint32_t* code, size_t wordCount, VkShaderModule& out) {
    VkShaderModuleCreateInfo ci = {VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
    ci.codeSize = wordCount * sizeof(uint32_t);
    ci.pCode = code;
    return vkCreateShaderModule(device, &ci, nullptr, &out) == VK_SUCCESS;
  }

  bool initVulkan(uint32_t reqW, uint32_t reqH, const SplatNvPresentTarget& target) {
    // Deterministic device-init failure test hook (uses live Win32 process env so C# Environment.SetEnvironmentVariable is seen under /MT!)
    char envBuf[16] = {};
    if (GetEnvironmentVariableA("SPLAT_NV_FORCE_INIT_FAIL", envBuf, static_cast<DWORD>(sizeof(envBuf))) > 0 && envBuf[0] == '1') {
      setErr(SPLAT_NV_ERR_GPU_DEVICE, "Forced GPU device initialization failure (SPLAT_NV_FORCE_INIT_FAIL=1)");
      return false;
    }

    VkApplicationInfo app = {VK_STRUCTURE_TYPE_APPLICATION_INFO};
    app.pApplicationName = "SplatConvertDesktopNativeViewport";
    app.applicationVersion = VK_MAKE_VERSION(3, 2, 3);
    app.pEngineName = "SplatNV-Vulkan13";
    app.engineVersion = VK_MAKE_VERSION(1, 1, 0);
    app.apiVersion = VK_API_VERSION_1_3;

    const char* instExts[] = {VK_KHR_SURFACE_EXTENSION_NAME, VK_KHR_WIN32_SURFACE_EXTENSION_NAME};
    VkInstanceCreateInfo ici = {VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    ici.pApplicationInfo = &app;
    ici.enabledExtensionCount = 2;
    ici.ppEnabledExtensionNames = instExts;
    if (vkCreateInstance(&ici, nullptr, &instance) != VK_SUCCESS) {
      setErr(SPLAT_NV_ERR_GPU_DEVICE, "vkCreateInstance failed");
      return false;
    }

    uint32_t devCount = 0;
    vkEnumeratePhysicalDevices(instance, &devCount, nullptr);
    if (devCount == 0) {
      setErr(SPLAT_NV_ERR_GPU_DEVICE, "No Vulkan-capable GPU detected");
      return false;
    }
    std::vector<VkPhysicalDevice> devs(devCount);
    vkEnumeratePhysicalDevices(instance, &devCount, devs.data());

    // Prefer discrete GPU (NVIDIA RTX) with graphics + compute queue
    int bestScore = -1;
    for (auto d : devs) {
      VkPhysicalDeviceProperties props = {};
      vkGetPhysicalDeviceProperties(d, &props);
      uint32_t qCount = 0;
      vkGetPhysicalDeviceQueueFamilyProperties(d, &qCount, nullptr);
      std::vector<VkQueueFamilyProperties> qps(qCount);
      vkGetPhysicalDeviceQueueFamilyProperties(d, &qCount, qps.data());
      int qIdx = -1;
      for (uint32_t i = 0; i < qCount; ++i) {
        if ((qps[i].queueFlags & (VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT)) == (VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT)) {
          qIdx = static_cast<int>(i);
          break;
        }
      }
      if (qIdx < 0) continue;
      int score = (props.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) ? 1000 : 100;
      if (props.vendorID == 0x10DE) score += 500; // Prefer NVIDIA discrete GPU
      if (score > bestScore) {
        bestScore = score;
        physDev = d;
        queueFamily = static_cast<uint32_t>(qIdx);
        timestampPeriodNs = props.limits.timestampPeriod > 0.0f ? props.limits.timestampPeriod : 1.0f;
        gpuName = props.deviceName;
      }
    }
    if (!physDev) {
      setErr(SPLAT_NV_ERR_GPU_DEVICE, "No Vulkan device with combined graphics+compute queue");
      return false;
    }

    VkPhysicalDeviceMemoryProperties mp = {};
    vkGetPhysicalDeviceMemoryProperties(physDev, &mp);
    for (uint32_t i = 0; i < mp.memoryHeapCount; ++i) {
      if (mp.memoryHeaps[i].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT) {
        vramBudgetBytes = std::max<uint64_t>(vramBudgetBytes, mp.memoryHeaps[i].size);
      }
    }

    // Query & enable Vulkan 1.3 shaderDemoteToHelperInvocation so GLSL discard passes Validation Layers cleanly
    VkPhysicalDeviceVulkan13Features feat13 = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
    VkPhysicalDeviceFeatures2 feats2 = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2};
    feats2.pNext = &feat13;
    vkGetPhysicalDeviceFeatures2(physDev, &feats2);
    VkPhysicalDeviceVulkan13Features enable13 = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
    enable13.shaderDemoteToHelperInvocation = feat13.shaderDemoteToHelperInvocation;

    float qPrio = 1.0f;
    VkDeviceQueueCreateInfo qci = {VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
    qci.queueFamilyIndex = queueFamily;
    qci.queueCount = 1;
    qci.pQueuePriorities = &qPrio;
    const char* devExts[] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
    VkDeviceCreateInfo dci = {VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
    dci.pNext = feat13.shaderDemoteToHelperInvocation ? &enable13 : nullptr;
    dci.queueCreateInfoCount = 1;
    dci.pQueueCreateInfos = &qci;
    dci.enabledExtensionCount = 1;
    dci.ppEnabledExtensionNames = devExts;
    if (vkCreateDevice(physDev, &dci, nullptr, &device) != VK_SUCCESS) {
      setErr(SPLAT_NV_ERR_GPU_DEVICE, "vkCreateDevice failed");
      return false;
    }
    vkGetDeviceQueue(device, queueFamily, 0, &queue);

    // Command pool, buffer, fence, semaphores, timestamp query pool
    VkCommandPoolCreateInfo cpci = {VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    cpci.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    cpci.queueFamilyIndex = queueFamily;
    if (vkCreateCommandPool(device, &cpci, nullptr, &cmdPool) != VK_SUCCESS) return false;

    VkCommandBufferAllocateInfo cbai = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    cbai.commandPool = cmdPool;
    cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cbai.commandBufferCount = 1;
    if (vkAllocateCommandBuffers(device, &cbai, &cmdBuf) != VK_SUCCESS) return false;

    VkFenceCreateInfo fci = {VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    fci.flags = VK_FENCE_CREATE_SIGNALED_BIT;
    vkCreateFence(device, &fci, nullptr, &frameFence);
    VkSemaphoreCreateInfo sci = {VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    vkCreateSemaphore(device, &sci, nullptr, &semImageAvail);
    vkCreateSemaphore(device, &sci, nullptr, &semRenderDone);

    VkQueryPoolCreateInfo qpci = {VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};
    qpci.queryType = VK_QUERY_TYPE_TIMESTAMP;
    qpci.queryCount = 4;
    vkCreateQueryPool(device, &qpci, nullptr, &queryPool);

    // RenderPass: RGBA8_UNORM color attachment -> TRANSFER_SRC_OPTIMAL
    VkAttachmentDescription att = {};
    att.format = VK_FORMAT_R8G8B8A8_UNORM;
    att.samples = VK_SAMPLE_COUNT_1_BIT;
    att.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    att.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    att.stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
    att.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    att.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    att.finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;

    VkAttachmentReference ref = {0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
    VkSubpassDescription sp = {};
    sp.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
    sp.colorAttachmentCount = 1;
    sp.pColorAttachments = &ref;

    VkSubpassDependency dep = {};
    dep.srcSubpass = VK_SUBPASS_EXTERNAL;
    dep.dstSubpass = 0;
    dep.srcStageMask = VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT;
    dep.dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT | VK_PIPELINE_STAGE_VERTEX_SHADER_BIT | VK_PIPELINE_STAGE_DRAW_INDIRECT_BIT;
    dep.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT;
    dep.dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_INDIRECT_COMMAND_READ_BIT;

    VkRenderPassCreateInfo rpci = {VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO};
    rpci.attachmentCount = 1;
    rpci.pAttachments = &att;
    rpci.subpassCount = 1;
    rpci.pSubpasses = &sp;
    rpci.dependencyCount = 1;
    rpci.pDependencies = &dep;
    if (vkCreateRenderPass(device, &rpci, nullptr, &renderPass) != VK_SUCCESS) return false;

    if (!createOffscreenTarget(reqW, reqH)) return false;

    // Static utility buffers
    createBuffer(64, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, bufDummy);
    createBuffer(sizeof(FrameUboData), VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, bufFrameUbo, true);
    createBuffer(16, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, bufIndirect);
    createBuffer(16, VK_BUFFER_USAGE_TRANSFER_DST_BIT, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, bufIndirectReadback, true);
    createBuffer(16ULL * NUM_RADIX_BLOCKS * sizeof(uint32_t), VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, bufBlockHist);
    createBuffer(16ULL * sizeof(uint32_t), VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, bufBinTotals);
    if (!ensureSortCapacity(1024u)) return false;

    if (!initPipelinesAndDescriptors()) return false;

    // Attach initial HWND surface if provided
    presentTarget = target;
    presentTarget.struct_size = sizeof(SplatNvPresentTarget);
    if (target.mode == SPLAT_NV_PRESENT_HWND && target.hwnd != nullptr) {
      VkWin32SurfaceCreateInfoKHR wci = {VK_STRUCTURE_TYPE_WIN32_SURFACE_CREATE_INFO_KHR};
      wci.hinstance = GetModuleHandleW(nullptr);
      wci.hwnd = static_cast<HWND>(target.hwnd);
      if (vkCreateWin32SurfaceKHR(instance, &wci, nullptr, &surface) == VK_SUCCESS) {
        createSwapchainForSurface(width, height);
      }
    }
    return true;
  }

  bool initPipelinesAndDescriptors() {
    auto makeDsl = [&](const std::vector<VkDescriptorSetLayoutBinding>& bindings, VkDescriptorSetLayout& out) -> bool {
      VkDescriptorSetLayoutCreateInfo ci = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
      ci.bindingCount = static_cast<uint32_t>(bindings.size());
      ci.pBindings = bindings.data();
      return vkCreateDescriptorSetLayout(device, &ci, nullptr, &out) == VK_SUCCESS;
    };
    auto ssbo = [](uint32_t b, VkShaderStageFlags st) {
      VkDescriptorSetLayoutBinding x = {};
      x.binding = b; x.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; x.descriptorCount = 1; x.stageFlags = st;
      return x;
    };
    auto uboB = [](uint32_t b, VkShaderStageFlags st) {
      VkDescriptorSetLayoutBinding x = {};
      x.binding = b; x.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER; x.descriptorCount = 1; x.stageFlags = st;
      return x;
    };

    if (!makeDsl({ssbo(0, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(1, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(2, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(3, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(4, VK_SHADER_STAGE_COMPUTE_BIT)}, dslKeygen)) return false;
    if (!makeDsl({ssbo(0, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(1, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(2, VK_SHADER_STAGE_COMPUTE_BIT)}, dslHist)) return false;
    if (!makeDsl({ssbo(0, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(1, VK_SHADER_STAGE_COMPUTE_BIT)}, dslScan)) return false;
    if (!makeDsl({ssbo(0, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(1, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(2, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(3, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(4, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(5, VK_SHADER_STAGE_COMPUTE_BIT), ssbo(6, VK_SHADER_STAGE_COMPUTE_BIT)}, dslScatter)) return false;
    if (!makeDsl({ssbo(0, VK_SHADER_STAGE_VERTEX_BIT), ssbo(1, VK_SHADER_STAGE_VERTEX_BIT), ssbo(2, VK_SHADER_STAGE_VERTEX_BIT), ssbo(3, VK_SHADER_STAGE_VERTEX_BIT), ssbo(4, VK_SHADER_STAGE_VERTEX_BIT), uboB(5, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT)}, dslRender)) return false;

    auto makePl = [&](VkDescriptorSetLayout dsl, uint32_t pcSize, VkShaderStageFlags pcStage, VkPipelineLayout& out) -> bool {
      VkPushConstantRange pcr = {pcStage, 0, pcSize};
      VkPipelineLayoutCreateInfo ci = {VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
      ci.setLayoutCount = 1; ci.pSetLayouts = &dsl;
      if (pcSize > 0) { ci.pushConstantRangeCount = 1; ci.pPushConstantRanges = &pcr; }
      return vkCreatePipelineLayout(device, &ci, nullptr, &out) == VK_SUCCESS;
    };
    if (!makePl(dslKeygen, sizeof(KeygenPushConst), VK_SHADER_STAGE_COMPUTE_BIT, plKeygen)) return false;
    if (!makePl(dslHist, sizeof(uint32_t), VK_SHADER_STAGE_COMPUTE_BIT, plHist)) return false;
    if (!makePl(dslScan, 0, 0, plScan)) return false;
    if (!makePl(dslScatter, sizeof(uint32_t), VK_SHADER_STAGE_COMPUTE_BIT, plScatter)) return false;
    if (!makePl(dslRender, 0, 0, plRender)) return false;

    auto makeCompPipe = [&](const uint32_t* spv, size_t words, VkPipelineLayout pl, VkPipeline& out) -> bool {
      VkShaderModule sm = VK_NULL_HANDLE;
      if (!createShaderModule(spv, words, sm)) return false;
      VkComputePipelineCreateInfo ci = {VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
      ci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
      ci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
      ci.stage.module = sm;
      ci.stage.pName = "main";
      ci.layout = pl;
      VkResult r = vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &ci, nullptr, &out);
      vkDestroyShaderModule(device, sm, nullptr);
      return r == VK_SUCCESS;
    };

    if (!makeCompPipe(SPV_SPLAT_KEYGEN, sizeof(SPV_SPLAT_KEYGEN) / 4, plKeygen, pipeKeygen)) return false;
    if (!makeCompPipe(SPV_RADIX_HIST, sizeof(SPV_RADIX_HIST) / 4, plHist, pipeHist)) return false;
    if (!makeCompPipe(SPV_RADIX_SCAN, sizeof(SPV_RADIX_SCAN) / 4, plScan, pipeScan)) return false;
    if (!makeCompPipe(SPV_RADIX_SCATTER, sizeof(SPV_RADIX_SCATTER) / 4, plScatter, pipeScatter)) return false;

    auto makeGfxPipe = [&](const uint32_t* vs, size_t vw, const uint32_t* fs, size_t fw, VkPrimitiveTopology topo, VkPipeline& out) -> bool {
      VkShaderModule smV = VK_NULL_HANDLE, smF = VK_NULL_HANDLE;
      if (!createShaderModule(vs, vw, smV) || !createShaderModule(fs, fw, smF)) {
        if (smV) vkDestroyShaderModule(device, smV, nullptr);
        if (smF) vkDestroyShaderModule(device, smF, nullptr);
        return false;
      }
      VkPipelineShaderStageCreateInfo stages[2] = {};
      stages[0].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
      stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT; stages[0].module = smV; stages[0].pName = "main";
      stages[1].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
      stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT; stages[1].module = smF; stages[1].pName = "main";

      VkPipelineVertexInputStateCreateInfo vi = {VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
      VkPipelineInputAssemblyStateCreateInfo ia = {VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};
      ia.topology = topo;
      VkPipelineViewportStateCreateInfo vp = {VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};
      vp.viewportCount = 1; vp.scissorCount = 1;
      VkDynamicState dynStates[2] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
      VkPipelineDynamicStateCreateInfo dyn = {VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO};
      dyn.dynamicStateCount = 2; dyn.pDynamicStates = dynStates;

      VkPipelineRasterizationStateCreateInfo rs = {VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};
      rs.polygonMode = VK_POLYGON_MODE_FILL;
      rs.cullMode = VK_CULL_MODE_NONE;
      rs.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE;
      rs.lineWidth = 1.0f;
      VkPipelineMultisampleStateCreateInfo ms = {VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};
      ms.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;

      // Back-to-front premultiplied alpha compositing: dst = src.rgb + (1 - src.a) * dst.rgb
      VkPipelineColorBlendAttachmentState cba = {};
      cba.blendEnable = VK_TRUE;
      cba.srcColorBlendFactor = VK_BLEND_FACTOR_ONE;
      cba.dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
      cba.colorBlendOp = VK_BLEND_OP_ADD;
      cba.srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
      cba.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
      cba.alphaBlendOp = VK_BLEND_OP_ADD;
      cba.colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;
      VkPipelineColorBlendStateCreateInfo cb = {VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};
      cb.attachmentCount = 1; cb.pAttachments = &cba;

      VkGraphicsPipelineCreateInfo gci = {VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO};
      gci.stageCount = 2; gci.pStages = stages;
      gci.pVertexInputState = &vi;
      gci.pInputAssemblyState = &ia;
      gci.pViewportState = &vp;
      gci.pRasterizationState = &rs;
      gci.pMultisampleState = &ms;
      gci.pColorBlendState = &cb;
      gci.pDynamicState = &dyn;
      gci.layout = plRender;
      gci.renderPass = renderPass;
      gci.subpass = 0;

      VkResult r = vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &gci, nullptr, &out);
      vkDestroyShaderModule(device, smV, nullptr);
      vkDestroyShaderModule(device, smF, nullptr);
      return r == VK_SUCCESS;
    };

    if (!makeGfxPipe(SPV_SPLAT_VERT, sizeof(SPV_SPLAT_VERT) / 4, SPV_SPLAT_FRAG, sizeof(SPV_SPLAT_FRAG) / 4, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, pipeSplat)) return false;
    if (!makeGfxPipe(SPV_SPHERE_VERT, sizeof(SPV_SPHERE_VERT) / 4, SPV_SPHERE_FRAG, sizeof(SPV_SPHERE_FRAG) / 4, VK_PRIMITIVE_TOPOLOGY_LINE_LIST, pipeSphere)) return false;

    // Descriptor Pool & Sets
    VkDescriptorPoolSize sizes[2] = {
      {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 48},
      {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 4}
    };
    VkDescriptorPoolCreateInfo dpci = {VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
    dpci.maxSets = 12;
    dpci.poolSizeCount = 2;
    dpci.pPoolSizes = sizes;
    if (vkCreateDescriptorPool(device, &dpci, nullptr, &descPool) != VK_SUCCESS) return false;

    auto allocDs = [&](VkDescriptorSetLayout dsl, VkDescriptorSet& out) -> bool {
      VkDescriptorSetAllocateInfo ai = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
      ai.descriptorPool = descPool;
      ai.descriptorSetCount = 1;
      ai.pSetLayouts = &dsl;
      return vkAllocateDescriptorSets(device, &ai, &out) == VK_SUCCESS;
    };
    if (!allocDs(dslKeygen, dsKeygen) || !allocDs(dslHist, dsHistA) || !allocDs(dslHist, dsHistB) ||
        !allocDs(dslScan, dsScan) || !allocDs(dslScatter, dsScatterA2B) || !allocDs(dslScatter, dsScatterB2A) ||
        !allocDs(dslRender, dsRender)) {
      return false;
    }
    descriptorsDirty = true;
    return true;
  }

  void updateDescriptorsForAsset(const GpuAsset* asset) {
    VkBuffer bPos = asset && asset->bufPosRgba.buf ? asset->bufPosRgba.buf : bufDummy.buf;
    VkBuffer bGeom = asset && asset->bufGeom.buf ? asset->bufGeom.buf : bufDummy.buf;
    VkBuffer bFlg = asset && asset->bufFlags.buf ? asset->bufFlags.buf : bufDummy.buf;
    VkBuffer bSh = asset && asset->bufShRest.buf ? asset->bufShRest.buf : bufDummy.buf;

    std::vector<VkDescriptorBufferInfo> infos;
    infos.reserve(36);
    std::vector<VkWriteDescriptorSet> writes;
    writes.reserve(36);

    auto addW = [&](VkDescriptorSet ds, uint32_t binding, VkDescriptorType tp, VkBuffer buf) {
      infos.push_back(VkDescriptorBufferInfo{buf, 0, VK_WHOLE_SIZE});
      VkWriteDescriptorSet w = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
      w.dstSet = ds;
      w.dstBinding = binding;
      w.descriptorCount = 1;
      w.descriptorType = tp;
      w.pBufferInfo = &infos.back();
      writes.push_back(w);
    };

    // dsKeygen
    addW(dsKeygen, 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bPos);
    addW(dsKeygen, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bFlg);
    addW(dsKeygen, 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufKeysA.buf);
    addW(dsKeygen, 3, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufValsA.buf);
    addW(dsKeygen, 4, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufIndirect.buf);

    // dsHistA / dsHistB
    addW(dsHistA, 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufKeysA.buf);
    addW(dsHistA, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufBlockHist.buf);
    addW(dsHistA, 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufIndirect.buf);
    addW(dsHistB, 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufKeysB.buf);
    addW(dsHistB, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufBlockHist.buf);
    addW(dsHistB, 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufIndirect.buf);

    // dsScan
    addW(dsScan, 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufBlockHist.buf);
    addW(dsScan, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufBinTotals.buf);

    // dsScatterA2B
    addW(dsScatterA2B, 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufKeysA.buf);
    addW(dsScatterA2B, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufValsA.buf);
    addW(dsScatterA2B, 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufKeysB.buf);
    addW(dsScatterA2B, 3, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufValsB.buf);
    addW(dsScatterA2B, 4, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufBlockHist.buf);
    addW(dsScatterA2B, 5, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufBinTotals.buf);
    addW(dsScatterA2B, 6, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufIndirect.buf);

    // dsScatterB2A
    addW(dsScatterB2A, 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufKeysB.buf);
    addW(dsScatterB2A, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufValsB.buf);
    addW(dsScatterB2A, 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufKeysA.buf);
    addW(dsScatterB2A, 3, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufValsA.buf);
    addW(dsScatterB2A, 4, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufBlockHist.buf);
    addW(dsScatterB2A, 5, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufBinTotals.buf);
    addW(dsScatterB2A, 6, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufIndirect.buf);

    // dsRender
    addW(dsRender, 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bPos);
    addW(dsRender, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bGeom);
    addW(dsRender, 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bFlg);
    addW(dsRender, 3, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bufValsA.buf);
    addW(dsRender, 4, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, bSh);
    addW(dsRender, 5, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, bufFrameUbo.buf);

    vkUpdateDescriptorSets(device, static_cast<uint32_t>(writes.size()), writes.data(), 0, nullptr);
    descriptorsDirty = false;
  }

  void destroyAssetGpu(GpuAsset& a) {
    destroyBuffer(a.bufPosRgba);
    destroyBuffer(a.bufGeom);
    destroyBuffer(a.bufFlags);
    destroyBuffer(a.bufShRest);
    a.cpuPos.clear(); a.cpuPos.shrink_to_fit();
    a.cpuFlags.clear(); a.cpuFlags.shrink_to_fit();
    a.srcIndices.clear(); a.srcIndices.shrink_to_fit();
    a.vramBytes = 0;
  }

  void shutdownVulkan() {
    if (device) {
      vkDeviceWaitIdle(device);
      for (auto& kv : assets) destroyAssetGpu(kv.second);
      assets.clear();
      destroySwapchain(true);
      destroyOffscreenTarget();

      destroyBuffer(bufKeysA); destroyBuffer(bufKeysB);
      destroyBuffer(bufValsA); destroyBuffer(bufValsB);
      destroyBuffer(bufBlockHist); destroyBuffer(bufBinTotals);
      destroyBuffer(bufIndirect); destroyBuffer(bufIndirectReadback);
      destroyBuffer(bufFrameUbo); destroyBuffer(bufDummy);

      if (pipeKeygen) vkDestroyPipeline(device, pipeKeygen, nullptr);
      if (pipeHist) vkDestroyPipeline(device, pipeHist, nullptr);
      if (pipeScan) vkDestroyPipeline(device, pipeScan, nullptr);
      if (pipeScatter) vkDestroyPipeline(device, pipeScatter, nullptr);
      if (pipeSplat) vkDestroyPipeline(device, pipeSplat, nullptr);
      if (pipeSphere) vkDestroyPipeline(device, pipeSphere, nullptr);

      if (plKeygen) vkDestroyPipelineLayout(device, plKeygen, nullptr);
      if (plHist) vkDestroyPipelineLayout(device, plHist, nullptr);
      if (plScan) vkDestroyPipelineLayout(device, plScan, nullptr);
      if (plScatter) vkDestroyPipelineLayout(device, plScatter, nullptr);
      if (plRender) vkDestroyPipelineLayout(device, plRender, nullptr);

      if (dslKeygen) vkDestroyDescriptorSetLayout(device, dslKeygen, nullptr);
      if (dslHist) vkDestroyDescriptorSetLayout(device, dslHist, nullptr);
      if (dslScan) vkDestroyDescriptorSetLayout(device, dslScan, nullptr);
      if (dslScatter) vkDestroyDescriptorSetLayout(device, dslScatter, nullptr);
      if (dslRender) vkDestroyDescriptorSetLayout(device, dslRender, nullptr);
      if (descPool) vkDestroyDescriptorPool(device, descPool, nullptr);

      if (renderPass) vkDestroyRenderPass(device, renderPass, nullptr);
      if (queryPool) vkDestroyQueryPool(device, queryPool, nullptr);
      if (semImageAvail) vkDestroySemaphore(device, semImageAvail, nullptr);
      if (semRenderDone) vkDestroySemaphore(device, semRenderDone, nullptr);
      if (frameFence) vkDestroyFence(device, frameFence, nullptr);
      if (cmdPool) vkDestroyCommandPool(device, cmdPool, nullptr);

      vkDestroyDevice(device, nullptr);
      device = VK_NULL_HANDLE;
    }
    if (instance) {
      vkDestroyInstance(instance, nullptr);
      instance = VK_NULL_HANDLE;
    }
  }
};

static bool check_abi_compatible(uint32_t caller_abi) {
  return (caller_abi >> 16) == SPLAT_NV_ABI_MAJOR;
}

extern "C" {

SPLAT_NV_API uint32_t SPLAT_NV_CALL splat_nv_get_abi_version(void) {
  return SPLAT_NV_ABI_VERSION;
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_query_capabilities(SplatNvCapabilities* out_caps) {
  if (!out_caps || out_caps->struct_size < sizeof(SplatNvCapabilities)) return SPLAT_NV_ERR_INVALID_ARG;
  const uint32_t sz = out_caps->struct_size;
  std::memset(out_caps, 0, sz);
  out_caps->struct_size = sz;
  out_caps->abi_version = SPLAT_NV_ABI_VERSION;
  std::snprintf(out_caps->backend_name, sizeof(out_caps->backend_name), "SplatNV-Vulkan-1.3-GPU-Radix");
  out_caps->max_sh_degree = 3;
  out_caps->supports_gpu_radix_sort = 1;
  out_caps->supports_gpu_picking = 1;
  out_caps->supports_hwnd_present = 1;
  out_caps->supports_dcomp_present = 0;
  out_caps->supports_offscreen_present = 1;
  out_caps->supports_sparse_flag_delta = 1;
  out_caps->max_splats_hint = 40000000ULL;
  out_caps->vram_budget_bytes = 12ULL * 1024ULL * 1024ULL * 1024ULL;
  return SPLAT_NV_OK;
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_create(const SplatNvCreateDesc* desc, SplatNvHandle* out_handle) {
  if (!desc || !out_handle || desc->struct_size < sizeof(SplatNvCreateDesc)) return SPLAT_NV_ERR_INVALID_ARG;
  if (!check_abi_compatible(desc->abi_version)) {
    *out_handle = nullptr;
    return SPLAT_NV_ERR_ABI_MISMATCH;
  }
  auto* inst = new (std::nothrow) SplatNvInstance_T();
  if (!inst) {
    *out_handle = nullptr;
    return SPLAT_NV_ERR_OUT_OF_MEMORY;
  }
  inst->coordSystem = desc->coord_system ? desc->coord_system : static_cast<uint32_t>(SPLAT_NV_COORD_Y_UP);
  inst->camera.struct_size = sizeof(SplatNvCamera);
  inst->camera.position[2] = 4.0f;
  inst->camera.up[1] = 1.0f;
  inst->camera.fov_y_deg = 50.0f;
  inst->camera.near_plane = 0.05f;
  inst->camera.far_plane = 500.0f;

  const uint32_t w = desc->present_target.width ? desc->present_target.width : 256u;
  const uint32_t h = desc->present_target.height ? desc->present_target.height : 256u;
  inst->dpiScale = desc->present_target.dpi_scale > 0.0f ? desc->present_target.dpi_scale : 1.0f;

  if (!inst->initVulkan(w, h, desc->present_target)) {
    inst->shutdownVulkan();
    delete inst;
    *out_handle = nullptr;
    return SPLAT_NV_ERR_GPU_DEVICE;
  }
  *out_handle = inst;
  return SPLAT_NV_OK;
}

SPLAT_NV_API void SPLAT_NV_CALL splat_nv_destroy(SplatNvHandle handle) {
  if (!handle) return;
  for (void* ptr : handle->ownedBuffers) std::free(ptr);
  handle->ownedBuffers.clear();
  handle->shutdownVulkan();
  delete handle;
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_set_present_target(SplatNvHandle handle, const SplatNvPresentTarget* target) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!target || target->struct_size < sizeof(SplatNvPresentTarget)) {
    return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "Invalid SplatNvPresentTarget descriptor");
  }
  if (target->mode == SPLAT_NV_PRESENT_HWND && target->hwnd == nullptr) {
    return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "HWND present mode requires non-null hwnd");
  }
  if (target->mode == SPLAT_NV_PRESENT_DIRECT_COMPOSITION) {
    if (target->dcomp_visual == nullptr) {
      return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "DirectComposition mode requires non-null dcomp_visual");
    }
    return handle->setErr(SPLAT_NV_ERR_UNSUPPORTED, "DirectComposition visual interop reserved for 002-C");
  }
  vkDeviceWaitIdle(handle->device);
  handle->destroySwapchain(true);
  handle->presentTarget = *target;
  if (target->width > 0 && target->height > 0) {
    handle->createOffscreenTarget(target->width, target->height);
  }
  if (target->mode == SPLAT_NV_PRESENT_HWND && target->hwnd != nullptr) {
    VkWin32SurfaceCreateInfoKHR wci = {VK_STRUCTURE_TYPE_WIN32_SURFACE_CREATE_INFO_KHR};
    wci.hinstance = GetModuleHandleW(nullptr);
    wci.hwnd = static_cast<HWND>(target->hwnd);
    if (vkCreateWin32SurfaceKHR(handle->instance, &wci, nullptr, &handle->surface) != VK_SUCCESS ||
        !handle->createSwapchainForSurface(handle->width, handle->height)) {
      return handle->setErr(SPLAT_NV_ERR_GPU_DEVICE, "Failed to create Win32 Vulkan swapchain");
    }
  }
  return handle->setErr(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_resize(SplatNvHandle handle, uint32_t width, uint32_t height, float dpi_scale) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (width == 0 || height == 0 || dpi_scale <= 0.0f) {
    return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "Resize requires positive width, height and dpi_scale");
  }
  vkDeviceWaitIdle(handle->device);
  handle->dpiScale = dpi_scale;
  if (!handle->createOffscreenTarget(width, height)) {
    return handle->setErr(SPLAT_NV_ERR_GPU_DEVICE, "Failed to recreate offscreen render target on resize");
  }
  if (handle->surface) {
    handle->createSwapchainForSurface(width, height);
  }
  return handle->setErr(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_load_asset(SplatNvHandle handle, const SplatNvAssetDesc* desc, SplatNvAssetId* out_asset_id) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!desc || !out_asset_id || desc->struct_size < sizeof(SplatNvAssetDesc) || !desc->utf8_path || !desc->utf8_path[0]) {
    return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "Asset descriptor requires valid utf8_path");
  }

  LoadedSplatAsset loaded;
  std::string err;
  if (!load_splat_asset_file(desc->utf8_path, desc->max_sh_degree, loaded, err)) {
    return handle->setErr(SPLAT_NV_ERR_IO, err);
  }

  vkDeviceWaitIdle(handle->device);
  GpuAsset ga;
  ga.id = handle->nextAssetId++;
  ga.key = desc->asset_key ? desc->asset_key : "primary";
  ga.count = loaded.count;
  ga.totalSource = loaded.totalSourcePoints;
  ga.shDegree = loaded.shDegree;
  ga.hasNonSeqSrcIdx = loaded.hasNonSequentialSrcIdx;
  ga.srcIndices = std::move(loaded.srcIndices);
  ga.cpuFlags.assign(ga.count, 0u);
  ga.cpuPos.resize(static_cast<size_t>(ga.count) * 3u);
  for (uint32_t i = 0; i < ga.count; ++i) {
    ga.cpuPos[static_cast<size_t>(i) * 3u + 0] = loaded.posRgba[i].x;
    ga.cpuPos[static_cast<size_t>(i) * 3u + 1] = loaded.posRgba[i].y;
    ga.cpuPos[static_cast<size_t>(i) * 3u + 2] = loaded.posRgba[i].z;
  }

  const VkDeviceSize posBytes = static_cast<VkDeviceSize>(ga.count) * sizeof(SplatPosRgba);
  const VkDeviceSize geomBytes = static_cast<VkDeviceSize>(ga.count) * sizeof(SplatGeomHalf);
  const VkDeviceSize flagWords = (static_cast<VkDeviceSize>(ga.count) + 3ULL) / 4ULL;
  const VkDeviceSize flagBytes = std::max<VkDeviceSize>(16, flagWords * sizeof(uint32_t));
  const VkBufferUsageFlags ssboUsage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;

  if (!handle->createBuffer(posBytes, ssboUsage, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, ga.bufPosRgba) ||
      !handle->uploadToDeviceBufferChunked(loaded.posRgba.data(), posBytes, ga.bufPosRgba) ||
      !handle->createBuffer(geomBytes, ssboUsage, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, ga.bufGeom) ||
      !handle->uploadToDeviceBufferChunked(loaded.geom.data(), geomBytes, ga.bufGeom) ||
      !handle->createBuffer(flagBytes, ssboUsage, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, ga.bufFlags)) {
    handle->destroyAssetGpu(ga);
    return handle->setErr(SPLAT_NV_ERR_OUT_OF_MEMORY, "Failed to upload splat SSBOs to device VRAM");
  }
  handle->submitOneShot([&](VkCommandBuffer cb) {
    vkCmdFillBuffer(cb, ga.bufFlags.buf, 0, flagBytes, 0u);
  });

  VkDeviceSize shBytes = 0;
  if (ga.shDegree > 0 && !loaded.shRestWords.empty()) {
    shBytes = static_cast<VkDeviceSize>(loaded.shRestWords.size()) * sizeof(uint32_t);
    if (!handle->createBuffer(shBytes, ssboUsage, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, ga.bufShRest) ||
        !handle->uploadToDeviceBufferChunked(loaded.shRestWords.data(), shBytes, ga.bufShRest)) {
      handle->destroyAssetGpu(ga);
      return handle->setErr(SPLAT_NV_ERR_OUT_OF_MEMORY, "Failed to upload SH1-3 SSBO to device VRAM");
    }
  }
  ga.vramBytes = posBytes + geomBytes + flagBytes + shBytes;

  if (!handle->ensureSortCapacity(ga.count)) {
    handle->destroyAssetGpu(ga);
    return handle->setErr(SPLAT_NV_ERR_OUT_OF_MEMORY, "Failed to allocate GPU radix sort buffers");
  }

  const SplatNvAssetId id = ga.id;
  handle->assets.emplace(id, std::move(ga));
  handle->activeAssetId = id;
  handle->descriptorsDirty = true;
  *out_asset_id = id;
  return handle->setErr(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_unload_asset(SplatNvHandle handle, SplatNvAssetId asset_id) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  auto it = handle->assets.find(asset_id);
  if (it == handle->assets.end()) {
    return handle->setErr(SPLAT_NV_ERR_ASSET_NOT_FOUND, "Unknown asset_id on unload");
  }
  vkDeviceWaitIdle(handle->device);
  handle->destroyAssetGpu(it->second);
  handle->assets.erase(it);
  if (handle->activeAssetId == asset_id) {
    handle->activeAssetId = handle->assets.empty() ? 0 : handle->assets.begin()->first;
  }
  handle->descriptorsDirty = true;
  return handle->setErr(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_set_camera(SplatNvHandle handle, const SplatNvCamera* cam) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!cam || cam->struct_size < sizeof(SplatNvCamera)) {
    return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "Invalid SplatNvCamera struct");
  }
  handle->camera = *cam;
  return handle->setErr(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_push_input(SplatNvHandle handle, const SplatNvInputEvent* ev) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!ev || ev->struct_size < sizeof(SplatNvInputEvent)) {
    return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "Invalid SplatNvInputEvent struct");
  }
  return handle->setErr(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_submit_command(SplatNvHandle handle, const SplatNvCommand* cmd) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!cmd || cmd->struct_size < sizeof(SplatNvCommand)) {
    return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "Invalid SplatNvCommand struct");
  }
  switch (cmd->type) {
    case SPLAT_NV_CMD_SET_DISPLAY_MODE:
      handle->displayMode = cmd->payload.display_mode;
      return handle->setErr(SPLAT_NV_OK, "");
    case SPLAT_NV_CMD_SET_SH_DEGREE:
      handle->activeShDegree = std::min<uint32_t>(3u, cmd->payload.sh_degree);
      return handle->setErr(SPLAT_NV_OK, "");
    case SPLAT_NV_CMD_SET_BOUNDING_SPHERE:
      handle->sphere = cmd->payload.bounding_sphere;
      return handle->setErr(SPLAT_NV_OK, "");
    case SPLAT_NV_CMD_SIMULATE_DEVICE_LOST:
      handle->deviceLost = true;
      return handle->setErr(SPLAT_NV_ERR_DEVICE_LOST, "Simulated Vulkan VK_ERROR_DEVICE_LOST");
    case SPLAT_NV_CMD_REQUEST_SORT:
      return handle->setErr(SPLAT_NV_OK, "");
    case SPLAT_NV_CMD_SET_OBJECT_MATRIX: {
      const auto& om = cmd->payload.object_matrix;
      auto it = handle->assets.find(om.asset_id);
      if (it == handle->assets.end()) {
        return handle->setErr(SPLAT_NV_ERR_ASSET_NOT_FOUND, "Asset not found for set_object_matrix");
      }
      std::memcpy(it->second.objectMatrix.m, om.matrix16, sizeof(float) * 16);
      return handle->setErr(SPLAT_NV_OK, "");
    }
    case SPLAT_NV_CMD_APPLY_SPARSE_FLAGS: {
      const auto& d = cmd->payload.sparse_flags;
      auto it = handle->assets.find(d.asset_id);
      if (it == handle->assets.end()) {
        return handle->setErr(SPLAT_NV_ERR_ASSET_NOT_FOUND, "Asset not found for sparse flag delta");
      }
      if (d.count > 0 && (!d.source_indices || !d.flags)) {
        return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "Null pointer in sparse flag delta");
      }
      GpuAsset& ga = it->second;
      if (d.count == 0) return handle->setErr(SPLAT_NV_OK, "");

      // Update host flags and collect touched 4-splat uint32 words (O(changed)!)
      std::vector<uint32_t> touchedWords;
      touchedWords.reserve(d.count);
      for (uint32_t i = 0; i < d.count; ++i) {
        const uint32_t si = d.source_indices[i];
        if (si < ga.count) {
          ga.cpuFlags[si] = d.flags[i];
          touchedWords.push_back(si >> 2u);
        }
      }
      if (touchedWords.empty()) return handle->setErr(SPLAT_NV_OK, "");
      std::sort(touchedWords.begin(), touchedWords.end());
      touchedWords.erase(std::unique(touchedWords.begin(), touchedWords.end()), touchedWords.end());

      // Coalesce contiguous uint32 word spans for minimal copy regions
      struct WordSpan { uint32_t startWord; uint32_t wordCount; };
      std::vector<WordSpan> spans;
      uint32_t runStart = touchedWords[0], runPrev = runStart;
      for (size_t i = 1; i < touchedWords.size(); ++i) {
        if (touchedWords[i] <= runPrev + 4u) {
          runPrev = touchedWords[i];
        } else {
          spans.push_back({runStart, runPrev - runStart + 1u});
          runStart = runPrev = touchedWords[i];
        }
      }
      spans.push_back({runStart, runPrev - runStart + 1u});

      uint32_t totalWords = 0;
      for (const auto& sp : spans) totalWords += sp.wordCount;
      std::vector<uint32_t> packed(totalWords);
      std::vector<VkBufferCopy> copies(spans.size());
      uint32_t cursor = 0;
      for (size_t s = 0; s < spans.size(); ++s) {
        copies[s].srcOffset = static_cast<VkDeviceSize>(cursor) * 4ULL;
        copies[s].dstOffset = static_cast<VkDeviceSize>(spans[s].startWord) * 4ULL;
        copies[s].size = static_cast<VkDeviceSize>(spans[s].wordCount) * 4ULL;
        for (uint32_t w = 0; w < spans[s].wordCount; ++w) {
          const uint32_t baseIdx = (spans[s].startWord + w) * 4u;
          uint32_t wordVal = 0;
          for (uint32_t k = 0; k < 4u && (baseIdx + k) < ga.count; ++k) {
            wordVal |= static_cast<uint32_t>(ga.cpuFlags[baseIdx + k]) << (k * 8u);
          }
          packed[cursor++] = wordVal;
        }
      }

      GpuBuffer stg;
      const VkDeviceSize stgBytes = static_cast<VkDeviceSize>(packed.size()) * 4ULL;
      if (!handle->createBuffer(stgBytes, VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                                VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                                stg, true)) {
        return handle->setErr(SPLAT_NV_ERR_OUT_OF_MEMORY, "Failed staging buffer for sparse flags");
      }
      std::memcpy(stg.mapped, packed.data(), static_cast<size_t>(stgBytes));
      handle->submitOneShot([&](VkCommandBuffer cb) {
        vkCmdCopyBuffer(cb, stg.buf, ga.bufFlags.buf, static_cast<uint32_t>(copies.size()), copies.data());
      });
      handle->destroyBuffer(stg);
      return handle->setErr(SPLAT_NV_OK, "");
    }
    default:
      return handle->setErr(SPLAT_NV_ERR_UNSUPPORTED, "Unknown command type");
  }
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_pick_rect(SplatNvHandle handle, const SplatNvPickRectDesc* desc, SplatNvPickResult* out_result) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!desc || !out_result || desc->struct_size < sizeof(SplatNvPickRectDesc) || out_result->struct_size < sizeof(SplatNvPickResult)) {
    return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "Invalid pick_rect arguments");
  }
  const SplatNvAssetId targetId = desc->asset_id ? desc->asset_id : handle->activeAssetId;
  auto it = handle->assets.find(targetId);
  if (it == handle->assets.end()) {
    return handle->setErr(SPLAT_NV_ERR_ASSET_NOT_FOUND, "Asset not found for pick_rect");
  }
  const GpuAsset& ga = it->second;
  const float aspect = static_cast<float>(handle->width) / static_cast<float>(std::max<uint32_t>(1u, handle->height));
  const Mat4 view = mat4_look_at(
      {handle->camera.position[0], handle->camera.position[1], handle->camera.position[2]},
      {handle->camera.target[0], handle->camera.target[1], handle->camera.target[2]},
      {handle->camera.up[0], handle->camera.up[1], handle->camera.up[2]});
  const Mat4 projVk = mat4_perspective_vk(handle->camera.fov_y_deg, aspect, handle->camera.near_plane, handle->camera.far_plane);
  const Mat4 mvp = mat4_mul(projVk, mat4_mul(view, ga.objectMatrix));
  const float* M = mvp.m;

  const float x0 = std::min(desc->min_ndc_x, desc->max_ndc_x);
  const float x1 = std::max(desc->min_ndc_x, desc->max_ndc_x);
  const float y0 = std::min(desc->min_ndc_y, desc->max_ndc_y);
  const float y1 = std::max(desc->min_ndc_y, desc->max_ndc_y);

  const uint32_t n = ga.count;
  const unsigned numThreads = (n > 200000u) ? std::max(1u, std::min(8u, std::thread::hardware_concurrency())) : 1u;
  std::vector<std::vector<uint32_t>> threadHits(numThreads);
  std::vector<std::thread> workers;

  auto scanSlice = [&](unsigned tid, uint32_t a, uint32_t b) {
    auto& local = threadHits[tid];
    const float* pos = ga.cpuPos.data();
    const uint8_t* flg = ga.cpuFlags.data();
    for (uint32_t i = a; i < b; ++i) {
      if ((flg[i] & 0x06u) != 0u) continue; // skip deleted/hidden
      const float px = pos[static_cast<size_t>(i) * 3u + 0];
      const float py = pos[static_cast<size_t>(i) * 3u + 1];
      const float pz = pos[static_cast<size_t>(i) * 3u + 2];
      const float cw = M[3] * px + M[7] * py + M[11] * pz + M[15];
      if (cw <= 1e-5f) continue;
      const float invW = 1.0f / cw;
      const float cz = (M[2] * px + M[6] * py + M[10] * pz + M[14]) * invW;
      if (cz < 0.0f || cz > 1.0f) continue;
      const float nx = (M[0] * px + M[4] * py + M[8] * pz + M[12]) * invW;
      // Flip Vulkan clip Y back to standard +Y-up NDC [-1, 1] matching C-ABI contract
      const float ny = -(M[1] * px + M[5] * py + M[9] * pz + M[13]) * invW;
      if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) {
        const uint32_t srcIdx = ga.hasNonSeqSrcIdx ? ga.srcIndices[i] : i;
        local.push_back(srcIdx);
      }
    }
  };

  if (numThreads == 1u) {
    scanSlice(0, 0, n);
  } else {
    const uint32_t chunk = (n + numThreads - 1u) / numThreads;
    for (unsigned t = 0; t < numThreads; ++t) {
      const uint32_t a = t * chunk;
      const uint32_t b = std::min(n, a + chunk);
      if (a < b) workers.emplace_back(scanSlice, t, a, b);
    }
    for (auto& w : workers) w.join();
  }

  size_t totalHits = 0;
  for (const auto& v : threadHits) totalHits += v.size();
  uint32_t* outBuf = nullptr;
  if (totalHits > 0) {
    outBuf = static_cast<uint32_t*>(std::malloc(totalHits * sizeof(uint32_t)));
    if (!outBuf) return handle->setErr(SPLAT_NV_ERR_OUT_OF_MEMORY, "Failed to allocate pick result buffer");
    size_t off = 0;
    for (const auto& v : threadHits) {
      if (!v.empty()) {
        std::memcpy(outBuf + off, v.data(), v.size() * sizeof(uint32_t));
        off += v.size();
      }
    }
    handle->ownedBuffers.insert(outBuf);
  }

  out_result->asset_id = targetId;
  out_result->hit_count = static_cast<uint32_t>(totalHits);
  out_result->source_indices = outBuf;
  return handle->setErr(SPLAT_NV_OK, "");
}

SPLAT_NV_API void SPLAT_NV_CALL splat_nv_free_buffer(SplatNvHandle handle, void* ptr) {
  if (!handle || !ptr) return;
  auto it = handle->ownedBuffers.find(ptr);
  if (it != handle->ownedBuffers.end()) {
    handle->ownedBuffers.erase(it);
    std::free(ptr);
  }
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_render_frame(SplatNvHandle handle, SplatNvFrameStats* out_stats) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (handle->deviceLost) {
    return handle->setErr(SPLAT_NV_ERR_DEVICE_LOST, "Vulkan device is in lost state");
  }

  const auto tFrame0 = std::chrono::steady_clock::now();
  GpuAsset* asset = nullptr;
  if (handle->activeAssetId != 0) {
    auto it = handle->assets.find(handle->activeAssetId);
    if (it != handle->assets.end()) asset = &it->second;
  }
  if (handle->descriptorsDirty) {
    handle->updateDescriptorsForAsset(asset);
  }

  // Acquire swapchain image if HWND swapchain active
  double presentWaitMs = 0.0;
  uint32_t swapImgIdx = 0;
  bool useSwapchain = (handle->swapchain != VK_NULL_HANDLE && !handle->swapImages.empty());
  if (useSwapchain) {
    const auto tAcq0 = std::chrono::steady_clock::now();
    VkResult acq = vkAcquireNextImageKHR(handle->device, handle->swapchain, UINT64_MAX, handle->semImageAvail, VK_NULL_HANDLE, &swapImgIdx);
    presentWaitMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tAcq0).count();
    if (acq == VK_ERROR_OUT_OF_DATE_KHR) {
      handle->createSwapchainForSurface(handle->width, handle->height);
      useSwapchain = (handle->swapchain != VK_NULL_HANDLE && !handle->swapImages.empty());
      if (useSwapchain) {
        const auto tAcq1 = std::chrono::steady_clock::now();
        acq = vkAcquireNextImageKHR(handle->device, handle->swapchain, UINT64_MAX, handle->semImageAvail, VK_NULL_HANDLE, &swapImgIdx);
        presentWaitMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tAcq1).count();
      }
    }
    if (acq == VK_ERROR_DEVICE_LOST) {
      handle->deviceLost = true;
      return handle->setErr(SPLAT_NV_ERR_DEVICE_LOST, "VK_ERROR_DEVICE_LOST on vkAcquireNextImageKHR");
    }
    if (acq != VK_SUCCESS && acq != VK_SUBOPTIMAL_KHR) {
      useSwapchain = false;
    }
  }

  // Build camera & UBO
  const float aspect = static_cast<float>(handle->width) / static_cast<float>(std::max<uint32_t>(1u, handle->height));
  const Mat4 view = mat4_look_at(
      {handle->camera.position[0], handle->camera.position[1], handle->camera.position[2]},
      {handle->camera.target[0], handle->camera.target[1], handle->camera.target[2]},
      {handle->camera.up[0], handle->camera.up[1], handle->camera.up[2]});
  const Mat4 proj = mat4_perspective_vk(handle->camera.fov_y_deg, aspect, handle->camera.near_plane, handle->camera.far_plane);
  const Mat4 objM = asset ? asset->objectMatrix : mat4_identity();
  const uint32_t totalSplats = asset ? asset->count : 0u;
  const uint32_t assetSh = asset ? asset->shDegree : 0u;
  const uint32_t effectiveSh = std::min(handle->activeShDegree, assetSh);
  const bool runRadixSort = (totalSplats > 0u) && (handle->displayMode != SPLAT_NV_DISPLAY_CENTERS);

  FrameUboData ubo = {};
  ubo.viewMat = view;
  ubo.projMat = proj;
  ubo.objMat = objM;
  ubo.camPos[0] = handle->camera.position[0];
  ubo.camPos[1] = handle->camera.position[1];
  ubo.camPos[2] = handle->camera.position[2];
  ubo.camPos[3] = handle->camera.fov_y_deg * DEG2RAD;
  ubo.viewport[0] = static_cast<float>(handle->width);
  ubo.viewport[1] = static_cast<float>(handle->height);
  ubo.viewport[2] = (totalSplats > 15000000u) ? 96.0f : 260.0f;
  ubo.viewport[3] = handle->camera.is_ortho ? 1.0f : 0.0f;
  ubo.sphereParams[0] = handle->sphere.center[0];
  ubo.sphereParams[1] = handle->sphere.center[1];
  ubo.sphereParams[2] = handle->sphere.center[2];
  ubo.sphereParams[3] = std::max(0.01f, handle->sphere.radius);
  ubo.flagsMeta[0] = handle->displayMode;
  ubo.flagsMeta[1] = handle->activeShDegree;
  ubo.flagsMeta[2] = assetSh;
  ubo.flagsMeta[3] = (handle->sphere.enabled ? 1u : 0u) | (handle->sphere.invert ? 2u : 0u);
  std::memcpy(handle->bufFrameUbo.mapped, &ubo, sizeof(ubo));

  vkResetFences(handle->device, 1, &handle->frameFence);
  vkResetCommandBuffer(handle->cmdBuf, 0);
  VkCommandBuffer cb = handle->cmdBuf;
  VkCommandBufferBeginInfo cbbi = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
  cbbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
  vkBeginCommandBuffer(cb, &cbbi);

  vkCmdResetQueryPool(cb, handle->queryPool, 0, 4);

  auto computeBarrier = [&]() {
    VkMemoryBarrier mb = {VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    mb.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT;
    mb.dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_INDIRECT_COMMAND_READ_BIT;
    vkCmdPipelineBarrier(cb,
                         VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_DRAW_INDIRECT_BIT | VK_PIPELINE_STAGE_VERTEX_SHADER_BIT,
                         0, 1, &mb, 0, nullptr, 0, nullptr);
  };

  // --- Timestamp 0: Start GPU Keygen + Radix Sort ---
  vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, handle->queryPool, 0);

  // Initialize indirect draw command: { vertexCount = 6, instanceCount = 0, firstVertex = 0, firstInstance = 0 }
  uint32_t initInd[4] = {6u, 0u, 0u, 0u};
  vkCmdUpdateBuffer(cb, handle->bufIndirect.buf, 0, sizeof(initInd), initInd);
  computeBarrier();

  if (totalSplats > 0u) {
    // 1. Keygen + frustum/flag cull
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, handle->pipeKeygen);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, handle->plKeygen, 0, 1, &handle->dsKeygen, 0, nullptr);
    KeygenPushConst kpc = {};
    kpc.modelView = mat4_mul(view, objM);
    kpc.proj = proj;
    kpc.totalCount = totalSplats;
    kpc.nearPlane = handle->camera.near_plane;
    kpc.farPlane = handle->camera.far_plane;
    vkCmdPushConstants(cb, handle->plKeygen, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(kpc), &kpc);
    vkCmdDispatch(cb, (totalSplats + 255u) / 256u, 1, 1);
    computeBarrier();

    // 2. 8-pass 4-bit Bitmask-Stable 32-bit GPU Radix Sort (back-to-front)
    if (runRadixSort) {
      for (uint32_t pass = 0; pass < 8u; ++pass) {
        const uint32_t shift = pass * 4u;
        const bool even = (pass & 1u) == 0u;
        VkDescriptorSet dsH = even ? handle->dsHistA : handle->dsHistB;
        VkDescriptorSet dsS = even ? handle->dsScatterA2B : handle->dsScatterB2A;

        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, handle->pipeHist);
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, handle->plHist, 0, 1, &dsH, 0, nullptr);
        vkCmdPushConstants(cb, handle->plHist, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(uint32_t), &shift);
        vkCmdDispatch(cb, NUM_RADIX_BLOCKS, 1, 1);
        computeBarrier();

        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, handle->pipeScan);
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, handle->plScan, 0, 1, &handle->dsScan, 0, nullptr);
        vkCmdDispatch(cb, 16u, 1, 1);
        computeBarrier();

        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, handle->pipeScatter);
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, handle->plScatter, 0, 1, &dsS, 0, nullptr);
        vkCmdPushConstants(cb, handle->plScatter, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(uint32_t), &shift);
        vkCmdDispatch(cb, NUM_RADIX_BLOCKS, 1, 1);
        computeBarrier();
      }
    }
  }

  // Copy visibleCount to host-visible readback buffer (16 bytes)
  VkBufferCopy indCopy = {0, 0, 16};
  vkCmdCopyBuffer(cb, handle->bufIndirect.buf, handle->bufIndirectReadback.buf, 1, &indCopy);

  // --- Timestamp 1: End Sort / Timestamp 2: Start Raster ---
  vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, handle->queryPool, 1);
  vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, handle->queryPool, 2);

  VkClearValue clearCol = {};
  clearCol.color.float32[0] = 0.082f;
  clearCol.color.float32[1] = 0.090f;
  clearCol.color.float32[2] = 0.106f;
  clearCol.color.float32[3] = 1.0f;
  VkRenderPassBeginInfo rpbi = {VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};
  rpbi.renderPass = handle->renderPass;
  rpbi.framebuffer = handle->framebuffer;
  rpbi.renderArea.extent = {handle->width, handle->height};
  rpbi.clearValueCount = 1;
  rpbi.pClearValues = &clearCol;
  vkCmdBeginRenderPass(cb, &rpbi, VK_SUBPASS_CONTENTS_INLINE);

  VkViewport vp = {0.0f, 0.0f, static_cast<float>(handle->width), static_cast<float>(handle->height), 0.0f, 1.0f};
  VkRect2D sc = {{0, 0}, {handle->width, handle->height}};
  vkCmdSetViewport(cb, 0, 1, &vp);
  vkCmdSetScissor(cb, 0, 1, &sc);

  if (totalSplats > 0u) {
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, handle->pipeSplat);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, handle->plRender, 0, 1, &handle->dsRender, 0, nullptr);
    vkCmdDrawIndirect(cb, handle->bufIndirect.buf, 0, 1, 16);
  }
  if (handle->sphere.enabled != 0u && handle->sphere.radius > 1e-4f) {
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, handle->pipeSphere);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, handle->plRender, 0, 1, &handle->dsRender, 0, nullptr);
    vkCmdDraw(cb, 7u * 64u * 2u, 1, 0, 0);
  }

  vkCmdEndRenderPass(cb);

  // --- Timestamp 3: End Raster ---
  vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, handle->queryPool, 3);

  // Blit offscreen RGBA8 colorImage -> Win32 HWND swapchain image if presenting
  if (useSwapchain) {
    VkImage swImg = handle->swapImages[swapImgIdx];
    VkImageMemoryBarrier toDst = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
    toDst.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    toDst.newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
    toDst.srcAccessMask = 0;
    toDst.dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    toDst.image = swImg;
    toDst.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, nullptr, 0, nullptr, 1, &toDst);

    VkImageBlit blit = {};
    blit.srcSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    blit.srcOffsets[1] = {static_cast<int32_t>(handle->width), static_cast<int32_t>(handle->height), 1};
    blit.dstSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    blit.dstOffsets[1] = {static_cast<int32_t>(handle->swapExtent.width), static_cast<int32_t>(handle->swapExtent.height), 1};
    vkCmdBlitImage(cb, handle->colorImage, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, swImg, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &blit, VK_FILTER_LINEAR);

    VkImageMemoryBarrier toPres = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
    toPres.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
    toPres.newLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
    toPres.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    toPres.dstAccessMask = 0;
    toPres.image = swImg;
    toPres.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, 0, 0, nullptr, 0, nullptr, 1, &toPres);
  }

  vkEndCommandBuffer(cb);

  VkSubmitInfo si = {VK_STRUCTURE_TYPE_SUBMIT_INFO};
  si.commandBufferCount = 1;
  si.pCommandBuffers = &cb;
  VkPipelineStageFlags waitStage = VK_PIPELINE_STAGE_TRANSFER_BIT;
  if (useSwapchain) {
    si.waitSemaphoreCount = 1;
    si.pWaitSemaphores = &handle->semImageAvail;
    si.pWaitDstStageMask = &waitStage;
    si.signalSemaphoreCount = 1;
    si.pSignalSemaphores = &handle->semRenderDone;
  }

  VkResult subR = vkQueueSubmit(handle->queue, 1, &si, handle->frameFence);
  if (subR == VK_ERROR_DEVICE_LOST) {
    handle->deviceLost = true;
    return handle->setErr(SPLAT_NV_ERR_DEVICE_LOST, "VK_ERROR_DEVICE_LOST on vkQueueSubmit");
  }
  if (subR != VK_SUCCESS) {
    return handle->setErr(SPLAT_NV_ERR_GPU_DEVICE, "vkQueueSubmit failed");
  }

  if (useSwapchain) {
    const auto tPres0 = std::chrono::steady_clock::now();
    VkPresentInfoKHR pi = {VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};
    pi.waitSemaphoreCount = 1;
    pi.pWaitSemaphores = &handle->semRenderDone;
    pi.swapchainCount = 1;
    pi.pSwapchains = &handle->swapchain;
    pi.pImageIndices = &swapImgIdx;
    VkResult pr = vkQueuePresentKHR(handle->queue, &pi);
    presentWaitMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tPres0).count();
    if (pr == VK_ERROR_DEVICE_LOST) {
      handle->deviceLost = true;
      return handle->setErr(SPLAT_NV_ERR_DEVICE_LOST, "VK_ERROR_DEVICE_LOST on vkQueuePresentKHR");
    }
    if (pr == VK_ERROR_OUT_OF_DATE_KHR || pr == VK_SUBOPTIMAL_KHR) {
      handle->createSwapchainForSurface(handle->width, handle->height);
    }
  }

  // Wait for GPU completion so hardware timestamps & wall frame time are 100% honest
  const auto tWait0 = std::chrono::steady_clock::now();
  VkResult wr = vkWaitForFences(handle->device, 1, &handle->frameFence, VK_TRUE, UINT64_MAX);
  const double gpuFenceWaitMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tWait0).count();
  if (wr == VK_ERROR_DEVICE_LOST) {
    handle->deviceLost = true;
    return handle->setErr(SPLAT_NV_ERR_DEVICE_LOST, "VK_ERROR_DEVICE_LOST on vkWaitForFences");
  }

  uint64_t ts[4] = {};
  double sortMs = 0.0, rasterMs = 0.0;
  if (vkGetQueryPoolResults(handle->device, handle->queryPool, 0, 4, sizeof(ts), ts, sizeof(uint64_t), VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT) == VK_SUCCESS) {
    if (ts[1] >= ts[0]) sortMs = static_cast<double>(ts[1] - ts[0]) * static_cast<double>(handle->timestampPeriodNs) * 1e-6;
    if (ts[3] >= ts[2]) rasterMs = static_cast<double>(ts[3] - ts[2]) * static_cast<double>(handle->timestampPeriodNs) * 1e-6;
  }

  uint32_t readInd[4] = {};
  std::memcpy(readInd, handle->bufIndirectReadback.mapped, sizeof(readInd));
  const uint64_t visSplats = readInd[1];
  const double frameTotalMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tFrame0).count();
  const double purePresentWaitMs = std::max(0.0, frameTotalMs - sortMs - rasterMs);
  (void)gpuFenceWaitMs;
  (void)presentWaitMs;

  uint64_t vramUsed = handle->dynamicVramBytes;
  for (const auto& kv : handle->assets) vramUsed += kv.second.vramBytes;

  if (out_stats && out_stats->struct_size >= offsetof(SplatNvFrameStats, present_wait_ms)) {
    out_stats->frame_time_ms = frameTotalMs;
    out_stats->sort_time_ms = sortMs;
    out_stats->raster_time_ms = rasterMs;
    out_stats->total_splats = totalSplats;
    out_stats->visible_splats = visSplats;
    out_stats->vram_used_bytes = vramUsed;
    if (out_stats->struct_size >= sizeof(SplatNvFrameStats)) {
      out_stats->present_wait_ms = purePresentWaitMs;
      out_stats->active_sh_degree = effectiveSh;
      out_stats->gpu_sort_active = runRadixSort ? 1u : 0u;
    }
  }
  return handle->setErr(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_readback_rgba(SplatNvHandle handle, uint32_t* out_width, uint32_t* out_height, uint8_t** out_rgba_pixels) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!out_width || !out_height || !out_rgba_pixels) {
    return handle->setErr(SPLAT_NV_ERR_INVALID_ARG, "Null out parameter in readback_rgba");
  }
  const uint32_t w = handle->width;
  const uint32_t h = handle->height;
  const VkDeviceSize byteLen = static_cast<VkDeviceSize>(w) * static_cast<VkDeviceSize>(h) * 4ULL;

  GpuBuffer stg;
  if (!handle->createBuffer(byteLen, VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                            stg, true)) {
    return handle->setErr(SPLAT_NV_ERR_OUT_OF_MEMORY, "Failed readback staging allocation");
  }
  bool ok = handle->submitOneShot([&](VkCommandBuffer cb) {
    VkBufferImageCopy reg = {};
    reg.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    reg.imageExtent = {w, h, 1};
    vkCmdCopyImageToBuffer(cb, handle->colorImage, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, stg.buf, 1, &reg);
  });
  if (!ok) {
    handle->destroyBuffer(stg);
    return handle->setErr(SPLAT_NV_ERR_GPU_DEVICE, "vkCmdCopyImageToBuffer failed");
  }

  auto* outBuf = static_cast<uint8_t*>(std::malloc(static_cast<size_t>(byteLen)));
  if (!outBuf) {
    handle->destroyBuffer(stg);
    return handle->setErr(SPLAT_NV_ERR_OUT_OF_MEMORY, "Failed host allocation for RGBA readback");
  }
  std::memcpy(outBuf, stg.mapped, static_cast<size_t>(byteLen));
  handle->destroyBuffer(stg);
  handle->ownedBuffers.insert(outBuf);

  *out_width = w;
  *out_height = h;
  *out_rgba_pixels = outBuf;
  return handle->setErr(SPLAT_NV_OK, "");
}

SPLAT_NV_API SplatNvStatus SPLAT_NV_CALL splat_nv_get_last_error(SplatNvHandle handle, SplatNvErrorInfo* out_error) {
  if (!handle) return SPLAT_NV_ERR_INVALID_HANDLE;
  if (!out_error || out_error->struct_size < sizeof(SplatNvErrorInfo)) return SPLAT_NV_ERR_INVALID_ARG;
  out_error->status_code = handle->lastErrorCode;
  std::snprintf(out_error->message, sizeof(out_error->message), "%s", handle->lastErrorMsg.c_str());
  return SPLAT_NV_OK;
}

} // extern "C"
