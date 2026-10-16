import fs from 'node:fs';
import crypto from 'node:crypto';
import { readWave } from 'sherpa-onnx-node';
import { SentenceAssembler, CloudTranslator, TranslationContext, type SegmentPayload, type SentenceAssemblyOptions } from '@rt/core';
import { TranscriptionPipeline, SAMPLE_RATE } from '../src/main/pipeline';
import { BOUNDARY_PROMPTS, createLocalBoundaryJudge } from './local-boundary-judge';

type Event = { atMs: number; segment?: SegmentPayload; partial?: string };
type Row = SegmentPayload & { emittedMs: number; translatedMs?: number; translation?: string; error?: string };
type Mode = 'rules' | 'grace-rules' | 'fast-rules' | 'reviewed' | 'active' | keyof typeof BOUNDARY_PROMPTS;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const normalize = (text: string) => text.replace(/\s/g, '');

async function main() {
  const [wav, models, output, order = 'baseline-first', traceFile, promptMode = 'original'] = process.argv.slice(2);
  if (!wav || !models || !output || !['original', 'small', 'compare', 'limit-audit', 'active-vs-rules'].includes(promptMode)) {
    throw new Error('Usage: semantic-boundary-replay <wav> <models> <output> [assisted-first] [previous-result.json] [original|small|compare|limit-audit|active-vs-rules]');
  }
  const wave = readWave(wav);
  if (wave.sampleRate !== SAMPLE_RATE) throw new Error('Expected 16kHz mono WAV');
  const audioSha256 = crypto.createHash('sha256').update(fs.readFileSync(wav)).digest('hex');
  const trace = traceFile ? JSON.parse(fs.readFileSync(traceFile, 'utf8')) : undefined;
  if (trace && trace.audioSha256 !== audioSha256) throw new Error('Trace belongs to different audio');
  let atMs = 0;
  const events: Event[] = trace?.events ?? [];
  if (!traceFile) {
    const asr = new TranscriptionPipeline(models, 'sense-voice', 'ja', {
      onSegment: (s) => events.push({ atMs, segment: { ...s } }),
      onPartial: ({ text }) => { if (text) events.push({ atMs, partial: text }); },
    }, { sentenceAssembly: false });
    for (let i = 0; i < wave.samples.length; i += 1600) {
      atMs = Math.min(i + 1600, wave.samples.length) / SAMPLE_RATE * 1000;
      asr.acceptWaveform(wave.samples.subarray(i, i + 1600));
    }
    asr.flush();
  }
  const translator = new CloudTranslator({ baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', model: 'hy-mt2-1.8b' });
  await translator.translate('こんにちは。', { source: 'ja', target: 'zh' });
  for (const prompt of promptMode === 'compare' ? Object.values(BOUNDARY_PROMPTS) : [BOUNDARY_PROMPTS[promptMode === 'original' ? 'original' : 'small']]) {
    await createLocalBoundaryJudge(prompt)('この説明は終わりです。', 'ja', AbortSignal.timeout(5000));
  }

  async function run(mode: Mode) {
    const assisted = mode !== 'rules' && mode !== 'grace-rules' && mode !== 'fast-rules';
    const localBoundaryJudge = createLocalBoundaryJudge(BOUNDARY_PROMPTS[mode === 'original' ? 'original' : 'small']);
    const context = new TranslationContext();
    const rows: Row[] = [];
    const decisions: Array<Parameters<NonNullable<SentenceAssemblyOptions['onDecision']>>[0]> = [];
    const calls: Array<{ text: string; ms?: number; result?: boolean; cancelled?: boolean; error?: string }> = [];
    const translations: Promise<void>[] = [];
    const flushEvents: Array<Parameters<NonNullable<SentenceAssemblyOptions['onFlush']>>[0] & { atMs: number }> = [];
    const configuration = { reviewLimits: mode === 'reviewed' || mode === 'active', reviewEverySegment: mode === 'active',
      shortSentenceRule: mode === 'fast-rules',
      maxWaitMs: mode === 'grace-rules' || mode === 'fast-rules' ? 12000 : 8000,
      maxAudioSeconds: mode === 'grace-rules' || mode === 'fast-rules' ? 14 : 10 };
    const start = performance.now();
    const assembler = new SentenceAssembler((segment) => {
      const row: Row = { ...segment, emittedMs: performance.now() - start };
      rows.push(row);
      const previous = context.take(segment.lang, 'zh', segment.text);
      translations.push(translator.translate(segment.text, { source: 'ja', target: 'zh', context: previous })
        .then((text) => { row.translation = text; row.translatedMs = performance.now() - start; })
        .catch((e) => { row.error = String(e); }));
    }, {
      ...configuration,
      onFlush: (event) => flushEvents.push({ ...event, atMs: performance.now() - start }),
      ...(assisted ? {
      judgeTimeoutMs: 1000,
      onDecision: (decision) => decisions.push(decision),
      judge: async (text, lang, signal) => {
        const call: (typeof calls)[number] = { text }; calls.push(call);
        const t = performance.now();
        try { const result = await localBoundaryJudge(text, lang, signal); call.result = result; return result; }
        catch (e) { call.cancelled = signal.aborted; call.error = String(e); throw e; }
        finally { call.ms = performance.now() - t; }
      },
      } : {}),
    });
    for (const event of events) {
      await sleep(event.atMs - (performance.now() - start));
      if (event.segment) assembler.push(event.segment);
      else assembler.touch();
    }
    assembler.flush();
    await Promise.all(translations);
    const raw = events.filter((e) => e.segment);
    const expected = normalize(raw.map((e) => e.segment!.text).join(''));
    if (normalize(rows.map((r) => r.text).join('')) !== expected) throw new Error('Recognized text was changed or lost');
    let offset = 0;
    const ranges = rows.map((r) => { offset += normalize(r.text).length; return { end: offset, row: r }; });
    offset = 0;
    const fragmentWaits = raw.map((e) => {
      offset += normalize(e.segment!.text).length;
      const row = ranges.find((r) => r.end >= offset)!.row;
      return { text: e.segment!.text, sourceAvailableMs: e.atMs,
        boundaryWaitMs: row.emittedMs - e.atMs,
        subtitleWaitMs: row.translatedMs === undefined ? null : row.translatedMs - e.atMs };
    });
    const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(JSON.stringify({ mode, rows: rows.length, decisions: decisions.length }));
    return { assisted, prompt: mode, configuration, flushEvents, rows, decisions, calls, fragmentWaits, textPreserved: true,
      meanBoundaryWaitMs: average(fragmentWaits.map((r) => r.boundaryWaitMs)),
      meanSubtitleWaitMs: average(fragmentWaits.flatMap((r) => r.subtitleWaitMs === null ? [] : [r.subtitleWaitMs])),
    };
  }
  const firstAssisted = order === 'assisted-first';
  const modes: Mode[] = promptMode === 'active-vs-rules' ? (firstAssisted ? ['active', 'fast-rules'] : ['fast-rules', 'active'])
    : promptMode === 'limit-audit'
    ? (firstAssisted ? ['reviewed', 'grace-rules', 'small', 'rules'] : ['rules', 'small', 'grace-rules', 'reviewed'])
    : promptMode === 'compare'
      ? (firstAssisted ? ['small', 'original', 'rules'] : ['rules', 'original', 'small'])
      : (firstAssisted ? [promptMode as keyof typeof BOUNDARY_PROMPTS, 'rules'] : ['rules', promptMode as keyof typeof BOUNDARY_PROMPTS]);
  const results = new Map<string, Awaited<ReturnType<typeof run>>>();
  for (const mode of modes) results.set(mode, await run(mode));
  const result = { audio: wav, audioSha256, order,
    audioSeconds: wave.samples.length / SAMPLE_RATE, events,
    method: 'Identical SenseVoice ja ASR event trace from the same audio replayed at original audio timestamps. Same Hy-MT2 translation and context run during replay. Both LLMs resident and prewarmed. Delays are measured from identical finalized ASR fragment availability to boundary/Chinese completion; audio acquisition and ASR compute excluded. EOF forces pending text out. Not a human-annotated accuracy score.',
    promptMode, prompts: BOUNDARY_PROMPTS,
    baseline: results.get(promptMode === 'active-vs-rules' ? 'fast-rules' : 'rules')!, original: promptMode === 'compare' ? results.get('original') : undefined,
    strict: promptMode === 'limit-audit' ? results.get('small') : undefined,
    grace: promptMode === 'limit-audit' ? results.get('grace-rules') : undefined,
    assisted: results.get(promptMode === 'active-vs-rules' ? 'active' : promptMode === 'limit-audit' ? 'reviewed' : promptMode === 'compare' ? 'small' : promptMode)! };
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, baselineRows: result.baseline?.rows.length, assistedRows: result.assisted.rows.length,
    baselineWaitMs: result.baseline?.meanSubtitleWaitMs, assistedWaitMs: result.assisted.meanSubtitleWaitMs }));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
