# 模型配置（统一清单 + 源治理 + 多源 fallback + 能力门槛）

全项目「可用模型 / 下载地址 / 可用端」的单一事实源集中在 `packages/core`。三端（macOS Electron 主进程、web 两个 model-store、iOS 由脚本生成的 Swift）都从这里派生，任何一处硬编码 URL/文件名/目录都会与其它端漂移。

## 结构

- **`model-registry.ts` — 统一清单（唯一作者处）**：`MODELS: ModelEntry[]`，判别联合 `kind: 'asr' | 'translation'`。增删/迁移模型、调平台或能力门槛只改这里。
  - **红线：本模块必须是纯可序列化数据，不含任何函数值/运行时行为。** 翻译母语字形后处理降为字符串标签 `LangEntrySpec.script = 'zh-hans'`，由 `translation/local-spec.ts` 派生视图时挂回 `normalizeZh`。原因见「iOS 代码生成」。
- **`model-sources.ts` — 下载源治理（唯一）**：所有基址、固定 revision、资产 pin、release tag 和命名约定收敛于此。
  - active native 源保持上游 Hugging Face／上游 GitHub Release；Subline `models-v1` 发布并核对资产前，`SELF_HOSTED` 只作关闭的未来配置，不能设成默认源。
  - 有 pin 的 HF 文件必须同时使用 `HF_REVISIONS` 固定提交，使下载内容与 `SELF_HOSTED_PINS` 的字节数和 SHA-256 对应；自托管副本也必须是同一内容。
  - 没有 pin 的文件仍可下载，不能因为缺少 `expectedBytes`／`sha256` 而拒绝；新增模型默认归入这一类，待取得可信 pin 后再启用校验。
  - `HF {host}` + `HF_MIRRORS[]` + `hfResolveUrls(repo, rel, revision)`：上游 Hugging Face 主源 + 可选镜像，返回**有序 URL 列表**。换镜像/owner/tag 只改这一处。
  - `TRANSFORMERS_REMOTE_HOST`（`'https://huggingface.co/'`，**不可变**）：**只**供 web 翻译缓存键用，与可切换的下载源严格分离。若让它跟随镜像变，web 翻译离线加载 `cache.match` 会全部落空（Transformers.js 内部仍按默认 remoteHost 请求）。
- **派生视图**：`models.ts` 导出 `ASR_MODELS` 等（过滤 `kind==='asr'`）；`translation/local-spec.ts` 导出 `LOCAL_TRANSLATION_MODELS` 等（过滤 `kind==='translation'`，并把 `script` 标签挂回函数）。各端消费这两份视图，形状与历史一致。

## 按端分源 + 多源 fallback

每个文件在每一端是一个**有序 URL 列表**，下载器按序尝试、**每个源只试一次、全部失败才判失败**：
- `ModelFileSpec.nativeUrls`（macOS/iOS）：默认使用上游源；只有发布并核验 Subline `models-v1` 后，才可显式启用自托管优先。
- `ModelFileSpec.webUrls`（web）：HF 主源 + 镜像。浏览器 fetch 受 CORS 约束，故 web 只走发 CORS 头的上游源。
- web 的 Silero VAD 靠同源静态资源覆盖（`import.meta.env.BASE_URL`，构建期值），故该覆盖留在 web 层（`apps/web/src/asr/model-store.ts` 的 `resolveUrls`，置于列表首），不进 `@rt/core`。
- native 下载器对声明 pin 的文件在落地前核对字节数和 SHA-256；不符与停滞/HTTP 错误一样计为该源失败并尝试下一源。未声明 pin 的文件跳过完整性校验，但继续正常下载。
- 各端下载器把「单源尝试（含 .part/缓存清理 + 无进展看门狗）」封成内层，外层循环 fallback；聚合错误在全部源耗尽后才浮现。

## 细分端能力门槛（模型属性 × 宿主约束 分离）

iOS/iPadOS WebKit（移动 Safari）单标签页内存装不下「本地翻译大模型 + ASR」共存，会 OOM。故：
- 模型侧声明属性 `availability.memoryHeavy`（两款 M2M100 均 true）。
- 宿主侧报告约束：web 传 `memoryConstrained: isIOS()`，macOS/native 传 `false`。
- core 的 `availableTranslationModels(platform, {memoryConstrained})` / `localTranslationSupported(...)` 收口判定，`apps/web/src/bridge.ts` 三处（`applyPlatformConstraints` 引擎回落 / `localTranslationAvailable` / `listModels` 翻译组）共用，避免漂移。回落引擎前先判默认模型是否在可用集内，否则回落 `cloud`（防止把被门槛排除的默认模型又选回）。
- ASR 不带 `memoryHeavy`，永不受此门槛影响（iOS web 上 ASR 单独可用）。

## iOS 代码生成

Swift 运行时无法 import TS，`apps/ios/native-plugin/scripts/gen-asr-models-swift.mjs` 用 esbuild 打包**以 `models.ts` 为入口**的子图、动态 import 拿 `ASR_MODELS`，生成提交物 `AsrModels.swift`（`AsrModelFile.urls: [String]` 取 `nativeUrls`）。
- 正因入口是 `models.ts`，它**绝不能** import `translation/local-spec` 或任何带运行时行为的翻译模块（如 `chinese-conv`），否则会被 bundle 进 iOS 产物。生成器对此有护栏：命中 `chinese-conv` 直接报错。这也是「统一清单必须纯数据」这条红线的根因。
- 改完注册表须重跑 `pnpm --filter @rt/ios gen:models` 并提交；CI 有 `gen:models --check` 兜底漂移。
