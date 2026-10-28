import { beforeEach, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, defineComponent, h, nextTick, ref, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { makeDefaults, type SettingsPatch } from '@rt/core';
import { recordingSettingsPatch } from '../components/settings/recording-settings';

const state = vi.hoisted(() => ({ recording: null as any, busy: null as any, loading: null as any,
  settings: null as any, save: vi.fn(), offShortcut: vi.fn(), stop: vi.fn(), shortcut: undefined as undefined | (() => void) }));
vi.mock('../composables/useTranscription', () => ({ recording: state.recording, recordBusy: state.busy,
  modelLoading: state.loading, toggleRecording: state.stop }));
vi.mock('../composables/useSettings', () => ({ settings: state.settings, saveSettings: state.save,
  alwaysOnTopSupported: () => true, setAlwaysOnTop: vi.fn() }));
vi.mock('../composables/useShortcuts', () => ({ onShortcutAction: (_name: string, action: () => void) => {
  state.shortcut = action; return state.offShortcut;
} }));
vi.mock('../bridge', () => ({ bridge: () => ({ platform: 'macos', testCloud: vi.fn() }) }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../components/settings/ModelPicker.vue', () => ({ default: defineComponent({
  props: ['disabled', 'kind'], setup: props => () => h('button', { disabled: props.disabled,
    'data-picker': props.kind }, 'picker'),
}) }));
vi.mock('naive-ui', () => {
  const wrapper = defineComponent({ props: ['label'], setup: (props, { slots }) => () => h('section',
    { 'data-label': props.label }, slots.default?.()) });
  const field = defineComponent({ props: ['disabled', 'value'], setup: props => () => h('input',
    { disabled: props.disabled, 'data-value': props.value }) });
  return { NFormItem: wrapper, NAlert: wrapper, NTooltip: wrapper, NSelect: field,
    NInput: field, NAutoComplete: field, NSwitch: field,
    NButton: defineComponent({ props: ['disabled'], setup: (props, { slots }) => () => h('button',
      { disabled: props.disabled }, slots.default?.()) }) };
});

beforeEach(() => {
  vi.resetModules();
  state.recording ??= ref(false); state.busy ??= ref(false); state.loading ??= ref(false);
  state.recording.value = false; state.busy.value = false; state.loading.value = false;
  const settings = makeDefaults([]);
  settings.nativeLang = 'zh'; settings.asr.language = 'ja'; settings.translation.targetLang = 'ko';
  settings.translation.enabled = true; settings.translation.engine = 'cloud';
  state.settings ??= ref(settings); state.settings.value = settings; state.stop.mockClear();
  state.save.mockReset().mockResolvedValue(settings); state.offShortcut.mockClear();
});
async function render() {
  const { default: component } = await import('./SettingsScreen.vue');
  return renderToString(createSSRApp(component));
}
const field = (html: string, label: string) => html.match(new RegExp(`<section data-label="${label}"[^>]*>(.*?)</section>`))?.[1];

it.each(['recording', 'busy', 'loading'] as const)('locks disruptive controls during %s but leaves appearance available', async flag => {
  state[flag].value = true;
  const html = await render();
  for (const label of ['settings.asrLanguage', 'settings.targetLang', 'settings.interfaceLang']) {
    expect(field(html, label), label).toContain('disabled');
  }
  expect(html).toContain('disabled data-picker="asr"');
  expect(html).toContain('disabled data-picker="translation"');
  for (const label of ['settings.baseUrl', 'settings.model', 'settings.apiKey']) {
    expect(field(html, label), label).toContain('disabled');
  }
  for (const label of ['settings.fontSize', 'main.theme', 'settings.alwaysOnTop']) {
    expect(field(html, label), label).not.toContain('disabled');
  }
  expect(html).toContain('settings.recordingLockHint');
});

it('unlocks languages and engine controls after stopping', async () => {
  const html = await render();
  for (const label of ['settings.asrLanguage', 'settings.targetLang', 'settings.interfaceLang']) {
    expect(field(html, label), label).not.toContain('disabled');
  }
  expect(html).not.toContain('disabled data-picker=');
});

it('can stop a current recording from settings but never starts one via the shortcut', async () => {
  state.recording.value = true;
  const html = await render();
  expect(html).toContain('settings.recordingStatus'); expect(html).toContain('main.stop');
  state.shortcut!(); expect(state.stop).toHaveBeenCalledOnce();
  state.busy.value = true; state.shortcut!(); expect(state.stop).toHaveBeenCalledOnce();
  state.busy.value = false; state.recording.value = false; state.shortcut!();
  expect(state.stop).toHaveBeenCalledOnce();
});

it('strips every disruptive field from a mixed appearance save while locked', () => {
  const patch: SettingsPatch = { nativeLang: 'ja', asr: { language: 'ja', model: 'other' },
    audioSource: 'system', translation: { enabled: true, targetLang: 'ko', engine: 'cloud',
      cloud: { model: 'other', baseURL: 'http://local', apiKey: 'fixture' } },
    fontSize: 'large', theme: 'dark', announceCaptions: false };
  expect(recordingSettingsPatch(patch, true)).toEqual({ fontSize: 'large', theme: 'dark', announceCaptions: false });
  expect(recordingSettingsPatch(patch, false)).toEqual(patch);
  expect(recordingSettingsPatch({ translation: { engine: 'cloud' } }, true)).toEqual({});
});

async function mountSetup() {
  const { default: component } = await import('./SettingsScreen.vue');
  const renderer = createRenderer<any, any>({
    patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}),
    createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp({ ...component, render: () => null });
  app.provide(ssrContextKey, { modules: new Set() });
  const vm = app.mount({}) as any;
  return { app, form: vm.$.setupState.form };
}

it('cancels a pending cloud edit when recording starts and saves only the following theme edit', async () => {
  vi.useFakeTimers();
  const { app, form } = await mountSetup();
  try {
    const previousModel = state.settings.value.translation.cloud.model;
    form.cloud.model = 'pending-cloud-model';
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.save).not.toHaveBeenCalled();
    state.recording.value = true;
    await nextTick();
    expect(form.cloud.model).toBe(previousModel);
    form.theme = 'dark';
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.save.mock.calls).toEqual([[{ theme: 'dark' }]]);
  } finally { app.unmount(); vi.useRealTimers(); }
  expect(state.offShortcut).toHaveBeenCalledOnce();
});

it('flushes the last unlocked cloud input on unmount without a later duplicate save', async () => {
  vi.useFakeTimers();
  const { app, form } = await mountSetup();
  try {
    form.cloud.model = 'last-cloud-model';
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.save).not.toHaveBeenCalled();
    app.unmount();
    expect(state.save.mock.calls).toEqual([[{ translation: { cloud: { model: 'last-cloud-model' } } }]]);
    expect(state.offShortcut).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.save).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
