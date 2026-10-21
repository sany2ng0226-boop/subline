# 隐私说明（DRAFT / 草稿）

本草稿仅描述当前仓库代码可核实的行为，**不是法律意见，也未经正式隐私政策审核**。第三方服务的留存、训练用途、服务器日志及操作系统备份行为不能仅从本仓库确认。代码路径为下述说明的依据。

## 音频与本地识别

麦克风与系统音频用于实时识别与翻译。语音识别在本机完成，音频不会上传；仅当你启用 API／云端翻译时，识别出的文字会发送到你配置的翻译服务（可以是本机或云端服务）。

ASR（语音识别）在本机执行；本次检查的应用录音／识别流程没有上传音频。桌面端在本机进程间传递 PCM，Web 在 AudioWorklet／Worker 内处理，iOS 使用原生音频采集与 sherpa-onnx。云翻译请求不包含 PCM、录音文件或音频编码内容。

依据：[共享识别管线](packages/core/src/asr/transcription-pipeline.ts)、[桌面音频桥接](apps/macos/src/renderer/src/mac-bridge.ts)、[桌面主进程](apps/macos/src/main/index.ts)、[Web ASR](apps/web/src/asr/web-asr.ts)、[Web 识别 Worker](apps/web/src/asr/sherpa-worker.ts)、[iOS 原生识别](apps/ios/native-plugin/ios/RealtimeAsrPlugin.swift)。

## 可选 API 翻译：具体发送什么

当用户启用 `cloud` 翻译引擎（界面 `engineCloud`：“API 服务（本机 / 云端）”）并触发翻译时，**识别得到的文字会发送到用户配置的 OpenAI 兼容端点**，使用用户的 `baseURL`、`apiKey` 和 `model`。该端点也可以是本机服务。选用应用内本地翻译引擎时，不走这个 API 请求。

实际请求为向去掉尾部斜线的 `baseURL + /chat/completions` 发送 HTTP POST：

- 请求头：`Content-Type: application/json`；配置了 Key 时另带 `Authorization: Bearer <apiKey>`。
- JSON：`model` 为配置的模型名，`temperature: 0`；`messages` 仅有一条 `role: "user"` 消息。
- 消息内容：目标语言名称、翻译指令、当前待翻译的识别原文；若调用方提供上下文，还包含最多前两段原文，每段截取末尾 400 个 JavaScript 字符串代码单元，以 JSON 数组嵌入提示词。桌面端 API 翻译接入此上下文；当前 Web／iOS 调用未传入上下文。此处没有发送整份归档、归档标题、音频或 API 对话历史；上下文是原文，不是此前生成的译文。
- 仅在本机回环端点、模型名匹配 `hy-mt2-7b` 且提供部分结果回调时附加 `stream: true`。
- “测试连接”也会请求该端点：发送固定文字 `hello`，目标为日语，并包含上述翻译指令、模型参数与认证头。

依据：[请求和完整提示词](packages/core/src/translation/cloud-translator.ts)、[上下文截取](packages/core/src/translation/context.ts)、[桌面调用与连接测试](apps/macos/src/main/index.ts)、[Web 调用](apps/web/src/bridge.ts)、[iOS 调用](apps/ios/src/bridge.ts)、[引擎及端点设置](packages/ui/src/components/settings/TranslationSection.vue)。

远程端点请求允许跟随重定向；回环端点拒绝重定向。代码允许 HTTP 或 HTTPS，传输保护取决于用户的地址配置。端点提供商如何使用或保存文本与 Key，本仓库无法确认。界面提供多个地址预设，不表示会自动向所有预设发送数据。iOS／内存受限 Web 环境的引擎回退可能选择 `cloud`，但仍需有效端点配置才能请求，不能把所有平台都描述为默认本地翻译。

## 模型下载与网络主机

模型文件按注册表下载，本地 ASR 不等于首次安装或下载模型时无需网络。代码中配置的模型源主机为：

| 主机 | 用途与边界 |
| --- | --- |
| `github.com` | 原生端模型资产源：`baijunjie/realtime-translator/releases/download/models-v1/`。 |
| `huggingface.co` | 模型上游；Web 模型下载主源，也用于注册表中的原生端上游地址。 |
| 可选 `HF_MIRRORS` 中的主机 | 当前列表为 `[]`，没有启用镜像；注释示例 `hf-mirror.com` 并非当前实际配置。 |
| Web 应用自身的 origin | Web 的部分 VAD／WASM 静态资源从部署站点加载，实际主机取决于部署。 |

下载器会跟随 GitHub／HuggingFace 的重定向；最终 CDN／对象存储主机由服务响应决定，未在这里假定固定名单。下载请求会让目标服务器接收正常网络连接信息（例如源 IP 与请求路径），下载代码未附带识别原文或音频。

依据：[模型源](packages/core/src/model-sources.ts)、[模型注册表](packages/core/src/model-registry.ts)、[桌面下载器](apps/macos/src/main/model-downloader.ts)、[桌面翻译模型下载](apps/macos/src/main/translation/model-downloader.ts)、[Web ASR 下载](apps/web/src/asr/model-store.ts)、[Web 翻译模型下载](apps/web/src/translation/model-store.ts)、[iOS 生成的模型 URL](apps/ios/native-plugin/ios/AsrModels.swift)及[原生下载实现](apps/ios/native-plugin/ios/RealtimeAsrPlugin.swift)。

## 数据、设置和归档存储

| 平台 | 代码中的位置与内容 |
| --- | --- |
| macOS 桌面打包版 | Electron `userData` 下的 `settings.json`（设置）、`archives.json`（手动保存的文字归档）、`archive-library.json`（文件夹及归档元数据）。Subline 使用 `~/Library/Application Support/Classroom Translator`；Internal 使用 `~/Library/Application Support/Classroom Translator Internal`。 |
| Windows 候选版 | `app.getPath('appData')/Subline Windows Candidate` 下的独立 `userData`，使用相同设置／归档文件结构；不假定每台机器的绝对用户目录。 |
| 桌面模型 | 打包版 `userData/models`，翻译模型在其 `transformers` 子目录。开发版从 `app.getAppPath()/models` 读取；`RT_PREVIEW_PROFILE` 可指定开发预览数据目录。 |
| Web | 当前站点 origin 的 IndexedDB：库 `realtime-translator`，`kv` store 的 `settings` 保存设置，`archives` store 保存文字归档。Cache Storage 的 `realtime-translator-asr-models-v1` 和 `transformers-cache` 保存模型；PWA 另有应用资源缓存。 |
| iOS | Capacitor Preferences（UserDefaults）键 `realtime-translator.settings` 与 `realtime-translator.archives` 保存设置／文字归档；ASR 模型在应用沙盒 `Application Support/models`。 |
| 共享 UI | `localStorage` 记录系统音频权限说明是否展示；当前会话字幕和清空撤销快照保存在 UI 内存中。未归档内容不能视为已持久保存。 |

归档记录包含名称、创建时间、行数据（原文、译文、时间戳等），及可选文件夹标识；归档写入路径保存文字数据，没有录音文件字段。桌面损坏归档可能保留为 `archives.json.corrupt-<时间戳>`。代码未对这些归档 JSON 做额外加密。

桌面 API Key 在 Electron `safeStorage.isEncryptionAvailable()` 为真时加密为 `apiKeyEnc`；**加密不可用时会回退到明文设置文件**，旧明文配置也能读取。Web 和 iOS 的设置分别直接序列化到 IndexedDB／Preferences，本次检查未发现额外 Key 加密，不能承诺 Key 始终加密或仅存内存。

依据：[桌面目录设置](apps/macos/src/main/index.ts)、[设置与密钥持久化](apps/macos/src/main/settings.ts)、[归档正文](apps/macos/src/main/archives.ts)、[归档元数据](apps/macos/src/main/archive-library.ts)、[数据类型](packages/core/src/types.ts)、[Web 存储](apps/web/src/bridge.ts)、[iOS 存储](apps/ios/src/bridge.ts)、[iOS 模型目录](apps/ios/native-plugin/ios/RealtimeAsrPlugin.swift)、[UI 会话状态](packages/ui/src/composables/useTranscription.ts)、[UI 权限标记及清空](packages/ui/src/screens/MainScreen.vue)。

## 分析、遥测与检查限制

本次搜索 `packages/core`、`packages/ui`、`apps/*` 的网络请求、HTTP 地址、存储及 telemetry／analytics 相关代码，**未发现应用主动向分析服务发送使用统计、广告追踪或崩溃遥测的实现**。`packages/core/src/bridge.ts` 中的 “input loudness telemetry” 是本机音量事件，用于音量显示，不是远程分析上传。iOS [隐私清单](apps/ios/ios/App/App/PrivacyInfo.xcprivacy)声明不追踪及空的收集类型列表；这不取消用户主动配置 API 翻译时的文字外发。

此结论是源码检查结果，未进行运行时抓包，也不保证操作系统、部署站点或全部第三方依赖没有自己的日志行为；第三方保留期限与删除政策仍待独立核实。

## English summary

**DRAFT — not legal advice.** ASR runs locally; the reviewed application audio pipeline does not upload audio. Enabling the API/cloud translation engine sends recognized text, translation instructions, target language and, on desktop, up to two preceding source-text segments (last 400 UTF-16 code units each) to the user-configured OpenAI-compatible `baseURL`, using the configured model and API key. Connection tests send `hello`. Models download from GitHub / Hugging Face; no optional mirror is currently enabled, and redirects may reach other hosts. Settings and text archives are stored locally in desktop files, browser IndexedDB or iOS Preferences. Desktop key encryption has a plaintext fallback; Web/iOS settings have no additional encryption in the reviewed code. No application analytics upload implementation was found; third-party retention and runtime network behavior have not been independently verified.
