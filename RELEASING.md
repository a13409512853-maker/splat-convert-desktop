# 发布到 GitHub（v3.2.3 操作指南）

仓库：https://github.com/a13409512853-maker/splat-convert-desktop

## 一、快速上传洁净源码与发布版

本工作区已在 `05_构建发布产物/GitHub_Release_v3.2.3/` 生成可直接上传的发布包：
- **`repo/`**：已清理 `.cache/`、`dist/`、`node_modules/` 与一切临时文件的洁净源码根目录，内含 `LICENSE`（Apache 2.0）、`NOTICE`、`THIRD_PARTY_LICENSES.md`、`README.md`、`CHANGELOG.md`、`locales/`、`windows/`、`app/`、`scripts/`、`docs/`、`tests/`、`.github/`。
- **`release/`**：已编译并通过完整回归测试的 Windows 发行文件（`Splat-Convert-Desktop-3.2.3-rc14-win-x64.exe`、`splat_native_viewport.dll`）、`SHA256SUMS.txt` 与 `RELEASE_NOTES_v3.2.3-rc14.md`。

### 推荐推送步骤

```powershell
# 1. 将 repo/ 内容同步至本地 git 仓库根目录（确保根目录直接看到 README.md / package.json / windows/）
git status
git add .
git commit -m "release: v3.2.3-rc14 (+Y-up native editor, 64MiB parallel bake, Apache-2.0, Vulkan bypass prototype)"
git tag v3.2.3-rc14
git push origin main --tags
```

### 创建 GitHub Release

1. 打开仓库 **Releases → Draft a new release**；
2. 选择标签 `v3.2.3-rc14`（建议勾选 **Set as a pre-release**，作为 V4 Godot 4 重构前的完整里程碑归档备份）；
3. 粘贴 `release/RELEASE_NOTES_v3.2.3-rc14.md` 内容作为发行说明；
4. 上传 `release/` 下的全部附件：
   - `Splat-Convert-Desktop-3.2.3-rc14-win-x64.exe`
   - `splat_native_viewport.dll`
   - `SHA256SUMS.txt`
   - `LICENSE` / `NOTICE` / `THIRD_PARTY_LICENSES.md`

## 二、安全与合规自查清单

- 仓库中**严禁提交** `.cache/`、`dist/`、`node_modules/`、`data/`、大型 `.ply`/`.sog` 测试素材或本机签名私钥；
- 所有分发包须附带 `LICENSE`、`NOTICE` 与第三方开源声明文件；
- 未在真机完成验收的 macOS 包不要伪标为 Windows 同版稳定发布。
