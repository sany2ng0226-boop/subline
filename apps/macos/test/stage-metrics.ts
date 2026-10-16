import type { SegmentPayload } from '@rt/core';
export const clockMs = (): number => performance.timeOrigin + performance.now();
export interface TimedFragment { atMs: number; segment: SegmentPayload }
export function sentenceTiming(sentence: SegmentPayload, finalizedMs: number, fragments: TimedFragment[]) {
  // A gap/language flush can happen while the next fragment is already being pushed.
  const matching = fragments.filter(({ segment: s }) => s.start >= sentence.start - 0.0001 &&
    s.start + s.duration <= sentence.start + sentence.duration + 0.0001);
  if (!matching.length) throw new Error(`No ASR fragments for sentence ${sentence.id}`);
  if (matching.map(x => x.segment.text).join('').replace(/\s/g, '') !== sentence.text.replace(/\s/g, '')) {
    throw new Error(`Fragment correlation lost text for sentence ${sentence.id}`);
  }
  const audioEndMs = (sentence.start + sentence.duration) * 1000;
  const firstRawMs = Math.min(...matching.map(x => x.atMs));
  const lastRawMs = Math.max(...matching.map(x => x.atMs));
  return { audioEndMs, firstRawMs, lastRawMs,
    recognitionCommitMs: lastRawMs - audioEndMs,
    assemblyWaitMs: finalizedMs - lastRawMs,
    assemblyResidenceMs: finalizedMs - firstRawMs,
    rawIds: matching.map(x => x.segment.id) };
}
export function translationTiming(finalizedMs: number, enqueuedMs: number, startedMs: number, completedMs: number, audioEndMs: number) {
  return { dispatchMs: enqueuedMs - finalizedMs, queueWaitMs: startedMs - enqueuedMs,
    translationMs: completedMs - startedMs, endToEndMs: completedMs - audioEndMs };
}
export function distribution(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: percentile(0.5), p95: percentile(0.95), max: sorted[sorted.length - 1] };
}
