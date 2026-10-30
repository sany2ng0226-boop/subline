import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { AppBridge } from '@rt/core';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

let callbacks: Record<string, (v: any) => void>;
let storage: MemoryStorage;
let transcription: typeof import('./useTranscription');
let recovery: typeof import('./useRecovery');

async function setup(extra: Partial<AppBridge> = {}): Promise<void> {
  vi.resetModules();
  callbacks = {};
  const bridge = Object.fromEntries(['onSegment', 'onPartial', 'onTranslation', 'onStatus', 'onTranslationStatus']
    .map((key) => [key, (fn: (v: any) => void) => { callbacks[key] = fn; return () => {}; }])) as unknown as AppBridge;
  Object.assign(bridge, extra);
  (await import('../bridge')).setBridge(bridge);
  transcription = await import('./useTranscription');
  recovery = await import('./useRecovery');
  transcription.registerTranscriptionListeners();
}

function segment(id: number, text: string): void {
  callbacks.onSegment({ id, text, start: id, duration: 1 });
}

function stored() {
  const json = storage.getItem('rt.recovery.v1');
  return json ? JSON.parse(json) : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('falls back to localStorage and throttles writes to one per 10 seconds', async () => {
  await setup();
  await recovery.initRecovery({ lang: () => 'ja' });
  segment(1, 'first');
  await nextTick();
  expect(stored()).toMatchObject({ version: 1, lang: 'ja', lines: [{ text: 'first', translation: '' }] });
  segment(2, 'second');
  callbacks.onTranslation({ id: 1, text: 'draft', partial: true });
  await nextTick();
  expect(stored().lines).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(recovery.RECOVERY_THROTTLE_MS);
  // 流式译文不写入暂存
  expect(stored().lines.map((l: { text: string; translation: string }) => [l.text, l.translation]))
    .toEqual([['first', ''], ['second', '']]);
});

it('uses the host bridge when it implements recovery', async () => {
  let file: string | null = null;
  await setup({
    saveRecovery: vi.fn(async (json: string) => { file = json; }),
    loadRecovery: vi.fn(async () => file),
    clearRecovery: vi.fn(async () => { file = null; }),
  });
  await recovery.initRecovery();
  segment(1, 'hello');
  await nextTick();
  expect(JSON.parse(file!).lines[0].text).toBe('hello');
  expect(stored()).toBeNull();
});

it('offers saved lines on start and restores them before new content', async () => {
  storage.setItem('rt.recovery.v1', JSON.stringify({
    version: 1, savedAt: 1, lines: [{ time: '09:00:00', text: 'old', translation: '旧', lang: 'en' }],
  }));
  await setup();
  await recovery.initRecovery();
  expect(recovery.recoveryOffer.value?.lines).toHaveLength(1);
  // 尚未处理恢复条时开始新内容：暂存里同时保留旧行
  segment(1, 'new');
  await nextTick();
  expect(stored().lines.map((l: { text: string }) => l.text)).toEqual(['old', 'new']);
  recovery.restoreRecovery();
  expect(recovery.recoveryOffer.value).toBeNull();
  expect(transcription.lines.map((l) => l.text)).toEqual(['old', 'new']);
  expect(transcription.lines[0]).toMatchObject({ translation: '旧', lang: 'en' });
  expect(transcription.lines[0].id).toBeLessThan(0);
});

it('discarding drops the saved lines', async () => {
  storage.setItem('rt.recovery.v1', JSON.stringify({ version: 1, savedAt: 1, lines: [{ time: '', text: 'old', translation: '' }] }));
  await setup();
  await recovery.initRecovery();
  recovery.discardRecovery();
  expect(stored()).toBeNull();
});

it('ignores corrupt data', async () => {
  storage.setItem('rt.recovery.v1', '{oops');
  await setup();
  await recovery.initRecovery();
  expect(recovery.recoveryOffer.value).toBeNull();
  expect(stored()).toBeNull();
});

it('keeps the snapshot during the undo window and clears it afterwards', async () => {
  await setup();
  await recovery.initRecovery();
  segment(1, 'a');
  await nextTick();
  transcription.deleteTranscript();
  await nextTick();
  expect(stored().lines).toHaveLength(1);
  transcription.dismissUndo();
  await nextTick();
  expect(stored()).toBeNull();
});

it('clears after archiving', async () => {
  await setup({ saveArchive: vi.fn(async () => []) });
  await recovery.initRecovery();
  segment(1, 'a');
  await nextTick();
  const { archiveSession } = await import('./useSessionArchive');
  await archiveSession('x');
  expect(stored()).toBeNull();
});

it('restores a snapshot containing only audio IDs', async () => {
  storage.setItem('rt.recovery.v1', JSON.stringify({ version: 1, savedAt: 1, lines: [], audioIds: ['saved-audio'] }));
  await setup();
  await recovery.initRecovery();
  expect(recovery.recoveryOffer.value).toMatchObject({ lines: [], audioIds: ['saved-audio'] });
  recovery.restoreRecovery();
  expect(transcription.lines).toEqual([]);
  expect(transcription.recordingIds).toEqual(['saved-audio']);
  expect(stored().audioIds).toEqual(['saved-audio']);
});

it('discovers orphan recordings even without a recovery snapshot', async () => {
  await setup({ listUnarchivedRecordings: vi.fn(async () => ['orphan']) });
  await recovery.initRecovery();
  expect(recovery.recoveryOffer.value).toMatchObject({ lines: [], audioIds: ['orphan'] });
  recovery.restoreRecovery();
  expect(transcription.recordingIds).toEqual(['orphan']);
  expect(stored()).toMatchObject({ audioIds: ['orphan'] });
});

it('merges independently discovered audio with the saved offer without duplicate IDs', async () => {
  storage.setItem('rt.recovery.v1', JSON.stringify({ version: 1, savedAt: 1, lines: [], audioIds: ['saved'] }));
  await setup({ listUnarchivedRecordings: vi.fn(async () => ['saved', 'orphan']) });
  await recovery.initRecovery();
  expect(recovery.recoveryOffer.value?.audioIds).toEqual(['saved', 'orphan']);
});

it('persists new audio IDs immediately without waiting for the first caption', async () => {
  await setup();
  await recovery.initRecovery();
  transcription.restoreRecordings(['first']);
  await nextTick();
  expect(stored()).toMatchObject({ lines: [], audioIds: ['first'] });
  transcription.restoreRecordings(['second']);
  await nextTick();
  expect(stored().audioIds).toEqual(['first', 'second']);
});

it('undo restores audio ownership before dismissing the delete buffer', async () => {
  const discardRecordings = vi.fn(async () => {});
  await setup({ discardRecordings });
  await recovery.initRecovery();
  transcription.restoreRecordings(['undo-audio']);
  await nextTick();
  transcription.deleteTranscript();
  await nextTick();
  expect(transcription.canUndoDelete.value).toBe(true);
  expect(stored().audioIds).toEqual(['undo-audio']);
  transcription.undoDelete();
  await nextTick();
  expect(transcription.recordingIds).toEqual(['undo-audio']);
  expect(transcription.canUndoDelete.value).toBe(false);
  expect(discardRecordings).not.toHaveBeenCalled();
});

it('discarding a recovery offer preserves audio already owned by the current transcript', async () => {
  storage.setItem('rt.recovery.v1', JSON.stringify({ version: 1, savedAt: 1, lines: [], audioIds: ['shared', 'old'] }));
  const discardRecordings = vi.fn(async () => {});
  await setup({ discardRecordings });
  await recovery.initRecovery();
  transcription.restoreRecordings(['shared', 'current']);
  recovery.discardRecovery();
  expect(discardRecordings).toHaveBeenCalledExactlyOnceWith(['old']);
  expect(transcription.recordingIds).toEqual(['shared', 'current']);
  expect(stored().audioIds).toEqual(['shared', 'current']);
});

it('releases deleted audio only after undo is dismissed', async () => {
  const discardRecordings = vi.fn(async () => {});
  await setup({ discardRecordings });
  await recovery.initRecovery();
  transcription.restoreRecordings(['discarded']);
  await nextTick();
  transcription.deleteTranscript();
  await nextTick();
  expect(discardRecordings).not.toHaveBeenCalled();
  transcription.dismissUndo();
  await nextTick();
  expect(discardRecordings).toHaveBeenCalledExactlyOnceWith(['discarded']);
  expect(stored()).toBeNull();
});

it('successful archive clears recovery ownership without discarding the archived audio file', async () => {
  const discardRecordings = vi.fn(async () => {});
  await setup({ saveArchive: vi.fn(async () => []), discardRecordings });
  await recovery.initRecovery();
  transcription.restoreRecordings(['archived-audio']);
  await nextTick();
  const { archiveSession } = await import('./useSessionArchive');
  await archiveSession('audio');
  expect(transcription.recordingIds).toEqual([]);
  expect(stored()).toBeNull();
  expect(discardRecordings).not.toHaveBeenCalled();
});

it('persists native completion metadata even when a skipped translation leaves its text empty', async () => {
  let file: string | null = null;
  const save = vi.fn(async (json: string) => { file = json; });
  await setup({ platform: 'ios', saveRecovery: save, loadRecovery: async () => null, clearRecovery: async () => {} });
  await recovery.initRecovery();
  callbacks.onSegment({ id: 77, text: '无需翻译的原文。', lang: 'zh', start: 0, duration: 3,
    nativeTranslation: { sessionId: 'session-a', revision: 7, target: 'zh', sequences: [1], completed: false } });
  await nextTick();
  expect(JSON.parse(file!).lines[0].nativeTranslation.completed).toBe(false);
  callbacks.onTranslation({ id: 77, text: '' });
  await nextTick();
  await vi.advanceTimersByTimeAsync(recovery.RECOVERY_THROTTLE_MS);
  expect(JSON.parse(file!).lines[0]).toMatchObject({ translation: '', nativeTranslation: { completed: true } });
  expect(save).toHaveBeenCalledTimes(2);
});
