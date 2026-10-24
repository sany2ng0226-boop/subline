// 一条归档的录后转写运行状态：只认本归档的进度事件，失败/取消不改动现有内容，可用同一组选项重试。
// 订阅随调用方的 effect scope（组件卸载）一起释放。
import { computed, onScopeDispose, ref } from 'vue';
import type { AppBridge, ArchiveRecord, ArchiveRefineOptions, ArchiveRefineProgress } from '@rt/core';

export type RefinePhase = 'idle' | 'transcribing' | 'translating' | 'saving' | 'done' | 'cancelled' | 'error';

export function useArchiveRefine(
  host: Pick<AppBridge, 'refineArchive' | 'cancelArchiveRefinement' | 'onArchiveRefineProgress' | 'getArchive'>,
  archiveId: () => string,
  onRecord: (record: ArchiveRecord) => void,
) {
  const phase = ref<RefinePhase>('idle');
  const completed = ref(0);
  const total = ref(0);
  const error = ref('');
  const cancelling = ref(false);
  const lastOptions = ref<ArchiveRefineOptions | null>(null);
  let runId = 0;
  let ownRun = false;
  let disposed = false;
  let cancelledEvent = false;

  const running = computed(() => phase.value === 'transcribing' || phase.value === 'translating' || phase.value === 'saving');
  // 写盘阶段不可取消：此时结果正在落地，取消无法保证原样。
  const canCancel = computed(() => running.value && phase.value !== 'saving' && !cancelling.value && !!host.cancelArchiveRefinement);
  const percent = computed(() => total.value > 0 ? Math.min(100, Math.round((completed.value / total.value) * 100)) : 0);

  const off = host.onArchiveRefineProgress?.((p: ArchiveRefineProgress) => {
    if (disposed || p.archiveId !== archiveId()) return;
    if (p.state === 'transcribing' || p.state === 'translating' || p.state === 'saving') {
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

  async function start(options: ArchiveRefineOptions): Promise<void> {
    if (!host.refineArchive || running.value) return;
    const current = ++runId;
    ownRun = true;
    lastOptions.value = options;
    phase.value = 'transcribing';
    completed.value = 0;
    total.value = 0;
    error.value = '';
    cancelling.value = false;
    cancelledEvent = false;
    try {
      const record = await host.refineArchive(archiveId(), options);
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

  return { phase, completed, total, percent, error, running, canCancel, cancelling, lastOptions, start, cancel, retry, dismiss };
}
