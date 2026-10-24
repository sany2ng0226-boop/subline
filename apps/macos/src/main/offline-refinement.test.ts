import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioAttachment, ArchiveRefineOptions, ArchiveRefineProgress, AsrModelSpec, Translator } from '@rt/core';
import { runOfflineRefinement, type RefinementDependencies, type RefinementJob } from './offline-refinement';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function wave(sampleCount: number, id = 'one', startedAt = 1_700_000_000_000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'subline-refinement-test-'));
  roots.push(root);
  const bytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < sampleCount; i++) wav.writeInt16LE(16384, 44 + i * 2);
  const filePath = path.join(root, `${id}.wav`);
  await fs.writeFile(filePath, wav);
  const attachment: AudioAttachment = { id, source: 'mic', format: 'wav', sampleRate: 16_000,
    channels: 1, durationMs: sampleCount / 16, startedAt, bytes: wav.length };
  return { filePath, attachment };
}

function job(recordings: RefinementJob['recordings'], options: Partial<ArchiveRefineOptions> = {}): RefinementJob {
  return { archiveId: 'archive-one', recordings, modelsDir: '/unused-models', cacheDir: '/unused-cache',
    options: { asrModel: 'sense-voice', language: 'ja', targetLang: 'zh', ...options } };
}

function dependencies(options: { silent?: boolean; spanStart?: number; translationError?: Error; language?: string } = {}) {
  const accepted: Float32Array[] = [];
  const decoded: Float32Array[] = [];
  const limits: number[] = [];
  const translate = vi.fn(async (text: string, _options: Parameters<Translator['translate']>[1]) => {
    if (options.translationError) throw options.translationError;
    return `翻譯：${text}`;
  });
  const createTranslator = vi.fn(async () => ({ init: vi.fn(async () => {}), translate }));
  const createInference = vi.fn(async (_job: RefinementJob, _spec: AsrModelSpec, maxSpeechSeconds: number) => {
    limits.push(maxSpeechSeconds);
    return {
      createVad() {
        const windows: Float32Array[] = [];
        let available = false;
        return {
          acceptWaveform(samples: Float32Array) { accepted.push(samples.slice()); windows.push(samples.slice()); },
          flush() { available = !options.silent && windows.length > 0; },
          isEmpty() { return !available; },
          front(enableExternalBuffer?: boolean) {
            expect(enableExternalBuffer).toBe(false);
            const samples = new Float32Array(windows.reduce((sum, block) => sum + block.length, 0));
            let offset = 0;
            for (const block of windows) { samples.set(block, offset); offset += block.length; }
            const start = options.spanStart ?? 0;
            return { samples: samples.subarray(start), start };
          },
          pop() { available = false; },
        };
      },
      decode(samples: Float32Array) {
        decoded.push(samples.slice());
        return { text: `文${decoded.length}`, lang: options.language ?? '<|ja|>' };
      },
    };
  });
  const deps: RefinementDependencies = { createInference, createTranslator };
  return { deps, accepted, decoded, limits, translate, createInference, createTranslator };
}

describe('offline recording refinement', () => {
  it('keeps the final partial VAD window, pads short native inputs, and saves only the real duration', async () => {
    const recording = await wave(1535);
    const fake = dependencies();
    const result = await runOfflineRefinement(job([recording]), () => {}, fake.deps);
    expect(fake.accepted).toHaveLength(3);
    expect(fake.accepted[2]![510]).toBe(0.5);
    expect(fake.accepted[2]![511]).toBe(0);
    expect(fake.decoded[0]).toHaveLength(8000);
    expect(fake.decoded[0]![1534]).toBe(0.5);
    expect(fake.decoded[0]![1535]).toBe(0);
    expect(result.lines[0]!.audio).toEqual({ recordingId: 'one', start: 0, duration: 1535 / 16_000 });
  });

  it('bounds transducer decoding even when VAD returns an oversized span', async () => {
    const recording = await wave(16_000 * 7.25);
    const fake = dependencies();
    const result = await runOfflineRefinement(job([recording], { asrModel: 'zipformer-ja-reazonspeech' }), () => {}, fake.deps);
    expect(fake.limits).toEqual([3]);
    expect(fake.decoded.map(samples => samples.length)).toEqual([48_000, 48_000, 20_000]);
    expect(result.lines.map(line => line.audio)).toEqual([
      { recordingId: 'one', start: 0, duration: 3 },
      { recordingId: 'one', start: 3, duration: 3 },
      { recordingId: 'one', start: 6, duration: 1.25 },
    ]);
  });

  it('uses a bounded 12 second whole-span path for SenseVoice and retains per-recording offsets', async () => {
    const earlier = await wave(32_000, 'earlier', 1_700_000_000_000);
    const later = await wave(32_000, 'later', 1_700_000_020_000);
    const fake = dependencies({ spanStart: 4000 });
    const result = await runOfflineRefinement(job([later, earlier]), () => {}, fake.deps);
    expect(fake.limits).toEqual([12]);
    expect(result.lines.map(line => line.audio)).toEqual([
      { recordingId: 'earlier', start: 0.25, duration: 1.75 },
      { recordingId: 'later', start: 0.25, duration: 1.75 },
    ]);
    const d = new Date(earlier.attachment.startedAt + 250);
    expect(result.lines[0]!.time).toBe([d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'));
  });

  it('translates every decoded span sequentially with no previous-sentence context', async () => {
    const recording = await wave(16_000 * 7);
    const fake = dependencies();
    const progress: ArchiveRefineProgress[] = [];
    const result = await runOfflineRefinement(job([recording], {
      asrModel: 'zipformer-ja-reazonspeech', translationModel: 'hy-mt2-7b',
    }), p => progress.push(p), fake.deps);
    expect(fake.translate.mock.calls.map(call => call[0])).toEqual(['文1', '文2', '文3']);
    expect(fake.translate.mock.calls).toEqual([
      ['文1', { source: 'ja', target: 'zh' }], ['文2', { source: 'ja', target: 'zh' }], ['文3', { source: 'ja', target: 'zh' }],
    ]);
    expect(result.lines.map(line => line.translation)).toEqual(['翻译：文1', '翻译：文2', '翻译：文3']);
    expect(progress.filter(p => p.state === 'translating').map(p => p.completed)).toEqual([0, 1, 2, 3]);
    expect(result.options).toEqual(job([], { asrModel: 'zipformer-ja-reazonspeech', translationModel: 'hy-mt2-7b' }).options);
  });

  it('does not produce a revision after a translation error', async () => {
    const recording = await wave(16_000);
    const fake = dependencies({ translationError: new Error('native translation failed') });
    await expect(runOfflineRefinement(job([recording], { translationModel: 'hy-mt2-7b' }), () => {}, fake.deps))
      .rejects.toThrow('native translation failed');
  });

  it('does not call the translation engine for the same source and target language', async () => {
    const recording = await wave(16_000);
    const fake = dependencies();
    const result = await runOfflineRefinement(job([recording], { translationModel: 'hy-mt2-7b', targetLang: 'ja' }), () => {}, fake.deps);
    expect(fake.translate).not.toHaveBeenCalled();
    expect(fake.createTranslator).not.toHaveBeenCalled();
    expect(result.lines[0]!.translation).toBe('');
  });

  it('accepts silence without hallucinating a line or loading a translator', async () => {
    const recording = await wave(16_000);
    const fake = dependencies({ silent: true });
    const result = await runOfflineRefinement(job([recording], { translationModel: 'hy-mt2-7b' }), () => {}, fake.deps);
    expect(result.lines).toEqual([]);
    expect(fake.decoded).toEqual([]);
    expect(fake.createTranslator).not.toHaveBeenCalled();
  });

  it('rejects damaged WAV sizes and symlinks instead of decoding arbitrary bytes', async () => {
    const recording = await wave(16_000);
    const fake = dependencies();
    const handle = await fs.open(recording.filePath, 'r+');
    await handle.write(Buffer.from('NOPE'), 0, 4, 0);
    await handle.close();
    await expect(runOfflineRefinement(job([recording]), () => {}, fake.deps)).rejects.toThrow('16 kHz mono PCM16 WAV');
    expect(fake.decoded).toEqual([]);
    const link = recording.filePath + '.link';
    await fs.symlink(recording.filePath, link);
    await expect(runOfflineRefinement(job([{ ...recording, filePath: link }]), () => {}, fake.deps)).rejects.toThrow();
  });

  it('rejects incompatible models and cloud translation before loading inference', async () => {
    const fake = dependencies();
    await expect(runOfflineRefinement(job([], { asrModel: 'paraformer-zh', language: 'ja' }), () => {}, fake.deps)).rejects.toThrow('Unsupported recognition');
    await expect(runOfflineRefinement(job([], { translationModel: 'cloud' as never }), () => {}, fake.deps)).rejects.toThrow('Only existing local');
    expect(fake.createInference).not.toHaveBeenCalled();
  });
});
