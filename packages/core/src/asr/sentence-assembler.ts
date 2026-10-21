import type { SegmentPayload } from '../types';

// Keep decoder windows short; these limits apply only to already recognized text.
export const SENTENCE_IDLE_MS = 1400;
export const SENTENCE_MAX_WAIT_MS = 12000;
const MAX_AUDIO_SECONDS = 14;
const MAX_CHARS = 180;
// Reviewed text thresholds can wait for another fragment, but cannot move these final caps.
const LIMIT_GRACE_SECONDS = 4;
const CONTINUATION = /(?:けど|けれども|ので|ながら|とか|という|っていう|のと|あるいは|そして|その|この)[。！？.!?\s]*$/u;

export type BoundaryJudge = (text: string, lang: string, signal: AbortSignal) => Promise<boolean>;
export type BoundaryReason = 'sentence' | 'short-sentence' | 'idle' | 'deadline' | 'audio-limit' | 'fragment';
export type FlushReason = BoundaryReason | 'chars-limit' | 'gap' | 'language' | 'stop' |
  'model-end' | 'model-fallback' | 'safety-deadline' | 'safety-audio';
export interface SentenceAssemblyOptions {
  judge?: BoundaryJudge;
  judgeTimeoutMs?: number;
  onDecision?: (decision: { text: string; reason: BoundaryReason; result: 'end' | 'wait' | 'fallback'; ms: number }) => void;
  onFlush?: (event: { reason: FlushReason; text: string; start: number; duration: number }) => void;
  reviewLimits?: boolean;
  reviewEverySegment?: boolean;
  shortSentenceRule?: boolean;
  maxWaitMs?: number;
  maxAudioSeconds?: number;
}

export class SentenceAssembler {
  private pending: SegmentPayload | null = null;
  private idle?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private safety?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private requestReason?: BoundaryReason;
  private requestTimer?: ReturnType<typeof setTimeout>;
  private waitedText?: string;

  constructor(private readonly emit: (segment: SegmentPayload) => void,
    private readonly options: SentenceAssemblyOptions = {}) {}

  get text(): string { return this.pending?.text ?? ''; }

  push(segment: SegmentPayload): void {
    this.cancelRequest();
    if (this.pending && (segment.lang !== this.pending.lang ||
      segment.start - (this.pending.start + this.pending.duration) > 1.5)) {
      this.flush(segment.lang !== this.pending.lang ? 'language' : 'gap');
    }
    if (!this.pending) {
      this.pending = { ...segment };
      const wait = this.options.maxWaitMs ?? SENTENCE_MAX_WAIT_MS;
      this.deadline = setTimeout(() => {
        if (this.options.reviewLimits && this.options.judge) this.consider('deadline');
        else this.flush('deadline');
      }, wait);
      if (this.options.reviewLimits && this.options.judge) {
        this.safety = setTimeout(() => this.flush('safety-deadline'), wait + LIMIT_GRACE_SECONDS * 1000);
      }
    } else {
      const separator = /[A-Za-z0-9]$/.test(this.pending.text) && /^[A-Za-z0-9]/.test(segment.text) ? ' ' : '';
      this.pending.text += separator + segment.text;
      this.pending.speechEndAt = segment.speechEndAt;
      this.pending.duration = segment.start + segment.duration - this.pending.start;
    }
    const p = this.pending;
    const sentenceEnd = /[。！？.!?][」』”"']?\s*$/u.test(p.text) &&
      !CONTINUATION.test(p.text) && Array.from(p.text).length >= 24 && p.duration >= 3;
    const shortSentenceEnd = (this.options.shortSentenceRule ?? true) && p.lang === 'ja' && p.duration >= 1 &&
      Array.from(p.text).length >= 4 && /(?:です|ます|でした|ました|ません|ましょう|ください|でしょう|だろう)[。！？!?][」』”"']?\s*$/u.test(p.text);
    const maxAudio = this.options.maxAudioSeconds ?? MAX_AUDIO_SECONDS;
    if (Array.from(p.text).length >= MAX_CHARS) this.flush('chars-limit');
    else if (p.duration >= maxAudio) {
      if (!this.options.reviewLimits || !this.options.judge) this.flush('audio-limit');
      else if (p.duration >= maxAudio + LIMIT_GRACE_SECONDS) this.flush('safety-audio');
      else this.consider('audio-limit');
    } else if (this.options.reviewEverySegment && this.options.judge) this.consider('fragment');
    else if (shortSentenceEnd) this.consider('short-sentence');
    else if (sentenceEnd) this.consider('sentence');
    else this.touch();
  }

  /** Active partial speech postpones the idle flush, but never the hard deadline. */
  touch(): void {
    if (!this.pending) return;
    if (this.requestReason === 'idle') this.cancelRequest();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.consider('idle'), SENTENCE_IDLE_MS);
  }

  private consider(reason: BoundaryReason): void {
    if (!this.pending || this.request || this.waitedText === this.pending.text) return;
    if (!this.options.judge) { this.flush(reason); return; }
    const { text, lang } = this.pending;
    const controller = new AbortController();
    this.request = controller;
    this.requestReason = reason;
    const started = Date.now();
    const finish = (result: 'end' | 'wait' | 'fallback') => {
      // Stop/reset or a new fragment invalidates an answer about the old text.
      if (controller.signal.aborted || this.request !== controller) return;
      this.cancelRequest();
      this.options.onDecision?.({ text, reason, result, ms: Date.now() - started });
      if (result === 'wait') this.waitedText = text;
      else this.flush(result === 'end' ? 'model-end' : 'model-fallback');
    };
    this.requestTimer = setTimeout(() => finish('fallback'), this.options.judgeTimeoutMs ?? 1000);
    Promise.resolve().then(() => this.options.judge!(text, lang, controller.signal))
      .then((complete) => finish(complete ? 'end' : 'wait'), () => finish('fallback'));
  }

  private cancelRequest(): void {
    this.request?.abort();
    this.request = undefined;
    this.requestReason = undefined;
    clearTimeout(this.requestTimer);
  }

  flush(reason: FlushReason = 'stop'): void {
    const segment = this.pending;
    this.reset();
    if (segment) {
      this.options.onFlush?.({ reason, text: segment.text, start: segment.start, duration: segment.duration });
      this.emit(segment);
    }
  }

  reset(): void {
    this.cancelRequest();
    this.waitedText = undefined;
    clearTimeout(this.idle);
    clearTimeout(this.deadline);
    clearTimeout(this.safety);
    this.pending = null;
  }
}
