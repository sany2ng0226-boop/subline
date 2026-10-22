import { expect, it, vi } from 'vitest';
import { build } from 'vite';
import { resolve } from 'node:path';

// Version lookup normally shells out to git; it is irrelevant to module resolution.
vi.mock('../../scripts/build-version', () => ({ buildVersion: () => 'test' }));

it('includes the current workspace MainScreen shortcut subscription in production', async () => {
  const { default: config } = await import('./electron.vite.config');
  const result = await build({
    ...config.renderer,
    configFile: false,
    root: resolve(import.meta.dirname, 'src/renderer'),
    logLevel: 'silent',
    build: { write: false, minify: false },
  });
  const outputs = (Array.isArray(result) ? result : [result])
    .flatMap((output) => 'output' in output ? output.output : []);
  const code = outputs.filter((output) => output.type === 'chunk').map((chunk) => chunk.code).join('\n');
  expect(code).toContain('timeline-time');
  expect(code).toContain('settings.targetLang');
  expect(code).toContain('function onShortcutAction(');
  expect(code).toContain('onUnmounted(onShortcutAction("toggleRecording"');
}, 20_000);
