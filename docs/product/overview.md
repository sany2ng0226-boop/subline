# 产品全貌与平台能力

Subline 是基于上游开源项目 Realtime Translator 定制、面向中文、日语、英语和韩语的实时语音转写与翻译应用。macOS、Windows 候选版、iOS 和 Web 共用界面与核心规则，音频采集、识别、本地翻译和存储由各平台宿主提供。Windows 的已确认范围与验收边界见 [Windows 候选版](windows-candidate.md)。

它面向需要跨语言实时字幕的用户，典型用途包括：

- 面对面对话或单人发言的实时转写与翻译；
- 将发言者的中、日、英、韩语内容转换成用户母语字幕；
- 在 macOS 14.2 及以上对电脑正在播放的系统音频生成字幕；
- 保存一次会话的已定稿原文与译文，以便稍后查看。

具体交互与翻译规则见[使用流程与产品规则](experience.md)。

## 本地处理与隐私边界

- 各端的语音识别都在当前设备上运行，应用不把音频发送给识别服务。
- 选择本地翻译时，译文也在当前设备上生成。macOS 新安装默认使用应用内 Hy-MT2 7B（GGUF Q4_K_M），并保留 M2M-100；Web 使用 M2M-100；iOS 使用 Apple Translation。macOS 的 Hy-MT2 不需要 LM Studio 或单独启动 API 服务，推理运行时随应用提供，权重在确认后下载。
- 选择云端翻译时，需要翻译的已定稿文本段会发送到用户配置的 OpenAI 兼容端点；macOS 的 API 翻译仍附带最近两段同语言对的原文上下文，每段最多 400 字符；应用内 Hy-MT2 每次只翻译当前段原文，使用独立会话，不附带此前原文或生成的对话历史。同语言跳过及仅需中文字形归一化的段不发送。端点可以是本机运行的 LM Studio 等兼容服务，此时文本发送到本机地址。在设置中测试连接会发送固定的 `hello` 测试文本。音频始终不发送，端点的数据处理规则由对应服务商决定。
- macOS Subline Dev 的本地录后转写使用已缓存的识别和翻译模型在设备上推理。可选的 Codex 校对与翻译则通过本机 Codex CLI 和已保存的 ChatGPT 登录，将字幕文字、源／目标语言、临时行号及匿名分组发送给 OpenAI，并使用用户的订阅额度；字幕请求不包含原音、音频 ID、真实时间偏移或原音文件路径，应用不读取或转发登录凭证，由 Codex CLI 自行鉴权。实时原稿保持不变，完整成功的结果作为独立版本保存。
- 应用启动时不自动下载识别或翻译权重。用户确认下载后，应用才从模型源获取文件；Web 的 Silero VAD 是随应用外壳提供的内置例外。
- 设置、模型和会话归档只保存在当前设备或当前浏览器站点存储中，产品没有跨设备同步。
- macOS 在系统 `safeStorage` 可用时加密保存云端 API Key；加密不可用时为保证功能会明文落盘。Web 和 iOS 分别将 API Key 随设置保存到 IndexedDB 和 Preferences，应用本身不做额外加密。

## 平台能力

| 能力 | macOS | iOS 原生应用 | Web / PWA |
| --- | --- | --- | --- |
| 音频源 | 麦克风；macOS 14.2+ 可选系统音频 | 仅麦克风 | 仅麦克风 |
| 语音识别 | SenseVoice；可按语言选 Paraformer、ReazonSpeech 或 Parakeet | SenseVoice | SenseVoice；可按语言选 Paraformer、ReazonSpeech 或 Parakeet |
| 识别运行时 | sherpa-onnx Node，独立 ASR 子进程 | sherpa-onnx 原生插件 | sherpa-onnx 单线程 WASM Worker |
| 本地翻译 | Hy-MT2 7B（默认，Apple 芯片 Metal）；M2M-100 418M 或 1.2B | Apple Translation，iOS 18+ | M2M-100 418M；iOS/iPadOS WebKit 上禁用 |
| 云端翻译 | 支持 | 支持 | 支持 |
| 原音归档／录后处理 | 仅 Dev：麦克风或系统音频归档；已缓存本地模型录后转写；可选 Codex 文字校对与翻译 | 不支持 | 不支持 |
| 主要存储 | Electron `userData` 中的文件和模型目录 | Preferences（设置/归档）与 Application Support（ASR 模型） | IndexedDB（设置/归档）与 Cache Storage（模型/应用外壳） |
| 离线使用 | 所需模型已下载时可用 | ASR 模型已下载时可离线转写；本地翻译还需对应的 Apple 翻译语言包 | 应用外壳和所需模型已缓存时可用 |

### macOS

macOS 测试版名为 Subline，分发目标为 Apple 芯片 Mac；当前公开渠道的版本、下载与产物说明以[仓库首页](../../README.zh-CN.md)和 [GitHub Releases](https://github.com/sany2ng0226-boop/subline/releases) 为准。早期分发验收记录中，0.2.0-beta.1 朋友测试产物仍以旧名 Classroom Translator 构建，0.2.0-beta.2 则为独立的 Subline Internal 预览包；当时分别对指定应用产物完成了 Developer ID 签名、公证、stapler 或 Gatekeeper 检查。这些记录不是当前渠道状态，也不替本轮重新担保旧产物或 DMG 容器。Hy-MT2 已在 48 GB 内存的开发机运行，其他内存容量的最低要求尚未验收。

早期预览验收还曾在空白用户数据目录中走通首次引导、模型下载确认、系统音频识别与本地翻译、手动归档和重启读回；这些同样只作为历史记录。此前已安装并验证的 Dev 包中，真实麦克风与系统音频均能归档并按行时间回听，麦克风归档可用 SenseVoice 追加本地录后转写版本而不覆盖实时原稿，退出重启后仍能读回原音、版本和设置。新增 Codex 入口仍只在 Dev 分支，尚未完成安装版原生界面与重启验收；录后真实本地翻译权重、多人噪声环境与整场活动的长时间负载也尚未验收，不能据此承诺识别、校对或翻译效果。

macOS 版是 Electron 应用。麦克风由渲染进程采集；系统音频通过 CoreAudio Tap 回环采集，因此只在 macOS 14.2 及以上显示音源切换。ASR 与本地翻译分别运行在隔离子进程中，某个推理进程崩溃不会连带关闭主窗口。Hy-MT2 通过随应用提供的 node-llama-cpp Metal 后端执行，用户无需安装编译工具；应用不在运行时编译或下载可执行推理组件。稳定渠道的设置、归档和模型缓存位于 `~/Library/Application Support/Classroom Translator`；内部验证渠道名为 Subline Internal，使用独立的 `~/Library/Application Support/Classroom Translator Internal`。改名后数据目录和应用标识保持旧值，已有设置、归档、模型及系统授予的麦克风/系统音频权限照常沿用。两者可并排安装，不自动迁移或共用配置、归档和模型缓存。两个渠道来自同一代码库，内部验收后再发布稳定渠道；Internal 的签名、公证状态按各自产物验收，不能沿用稳定版的公证结论。

### Windows 候选版

Windows 候选版复用 Electron 桌面宿主，目标为 Windows 10/11 x64，提供麦克风与默认系统播放声音的单一音源选择、本地识别与 Hy-MT2 翻译、手动归档和文件夹。翻译优先 CUDA，不可用时显示 CPU 降级；本地失败不会自动启用云服务。设置、归档及模型使用独立的 `%APPDATA%\Subline Windows Candidate`。已通过 Windows Server 2022 上的未压缩应用构建、随包原生绑定及合成界面/数据读回检查，NSIS 安装器、ZIP 和 SHA-256 清单已生成并上传为工作流产物；安装流程、真实音频、实际模型推理、完整应用重启及朋友硬件尚未验收。完整验证边界、约束和验收清单见 [Windows 候选版](windows-candidate.md)。上表的已发布 macOS 能力与验收结论不自动适用于 Windows。

### iOS 原生应用

iOS 版是 Capacitor WebView 与原生插件的组合。识别只提供多语种 SenseVoice；音频由原生 `AVAudioEngine` 采集。本地翻译依赖 Apple Translation，要求 iOS 18 及以上，并由系统管理翻译语言包；首次使用某个语言对时，系统可能显示语言包下载或同意界面。当系统版本、语言对或语言包不可用时，本地翻译会失败，用户可改用云端翻译。

### Web / PWA

Web 版可在浏览器中直接使用，也可安装为 PWA。应用外壳和 sherpa WASM 由 Service Worker 预缓存；内置 Silero VAD 由同源资源按需写入 ASR 模型缓存，其余识别与本地翻译模型也按需缓存。已安装 PWA 可在保留模型缓存的同时强制刷新应用外壳。云端翻译和首次下载仍需要网络。

iPhone 和 iPad 上的 WebKit 单标签页无法同时容纳 ASR 与 M2M-100 的内存占用，因此在这类浏览器上不显示本地翻译选项，仅可选关闭翻译或云端翻译。
