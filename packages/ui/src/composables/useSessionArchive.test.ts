import { beforeEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { AppBridge, CloseGuard } from '@rt/core';

let callbacks: Record<string, (v: any) => void>;
let guard: CloseGuard | null;
let archiveHandler: () => Promise<boolean>;
let saveArchive: ReturnType<typeof vi.fn>;
let transcription: typeof import('./useTranscription');

beforeEach(async () => {
  vi.resetModules();
  callbacks = {};
  guard = null;
  saveArchive = vi.fn(async () => []);
  const bridge = Object.fromEntries(['onSegment', 'onPartial', 'onTranslation', 'onStatus', 'onTranslationStatus']
    .map((key) => [key, (fn: (v: any) => void) => { callbacks[key] = fn; return () => {}; }])) as unknown as AppBridge;
  Object.assign(bridge, {
    setCloseGuard: (next: CloseGuard | null) => { guard = next; },
    onArchiveBeforeClose: (handler: () => Promise<boolean>) => { archiveHandler = handler; return () => {}; },
    listArchives: async () => [],
    saveArchive,
  });
  (await import('../bridge')).setBridge(bridge);
  transcription = await import('./useTranscription');
  transcription.registerTranscriptionListeners();
  (await import('./useSessionArchive')).registerCloseGuard();
});

it('keeps the close guard while a cleared transcript can still be undone', async () => {
  callbacks.onSegment({ id: 1, text: 'a', start: 0, duration: 1 });
  await nextTick();
  expect(guard?.detail).toBe('Quitting without saving loses these captions.');
  transcription.deleteTranscript();
  await nextTick();
  expect(guard?.detail).toBe('Deleted captions can still be undone. They can’t be restored after you quit.');
  transcription.dismissUndo();
  await nextTick();
  expect(guard).toBeNull();
});

it('archive-and-quit during the undo window archives the cleared lines', async () => {
  callbacks.onSegment({ id: 1, text: 'a', start: 0, duration: 1 });
  transcription.deleteTranscript();
  expect(await archiveHandler()).toBe(true);
  expect(saveArchive).toHaveBeenCalledOnce();
  expect(saveArchive.mock.calls[0][1]).toEqual([expect.objectContaining({ text: 'a' })]);
});
