# Third-Party Licenses & Open-Source Acknowledgements

本文件汇总 Splat Convert Desktop（**Apache License 2.0**）所集成、捆绑或借鉴架构思想的全部上游开源项目，包含项目名称、原仓库链接、版权声明与对应许可证。完整第三方依赖原始许可全文另见 [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt) 与 [NOTICE](NOTICE)。

> **合规声明**：本项目严格遵守开源许可证边界，**不包含任何 GPL / AGPL 或非商用（CC BY-NC / Inria NC）代码**。所有随软件分发及未来导出的 `.exe` / `.apk` 模板包均保留本声明与 `NOTICE` 文件。

---

## 一、核心依赖与捆绑组件（V1.9 当前版本）

| 项目 | 上游仓库 | 版权声明 | 许可证 | 用途说明 |
| --- | --- | --- | :---: | --- |
| **PlayCanvas Splat Transform** | https://github.com/playcanvas/splat-transform | Copyright (c) 2011-2026 PlayCanvas Ltd. | **MIT** | 高斯泼溅核心编解码、压缩转换与体素生成引擎（v3.12.0） |
| **Three.js** | https://github.com/mrdoob/three.js | Copyright (c) 2010-2026 three.js authors | **MIT** | V1.9 WebGL2 3D 编辑器视口、相机与变换控点基础库 |
| **Meta SAM 2 / SAM 2.1 Tiny ONNX** | https://github.com/facebookresearch/sam2 | Copyright (c) Meta Platforms, Inc. and affiliates | **Apache 2.0** | 本地 2D/3D 语义框选分割模型权重与接口 |
| **ONNX Runtime (Web / C++)** | https://github.com/microsoft/onnxruntime | Copyright (c) Microsoft Corporation | **MIT** | 本地离线 AI 模型推理运行时（WebGPU/WASM / DirectML） |
| **LaMa Inpainting** | https://github.com/advimman/lama | Copyright (c) Samsung AI Center Moscow | **Apache 2.0** | 平面补洞 L2 智能纹理修复模型（可选下载） |
| **Node.js** | https://github.com/nodejs/node | Copyright Node.js contributors | **MIT** | 离线多核烘焙与 `splat-transform` 便携运行环境 |
| **Lucide Icons** | https://github.com/lucide-icons/lucide | Copyright (c) Lucide Contributors | **ISC** | 桌面主界面矢量图标 |
| **yauzl / yazl / plist** | npm ecosystem | Respective authors | **MIT** | 压缩包与元数据读写工具 |

---

## 二、设计借鉴与算法思想致谢

| 项目 | 上游仓库 | 版权声明 | 许可证 | 说明 |
| --- | --- | --- | :---: | --- |
| **PlayCanvas SuperSplat & Engine** | https://github.com/playcanvas/supersplat | Copyright (c) PlayCanvas Ltd. | **MIT** | 3DGS 编辑范式、球谐旋转、量化 SH 与状态零拷贝架构参考 |
| **ReSplat Editor** | https://github.com/Re-qi/ReSplat_Editor | Copyright (c) 2025 Re祁 | **CC BY 4.0** | 环模式、专业调色与选区交互理念参考（V1.9 源码已 100% 自主重写，零包含非商用 NanoGS） |
| **GaussianSplatEditor** | https://github.com/TimChen1383/GaussianSplatEditor | Copyright (c) TimChen1383 | **MIT** | 透明度与尺寸筛选工具设计参考 |
| **Spirula Studio** | https://github.com/harry7557558/spirula-studio | Copyright (c) harry7557558 | **GPL-3.0** | **仅参考交互概念**（六面推拉包裹体控点思路），**零代码复制与衍生** |

---

## 三、V2.0 下一代重构计划引入的兼容组件（MIT / Apache 2.0）

| 项目 | 上游仓库 | 许可证 | 计划用途 |
| --- | --- | :---: | --- |
| **Godot Engine 4.6 & godot-cpp** | https://github.com/godotengine/godot | **MIT** | V2.0 统一原生应用底座、Jolt 物理引擎与 C++ GDExtension 接口 |
| **godot-gaussian-splatting (GDGS)** | https://github.com/ReconWorldLab/godot-gaussian-splatting | **MIT** | `CompositorEffect` 深度遮挡、体素碰撞与近似重打光参考 |
| **pocketsplat** | https://github.com/Artemarius/pocketsplat | **MIT** | Android Adreno/Mali 原生 Vulkan 排序与移动端优化参考 |
| **Niantic SPZ** | https://github.com/nianticlabs/spz | **MIT** | C++ 原生高速 `.spz` 格式读写库 |
| **NVIDIA vk_gaussian_splatting** | https://github.com/nvpro-samples/vk_gaussian_splatting | **Apache 2.0** | 通用 GPU 视锥剔除、流压缩与 Indirect Draw 管线思想参考 |
| **PlayCanvas SuperSplat Viewer** | https://github.com/playcanvas/supersplat-viewer | **MIT** | 标准化 `scene.json` 场景协议与未来静态 HTML 第二出口参考 |
