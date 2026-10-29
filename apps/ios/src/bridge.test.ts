// Host-contract tests only: native audio capture, Apple language packs and BLE
// still require the real-device checklist. No network or microphone is used here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDefaults } from '@rt/core';
import { createIosBridge } from './bridge';
import type { SegmentPayload, TranslationPayload } from '@rt/core';

const native = vi.hoisted(() => ({
  listeners: new Map<string, (value: any) => void>(),
  settings: '',
  translate: vi.fn(),
  cloudTranslate: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@capacitor/preferences', () => ({ Preferences: {
  get: vi.fn(async () => ({ value: native.settings })),
  set: vi.fn(async ({ value }) => { native.settings = value; }),
} }));
vi.mock('../native-plugin', () => ({
  RealtimeAsr: {
    addListener: vi.fn(async (event, cb) => {
      native.listeners.set(event, cb);
      return { remove: vi.fn() };
    }),
    start: native.start,
    stop: native.stop,
  },
  RealtimeTranslate: { translate: native.translate },
}));
vi.mock('./rayneo-forwarder', () => ({ forwardRayNeoText: vi.fn(async () => {}) }));
vi.mock('@rt/core', async (original) => ({
  ...await original<typeof import('@rt/core')>(),
  CloudTranslator: class { translate = native.cloudTranslate; },
}));

beforeEach(() => {
  vi.clearAllMocks();
  native.listeners.clear();
  const s = makeDefaults(['zh']);
  s.onboarded = true;
  s.asr.language = 'ja';
  s.translation.enabled = true;
  native.settings = JSON.stringify(s);
  native.translate.mockResolvedValue({ text: '这是译文。' });
  native.cloudTranslate.mockResolvedValue('网络恢复后的译文。');
  native.start.mockResolvedValue({ ok: true });
  native.stop.mockResolvedValue({ ok: true });
  vi.stubGlobal('navigator', { languages: ['zh'], onLine: true });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });

function segment(id = 0) {
  native.listeners.get('segment')!({ id, text: '今日は会場で話を聞きます。', lang: 'ja', start: 0, end: 2 });
}

async function fixture() {
  const bridge = createIosBridge();
  await bridge.getSettings();
  const lines: SegmentPayload[] = [];
  const translations: TranslationPayload[] = [];
  bridge.onSegment(p => lines.push(p));
  bridge.onTranslation(p => translations.push(p));
  return { bridge, lines, translations };
}

describe('iOS listening host contract (mock native services)', () => {
  it('shows partials, final original and matching local translation without cloud credentials', async () => {
    const { bridge, lines, translations } = await fixture();
    const partial = vi.fn();
    bridge.onPartial(partial);
    expect(await bridge.startPipeline()).toEqual({ ok: true, error: undefined });
    expect(native.start).toHaveBeenCalledWith({ modelId: 'sense-voice', language: 'ja' });
    native.listeners.get('partial')!({ text: '今日は会場で' });
    segment();
    await vi.waitFor(() => expect(translations).toHaveLength(2));
    expect(partial).toHaveBeenCalledWith({ text: '今日は会場で' });
    expect(lines).toHaveLength(1);
    expect(translations[0]).toMatchObject({ id: lines[0].id, pending: true });
    expect(translations[1]).toMatchObject({ id: lines[0].id, text: '这是译文。' });
    expect(native.cloudTranslate).not.toHaveBeenCalled();
    await bridge.stopPipeline();
  });

  it('keeps native segment IDs distinct after pause/resume and accepts late translations', async () => {
    const { bridge, lines, translations } = await fixture();
    let finish!: (value: { text: string }) => void;
    native.translate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await bridge.startPipeline();
    segment(0);
    await bridge.stopPipeline();
    await bridge.startPipeline();
    segment(0);
    finish({ text: '暂停前的译文。' });
    await vi.waitFor(() => expect(translations.filter(p => !p.pending)).toHaveLength(2));
    expect(lines.map(p => p.id)).toEqual([0, 1]);
    expect(translations.find(p => p.text === '暂停前的译文。')?.id).toBe(0);
    expect(translations.find(p => p.text === '这是译文。')?.id).toBe(1);
    await bridge.stopPipeline();
  });

  it('keeps original captions on a cloud outage and translates new captions after recovery', async () => {
    const { bridge, lines, translations } = await fixture();
    const s = await bridge.getSettings();
    s.translation.engine = 'cloud';
    await bridge.saveSettings(s);
    native.cloudTranslate.mockRejectedValueOnce(new Error('offline fixture'));
    await bridge.startPipeline();
    segment(0);
    await vi.waitFor(() => expect(translations.some(p => p.failed)).toBe(true));
    segment(1);
    await vi.waitFor(() => expect(translations.some(p => p.text === '网络恢复后的译文。')).toBe(true));
    expect(lines).toHaveLength(2);
    expect(native.stop).not.toHaveBeenCalled();
    expect(native.translate).not.toHaveBeenCalled();
    await bridge.stopPipeline();
  });

  it('does not send text to cloud when Apple translation is unavailable', async () => {
    const { bridge, lines, translations } = await fixture();
    native.translate.mockResolvedValueOnce({ text: '', unavailable: true, reason: 'missing language pack' });
    await bridge.startPipeline();
    segment();
    await vi.waitFor(() => expect(translations.some(p => p.failed)).toBe(true));
    expect(lines).toHaveLength(1);
    expect(native.cloudTranslate).not.toHaveBeenCalled();
    await bridge.stopPipeline();
  });

  it('routes 1,200 sequential finals and translations without losing IDs or leaving pending rows', async () => {
    const { bridge, lines, translations } = await fixture();
    await bridge.startPipeline();
    for (let i = 0; i < 1200; i++) segment(i);
    await vi.waitFor(() => expect(translations.filter(p => !p.pending)).toHaveLength(1200));
    expect(new Set(lines.map(p => p.id)).size).toBe(1200);
    expect(translations.filter(p => p.pending)).toHaveLength(1200);
    expect(translations.some(p => p.failed)).toBe(false);
    await bridge.stopPipeline();
  });
});
