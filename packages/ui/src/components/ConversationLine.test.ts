import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { i18n } from '../i18n';
import ConversationLine from './ConversationLine.vue';

function render(props: Record<string, unknown>) {
  return renderToString(createSSRApp(ConversationLine, props).use(i18n));
}

describe('archive line audio affordance', () => {
  it('shows a keyboard-accessible play action only when supplied an exact seek target', async () => {
    const playable = await render({ text: 'hello', time: '10:00:03', seekLabel: 'Play from 10:00:03', active: true });
    expect(playable).toContain('<button');
    expect(playable).toContain('aria-label="Play from 10:00:03"');
    expect(playable).toContain('aria-current="true"');
    const legacy = await render({ text: 'hello', time: '10:00:03' });
    expect(legacy).toContain('<time');
    expect(legacy).not.toContain('<button');
  });
});
