# 发布到 GitHub

仓库：https://github.com/a13409512853-maker/splat-convert-desktop

## 当前 1.2.0

本轮已构建并实测 Windows 1.2.0；macOS 源码已同步，但未重新构建或真机验证。发布 Windows 稳定版与苹果预发布时，请分别写清验证状态，不要将旧苹果 1.1.0 文件改名为 1.2.0。

Windows 1.2.0 新增资源角标、按当前资源余量判断的预警、常见错误弹窗、七语言和工具图标。详细规则见 `docs/RESOURCES.md`。

推送当前版本标签请使用 `v1.2.0`。下方 1.1.0 内容是初版发布示例，实际发布应以新版本号为准。

1. 将源码包解压后的文件放在仓库根目录。根目录应直接看到 `README.md`、`package.json`、`windows/`、`app/` 和 `.github/`，不要再套一层目录。
2. 提交源码、锁文件和许可证。不要提交运行时缓存、依赖目录、模型测试文件或程序二进制文件。
3. 在 GitHub 的 Actions 页面手动运行 `Build desktop releases`，核对三个构建任务和测试结果。
4. 在 macOS 真机验证两种架构的启动、文件选择、实际 SOG 转换和首次提示后，再作为稳定版发布。现有本地苹果包建议先发预发布。
5. 创建 `v1.1.0` 标签后，自动构建会生成草稿发行版。也可以手动创建发行版并上传已制作的三种程序和 `SHA256SUMS.txt`。

建议发行说明：

```text
Splat Convert Desktop v1.1.0

Windows / macOS 本地高斯泼溅转换工具，基于 PlayCanvas Splat Transform 3.10.3。

支持标准 PLY、压缩 PLY、SOG、CSV、HTML 和体素碰撞数据导出。
新增苹果 Apple 芯片 / Intel 版本、项目仓库入口、首次转换成功仅提示一次的求赞窗口。

Windows：下载 win-x64.exe，双击运行。
Mac Apple 芯片：下载 mac-arm64-adhoc.zip。
Mac Intel 芯片：下载 mac-x64-adhoc.zip。
Mac 解压后将 .app 拖入“应用程序”。

苹果包为临时签名，未做开发者身份签名或公证；可能触发系统安全提示。
macOS 13 或更高。苹果包尚未完成真机验收，本次作为预发布提供。
```

## 正式签名

面向广泛用户的稳定苹果发行版，建议在 Mac 上配置开发者身份签名、公证和票据装订。仓库未包含任何签名密钥。临时签名不等于苹果公证，不应在宣传中描述为“已通过苹果认证”。
