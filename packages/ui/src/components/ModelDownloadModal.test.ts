import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { expect, it, vi } from 'vitest';
import { getTranslationModel, type AppBridge } from '@rt/core';
import { setBridge } from '../bridge';
import { i18n } from '../i18n';
import { missingTranslationDownload } from '../composables/translationDownload';
import { humanBytes } from '../utils/bytes';
import ModelDownloadModal from './ModelDownloadModal.vue';

vi.mock('naive-ui', () => {
  const passthrough = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) });
  return { NModal: passthrough, NButton: passthrough };
});

it.each(['en', 'ja', 'ko', 'zh'] as const)('shows the selected M2M-100 model and its catalog size in the %s download prompt', async locale => {
  setBridge({
    getTranslationSetupStatus: vi.fn().mockResolvedValue({ ready: false }),
    downloadTranslationModel: vi.fn(),
  } as unknown as AppBridge);
  const tasks = await missingTranslationDownload('m2m100');
  const spec = getTranslationModel('m2m100')!;
  const previousLocale = i18n.global.locale.value;
  try {
    i18n.global.locale.value = locale;
    const html = await renderToString(createSSRApp(ModelDownloadModal, { show: true, tasks }).use(i18n));
    const prompt = html.match(/<p[^>]*>(.*?)<\/p>/s)?.[1];
    expect(prompt).toContain(i18n.global.t(spec.nameKey));
    expect(prompt).toContain(humanBytes(spec.approxDownloadBytes));
    expect(prompt).toContain('610.4 MB');
    expect(html).not.toContain('Hy-MT2');
    expect(html).not.toContain('4.5 GB');
  } finally {
    i18n.global.locale.value = previousLocale;
  }
});
