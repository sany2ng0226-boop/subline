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
