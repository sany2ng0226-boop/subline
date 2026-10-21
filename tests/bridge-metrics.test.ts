import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudTranslator, makeDefaults, type PipelineMetrics } from '../packages/core/src';
import { RealtimeAsr } from '../apps/ios/native-plugin';
import { createIosBridge } from '../apps/ios/src/bridge';

const native = vi.hoisted(() => ({ listeners: new Map<string, (payload: any) => void>() }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(async () => ({ value: null })), set: vi.fn(async () => undefined) },
}));
vi.mock('../apps/ios/native-plugin', () => ({
  RealtimeAsr: {
    addListener: vi.fn(async (name: string, callback: (payload: any) => void) => {
      native.listeners.set(name, callback);
      return { remove: vi.fn() };
    }),
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
  },
  RealtimeTranslate: { translate: vi.fn() },
}));

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const segment = { id: 0, text: 'hello', lang: 'en', start: 0, duration: 1, speechEndAt: 900 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  vi.stubGlobal('navigator', { languages: ['ja'], onLine: true });
  vi.stubGlobal('window', new EventTarget());
  native.listeners.clear();
  vi.mocked(RealtimeAsr.start).mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function recordingBridge() {
  const bridge = createIosBridge();
  await bridge.getSettings();
  const settings = makeDefaults(['ja']);
  settings.nativeLang = 'ja';
  settings.translation.enabled = true;
  settings.translation.engine = 'cloud';
  await bridge.saveSettings(settings);
  await bridge.startPipeline();
  native.listeners.get('status')!({ state: 'running' });
  return bridge;
}

describe('iOS TS bridge metrics', () => {
  it('tracks pending/finished requests, browser connectivity, timer stop and unsubscribe', async () => {
    let finish!: (text: string) => void;
    vi.spyOn(CloudTranslator.prototype, 'translate').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const bridge = await recordingBridge();
    const values: PipelineMetrics[] = [];
    const unsubscribe = bridge.onMetrics!(value => values.push(value));
    native.listeners.get('segment')!(segment);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(values.at(-1)).toMatchObject({ asrLatencyMs: 100, queueDepth: 1, network: 'online', engine: 'cloud' });
    finish('こんにちは');
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(values.at(-1)).toMatchObject({ translateLatencyMs: 1000, cloudRttMs: 1000, queueDepth: 0 });
    const settings = makeDefaults(['ja']);
    settings.translation.engine = 'cloud';
    settings.translation.enabled = false;
    await bridge.saveSettings(settings);
    await vi.advanceTimersByTimeAsync(1000);
    expect(values.at(-1)?.engine).toBe('local');
    expect(values.at(-1)?.cloudRttMs).toBeUndefined();
    settings.translation.enabled = true;
    await bridge.saveSettings(settings);
    await vi.advanceTimersByTimeAsync(1000);
    expect(values.at(-1)?.engine).toBe('cloud');
    expect(values.at(-1)?.cloudRttMs).toBeUndefined();
    vi.stubGlobal('navigator', { languages: ['ja'], onLine: false });
    window.dispatchEvent(new Event('offline'));
    expect(values.at(-1)?.network).toBe('offline');
    unsubscribe();
    const count = values.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(values).toHaveLength(count);
    const callback = vi.fn();
    bridge.onMetrics!(callback);
    await bridge.stopPipeline();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores previous-session completions and omits unavailable native ASR timestamps', async () => {
    let finish!: (text: string) => void;
    vi.spyOn(CloudTranslator.prototype, 'translate').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const bridge = await recordingBridge();
    native.listeners.get('segment')!({ ...segment, speechEndAt: undefined });
    await flush();
    await bridge.stopPipeline();
    await bridge.startPipeline();
    native.listeners.get('status')!({ state: 'running' });
    finish('古い結果');
    await flush();
    const callback = vi.fn();
    bridge.onMetrics!(callback);
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback.mock.calls[0][0]).toMatchObject({ queueDepth: 0, network: 'online' });
    expect(callback.mock.calls[0][0].translateLatencyMs).toBeUndefined();
    expect(callback.mock.calls[0][0].asrLatencyMs).toBeUndefined();
    expect(callback.mock.calls[0][0].cloudRttMs).toBeUndefined();
    native.listeners.get('status')!({ state: 'error' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it.each(['failure', 'rejection'])('stops a timer started before startup %s', async (outcome) => {
    const bridge = createIosBridge();
    await bridge.getSettings();
    vi.mocked(RealtimeAsr.start).mockImplementationOnce(async () => {
      native.listeners.get('status')!({ state: 'running' });
      if (outcome === 'rejection') throw new Error('failed');
      return { ok: false, error: 'failed' };
    });
    const callback = vi.fn();
    bridge.onMetrics!(callback);
    expect((await bridge.startPipeline()).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(callback).not.toHaveBeenCalled();
  });

});
