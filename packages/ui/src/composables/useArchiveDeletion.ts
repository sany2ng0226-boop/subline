import { onBeforeUnmount, type Ref } from 'vue';
import type { ArchiveSummary } from '@rt/core';
import { bridge } from '../bridge';
import { useDeferredAction } from './useDeferredAction';

export function useArchiveDeletion(items: Ref<ArchiveSummary[]>, error: Ref<string>, t: (key: string) => string) {
  // Keep successful IDs too: an older metadata response can arrive after deletion.
  const hidden = new Set<string>();
  const actions = useDeferredAction<ArchiveSummary>(
    async (item) => { await bridge().deleteArchive(item.id); },
    (item) => {
      hidden.delete(item.id);
      if (!items.value.some((entry) => entry.id === item.id)) {
        items.value = [...items.value, item].sort((a, b) => b.createdAt - a.createdAt);
      }
    },
    (cause) => { error.value = t('archive.deleteFailed'); console.error('[archive delete]', cause); },
  );
  function remove(id: string): void {
    const item = items.value.find((entry) => entry.id === id);
    if (!item) return;
    error.value = '';
    hidden.add(id);
    actions.defer(item);
    items.value = items.value.filter((entry) => entry.id !== id);
  }
  onBeforeUnmount(() => { void actions.commitAll(); });
  return { ...actions, remove, isHidden: (id: string) => hidden.has(id) };
}
