import fs, { type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AudioAttachment, AudioSource } from '@rt/core';

const SAMPLE_RATE = 16_000;
const HEADER_BYTES = 44;
const MAX_DATA_BYTES = 0xffff_ffff - 36;
export const MAX_QUEUED_PCM_BYTES = 8 * 1024 * 1024;
const ID_PATTERN = /^audio-(\d{13})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(-mic)?$/;

type RecordingStart = { id: string; startedAt: number; sampleRate: number; channels: number };
type Recording = RecordingStart & {
  handle: FileHandle;
  accepting: boolean;
  bytes: number;
  queuedBytes: number;
  tail: Promise<void>;
  failure: Error | null;
  writeFailed: boolean;
};

class InvalidRecording extends Error {}
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

function startedAtOf(id: string): number {
  const match = typeof id === 'string' ? ID_PATTERN.exec(id) : null;
  if (!match) throw new InvalidRecording('Invalid audio recording ID');
  return Number(match[1]);
}

function header(bytes: number): Buffer {
  const result = Buffer.alloc(HEADER_BYTES);
  result.write('RIFF', 0);
  result.writeUInt32LE(36 + bytes, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(SAMPLE_RATE, 24);
  result.writeUInt32LE(SAMPLE_RATE * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(bytes, 40);
  return result;
}

async function writeAll(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Audio recording write made no progress');
    offset += bytesWritten;
  }
}

function pcm16(samples: Float32Array): Buffer {
  const result = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    const value = Number.isNaN(samples[index]) ? 0 : Math.max(-1, Math.min(1, samples[index]));
    result.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), index * 2);
  }
  return result;
}

/** The root is this profile's recordings directory; files never leave that directory. */
export class AudioRecordingStore {
  private active: Recording | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private requestedSession = 0;
  private stoppedThrough = 0;
  private pendingFinish: { session: number; result: Promise<void> } | null = null;

  constructor(private readonly root: () => string) {}

  pathFor(id: string): string {
    startedAtOf(id);
    return path.join(this.root(), `${id}.wav`);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  start(source: AudioSource = 'system'): Promise<RecordingStart> {
    if (source !== 'mic' && source !== 'system') return Promise.reject(new Error('Invalid audio source'));
    const session = ++this.requestedSession;
    this.stoppedThrough = session - 1;
    if (this.active) this.active.accepting = false;
    return this.serialize(async () => {
      await this.finishActive();
      const startedAt = Date.now();
      const id = `audio-${startedAt}-${randomUUID()}${source === 'mic' ? '-mic' : ''}`;
      await fs.mkdir(this.root(), { recursive: true, mode: 0o700 });
      const handle = await fs.open(this.pathFor(id), 'wx', 0o600);
      try { await writeAll(handle, header(0), 0); }
      catch (error) { await handle.close(); throw error; }
      this.active = {
        id, startedAt, sampleRate: SAMPLE_RATE, channels: 1, handle, accepting: session > this.stoppedThrough,
        bytes: 0, queuedBytes: 0, tail: Promise.resolve(), failure: null, writeFailed: false,
      };
      return { id, startedAt, sampleRate: SAMPLE_RATE, channels: 1 };
    });
  }

  append(samples: Float32Array): void {
    const recording = this.active;
    if (!recording || !recording.accepting) throw new Error('No audio recording is accepting samples');
    if (recording.failure) throw recording.failure;
    if (!(samples instanceof Float32Array)) throw new TypeError('Audio samples must be Float32 PCM');
    const bytes = samples.length * 2;
    if (!bytes) return;
    if (recording.queuedBytes + bytes > MAX_QUEUED_PCM_BYTES
      || recording.bytes + recording.queuedBytes + bytes > MAX_DATA_BYTES) {
      recording.failure = new Error('Audio recording queue or WAV size limit exceeded; the recording is incomplete');
      throw recording.failure;
    }
    // Own the frame before returning: IPC callers may reuse or mutate their input buffer.
    const owned = samples.slice();
    recording.queuedBytes += bytes;
    recording.tail = recording.tail.then(async () => {
      if (recording.writeFailed) return;
      await writeAll(recording.handle, pcm16(owned), HEADER_BYTES + recording.bytes);
      recording.bytes += bytes;
    }).catch((error) => {
      recording.failure ??= asError(error);
      recording.writeFailed = true;
    }).finally(() => { recording.queuedBytes -= bytes; });
  }

  finish(): Promise<void> {
    this.stoppedThrough = this.requestedSession;
    if (this.active) this.active.accepting = false;
    if (this.pendingFinish?.session === this.requestedSession) return this.pendingFinish.result;
    const session = this.requestedSession;
    const result = this.serialize(() => this.finishActive()).finally(() => {
      if (this.pendingFinish?.result === result) this.pendingFinish = null;
    });
    this.pendingFinish = { session, result };
    return result;
  }

  private async finishActive(): Promise<void> {
    const recording = this.active;
    if (!recording) return;
    recording.accepting = false;
    await recording.tail;
    try {
      await writeAll(recording.handle, header(recording.bytes), 0);
      await recording.handle.sync();
    } catch (error) { recording.failure ??= asError(error); }
    finally {
      try { await recording.handle.close(); }
      catch (error) { recording.failure ??= asError(error); }
      if (this.active === recording) this.active = null;
    }
    if (recording.failure) throw recording.failure;
  }

  private async inspect(id: string): Promise<AudioAttachment> {
    const startedAt = startedAtOf(id);
    if (this.active?.id === id) throw new InvalidRecording('Audio recording has not finished');
    const target = this.pathFor(id);
    const stat = await fs.lstat(target);
    if (!stat.isFile()) throw new InvalidRecording('Audio recording is not a regular file');
    const handle = await fs.open(target, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.size < HEADER_BYTES + 2 || actual.size - HEADER_BYTES > MAX_DATA_BYTES) {
        throw new InvalidRecording('Audio recording is empty or has an invalid size');
      }
      const dataBytes = Math.floor((actual.size - HEADER_BYTES) / 2) * 2;
      const expected = header(dataBytes);
      const current = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(current, 0, HEADER_BYTES, 0);
      // Only size fields may differ after interruption; unknown formats are never rewritten.
      if (bytesRead !== HEADER_BYTES || !current.subarray(0, 4).equals(expected.subarray(0, 4))
        || !current.subarray(8, 40).equals(expected.subarray(8, 40))) {
        throw new InvalidRecording('Audio recording has an unsupported or damaged WAV header');
      }
      if (!current.equals(expected) || actual.size !== HEADER_BYTES + dataBytes) {
        if (actual.size !== HEADER_BYTES + dataBytes) await handle.truncate(HEADER_BYTES + dataBytes);
        await writeAll(handle, expected, 0);
        await handle.sync();
      }
      return { id, source: id.endsWith('-mic') ? 'mic' : 'system', format: 'wav', sampleRate: SAMPLE_RATE, channels: 1,
        durationMs: Math.round(dataBytes / (SAMPLE_RATE * 2) * 1000), startedAt,
        bytes: HEADER_BYTES + dataBytes };
    } finally { await handle.close(); }
  }

  list(): Promise<AudioAttachment[]> {
    return this.serialize(async () => {
      let files: string[];
      try { files = await fs.readdir(this.root()); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const result: AudioAttachment[] = [];
      for (const file of files) {
        if (!file.endsWith('.wav') || !ID_PATTERN.test(file.slice(0, -4))) continue;
        const id = file.slice(0, -4);
        if (this.active?.id === id) continue;
        try { result.push(await this.inspect(id)); }
        catch (error) {
          if (!(error instanceof InvalidRecording) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return result.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
    });
  }

  async resolve(ids: string[]): Promise<AudioAttachment[]> {
    const selected = [...new Set(ids)];
    selected.forEach(startedAtOf);
    return this.serialize(async () => {
      const result: AudioAttachment[] = [];
      for (const id of selected) result.push(await this.inspect(id));
      return result;
    });
  }

  async remove(ids: string[]): Promise<void> {
    const selected = [...new Set(ids)];
    selected.forEach(startedAtOf);
    return this.serialize(async () => {
      if (selected.some((id) => this.active?.id === id)) throw new Error('Cannot remove an active audio recording');
      for (const id of selected) await fs.rm(this.pathFor(id), { force: true });
    });
  }
}
