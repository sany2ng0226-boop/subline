import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDeferredAction } from './useDeferredAction';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  const execute = vi.fn(async (_item: { id: string }) => {});
  const restore = vi.fn();
  const failed = vi.fn();
  return { ...useDeferredAction(execute, restore, failed), execute, restore, failed };
}
it('waits eight seconds before committing exactly once', async () => {
  const q = setup();
  q.defer({ id: 'a' });
  await vi.advanceTimersByTimeAsync(7999);
  expect(q.execute).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await q.commitAll();
  expect(q.execute).toHaveBeenCalledTimes(1);
  expect(q.pending.value).toEqual([]);
});
it('undo restores without touching persistence', async () => {
  const q = setup();
  q.defer({ id: 'a' });
  q.undo('a');
  await vi.advanceTimersByTimeAsync(8000);
  expect(q.restore).toHaveBeenCalledWith({ id: 'a' });
  expect(q.execute).not.toHaveBeenCalled();
});
it('keeps separate undo deadlines for consecutive deletions', async () => {
  const q = setup();
  q.defer({ id: 'a' });
  await vi.advanceTimersByTimeAsync(4000);
  q.defer({ id: 'b' });
  await vi.advanceTimersByTimeAsync(4000);
  expect(q.execute).toHaveBeenCalledWith({ id: 'a' });
  expect(q.pending.value).toEqual([{ id: 'b' }]);
  q.undo('b');
  await vi.runAllTimersAsync();
  expect(q.execute).toHaveBeenCalledTimes(1);
});
it('flushes outstanding deletes on close without duplicate timer commits', async () => {
  const q = setup();
  q.defer({ id: 'a' });
  q.defer({ id: 'b' });
  await q.commitAll();
  await vi.runAllTimersAsync();
  expect(q.execute).toHaveBeenCalledTimes(2);
  expect(q.pending.value).toEqual([]);
});
it('restores failed deletes and reports the error without an unhandled rejection', async () => {
  const q = setup();
  const cause = new Error('storage unavailable');
  q.execute.mockRejectedValue(cause);
  q.defer({ id: 'a' });
  await vi.advanceTimersByTimeAsync(8000);
  expect(q.restore).toHaveBeenCalledWith({ id: 'a' });
  expect(q.failed).toHaveBeenCalledWith(cause);
});
it('ignores duplicate scheduling and undo after commit has started', async () => {
  const q = setup();
  q.defer({ id: 'a' });
  q.defer({ id: 'a' });
  await q.commit('a');
  q.undo('a');
  await vi.runAllTimersAsync();
  expect(q.execute).toHaveBeenCalledTimes(1);
  expect(q.restore).not.toHaveBeenCalled();
});
