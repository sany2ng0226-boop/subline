# macOS 无 GUI 评测

本目录提供脱离 Electron 界面的管线、识别精度、切句与翻译回放。它们不会操作应用录音按钮或 OBS。阶段延迟评测直接读取音频文件，按真实时间投递 PCM，不向系统音源播放声音。

## 命令入口

- `test-pipeline`：运行无 GUI 识别管线。
- `eval-cer`：比较产品管线与整段离线识别，并计算 CER 和定稿漂移。
- `test-translate`：运行翻译模型测试。
- `test-stage-latency`：对固定课堂样本运行阶段延迟评测。

命令均通过 `pnpm --filter @rt/macos <命令>` 从工作区根目录调用。

## 固定课堂阶段延迟评测

```sh
pnpm --filter @rt/macos test-stage-latency \
  /absolute/path/classroom-104.wav \
  /absolute/path/models \
  /absolute/path/apps/macos/test/fixtures/classroom-104.json \
  /absolute/path/apps/macos/test-results/classroom-104.json
```

音频须为固定样本对应的 16 kHz 单声道 WAV；参数采用绝对路径，避免工作区过滤命令改变相对路径的含义。仓库只保存含音频 SHA-256、12 个定稿段文本哈希及音频起止信息的 manifest，不保存课堂音频或其原文。音频哈希不匹配时拒绝运行；定稿段数量、文本哈希、语种或起止与基线不匹配时评测失败。这个检查验证固定输入的回归一致性，不能作为识别准确率证明。

运行前须在模型目录准备 SenseVoice 及其 VAD 文件。设置 `RT_LOCAL_CACHE=/absolute/path/model-cache` 可直接使用应用内 `HyTranslator`，该缓存根目录须包含注册表所定义的 Hy-MT2 GGUF 文件；不需要 LM Studio 或 HTTP 服务。未设置此变量时，须在本机 OpenAI 兼容服务加载别名 `hy-mt2-7b`。默认端点为 `http://127.0.0.1:1234/v1`，可通过 `RT_TRANSLATION_BASE_URL`、`RT_TRANSLATION_API_KEY` 指定其他本机端点与凭据；评测拒绝非回环地址。它使用固定日语识别、默认规则合句和产品的 `TranslationRequestQueue`，不读取或修改应用设置。ASR 在独立子进程运行，翻译先执行一次预热请求。

默认启用本机 Hy-MT2 7B 的流式回调；使用 `RT_TRANSLATION_STREAM=0` 运行同一命令可测完整响应路径。`firstTranslationMs` 记录首批译文在回放时间轴上的时刻，完整返回仍以 `completedMs` 记录；降低首批等待不代表完整生成更快。

输出 JSON 包含逐句时刻、事件、统计分布、音频与相关代码哈希、模型标识、预热耗时和回放投递迟到量。评测输出仅记录配置标识，不记录权重文件哈希；使用 API 时服务别名不变不能证明权重未更换。应用内下载器对注册表中的 Hy-MT2 文件执行校验，不等于评测输出包含该校验的证据。结果包含识别原文与译文，建议放在已被 Git 忽略的 `apps/macos/test-results/`，按私有课堂资料保管，不提交到仓库。各指标使用同一回放时间轴：

| 指标 | 边界与解释 |
| --- | --- |
| `recognitionCommitMs` | 最后一个组成该句的原始识别片段发出时刻，减该句逻辑音频末端；包含 VAD、识别计算与内部提交等待，不是纯模型耗时。 |
| `decodeMs` | 单次原生解码调用的计算耗时，单独汇总；不可再加到识别提交耗时上。 |
| `assemblyWaitMs` | 合句定稿时刻减最后一个组成片段的发出时刻，即识别提交后的额外等待。 |
| `assemblyResidenceMs` | 合句定稿时刻减首个组成片段的发出时刻，用于观察整个合句驻留，不能作为额外阶段相加。 |
| `dispatchMs` | 父进程将句子入翻译队列的时刻减 ASR 子进程定稿时刻。 |
| `queueWaitMs` | 开始执行翻译减进入队列时刻。 |
| `translationFirstContentMs` | 开始执行翻译至首批非空译文回调的耗时；非流式路径使用完整返回时刻。 |
| `firstVisibleEndToEndMs` | 首批译文回调时刻减逻辑音频末端；名称中的 visible 指交付调用方，不包含 UI 渲染或实际显示时刻。 |
| `translationMs` | 完整翻译调用耗时；API 路径包含本机服务端调度、生成和响应，`RT_LOCAL_CACHE` 路径包含应用内推理，不是纯 GPU 计算。 |
| `endToEndMs` | 完整译文返回时刻减逻辑音频末端；不包含真实设备采集、设备缓冲或 UI 渲染。 |

识别提交、额外合句等待、分发、排队和翻译五项之和应等于端到端延迟，脚本对此做一致性检查。统计给出均值、nearest-rank p50/p95 和最大值；12 句样本的 p95 不足以代表长期课堂表现。预热与初始化单独报告，不计入逐句统计。录屏与正在运行的翻译应用仍会共享硬件资源，因此测量反映本次机器负载，不能直接解释为隔离环境的模型性能。

## 固定文本翻译传输对照

```sh
pnpm --filter @rt/macos exec node scripts/build-test.mjs test/translation-transport-replay.ts
pnpm --filter @rt/macos exec node dist-test/test/translation-transport-replay.js \
  /absolute/path/stage-result.json \
  /absolute/path/apps/macos/test/fixtures/classroom-104.json \
  /absolute/path/apps/macos/test-results/translation-transport.json
```

此测试读取阶段延迟评测产生的 12 句原文，校验音频哈希、段数及逐段文本哈希，然后在相同提示词、两段原文上下文、温度和本机 `hy-mt2-7b` 模型上，按完整响应、流式、流式、完整响应的 ABBA 顺序串行请求。每轮先预热，分别统计首批与完整返回延迟；不重跑 ASR、不播放声音、不操作录屏。

结果严格比较四轮每句的最终译文是否逐字一致，并检查流式部分结果是否为最终输出的单调增长前缀；任一检查不通过即失败。它用于隔离传输与展示时机的变化，不证明翻译本身正确，也不包含识别、合句、排队或界面渲染时间。输出包含课堂原文和译文，与阶段延迟结果一样按私有资料保管，不提交。
