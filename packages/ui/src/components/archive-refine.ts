// 一条归档的录后任务运行状态（本地重新转写与 Codex 校对共用；宿主保证全应用同一时间只跑一个）：
// 只认本归档的进度事件，失败/取消不改动现有内容，可用同一组选项重试。
// 订阅随调用方的 effect scope（组件卸载）一起释放。
import { computed, onScopeDispose, ref } from 'vue';
import type { AppBridge, ArchiveProofreadOptions, ArchiveRecord, ArchiveRefineOptions, ArchiveRefineProgress } from '@rt/core';
import { isProofreadOptions } from './archive-review';

export type RefinePhase = 'idle' | 'transcribing' | 'translating' | 'proofreading' | 'saving' | 'done' | 'cancelled' | 'error';
export type RefineTask = ArchiveRefineOptions | ArchiveProofreadOptions;

const ACTIVE = new Set<RefinePhase>(['transcribing', 'translating', 'proofreading', 'saving']);

export function useArchiveRefine(
  host: Pick<AppBridge, 'refineArchive' | 'proofreadArchive' | 'cancelArchiveRefinement' | 'onArchiveRefineProgress' | 'getArchive'>,
  archiveId: () => string,
  onRecord: (record: ArchiveRecord) => void,
) {
  const phase = ref<RefinePhase>('idle');
  const completed = ref(0);
  const total = ref(0);
  const error = ref('');
  const cancelling = ref(false);
  const lastOptions = ref<RefineTask | null>(null);
  /** 当前/最近一次任务的类型：决定进度与失败文案（Codex 重试意味着再次发送文字）。 */
  const kind = ref<'local' | 'codex'>('local');
  let runId = 0;
  let ownRun = false;
  let disposed = false;
  let cancelledEvent = false;

  const running = computed(() => ACTIVE.has(phase.value));
  // 写盘阶段不可取消：此时结果正在落地，取消无法保证原样。
  const canCancel = computed(() => running.value && phase.value !== 'saving' && !cancelling.value && !!host.cancelArchiveRefinement);
  const percent = computed(() => total.value > 0 ? Math.min(100, Math.round((completed.value / total.value) * 100)) : 0);

  const off = host.onArchiveRefineProgress?.((p: ArchiveRefineProgress) => {
    if (disposed || p.archiveId !== archiveId()) return;
    if (ACTIVE.has(p.state)) {
      if (p.state === 'proofreading') kind.value = 'codex';
      else if (!ownRun && p.state === 'transcribing') kind.value = 'local';
      phase.value = p.state;
      completed.value = p.completed;
      total.value = p.total;
      return;
    }
    // 结束态以本页发起的 Promise 为准；本页只是旁观（如重新打开详情）时才从事件收尾。
    if (ownRun) { if (p.state === 'cancelled') cancelledEvent = true; return; }
    if (p.state === 'error') { phase.value = 'error'; error.value = p.error ?? ''; }
    else if (p.state === 'cancelled') phase.value = 'cancelled';
    else if (p.state === 'done') {
      phase.value = 'done';
      void host.getArchive(archiveId()).then((r) => { if (!disposed && r) onRecord(r); }).catch(() => undefined);
    }
  });
  onScopeDispose(() => { disposed = true; off?.(); });

  async function start(options: RefineTask): Promise<void> {
    const codex = isProofreadOptions(options);
    const run = codex ? host.proofreadArchive : host.refineArchive;
    if (!run || running.value) return;
    const current = ++runId;
    ownRun = true;
    lastOptions.value = options;
    kind.value = codex ? 'codex' : 'local';
    phase.value = codex ? 'proofreading' : 'transcribing';
    completed.value = 0;
    total.value = 0;
    error.value = '';
    cancelling.value = false;
    cancelledEvent = false;
    try {
      const record = codex
        ? await host.proofreadArchive!(archiveId(), options)
        : await host.refineArchive!(archiveId(), options as ArchiveRefineOptions);
      if (disposed || current !== runId) return;
      phase.value = 'done';
      onRecord(record);
    } catch (cause) {
      if (disposed || current !== runId) return;
      if (cancelling.value || cancelledEvent) phase.value = 'cancelled';
      else {
        phase.value = 'error';
        error.value = cause instanceof Error ? cause.message : String(cause ?? '');
      }
    } finally {
      if (current === runId) { ownRun = false; cancelling.value = false; }
    }
  }

  async function cancel(): Promise<void> {
    if (!canCancel.value) return;
    cancelling.value = true;
    try { await host.cancelArchiveRefinement!(archiveId()); }
    catch { cancelling.value = false; }
  }

  function retry(): Promise<void> {
    return lastOptions.value ? start(lastOptions.value) : Promise.resolve();
  }

  function dismiss(): void {
    if (!running.value) { phase.value = 'idle'; error.value = ''; }
  }

  return { phase, completed, total, percent, error, running, canCancel, cancelling, lastOptions, kind, start, cancel, retry, dismiss };
}
