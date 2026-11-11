# Splat Convert Desktop

大文件本地转换，绕开在线网页的体积与浏览器环境限制；免安装便携，图形界面上手即用。基于 [PlayCanvas Splat Transform](https://github.com/playcanvas/splat-transform) 的非官方 Windows / macOS 转换工具，文件不上传。

项目地址：**https://github.com/a13409512853-maker/splat-convert-desktop**

![Windows 界面](docs/interface-windows.png)

当前 Windows 版本为 **1.2.0**。本轮更新了 macOS 源码，但未重新制作或真机验收苹果 1.2.0 应用。

## 下载与运行

在 [Releases（发行版）](https://github.com/a13409512853-maker/splat-convert-desktop/releases) 下载适合自己电脑的文件。

| 系统 | 文件 | 使用方法 |
| --- | --- | --- |
| Windows 10 / 11，64 位 x64 | `Splat-Convert-Desktop-1.2.0-win-x64.exe` | 双击运行，无需安装 Node.js |
| macOS 13 或更高，Apple 芯片 | `Splat-Convert-Desktop-1.1.0-mac-arm64-adhoc.zip` | 解压后，将 `.app` 拖入“应用程序”并打开 |
| macOS 13 或更高，Intel 芯片 | `Splat-Convert-Desktop-1.1.0-mac-x64-adhoc.zip` | 解压后，将 `.app` 拖入“应用程序”并打开 |

Windows 版使用系统自带的 .NET Framework 4.8。苹果芯片型号可在苹果菜单的“关于本机”中查看：显示 Apple M 系列就用 arm64，显示 Intel 就用 x64。

## 功能

- 七种界面语言：简体中文、英语、日语、韩语、德语、法语、西班牙语。原始引擎日志保留原文。
- 带图标的实时资源角标：CPU、物理内存、GPU、显存。未知指标显示“暂不可用”，不会伪装为 0%。
- 根据本次任务估算与当前资源余量比较，仅在可能不足时预警；用户可返回调整或继续，不自动降低画质。
- 常见失败原因弹窗、诊断复制和日志入口；主动取消不弹错误框。

- 输入：PLY（含压缩 PLY）、SOG、KSPLAT、SPLAT、SPZ。
- 输出：标准 PLY、压缩 PLY、SOG、CSV 表格、HTML 内嵌查看器、体素 ZIP 碰撞数据包。
- 多文件合并，可调整文件顺序。
- 对单个输入文件或合并结果分别添加有序操作：平移、旋转、缩放、无效点清理、球谐阶数上限、包围盒和球形范围筛选。
- 常用参数滑块：保留点数、球谐压缩迭代、WebP 无损打包强度、编码线程、体素边长和不透明度阈值。
- 本地日志、取消转换、输出覆盖确认。转换成功前不会替换已有目标文件。
- 两端主界面都有本项目仓库入口。首次成功导出后，仅提示一次为项目点 Star（赞）。关闭后也不会再次提示；不自动打开浏览器。

默认输出 SOG，保留 100% 的高斯点。球谐阶数上限在“变换与筛选”中添加。点数精简低于 100% 时，非标准 PLY 输出会先生成中间 PLY 再编码，需要额外磁盘空间。

### 资源监测与预警

Windows 使用系统内存接口、处理器时间、DXGI 显卡信息和本地 GPU 性能计数器。约每 2 秒后台采样，窗口最小化时约每 10 秒采样。鼠标悬停资源角标可查看设备名称、可用内存、系统提交余量和采样时间。

启动转换时，对可快速读取元数据的标准高斯 PLY、SOG 和 SPLAT 估算基础数组与编码开销区间。根据球谐阶数、点数保留比例、线程和设备设置调整需求；减点前的精简阶段也计入内存压力。范围筛选导致的点数不确定时标为上限。其他输入仍可转换，但不会虚构内存预估。

只有预计需求接近或超过当前物理内存、提交额度或可靠显存余量时提示。CPU 高占用只影响速度，不单独预警；采样过期或指标未知不被当作资源不足。自动显卡模式无法可靠确认实际设备时，显存预警采取保守判断，不承诺提前识别全部显卡错误。

macOS 源码读取 CPU 和内存压力近似余量；Apple 芯片标记统一内存，不重复计算独立显存。通用接口无法取得 GPU 使用率或显存占用时显示不可用。内存估算不是精确峰值保证。

## 本地构建

开发者需要 Node.js 22 或更高版本；普通使用者不需要安装它。先安装锁定的依赖并运行测试：

```sh
npm ci
npm test
npm run test:conversion
```

Windows 构建：

```sh
npm run build:win
```

macOS 构建：

```sh
npm run build:mac:arm64
npm run build:mac:x64
```

运行结果在 `dist/`。下载缓存和临时构建内容在 `.cache/`，不应提交。构建脚本校验 Node.js 和 Electron 官方 SHA-256 清单；转换引擎固定为 `3.10.3`，Node.js 为 `22.23.2`，Electron 为 `45.3.0`。

推荐在 macOS 上制作苹果正式发行包，脚本会使用系统 `codesign` 添加临时签名并验证应用。Windows 也能交叉打包苹果应用；交叉打包的 `-unsigned.zip` 不应直接发布，需要进一步签名。可运行：

```sh
node scripts/sign-mac.cjs dist/Splat-Convert-Desktop-1.1.0-mac-arm64-unsigned.zip
```

跨平台签名脚本会下载并校验开源 `apple-codesign 0.29.0` 的 Windows 版本。Windows 创建苹果内部符号链接时，需要系统开发者模式或管理员权限。也可以用环境变量 `RCODESIGN` 指向已安装的工具。脚本只添加临时签名，不需要或包含任何私钥。

## GitHub 自动构建

仓库内已有 `.github/workflows/build.yml`。在 GitHub 的 Actions（自动化操作）页面手动运行 `Build desktop releases`，会分别在 Windows、Apple 芯片 Mac 和 Intel Mac 上构建。每个平台先跑测试，再提供可下载的构建产物。

推送 `v` 开头的版本标签会自动创建一个草稿发行版，并附上三种程序文件；维护者检查后再发布。版本号位于 `package.json`、`app/package.json` 和 Windows 的程序集信息中，发布前应同步修改。

```sh
git tag v1.2.0
git push origin v1.2.0
```

只推送源码与锁文件，不要把 `node_modules/`、`.cache/`、`dist/`、模型文件或本机凭据放进仓库。EXE 和苹果 ZIP 应上传到发行版附件。

## 源码结构

```text
windows/                 Windows 原生界面、引擎调用、一次性提示与自测
app/                     macOS Electron 界面、受限进程通信、引擎调用
scripts/                 官方运行时下载校验、打包、临时签名
tests/                   参数校验、提示持久化、真实引擎转换、苹果包结构检查
.github/workflows/       Windows、Apple 芯片、Intel 自动构建
```

Windows 保留原有原生界面；macOS 使用 Electron 桌面窗口。两端调用官方引擎，不修改上游压缩算法。大文件在单独的引擎进程内处理，不会先读进图形界面。

## 隐私与提示记录

不提供遥测、登录或自动更新。转换不需要网络。只有点击仓库链接或提示中的“打开项目”，才会打开系统浏览器。

一次性求赞提示按当前操作系统用户记录，而非按 EXE 或版本号记录。Windows 标记位于 `%LOCALAPPDATA%/SplatConvertDesktop/star-prompt-shown-v1`；macOS 标记位于 Electron 返回的应用用户数据目录，通常是 `~/Library/Application Support/SplatConvertDesktop/star-prompt-shown-v1`。删除用户数据或换用户后会重新计数；标记不可写时跳过提示，不阻断转换。

## 局限性

- 此项目不是 PlayCanvas 或 SuperSplat 官方产品，不代表官方背书。
- 提供的苹果包使用临时签名（ad-hoc），没有 Apple Developer ID（开发者身份）签名或公证。Gatekeeper（系统安全检查）可能拦截首次打开。确认来源后，可按系统提供的“仍要打开”流程操作；不要全局关闭系统安全保护。Windows 包也未做商业代码签名，可能显示安全提示。
- 本次本地验收环境是 Windows。Windows 原生版已完成实际转换与界面测试；macOS 界面完成浏览器级交互测试，苹果包完成架构、权限、依赖、链接和签名资源检查，尚未完成 Mac 真机启动和 GPU 转换验收。苹果版本首次发布建议标记为预发布。
- 体素输出需要兼容的 GPU（图形处理器）和驱动。SOG / HTML 可改用 CPU（处理器）编码。普通网格 PLY 不一定包含高斯所需属性，不保证能作为高斯场景转换。
- 实际压缩率、耗时、内存和临时磁盘需求取决于场景。测试使用约 472 MB、200 万点的模拟文件，不代表所有真实大文件的表现。
- 仅覆盖转换网页提供的六种导出功能，没有把上游命令行的全部专业功能暴露为界面。

## 许可证与致谢

本项目界面与构建代码采用 [MIT License](LICENSE)。上游引擎、Node.js、Electron、Dawn/WebGPU、WebP、SPZ 以及图标等组件分别遵循其自身许可证。本仓库提供 `THIRD-PARTY-LICENSES.txt`，构建过程也会将依赖许可放入程序和发行包。

新增的 macOS 元数据读取依赖许可另见 `docs/licenses/`；重新构建时会合并到第三方许可清单中。

- [PlayCanvas Splat Transform](https://github.com/playcanvas/splat-transform)
- [SuperSplat Convert](https://superspl.at/convert)
- [Node.js](https://nodejs.org/)
- [Electron](https://www.electronjs.org/)
- [Lucide Icons](https://lucide.dev/)
- [apple-codesign](https://github.com/indygreg/apple-platform-rs)
