import { shallowRef } from 'vue';

export const UNDO_MS = 8000;

/** Each action owns its deadline, so a later action cannot shorten an earlier undo window. */
export function useDeferredAction<T extends { id: string }>(
  execute: (item: T) => Promise<void>,
  restore: (item: T) => void,
  failed: (cause: unknown) => void,
) {
  const pending = shallowRef<T[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  function take(id: string): T | undefined {
    const item = pending.value.find((entry) => entry.id === id);
    clearTimeout(timers.get(id));
    timers.delete(id);
    pending.value = pending.value.filter((entry) => entry.id !== id);
    return item;
  }
  async function commit(id: string): Promise<void> {
    const item = take(id);
    if (!item) return;
    try { await execute(item); }
    catch (cause) { restore(item); failed(cause); }
  }
  function defer(item: T): void {
    if (pending.value.some((entry) => entry.id === item.id)) return;
    pending.value = [...pending.value, item];
    timers.set(item.id, setTimeout(() => { void commit(item.id); }, UNDO_MS));
  }
  function undo(id: string): void {
    const item = take(id);
    if (item) restore(item);
  }
  async function commitAll(): Promise<void> {
    await Promise.all(pending.value.map((item) => commit(item.id)));
  }
  return { pending, defer, undo, commit, commitAll };
}
