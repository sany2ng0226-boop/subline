import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue';
import type { ArchiveSummary } from '@rt/core';
import { bridge } from '../bridge';

/** 归档删除的撤销窗口：确认后先从列表移除，窗口结束才真正调用 deleteArchive。 */
export const ARCHIVE_UNDO_MS = 8000;

interface PendingDelete {
  item: ArchiveSummary;
  index: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 稳定版与 Internal 版归档列表共用的删除流程：确认 → 列表先移除 → 8 秒内可撤销 → 延迟提交。
 * 离开归档页（作用域销毁）或页面隐藏 / 关闭时立即提交挂起的删除；提交失败则放回原位并置 failed。
 */
export function useArchiveDelete(
  items: Ref<ArchiveSummary[]>,
  options: { delayMs?: number; onRemoved?: (id: string) => void } = {},
) {
  const delayMs = options.delayMs ?? ARCHIVE_UNDO_MS;
  /** 等待确认的归档（确认框显示中） */
  const confirmTarget = ref<ArchiveSummary | null>(null);
  /** 已移除、尚可撤销的归档（撤销条显示中） */
  const pending = ref<ArchiveSummary | null>(null);
  const failed = ref(false);
  // 已移除但服务端尚未确认删除的 id：在途提交返回的列表里仍含它们，需要滤掉
  const hidden = new Set<string>();
  let current: PendingDelete | null = null;

  function request(item: ArchiveSummary): void {
    failed.value = false;
    confirmTarget.value = item;
  }

  function cancel(): void {
    confirmTarget.value = null;
  }

  function restore(item: ArchiveSummary, index: number): void {
    hidden.delete(item.id);
    if (items.value.some((it) => it.id === item.id)) return;
    const next = [...items.value];
    next.splice(Math.min(index, next.length), 0, item);
    items.value = next;
  }

  /** 立即提交挂起的删除（撤销窗口结束、关闭撤销条、离开页面时调用） */
  async function flush(): Promise<void> {
    if (!current) return;
    const { item, index, timer } = current;
    clearTimeout(timer);
    current = null;
    pending.value = null;
    try {
      const list = await bridge().deleteArchive(item.id);
      hidden.delete(item.id);
      items.value = list.filter((it) => !hidden.has(it.id));
    } catch (error) {
      console.error('[archive:delete]', error);
      restore(item, index);
      failed.value = true;
    }
  }

  function confirm(): void {
    const item = confirmTarget.value;
    confirmTarget.value = null;
    if (!item) return;
    // 撤销条只对应最近一次删除：上一条挂起的删除先提交
    void flush();
    failed.value = false;
    const index = items.value.findIndex((it) => it.id === item.id);
    if (index < 0) return;
    hidden.add(item.id);
    items.value = items.value.filter((it) => it.id !== item.id);
    current = { item, index, timer: setTimeout(() => void flush(), delayMs) };
    pending.value = item;
    options.onRemoved?.(item.id);
  }

  function undo(): void {
    if (!current) return;
    const { item, index, timer } = current;
    clearTimeout(timer);
    current = null;
    pending.value = null;
    restore(item, index);
  }

  if (getCurrentScope()) {
    const onPageHide = (): void => void flush();
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
    onScopeDispose(() => {
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      void flush();
    });
  }

  return { confirmTarget, pending, failed, request, cancel, confirm, undo, flush };
}
