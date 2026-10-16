import { beforeEach, expect, it, vi } from 'vitest';
import type { AppBridge } from '@rt/core';

let callbacks: Record<string, (v: any) => void>;
let state: typeof import('./useTranscription');
beforeEach(async () => {
  vi.resetModules();
  callbacks = {};
  const bridge = Object.fromEntries(['onSegment', 'onPartial', 'onTranslation', 'onStatus', 'onTranslationStatus']
    .map((key) => [key, (fn: (v: any) => void) => { callbacks[key] = fn; return () => {}; }])) as unknown as AppBridge;
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
