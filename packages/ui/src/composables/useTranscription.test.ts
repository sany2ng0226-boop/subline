import { beforeEach, expect, it, vi } from 'vitest';
import type { AppBridge } from '@rt/core';

let callbacks: Record<string, (v: any) => void>;
let state: typeof import('./useTranscription');
beforeEach(async () => {
  vi.resetModules();
  callbacks = {};
  const bridge = Object.fromEntries(['onSegment', 'onPartial', 'onTranslation', 'onStatus', 'onTranslationStatus']
    .map((key) => [key, (fn: (v: any) => void) => { callbacks[key] = fn; return () => {}; }])) as unknown as AppBridge;
  bridge.startPipeline = async () => ({ ok: true });
  bridge.stopPipeline = async () => ({ ok: true });
  (await import('../bridge')).setBridge(bridge);
  state = await import('./useTranscription');
  state.registerTranscriptionListeners();
});

it('keeps the same visible row through corrections, confirmation and translation', () => {
  callbacks.onPartial({ text: '会社のロゴを消費登録', stableText: '会社のロゴを' });
  const row = state.draftLine.value!;
  callbacks.onPartial({ text: '会社のロゴを商標登録しました。', stableText: '会社のロゴを商標登録' });
  expect(state.draftLine.value).toBe(row);
  expect(state.lines).toHaveLength(0);
  callbacks.onSegment({ id: 10, text: '会社のロゴを商標登録しました。', start: 0, duration: 4, lang: 'ja' });
  expect(state.lines[0]).toBe(row);
  expect(state.draftLine.value).toBeNull();
  callbacks.onTranslation({ id: 10, text: '注册了公司的商标。' });
  expect(row.translation).toBe('注册了公司的商标。');
  expect(state.lines[0].displayId).toBe(row.displayId);
});

it('keeps late translations on their confirmed row while the next row grows', () => {
  callbacks.onPartial({ text: '最初の話。' });
  callbacks.onSegment({ id: 11, text: '最初の話。', start: 0, duration: 2, lang: 'ja' });
  const first = state.lines[0];
  callbacks.onPartial({ text: '次の話' });
  const next = state.draftLine.value!;
  callbacks.onTranslation({ id: 11, text: '第一件事。' });
  expect(first.translation).toBe('第一件事。');
  expect(next.translation).toBe('');
  expect(next.displayId).not.toBe(first.displayId);
  expect(state.lines).toHaveLength(1);
});

it('does not archive provisional rows and can accept a segment without partial events', () => {
  callbacks.onPartial({ text: 'まだ途中' });
  expect(state.lines).toHaveLength(0);
  state.clearTranscript();
  expect(state.draftLine.value).toBeNull();
  callbacks.onSegment({ id: 12, text: '確定だけ。', start: 0, duration: 2, lang: 'ja' });
  expect(state.lines).toHaveLength(1);
  expect(state.lines[0].text).toBe('確定だけ。');
  expect(state.lines[0].displayId).toBeGreaterThan(0);
});

it('keeps cumulative translation provisional until completion and clears it on stream failure', () => {
  callbacks.onSegment({ id: 20, text: '本文。', start: 0, duration: 2, lang: 'ja' });
  const row = state.lines[0];
  callbacks.onTranslation({ id: 20, text: '', pending: true });
  callbacks.onTranslation({ id: 20, text: '正在翻', partial: true });
  expect(row.translation).toBe('正在翻'); expect(row.translating).toBe(true);
  expect(state.archiveSnapshot()[0].translation).toBe('');
  callbacks.onTranslation({ id: 20, text: '', failed: true, error: 'stream interrupted' });
  expect(row.translation).toBe(''); expect(row.failed).toBe(true); expect(row.translating).toBe(false);
  callbacks.onTranslation({ id: 20, text: '完整译文' });
  expect(row.translation).toBe('完整译文'); expect(row.translationPartial).toBe(false); expect(row.failed).toBe(false);
  expect(state.archiveSnapshot()[0].translation).toBe('完整译文');
});

it('restores deleted rows on undo, including translations that arrived meanwhile', () => {
  callbacks.onSegment({ id: 30, text: '消した文。', start: 0, duration: 2, lang: 'ja' });
  const row = state.lines[0];
  callbacks.onTranslation({ id: 30, text: '', pending: true });
  state.deleteTranscript();
  expect(state.lines).toHaveLength(0);
  expect(state.canUndoDelete.value).toBe(true);
  callbacks.onTranslation({ id: 30, text: '删掉的句子。' });
  state.undoDelete();
  expect(state.lines[0]).toBe(row);
  expect(row.translation).toBe('删掉的句子。');
  expect(row.translating).toBe(false);
  expect(state.canUndoDelete.value).toBe(false);
});

it('drops the undo buffer after an archive clear', () => {
  callbacks.onSegment({ id: 31, text: '保存済み。', start: 0, duration: 2, lang: 'ja' });
  state.deleteTranscript();
  state.clearTranscript();
  expect(state.canUndoDelete.value).toBe(false);
  state.undoDelete();
  expect(state.lines).toHaveLength(0);
});

it('treats recording or unarchived rows as unsaved, and waits for an in-flight start before stopping', async () => {
  expect(state.hasUnsavedContent.value).toBe(false);
  state.toggleRecording();
  expect(state.hasUnsavedContent.value).toBe(true);
  callbacks.onSegment({ id: 40, text: '最後の文。', start: 0, duration: 2, lang: 'ja' });
  await state.ensureStopped();
  expect(state.recording.value).toBe(false);
  expect(state.recordBusy.value).toBe(false);
  expect(state.hasUnsavedContent.value).toBe(true);
  state.clearTranscript();
  expect(state.hasUnsavedContent.value).toBe(false);
});

it('reports a denied microphone as a permission error, not a recognizer failure', async () => {
  const { setBridge, bridge } = await import('../bridge');
  setBridge({ ...bridge(), startPipeline: async () => ({ ok: false, error: 'NotAllowedError: Permission denied', code: 'asr-init-failed' }) });
  await state.startRecording();
  expect(state.errorCode.value).toBe('mic-permission');
  callbacks.onStatus({ state: 'error', error: 'NotAllowedError: Permission denied' });
  expect(state.errorCode.value).toBe('mic-permission');
});

it('surfaces a failed stop and blocks archive until a later successful recording', async () => {
  const { setBridge, bridge } = await import('../bridge');
  const current = bridge();
  setBridge({ ...current, stopPipeline: async () => { throw new Error('ASR flush timed out'); } });
  await state.startRecording();
  state.toggleRecording();
  await expect(state.ensureStopped()).rejects.toThrow('ASR flush timed out');
  expect(state.recordBusy.value).toBe(false);
  expect(state.errorText.value).toBe('ASR flush timed out');
  await expect(state.ensureStopped()).rejects.toThrow('ASR flush timed out');
  setBridge(current);
  await state.startRecording();
  await expect(state.ensureStopped()).resolves.toBeUndefined();
});

it('waits for an automatic error-triggered stop before allowing archive', async () => {
  const { setBridge, bridge } = await import('../bridge');
  let finish!: () => void;
  setBridge({ ...bridge(), stopPipeline: () => new Promise<void>((resolve) => { finish = resolve; }) });
  await state.startRecording();
  callbacks.onStatus({ state: 'error', error: 'audio interrupted' });
  let stopped = false;
  const pending = state.ensureStopped().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  callbacks.onSegment({ id: 50, text: 'final buffered words', start: 0, duration: 1 });
  finish();
  await pending;
  expect(state.lines[0].text).toBe('final buffered words');
  expect(state.recordBusy.value).toBe(false);
});
