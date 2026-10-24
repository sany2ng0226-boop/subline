import fs, { type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  cleanAsrText, getAsrModel, getTranslationModel, guardAsrLang, normalizeZh,
  type ArchiveLine, type ArchiveRefineOptions, type ArchiveRefineProgress, type ArchiveRevision,
  type AsrModelSpec, type AudioAttachment, type Translator,
} from '@rt/core';

const SAMPLE_RATE = 16_000;
const VAD_WINDOW = 512;
const WAV_HEADER_BYTES = 44;
const READ_BYTES = SAMPLE_RATE * 2;
const MIN_DECODE_SAMPLES = SAMPLE_RATE / 2;

export interface RefinementJob {
  archiveId: string;
  recordings: Array<{ attachment: AudioAttachment; filePath: string }>;
  modelsDir: string;
  cacheDir: string;
  options: ArchiveRefineOptions;
}

export type RefinementWorkerMessage =
  | { type: 'progress'; progress: ArchiveRefineProgress }
  | { type: 'result'; revision: ArchiveRevision }
  | { type: 'error'; message: string };

interface SpeechSpan { samples: Float32Array; start: number }
interface RefinementVad {
  acceptWaveform(samples: Float32Array): void;
  flush(): void;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): SpeechSpan;
  pop(): void;
}
interface RefinementInference {
  createVad(): RefinementVad;
  decode(samples: Float32Array): { text: string; lang?: string };
}

export interface RefinementDependencies {
  createInference(job: RefinementJob, spec: AsrModelSpec, maxSpeechSeconds: number): Promise<RefinementInference>;
  createTranslator(model: NonNullable<ArchiveRefineOptions['translationModel']>, cacheDir: string): Promise<Translator>;
}

const nativeDependencies: RefinementDependencies = {
  async createInference(job, spec, maxSpeechSeconds) {
    const [sherpaModule, { buildModelConfig, buildVadConfig }] = await Promise.all([
      import('sherpa-onnx-node'), import('./pipeline'),
    ]);
    // Node cannot infer these constructors as named exports from sherpa's CommonJS export assignments.
    type SherpaConstructors = Pick<typeof import('sherpa-onnx-node'), 'OfflineRecognizer' | 'Vad'>;
    const commonJs = sherpaModule as unknown as { default?: SherpaConstructors };
    const { OfflineRecognizer, Vad } = commonJs.default ?? sherpaModule;
    const recognizer = new OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: buildModelConfig(job.modelsDir, spec, job.options.language),
    });
    return {
      createVad() {
        const config = buildVadConfig(job.modelsDir);
        config.sileroVad.maxSpeechDuration = maxSpeechSeconds;
        return new Vad(config, 120);
      },
      decode(samples) {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
        recognizer.decode(stream);
        return recognizer.getResult(stream);
      },
    };
  },
  async createTranslator(model, cacheDir) {
    const { createTranslator } = await import('./translation/translator');
    return createTranslator({ backend: model, cacheDir });
  },
};

async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesRead) throw new Error('Saved audio is truncated');
    offset += bytesRead;
  }
}

async function openWave(filePath: string): Promise<{ handle: FileHandle; samples: number }> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < WAV_HEADER_BYTES || (stat.size - WAV_HEADER_BYTES) % 2) {
      throw new Error('Saved audio is not a complete PCM WAV file');
    }
    const header = Buffer.alloc(WAV_HEADER_BYTES);
    await readExactly(handle, header, 0);
    const dataBytes = stat.size - WAV_HEADER_BYTES;
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.readUInt32LE(4) !== stat.size - 8
      || header.toString('ascii', 8, 16) !== 'WAVEfmt ' || header.readUInt32LE(16) !== 16
      || header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1
      || header.readUInt32LE(24) !== SAMPLE_RATE || header.readUInt32LE(28) !== SAMPLE_RATE * 2
      || header.readUInt16LE(32) !== 2 || header.readUInt16LE(34) !== 16
      || header.toString('ascii', 36, 40) !== 'data' || header.readUInt32LE(40) !== dataBytes) {
      throw new Error('Saved audio must be 16 kHz mono PCM16 WAV');
    }
    return { handle, samples: dataBytes / 2 };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function localClock(epoch: number): string {
  const date = new Date(epoch);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

/** Runs in a disposable process: native model memory and cancellation never affect the live transcript. */
export async function runOfflineRefinement(
  job: RefinementJob,
  onProgress: (progress: ArchiveRefineProgress) => void,
  dependencies: RefinementDependencies = nativeDependencies,
): Promise<ArchiveRevision> {
  const spec = getAsrModel(job.options.asrModel);
  if (!spec || !spec.languages.includes(job.options.language)) throw new Error('Unsupported recognition model or language');
  const translationModel = job.options.translationModel;
  if (translationModel && !getTranslationModel(translationModel)) throw new Error('Only existing local translation models are supported');
  if (!['zh', 'ja', 'en', 'ko'].includes(job.options.targetLang)) throw new Error('Unsupported translation language');
  const recordings = [...job.recordings].sort((a, b) => a.attachment.startedAt - b.attachment.startedAt);
  const ids = new Set<string>();
  for (const { attachment } of recordings) {
    if (!attachment.id || ids.has(attachment.id) || !Number.isFinite(attachment.startedAt)) throw new Error('Invalid recording attachment');
    ids.add(attachment.id);
  }
  // The existing transducer models become unstable on longer windows; more time is not automatically more accurate.
  const maxSpeechSeconds = spec.engine === 'transducer' ? 3 : 12;
  const maxDecodeSamples = maxSpeechSeconds * SAMPLE_RATE;
  const totalMs = recordings.reduce((sum, r) => sum + Math.max(0, r.attachment.durationMs), 0);
  let completedMs = 0;
  const lines: ArchiveLine[] = [];
  const progress = (state: ArchiveRefineProgress['state'], completed: number, total: number) => {
    onProgress({ archiveId: job.archiveId, state, completed, total });
  };
  progress('transcribing', 0, totalMs);
  const inference = recordings.length ? await dependencies.createInference(job, spec, maxSpeechSeconds) : undefined;
  for (const recording of recordings) {
    const { handle, samples: totalSamples } = await openWave(recording.filePath);
    try {
      const vad = inference!.createVad();
      const decodeSpan = (span: SpeechSpan): void => {
        if (!Number.isInteger(span.start) || span.start < 0) throw new Error('Invalid speech segment offset');
        const spanSamples = Math.min(span.samples.length, Math.max(0, totalSamples - span.start));
        for (let offset = 0; offset < spanSamples; offset += maxDecodeSamples) {
          const length = Math.min(maxDecodeSamples, spanSamples - offset);
          let samples = span.samples.subarray(offset, offset + length);
          if (samples.length < MIN_DECODE_SAMPLES) {
            const padded = new Float32Array(MIN_DECODE_SAMPLES);
            padded.set(samples);
            samples = padded;
          }
          const result = inference!.decode(samples);
          const text = cleanAsrText(result.text || '');
          if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
          const detected = (result.lang || '').replace(/[<|>]/g, '');
          const lang = guardAsrLang(text, job.options.language === 'auto' ? detected : job.options.language);
          if (!['zh', 'ja', 'en', 'ko', 'yue'].includes(lang)) throw new Error('Recognition returned no supported source language');
          const start = (span.start + offset) / SAMPLE_RATE;
          lines.push({
            time: localClock(recording.attachment.startedAt + start * 1000),
            text, translation: '', lang,
            audio: { recordingId: recording.attachment.id, start, duration: length / SAMPLE_RATE },
          });
        }
      };
      const drain = (): void => {
        while (!vad.isEmpty()) {
          // Electron disallows sherpa's default external ArrayBuffer; request an owned copy.
          decodeSpan(vad.front(false));
          vad.pop();
        }
      };
      let pending = new Float32Array(VAD_WINDOW);
      let pendingSamples = 0;
      const bytes = Buffer.alloc(READ_BYTES);
      for (let sampleOffset = 0; sampleOffset < totalSamples;) {
        const count = Math.min(READ_BYTES / 2, totalSamples - sampleOffset);
        await readExactly(handle, bytes.subarray(0, count * 2), WAV_HEADER_BYTES + sampleOffset * 2);
        for (let index = 0; index < count; index++) {
          pending[pendingSamples++] = bytes.readInt16LE(index * 2) / 32768;
          if (pendingSamples === VAD_WINDOW) {
            vad.acceptWaveform(pending);
            drain();
            pending = new Float32Array(VAD_WINDOW);
            pendingSamples = 0;
          }
        }
        sampleOffset += count;
        progress('transcribing', completedMs + sampleOffset / SAMPLE_RATE * 1000, totalMs);
      }
      // VAD requires full windows; keep the final real samples and clip padded silence from saved offsets.
      if (pendingSamples) vad.acceptWaveform(pending);
      vad.flush();
      drain();
      completedMs += totalSamples / SAMPLE_RATE * 1000;
    } finally {
      await handle.close();
    }
  }
  if (translationModel && lines.some(line => line.lang !== job.options.targetLang)) {
    progress('translating', 0, lines.length);
    const translator = await dependencies.createTranslator(translationModel, job.cacheDir);
    await translator.init();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.lang !== job.options.targetLang) {
        // Keep HY-MT2 source-only; including earlier sentences previously translated the wrong sentence.
        const translated = await translator.translate(line.text, { source: line.lang, target: job.options.targetLang });
        if (!translated.trim()) throw new Error('Local translation returned empty text');
        line.translation = job.options.targetLang === 'zh' ? normalizeZh(translated.trim()) : translated.trim();
      }
      progress('translating', index + 1, lines.length);
    }
  }
  return { id: `r${randomUUID()}`, createdAt: Date.now(), options: { ...job.options }, lines };
}
