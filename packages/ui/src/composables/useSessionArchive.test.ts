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
    startPipeline: async () => ({ ok: true }),
    stopPipeline: async () => {},
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

it('guards an unresolved recovery draft even before any new recording', async () => {
  const { recoveryOffer } = await import('./useRecovery');
  recoveryOffer.value = { version: 1, savedAt: 1, lines: [{ time: '09:00:00', text: 'older class', translation: '' }] };
  await nextTick();
  expect(guard).not.toBeNull();
});

it('archives pending recovery before new captions when leaving', async () => {
  const { recoveryOffer } = await import('./useRecovery');
  recoveryOffer.value = { version: 1, savedAt: 1, lines: [{ time: '09:00:00', text: 'older class', translation: '旧课' }] };
  callbacks.onSegment({ id: 1, text: 'new class', start: 0, duration: 1 });
  expect(await archiveHandler()).toBe(true);
  expect(saveArchive.mock.calls[0][1]).toEqual([
    expect.objectContaining({ text: 'older class', translation: '旧课' }),
    expect.objectContaining({ text: 'new class' }),
  ]);
  expect(recoveryOffer.value).toBeNull();
  expect(transcription.lines).toHaveLength(0);
});

it('preserves both a pending recovery draft and captions in the delete-undo window', async () => {
  const { recoveryOffer } = await import('./useRecovery');
  recoveryOffer.value = { version: 1, savedAt: 1, lines: [{ time: '09:00:00', text: 'older class', translation: '' }] };
  callbacks.onSegment({ id: 1, text: 'just deleted', start: 0, duration: 1 });
  transcription.deleteTranscript();
  expect(await archiveHandler()).toBe(true);
  expect(saveArchive.mock.calls[0][1].map((line: { text: string }) => line.text))
    .toEqual(['older class', 'just deleted']);
});

it('keeps the window open without archiving when final ASR flush fails', async () => {
  const { bridge, setBridge } = await import('../bridge');
  setBridge({ ...bridge(), stopPipeline: async () => { throw new Error('ASR flush timed out'); } });
  await transcription.startRecording();
  callbacks.onSegment({ id: 1, text: 'saved prefix', start: 0, duration: 1 });
  expect(await archiveHandler()).toBe(false);
  expect(saveArchive).not.toHaveBeenCalled();
  expect(transcription.lines[0].text).toBe('saved prefix');
  expect(guard).not.toBeNull();
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
