cmake_minimum_required(VERSION 3.20)
project(splat_native_viewport LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Use static MSVC runtime (/MT) so splat_native_viewport.dll has ZERO external VCRUNTIME dependency!
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
  add_compile_options(/O2 /W3 /EHsc /utf-8)
  add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX)
endif()

add_library(splat_nv_abi_headers INTERFACE)
target_include_directories(splat_nv_abi_headers INTERFACE "${CMAKE_CURRENT_SOURCE_DIR}/include")

# 1) Pure C-ABI mock DLL + smoke executable (zero Vulkan dependency)
add_library(splat_native_viewport_mock SHARED
  examples/abi_mock_impl.cpp
)
target_compile_definitions(splat_native_viewport_mock PRIVATE SPLAT_NV_BUILD_DLL)
target_link_libraries(splat_native_viewport_mock PRIVATE splat_nv_abi_headers)

add_executable(splat_nv_abi_smoke
  examples/abi_mock_impl.cpp
  examples/abi_smoke.cpp
)
target_link_libraries(splat_nv_abi_smoke PRIVATE splat_nv_abi_headers)

# 2) Real Vulkan 1.3 Native Bypass Viewport DLL (002-B)
find_package(Vulkan QUIET)
if(Vulkan_FOUND AND DEFINED SPLAT_NV_GEN_DIR)
  add_library(splat_native_viewport SHARED
    src/asset_loader.cpp
    src/vulkan_viewport.cpp
  )
  target_compile_definitions(splat_native_viewport PRIVATE SPLAT_NV_BUILD_DLL)
  target_include_directories(splat_native_viewport PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${SPLAT_NV_GEN_DIR}"
  )
  target_link_libraries(splat_native_viewport PRIVATE splat_nv_abi_headers Vulkan::Vulkan)

  add_executable(splat_nv_vulkan_smoke
    examples/vulkan_unit_smoke.cpp
  )
  target_compile_definitions(splat_nv_vulkan_smoke PRIVATE SPLAT_NV_USE_DLL)
  target_link_libraries(splat_nv_vulkan_smoke PRIVATE splat_nv_abi_headers splat_native_viewport)
endif()
