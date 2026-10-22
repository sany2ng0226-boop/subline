// Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/timeline-shots.mjs
// Uses synthetic data only, following the existing headless qa-shots workflow.
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const entry = `
import { createApp, h } from 'vue';
import TranscriptList from '/packages/ui/src/components/TranscriptList.vue';
import ConversationLine from '/packages/ui/src/components/ConversationLine.vue';
import { i18n } from '/packages/ui/src/i18n.ts';
import '/packages/ui/src/styles.css';
const lines = [
  { displayId: 1, id: 1, time: '19:38:14', text: '今日は、デザインと日常生活の関係について考えます。', translation: '今天，我们来思考设计与日常生活的关系。' },
  { displayId: 2, id: 2, time: '19:38:26', text: 'Small details can make information easier to understand.', translation: '细节可以让信息更容易理解。' },
];
createApp({ render: () => h('main', { style: 'height:100vh;padding:24px;--transcript-size:18px' }, [
  h('h1', { style: 'font-size:16px;margin-bottom:12px' }, 'Live subtitles'),
  h('section', { style: 'height:340px;display:flex' }, [h(TranscriptList, { lines, partial: '', emptyHint: '', translateOn: true, sourceLang: 'ja', targetLang: 'zh' })]),
  h('h2', { style: 'font-size:16px;margin:20px 0' }, 'Archive detail'),
  ...lines.map(line => h(ConversationLine, line)),
  h(ConversationLine, { text: 'Legacy archive without a timestamp', translation: '旧归档：没有时间也能正常阅读。' }),
]) }).use(i18n).mount('#app');`;
const server = await createServer({
  root, configFile: false, plugins: [vue(), tailwindcss(), {
    name: 'timeline-fixture',
    configureServer(server) {
      server.middlewares.use('/timeline-fixture', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml('/timeline-fixture', '<html><body><div id="app"></div><script type="module" src="/timeline-entry.js"></script></body></html>'));
      });
    },
    resolveId(id) { if (id === '/timeline-entry.js') return '\0timeline-entry'; },
    load(id) { if (id === '\0timeline-entry') return entry; },
  }],
  resolve: { alias: { '@rt/core': path.join(root, 'packages/core/src/index.ts') } },
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  await mkdir(path.join(root, 'qa-shots'), { recursive: true });
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0] + 'timeline-fixture');
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.locator('.timeline-time').first().waitFor();
    await page.waitForFunction(() => {
      const row = document.querySelector('.caption-row');
      return row && getComputedStyle(row).display === 'flex';
    });
    await page.evaluate(() => document.fonts.ready);
    if (await page.locator('.timeline-time').count() !== 4) throw new Error('Missing live/archive clock');
    if (errors.length) throw new Error(errors.join('\n'));
    await page.screenshot({ path: path.join(root, `qa-shots/timeline-${theme}.png`), animations: 'disabled' });
    console.log(`qa-shots/timeline-${theme}.png`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
