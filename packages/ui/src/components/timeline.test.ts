import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { expect, it } from 'vitest';
import ConversationLine from './ConversationLine.vue';
import TranscriptList from './TranscriptList.vue';
import { i18n } from '../i18n';

async function render(component: any, props: Record<string, unknown>) {
  return renderToString(createSSRApp(component, props).use(i18n));
}
it('renders the live wall clock alongside source and accented translation', async () => {
  const html = await render(TranscriptList, { lines: [{ displayId: 1, id: 1, time: '19:38:14', text: 'Source', translation: 'Translation', translating: false, failed: false }], partial: '', emptyHint: '', translateOn: true });
  expect(html).toContain('<time class="timeline-time"');
  expect(html).toContain('19:38:14</time>');
  expect(html).toContain('caption-body');
  expect(html).toContain('caption-translation');
  expect(html).toContain('Translation');
});
it('renders archive clocks and tolerates legacy lines without a time column', async () => {
  expect(await render(ConversationLine, { time: '19:38:14', text: 'Source', translation: 'Translation' })).toContain('19:38:14</time>');
  for (const time of [undefined, '']) {
    const html = await render(ConversationLine, { time, text: 'Legacy source', translation: 'Legacy translation' });
    expect(html).not.toContain('<time');
    expect(html).toContain('Legacy source');
    expect(html).toContain('Legacy translation');
  }
});
