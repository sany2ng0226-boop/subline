// Read-only PCM replay; does not acquire microphone/system audio or control OBS.
import fs from 'node:fs';
import { readWave } from 'sherpa-onnx-node';
import { CloudTranslator, TranslationContext, SentenceAssembler, type SegmentPayload } from '@rt/core';
import { TranscriptionPipeline, SAMPLE_RATE } from '../src/main/pipeline';

async function main(): Promise<void> {
  const [wav, modelsDir, output, model = 'zipformer-ja-reazonspeech'] = process.argv.slice(2);
  if (!wav || !modelsDir || !output) throw new Error('Usage: classroom-replay <16k-mono.wav> <modelsDir> <output.json> [asr-model]');
  const wave = readWave(wav);
  if (wave.sampleRate !== SAMPLE_RATE) throw new Error('Expected 16 kHz mono PCM');
  const raw: SegmentPayload[] = [];
  const baseline = new TranscriptionPipeline(modelsDir, model, 'ja', {
    onSegment: (s) => raw.push(s),
  }, { sentenceAssembly: false });
  const t0 = performance.now();
  for (let i = 0; i < wave.samples.length; i += 1600) baseline.acceptWaveform(wave.samples.subarray(i, i + 1600));
  baseline.flush();
  const asrMs = performance.now() - t0;

  const productSegments: SegmentPayload[] = [];
  const candidate = new TranscriptionPipeline(modelsDir, model, 'ja', {
    onSegment: (s) => productSegments.push(s),
  });
  for (let i = 0; i < wave.samples.length; i += 1600) candidate.acceptWaveform(wave.samples.subarray(i, i + 1600));
  candidate.flush();

  // Reuse identical recognized fragments for the controlled translation comparison.
  const assembled: SegmentPayload[] = [];
  const assembler = new SentenceAssembler((s) => assembled.push(s));
  raw.forEach((s) => assembler.push(s));
  assembler.flush();
  const normalize = (s: string) => s.replace(/\s/g, '');
  if (normalize(raw.map((s) => s.text).join('')) !== normalize(assembled.map((s) => s.text).join(''))) {
    throw new Error('Assembly changed or lost recognized text');
  }
  const translator = new CloudTranslator({ baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', model: 'hy-mt2-1.8b' });
  await translator.translate('こんにちは。', { source: 'ja', target: 'zh' });
  async function translate(segments: SegmentPayload[], contextual: boolean) {
    const context = new TranslationContext();
    const rows = [];
    for (const segment of segments) {
      const previous = contextual ? context.take(segment.lang, 'zh', segment.text) : [];
      const t = performance.now();
      const translation = await translator.translate(segment.text, { source: 'ja', target: 'zh', context: previous });
      rows.push({ ...segment, context: previous, translation, translationMs: Math.round(performance.now() - t) });
    }
    return rows;
  }
  const result = {
    audioSeconds: wave.samples.length / SAMPLE_RATE, asrModel: model, asrMs,
    comparison: 'Same audio and exactly the same ASR text. Baseline=independent fragments; candidate=bounded assembly plus previous two source segments. Accelerated replay is not wall-clock live latency.',
    raw: await translate(raw, false), assembled: await translate(assembled, true),
    productSegments,
    textPreserved: true,
  };
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, rawSegments: raw.length, assembledSegments: assembled.length, asrMs, textPreserved: true }));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
