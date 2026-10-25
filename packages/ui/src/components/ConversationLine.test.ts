import { beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { i18n } from '../i18n';
import ConversationLine from './ConversationLine.vue';

function render(props: Record<string, unknown>) {
  return renderToString(createSSRApp(ConversationLine, props).use(i18n));
}
beforeEach(() => { i18n.global.locale.value = 'zh'; });

describe('proofread line review', () => {
  it('flags lines to check with the reason and keeps the pre-edit text collapsed', async () => {
    const html = await render({
      text: '张教授', translation: '張教授', seekLabel: '从 0:05 开始播放', time: '0:05',
      review: { needsReview: true, note: '人名听不清', originalText: '章教授' },
    });
    expect(html).toContain('待核对');
    expect(html).toContain('人名听不清');
    expect(html).toMatch(/<details[^>]*>(?:(?!<\/details>).)*查看修改前(?:(?!<\/details>).)*章教授/s);
    expect(html).not.toMatch(/<details[^>]*open/);
    // Proofread text is shown, and the exact audio seek target survives the edit.
    expect(html).toContain('张教授');
    expect(html).toContain('aria-label="从 0:05 开始播放"');
  });

  it('shows nothing extra for confident unchanged lines and plain archive lines', async () => {
    const reviewed = await render({ text: 'ok', translation: '', review: { needsReview: false, note: '', originalText: 'ok' } });
    const plain = await render({ text: 'ok', translation: '' });
    for (const html of [reviewed, plain]) {
      expect(html).not.toContain('待核对');
      expect(html).not.toContain('<details');
    }
  });

  it('keeps a note for confident edits behind the disclosure', async () => {
    const html = await render({ text: '东京', translation: '', review: { needsReview: false, note: '统一地名写法' } });
    expect(html).not.toContain('待核对');
    expect(html).toMatch(/<details[^>]*>(?:(?!<\/details>).)*校对说明(?:(?!<\/details>).)*统一地名写法/s);
  });
});
