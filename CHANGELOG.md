# Changelog

> **DRAFT / 草稿**：依据当前仓库 `git log --oneline`、已有标签及产品文档整理，尚未作为正式发布说明审核。采用 Keep a Changelog 的版本分组与变更类别。以下日期为标签所指提交的日期，不据此推断实际发布日期；未标日期的候选版没有对应发布标签。`models-v1` 是模型资产标签，不是应用版本。

## [Unreleased]

### Added

- 清空前确认、取消与先归档选项，以及限时撤销；未归档字幕的关闭／退出保护和归档后退出选项。（`83cf49d`、`b82ad12`、`1752f35`）
- 归档状态显示与停止录音后的归档提示。（`1d91ed2`）
- 默认只检查、不修改版本的版本同步脚本。（`dd2dfc7`）
- iOS `PrivacyInfo.xcprivacy` 隐私清单。（`a5ef4ca`）

## [0.2.0-beta.3-windows.1] — Windows candidate（未发布）

### Added

- Windows 10/11 x64 独立候选渠道、隔离的数据目录，以及 NSIS／ZIP 候选构建流程。（`b10ac1b`）
- 录音前选择麦克风或默认播放设备的系统声音、本地 SenseVoice 识别、Hy-MT2 7B 翻译及手动文字归档。

### Fixed

- 包内原生路径与归档检查、Electron 兼容音频缓冲区，以及与生产一致的原生进程隔离检查。（`a6f404a`、`3898f46`、`254ffe3`）

### Changed

- 记录已验证的构建边界：已生成并上传工作流候选产物；候选未签名，未发布到 GitHub Release，安装流程、真实音源与 GPU 尚未完成实机验收。（`4cf363c`；[Windows 候选版](docs/product/windows-candidate.md)）

## [0.2.0-beta.2] — 2026-10-17（macOS Internal beta.2）

### Added

- Internal 与稳定安装渠道分离；Internal 可保存主要识别语言选择。（`247e16c`、`7f72df0`）
- 连续字幕预览、文件夹归档及 Subline 品牌说明。（`7f4b629`、`6b78b2d`）

### Changed

- 记录已签名、公证的 Apple Silicon macOS Internal beta.2 与首次安装说明。验收适用于 DMG 内的应用，不表示 DMG 容器独立公证。（`1cdc649`；[README.zh-CN.md](README.zh-CN.md)、[产品全貌](docs/product/overview.md)）

## [0.2.0-beta.1] — 2026-10-17（macOS 课堂 beta）

### Added

- 应用内 Apple Silicon Hy-MT2 本地推理。（`f3baba5`）
- 课堂连续双语字幕、有限原文上下文翻译、本地 Hy-MT2 流式译文与输入音量显示。（`b27402b`、`46c63f9`、`b511e43`）
- 固定课堂回放及分阶段延迟诊断。（`790d15c`）

### Changed

- 临时字幕尾部延迟两个字符展示。（`c184728`）

## [0.1.0-beta.5] — 2026-09-27

### Fixed

- 稳定实时定稿，建立日语识别精度门禁；修复新版 macOS 图标打包失败。（`251f71d`、`fa2ab2d`）

## [0.1.0-beta.4] — 2026-07-22

### Fixed

- 处理识别模型修订已有结果时的前缀重基、定稿择长与标点对齐；按文字系统修正语言误判。（`db5d02e`、`d69cd8b`）

### Added

- 实时与离线识别 CER 对照评测及语言误判统计。（`8237e57`）

## [0.1.0-beta.3] — 2026-07-07

### Added

- 自动模式下将母语反向翻译为最近一次外语。（`d580bac`）

### Fixed

- Web 模型缓存探测与列表实例复用。（`a4f4e3e`）

### Changed

- 版本号收敛为根 `package.json` 单一来源。（`9ea5107`）

## [0.1.0-beta.2] — 2026-07-05

### Added

- 模型统一清单、多源回退与内存门槛；后台模型下载、进度、取消、并行及录音等待提示。（`2875c47`、`f07429a`）

### Fixed

- Pages 部署竞态，并按相关路径变更控制部署。（`6244223`）

## [0.1.0-beta.1] — 2026-07-04

### Added

- 早期 macOS 本地实时识别与可选 API 翻译；扩展为共享 core／UI 的 macOS、iOS、Web PWA 工作区。（`937d0dc` 及更早历史）
- 按需模型下载、多识别模型选择及 macOS 系统音频采集。（`e02214a`）

### Fixed

- 滑动窗口识别、段尾与定稿丢句保护；Web 本地翻译 Worker 离线模型装载配置。（`1850a17`、`4a8054f`）

此处以现存 `v0.1.0-beta.1` 标签分组；历史另有 `23a36ad` 同名版本提交，不能据此认定两个独立发布。以上是按里程碑归纳的草稿，并非逐提交完整清单。
