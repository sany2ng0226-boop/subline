import { computed, reactive, ref } from 'vue';
import type { PipelineErrorCode, TranslationStatusPayload } from '@rt/core';
import { fmtClock } from '../utils/datetime';
import { pipelineErrorCode } from '../utils/micPermission';
import { bridge } from '../bridge';

export interface TranscriptLine {
  /** Stable view identity survives provisional text becoming a finalized segment. */
  displayId: number;
  lang?: string;
  id: number;
  time: string;
  text: string;
  translation: string;
  /** 译文进行中：已派发翻译、结果未到，UI 在译文区显示等待动画。同语言/未开启翻译时恒 false */
  translating: boolean;
  translationPartial?: boolean;
  /** 该行翻译失败：在译文区显示失败标记（failedDetail 为宿主原始错误，供悬停提示） */
  failed: boolean;
  failedDetail?: string;
}

export const lines = reactive<TranscriptLine[]>([]);
export const partial = ref('');
export const stablePartial = ref<string>();
export const draftLine = ref<TranscriptLine | null>(null);
let nextDisplayId = 0;
function makeDraft(text: string): TranscriptLine {
  return { displayId: ++nextDisplayId, id: -1, time: fmtClock(Date.now()), text, translation: '', translating: false, failed: false };
}
export const recording = ref(false);

// 软件未就绪：加载 ASR 模型中（录音管线就绪前）
export const modelLoading = ref(false);
// 录音/管线错误：原始文案（宿主自由文本，可能非界面语言）+ 稳定错误码（有码时 UI 按码取本地化文案）
export const errorText = ref('');
export const errorCode = ref<PipelineErrorCode | null>(null);

// 翻译引擎装载状态（独立，显示在顶栏，不影响录音）。下载进度不在此，走 onSetupProgress（下载弹窗消费）。
export const translationLoading = ref(false);
export const translationError = ref(false);
export const translationErrorDetail = ref('');
export const translationBackend = ref<TranslationStatusPayload['backend']>();
export const translationNotice = ref('');

// 录音开始时的本地时刻（epoch ms），用于把片段的相对偏移换算成本地时钟时间
let recordStartEpoch = 0;

// 录音开关在途状态：start/stop 尚未 await 完成时为真——既作并发守卫（忽略新的切换请求，
// 消除 stop 进行中被并发 start 拆掉音频通路的窗口期），也供 UI 禁用录音按钮并显示加载态
// （启动含取麦克风等待，可达数秒，无反馈会让用户以为没点上而连点）。
export const recordBusy = ref(false);

// 把片段相对录音起点的偏移（秒）换算成本地时钟时间 HH:MM:SS
function fmtTime(offsetSeconds: number): string {
  return fmtClock(recordStartEpoch + offsetSeconds * 1000);
}

// 应用生命周期级监听：只注册一次即可（bridge on* 支持反注册，但这些订阅与应用同寿，无需退订）。
// 由 mountApp 在 setBridge 之后调用 registerTranscriptionListeners()，
// 不再在模块导入时注册——此时 bridge 尚未注入。
let registered = false;
export function registerTranscriptionListeners(): void {
  if (registered) return;
  registered = true;

  bridge().onSegment((seg) => {
    const line = draftLine.value ?? makeDraft(seg.text);
    Object.assign(line, {
      id: seg.id, time: fmtTime(seg.start), text: seg.text, lang: seg.lang,
      translation: '', translating: false, failed: false,
    });
    lines.push(line);
    draftLine.value = null;
    partial.value = '';
    stablePartial.value = undefined;
  });
  bridge().onPartial((p) => {
    partial.value = p.text;
    stablePartial.value = p.stableText;
    if (p.text) {
      if (!draftLine.value) draftLine.value = makeDraft(p.text);
      else draftLine.value.text = p.text;
    } else draftLine.value = null;
  });
  bridge().onTranslation((tr) => {
    // 撤销窗口内被删除的行仍接收译文，撤销恢复后不会卡在「翻译中」。
    const line = lines.find((l) => l.id === tr.id) ?? clearedLines.find((l) => l.id === tr.id);
    if (!line) return;
    if (tr.partial) {
      line.translation = tr.text;
      line.translationPartial = true;
      line.translating = true;
      line.failed = false;
    } else if (tr.pending) {
      // 翻译已开始、结果未到：显示等待动画
      line.translating = true;
      line.failed = false;
    } else if (tr.failed) {
      // 该行翻译失败：结束等待动画、行内显示失败标记（不进全局引擎状态）
      line.translating = false;
      if (line.translationPartial) line.translation = '';
      line.translationPartial = false;
      line.failed = true;
      line.failedDetail = tr.error;
    } else {
      // 最终结果（空串表示无需翻译，仅结束等待、不展示）
      line.translation = tr.text;
      line.translationPartial = false;
      line.translating = false;
      line.failed = false;
    }
  });
  bridge().onStatus((s) => {
    if (s.state === 'loading') {
      modelLoading.value = true;
    } else if (s.state === 'running') {
      modelLoading.value = false;
      errorText.value = '';
      errorCode.value = null;
    } else if (s.state === 'error') {
      modelLoading.value = false;
      errorText.value = s.error ?? 'Error';
      errorCode.value = pipelineErrorCode(s.code, s.error);
      // 经守卫收停：stopPipeline 在途期间用户点录音会被 recordBusy 挡住，避免 start/stop 交错
      if (recording.value) {
        recordBusy.value = true;
        toggling = stopRecording().catch(() => {}).finally(() => {
          recordBusy.value = false;
        });
      }
    } else if (s.state === 'stopped') {
      modelLoading.value = false;
      // 管线可能在宿主侧结束（如 iOS 来电/拔耳机等系统音频中断），同步 UI 回到停止态；
      // 用户主动停止时 recording 已为 false，重复赋值无副作用。
      recording.value = false;
    }
  });
  bridge().onTranslationStatus((s) => {
    translationBackend.value = s.backend;
    translationNotice.value = s.notice ?? '';
    translationErrorDetail.value = s.error ?? '';
    if (s.state === 'loading') {
      // 装载模型入内存（无字节进度；下载进度另经 onSetupProgress 上报给下载弹窗）。
      translationLoading.value = true;
      translationError.value = false;
    } else if (s.state === 'error') {
      translationLoading.value = false;
      translationError.value = true;
      // 翻译失败（含子进程崩溃）：结束所有仍在等待的译文动画，避免永久转圈
      for (const l of [...lines, ...clearedLines]) {
        l.translating = false;
        if (l.translationPartial) { l.translation = ''; l.translationPartial = false; l.failed = true; }
      }
    } else if (s.state === 'ready') {
      translationLoading.value = false;
      translationError.value = false; // 引擎恢复就绪，清除全局失败提示
    }
  });
}

export async function startRecording(): Promise<void> {
  dismissUndo(); // 新会话开始后不再允许把旧内容撤销回来，避免新旧行交错
  errorText.value = '';
  errorCode.value = null;
  // 桥接内部负责音频采集（macOS 渲染层用 AudioWorklet，iOS 原生采麦），UI 不感知平台细节。
  const result = await bridge().startPipeline();
  if (!result.ok) {
    errorText.value = result.error ?? 'Error';
    errorCode.value = pipelineErrorCode(result.code, result.error);
    return;
  }
  // 计时基线在管线确认启动后才取：segment.start 的 0 点是管线启动之后，
  // 首次录音需加载模型耗时数秒，若在 await 前取值会让所有行的时钟偏早整个加载时长。
  recordStartEpoch = Date.now();
  lastStopFailure = null;
  recording.value = true;
}

let lastStopFailure: Error | null = null;

export async function stopRecording(): Promise<void> {
  recording.value = false;
  try {
    await bridge().stopPipeline();
    lastStopFailure = null;
  } catch (error) {
    lastStopFailure = error instanceof Error ? error : new Error(String(error));
    errorText.value = lastStopFailure.message;
    errorCode.value = pipelineErrorCode(undefined, lastStopFailure.message);
    throw lastStopFailure;
  }
  partial.value = '';
  stablePartial.value = undefined;
  draftLine.value = null;
}

let toggling: Promise<void> = Promise.resolve();
export function toggleRecording(): void {
  // 上一次切换（含 onStatus error 分支触发的收停）尚在途时忽略本次点击，避免 start/stop 交错并发。
  if (recordBusy.value) return;
  recordBusy.value = true;
  const action = recording.value ? stopRecording() : startRecording();
  toggling = action.catch((error) => {
    errorText.value = error instanceof Error ? error.message : String(error);
    errorCode.value = pipelineErrorCode(undefined, errorText.value);
  }).finally(() => {
    recordBusy.value = false;
  });
}

/** 等在途的启停结束；仍在录音则停止并等到收尾完成（关闭前归档用） */
export async function ensureStopped(): Promise<void> {
  await toggling;
  if (lastStopFailure) throw lastStopFailure;
  if (!recording.value) return;
  toggleRecording();
  await toggling;
  if (lastStopFailure) throw lastStopFailure;
}

// 未归档：正在录音，或主页仍有定稿行（归档成功会清空主页，所以剩下的行都是上次归档后新增的）。
export const hasUnsavedContent = computed(() => recording.value || recordBusy.value || lines.length > 0);

/** 清空转写历史（归档成功后调用；不可撤销） */
export function clearTranscript(): void {
  dismissUndo();
  lines.splice(0, lines.length);
  resetDraft();
}

// 主页「删除」可撤销：被删的行暂存在内存里，直到撤销、开始新录音或再次清空。
let clearedLines: TranscriptLine[] = [];
export const canUndoDelete = ref(false);

// 最近一次归档成功的时刻：主页清空后顶栏显示「已归档 · HH:mm」；删除内容后不再沿用旧时刻。
export const lastArchivedAt = ref<number | null>(null);

/** 删除主页内容，但保留一次撤销机会 */
export function deleteTranscript(): void {
  lastArchivedAt.value = null;
  clearedLines = lines.splice(0, lines.length);
  resetDraft();
  canUndoDelete.value = clearedLines.length > 0;
}

/** 撤销最近一次删除 */
export function undoDelete(): void {
  if (!canUndoDelete.value || lines.length) return;
  lines.push(...clearedLines);
  dismissUndo();
}

export function dismissUndo(): void {
  clearedLines = [];
  canUndoDelete.value = false;
}

function resetDraft(): void {
  partial.value = '';
  stablePartial.value = undefined;
  draftLine.value = null;
}

/** A provisional stream must never be persisted as a completed translation. */
export function archiveSnapshot() {
  return lines.map(line => ({ time: line.time, text: line.text,
    translation: line.translationPartial ? '' : line.translation }));
}

/** 崩溃暂存用的快照：在归档快照基础上保留每行语言 */
export function recoverySnapshot(): RecoveredLine[] {
  return lines.map((line) => ({ time: line.time, text: line.text,
    translation: line.translationPartial ? '' : line.translation,
    ...(line.lang ? { lang: line.lang } : {}) }));
}

export interface RecoveredLine { time: string; text: string; translation: string; lang?: string }

// 恢复行用负 id：新会话的 segment id 从头计数，不能让迟到的译文串到旧行上
let nextRecoveredId = -2;

/** 把上次未归档的行恢复到当前内容之前 */
export function restoreLines(saved: RecoveredLine[]): void {
  lastArchivedAt.value = null;
  lines.unshift(...saved.map((line): TranscriptLine => ({
    displayId: ++nextDisplayId, id: nextRecoveredId--, time: line.time, text: line.text,
    translation: line.translation, translating: false, failed: false,
    ...(line.lang ? { lang: line.lang } : {}),
  })));
}

/** 当前录音的开始时刻（epoch ms）；尚未录音时为 0 */
export function recordingStartedAt(): number {
  return recordStartEpoch;
}
