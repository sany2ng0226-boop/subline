import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AudioRecordingStore, MAX_QUEUED_PCM_BYTES, MAX_QUEUED_PCM_FRAMES } from './audio-recordings';

let dir: string;
let store: AudioRecordingStore;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subline-audio-test-'));
  store = new AudioRecordingStore(() => dir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.finish().catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
});

function tone(seconds = 0.1): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * 16_000) }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 16_000) * 0.5);
}

it('preserves microphone provenance and the short tail across reopening without changing legacy system IDs', async () => {
  const mic = await store.start('mic');
  store.append(tone(0.013));
  await store.finish();
  const system = await store.start('system');
  store.append(tone(0.1));
  await store.finish();
  const reopened = new AudioRecordingStore(() => dir);
  const audio = await reopened.resolve([mic.id, system.id]);
  expect(audio[0]).toMatchObject({ source: 'mic', durationMs: 13, bytes: 44 + 208 * 2 });
  expect(audio[1]).toMatchObject({ source: 'system', durationMs: 100 });
  expect(mic.id).toMatch(/-mic$/);
  expect(system.id).not.toMatch(/-mic$/);
});

it('writes multiple frames into one PCM16 mono WAV and waits for all queued data on finish', async () => {
  const started = await store.start();
  const frame = tone();
  for (let i = 0; i < 20; i++) store.append(frame);
  const finish = store.finish();
  expect(() => store.append(frame)).toThrow('accepting');
  await finish;
  const [audio] = await store.resolve([started.id]);
  expect(audio).toEqual({ ...started, source: 'system', format: 'wav', durationMs: 2000, bytes: 64_044 });
  const wav = await fs.readFile(store.pathFor(started.id));
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt16LE(34)).toBe(16);
});

it('owns queued frames and clips PCM amplitudes without propagating NaN', async () => {
  const { id } = await store.start();
  const frame = new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity, -Infinity]);
  store.append(frame);
  frame.fill(0);
  await store.finish();
  const wav = await fs.readFile(store.pathFor(id));
  expect(Array.from({ length: 10 }, (_, i) => wav.readInt16LE(44 + i * 2)))
    .toEqual([-32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 32767, -32768]);
});

it('serializes start and finish and preserves each separate recording', async () => {
  const first = await store.start();
  store.append(tone());
  const stopping = store.finish();
  const next = store.start();
  await stopping;
  const second = await next;
  store.append(tone(0.2));
  await Promise.all([store.finish(), store.finish()]);
  expect(first.id).not.toBe(second.id);
  expect((await store.resolve([first.id, second.id])).map((audio) => audio.durationMs)).toEqual([100, 200]);
});

it('finishes a previous recording before starting a new one', async () => {
  const first = await store.start();
  store.append(tone());
  const second = await store.start();
  store.append(tone());
  await store.finish();
  expect((await store.list()).map((audio) => audio.id).sort()).toEqual([first.id, second.id].sort());
});

it('reopens its directory without an index and returns only its own nonempty WAVs', async () => {
  expect(await store.list()).toEqual([]);
  const { id } = await store.start();
  store.append(tone());
  await store.finish();
  await fs.writeFile(path.join(dir, 'unrelated.wav'), 'untouched');
  const reopened = new AudioRecordingStore(() => dir);
  expect((await reopened.list()).map((audio) => audio.id)).toEqual([id]);
  expect(await fs.readFile(path.join(dir, 'unrelated.wav'), 'utf8')).toBe('untouched');
});

it('repairs stale length fields after interruption using the actual PCM length', async () => {
  const { id } = await store.start();
  store.append(tone());
  await store.finish();
  const target = store.pathFor(id);
  const wav = await fs.readFile(target);
  wav.writeUInt32LE(36, 4);
  wav.writeUInt32LE(0, 40);
  await fs.writeFile(target, Buffer.concat([wav, Buffer.from([42])]));
  const reopened = new AudioRecordingStore(() => dir);
  expect((await reopened.resolve([id]))[0]).toMatchObject({ durationMs: 100, bytes: 3244 });
  const repaired = await fs.readFile(target);
  expect(repaired.length).toBe(3244);
  expect(repaired.readUInt32LE(4)).toBe(3236);
  expect(repaired.readUInt32LE(40)).toBe(3200);
  expect((await reopened.resolve([id]))[0].incomplete).toBe(true);
  expect((await new AudioRecordingStore(() => dir).resolve([id]))[0].incomplete).toBe(true);
});

it('does not expose an active recording or remove it while it is being written', async () => {
  const { id } = await store.start();
  store.append(tone());
  expect(await store.list()).toEqual([]);
  await expect(store.resolve([id])).rejects.toThrow('not finished');
  await expect(store.remove([id])).rejects.toThrow('active');
  await store.finish();
  expect(await store.resolve([id])).toHaveLength(1);
});

it('rejects missing, damaged, and empty recordings without deleting them', async () => {
  const { id } = await store.start();
  await store.finish();
  await expect(store.resolve([id])).rejects.toThrow('empty');
  expect(await store.list()).toEqual([]);
  await fs.writeFile(store.pathFor(id), Buffer.alloc(100));
  await expect(store.resolve([id])).rejects.toThrow('header');
  expect(await store.list()).toEqual([]);
  expect((await fs.stat(store.pathFor(id))).size).toBe(100);
  await store.remove([id]);
  await expect(store.resolve([id])).rejects.toThrow();
});

it('validates the entire ID batch before removing anything and never accepts paths', async () => {
  const { id } = await store.start();
  store.append(tone());
  await store.finish();
  for (const invalid of ['../outside', `${id}/../outside`, `${id}.wav`, id.toUpperCase(), '/tmp/file', '']) {
    expect(() => store.pathFor(invalid)).toThrow('Invalid');
    await expect(store.resolve([invalid])).rejects.toThrow('Invalid');
    await expect(store.remove([id, invalid])).rejects.toThrow('Invalid');
  }
  expect(await store.resolve([id])).toHaveLength(1);
  await store.remove([id, id]);
  expect(await store.list()).toEqual([]);
});

it('rejects symbolic links and leaves their targets untouched', async () => {
  const { id } = await store.start();
  store.append(tone());
  await store.finish();
  const saved = await fs.readFile(store.pathFor(id));
  const outside = path.join(dir, 'outside.bin');
  await fs.writeFile(outside, saved);
  await fs.rm(store.pathFor(id));
  await fs.symlink(outside, store.pathFor(id));
  expect(await store.list()).toEqual([]);
  await expect(store.resolve([id])).rejects.toThrow('regular file');
  await store.remove([id]);
  expect(await fs.readFile(outside)).toEqual(saved);
});

it('reports queue overload immediately and rejects finish while preserving accepted audio', async () => {
  const { id } = await store.start();
  store.append(tone());
  expect(() => store.append(new Float32Array(MAX_QUEUED_PCM_BYTES / 2))).toThrow('limit');
  await expect(store.finish()).rejects.toThrow('incomplete');
  expect((await store.resolve([id]))[0].durationMs).toBe(100);
  expect((await new AudioRecordingStore(() => dir).resolve([id]))[0].incomplete).toBe(true);
  expect(await fs.readFile(`${store.pathFor(id)}.incomplete`, 'utf8')).toContain('incomplete');
  await store.remove([id]);
  await expect(fs.stat(`${store.pathFor(id)}.incomplete`)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(store.start()).resolves.toMatchObject({ sampleRate: 16_000 });
});

it('bounds queue bookkeeping even when callers submit tiny frames', async () => {
  const { id } = await store.start();
  for (let index = 0; index < MAX_QUEUED_PCM_FRAMES; index++) store.append(new Float32Array(1));
  expect(() => store.append(new Float32Array(1))).toThrow('limit');
  await expect(store.finish()).rejects.toThrow('incomplete');
  expect((await fs.stat(store.pathFor(id))).size).toBe(44 + MAX_QUEUED_PCM_FRAMES * 2);
});

it('propagates asynchronous disk write failure through finish without an unhandled rejection', async () => {
  const open = fs.open.bind(fs);
  let handle: FileHandle | undefined;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const opened = await open(...args);
    if (String(args[0]).endsWith('.wav')) handle = opened;
    return opened;
  });
  await store.start();
  vi.spyOn(handle!, 'write').mockRejectedValueOnce(new Error('disk full'));
  store.append(tone());
  const first = store.finish();
  const repeated = store.finish();
  expect(repeated).toBe(first);
  await expect(first).rejects.toThrow('disk full');
  expect(await store.list()).toEqual([]);
});

it('honors finish requested while start is still opening its file', async () => {
  const start = store.start();
  const finish = store.finish();
  await start;
  expect(() => store.append(tone())).toThrow('accepting');
  await finish;
  expect(await store.list()).toEqual([]);
});

it('retains an incomplete capture marker after an otherwise successful finalization', async () => {
  const { id } = await store.start();
  store.append(tone());
  store.markIncomplete();
  await expect(store.finish()).resolves.toBeUndefined();
  expect((await new AudioRecordingStore(() => dir).resolve([id]))[0]).toMatchObject({ incomplete: true, durationMs: 100 });
  const next = await store.start();
  store.append(tone());
  await store.finish();
  expect((await store.resolve([next.id]))[0].incomplete).toBeUndefined();
});

it('rejects a failed fsync while still closing the file and preserving its audio', async () => {
  const open = fs.open.bind(fs);
  let handle: FileHandle | undefined;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const opened = await open(...args);
    if (String(args[0]).endsWith('.wav')) handle = opened;
    return opened;
  });
  const { id } = await store.start();
  const close = vi.spyOn(handle!, 'close');
  vi.spyOn(handle!, 'sync').mockRejectedValueOnce(new Error('sync failed'));
  store.append(tone());
  await expect(store.finish()).rejects.toThrow('sync failed');
  expect(close).toHaveBeenCalledOnce();
  expect((await store.resolve([id]))[0].durationMs).toBe(100);
  expect((await new AudioRecordingStore(() => dir).resolve([id]))[0].incomplete).toBe(true);
  expect(await fs.readFile(`${store.pathFor(id)}.incomplete`, 'utf8')).toBe('sync failed');
});

it('rejects when its root cannot be created and can be retried after the filesystem is repaired', async () => {
  const blocked = path.join(dir, 'blocked');
  await fs.writeFile(blocked, 'file');
  const isolated = new AudioRecordingStore(() => blocked);
  await expect(isolated.start()).rejects.toThrow();
  await fs.rm(blocked);
  await expect(isolated.start()).resolves.toMatchObject({ channels: 1 });
  isolated.append(tone());
  await isolated.finish();
});
