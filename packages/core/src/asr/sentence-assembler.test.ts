import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentenceAssembler, SENTENCE_IDLE_MS, SENTENCE_MAX_WAIT_MS } from './sentence-assembler';
import type { SegmentPayload } from '../types';

afterEach(() => vi.useRealTimers());
const seg = (text: string, start = 0, duration = 1, lang = 'ja'): SegmentPayload =>
  ({ id: start, text, start, duration, lang });

describe('sentence assembly', () => {
  it('keeps continuation fragments intact and flushes every character on stop', () => {
    const out: SegmentPayload[] = [];
    const a = new SentenceAssembler((s) => out.push(s));
    const parts = ['人間の基本的なですね', '思いっていうかあるいは', '人間の基本的な感情とかですね'];
    parts.forEach((s, i) => a.push(seg(s, i)));
    expect(out).toHaveLength(0);
    expect(a.text).toBe(parts.join(''));
    a.flush(); a.flush();
    expect(out.map((s) => s.text).join('')).toBe(parts.join(''));
    expect(out[0]).toMatchObject({ start: 0, duration: 3 });
  });

  it('flushes on idle, but active partials cannot postpone the hard deadline', () => {
    vi.useFakeTimers();
    const emit = vi.fn(); const a = new SentenceAssembler(emit);
    a.push(seg('その'));
    vi.advanceTimersByTime(SENTENCE_IDLE_MS);
    expect(emit).toHaveBeenCalledTimes(1);
    a.push(seg('この続きは', 2));
    for (let ms = 0; ms < SENTENCE_MAX_WAIT_MS; ms += 500) {
      a.touch(); vi.advanceTimersByTime(500);
    }
    expect(emit).toHaveBeenCalledTimes(2);
    expect(a.text).toBe('');
  });

  it('does not mix languages, long silences, or sessions', () => {
    const out: SegmentPayload[] = []; const a = new SentenceAssembler((s) => out.push(s));
    a.push(seg('日本語')); a.push(seg('English', 1, 1, 'en'));
    a.push(seg('Next', 5, 1, 'en'));
    expect(out.map((s) => s.text)).toEqual(['日本語', 'English']);
    a.reset(); a.flush(); expect(out).toHaveLength(2);
  });

  it('bounds continuous speech using audio time and closes a complete sentence', () => {
    const out: SegmentPayload[] = []; const a = new SentenceAssembler((s) => out.push(s));
    a.push(seg('これは日常の生活と人間の感情についての説明です。', 0, 4));
    expect(out).toHaveLength(1);
    a.push(seg('でも', 4, 5)); a.push(seg('その続きを話すと', 9, 5));
    expect(out).toHaveLength(1);
    a.push(seg('まだ途中ですが', 14, 4));
    expect(out).toHaveLength(2);
    expect(out[1].text).toBe('でもその続きを話すとまだ途中ですが');
  });

  it('allows a model to defer a boundary without postponing the hard deadline', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(); const judge = vi.fn(async () => false);
    const a = new SentenceAssembler(emit, { judge });
    a.push(seg('この内容はまだ途中の説明なのですが。', 0, 4));
    await vi.advanceTimersByTimeAsync(SENTENCE_IDLE_MS);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SENTENCE_MAX_WAIT_MS);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('falls back when a judge hangs and ignores its late answer', async () => {
    vi.useFakeTimers();
    let answer!: (value: boolean) => void;
    const emit = vi.fn();
    const a = new SentenceAssembler(emit, {
      judge: () => new Promise((resolve) => { answer = resolve; }), judgeTimeoutMs: 300,
    });
    a.push(seg('説明の途中'));
    await vi.advanceTimersByTimeAsync(SENTENCE_IDLE_MS + 300);
    expect(emit).toHaveBeenCalledTimes(1);
    a.push(seg('次の会話', 2));
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledTimes(1);
    a.reset();
  });

  it('invalidates idle decisions when speech resumes and preserves all fragments', async () => {
    vi.useFakeTimers();
    let answer!: (value: boolean) => void;
    const out: SegmentPayload[] = [];
    const a = new SentenceAssembler((s) => out.push(s), {
      judge: () => new Promise((resolve) => { answer = resolve; }),
    });
    a.push(seg('前半'));
    await vi.advanceTimersByTimeAsync(SENTENCE_IDLE_MS);
    a.touch(); answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toHaveLength(0);
    a.push(seg('後半', 1)); a.flush();
    expect(out.map((s) => s.text).join('')).toBe('前半後半');
    a.reset();
  });

  it('reports hard limits that bypass the default judge', async () => {
    vi.useFakeTimers();
    const judge = vi.fn(async () => false); const flushed = vi.fn();
    const a = new SentenceAssembler(() => {}, { judge, onFlush: flushed });
    a.push(seg('途中', 0, 14));
    expect(flushed.mock.calls[0][0].reason).toBe('audio-limit');
    expect(judge).not.toHaveBeenCalled();
    a.push(seg('次の途中', 15));
    for (let i = 0; i < 24; i++) { a.touch(); await vi.advanceTimersByTimeAsync(500); }
    expect(flushed.mock.calls[1][0].reason).toBe('deadline');
    expect(judge).not.toHaveBeenCalled();
  });

  it('lets reviewed limits wait for the next fragment, then applies a final safety cap', async () => {
    vi.useFakeTimers();
    const out: SegmentPayload[] = []; const reasons: string[] = [];
    const a = new SentenceAssembler((s) => out.push(s), {
      judge: async () => false, reviewLimits: true, maxWaitMs: 8000, maxAudioSeconds: 10, onFlush: (e) => reasons.push(e.reason),
    });
    a.push(seg('説明の途中', 0, 10));
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toHaveLength(0);
    a.push(seg('続き', 10, 1));
    await vi.advanceTimersByTimeAsync(12000);
    expect(out.map((s) => s.text)).toEqual(['説明の途中続き']);
    expect(reasons).toEqual(['safety-deadline']);
    a.push(seg('長い語り', 12, 14));
    expect(reasons[1]).toBe('safety-audio');
    a.reset();
  });

  it('can ask about a short complete fragment before punctuation length gates', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(); const judge = vi.fn(async () => true);
    const a = new SentenceAssembler(emit, { judge, reviewEverySegment: true, reviewLimits: true });
    a.push(seg('終わりです。', 0, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    a.reset();
  });

  it('releases a short Japanese predicate by default without model inference', () => {
    const out: SegmentPayload[] = []; const reasons: string[] = [];
    const a = new SentenceAssembler((s) => out.push(s), {
      onFlush: (e) => reasons.push(e.reason),
    });
    a.push(seg('説明します。', 0, 1));
    expect(out).toHaveLength(1);
    expect(reasons).toEqual(['short-sentence']);
    a.push(seg('説明するので。', 1));
    expect(out).toHaveLength(1);
    a.reset();
  });
});


it('keeps the last audio endpoint through merging and delayed flush', () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const a = new SentenceAssembler(emit);
  a.push({ ...seg('その', 0), speechEndAt: 1000 });
  a.push({ ...seg('続き', 1), speechEndAt: 2000 });
  vi.advanceTimersByTime(SENTENCE_IDLE_MS);
  expect(emit.mock.calls[0][0].speechEndAt).toBe(2000);
});
