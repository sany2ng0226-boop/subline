import { expect, it, vi } from 'vitest';
import { createSSRApp, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { LOCAL_TRANSLATION_MODELS, type AppBridge } from '@rt/core';
import { i18n } from '../../i18n';
import { setBridge } from '../../bridge';
import ModelsSection from './ModelsSection.vue';

vi.mock('../../composables/useModels', () => ({
  useModels: () => ({
    models: ref(LOCAL_TRANSLATION_MODELS.map((m) => ({
      id: m.id, kind: 'translation', downloaded: false, sizeBytes: 0, inUse: false,
    }))),
    refreshModels: vi.fn(),
  }),
}));

it.each(['en', 'ja', 'zh'] as const)('renders ultra quality only for HY-MT2 alongside its size in %s', async (locale) => {
  setBridge({ platform: 'macos' } as AppBridge);
  i18n.global.locale.value = locale;
  const html = await renderToString(createSSRApp(ModelsSection).use(i18n));
  const rows = html.match(/<li\b[\s\S]*?<\/li>/g)!;
  expect(rows).toHaveLength(LOCAL_TRANSLATION_MODELS.length);
  const messages = i18n.global.getLocaleMessage(locale).modelsScreen;
  for (const [index, model] of LOCAL_TRANSLATION_MODELS.entries()) {
    const row = rows[index];
    if (model.id === 'hy-mt2-7b') {
      expect(row).toContain(messages.ultra);
      expect(row).toContain(messages.ultraDesc);
      expect(row).toContain('4.3 GB');
    } else {
      expect(row).not.toContain(messages.ultra);
      expect(row).not.toContain(messages.ultraDesc);
    }
  }
});
