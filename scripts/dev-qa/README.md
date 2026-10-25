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
- `main.pipeline:partial` / `main.pipeline:segment` / `main.pipeline:status` / `main.pipeline:translation`：主进程送往渲染层的事件；
- `renderer.ui:partial` / `renderer.ui:segment`：UI 实际接收的原文事件；
- `session.start` / `session.stop-request`：一次录音会话的边界。

快照中的 `transcription` 节包含有界字幕、临时行和录音状态，`viewport` 节包含当前跟随状态、阅读锚点、滚动量及可见原文。文本或历史超出边界时会显式标记省略或游标丢失，不能把不完整轨迹当成完整证据。

## 导出审计边界

`audit.mjs` 比较同一会话内 ASR 片段串联后的文字与合句结果，以及主进程定稿段与 UI 定稿段的 ID 和文本，并报告重复 UI ID、游标缺口、字段省略和会话是否正常停录。只有轨迹无缺口、无省略、恰有一次会话开始且出现停止状态时，跨阶段相等性才会给出布尔结论。

这些结论只证明已埋点阶段之间的文字守恒。它们不提供独立音频真值，不能判断语音是否被 ASR 漏识别，也不是准确率、CER、实时延迟或完整音频评分；要逐句确认“内容不漏不重复”，仍需将导出证据与视频、人工参考文本或其它独立真值对照。

## 模块接口清单

- `scripts/dev-qa/connection.mjs`：`defaultSocketPath()` 计算默认本地 socket；`readDev()` 仅转发 `identity`、`snapshot`、`events`。
- `scripts/dev-qa/server.mjs`：注册 `subline_identity`、`subline_snapshot`、`subline_events` 三个 MCP 工具。
- `scripts/dev-qa/client.mjs`：提供 `identity`、`snapshot`、`events`、`list` 和 `capture` 命令行入口。
- `scripts/dev-qa/audit.mjs`：导出 `auditTrace()`，并提供轨迹文件审计命令行入口。
- `apps/macos/src/main/dev-qa.ts`：导出 `devQaEnabled()`、`DevQaTrace`、`DevQaServer` 及对应事件和选项类型，负责启用判定、有界事件与本地只读服务。
- `packages/core/src/bridge.ts`：`DevQaBridge` 是仅在显式启用的开发宿主中出现的渲染层诊断桥。
- `packages/ui/src/devQa.ts`：`configureDevQa()`、`registerDevQaProvider()`、`traceDevQa()`、`boundedQaText()` 和 `transcriptQaSnapshot()` 提供有界 UI 事件与快照。
