# Splat Convert Desktop

**高斯泼溅（3D Gaussian Splatting）本地全流程化桌面工具**——集大文件格式转换压缩、自有 `+Y` 朝上 3D 高斯编辑器、64 MiB 有界多核无损烘焙与离线 AI 分割补洞于一体。免安装严格便携，所有素材与模型全程本地处理，不上传云端。

> **创作者归属保证**：你用本软件编辑、压缩或封装导出的任何 `.ply` / `.sog` / `.exe` / `.apk` 成品，其版权与商业分发权 **100% 归你所有**，本软件不主张任何权利，无需开源你的业务资产。

当前 Windows 里程碑版本：**`v3.2.3-rc14`**（内置引擎 `@playcanvas/splat-transform` **3.12.0**，内置离线 `SAM 2.1 Hiera Tiny` 语义模型，7 语种 **1,797 Key** 完整覆盖）。

---

## 核心特性（v3.2.3）

### 1. 严格便携的现代桌面转换工作台
- **零外部残留便携架构**：所有配置、缓存、日志、语言扩展与解耦引擎均落在程序同级 `data/` 目录，不写注册表或 `AppData`。
- **丰富格式支持**：
  - 输入：`.ply`（含压缩 PLY）、`.sog`（v2/v3）、`.spz`（v3/v4）、`.ksplat`、`.splat`、`.glb`、`.lcc`、`.lcc2`；
  - 输出：`.sog`、标准 `.ply`、`.compressed.ply`、`.spz`、`.csv`、`.html` 单页查看器、`.voxel.zip` 体素碰撞包。
- **实用生产增强**：4 档校准预设（快速转换 / 极致瘦身 / 网页均衡 / 高质归档）、自适应重要性抽稀、目标体积硬上限、批量独立转换与历史任务断点续传队列、文件元数据体检（SOG 分层占比与格式兼容矩阵）、国内多镜像一键引擎热更新与回滚、0.5 秒高频硬件监控与悬停双色历史曲线。

### 2. 全自主 `+Y` 朝上 3D 高斯编辑器（非破坏性管线）
- **统一右手 `+Y` 朝上坐标系**：无限 `Y=0` XZ 地面网格（64 位射线多尺度 LOD 防噪点）、永远横平竖直的 World AABB 八角边角框、透明悬浮 3D 坐标导航球、轨道/漫游双摄像机（带自适应速度滑条与五次缓动飞镜）、全局数值框横拖调参 & 滑块点值直输。
- **完备选区与 AI 工具**：
  - 6 大基础选择（浏览 / 框选 / 套索 / 椭圆 / 多边形 / 360px 实体圆圈画笔），常态「替换」+ `Ctrl` 临时加选 / `Alt` 临时减选，支持「仅选可见点（32-bit GPU ID 拾取）」与「整个高斯点」模式；
  - 5 大筛选工具（吸管 / 透明度 / 尺寸 / **全内置离线 `SAM 2.1 Hiera Tiny` `Shift+左键` 框选 2D/3D 语义分割** / 悬浮点选择）；
  - **智能平面补洞**：支持 **`L0 纯色`**（封装可复用 360° 色相环 + 吸管 + 最近颜色）、**`L1 极速几何`**、**`L2 LaMa ONNX`** 智能纹理反投影修复；
  - **3DGS 智能测量**：全局非破坏性比例尺校准（`Shift+T`）+ 智能测量笔（`T`，支持直线/折线/2.5D 面积/堆体体积积分、一键智能贴边、4 种 GPU 堆体透视/热力/网格视图与多结果钉住）。
- **GPU 光线投射 CSG 组合包裹体**：支持盒/球/圆柱递归嵌套分组与 `相加 / 挖去 / 交叠` 布尔运算、控点遮挡自动减淡、120 FPS 实时 GPU 可选范围柔和青蓝染色。
- **Camera Raw 风格专业调色 & 生产级场景树**：直方图仅采样点云像素（零背景干扰）、8 段 HSL 混色器 + 16³ 3D LUT + 分屏实时对比 + 松手记单步撤销；场景管理器支持原位双击改名、多选合并/打组、`Ctrl+拖` 复制移动与历史操作连续 3 次自动打组折叠。
- **单写者稀疏同步 + 64 MiB 严格有界多线程烘焙**：`ply-parallel.mjs` 实现 0 字节超限的 64 MiB 在途缓冲预算，500k 全 SH3 变换调色烘焙实测 **3.19×–3.59×** 加速且与串行 100% SHA-256 比特一致。
- **实验性原生 Vulkan 1.3 旁路视口（可选预览）**：右键「3D 编辑」或 `Shift+左键` 体验 C++20/Vulkan 1.3 引擎（`splat_native_viewport.dll`），支持 SH0–3 实时渲染、GPU 基数排序、可调包裹球与故障自动回退 WebView2（注：实验原型请勿用于覆盖已有复杂编辑配方的旧工程）。

### 3. 全量国际化（7 语种 1,797 Key）
内置 `zh-CN / en-US / ja-JP / ko-KR / de-DE / fr-FR / es-ES` 完整翻译，主界面一键热切换实时同步 3D 编辑器；社区贡献者可直接将新语言 JSON 放入 `data/locales/` 零编译预览。校验命令：`npm run i18n:check`。

---

## 下一代 V4 重构规划（Godot 4.6 + C++ RenderingDevice）

为进一步突破千万级点云编辑帧率并实现「**3D 展示编排（人物/小鸟骨骼动画、1/3 人称物理漫游、热点切入建筑内部、天空球、9 系数 SH 探针光照反推与重打光）+ 零 SDK 一键封装独立 Windows `.exe` / Android `.apk`**」，后续 V4 将全面升级至 **Godot 4.6 + 同一套 C++ `RenderingDevice` / `CompositorEffect (POST_SKY)`** 统一原生底座。

---

## 本地构建与测试

### 环境要求
- **Windows 10 / 11 x64**，系统内置 .NET Framework 4.8（桌面单文件构建无需安装 Visual Studio）
- **Node.js ≥ 22**（仅开发/测试/校验用，终端用户无需安装）
- *(可选)* 构建实验性原生 Vulkan 旁路 DLL：LunarG Vulkan SDK 1.3+、MSVC x64、CMake、Ninja（详见 [docs/NATIVE_VULKAN_BUILD.md](docs/NATIVE_VULKAN_BUILD.md)）

### 常用命令

```powershell
# 1. 多语言完整性与占位符严格校验（7 语种 1,797 Key）
npm run i18n:check

# 2. 模块边界、历史兼容、稀疏状态、64 MiB 多核烘焙与纯领域契约回归
node tests/module-boundary-check.mjs
node tests/coord-and-cylinder-compat.test.mjs
node tests/sparse-sync-and-state.test.mjs
node tests/parallel-bake-bench.test.mjs
node tests/domain-contract.test.mjs

# 3. 构建 Windows 单文件便携版 EXE
.\windows\Build.ps1 -Output ".\dist\Splat-Convert-Desktop-3.2.3-win-x64.exe"
```

---

## 仓库目录结构

```text
locales/                 7 语种统一 JSON 词典包（zh-CN 为单一事实来源）
windows/                 C# 便携原生桌面壳（App / Controls / Theme / Health / ModelManager / EditorHost）
├── editor/              自有 +Y-up 3D 高斯编辑器（domain / ui / shaders / semantic / smart / measure / ply-parallel）
├── native-viewport/     实验性 C++20 / Vulkan 1.3 原生旁路视口源码与 GLSL 450 着色器
└── icons/               明暗双套桌面图标
app/                     macOS Electron 壳与通用 i18n 加载器
scripts/                 引擎打包校验与 i18n-check.mjs 自动化工具
docs/                    开发者文档（三维编辑模块 / I18N / NATIVE_VULKAN_BUILD / RESOURCES）
tests/                   领域契约、多核烘焙、模块边界、i18n 与端到端回归套件
.github/workflows/       GitHub Actions 自动构建配置
```

---

## 许可证与开源致谢

本项目采用 **[Apache License 2.0](LICENSE)** 开源发布。请同时参阅 **[NOTICE](NOTICE)** 与 **[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)** 查看完整的第三方开源版权与致谢清单。
