# 项目地图

Realtime Translator 是 pnpm workspace 单仓库。`@rt/core` 提供平台无关规则与契约，`@rt/ui` 提供三端共享界面，macOS、iOS 和 Web 宿主通过 `AppBridge` 注入平台能力。外部可见的产品行为见[product/overview.md](product/overview.md) 和 [product/experience.md](product/experience.md)。

## 模块导航

| 模块 | 职责与关键入口 |
| --- | --- |
| `packages/core` (`@rt/core`) | 领域类型、`AppBridge` 契约、设置/归档纯逻辑、模型注册表、macOS/Web 共用的实时转写管线、定稿漂移度量、供 macOS 使用的文字合句与原文上下文，以及三端共用的翻译编排；公共入口为 `packages/core/src/index.ts`。 |
| `packages/ui` (`@rt/ui`) | 共享 Vue 3 单页界面，包含引导、主页、设置、归档和跨页状态；平台业务能力及设置、模型、归档持久化通过 `AppBridge` 访问宿主，纯界面状态可直接使用 DOM、媒体查询和 `localStorage` 等浏览器运行时能力。挂载入口为 `packages/ui/src/index.ts`，屏幕切换入口为 `packages/ui/src/App.vue`。 |
| `apps/macos` (`@rt/macos`) | Electron 宿主：渲染层采集麦克风/系统音频，preload 暴露收紧后的 IPC，主进程管理设置、归档、模型和推理子进程；宿主入口是 `apps/macos/src/main/index.ts`，UI 适配入口是 `apps/macos/src/renderer/src/mac-bridge.ts`。 |
| `apps/web` (`@rt/web`) | 浏览器 PWA 宿主：使用 IndexedDB/Cache Storage 存储，AudioWorklet 采集，Web Worker 中运行 sherpa-onnx WASM 与本地翻译，并管理 Service Worker 外壳缓存；应用入口是 `apps/web/src/main.ts`，平台契约实现是 `apps/web/src/bridge.ts`。 |
| `apps/ios` (`@rt/ios`) | Capacitor 宿主和 WebView 侧桥接，设置/归档使用 Preferences；应用入口是 `apps/ios/src/main.ts`，平台契约实现是 `apps/ios/src/bridge.ts`。 |
| `apps/ios/native-plugin` | iOS 原生能力：`AVAudioEngine` 音频采集、sherpa-onnx ASR、模型下载/管理和 iOS 18+ Apple Translation；TypeScript 契约从 `definitions.ts` 导出，Swift 主入口是 `ios/RealtimeAsrPlugin.swift`。 |
| `assets` | 三端图标的共享源资产；各端构建脚本由此生成所需尺寸和格式。 |
| 根工作区配置 | `package.json` 和 `pnpm-workspace.yaml` 定义工作区、共享依赖版本与跨模块质量门禁；`.github/workflows/ci.yml` 运行检查；仅仓库变量 `ENABLE_PAGES=true` 时启用 GitHub Pages 的变更探测与部署。 |

## 关键数据流

### 录音与转写

1. `@rt/ui` 调用注入的 `AppBridge.startPipeline()`。
2. 宿主按平台采集音频：macOS 在渲染层采集后经 IPC 传给主进程，Web 用 AudioWorklet 传给 ASR Worker，iOS 在原生插件内采集。
3. macOS 和 Web 将音频送入 `@rt/core` 的共享转写管线，分别在 utility process 和 WASM Worker 中执行 VAD 与 ASR；iOS 原生插件在自身 ASR 队列中执行对应的 VAD、部分识别与定稿。
4. macOS 在识别后使用 `packages/core/src/asr/sentence-assembler.ts` 按规则合并文字片段，不注入模型切句判断器；默认启用日语短谓语句提前提交，等待上限为 12 秒、累计音频上限为 14 秒，不改变 ASR 识别窗口或翻译模型。部分文本与合并后的定稿段经 `AppBridge` 事件返回 `@rt/ui`。Web 与 iOS 直接发布自身管线的定稿段；UI 将定稿段追加为对话行。

### 部分识别与字幕显示

- `packages/core/src/types.ts` 的 `PartialPayload.stableText` 是可选的已确认显示前缀。共享转写管线在实时识别时从 `committedDone + committedInWindow` 生成它；音频块更新时只使用 `committedDone`。后续识别重基仍可修改前缀，它不构成不可变文本的承诺。
- macOS 宿主把合句器中待提交文字与识别器稳定前缀合并，经部分识别事件发送给 UI；定稿事件使 UI 原位确认当前临时字幕行，并清空部分识别状态，不再把刚定稿全文短暂写回。Web 的 ASR Worker 消息和 iOS 原生桥目前未提供稳定前缀元数据。
- `packages/ui/src/composables/useTranscription.ts` 将临时行保存在独立的 `draftLine` ref，定稿行保存在 `lines`；临时行不参与归档或翻译。首次部分识别创建带稳定 `displayId` 的行，后续部分识别修改它；定稿通过 `Object.assign` 更新同一对象后放入 `lines`，再清空 `draftLine`。无部分识别的定稿也分配 `displayId`；译文仍按宿主段 ID 回填原行。停止录音等待宿主提交剩余文字后清除临时行，清屏同时清除临时行。
- `stablePartial` 经 `MainScreen.vue` 传入 `components/TranscriptList.vue`。只有它与当前全文前缀匹配时，UI 才将前缀深色展示，其余尾部稍浅色；不匹配时全段浅色。缺少元数据时保留 `undefined`，让 iOS/Web 兼容原有的整段深色外观，不将其伪装为已确认前缀。
- `TranscriptList.vue` 将已定稿行与临时行合成按时间正序的单一字幕流，并以 `displayId` 作为 Vue key；同一句从临时状态、定稿到翻译回填持续使用同一个 `article`。各行左对齐、同样式，原文字号为设置值加 7 像素，译文为设置值加 5 像素并在下方回填；不再分设临时框、最新定稿框和历史区，也不使用句子过渡动画或文本框内部滚动。
- `MainScreen.vue` 将识别语言与母语作为 `sourceLang` / `targetLang` 传入 `TranscriptList.vue`；定稿行在 `useTranscription.ts` 中保留段的 `lang`，显示时优先于识别语言设置。组件将 `zh` 标注为 `zh-Hans`，按 `:lang()` 为日语优先指定 Hiragino Sans、简体中文优先指定 PingFang SC；`auto` 不生成具体语言标注。译文标注当前仍使用母语设置，尚未逐行传入自动反向翻译的实际目标语种。
- 字幕排版由 `TranscriptList.vue` 的 scoped CSS 管理：正文列限制为约 36 个原文全角字宽，时间戳位于侧列；原文与译文均用常规字重、1.6 倍行高，译文下置并使用低饱和蓝。具体间距与移动端缩窄规则见[开始一次转写](product/experience.md#开始一次转写)。
- 字幕流统一滚动；更新前位于末尾时在原文/译文更新后跟随底部，用户上滚查看前文时不强制返回末尾。上述共享 UI 状态与排版不增加识别计时器、推理或切句步骤。

### 翻译

1. 宿主在定稿段到达时调用 `packages/core/src/translation/segment-translation.ts` 的共享编排。
2. 共享编排根据母语、识别语言和会话内最近外语决定跳过、字形归一化或发起翻译。
3. macOS API 翻译通过 `packages/core/src/translation/context.ts` 管理同语言对的有限原文上下文；会话与配置变化由主进程重置。宿主执行具体引擎：macOS 将 M2M-100/云端请求放在纯 Node 子进程，Web 用 Transformers.js Worker 或直接调云端，iOS 调 Apple Translation 或直接调云端。
4. macOS 主进程在发送翻译 IPC 前通过 `apps/macos/src/main/translation/request-queue.ts` 调度请求，负责并发、等待容量、排队过期及配置变更时的等待取消；具体限制与行级降级见[翻译规则](product/experience.md#翻译规则)。翻译子进程仍负责具体推理，ASR 定稿路径不等待翻译队列完成。
5. pending、成功或失败事件按段 ID 回到 UI 的原文行；翻译不阻塞后续识别。

### 设置、模型与归档

- `@rt/ui` 只持有表单和当前会话状态；设置、模型和归档持久化经 `AppBridge`。默认值、字段校验、归档摘要和排序在 `@rt/core` 复用，各宿主只选择文件、Preferences 或 IndexedDB 作为存储后端。
- 模型清单、大小、语言、平台可用性和有序下载源的单一事实源是 `packages/core/src/model-registry.ts`。各宿主将文件下载到本端模型目录或 Cache Storage，再由对应推理运行时离线装载。

## 测试与构建位置

- 根 `package.json` 的 `pnpm check` 运行 `@rt/core` 单元测试、macOS 评测语料导入器的纯逻辑测试，以及 macOS、Web、iOS 三端类型检查；它不下载语料或模型，也不执行耗时的识别精度门禁。
- `packages/core/src/**/*.test.ts` 覆盖设置、归档、模型源、转写管线、定稿漂移统计和翻译决策等共享逻辑。
- `apps/macos/test` 包含无 GUI 管线、CER 评测和翻译脚本；入口命令由 `apps/macos/package.json` 的 `test-pipeline`、`eval-cer` 和 `test-translate` 定义。`eval-cer` 同时报告产品管线 CER、整段离线 CER 和“实时最长结果到定稿”的 Final 漂移，并可用 `--max-cer`、`--max-drift` 将任一模型的加权结果设为失败门槛。日语快捷命令 `eval-cer-ja` 评测固定语言的完整语料，`eval-cer-ja:gate` 则以 SenseVoice 的产品管线 CER 不超过 20%、Final 漂移不超过 5% 为回归门禁。
- `apps/macos/scripts/fetch-fleurs-eval.mjs` 通过 `fetch-eval-fleurs` 从固定 revision 的 FLEURS `ja_jp` test split 确定性抽取 100 条 CC-BY-4.0 语料，生成 16 kHz 单声道 PCM WAV、参考文本、语言元数据和带署名及音频哈希的 manifest。源 Parquet 缓存在 `apps/macos/test-audio/cache`，用例写入 `apps/macos/test-audio/eval/fleurs-ja-test`；两处均被 Git 忽略，需要评测的环境自行生成。
- `apps/macos/test/classroom-replay.ts` 使用同一音频与识别模型，对照未合句和合句的原文段，并可将两组结果送至同一 OpenAI 兼容翻译端点；用于课堂音频回放验收。
- `apps/macos/test/semantic-boundary-replay.ts` 在相同 ASR 事件时序上对照规则合句与语义判断，固定 Hy-MT2 翻译及原文上下文。`local-boundary-judge.ts` 通过本机 LM Studio 的 `sentence-judge` 别名请求 `END` / `WAIT`，判断超时按规则回退。结果记录提示词、分组、配置及带时刻和触发原因的 `flushEvents`。
- 回放脚本末尾的 `original|small|compare` 参数选择原英文提示词、中文指令加日语示例提示词，或将两者与规则合句分组对照，默认是 `original`。`limit-audit` 在同一 ASR 时序、优化提示词和 Hy-MT2 配置下，对照原规则、保留 8 秒等待/10 秒音频硬上限的模型辅助、仅将规则上限延至 12 秒/14 秒，以及允许模型复核 8 秒/10 秒阈值的四组配置。
- `active-vs-rules` 将逐个已定稿 ASR 片段请求模型判断的 `reviewEverySegment` 实验与 `fast-rules` 对照。后者启用 `shortSentenceRule`：日语具有明确谓语结尾（如「です」「ます」）、至少 4 字且音频至少 1 秒时可提交，并将等待/音频上限设为 12 秒/14 秒。模型复核组同样保留 12 秒/14 秒最终边界；字数、语言、间隔和停止边界仍有效。`shortSentenceRule` 及 12 秒/14 秒上限现为合句器和 macOS 默认录音流程的规则配置；模型判断选项仍仅供离线实验，未接入应用界面或默认录音流程。回放实验会显式指定各组参数，继续保留原 8 秒/10 秒规则基线，避免默认值变化改写历史对照的含义。
- 根 `pnpm build` / `pnpm dist` 构建或打包 macOS；Web 和 iOS Web 资源分别由各自 `package.json` 的 `build` 脚本构建。iOS 原生工程位于 `apps/ios/ios/App`，注册表到 Swift 的生成入口是 `apps/ios/native-plugin/scripts/gen-asr-models-swift.mjs`。
- `pnpm --filter @rt/macos dist:preview` 构建独立的 `Realtime Translator Preview.app` 到 `apps/macos/release-preview/mac-arm64`；预览版使用 `realtime-translator-preview` 包名与 `io.github.baijunjie.realtimetranslator.classroompreview` 应用标识，配置和归档目录独立于正式版。命令只生成应用，不安装或覆盖已有版本。
- `.github/workflows/ci.yml` 在 PR、`main` 分支推送和手动触发时执行 core 单元测试、字幕身份与 macOS 翻译队列回归测试、三端类型检查，并校验 iOS 生成的模型清单未与注册表漂移。Pages 变更探测和部署均要求仓库变量 `ENABLE_PAGES=true`；未设置时仅执行质量门禁。启用后，门禁通过的 `main` 推送仅在 Web 相关变更时部署，手动触发则直接进入部署流程。
