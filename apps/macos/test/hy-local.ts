import fs from 'node:fs';
import path from 'node:path';
import { HyTranslator } from '../src/main/translation/hy-translator';

async function main() {
  const [cacheDir, input, output] = process.argv.slice(2);
  if (!cacheDir || !input || !output) throw new Error('Usage: hy-local <cacheDir> <source-rows.json> <result.json>');
  const data = JSON.parse(fs.readFileSync(input, 'utf8'));
  const sourceRows: Array<{ text: string }> = Array.isArray(data) ? data : data.rows;
  const translator = new HyTranslator(path.resolve(cacheDir));
  const boot = performance.now();
  await translator.init();
  const loadMs = performance.now() - boot;
  const results = [];
  const context: string[] = [];
  for (const row of sourceRows) {
    const start = performance.now();
    let firstMs: number | undefined;
    const translation = await translator.translate(row.text, {
      source: 'ja', target: 'zh', context: context.slice(-2),
      onPartial: () => { firstMs ??= performance.now() - start; },
    });
    context.push(row.text);
    results.push({ text: row.text, translation, firstMs, completedMs: performance.now() - start });
    console.log(JSON.stringify(results.at(-1)));
  }
  fs.writeFileSync(output, JSON.stringify({ engine: 'node-llama-cpp Metal', loadMs, results }, null, 2));
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
