# Splat Convert Desktop — 原生 Vulkan 1.3 旁路视口构建说明（002-B）

本文档记录在 Windows x64 环境下可复现构建 `splat_native_viewport.dll`（C-ABI v1.1 + Vulkan 1.3 GPU 排序/SH0–3 高斯光栅化/可调包裹球）的完整环境与命令。

## 1. 本机实测验证环境

| 组件 | 版本 / 型号 | 路径 / 备注 |
|---|---|---|
| 操作系统 | Windows 11 x64 | Command shell: PowerShell / cmd |
| 独立显卡 | NVIDIA GeForce RTX 4080 Laptop GPU | 12,282 MiB VRAM（12 GiB），VBIOS `95.04.1f.00.14` |
| NVIDIA 驱动 | `595.97` | 支持 Vulkan Instance `1.4.363` / `VK_KHR_win32_surface` |
| LunarG Vulkan SDK | `1.4.363.0` (`KhronosGroup.VulkanSDK`) | `C:\VulkanSDK\1.4.363.0`（环境变量 `VULKAN_SDK`） |
| 着色器编译器 | `glslc.exe` (`shaderc v2026.4` / `glslang 11.1.0`) | `%VULKAN_SDK%\Bin\glslc.exe` |
| C/C++ 编译器 | MSVC `19.52.37029` (x64) | Visual Studio 18 Community (`vcvars64.bat`) |
| 构建工具 | `CMake 4.3.3` + `Ninja 1.13.2` | 静态链接 MSVC 运行时 `/MT`，无额外 VC Redist 依赖 |
| 宿主编译器 | `.NET Framework 4.x csc.exe` (x64) | `windows\Build.ps1`，零 `/unsafe` |

## 2. 安装前置依赖

1. 安装 **Visual Studio Build Tools / Community**（勾选「使用 C++ 的桌面开发」与 Windows SDK）。
2. 安装 **LunarG Vulkan SDK**（`1.4.363.0` 或兼容 `1.3+` 版本）：
   ```powershell
   winget install --id KhronosGroup.VulkanSDK -e --silent --accept-package-agreements --accept-source-agreements
   ```
   安装完成后验证：
   ```powershell
   $env:VULKAN_SDK = [Environment]::GetEnvironmentVariable('VULKAN_SDK', 'Machine')
   & "$env:VULKAN_SDK\Bin\glslc.exe" --version
   & "$env:VULKAN_SDK\Bin\vulkaninfoSDK.exe" --summary
   ```

## 3. 编译原生 Vulkan 视口动态库（`splat_native_viewport.dll`）

从仓库根目录 `01_当前开发工程\splat-convert-desktop` 执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File windows\native-viewport\build-vulkan.ps1
```

该脚本自动完成以下步骤（全部在纯 ASCII 路径 `.cache\native-vulkan-build` 中构建，避开中文路径链接问题）：
1. 调用 `%VULKAN_SDK%\Bin\glslc.exe --target-env=vulkan1.3 -O` 将 `windows\native-viewport\shaders\*.{comp,vert,frag}` 编译为 SPIR-V，并生成嵌入式 C++ 字节数组头 `generated_shaders.h`（免除运行期散落 `.spv` 文件依赖）。
2. 加载 MSVC x64 `vcvars64.bat`，通过 `CMake + Ninja` 编译：
   - `splat_native_viewport.dll`（真实 Vulkan 1.3 旁路渲染器，导出全部 16 个 C-ABI v1.1 符号，静态链接 `/MT`，仅依赖系统 `vulkan-1.dll` / `kernel32.dll`）
   - `splat_native_viewport_mock.dll`（纯 ABI 契约验证 mock 动态库）
   - `splat_nv_abi_smoke.exe`（C++ 侧 ABI 契约自检）
   - `splat_nv_vulkan_smoke.exe`（C++ 侧 Vulkan 1.3 SH0–3 / GPU Radix Sort / 拾取 / 5 次开闭显存回收自检）
3. 输出路径：`.cache\native-vulkan-build\splat_native_viewport.dll`（支持 `-CopyTo <dir>` 参数复制到发布目录与便携 EXE 同目录）。

## 4. 构建桌面单文件宿主并运行端到端验证

```powershell
# 1) 构建单文件便携 EXE（默认视口保持 100% WebView2，原生 Vulkan 为显式旁路入口）
powershell -NoProfile -ExecutionPolicy Bypass -File windows\Build.ps1 -Output dist\Splat-Convert-Desktop-3.2.3-rc14-win-x64.exe

# 2) 将原生 Vulkan DLL 置于 EXE 同目录
Copy-Item .cache\native-vulkan-build\splat_native_viewport.dll dist\splat_native_viewport.dll -Force

# 3) C# 宿主 <-> 原生 C-ABI v1.1 跨语言端到端验证（11 结构体尺寸、调用约定、拾取、读回、跨边界释放）
.\dist\Splat-Convert-Desktop-3.2.3-rc14-win-x64.exe --native-abi-test .cache\abi-test-out

# 4) 原生旁路视口完整验收（SH0-3 方向色响应、GPU 排序遮挡、WinForms HWND、包裹球、保存重开导出、设备丢失回退、5 次开闭显存）
.\dist\Splat-Convert-Desktop-3.2.3-rc14-win-x64.exe --native-viewport-smoke ..\..\06_测试素材\scene-demo-24k.ply .cache\native-smoke-out

# 5) 同宿主真实桌面交替基准（WebView2 vs Vulkan 旁路，120 帧轨迹，冷/热分离）
.\dist\Splat-Convert-Desktop-3.2.3-rc14-win-x64.exe --desktop-bench ..\..\06_测试素材\真实场景\展览馆-converted.sog .cache\bench-hall.json 120 3 both
```

## 5. 依赖与许可证边界

- 原生视口 C++ / GLSL 着色器为本项目原创实现（遵循仓库 MIT 许可证），仅静态/动态调用标准 Khronos Vulkan 1.3 C 头文件与系统 `vulkan-1.dll`（Apache-2.0）。
- 严格不引入 GPL/LGPL 代码（不复制任何 `LichtFeld-Studio` 源码），亦不引入重型第三方引擎运行时。
