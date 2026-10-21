# 项目地图

Subline 的源码仓库（仓库名与 npm 包名仍沿用 realtime-translator / `@rt/*`）是 pnpm workspace 单仓库。`@rt/core` 提供平台无关规则与契约，`@rt/ui` 提供共享界面，macOS、Windows 候选版、iOS 和 Web 宿主通过 `AppBridge` 注入平台能力。外部可见的产品行为见[product/overview.md](product/overview.md) 和 [product/experience.md](product/experience.md)。

## 模块导航

| 模块 | 职责与关键入口 |
| --- | --- |
| `packages/core` (`@rt/core`) | 领域类型、`AppBridge` 契约、设置/归档纯逻辑、模型注册表、macOS/Web 共用的实时转写管线、定稿漂移度量、供 macOS 使用的文字合句与原文上下文，以及三端共用的翻译编排；公共入口为 `packages/core/src/index.ts`。 |
| `packages/ui` (`@rt/ui`) | 共享 Vue 3 单页界面，包含引导、主页、设置、归档和跨页状态；平台业务能力及设置、模型、归档持久化通过 `AppBridge` 访问宿主，纯界面状态可直接使用 DOM、媒体查询和 `localStorage` 等浏览器运行时能力。挂载入口为 `packages/ui/src/index.ts`，屏幕切换入口为 `packages/ui/src/App.vue`。 |
| `apps/macos` (`@rt/macos`) | macOS 与 Windows 候选版共用的 Electron 桌面宿主（保留历史目录名）：渲染层采集麦克风/系统音频，preload 暴露收紧后的 IPC，主进程管理设置、归档、模型和推理子进程；宿主入口是 `apps/macos/src/main/index.ts`，UI 适配入口是 `apps/macos/src/renderer/src/mac-bridge.ts`。 |
| `apps/web` (`@rt/web`) | 浏览器 PWA 宿主：使用 IndexedDB/Cache Storage 存储，AudioWorklet 采集，Web Worker 中运行 sherpa-onnx WASM 与本地翻译，并管理 Service Worker 外壳缓存；应用入口是 `apps/web/src/main.ts`，平台契约实现是 `apps/web/src/bridge.ts`。 |
| `apps/ios` (`@rt/ios`) | Capacitor 宿主和 WebView 侧桥接，设置/归档使用 Preferences；应用入口是 `apps/ios/src/main.ts`，平台契约实现是 `apps/ios/src/bridge.ts`。 |
| `apps/ios/native-plugin` | iOS 原生能力：`AVAudioEngine` 音频采集、sherpa-onnx ASR、模型下载/管理和 iOS 18+ Apple Translation；TypeScript 契约从 `definitions.ts` 导出，Swift 主入口是 `ios/RealtimeAsrPlugin.swift`。 |
| `assets` | 三端图标的共享源资产，满版母版为 `assets/icon.svg`；`apps/macos/scripts/gen-icon.mjs`、`apps/web/scripts/gen-icons.mjs` 和 `apps/ios/scripts/gen-icons.mjs` 由此生成各端尺寸和格式，macOS 取景另加投影与描边。 |
| 根工作区配置 | `package.json` 和 `pnpm-workspace.yaml` 定义工作区、共享依赖版本与跨模块质量门禁；`.github/workflows/ci.yml` 运行检查；仅仓库变量 `ENABLE_PAGES=true` 时启用 GitHub Pages 的变更探测与部署。 |

## 关键数据流

### 录音与转写

1. `@rt/ui` 调用注入的 `AppBridge.startPipeline()`。
2. 宿主按平台采集音频：macOS 在渲染层采集后经 IPC 传给主进程，Web 用 AudioWorklet 传给 ASR Worker，iOS 在原生插件内采集。
3. macOS 和 Web 将音频送入 `@rt/core` 的共享转写管线，分别在 utility process 和 WASM Worker 中执行 VAD 与 ASR；iOS 原生插件在自身 ASR 队列中执行对应的 VAD、部分识别与定稿。
4. macOS 在识别后使用 `packages/core/src/asr/sentence-assembler.ts` 按规则合并文字片段，不注入模型切句判断器；默认启用日语短谓语句提前提交，等待上限为 12 秒、累计音频上限为 14 秒，不改变 ASR 识别窗口或翻译模型。部分文本与合并后的定稿段经 `AppBridge` 事件返回 `@rt/ui`。Web 与 iOS 直接发布自身管线的定稿段；UI 将定稿段追加为对话行。

### 音频音量显示

- `packages/core/src/audio-level.ts` 提供输入 PCM 的音量归一化，macOS 的 `mac-bridge.ts` 在发送识别音频时通过可选 `AppBridge.onAudioLevel` 发布音量事件；它不改写音频或识别管线。
- `packages/ui/src/components/AudioLevelMeter.vue` 订阅宿主音量，以 Canvas 在主页顶栏绘制连续滚动的波形，不经 Vue 响应式；停止录音且波形归零后停止 rAF 循环。未提供该桥接能力的宿主不显示。外部行为见[开始一次转写](product/experience.md#开始一次转写)。

### 部分识别与字幕显示

- `packages/core/src/types.ts` 的 `PartialPayload.stableText` 是可选的已确认显示前缀。共享转写管线在实时识别时从 `committedDone + committedInWindow` 生成它；音频块更新时只使用 `committedDone`。后续识别重基仍可修改前缀，它不构成不可变文本的承诺。
- macOS 宿主把合句器中待提交文字与识别器稳定前缀合并，经部分识别事件发送给 UI；定稿事件使 UI 原位确认当前临时字幕行，并清空部分识别状态，不再把刚定稿全文短暂写回。Web 的 ASR Worker 消息和 iOS 原生桥目前未提供稳定前缀元数据。
- `packages/ui/src/composables/useTranscription.ts` 将临时行保存在独立的 `draftLine` ref，定稿行保存在 `lines`；临时行不参与归档或翻译。首次部分识别创建带稳定 `displayId` 的行，后续部分识别修改它；定稿通过 `Object.assign` 更新同一对象后放入 `lines`，再清空 `draftLine`。无部分识别的定稿也分配 `displayId`；译文仍按宿主段 ID 回填原行。停止录音等待宿主提交剩余文字后清除临时行，清屏同时清除临时行。
- `stablePartial` 经 `MainScreen.vue` 传入 `components/TranscriptList.vue`。只有它与当前全文前缀匹配时，UI 才将前缀深色展示，其余尾部稍浅色；不匹配时全段浅色。缺少元数据时保留 `undefined`，让 iOS/Web 兼容原有的整段深色外观，不将其伪装为已确认前缀。
- `TranscriptList.vue` 将已定稿行与临时行合成按时间正序的单一字幕流，并以 `displayId` 作为 Vue key；同一句从临时状态、定稿到翻译回填持续使用同一个 `article`，不再分设临时框、最新定稿框和历史区，也不使用文本框内部滚动。新行与译文的过渡只改 opacity。
- `MainScreen.vue` 将识别语言与母语作为 `sourceLang` / `targetLang` 传入 `TranscriptList.vue`；定稿行在 `useTranscription.ts` 中保留段的 `lang`，显示时优先于识别语言设置。组件将 `zh` 标注为 `zh-Hans`，按 `:lang()` 为日语优先指定 Hiragino Sans、简体中文优先指定 PingFang SC；`auto` 不生成具体语言标注。译文标注当前仍使用母语设置，尚未逐行传入自动反向翻译的实际目标语种。
- 字幕排版（字号、颜色层级、间距、草稿光标与淡入）由 `TranscriptList.vue` 的 scoped CSS 管理，颜色取自 `styles.css` 的 `--rt-*` 主题变量；外部规则见[开始一次转写](product/experience.md#开始一次转写)。
- 底部跟随也在 `TranscriptList.vue`：只有用户向上滚动才退出跟随，跟随中的高度变化由 `ResizeObserver` 贴底，数据变化后的 `watch` + `nextTick` 贴底作为后台窗口无渲染帧时的兜底。上述共享 UI 状态与排版不增加识别计时器、推理或切句步骤。

### 翻译

1. 宿主在定稿段到达时调用 `packages/core/src/translation/segment-translation.ts` 的共享编排。
2. 共享编排根据母语、识别语言和会话内最近外语决定跳过、字形归一化或发起翻译。
3. macOS 应用内 Hy-MT2 与 API 翻译通过 `packages/core/src/translation/context.ts` 管理同语言对的有限原文上下文；会话与配置变化由主进程重置。宿主执行具体引擎：macOS 将应用内 Hy-MT2 7B、M2M-100/API 请求放在纯 Node 子进程，Web 用 Transformers.js Worker 或直接调云端，iOS 调 Apple Translation 或直接调云端。
4. macOS 主进程在发送翻译 IPC 前通过 `apps/macos/src/main/translation/request-queue.ts` 调度请求，负责并发、等待容量、排队过期及配置变更时的等待取消；具体限制与行级降级见[翻译规则](product/experience.md#翻译规则)。翻译子进程仍负责具体推理，ASR 定稿路径不等待翻译队列完成。
5. pending、部分译文、成功或失败事件按段 ID 回到 UI 的原文行；共享编排负责部分译文的目标字形归一化，并忽略请求结束后的迟到更新。macOS 通过翻译子进程 IPC 回传应用内及本机 API Hy-MT2 7B 的流式结果；`packages/core/src/translation/translation-stream.ts` 负责读取 OpenAI 兼容 SSE，部分结果不结束队列请求。Web 与 iOS 未订阅部分回填，保持完整结果路径。流式显示与失败契约见[翻译规则](product/experience.md#翻译规则)。

- `apps/macos/src/main/translation/hy-translator.ts` 通过 node-llama-cpp 装载 GGUF；`hy-runtime.ts` 负责 macOS Metal 及 Windows CUDA/CPU 选择和资源检查；每句创建独立 session，仅使用显式原文上下文。`getLlama` 禁止运行时构建和下载原生组件。`translator.ts` 工厂路由 Hy-MT2 与 `local-translator.ts` 的 M2M-100 实现，上层 IPC 将上下文和部分结果回调传入本地实现。
- `apps/macos/electron-builder.yml` 将 Node 翻译子进程入口及依赖解包到 `app.asar.unpacked`，包含 arm64 Metal 原生运行时而不打包权重；纯 Node 子进程不能依赖 Electron 的 asar 读取补丁。

### 设置、模型与归档

- `@rt/ui` 只持有表单和当前会话状态；设置、模型和归档持久化经 `AppBridge`。设置保存契约是 `SettingsPatch`：UI 只提交发生变化的字段，`@rt/core` 的 `mergeSettings` 将补丁合并到最新完整设置并统一校验；macOS 同步合并后写文件，Web 与 iOS 将异步写入串行化，并在每次实际执行时读取最新状态再合并。默认值、其它字段校验、归档摘要和排序也在 `@rt/core` 复用，各宿主只选择文件、Preferences 或 IndexedDB 作为存储后端。
- Internal 归档入口由 `packages/ui/src/screens/ArchiveLibrary.vue` 管理文件夹、筛选、改名与移动，`MainScreen.vue` 负责手动保存弹窗；内容标题提取属于 `packages/core/src/archive.ts` 的 `suggestArchiveTitle`。产品规则见[清屏与归档](product/experience.md#清屏与归档)。
- `apps/macos/src/main/archives.ts` 保留 `archives.json` 的记录数组格式，读取旧记录不做迁移；`archive-library.ts` 单独管理 `archive-library.json` 中的文件夹及记录元数据覆盖，改名和移动不重写归档正文。归档正文与元数据各自通过原子替换落盘，UI 等待保存成功后才清屏。
- 文件夹能力同时受 UI 的 `__INTERNAL_BUILD__`、可选 `AppBridge.getArchiveLibrary` 能力和桌面主进程的 Internal 应用身份、Windows 候选版或隔离预览 profile 检查约束；稳定渠道、Web 与 iOS 保留原路径。
- `apps/macos/src/main/settings.ts` 仅对新建设置预选本地 `hy-mt2-7b`，翻译默认保持关闭；已有设置由共享兼容逻辑读取。正式应用名为 Subline，应用标识仍为 `io.github.sany2ng0226.classroomtranslator`，独立数据目录为 `~/Library/Application Support/Classroom Translator`。
- 模型清单、大小、语言、平台可用性和有序下载源的单一事实源是 `packages/core/src/model-registry.ts`。各宿主将文件下载到本端模型目录或 Cache Storage，再由对应推理运行时离线装载。Hy-MT2 使用 Tencent 固定 revision 的 Q4_K_M 文件，注册表声明精确字节数及 SHA-256；macOS 下载流程据此校验。

## 测试与构建位置

- 根 `package.json` 的 `pnpm check` 运行 `@rt/core` 单元测试、macOS 评测语料导入器的纯逻辑测试，以及 macOS、Web、iOS 三端类型检查；它不下载语料或模型，也不执行耗时的识别精度门禁。
- `packages/core/src/**/*.test.ts` 覆盖设置、归档、模型源、转写管线、定稿漂移统计和翻译决策等共享逻辑。
- `apps/macos/test` 包含无 GUI 管线、CER 评测和翻译脚本；入口命令由 `apps/macos/package.json` 的 `test-pipeline`、`eval-cer` 和 `test-translate` 定义。`eval-cer` 同时报告产品管线 CER、整段离线 CER 和“实时最长结果到定稿”的 Final 漂移，并可用 `--max-cer`、`--max-drift` 将任一模型的加权结果设为失败门槛。日语快捷命令 `eval-cer-ja` 评测固定语言的完整语料，`eval-cer-ja:gate` 则以 SenseVoice 的产品管线 CER 不超过 20%、Final 漂移不超过 5% 为回归门禁。
- `apps/macos/scripts/fetch-fleurs-eval.mjs` 通过 `fetch-eval-fleurs` 从固定 revision 的 FLEURS `ja_jp` test split 确定性抽取 100 条 CC-BY-4.0 语料，生成 16 kHz 单声道 PCM WAV、参考文本、语言元数据和带署名及音频哈希的 manifest。源 Parquet 缓存在 `apps/macos/test-audio/cache`，用例写入 `apps/macos/test-audio/eval/fleurs-ja-test`；两处均被 Git 忽略，需要评测的环境自行生成。
- `apps/macos/test/stage-latency.ts` 使用固定课堂音频、SenseVoice、默认合句规则、Hy-MT2 7B 与产品翻译队列作静音实时回放，分开记录识别提交、合句、排队与翻译延迟；入口为 `test-stage-latency`，指标边界、命令和私有素材要求见[macOS 无 GUI 评测](../apps/macos/test/README.md)。
- `apps/macos/test/translation-transport-replay.ts` 在固定课堂样本校验通过的原文与相同上下文上，以 ABBA 顺序对比完整响应与流式响应的首批、完整返回延迟，并严格检查最终译文一致性及部分输出前缀；命令和边界见[macOS 无 GUI 评测](../apps/macos/test/README.md)。
- `apps/macos/test/classroom-replay.ts` 使用同一音频与识别模型，对照未合句和合句的原文段，并可将两组结果送至同一 OpenAI 兼容翻译端点；用于课堂音频回放验收。
- `apps/macos/test/semantic-boundary-replay.ts` 在相同 ASR 事件时序上对照规则合句与语义判断，固定 Hy-MT2 翻译及原文上下文。`local-boundary-judge.ts` 通过本机 LM Studio 的 `sentence-judge` 别名请求 `END` / `WAIT`，判断超时按规则回退。结果记录提示词、分组、配置及带时刻和触发原因的 `flushEvents`。
- 回放脚本末尾的 `original|small|compare` 参数选择原英文提示词、中文指令加日语示例提示词，或将两者与规则合句分组对照，默认是 `original`。`limit-audit` 在同一 ASR 时序、优化提示词和 Hy-MT2 配置下，对照原规则、保留 8 秒等待/10 秒音频硬上限的模型辅助、仅将规则上限延至 12 秒/14 秒，以及允许模型复核 8 秒/10 秒阈值的四组配置。
- `active-vs-rules` 将逐个已定稿 ASR 片段请求模型判断的 `reviewEverySegment` 实验与 `fast-rules` 对照。后者启用 `shortSentenceRule`：日语具有明确谓语结尾（如「です」「ます」）、至少 4 字且音频至少 1 秒时可提交，并将等待/音频上限设为 12 秒/14 秒。模型复核组同样保留 12 秒/14 秒最终边界；字数、语言、间隔和停止边界仍有效。`shortSentenceRule` 及 12 秒/14 秒上限现为合句器和 macOS 默认录音流程的规则配置；模型判断选项仍仅供离线实验，未接入应用界面或默认录音流程。回放实验会显式指定各组参数，继续保留原 8 秒/10 秒规则基线，避免默认值变化改写历史对照的含义。
- 根 `pnpm build` / `pnpm dist` 构建或打包 macOS；Web 和 iOS Web 资源分别由各自 `package.json` 的 `build` 脚本构建。iOS 原生工程位于 `apps/ios/ios/App`，注册表到 Swift 的生成入口是 `apps/ios/native-plugin/scripts/gen-asr-models-swift.mjs`。
- macOS 分发采用本机 Developer ID 签名与独立 Apple 公证步骤：electron-builder 使用本机 Keychain 身份，`CSC_NAME` 不含 `Developer ID Application:` 前缀；Xcode archive 经 `xcodebuild -exportArchive`（`method=developer-id`、`destination=upload`）提交，Apple 接受后由 `-exportNotarizedApp` 导出带票据的应用。签名、stapler 和 Gatekeeper 检查导出应用，再用 electron-builder `--prepackaged` 制作 DMG，不能将 app 的票据误称为 DMG 独立公证。私钥与认证信息不进入仓库。
- `apps/macos/scripts/package-mac.mjs` 从根版本号构建两个渠道：默认生成 `Subline.app`，包名 `realtime-translator`、appId `io.github.sany2ng0226.classroomtranslator`；`pnpm --filter @rt/macos dist:preview` 使用 `--preview` 生成 `Subline Internal.app`，包名 `realtime-translator-internal`、appId `io.github.sany2ng0226.classroomtranslator.preview`，默认输出 `apps/macos/release-preview/mac-arm64`。`RT_RELEASE_DIR` 可覆盖产物目录。打包先构建工作区，再用遵循锁文件的 `pnpm deploy` 导出自包含副本；`pnpm-workspace.yaml` 的 `injectWorkspacePackages` 与 `syncInjectedDepsAfterScripts` 保证副本带入构建后的工作区包。命令只构建，不安装、发布或自动完成公证；内部验收后再发布稳定渠道，稳定渠道目前仍为朋友测试版。
- `apps/macos/src/main/index.ts` 的 `LEGACY_PROFILE_DIRS` 把打包后的应用名映射到旧数据目录：Subline Internal（及更早的 Realtime Translator Internal）用 `Application Support/Classroom Translator Internal`，Subline（及 Realtime Translator）用 `Application Support/Classroom Translator`，两者分离；未打包且设置 `RT_PREVIEW_PROFILE` 时改用该目录并以 Subline Preview 命名。设置、归档及 `models` 缓存随各自目录隔离。打包窗口使用 `app.getName()` 显示渠道名，并拦截页面标题更新以保持窗口标识。
- `package-mac.mjs --preview` 构建时设置 `RT_INTERNAL_BUILD=1`，由 `apps/macos/electron.vite.config.ts` 注入 `__INTERNAL_BUILD__`。`packages/ui/src/screens/MainScreen.vue` 仅在内部构建展示主要语言下拉，复用 `saveSettings` 保存 `asr.language`，并按平台和语言校验当前模型、必要时回退 `DEFAULT_ASR_MODEL_ID`。默认稳定构建关闭此入口；入口锁定遵循录音启停和保存状态。
- `.github/workflows/ci.yml` 在 PR、`main` 分支推送和手动触发时执行 core 单元测试、字幕身份、macOS 翻译队列与阶段延迟记账回归测试、三端类型检查，并校验 iOS 生成的模型清单未与注册表漂移。Pages 变更探测和部署均要求仓库变量 `ENABLE_PAGES=true`；未设置时仅执行质量门禁。启用后，门禁通过的 `main` 推送仅在 Web 相关变更时部署，手动触发则直接进入部署流程。

### Windows 候选构建

- `apps/macos/scripts/package-win.mjs` 和 `electron-builder.windows.yml` 从共享桌面宿主生成 Windows x64 NSIS/ZIP 候选；`pnpm --filter @rt/macos dist:win` 需在 Windows x64 运行，默认输出到 `apps/macos/release-windows`，不安装或发布。产品边界见 [Windows 候选版](product/windows-candidate.md)。
- `.github/workflows/windows-candidate.yml` 使用 Windows runner 构建并保存安装器、ZIP、SHA-256 与诊断记录；`apps/macos/scripts/windows-native-smoke.mjs` 检查随包原生依赖并启动 `src/main/candidate-smoke.ts` 的合成界面、设置和归档验证。这些入口不替代真实音源或 CUDA 推理验收。
- 桌面 `src/main/index.ts` 为 Windows 候选设置独立 userData，系统音频仅向主窗口主 frame 的有效系统音源请求授权；`src/shared/audio-source.ts` 提供平台能力判定，渲染桥接负责采集默认播放声音及释放临时视频轨。
