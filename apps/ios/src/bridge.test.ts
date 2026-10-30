import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudTranslator, makeDefaults, type AppSettings, type PartialPayload, type SegmentPayload, type TranslationPayload } from '@rt/core';

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  listeners: new Map<string, (value: any) => void>(),
  start: vi.fn(), stop: vi.fn(), translate: vi.fn(), setup: vi.fn(), download: vi.fn(),
  journal: undefined as any, ack: vi.fn(), prewarm: vi.fn(),
  nativeConfigure: undefined as any, nativeResultDrain: undefined as any, nativeResultAck: vi.fn(),
}));
vi.mock('@capacitor/preferences', () => ({ Preferences: {
  get: vi.fn(async ({ key }: { key: string }) => ({ value: mocks.storage.get(key) ?? null })),
  set: vi.fn(async ({ key, value }: { key: string; value: string }) => { mocks.storage.set(key, value); }),
} }));
vi.mock('../native-plugin', () => ({
  RealtimeAsr: {
    get configureBackgroundTranslation() { return mocks.nativeConfigure; },
    get drainTranslationResults() { return mocks.nativeResultDrain; },
    ackTranslationResults: mocks.nativeResultAck,
    get drainPendingSegments() { return mocks.journal; }, ackPendingSegments: mocks.ack, prewarm: mocks.prewarm,
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
  mocks.nativeConfigure = undefined; mocks.nativeResultDrain = undefined; mocks.nativeResultAck.mockReset().mockResolvedValue({ ok: true });
  mocks.journal = undefined; mocks.ack.mockReset().mockResolvedValue({ ok: true }); mocks.prewarm.mockReset().mockResolvedValue(undefined);
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

async function settleJournal(): Promise<void> { for (let i = 0; i < 80; i++) await Promise.resolve(); }
const sessionStart = 1793330000000;
function journalSegment(sequence: number, text: string, sessionId = 'session-a', start = sequence * 2) {
  return { ...fragment(text, start, 1.2), sequence, sessionId, startedAt: sessionStart };
}
async function journalSetup() {
  const snapshot = { segments: [] as ReturnType<typeof journalSegment>[],
    status: { state: 'stopped' as 'stopped' | 'running', sessionId: '', startedAt: 0 } };
  mocks.journal = vi.fn(async () => ({ segments: [...snapshot.segments], status: { ...snapshot.status } }));
  mocks.start.mockImplementation(async () => {
    snapshot.status = { state: 'running', sessionId: 'session-a', startedAt: sessionStart };
    emit('status', { ...snapshot.status });
    return { ok: true };
  });
  mocks.stop.mockImplementation(async () => {
    snapshot.status.state = 'stopped';
    emit('status', { ...snapshot.status });
    return { ok: true };
  });
  const result = await setup();
  await settleJournal();
  return { ...result, snapshot };
}

describe('iOS durable native background replay', () => {
  it('deduplicates live and replayed finals and acknowledges only after the UI recovery write succeeds', async () => {
    const { bridge, segments, snapshot } = await journalSetup();
    const segment = journalSegment(1, '保存する文です。');
    snapshot.segments.push(segment);
    emit('segment', segment);
    await settleJournal();
    expect(segments).toHaveLength(1);
    expect(mocks.ack).not.toHaveBeenCalled();
    emit('appActive', { active: true });
    await settleJournal();
    expect(segments).toHaveLength(1);
    const { Preferences } = await import('@capacitor/preferences');
    vi.mocked(Preferences.set).mockRejectedValueOnce(new Error('disk full'));
    await expect(bridge.saveRecovery!('{"version":1,"lines":[{"text":"保存する文です。"}]}')).rejects.toThrow('disk full');
    expect(mocks.ack).not.toHaveBeenCalled();
    await bridge.saveRecovery!('{"version":1,"lines":[{"text":"保存する文です。"}]}');
    expect(mocks.ack).toHaveBeenLastCalledWith({ through: 1 });
  });

  it('does not translate while hidden and replays missing native finals once when foreground returns', async () => {
    const document = new EventTarget() as EventTarget & { visibilityState: string };
    document.visibilityState = 'visible';
    vi.stubGlobal('document', document);
    const { segments, snapshot } = await journalSetup();
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    const first = journalSegment(1, '背景で確定した文です。');
    snapshot.segments.push(first);
    emit('segment', first);
    await settleJournal();
    expect(segments).toHaveLength(1);
    expect(mocks.translate).not.toHaveBeenCalled();
    snapshot.segments.push(journalSegment(2, '戻ってから読む文です。'));
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await settleJournal();
    expect(segments.map((s) => s.text)).toEqual(['背景で確定した文です。', '戻ってから読む文です。']);
    expect(mocks.translate).toHaveBeenCalledTimes(2);
    emit('appActive', { active: true }); await settleJournal();
    expect(segments).toHaveLength(2);
    expect(mocks.translate).toHaveBeenCalledTimes(2);
  });

  it('drains a missing native stop-tail before stopped and does not acknowledge an unrendered assembler fragment', async () => {
    const { bridge, segments, snapshot } = await journalSetup();
    const order: string[] = [];
    bridge.onSegment((s) => order.push(s.text));
    bridge.onStatus((s) => { if (s.state === 'stopped') order.push('stopped'); });
    emit('segment', journalSegment(1, 'まだ途中'));
    await settleJournal();
    await bridge.saveRecovery!('{"version":1,"lines":[]}');
    expect(mocks.ack).not.toHaveBeenCalled();
    mocks.stop.mockImplementationOnce(async () => {
      snapshot.segments.push(journalSegment(1, 'まだ途中'), journalSegment(2, '続きの尾段', 'session-a', 4));
      snapshot.status.state = 'stopped';
      emit('status', { ...snapshot.status });
      return { ok: true };
    });
    await bridge.stopPipeline();
    await settleJournal();
    expect(segments.map((s) => s.text)).toEqual(['まだ途中続きの尾段']);
    expect(order[0]).toBe('まだ途中続きの尾段');
    expect(order.indexOf('stopped')).toBeGreaterThan(0);
    await bridge.saveRecovery!('{"version":1,"lines":[{"text":"まだ途中続きの尾段"}]}');
    expect(mocks.ack).toHaveBeenLastCalledWith({ through: 2 });
  });

  it('loads a durable cursor before startup replay and restores a running session instead of starting the microphone again', async () => {
    mocks.storage.set('realtime-translator.recovery', JSON.stringify({ through: 4,
      json: '{"version":1,"lines":[{"text":"持久化済みです。"}]}' }));
    const snapshot = { segments: [journalSegment(4, '持久化済みです。'), journalSegment(5, '新しく届く文です。')],
      status: { state: 'running', sessionId: 'session-a', startedAt: sessionStart } };
    mocks.journal = vi.fn(async () => snapshot);
    const bridge = createIosBridge();
    const segments: SegmentPayload[] = [], statuses: any[] = [];
    bridge.onSegment((s) => segments.push(s)); bridge.onStatus((s) => statuses.push(s));
    expect(await bridge.loadRecovery!()).toContain('持久化済みです。');
    await settleJournal();
    expect(segments.map((s) => s.text)).toEqual(['新しく届く文です。']);
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'running', resumed: true, startedAt: sessionStart }));
    await bridge.startPipeline();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe('iOS replay ordering and persistence boundaries', () => {
  it('drains older suspended finals before a newer live event can advance the dedupe cursor', async () => {
    const { segments, snapshot } = await journalSetup();
    snapshot.segments.push(journalSegment(1, '先に届くべき文です。'), journalSegment(2, '後から届く文です。'));
    emit('segment', snapshot.segments[1]);
    await settleJournal();
    expect(segments.map((s) => s.text)).toEqual(['先に届くべき文です。', '後から届く文です。']);
  });

  it('persists only the rendered prefix when the next source fragment remains open, without replaying that prefix after reload', async () => {
    const { bridge, segments, snapshot } = await journalSetup();
    snapshot.segments.push(journalSegment(1, '途中の原文', 'session-a', 0), journalSegment(2, '次の途中', 'session-a', 10));
    emit('segment', snapshot.segments[0]); emit('segment', snapshot.segments[1]);
    await settleJournal();
    expect(segments.map((s) => s.text)).toEqual(['途中の原文']);
    await bridge.saveRecovery!(JSON.stringify({ version: 1, savedAt: 1,
      lines: [{ time: '11:00:00', text: '途中の原文', translation: '' }] }));
    expect(mocks.ack).toHaveBeenLastCalledWith({ through: 1 });
    const restored = createIosBridge();
    const replayed: SegmentPayload[] = [];
    restored.onSegment((s) => replayed.push(s));
    await restored.loadRecovery!(); await settleJournal();
    await vi.advanceTimersByTimeAsync(1500);
    expect(replayed.map((s) => s.text)).toEqual(['次の途中']);
  });
});

describe('iOS native foreground translation gating', () => {
  it('uses native background state even before the document visibility event arrives', async () => {
    const { snapshot } = await journalSetup();
    emit('appActive', { active: false });
    const segment = journalSegment(1, '背景で受け取った文です。');
    snapshot.segments.push(segment); emit('segment', segment);
    await settleJournal();
    expect(mocks.translate).not.toHaveBeenCalled();
    emit('appActive', { active: true }); await settleJournal();
    expect(mocks.translate).toHaveBeenCalledTimes(1);
  });

  it('pauses an already queued native translation until foreground returns', async () => {
    const first = deferred<{ text: string }>();
    mocks.translate.mockImplementationOnce(() => first.promise);
    const { snapshot } = await journalSetup();
    const a = journalSegment(1, '前景の最初の文です。'), b = journalSegment(2, '待機している次の文です。');
    snapshot.segments.push(a, b); emit('segment', a); emit('segment', b);
    await settleJournal();
    expect(mocks.translate).toHaveBeenCalledTimes(1);
    emit('appActive', { active: false });
    first.resolve({ text: '第一句' }); await settleJournal();
    expect(mocks.translate).toHaveBeenCalledTimes(1);
    emit('appActive', { active: true }); await settleJournal();
    expect(mocks.translate).toHaveBeenCalledTimes(2);
  });
});

function nativeTranslations() {
  const state = { results: [] as any[], error: undefined as string | undefined };
  mocks.nativeConfigure = vi.fn(async () => ({ available: true, revision: 7 }));
  mocks.nativeResultDrain = vi.fn(async () => ({ results: [...state.results], ...(state.error ? { error: state.error } : {}) }));
  return state;
}
function nativeFragment(sequence: number, text: string, start = sequence - 1) {
  return { ...journalSegment(sequence, text, 'session-a', start), translationMode: 'native' as const, translationRevision: 7, target: 'zh' };
}
function nativeResult(sequence: number, text: string, state: 'pending' | 'done' | 'error' = 'done', extra: object = {}) {
  return { sequence, sessionId: 'session-a', revision: 7, target: 'zh', text, state, ...extra };
}
function nativeSnapshot(line: SegmentPayload, translation: string, completed: boolean, failed = false) {
  return JSON.stringify({ version: 1, savedAt: 1, lines: [{ time: '11:00:00', text: line.text, lang: line.lang, translation,
    nativeTranslation: { ...line.nativeTranslation, completed, failed } }] });
}

describe('iOS independent durable native translation jobs', () => {
  it('joins every native source chunk in order, normalizes target script, and acknowledges only the durably saved complete translation', async () => {
    const results = nativeTranslations();
    const { bridge, segments, translations, snapshot } = await journalSetup();
    const a = nativeFragment(1, '駅まで'), b = nativeFragment(2, '歩いてください。');
    snapshot.segments.push(a, b); emit('segment', a); emit('segment', b);
    results.results = [nativeResult(1, '車站'), nativeResult(2, '', 'pending')];
    await settleJournal();
    expect(segments).toHaveLength(1);
    expect(segments[0].nativeTranslation).toMatchObject({ sequences: [1, 2], revision: 7, target: 'zh' });
    expect(mocks.translate).not.toHaveBeenCalled();
    expect(translations.at(-1)).toMatchObject({ pending: true });
    await bridge.saveRecovery!(nativeSnapshot(segments[0], '', false));
    expect(mocks.ack).toHaveBeenLastCalledWith({ through: 2 });
    expect(mocks.nativeResultAck).not.toHaveBeenCalled();
    results.results[1] = nativeResult(2, '請步行。');
    emit('translationResultsAvailable', {}); await settleJournal();
    expect(translations.at(-1)).toMatchObject({ id: segments[0].id, text: '车站请步行。' });
    const { Preferences } = await import('@capacitor/preferences');
    vi.mocked(Preferences.set).mockRejectedValueOnce(new Error('disk full'));
    await expect(bridge.saveRecovery!(nativeSnapshot(segments[0], '车站请步行。', true))).rejects.toThrow('disk full');
    expect(mocks.nativeResultAck).not.toHaveBeenCalled();
    await bridge.saveRecovery!(nativeSnapshot(segments[0], '车站请步行。', true));
    expect(mocks.nativeResultAck).toHaveBeenLastCalledWith({ sequences: [1, 2] });
    emit('translationResultsAvailable', {}); await settleJournal();
    expect(translations.filter((t) => t.text === '车站请步行。')).toHaveLength(1);
  });

  it('keeps pending jobs independent of acknowledged source text and binds their results to a restored negative UI id', async () => {
    const results = nativeTranslations();
    const reference = { sessionId: 'session-a', revision: 7, target: 'zh', sequences: [1, 2], completed: false };
    const json = JSON.stringify({ version: 1, savedAt: 1, lines: [{ time: '11:00:00', text: '駅まで歩いてください。', lang: 'ja', translation: '', nativeTranslation: reference }] });
    mocks.storage.set('realtime-translator.recovery', JSON.stringify({ through: 2, json }));
    mocks.journal = vi.fn(async () => ({ segments: [], status: { state: 'stopped', sessionId: 'session-a', startedAt: sessionStart } }));
    results.results = [nativeResult(1, '車站'), nativeResult(2, '請步行。')];
    const bridge = createIosBridge();
    const translations: TranslationPayload[] = [];
    bridge.onSegment(() => {}); bridge.onTranslation((t) => translations.push(t));
    expect(await bridge.loadRecovery!()).toBe(json);
    await settleJournal();
    expect(translations).toHaveLength(0);
    expect(mocks.nativeResultAck).not.toHaveBeenCalled();
    bridge.restoreNativeTranslationRows!([{ id: -2, text: '駅まで歩いてください。', lang: 'ja', translation: '', nativeTranslation: reference }]);
    await settleJournal();
    expect(translations).toEqual([{ id: -2, text: '车站请步行。' }]);
    expect(mocks.translate).not.toHaveBeenCalled();
    await bridge.saveRecovery!(nativeSnapshot({ ...fragment('駅まで歩いてください。'), nativeTranslation: reference }, '车站请步行。', true));
    expect(mocks.nativeResultAck).toHaveBeenLastCalledWith({ sequences: [1, 2] });
  });

  it('refuses to archive while native translation is pending and patches the final translation into the retry snapshot', async () => {
    const results = nativeTranslations();
    const { bridge, segments, snapshot } = await journalSetup();
    const segment = nativeFragment(1, '翻訳を待っている文です。');
    snapshot.segments.push(segment); emit('segment', segment);
    results.results = [nativeResult(1, '', 'pending')]; await settleJournal();
    await bridge.stopPipeline(); await settleJournal();
    const lines = [{ time: '11:00:00', text: segments[0].text, translation: '', nativeTranslation: segments[0].nativeTranslation }];
    await expect(bridge.saveArchive('pending', lines)).rejects.toThrow('翻译仍在处理中');
    expect(mocks.storage.get('realtime-translator.archives')).toBeUndefined();
    expect(mocks.nativeResultAck).not.toHaveBeenCalled();
    results.results = [nativeResult(1, '正在等待翻译的句子。')];
    emit('translationResultsAvailable', {}); await settleJournal();
    await bridge.saveArchive('complete', lines);
    const saved = JSON.parse(mocks.storage.get('realtime-translator.archives')!);
    expect(saved[0].lines[0]).toMatchObject({ translation: '正在等待翻译的句子。', nativeTranslation: { completed: true } });
  });

  it('does not show translation pending for the same language and preserves core script conversion', async () => {
    const results = nativeTranslations();
    const { bridge, segments, translations, snapshot } = await journalSetup();
    const segment = { ...nativeFragment(1, '這是繁體中文。'), lang: 'zh', duration: 3 };
    snapshot.segments.push(segment); emit('segment', segment); await settleJournal();
    await bridge.stopPipeline(); await settleJournal();
    expect(translations.some((t) => t.pending)).toBe(false);
    expect(translations.at(-1)).toMatchObject({ text: '这是繁体中文。' });
    expect(mocks.translate).not.toHaveBeenCalled();
    expect(segments).toHaveLength(1);
    results.results = [nativeResult(1, '', 'done', { skipped: true })];
  });

  it('surfaces a translation journal failure on its row while leaving ASR running and permitting original-text archive', async () => {
    const results = nativeTranslations();
    const { bridge, segments, translations, snapshot } = await journalSetup();
    const segment = nativeFragment(1, '原文を残す必要があります。');
    snapshot.segments.push(segment); emit('segment', segment); await settleJournal();
    results.error = 'Translation queue is full';
    emit('translationResultsAvailable', {}); await settleJournal();
    expect(translations.at(-1)).toMatchObject({ failed: true, error: 'Translation queue is full' });
    expect(mocks.stop).not.toHaveBeenCalled();
    await bridge.saveArchive('original', [{ time: '', text: segments[0].text, translation: '', nativeTranslation: segments[0].nativeTranslation }]);
    expect(mocks.nativeResultAck).not.toHaveBeenCalled();
  });

  it('acknowledges completed detached jobs only after the user durably discards the recovery offer', async () => {
    const results = nativeTranslations();
    const reference = { sessionId: 'session-a', revision: 7, target: 'zh', sequences: [1], completed: false };
    mocks.storage.set('realtime-translator.recovery', JSON.stringify({ through: 1,
      json: JSON.stringify({ version: 1, savedAt: 1, lines: [{ time: '', text: '未復元です。', lang: 'ja', translation: '', nativeTranslation: reference }] }) }));
    mocks.journal = vi.fn(async () => ({ segments: [], status: { state: 'stopped', sessionId: 'session-a', startedAt: sessionStart } }));
    results.results = [nativeResult(1, '尚未恢复。')];
    const bridge = createIosBridge(); bridge.onSegment(() => {});
    await bridge.loadRecovery!(); await settleJournal();
    expect(mocks.nativeResultAck).not.toHaveBeenCalled();
    await bridge.clearRecovery!();
    expect(mocks.nativeResultAck).toHaveBeenLastCalledWith({ sequences: [1] });
  });

  it('rejects results from another translation revision and supports auto-language native routing with an explicit fixed target', async () => {
    const results = nativeTranslations();
    const { bridge, snapshot, translations } = await journalSetup();
    const segment = nativeFragment(1, '正しい設定を使う文です。');
    snapshot.segments.push(segment); emit('segment', segment);
    results.results = [nativeResult(1, '错误旧配置', 'done', { revision: 6 })]; await settleJournal();
    expect(translations.some((t) => t.text === '错误旧配置')).toBe(false);
    expect(translations.at(-1)).toMatchObject({ pending: true });
    results.results = [nativeResult(1, '使用正确设置。')]; emit('translationResultsAvailable', {}); await settleJournal();
    expect(translations.at(-1)).toMatchObject({ text: '使用正确设置。' });
    await bridge.stopPipeline();
    await bridge.saveSettings({ asr: { language: 'auto' } });
    expect(mocks.nativeConfigure).toHaveBeenLastCalledWith({ enabled: true, engine: 'local', target: 'zh' });
  });
});
