import { describe, expect, it } from 'vitest';
import { MetricsAggregator } from './metrics';

describe('MetricsAggregator', () => {
  it('reports unknown latencies until valid timestamps arrive', () => {
    const metrics = new MetricsAggregator();
    metrics.segment(undefined, 100);
    metrics.segment(200, 100);
    metrics.segment(NaN, 100);
    metrics.completed('missing', 100);
    expect(metrics.snapshot()).toEqual({ asrLatencyMs: undefined, translateLatencyMs: undefined, queueDepth: 0 });
  });

  it('takes the median of only the last five samples, without sorting the rolling window', () => {
    const metrics = new MetricsAggregator();
    for (const latency of [900, 10, 40, 30, 20, 50]) metrics.segment(1000, 1000 + latency);
    expect(metrics.snapshot().asrLatencyMs).toBe(30);
    metrics.segment(1000, 1060);
    expect(metrics.snapshot().asrLatencyMs).toBe(40);
  });

  it('tracks concurrent translations, ignores duplicate pending and excludes failures', () => {
    const metrics = new MetricsAggregator();
    metrics.requested('a', 100);
    metrics.requested('a', 200);
    metrics.requested('b', 100);
    expect(metrics.snapshot().queueDepth).toBe(2);
    metrics.completed('b', 200, true);
    metrics.completed('a', 400);
    metrics.completed('a', 900);
    expect(metrics.snapshot()).toMatchObject({ queueDepth: 0, translateLatencyMs: 300 });
    for (const [id, latency] of [10, 20, 30, 40, 50].entries()) {
      metrics.requested(String(id), 1000);
      metrics.completed(String(id), 1000 + latency);
    }
    expect(metrics.snapshot().translateLatencyMs).toBe(30);
  });

  it('averages even medians, rejects invalid durations and resets between sessions', () => {
    const metrics = new MetricsAggregator();
    metrics.segment(0, 10);
    metrics.segment(0, 20);
    expect(metrics.snapshot().asrLatencyMs).toBe(15);
    metrics.requested('a', 100);
    metrics.completed('a', 50);
    metrics.requested('b', NaN);
    metrics.completed('b', 200);
    expect(metrics.snapshot().translateLatencyMs).toBeUndefined();
    metrics.requested('c', 100);
    metrics.reset();
    expect(metrics.snapshot()).toEqual({ asrLatencyMs: undefined, translateLatencyMs: undefined, queueDepth: 0 });
    metrics.completed('c', 300);
    expect(metrics.snapshot().translateLatencyMs).toBeUndefined();
  });
});
