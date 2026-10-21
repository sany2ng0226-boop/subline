import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetricsController } from './metrics';

function harness() {
  const settings = { enabled: true, engine: 'cloud', cloud: { baseURL: 'https://user:secret@example.com/v1?key=secret' } };
  const publish = vi.fn();
  const online = vi.fn(() => true);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({ ok: true } as Response);
  const controller = createMetricsController({ settings: () => settings, publish, online, fetch });
  return { controller, settings, publish, online, fetch };
}
afterEach(() => vi.useRealTimers());
describe('macOS metrics lifecycle', () => {
  it('samples every second only while running and resets session samples', async () => {
    vi.useFakeTimers();
    const h = harness(); h.settings.engine = 'local';
    h.controller.start();
    h.controller.aggregator.segment(100, 150);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.publish).toHaveBeenLastCalledWith(expect.objectContaining({ asrLatencyMs: 50, queueDepth: 0, network: 'online', engine: 'local' }));
    expect(h.fetch).not.toHaveBeenCalled();
    h.controller.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.publish).toHaveBeenCalledTimes(1);
    h.controller.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.publish.mock.lastCall![0].asrLatencyMs).toBeUndefined();
    h.controller.stop();
  });
  it('probes at 15 second cadence, strips credentials, and reports failed probes degraded', async () => {
    vi.useFakeTimers();
    const h = harness(); h.controller.start();
    await vi.advanceTimersByTimeAsync(1000);
    const [url, options] = h.fetch.mock.calls[0];
    expect(String(url)).toBe('https://example.com/v1');
    expect(options).toEqual({ method: 'HEAD', signal: expect.any(AbortSignal), credentials: 'omit', redirect: 'error' });
    await vi.advanceTimersByTimeAsync(14000); expect(h.fetch).toHaveBeenCalledTimes(1);
    h.fetch.mockRejectedValue(new Error('unreachable'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.publish.mock.lastCall![0].network).toBe('degraded');
    h.online.mockReturnValue(false); await vi.advanceTimersByTimeAsync(1000);
    expect(h.publish.mock.lastCall![0].network).toBe('offline');
    h.controller.stop();
  });
  it('aborts in-flight probes on stop and ignores results from the old session', async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish!: (response: Response) => void;
    h.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    h.controller.start(); await vi.advanceTimersByTimeAsync(1000);
    const signal = h.fetch.mock.calls[0][1]!.signal!;
    await vi.advanceTimersByTimeAsync(4000); expect(h.fetch).toHaveBeenCalledTimes(1);
    h.controller.stop(); expect(signal.aborted).toBe(true);
    h.settings.engine = 'local'; h.controller.start();
    finish({ ok: true } as Response); await vi.advanceTimersByTimeAsync(1000);
    expect(h.publish.mock.lastCall![0]).not.toHaveProperty('cloudRttMs');
    h.controller.stop();
  });
  it('clears cloud samples and aborts probes when the configured endpoint changes', async () => {
    vi.useFakeTimers(); const h = harness();
    let finish!: (response: Response) => void;
    h.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    h.controller.start(); await vi.advanceTimersByTimeAsync(1000);
    const oldSignal = h.fetch.mock.calls[0][1]!.signal!;
    const oldFinish = finish;
    h.settings.cloud.baseURL = 'https://other.example/v1';
    await vi.advanceTimersByTimeAsync(1000);
    expect(oldSignal.aborted).toBe(true);
    expect(String(h.fetch.mock.calls[1][0])).toBe('https://other.example/v1');
    oldFinish({ ok: true } as Response);
    h.settings.engine = 'local'; await vi.advanceTimersByTimeAsync(1000);
    expect(h.publish.mock.lastCall![0]).toMatchObject({ engine: 'local', network: 'online' });
    expect(h.publish.mock.lastCall![0]).not.toHaveProperty('cloudRttMs');
    h.controller.stop();
  });
  it('aborts timed out probes after five seconds', async () => {
    vi.useFakeTimers(); const h = harness();
    h.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('timeout')));
    }));
    h.controller.start(); await vi.advanceTimersByTimeAsync(7000);
    expect(h.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(h.publish.mock.lastCall![0].network).toBe('degraded'); h.controller.stop();
  });
});
