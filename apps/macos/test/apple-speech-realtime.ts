// Silent real-time PCM replay through the same two ASR adapters used by the application.
// Usage: build-test.mjs test/apple-speech-realtime.ts; node dist-test/test/apple-speech-realtime.js WAV MODELS_DIR HELPER OUTPUT_JSON
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readWave } from 'sherpa-onnx-node';
import { AppleSpeechClient, queryAppleSpeechSetup } from '../src/main/apple-speech-client';
import { TranscriptionPipeline } from '../src/main/pipeline';
import type { AsrToMain } from '../src/shared/types';

async function main(): Promise<void> {
  const [wav, modelsDir, helper, output] = process.argv.slice(2);
  if (!wav || !modelsDir || !helper || !output) throw new Error('Expected WAV MODELS_DIR HELPER OUTPUT_JSON');
  const wave = readWave(wav);
  if (wave.sampleRate !== 16_000) throw new Error('Expected 16 kHz mono WAV');
  const setup = await queryAppleSpeechSetup(helper, 'ja');
  if (!setup.asrReady) throw new Error(setup.error ?? 'Prepare the Japanese system speech model first');
  const results: unknown[] = [];
  for (const engine of ['apple-speech', 'sense-voice'] as const) {
    const events: { atSeconds: number; event: AsrToMain }[] = [];
    let started = performance.now();
    const receive = (event: AsrToMain): void => {
      if (event.type === 'error') throw new Error(event.message);
      events.push({ atSeconds: (performance.now() - started) / 1000, event });
    };
    const loadStart = performance.now();
    const adapter = engine === 'apple-speech'
      ? new AppleSpeechClient(helper, 'ja', receive)
      : new TranscriptionPipeline(modelsDir, engine, 'ja', {
        onPartial: payload => receive({ type: 'partial', payload }),
        onSegment: payload => receive({ type: 'segment', payload }),
      });
    if (adapter instanceof AppleSpeechClient) await adapter.ready;
    const loadSeconds = (performance.now() - loadStart) / 1000;
    adapter.reset();
    started = performance.now();
    let maxFeedDelayMs = 0;
    try {
      for (let offset = 0; offset < wave.samples.length; offset += 2048) {
        const target = started + offset / wave.sampleRate * 1000;
        const wait = target - performance.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        maxFeedDelayMs = Math.max(maxFeedDelayMs, performance.now() - target);
        adapter.acceptWaveform(wave.samples.subarray(offset, offset + 2048));
      }
      const flushStarted = performance.now();
      if (adapter instanceof AppleSpeechClient) await adapter.flush(1);
      else adapter.flush();
      const flushSeconds = (performance.now() - flushStarted) / 1000;
      const segments = events.flatMap(e => e.event.type === 'segment' ? [e.event.payload] : []);
      const firstPartial = events.find(e => e.event.type === 'partial' && e.event.payload.text.trim());
      results.push({ engine, loadSeconds, audioSeconds: wave.samples.length / wave.sampleRate,
        maxFeedDelayMs, flushSeconds, firstPartialFromFileStartSeconds: firstPartial?.atSeconds,
        partialUpdates: events.filter(e => e.event.type === 'partial' && e.event.payload.text).length,
        text: segments.map(s => s.text).join(''), segments, events });
      fs.writeFileSync(output, JSON.stringify({ scope: 'Silent scheduled 2048-sample PCM replay; not live microphone or system capture', wav, results }, null, 2));
      console.log(JSON.stringify({ engine, segments: segments.length, maxFeedDelayMs, flushSeconds }));
    } finally { if (adapter instanceof AppleSpeechClient) adapter.dispose(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
