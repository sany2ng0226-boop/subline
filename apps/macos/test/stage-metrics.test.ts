import { expect, it } from 'vitest';
import { sentenceTiming, translationTiming, distribution } from './stage-metrics';
const seg = (id: number, start: number, duration: number, text: string) => ({ id, start, duration, text, lang: 'ja' });
it('excludes the next pushed fragment during a gap flush and retains additive stage accounting', () => {
  const sentence = seg(1, 0, 2, '前半後半');
  const metrics = sentenceTiming(sentence, 4000, [
    { atMs: 1500, segment: seg(1, 0, 1, '前半') },
    { atMs: 2600, segment: seg(2, 1, 1, '後半') },
    { atMs: 3900, segment: seg(3, 4, 1, '次の話') },
  ]);
  expect(metrics.rawIds).toEqual([1, 2]);
  expect(metrics.recognitionCommitMs).toBe(600);
  expect(metrics.assemblyWaitMs).toBe(1400);
  expect(metrics.assemblyResidenceMs).toBe(2500);
  const tr = translationTiming(4000, 4010, 4210, 4810, metrics.audioEndMs);
  expect(metrics.recognitionCommitMs + metrics.assemblyWaitMs + tr.dispatchMs + tr.queueWaitMs + tr.translationMs).toBe(tr.endToEndMs);
});
it('rejects incomplete correlation instead of publishing plausible wrong timings', () => {
  expect(() => sentenceTiming(seg(1, 0, 2, '完整'), 3000, [])).toThrow();
  expect(() => sentenceTiming(seg(1, 0, 2, '完整'), 3000, [{ atMs: 2500, segment: seg(1, 0, 2, '缺失') }])).toThrow();
});
it('reports nearest-rank percentiles and an explicit empty sample', () => {
  expect(distribution([])).toBeNull();
  expect(distribution([40, 10, 30, 20])).toEqual({ count: 4, mean: 25, p50: 20, p95: 40, max: 40 });
});
