import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { SentenceAssembler, type AsrLang, type PartialPayload, type SegmentPayload } from '@rt/core';
import type { AsrToMain } from '../shared/types';

type HelperProcess = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'kill'> & {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
};
type Launch = (file: string) => HelperProcess;
const launchHelper: Launch = (file) => spawn(file, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

export function assertAppleSpeechSupported(platform = process.platform, release = os.release()): void {
  if (platform !== 'darwin' || Number(release.split('.')[0]) < 25) {
    throw new Error('Apple 语音识别需要 macOS 26 或更新版本');
  }
}

export interface AppleSpeechSetup {
  asrReady: boolean;
  supported: boolean;
  error?: string;
}

/** A setup probe cannot keep a microphone or a long-lived recognition session open. */
export function queryAppleSpeechSetup(
  helperPath: string,
  language: AsrLang,
  download = false,
  launch: Launch = launchHelper,
  timeoutMs = download ? 180_000 : 15_000,
): Promise<AppleSpeechSetup> {
  return new Promise((resolve, reject) => {
    const child = launch(helperPath);
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (result?: AppleSpeechSetup, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(undefined, new Error('Apple 语音模型准备超时，请稍后重试')), timeoutMs);
    child.stderr.resume();
    child.on('error', (error: Error) => finish(undefined, error));
    child.stdin.on('error', (error: Error) => finish(undefined, error));
    child.on('exit', () => finish(undefined, new Error('Apple 语音识别服务在准备完成前退出')));
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === 'setup') {
          finish({ asrReady: message.asrReady === true, supported: message.supported === true,
            ...(typeof message.error === 'string' ? { error: message.error } : {}) });
        } else if (message.type === 'error') {
          finish(undefined, new Error(String(message.message ?? 'Apple 语音模型准备失败')));
        }
      } catch { finish(undefined, new Error('Apple 语音识别服务返回无效结果')); }
    });
    child.stdin.write(JSON.stringify({ type: 'setup', language, download }) + '\n');
  });
}

/** Adapts native progressive results to the same sentence and stop contract as the local ASR pipeline. */
export class AppleSpeechClient {
  private readonly child: HelperProcess;
  private readonly sentences: SentenceAssembler;
  private partial = '';
  private sessionId = 0;
  private active = false;
  private failed = false;
  private disposed = false;
  private nextSegmentId = 0;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private readonly flushes = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  readonly ready: Promise<void>;

  constructor(helperPath: string, language: AsrLang, private readonly post: (event: AsrToMain) => void,
    launch: Launch = launchHelper) {
    this.sentences = new SentenceAssembler((segment) => {
      this.post({ type: 'segment', payload: { ...segment, id: ++this.nextSegmentId } });
      this.publishPartial();
    });
    this.child = launch(helperPath);
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.readyTimer = setTimeout(() => this.fail(new Error('Apple 语音识别服务启动超时')), 20_000);
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(new Error('Apple 语音识别服务返回无效结果')); }
    });
    this.child.stderr.resume();
    this.child.on('error', (error: Error) => this.fail(error));
    this.child.stdin.on('error', (error: Error) => this.fail(error));
    this.child.on('exit', (code: number | null) => {
      lines.close();
      if (!this.disposed) this.fail(new Error(`Apple 语音识别服务异常退出 (${code})`));
    });
    this.send({ type: 'init', language, prepare: false });
  }

  reset(): void {
    this.active = true;
    this.sessionId += 1;
    this.partial = '';
    this.nextSegmentId = 0;
    this.sentences.reset();
    // Old flush acknowledgements must never finish a new recording.
    for (const waiter of this.flushes.values()) waiter.reject(new Error('录音会话已切换'));
    this.flushes.clear();
    this.send({ type: 'reset', sessionId: this.sessionId });
  }

  acceptWaveform(samples: Float32Array): void {
    if (!this.active || this.failed || this.disposed) return;
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    this.send({ type: 'audio', samples: bytes.toString('base64') });
  }

  async flush(requestId: number): Promise<void> {
    if (this.failed || this.disposed) throw new Error('Apple 语音识别服务已停止');
    if (!this.active) return;
    await new Promise<void>((resolve, reject) => {
      this.flushes.set(requestId, { resolve, reject });
      this.send({ type: 'flush', requestId });
    });
    this.sentences.flush();
    this.partial = '';
    this.active = false;
    this.publishPartial();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.readyTimer);
    this.sentences.reset();
    const error = new Error('Apple 语音识别服务已停止');
    this.readyReject?.(error);
    this.readyReject = undefined;
    for (const waiter of this.flushes.values()) waiter.reject(error);
    this.flushes.clear();
    this.child.stdin.end();
    this.child.kill();
  }

  private publishPartial(): void {
    const payload: PartialPayload = { text: this.sentences.text + this.partial, stableText: this.sentences.text };
    this.post({ type: 'partial', payload });
  }

  private receive(message: Record<string, unknown>): void {
    if (this.failed || this.disposed) return;
    if (message.type === 'ready') {
      clearTimeout(this.readyTimer);
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (message.type === 'error') {
      if (typeof message.sessionId === 'number' && message.sessionId !== this.sessionId) return;
      this.fail(new Error(String(message.message ?? 'Apple 语音识别失败')));
      return;
    }
    if (message.type === 'flushed') {
      const requestId = Number(message.requestId);
      const waiter = this.flushes.get(requestId);
      this.flushes.delete(requestId);
      waiter?.resolve();
      return;
    }
    if (!this.active || message.sessionId !== this.sessionId || typeof message.text !== 'string') return;
    if (message.type === 'partial') {
      this.partial = message.text;
      if (this.partial) this.sentences.touch();
      this.publishPartial();
    } else if (message.type === 'segment') {
      if (typeof message.start !== 'number' || !Number.isFinite(message.start) ||
          typeof message.duration !== 'number' || !Number.isFinite(message.duration) ||
          typeof message.lang !== 'string') throw new Error('无效的 Apple 字幕时间范围');
      this.partial = '';
      this.sentences.push({ id: ++this.nextSegmentId, text: message.text, lang: message.lang,
        start: message.start, duration: message.duration } as SegmentPayload);
      this.publishPartial();
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.failed || this.disposed) throw new Error('Apple 语音识别服务已停止');
    if (this.child.stdin.writableLength > MAX_PENDING_BYTES) {
      this.fail(new Error('Apple 语音识别处理跟不上音频输入，请停止后重试'));
      return;
    }
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private fail(error: Error): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    clearTimeout(this.readyTimer);
    this.sentences.reset();
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const waiter of this.flushes.values()) waiter.reject(error);
    this.flushes.clear();
    this.child.kill();
    this.post({ type: 'error', message: error.message });
  }
}
