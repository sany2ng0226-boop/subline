// Silent, real-time replay of the production macOS ASR, assembler and translation queue.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { readWave } from 'sherpa-onnx-node';
import { TranscriptionPipeline } from '../src/main/pipeline';
import { TranslationRequestQueue } from '../src/main/translation/request-queue';
import { CloudTranslator, isLoopbackEndpoint, TranslationContext, type SegmentPayload } from '@rt/core';
import { clockMs, sentenceTiming, translationTiming, distribution, type TimedFragment } from './stage-metrics';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
type Manifest = { schemaVersion: number; caseId: string; audioSha256: string; sampleRate: number; asrModel: string; language: 'ja'; translationModel: string;
  expectedSegments: Array<{ textSha256: string; start: number; duration: number; lang: string }> };
type Row = SegmentPayload & ReturnType<typeof sentenceTiming> & {
  finalizedMs: number; reason: string; enqueuedMs: number; startedMs?: number; completedMs?: number;
  translation?: string; error?: string; dispatchMs?: number; queueWaitMs?: number; translationMs?: number; endToEndMs?: number;
};
async function worker(wav: string, models: string) {
  const boot = clockMs();
  const wave = readWave(wav);
  const post = (kind: string, payload: unknown) => process.send!({ kind, payload, clock: clockMs() });
  let reason = '';
  const pipeline = new TranscriptionPipeline(models, 'sense-voice', 'ja', {
    onPartial: payload => post('partial', payload),
    onSegment: payload => post('final', { segment: payload, reason }),
  }, {
    onDiagnostic: payload => post('diagnostic', payload),
    sentenceOptions: { onFlush: event => { reason = event.reason; post('boundary', event); } },
  });
  const start = await new Promise<number>(resolve => {
    process.once('message', (message: { start: number }) => resolve(message.start));
    post('ready', { bootMs: clockMs() - boot });
  });
  let maxFeedLatenessMs = 0;
  for (let i = 0; i < wave.samples.length; i += 1600) {
    const end = Math.min(i + 1600, wave.samples.length);
    // Deliver a chunk only after its last audio sample would have arrived in real time.
    const target = start + end / wave.sampleRate * 1000;
    await sleep(target - clockMs());
    maxFeedLatenessMs = Math.max(maxFeedLatenessMs, clockMs() - target);
    pipeline.acceptWaveform(wave.samples.subarray(i, end));
  }
  pipeline.flush();
  post('done', { maxFeedLatenessMs });
  process.disconnect!();
}

async function main() {
  const [wav, models, manifestPath, output] = process.argv.slice(2);
  if (!wav || !models || !manifestPath || !output) throw new Error('Usage: stage-latency <16k-mono.wav> <modelsDir> <manifest.json> <output.json>');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  const audioHash = sha(fs.readFileSync(wav));
  const wave = readWave(wav);
  if (manifest.schemaVersion !== 1 || manifest.asrModel !== 'sense-voice' || manifest.language !== 'ja' || manifest.translationModel !== 'hy-mt2-7b') throw new Error('Unexpected fixed case/model configuration');
  if (audioHash !== manifest.audioSha256 || wave.sampleRate !== 16000 || manifest.sampleRate !== 16000) throw new Error('Audio hash/sample rate mismatch; refusing an incomparable run');
  const baseURL = process.env.RT_TRANSLATION_BASE_URL ?? 'http://127.0.0.1:1234/v1';
  if (!isLoopbackEndpoint(baseURL)) throw new Error('This private classroom benchmark permits loopback translation only');
  const translator = new CloudTranslator({ baseURL, apiKey: process.env.RT_TRANSLATION_API_KEY ?? '', model: manifest.translationModel });
  const warmStart = clockMs();
  await translator.translate('こんにちは。', { source: 'ja', target: 'zh' });
  const translationWarmupMs = clockMs() - warmStart;
  const context = new TranslationContext();
  const events: Array<{ kind: string; atMs: number; payload: any }> = [];
  const fragments: TimedFragment[] = [], rows: Row[] = [], jobs: Promise<unknown>[] = [];
  let start = 0, bootMs = 0, maxFeedLatenessMs = 0, active = 0, maxActive = 0, pending = 0, maxPending = 0;
  const queue = new TranslationRequestQueue<{ row: Row; context: string[] }, string>(async ({ row, context: previous }) => {
    row.startedMs = clockMs() - start;
    active++; maxActive = Math.max(maxActive, active);
    events.push({ kind: 'translation-start', atMs: row.startedMs, payload: { id: row.id } });
    try { return await translator.translate(row.text, { source: 'ja', target: 'zh', context: previous }); }
    finally { active--; }
  });
  const child = fork(__filename, ['--worker', wav, models], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const watchdog = setTimeout(() => { child.kill(); reject(new Error('Replay watchdog expired')); }, (wave.samples.length / wave.sampleRate + 60) * 1000);
      const fail = (error: Error) => { clearTimeout(watchdog); reject(error); };
      child.on('error', fail);
      child.on('exit', code => { if (!done) fail(new Error(`ASR worker exited before completion (${code})`)); });
      child.on('message', (message: { kind: string; clock: number; payload: any }) => {
        try {
          if (message.kind === 'ready') {
            bootMs = message.payload.bootMs;
            start = clockMs() + 100;
            child.send({ start });
            return;
          }
          if (message.kind === 'fatal') { fail(new Error(message.payload)); return; }
          if (message.kind === 'done') { maxFeedLatenessMs = message.payload.maxFeedLatenessMs; done = true; clearTimeout(watchdog); resolve(); return; }
          // Startup decode diagnostics precede the replay clock and are summarized separately.
          if (!start) return;
          const atMs = message.clock - start;
          events.push({ kind: message.kind, atMs, payload: message.payload });
          if (message.kind === 'diagnostic' && message.payload.kind === 'asr-fragment') fragments.push({ atMs, segment: message.payload.segment });
          if (message.kind !== 'final') return;
          const segment = message.payload.segment as SegmentPayload;
          const row: Row = { ...segment, ...sentenceTiming(segment, atMs, fragments), finalizedMs: atMs,
            reason: message.payload.reason, enqueuedMs: clockMs() - start };
          rows.push(row); pending++; maxPending = Math.max(maxPending, pending);
          events.push({ kind: 'translation-enqueue', atMs: row.enqueuedMs, payload: { id: row.id } });
          const previous = context.take('ja', 'zh', row.text);
          jobs.push(queue.submit({ row, context: previous }).then(text => {
            row.translation = text; row.completedMs = clockMs() - start;
            Object.assign(row, translationTiming(row.finalizedMs, row.enqueuedMs, row.startedMs!, row.completedMs, row.audioEndMs));
            events.push({ kind: 'translation-end', atMs: row.completedMs, payload: { id: row.id } });
          }).catch(error => {
            row.error = String(error); row.completedMs = clockMs() - start;
            events.push({ kind: 'translation-failed', atMs: row.completedMs, payload: { id: row.id, error: row.error } });
          }).finally(() => pending--));
        } catch (error) { fail(error as Error); }
      });
    });
    await Promise.all(jobs);
  } finally { if (child.connected) child.kill(); }
  const expected = manifest.expectedSegments;
  const goldenMatch = rows.length === expected.length && rows.every((row, i) => sha(row.text) === expected[i].textSha256 &&
    row.lang === expected[i].lang && Math.abs(row.start - expected[i].start) < 0.005 && Math.abs(row.duration - expected[i].duration) < 0.005);
  const additiveMatch = rows.every(row => row.error || Math.abs(row.recognitionCommitMs + row.assemblyWaitMs + row.dispatchMs! + row.queueWaitMs! + row.translationMs! - row.endToEndMs!) < 0.01);
  const metrics = Object.fromEntries(['recognitionCommitMs', 'assemblyWaitMs', 'assemblyResidenceMs', 'dispatchMs', 'queueWaitMs', 'translationMs', 'endToEndMs'].map(key =>
    [key, distribution(rows.map(row => row[key as keyof Row]).filter((value): value is number => typeof value === 'number'))]));
  const appRoot = path.resolve(__dirname, '../..');
  const codeHashes = Object.fromEntries(['src/main/pipeline.ts', 'src/main/translation/request-queue.ts', '../../packages/core/src/asr/sentence-assembler.ts', '../../packages/core/src/asr/transcription-pipeline.ts', '../../packages/core/src/translation/cloud-translator.ts'].map(file => [file, sha(fs.readFileSync(path.resolve(appRoot, file)))]));
  const report = { schemaVersion: 1, caseId: manifest.caseId, audioSha256: audioHash, audioSeconds: wave.samples.length / wave.sampleRate,
    createdAt: new Date().toISOString(), models: { asr: manifest.asrModel, language: 'ja', translation: manifest.translationModel, baseURL }, codeHashes,
    warmup: { asrBootMs: bootMs, translationMs: translationWarmupMs },
    checks: { goldenMatch, additiveMatch, allTranslated: rows.every(row => !!row.translation && !row.error), maxActive, maxPending, maxFeedLatenessMs },
    definitions: {
      recognitionCommitMs: 'Last contributing raw ASR fragment emitted minus logical audio end; includes VAD, ASR computation and internal commitment waiting.',
      decodeMs: 'Individual native decoder calls only; separate distribution, not additive with recognitionCommitMs.',
      assemblyWaitMs: 'Sentence emitted minus last contributing raw fragment; additive post-ASR sentence waiting.',
      assemblyResidenceMs: 'Sentence emitted minus FIRST contributing fragment; contextual residence, not an additive stage.',
      queueWaitMs: 'Translation execution starts minus queue submission.',
      translationMs: 'Full local HTTP request, including server scheduling and generation; not isolated GPU compute.',
      endToEndMs: 'Complete translation minus logical sentence audio end; excludes microphone capture, device buffers and UI rendering.',
      percentiles: 'Nearest-rank; 12 sentences are insufficient to establish production p95.' },
    metrics, decodeMs: distribution(events.filter(e => e.kind === 'diagnostic' && e.payload.kind === 'decode' && !e.payload.warmup).map(e => e.payload.ms)),
    rows, events };
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, metrics, decodeMs: report.decodeMs }, null, 2));
  if (!goldenMatch || !additiveMatch || !report.checks.allTranslated) process.exitCode = 1;
}
if (process.argv[2] === '--worker') {
  void worker(process.argv[3], process.argv[4]).catch(error => { process.send?.({ kind: 'fatal', payload: String(error), clock: clockMs() }); process.exitCode = 1; process.disconnect?.(); });
} else void main().catch(error => { console.error(error); process.exitCode = 1; });
