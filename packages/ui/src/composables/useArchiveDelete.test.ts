import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { AppBridge, ArchiveSummary } from '@rt/core';
import { setBridge } from '../bridge';
import { ARCHIVE_UNDO_MS, useArchiveDelete } from './useArchiveDelete';

const a: ArchiveSummary = { id: 'a', name: 'A', createdAt: 1, preview: '' };
const b: ArchiveSummary = { id: 'b', name: 'B', createdAt: 2, preview: '' };
const c: ArchiveSummary = { id: 'c', name: 'C', createdAt: 3, preview: '' };
let stored: ArchiveSummary[];
let deleteArchive: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  stored = [a, b, c];
  deleteArchive = vi.fn(async (id: string) => (stored = stored.filter((it) => it.id !== id)));
  setBridge({ deleteArchive } as unknown as AppBridge);
});
afterEach(() => vi.useRealTimers());

it('removes after confirm but only deletes once the undo window ends', async () => {
  const items = ref([a, b, c]);
  const removal = useArchiveDelete(items);
  removal.request(b);
  expect(items.value).toHaveLength(3);
  removal.confirm();
  expect(items.value.map((it) => it.id)).toEqual(['a', 'c']);
  expect(removal.pending.value).toEqual(b);
  await vi.advanceTimersByTimeAsync(ARCHIVE_UNDO_MS - 1);
  expect(deleteArchive).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(deleteArchive).toHaveBeenCalledWith('b');
  expect(removal.pending.value).toBeNull();
  expect(items.value.map((it) => it.id)).toEqual(['a', 'c']);
});

it('puts the archive back in place on undo and never deletes it', async () => {
  const items = ref([a, b, c]);
  const removal = useArchiveDelete(items);
  removal.request(b);
  removal.confirm();
  removal.undo();
  expect(items.value.map((it) => it.id)).toEqual(['a', 'b', 'c']);
  await vi.advanceTimersByTimeAsync(ARCHIVE_UNDO_MS * 2);
  expect(deleteArchive).not.toHaveBeenCalled();
});

it('cancel keeps the list untouched', () => {
  const items = ref([a, b, c]);
  const removal = useArchiveDelete(items);
  removal.request(a);
  removal.cancel();
  removal.confirm();
  expect(items.value).toHaveLength(3);
  expect(removal.pending.value).toBeNull();
});

it('commits the previous pending delete before starting a new one, without resurrecting it', async () => {
  const items = ref([a, b, c]);
  const removal = useArchiveDelete(items);
  removal.request(a);
  removal.confirm();
  removal.request(b);
  removal.confirm();
  await vi.advanceTimersByTimeAsync(0);
  expect(deleteArchive).toHaveBeenCalledWith('a');
  expect(items.value.map((it) => it.id)).toEqual(['c']);
  expect(removal.pending.value).toEqual(b);
});

it('restores the archive and flags a readable error when the delete fails', async () => {
  deleteArchive.mockRejectedValueOnce(new Error('EACCES'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const items = ref([a, b, c]);
  const removal = useArchiveDelete(items);
  removal.request(b);
  removal.confirm();
  await removal.flush();
  expect(removal.failed.value).toBe(true);
  expect(items.value.map((it) => it.id)).toEqual(['a', 'b', 'c']);
});
