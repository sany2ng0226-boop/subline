import { createServer, type Server } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function devQaEnabled(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return !isPackaged && env['SUBLINE_DEV_QA'] === '1';
}

export interface QaEvent {
  seq: number;
  at: string;
  monotonicMs: number;
  session: string | null;
  stage: string;
  payload: unknown;
}

function jsonCopy(value: unknown, maxBytes: number): unknown {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > maxBytes) throw new Error('QA payload exceeds limit');
  return JSON.parse(json);
}

export class DevQaTrace {
  private events: Array<{ event: QaEvent; bytes: number }> = [];
  private bytes = 0;
  private seq = 0;
  private session: string | null = null;
  private audioAt = 0;
  private audioChunks = 0;
  private audioSamples = 0;
  private totalSamples = 0;
  private audioEnergy = 0;
  private audioPeak = 0;
  private nonFinite = 0;

  constructor(private readonly capacity = 4000, private readonly byteCapacity = 8 * 1024 * 1024) {}

  beginSession(): string {
    this.session = randomUUID();
    this.totalSamples = 0;
    this.resetAudio();
    this.record('session.start', {});
    return this.session;
  }

  record(stage: string, payload: unknown): void {
    if (!/^[a-z][a-z0-9:._-]{0,63}$/.test(stage)) return;
    let copy: unknown;
    try { copy = jsonCopy(payload, 64 * 1024); }
    catch { copy = { omitted: true, reason: 'payload-size-or-serialization' }; }
    const event: QaEvent = {
      seq: ++this.seq, at: new Date().toISOString(), monotonicMs: performance.now(),
      session: this.session, stage, payload: copy,
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push({ event, bytes });
    this.bytes += bytes;
    while (this.events.length > this.capacity || this.bytes > this.byteCapacity) {
      this.bytes -= this.events.shift()!.bytes;
    }
  }

  read(after = 0, limit = 200): {
    events: QaEvent[]; oldestSeq: number; latestSeq: number; nextSeq: number; dropped: boolean; hasMore: boolean;
  } {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Invalid QA cursor or limit');
    }
    const oldestSeq = this.events[0]?.event.seq ?? this.seq + 1;
    const selected = this.events.filter(({ event }) => event.seq > after).slice(0, limit).map(({ event }) => event);
    const nextSeq = selected.at(-1)?.seq ?? after;
    return jsonCopy({ events: selected, oldestSeq, latestSeq: this.seq, nextSeq,
      dropped: after < oldestSeq - 1, hasMore: this.seq > nextSeq }, 9 * 1024 * 1024) as ReturnType<DevQaTrace['read']>;
  }

  audio(samples: Float32Array): void {
    this.audioChunks++;
    this.audioSamples += samples.length;
    this.totalSamples += samples.length;
    for (const sample of samples) {
      if (!Number.isFinite(sample)) { this.nonFinite++; continue; }
      this.audioEnergy += sample * sample;
      this.audioPeak = Math.max(this.audioPeak, Math.abs(sample));
    }
    if (performance.now() - this.audioAt >= 500) this.flushAudio();
  }

  flushAudio(): void {
    if (!this.audioChunks) return;
    this.record('audio.input', {
      chunks: this.audioChunks, samples: this.audioSamples, totalSamples: this.totalSamples,
      rms: Math.sqrt(this.audioEnergy / Math.max(1, this.audioSamples - this.nonFinite)),
      peak: this.audioPeak, nonFinite: this.nonFinite, sampleRate: 16000,
    });
    this.resetAudio();
  }

  private resetAudio(): void {
    this.audioAt = performance.now();
    this.audioChunks = this.audioSamples = this.audioEnergy = this.audioPeak = this.nonFinite = 0;
  }
}

export interface DevQaOptions {
  identity: Record<string, unknown>;
  state: () => unknown;
  requestRendererSnapshot: (requestId: number) => void;
  socketPath?: string;
  rendererTimeoutMs?: number;
}

export class DevQaServer {
  readonly trace = new DevQaTrace();
  private server: Server | undefined;
  private directory: string | undefined;
  private requestId = 0;
  private pending = new Map<number, (snapshot: unknown) => void>();
  private renderer: { at: number; data: unknown } | undefined;
  private socketOwned = false;
  socketPath = '';

  constructor(private readonly options: DevQaOptions) {}

  acceptRendererSnapshot(requestId: unknown, payload: unknown): void {
    if (!Number.isSafeInteger(requestId) || (requestId as number) < 0) return;
    try {
      const data = jsonCopy(payload, 512 * 1024);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      this.renderer = { at: Date.now(), data };
      this.pending.get(requestId as number)?.(data);
    } catch { /* An oversized renderer report cannot expand the trace without bounds. */ }
  }

  async listen(): Promise<string> {
    const requested = this.options.socketPath;
    this.directory = requested ? path.dirname(requested) : fs.mkdtempSync(path.join(os.tmpdir(), 'subline-dev-qa-'));
    if (!fs.existsSync(this.directory)) fs.mkdirSync(this.directory, { mode: 0o700, recursive: true });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('QA socket requires an owned private directory (0700)');
    }
    this.socketPath = requested ?? path.join(this.directory, `${process.pid}.sock`);
    if (!path.isAbsolute(this.socketPath) || fs.existsSync(this.socketPath)) throw new Error('QA socket path must be absolute and unused');
    const server = createServer((socket) => {
      let buffer = '';
      let handled = false;
      socket.setTimeout(3000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        if (handled) return;
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > 4096) { socket.destroy(); return; }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        handled = true;
        let request: unknown;
        try { request = JSON.parse(buffer.slice(0, newline)); }
        catch { socket.end(JSON.stringify({ error: 'Invalid JSON' }) + '\n'); return; }
        void this.handle(request).then(
          (response) => socket.end(JSON.stringify(response) + '\n'),
          () => socket.end(JSON.stringify({ error: 'QA request failed' }) + '\n'),
        );
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(this.socketPath, () => {
        server.off('error', failed);
        this.socketOwned = true;
        fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
    return this.socketPath;
  }

  async handle(value: unknown): Promise<unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Invalid request' };
    const request = value as Record<string, unknown>;
    const id = request.id;
    if (id !== undefined && !(typeof id === 'string' && id.length <= 128) && !Number.isSafeInteger(id)) return { error: 'Invalid id' };
    const allowed = request.method === 'events' ? ['id', 'method', 'after', 'limit'] : ['id', 'method'];
    if (Object.keys(request).some((key) => !allowed.includes(key))) return { id, error: 'Unsupported parameter' };
    try {
      switch (request.method) {
        case 'identity': return { id, result: { ...this.options.identity, socketPath: this.socketPath } };
        case 'events': return { id, result: this.trace.read(request.after as number | undefined, request.limit as number | undefined) };
        case 'snapshot': {
          const renderer = await this.rendererSnapshot();
          return { id, result: { identity: { ...this.options.identity, socketPath: this.socketPath },
            state: this.options.state(), renderer, events: this.trace.read(this.trace.read().latestSeq, 1) } };
        }
        default: return { id, error: 'Read-only QA supports identity, snapshot, events only' };
      }
    } catch (error) { return { id, error: error instanceof Error ? error.message : String(error) }; }
  }

  private async rendererSnapshot(): Promise<unknown> {
    const requestId = ++this.requestId;
    const fresh = await new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => { clearTimeout(timer); this.pending.delete(requestId); resolve(ok); };
      const timer = setTimeout(() => finish(false), this.options.rendererTimeoutMs ?? 1000);
      this.pending.set(requestId, () => finish(true));
      try { this.options.requestRendererSnapshot(requestId); }
      catch { finish(false); }
    });
    return { available: !!this.renderer, stale: !fresh,
      ageMs: this.renderer ? Date.now() - this.renderer.at : null,
      data: this.renderer?.data ?? null, ...(!fresh ? { error: 'Renderer did not answer fresh snapshot request' } : {}) };
  }

  close(): void {
    this.server?.close();
    if (this.socketOwned && this.socketPath && fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    this.socketOwned = false;
  }
}
