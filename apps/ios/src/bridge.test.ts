import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudTranslator, makeDefaults, type AppSettings, type PartialPayload, type SegmentPayload, type TranslationPayload } from '@rt/core';

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  listeners: new Map<string, (value: any) => void>(),
  start: vi.fn(), stop: vi.fn(), translate: vi.fn(), setup: vi.fn(), download: vi.fn(),
}));
vi.mock('@capacitor/preferences', () => ({ Preferences: {
  get: vi.fn(async ({ key }: { key: string }) => ({ value: mocks.storage.get(key) ?? null })),
  set: vi.fn(async ({ key, value }: { key: string; value: string }) => { mocks.storage.set(key, value); }),
} }));
vi.mock('../native-plugin', () => ({
  RealtimeAsr: {
    start: mocks.start, stop: mocks.stop, getSetupStatus: mocks.setup, downloadModels: mocks.download,
    addListener: vi.fn((event: string, callback: (value: any) => void) => {
      mocks.listeners.set(event, callback);
      return Promise.resolve({ remove: vi.fn() });
    }),
  },
  RealtimeTranslate: { translate: mocks.translate },
}));
import { createIosBridge } from './bridge';

function emit(event: string, payload: unknown): void { mocks.listeners.get(event)!(payload); }
function fragment(text: string, start = 0, duration = 1.2): SegmentPayload {
  return { id: 0, text, lang: 'ja', start, duration };
}
async function drain(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup(engine: AppSettings['translation']['engine'] = 'm2m100') {
  const settings = makeDefaults(['zh']);
  settings.asr.language = 'ja';
  settings.translation = { ...settings.translation, enabled: true, engine, targetLang: 'zh' };
  mocks.storage.set('realtime-translator.settings', JSON.stringify(settings));
  const bridge = createIosBridge();
  await bridge.getSettings();
  const segments: SegmentPayload[] = [], partials: PartialPayload[] = [], translations: TranslationPayload[] = [];
  bridge.onSegment((value) => segments.push(value));
  bridge.onPartial((value) => partials.push(value));
  bridge.onTranslation((value) => translations.push(value));
  await bridge.startPipeline();
  return { bridge, segments, partials, translations };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.storage.clear(); mocks.listeners.clear();
  mocks.start.mockReset().mockResolvedValue({ ok: true });
  mocks.stop.mockReset().mockResolvedValue({ ok: true });
  mocks.setup.mockReset().mockResolvedValue({ asrReady: true });
  mocks.download.mockReset().mockResolvedValue({ ok: true });
  mocks.translate.mockReset().mockImplementation(async ({ text }: { text: string }) => ({ text: `译文:${text}` }));
  vi.stubGlobal('navigator', { languages: ['zh'] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('iOS shared sentence and translation pipeline', () => {
  it('keeps pending recognized text visible with live partials and postpones idle finalization during speech', async () => {
    const { segments, partials } = await setup();
    emit('segment', fragment('自分の言葉で', 0, 2));
    await vi.advanceTimersByTimeAsync(1000);
    emit('partial', { text: '感想を書いて' });
    expect(partials.at(-1)).toEqual({ text: '自分の言葉で感想を書いて', stableText: '自分の言葉で' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(segments).toHaveLength(0);
    emit('segment', fragment('感想を書いてください。', 2, 2));
    emit('partial', { text: '' });
    expect(segments).toMatchObject([{ id: 0, text: '自分の言葉で感想を書いてください。', start: 0, duration: 4 }]);
    expect(partials.at(-1)?.text).toBe('');
  });

  it('flushes the final native fragment before stopped is visible and before stop resolves, exactly once', async () => {
    const { bridge, segments } = await setup();
    const order: string[] = [];
    bridge.onSegment((s) => order.push(s.text));
    bridge.onStatus((s) => order.push(s.state));
    mocks.stop.mockImplementationOnce(async () => {
      emit('segment', fragment('まだ終わっていない', 0, 1));
      emit('status', { state: 'stopped' });
      return { ok: true };
    });
    expect(await bridge.stopPipeline()).toEqual({ ok: true });
    expect(order).toEqual(['まだ終わっていない', 'stopped']);
    emit('segment', fragment('古い遅延イベント', 1, 1));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(segments).toHaveLength(1);
    await drain();
    expect(mocks.translate).toHaveBeenCalledTimes(1);
  });

  it('captures source context in order while serializing native calls, without recycling generated translations', async () => {
    const first = deferred<{ text: string }>();
    mocks.translate.mockImplementationOnce(() => first.promise);
    await setup();
    emit('segment', fragment('最初の文です。', 0));
    emit('segment', fragment('次の文です。', 2));
    emit('segment', fragment('最後の文です。', 4));
    await drain();
    expect(mocks.translate).toHaveBeenCalledTimes(1);
    expect(mocks.translate.mock.calls[0][0]).toMatchObject({ context: [], text: '最初の文です。' });
    first.resolve({ text: '模型生成的译文' });
    await drain();
    expect(mocks.translate).toHaveBeenCalledTimes(3);
    expect(mocks.translate.mock.calls[1][0].context).toEqual(['最初の文です。']);
    expect(mocks.translate.mock.calls[2][0].context).toEqual(['最初の文です。', '次の文です。']);
  });

  it('preserves an open utterance on repeated start but isolates late translations when a new session begins', async () => {
    const old = deferred<{ text: string }>();
    mocks.translate.mockImplementationOnce(() => old.promise);
    const { bridge, segments, translations } = await setup();
    emit('segment', fragment('まだ途中', 0, 1));
    await bridge.startPipeline();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(await bridge.stopPipeline()).toEqual({ ok: true });
    expect(segments[0].text).toBe('まだ途中');
    await drain();
    await bridge.startPipeline();
    emit('segment', fragment('新しい会話です。', 0));
    old.resolve({ text: '旧会话迟到译文' });
    await drain();
    expect(segments.map((s) => s.id)).toEqual([0, 1]);
    expect(translations.some((t) => t.text === '旧会话迟到译文')).toBe(false);
    expect(mocks.translate.mock.calls[1][0].context).toEqual([]);
    expect(translations.at(-1)).toMatchObject({ id: 1, text: '译文:新しい会话です。' });
  });

  it('keeps context across appearance changes, resets it for translation settings, and rejects outdated results', async () => {
    const old = deferred<{ text: string }>();
    const { bridge, translations } = await setup();
    emit('segment', fragment('前の文です。', 0));
    await drain();
    await bridge.saveSettings({ theme: 'dark' });
    mocks.translate.mockImplementationOnce(() => old.promise);
    emit('segment', fragment('変更前の文です。', 2));
    await drain();
    expect(mocks.translate.mock.calls[1][0].context).toEqual(['前の文です。']);
    await bridge.saveSettings({ translation: { targetLang: 'ko' } });
    emit('segment', fragment('変更後の文です。', 4));
    old.resolve({ text: '错误语言的迟到译文' });
    await drain();
    expect(translations.some((t) => t.text === '错误语言的迟到译文')).toBe(false);
    expect(mocks.translate.mock.calls[2][0]).toMatchObject({ context: [], target: 'ko' });
  });

  it('keeps the cloud request policy unchanged rather than sending Apple context to another endpoint', async () => {
    const cloud = vi.spyOn(CloudTranslator.prototype, 'translate').mockResolvedValue('云译文');
    await setup('cloud');
    emit('segment', fragment('前の文です。', 0));
    emit('segment', fragment('次の文です。', 2));
    await drain();
    expect(mocks.translate).not.toHaveBeenCalled();
    expect(cloud).toHaveBeenNthCalledWith(2, '次の文です。', { source: 'ja', target: 'zh' });
  });
});

 describe('iOS Apple ASR selection', () => {
  it('keeps the explicit selected language for native start, readiness and system asset download', async () => {
    const bridge = createIosBridge();
    await bridge.getSettings();
    await bridge.saveSettings({ asr: { model: 'apple-speech', language: 'ja' } });
    expect((await bridge.getSettings()).asr).toEqual({ model: 'apple-speech', language: 'ja' });
    await bridge.getSetupStatus('apple-speech');
    await bridge.downloadAsrModels('apple-speech');
    await bridge.startPipeline();
    expect(mocks.setup).toHaveBeenCalledWith({ modelId: 'apple-speech', language: 'ja' });
    expect(mocks.download).toHaveBeenCalledWith({ modelId: 'apple-speech', language: 'ja' });
    expect(mocks.start).toHaveBeenCalledWith({ modelId: 'apple-speech', language: 'ja' });
    await bridge.stopPipeline();
    await bridge.saveSettings({ asr: { language: 'auto' } });
    expect((await bridge.getSettings()).asr).toEqual({ model: 'sense-voice', language: 'auto' });
  });
 });
