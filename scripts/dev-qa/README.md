# Subline Dev QA

## 功能概述

该模块为本地 Electron 开发版提供只读诊断入口，供 UI 实测时先确认目标进程，再观察音频输入摘要、识别阶段、主进程上屏事件以及渲染层字幕与滚动状态。它只在未打包应用显式设置 `SUBLINE_DEV_QA=1` 时启用；普通 `pnpm dev` 和所有打包应用不开放该入口。

诊断连接使用当前用户临时目录下的 Unix domain socket。默认父目录权限为 `0700`、socket 权限为 `0600`，不监听 TCP；默认路径可由 `SUBLINE_DEV_QA_SOCKET` 覆盖，但仍要求绝对路径、父目录由当前用户拥有且权限为 `0700`，并拒绝覆盖已有路径。

## 命令入口

| 命令 | 作用 |
| --- | --- |
| `pnpm qa:dev` | 以诊断开关和默认 socket 路径启动实际 Subline Dev；这是唯一会启动应用的 QA 命令。 |
| `pnpm qa:mcp` | 启动基于官方 MCP SDK 的 stdio 服务；服务本身不启动应用。 |
| `pnpm qa:read identity` | 读取已选择 Dev 实例的进程、可执行文件、应用路径、工作目录、版本、Git revision 和打包状态。 |
| `pnpm qa:read snapshot` | 读取当前录音、识别与有限设置状态，并请求新鲜的渲染层字幕和视口快照。 |
| `pnpm qa:read events [after] [limit]` | 从序列游标之后读取有界事件；单次 `limit` 为 1–1000。 |
| `pnpm qa:read list` | 列出 MCP 工具及只读标记。 |
| `pnpm qa:read capture <seconds> <absolute-output-directory>` | 每秒采集事件与快照，时长为 1–600 秒；在指定绝对目录中新建权限 `0600` 的 `trace.jsonl`，若文件已存在则失败而不覆盖。 |
| `node scripts/dev-qa/audit.mjs <trace.jsonl> [phrase]` | 按会话审计已导出的轨迹；可选短语会列出其在各阶段的出现位置。 |
| `pnpm qa:test` | 运行 socket、MCP、导出审计及拒绝写操作的模块测试。 |

`capture` 会把实时字幕写入指定目录，属于显式的证据导出；其余字幕事件只保存在进程内的有界缓冲区中。该模块不保存 PCM 音频。

## MCP 对外接口

| 工具 | 返回内容 |
| --- | --- |
| `subline_identity` | 精确 Dev 实例身份与 socket 路径。它不查找或启动其它 Electron 应用。 |
| `subline_snapshot` | 主进程状态与渲染层快照。使用方必须检查 `renderer.available`、`renderer.stale`、`renderer.ageMs` 和 `renderer.error` 后再下结论。 |
| `subline_events` | `after` 游标后的诊断事件及 `oldestSeq`、`latestSeq`、`nextSeq`、`dropped`、`hasMore` 完整性字段。 |

三个工具均声明为只读、非破坏、幂等且不访问开放网络；它们不能开始或停止录音、修改设置、清空字幕、操作归档或代替界面操作。

主要事件层级为：

- `audio.input`：16 kHz 输入的块数、样本数、RMS、峰值及非有限值计数，不含 PCM；
- `asr.raw-result` / `asr.raw-partial` / `asr.asr-fragment` / `asr.sentence`：模型结果、临时结果、管线片段和合句结果；
- `asr.sentence-flush`：macOS 合句器每次定稿时的 `reason`、`text`、`start` 和 `duration`，用于区分标点、短句、等待上限、音频上限、间隔、语言切换或停录等现有定稿原因；该事件只观测分句结果，不改变合句决策；
- `asr.context-trim`：一致前缀模式实际携带逻辑边界前的解码上下文时产生，以会话相对秒记录 `contextStart`、`windowStart` 和 `to`，并提供原始 `rawText`、排除边界前内容后的 `text` 及 `removedText`。`mode` 为 `timestamps` 时按 token 时间归属，`retained-anchor` 表示在边界附近用已保留文字锚定切点，`already-retained` 表示原始结果已从保留内容开始因而不裁剪，`direct-retry` 表示无法可靠对齐时只重解逻辑区间；
- `asr.final-choice`：一致前缀模式定稿时选择尚未提交尾部后产生，记录窗口内已确认文字、此前幸存候选、本次尾部解码、最终选择及是否覆盖完整音频。`reason` 为 `latest` 时采用本次读法，`empty-fallback` 或 `truncated-fallback` 时分别表示空结果或未覆盖完整音频的明显坍缩触发旧候选保底；该事件只观测现有定稿选择，不新增解码或等待；
- `asr.stall-checkpoint` / `asr.stall-fallback` / `asr.ordinary-slide`：只有管线实际执行对应的停滞检查点、停滞降级或普通窗口滑动分支时才产生。三者均以会话相对秒记录 `windowStart`、`to`、`nextWindowStart`，并附带 `committedPrefix`、`currentText` 和 `savedText`；降级事件另有 `reason`，普通滑动另有切点和保留文本字段。检查点的 `mode` 区分保留已对齐尾部的 `retained-overlap` 和只保存最新全窗读法一次的 `full-window`；前者另有 `retainedText`，两者可记录 `trigger` 与 `prefixCompatible`；
- `main.pipeline:partial` / `main.pipeline:segment` / `main.pipeline:status` / `main.pipeline:translation`：主进程送往渲染层的事件；
- `renderer.ui:partial` / `renderer.ui:segment`：UI 实际接收的原文事件；
- `session.start` / `session.stop-request`：一次录音会话的边界。

快照中的 `transcription` 节包含有界字幕、临时行和录音状态，`viewport` 节包含当前跟随状态、阅读锚点、滚动量及可见原文。文本或历史超出边界时会显式标记省略或游标丢失，不能把不完整轨迹当成完整证据。

## 导出审计边界

`audit.mjs` 比较同一会话内 ASR 片段串联后的文字与合句结果，以及主进程定稿段与 UI 定稿段的 ID 和文本，并报告重复 UI ID、游标缺口、字段省略和会话是否正常停录。只有轨迹无缺口、无省略、恰有一次会话开始且出现停止状态时，跨阶段相等性才会给出布尔结论。

审计结果中的 `checkpointCount` 和 `checkpoints` 列出实际捕获的停滞检查点；每个检查点的 `savedTextInFragments` 与 `savedTextInUi` 分别统计 `savedText` 在拼接后的 ASR 片段和 UI 定稿原文中出现的次数，比较前会做 NFKC 归一化并移除空白。`retained-overlap` 检查点的 `savedText` 只是已跨过最终提交边界的前缀，`retainedText` 仍属于后续窗口，不能仅凭当个检查点的出现次数判定它丢失或重复；`full-window` 的 `savedText` 才是该次最新全窗读法。轨迹不完整时这两个次数为 `null`。`ordinarySlides` 与 `stallFallbacks` 只统计对应事件数量。计数为零只能说明这份完整轨迹里没有捕获该分支；在未满足触发条件、游标丢失、字段省略或会话未正常停止时，不能据此判定分支不可达或实现失效。

`audit.mjs` 尚不将 `asr.context-trim` 或 `asr.final-choice` 汇总为正确性判定。`removedText` 只表示本次根据音频边界排除的解码上下文；`already-retained` 的空 `removedText` 与 `direct-retry` 的二次解码都不是单独的丢失或重复证据。逻辑区间为空时不执行上下文解码，因此也不产生该事件。`final-choice` 的 `reason` 只说明当次选择路径；即使采用最新读法或触发保底，也不能脱离音频真值判断文字是否正确。

这些结论只证明已埋点阶段之间的文字守恒。它们不提供独立音频真值，不能判断语音是否被 ASR 漏识别，也不是准确率、CER、实时延迟或完整音频评分；要逐句确认“内容不漏不重复”，仍需将导出证据与视频、人工参考文本或其它独立真值对照。

## 模块接口清单

- `scripts/dev-qa/connection.mjs`：`defaultSocketPath()` 计算默认本地 socket；`readDev()` 仅转发 `identity`、`snapshot`、`events`。
- `scripts/dev-qa/server.mjs`：注册 `subline_identity`、`subline_snapshot`、`subline_events` 三个 MCP 工具。
- `scripts/dev-qa/client.mjs`：提供 `identity`、`snapshot`、`events`、`list` 和 `capture` 命令行入口。
- `scripts/dev-qa/audit.mjs`：导出 `auditTrace()`，并提供轨迹文件审计命令行入口。
- `apps/macos/src/main/dev-qa.ts`：导出 `devQaEnabled()`、`DevQaTrace`、`DevQaServer` 及对应事件和选项类型，负责启用判定、有界事件与本地只读服务。
- `packages/core/src/asr/transcription-pipeline.ts`：`PipelineWindowDiagnostic` 定义可选的窗口分支事件；未配置诊断回调时不改变转写路径。
- `packages/core/src/bridge.ts`：`DevQaBridge` 是仅在显式启用的开发宿主中出现的渲染层诊断桥。
- `packages/ui/src/devQa.ts`：`configureDevQa()`、`registerDevQaProvider()`、`traceDevQa()`、`boundedQaText()` 和 `transcriptQaSnapshot()` 提供有界 UI 事件与快照。
