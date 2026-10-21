import type { PipelineMetrics } from './types';

function sample(values: number[], duration: number): void {
  if (!Number.isFinite(duration) || duration < 0) return;
  values.push(duration);
  if (values.length > 5) values.shift();
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Pure session accounting: callers supply timestamps from the same epoch clock.
 * Hosts currently report cloud failures per line; no cloud-to-local fallback exists.
 * The reserved fallback-local status notice must only be emitted if that behavior is added.
 */
export class MetricsAggregator {
  private asr: number[] = [];
  private translations: number[] = [];
  private pending = new Map<string, number>();

  segment(speechEndAt: number | undefined, finalizedAt: number): void {
    if (speechEndAt !== undefined) sample(this.asr, finalizedAt - speechEndAt);
  }

  requested(id: string, requestedAt: number): void {
    if (!this.pending.has(id)) this.pending.set(id, requestedAt);
  }

  completed(id: string, completedAt: number, failed = false): void {
    const requestedAt = this.pending.get(id);
    this.pending.delete(id);
    if (requestedAt !== undefined && !failed) sample(this.translations, completedAt - requestedAt);
  }

  reset(): void {
    this.asr = [];
    this.translations = [];
    this.pending.clear();
  }

  snapshot(): Pick<PipelineMetrics, 'asrLatencyMs' | 'translateLatencyMs'> & { queueDepth: number } {
    return {
      asrLatencyMs: median(this.asr),
      translateLatencyMs: median(this.translations),
      queueDepth: this.pending.size,
    };
  }
}
