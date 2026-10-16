// Isolate transport using frozen source rows from a hash-verified classroom replay.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CloudTranslator, TranslationContext } from '@rt/core';
import { distribution } from './stage-metrics';
async function main() {
  const [tracePath, manifestPath, output] = process.argv.slice(2);
  if (!tracePath || !manifestPath || !output) throw new Error('Usage: translation-transport-replay <stage-result.json> <manifest.json> <output.json>');
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sources: Array<{ id: number; text: string }> = trace.rows;
  const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  if (trace.audioSha256 !== manifest.audioSha256 || sources.length !== manifest.expectedSegments.length ||
    sources.some((source, i) => sha(source.text) !== manifest.expectedSegments[i].textSha256)) throw new Error('Frozen source does not match fixed recording');
  const translator = new CloudTranslator({ baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', model: 'hy-mt2-7b' });
  const runs = [];
  for (const mode of ['before', 'after', 'after', 'before']) {
    await translator.translate('こんにちは。', { source: 'ja', target: 'zh' });
    const context = new TranslationContext(); const rows = [];
    for (const source of sources) {
      const started = performance.now(); let firstMs: number | undefined;
      const partials: string[] = [];
      const text = await translator.translate(source.text, { source: 'ja', target: 'zh', context: context.take('ja', 'zh', source.text),
        ...(mode === 'after' ? { onPartial: (text: string) => { firstMs ??= performance.now() - started; partials.push(text); } } : {}),
      });
      const totalMs = performance.now() - started;
      rows.push({ id: source.id, source: source.text, text, firstMs: firstMs ?? totalMs, totalMs, partials,
        monotonic: partials.every((text, i) => text.startsWith(partials[i - 1] ?? '') && text.length > 0) && partials.every(partial => text.startsWith(partial)) });
    }
    runs.push({ mode, rows });
    console.log(mode, 'first', distribution(rows.map(r => r.firstMs))?.mean, 'full', distribution(rows.map(r => r.totalMs))?.mean);
  }
  const summary = Object.fromEntries(['before', 'after'].map(mode => {
    const rows = runs.filter(run => run.mode === mode).flatMap(run => run.rows);
    return [mode, { firstMs: distribution(rows.map(row => row.firstMs)), totalMs: distribution(rows.map(row => row.totalMs)) }];
  }));
  const exactMatch = runs.every(run => run.rows.every((row, i) => row.text === runs[0].rows[i].text));
  const monotonic = runs.every(run => run.rows.every(row => row.monotonic));
  fs.writeFileSync(output, JSON.stringify({ audioSha256: trace.audioSha256, protocol: 'ABBA, serial, unchanged prompt/context/temperature/model; silent', exactMatch, monotonic, summary, runs }, null, 2));
  console.log({ exactMatch, monotonic, summary });
  if (!exactMatch || !monotonic) process.exitCode = 1;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
