import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentenceAssembler, SENTENCE_IDLE_MS, SENTENCE_MAX_WAIT_MS } from './sentence-assembler';
import { SAMPLE_RATE, TranscriptionPipeline, type AsrInferenceEngine } from './transcription-pipeline';
import type { SegmentPayload } from '../types';

afterEach(() => vi.useRealTimers());

type Token = { at: number; text: string; lang?: string };
class TimelineEngine implements AsrInferenceEngine {
  detected = false;
  calls: { start: number; end: number }[] = [];
  constructor(readonly tokens: Token[]) {}
  acceptVadWindow(): void {}
  isSpeechDetected(): boolean { return this.detected; }
  drainVad(): void {}
  flushVad(): void {}
  transcribe(samples: Float32Array) {
    let count = samples.length;
    while (count && samples[count - 1] === 0) count--;
    if (!count) return { text: '', lang: '<|ja|>', tokens: [], timestamps: [] };
    const start = (samples[0] - 1) / SAMPLE_RATE;
    const end = start + count / SAMPLE_RATE;
    this.calls.push({ start, end });
    const own = this.tokens.filter(t => t.at >= start - 1e-6 && t.at < end - 1e-6);
    return {
      text: own.map(t => t.text).join(''), lang: `<|${own[0]?.lang ?? 'ja'}|>`,
      tokens: own.map(t => t.text), timestamps: own.map(t => t.at - start),
      durations: own.map(() => 0.12),
    };
  }
}

function timeline(text: string, from = 0, lang = 'ja', step = 0.18): Token[] {
  return Array.from(text).map((text, i) => ({ text, at: from + i * step, lang }));
}

function session(tokens: Token[]) {
  vi.useFakeTimers();
  const fragments: SegmentPayload[] = [];
  const finals: SegmentPayload[] = [];
  const reasons: string[] = [];
  const assembler = new SentenceAssembler(s => finals.push(s), { onFlush: e => reasons.push(e.reason) });
  const engine = new TimelineEngine(tokens);
  const core = new TranscriptionPipeline(engine, {
    onSegment: s => { fragments.push(s); assembler.push(s); },
    onPartial: p => { if (p.text) assembler.touch(); },
  });
  let fed = 0;
  const feed = (seconds: number, speech: boolean) => {
    engine.detected = speech;
    for (let i = 0; i < Math.round(seconds * 10); i++) {
      const chunk = new Float32Array(SAMPLE_RATE / 10);
      for (let k = 0; k < chunk.length; k++) chunk[k] = ++fed;
      core.acceptWaveform(chunk);
      vi.advanceTimersByTime(100);
    }
  };
  const stop = () => { core.flush(); assembler.flush(); };
  return { core, assembler, engine, feed, stop, fragments, finals, reasons };
}

describe('window retention through the unchanged sentence assembler', () => {
  it('preserves a continuous clause exactly once across forced fragments and stop', () => {
    const text = '基本の十項目かける五点というそういう採点方法でもう一つ上に世間的な評価を五十項目かける一点としてここに載せています';
    const h = session(timeline(text));
    h.feed(12, true);
    h.stop(); h.stop();
    expect(h.fragments.length).toBeGreaterThan(1);
    expect(h.fragments.map(s => s.text).join('')).toBe(text);
    expect(h.finals.map(s => s.text).join('')).toBe(text);
    for (let i = 1; i < h.fragments.length; i++) {
      const previous = h.fragments[i - 1];
      expect(h.fragments[i].start).toBeCloseTo(previous.start + previous.duration, 5);
    }
    expect(h.fragments.reduce((n, s) => n + s.duration, 0)).toBeCloseTo(12, 5);
    expect(h.reasons).not.toContain('gap');
  });

  it('retains genuinely repeated utterances instead of deduplicating equal words globally', () => {
    const text = 'はい一万円なら借りられる人はい一万円なら借りられる人';
    const h = session(timeline(text, 0, 'ja', 0.3));
    h.feed(9, true); h.stop();
    expect(h.finals.map(s => s.text).join('')).toBe(text);
    expect(h.finals.map(s => s.text).join('').split('一万円なら借りられる人')).toHaveLength(3);
    expect(h.reasons).not.toContain('gap');
  });

  it('keeps active continuation fragments pending through idle but respects the hard deadline', () => {
    const text = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
    const h = session(timeline(text, 0, 'ja', 0.35));
    h.feed(9, true);
    expect(h.fragments.length).toBeGreaterThan(0);
    expect(h.finals).toHaveLength(0);
    expect(h.reasons).not.toContain('idle');
    for (let elapsed = 0; elapsed < SENTENCE_MAX_WAIT_MS; elapsed += 500) {
      h.assembler.touch(); vi.advanceTimersByTime(500);
    }
    expect(h.reasons).toContain('deadline');
    h.stop();
    expect(h.finals.map(s => s.text).join('')).toBe(h.fragments.map(s => s.text).join(''));
  });

  it('keeps complete Japanese sentences separate without introducing fragment-sized rows', () => {
    const first = 'これは日常の生活と人間の感情についての説明です。';
    const second = '次の説明を始めます。';
    const h = session([...timeline(first, 0, 'ja', 0.18), ...timeline(second, 6.4, 'ja', 0.18)]);
    h.feed(6, true); h.feed(0.4, false);
    h.feed(2.5, true); h.feed(0.4, false); h.stop();
    expect(h.finals.map(s => s.text)).toEqual([first, second]);
    expect(h.reasons).toEqual(['short-sentence', 'short-sentence']);
  });

  it('keeps real pauses and language changes as boundaries after retained windows', () => {
    const first = 'まだ説明の途中';
    const second = '次に進む';
    const english = 'next topic';
    const h = session([
      ...timeline(first, 0, 'ja', 0.2),
      ...timeline(second, 4.2, 'ja', 0.2),
      ...timeline(english, 6.2, 'en', 0.12),
    ]);
    h.feed(2, true); h.feed(2.2, false);
    h.feed(1, true); h.feed(1, false);
    h.feed(1.5, true); h.stop();
    expect(h.finals.map(s => s.text)).toEqual([first, second, english]);
    expect(h.finals.map(s => s.lang)).toEqual(['ja', 'ja', 'en']);
    expect(h.finals[1].start - (h.finals[0].start + h.finals[0].duration)).toBeGreaterThan(1.5);
    expect(h.reasons).toContain('idle');
    vi.advanceTimersByTime(SENTENCE_IDLE_MS * 2);
    expect(h.finals).toHaveLength(3);
  });
});
