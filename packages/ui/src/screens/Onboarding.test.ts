import { beforeEach, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, h, nextTick, ref, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { ASR_MODELS, makeDefaults, translationModelsFor, type AppBridge } from '@rt/core';
import { setBridge } from '../bridge';
import { i18n } from '../i18n';
import { humanBytes } from '../utils/bytes';

const state = vi.hoisted(() => ({ save: vi.fn(), downloads: vi.fn() }));
vi.mock('../composables/useSettings', () => ({
  settings: ref(null), saveSettings: state.save,
  previewLocale: vi.fn(), previewTheme: vi.fn(), applyFontSize: vi.fn(),
}));
vi.mock('../composables/useModelDownloads', () => ({ startDownloads: state.downloads }));
vi.mock('../components/settings/GeneralSection.vue', () => ({ default: { render: () => null } }));
vi.mock('naive-ui', () => ({
  NButton: { setup: (_: unknown, { slots }: any) => () => h('button', slots.default?.()) },
  NFormItem: { props: ['label'], setup: (p: any, { slots }: any) => () => h('label', [p.label, slots.default?.()]) },
  NSelect: { props: ['value', 'options', 'renderLabel'], render: () => null },
}));
import { settings } from '../composables/useSettings';
import Onboarding from './Onboarding.vue';

beforeEach(() => { vi.clearAllMocks(); settings.value = makeDefaults(['zh']); });

async function mount(platform: AppBridge['platform'] = 'macos', ready = false, local = true) {
  setBridge({ platform, localTranslationAvailable: local, getSetupStatus: vi.fn(async () => ({ asrReady: ready })) } as unknown as AppBridge);
  const renderer = createRenderer<any, any>({
    patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}),
    createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp({ ...Onboarding, render: () => null });
  app.provide(ssrContextKey, { modules: new Set() });
  const vm = app.use(i18n).mount({}) as any;
  const setup = vm.$.setupState;
  setup.step = 2;
  await nextTick();
  return { app, setup, vm };
}

it.each(['zh', 'ja', 'en'] as const)('offers exactly two model choices with registry sizes and HY ultra badge in %s', async (locale) => {
  i18n.global.locale.value = locale;
  const { app, setup, vm } = await mount();
  try {
    const html = await renderToString(createSSRApp({ ...Onboarding, setup: () => setup }).use(i18n));
    expect(html.match(/<label>/g)).toHaveLength(2);
    expect(html).toContain(i18n.global.t('onboarding.modelHint'));
    expect(setup.asrOptions.map((o: any) => o.value)).toEqual(ASR_MODELS.filter(m => m.platforms.includes('macos')).map(m => m.id));
    for (const m of ASR_MODELS.filter(m => m.platforms.includes('macos'))) {
      expect(setup.asrOptions.find((o: any) => o.value === m.id).label).toContain(humanBytes(m.approxBytes));
    }
    expect(setup.translation).toBe('none');
    for (const m of translationModelsFor('macos')) {
      const option = setup.translationOptions.find((o: any) => o.value === m.id);
      expect(option.label).toContain(humanBytes(m.approxDownloadBytes));
      const badge = setup.renderTranslationLabel(option).children[1];
      if (m.tier === 'ultra') expect(badge.children).toBe(i18n.global.t('modelsScreen.ultra'));
      else expect(badge).toBeUndefined();
    }
    expect(i18n.global.t('onboarding.modelHint')).not.toBe('onboarding.modelHint');
  } finally { app.unmount(); }
});

it.each([false, true])('saves selected ASR and translation settings, initializing the translation target (translation %s)', async (enabled) => {
  const { app, setup } = await mount();
  try {
    const model = ASR_MODELS.find(m => m.platforms.includes('macos') && !m.languages.includes('auto'))!;
    setup.asrModel = model.id;
    setup.form.nativeLang = 'ja';
    if (enabled) setup.translation = 'hy-mt2-7b';
    await setup.start();
    await vi.waitFor(() => expect(state.downloads).toHaveBeenCalledOnce());
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({
      onboarded: true, nativeLang: 'ja', asr: { model: model.id, language: model.languages[0] },
      translation: { ...settings.value!.translation, targetLang: 'ja', enabled, engine: enabled ? 'hy-mt2-7b' : settings.value!.translation.engine },
    }));
    expect(state.downloads).toHaveBeenCalledWith([expect.objectContaining({ kind: 'asr', modelId: model.id })]);
  } finally { app.unmount(); }
});

it('keeps recognition language when compatible and never downloads cached ASR or translation', async () => {
  settings.value!.asr.language = 'ja';
  const { app, setup } = await mount('macos', true);
  try {
    setup.translation = 'hy-mt2-7b';
    await setup.start();
    await vi.waitFor(() => expect(state.downloads).toHaveBeenCalledWith([]));
    expect(state.save.mock.calls[0][0].asr.language).toBe('ja');
  } finally { app.unmount(); }
});

it('keeps the translation choice visible and disabled by default on constrained hosts', async () => {
  const { app, setup } = await mount('web', false, false);
  try { expect(setup.translationOptions.map((o: any) => o.value)).toEqual(['none']); }
  finally { app.unmount(); }
});
