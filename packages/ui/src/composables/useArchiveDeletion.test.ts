import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { AppBridge, ArchiveSummary } from '@rt/core';
import { setBridge } from '../bridge';
import { useArchiveDeletion } from './useArchiveDeletion';

const hooks = vi.hoisted(() => ({ unmount: () => {} }));
vi.mock('vue', async (original) => ({
  ...await original<typeof import('vue')>(),
  onBeforeUnmount: (fn: () => void) => { hooks.unmount = fn; },
}));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const record = (id: string, createdAt: number) => ({ id, name: id, createdAt, lastLine: '' }) as ArchiveSummary;
function setup() {
  const a = record('a', 3), b = record('b', 2), c = record('c', 1);
  const items = ref([a, b, c]);
  const error = ref('');
  const remove = vi.fn(async (_id: string) => [] as ArchiveSummary[]);
  setBridge({ deleteArchive: remove } as unknown as AppBridge);
  return { items, error, deleteArchive: remove, ...useArchiveDeletion(items, error, (key) => key) };
}
it('hides immediately and undo restores the original order without persistence', async () => {
  const q = setup();
  q.remove('b');
  expect(q.items.value.map((x) => x.id)).toEqual(['a', 'c']);
  expect(q.isHidden('b')).toBe(true);
  q.undo('b');
  expect(q.items.value.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  expect(q.isHidden('b')).toBe(false);
  await vi.runAllTimersAsync();
  expect(q.deleteArchive).not.toHaveBeenCalled();
});
it('restores a failed deletion with its specific error', async () => {
  const q = setup();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  q.deleteArchive.mockRejectedValueOnce(new Error('offline'));
  q.remove('b');
  await vi.advanceTimersByTimeAsync(8000);
  expect(q.items.value.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  expect(q.error.value).toBe('archive.deleteFailed');
  expect(q.isHidden('b')).toBe(false);
  log.mockRestore();
});
it('commits pending deletions on unmount and ignores returned stale lists', async () => {
  const q = setup();
  q.remove('a');
  q.remove('b');
  hooks.unmount();
  await vi.runAllTimersAsync();
  expect(q.deleteArchive).toHaveBeenCalledTimes(2);
  expect(q.items.value.map((x) => x.id)).toEqual(['c']);
});

it('keeps in-flight and committed records hidden from stale metadata responses', async () => {
  const q = setup();
  let finish!: (value: ArchiveSummary[]) => void;
  q.deleteArchive.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  q.remove('a');
  const committing = q.commit('a');
  expect(q.pending.value).toEqual([]);
  expect(q.isHidden('a')).toBe(true);
  finish([]);
  await committing;
  expect(q.isHidden('a')).toBe(true);
});
