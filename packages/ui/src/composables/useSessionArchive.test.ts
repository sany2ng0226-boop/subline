import { beforeEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { AppBridge, CloseGuard } from '@rt/core';

let callbacks: Record<string, (v: any) => void>;
let guard: CloseGuard | null;
let archiveHandler: () => Promise<boolean>;
let saveArchive: ReturnType<typeof vi.fn>;
let transcription: typeof import('./useTranscription');
let host: AppBridge;

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
    stopPipeline: vi.fn(async () => ({ ok: true })),
  });
  host = bridge;
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

it('guards and archives an audio-only session on quit', async () => {
  transcription.restoreRecordings(['audio-only']);
  await nextTick();
  expect(guard).not.toBeNull();
  expect(await archiveHandler()).toBe(true);
  expect(saveArchive).toHaveBeenCalledWith(expect.any(String), [], undefined, ['audio-only']);
  expect(transcription.recordingIds).toEqual([]);
  await nextTick();
  expect(guard).toBeNull();
});

it('keeps audio IDs and captions when the native destination dialog is cancelled', async () => {
  transcription.restoreRecordings(['native-cancel']);
  callbacks.onSegment({ id: 1, text: 'keep me', start: 0, duration: 1 });
  host.chooseArchiveSavePath = vi.fn(async () => ({ status: 'cancelled' as const }));
  host.saveArchiveBeforeClose = vi.fn(async () => {});
  expect(await archiveHandler()).toBe(false);
  expect(transcription.recordingIds).toEqual(['native-cancel']);
  expect(transcription.lines[0].text).toBe('keep me');
  expect(host.saveArchiveBeforeClose).not.toHaveBeenCalled();
  expect(saveArchive).not.toHaveBeenCalled();
  expect(transcription.recordBusy.value).toBe(false);
});

it('takes the native save snapshot after translations finish during destination selection', async () => {
  callbacks.onSegment({ id: 1, text: 'original', start: 0, duration: 1 });
  transcription.restoreRecordings(['native-file']);
  let choose!: (result: { status: 'selected'; token: string }) => void;
  host.chooseArchiveSavePath = vi.fn(() => new Promise((resolve) => { choose = resolve; }));
  host.saveArchiveBeforeClose = vi.fn(async () => {});
  const leaving = archiveHandler();
  await vi.waitFor(() => expect(host.chooseArchiveSavePath).toHaveBeenCalledOnce());
  expect(transcription.recordBusy.value).toBe(true);
  callbacks.onTranslation({ id: 1, text: 'completed translation' });
  choose({ status: 'selected', token: 'confirmed' });
  expect(await leaving).toBe(true);
  expect(host.saveArchiveBeforeClose).toHaveBeenCalledWith('confirmed', [expect.objectContaining({
    text: 'original', translation: 'completed translation',
  })], ['native-file']);
  expect(transcription.recordingIds).toEqual([]);
});

it('waits for stop and includes its final captions before ordinary archive persistence', async () => {
  const { archiveSession } = await import('./useSessionArchive');
  let finishStop!: () => void;
  host.stopPipeline = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { finishStop = () => resolve({ ok: true }); }));
  transcription.recording.value = true;
  transcription.restoreRecordings(['stopping']);
  const saving = archiveSession('recording');
  await vi.waitFor(() => expect(host.stopPipeline).toHaveBeenCalledOnce());
  expect(saveArchive).not.toHaveBeenCalled();
  callbacks.onSegment({ id: 1, text: 'final tail', start: 0, duration: 1 });
  finishStop();
  await saving;
  expect(saveArchive).toHaveBeenCalledWith('recording', [expect.objectContaining({ text: 'final tail' })], undefined, ['stopping']);
});

it('retains audio IDs when ordinary archive persistence fails', async () => {
  const { archiveSession } = await import('./useSessionArchive');
  transcription.restoreRecordings(['disk-failure']);
  callbacks.onSegment({ id: 1, text: 'retain', start: 0, duration: 1 });
  saveArchive.mockRejectedValue(new Error('disk unavailable'));
  await expect(archiveSession('failed')).rejects.toThrow('disk unavailable');
  expect(transcription.recordingIds).toEqual(['disk-failure']);
  expect(transcription.lines[0].text).toBe('retain');
  expect(transcription.lastArchivedAt.value).toBeNull();
});

it('keeps audio IDs and refuses quit if the native file write fails', async () => {
  transcription.restoreRecordings(['native-failure']);
  host.chooseArchiveSavePath = vi.fn(async () => ({ status: 'selected' as const, token: 'confirmed' }));
  host.saveArchiveBeforeClose = vi.fn(async () => { throw new Error('file write failed'); });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await archiveHandler()).toBe(false);
    expect(transcription.recordingIds).toEqual(['native-failure']);
    expect(saveArchive).not.toHaveBeenCalled();
    expect(transcription.recordBusy.value).toBe(false);
  } finally { log.mockRestore(); }
});

it('restores deleted audio before merging an older recovery offer for quit', async () => {
  const { recoveryOffer } = await import('./useRecovery');
  transcription.restoreRecordings(['new-audio']);
  transcription.deleteTranscript();
  recoveryOffer.value = { version: 1, lines: [], audioIds: ['old-audio'], savedAt: 1 };
  expect(await archiveHandler()).toBe(true);
  expect(saveArchive.mock.calls[0][3]).toEqual(['new-audio', 'old-audio']);
});

it('blocks a new recording shortcut until ordinary archive persistence finishes', async () => {
  const { archiveSession } = await import('./useSessionArchive');
  transcription.restoreRecordings(['being-saved']);
  host.startPipeline = vi.fn(async () => ({ ok: true, recordingId: 'new-recording' }));
  let finishSave!: () => void;
  saveArchive.mockImplementation(() => new Promise<[]>(resolve => { finishSave = () => resolve([]); }));
  const saving = archiveSession('pending');
  await vi.waitFor(() => expect(saveArchive).toHaveBeenCalledOnce());
  transcription.toggleRecording();
  await nextTick();
  try { expect(host.startPipeline).not.toHaveBeenCalled(); }
  finally { finishSave(); await saving; }
  expect(transcription.recordBusy.value).toBe(false);
});
