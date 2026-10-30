import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { AppBridge, ModelInfo } from '@rt/core';
import { setBridge } from '../../bridge';
import { i18n } from '../../i18n';
import { recording, recordBusy, modelLoading } from '../../composables/useTranscription';
import { modelPickerRows, type ModelPickerOption } from './model-picker';
import ModelPicker from './ModelPicker.vue';

const state = vi.hoisted(() => ({ models: [] as ModelInfo[], error: '', refresh: vi.fn(),
  downloads: vi.fn(), cancel: vi.fn(), remove: vi.fn(), downloadingId: '', failedId: '' }));
vi.mock('../../composables/useModelDownloads', () => ({
  startDownloads: state.downloads, cancelDownload: state.cancel,
  isDownloading: (_: string, id: string) => id === state.downloadingId,
  downloadFailed: (_: string, id: string) => id === state.failedId,
  downloadEntry: () => ({ total: 0 }), percentOf: () => 0, onDownloadDone: () => () => {},
}));
vi.mock('../../composables/useModels', async () => {
  const { ref } = await import('vue');
  return { useModels: () => ({ models: ref(state.models), error: ref(state.error), refreshModels: state.refresh }) };
});
vi.mock('../../composables/useTranscription', async () => {
  const { ref } = await import('vue');
  return { recording: ref(false), recordBusy: ref(false), modelLoading: ref(false) };
});
vi.mock('../ModelDownloadModal.vue', () => ({ default: { render: () => null } }));
// Render popup slots during SSR so row accessibility and independent action buttons are inspectable.
vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    NPopover: defineComponent({ setup: (_, { slots }) => () => h('div', [slots.trigger?.(), slots.default?.()]) }),
    NPopconfirm: defineComponent({ setup: (_, { slots }) => () => h('div', slots.trigger?.()) }),
    NProgress: defineComponent({ setup: () => () => h('span', { role: 'progressbar' }) }),
  };
});

const options: ModelPickerOption[] = [
  { value: 'none', label: 'No translation' },
  { value: 'cloud', label: 'API service' },
  { value: 'ready', label: 'Ready model', modelId: 'm2m100' },
  { value: 'pending', label: 'Pending model', modelId: 'hy-mt2-7b', ultra: true },
];
const models: ModelInfo[] = [
  { id: 'm2m100', kind: 'translation', downloaded: true, sizeBytes: 123, inUse: false },
  { id: 'hy-mt2-7b', kind: 'translation', downloaded: false, sizeBytes: 0, inUse: true },
];
beforeEach(() => {
  state.models = models;
  state.error = '';
  state.refresh.mockReset(); state.downloads.mockReset(); state.cancel.mockReset(); state.remove.mockReset();
  state.downloadingId = ''; state.failedId = '';
  state.refresh.mockResolvedValue(undefined); state.cancel.mockResolvedValue(undefined);
  recording.value = false; recordBusy.value = false; modelLoading.value = false;
  setBridge({ platform: 'macos', downloadTranslationModel: vi.fn(), deleteModel: state.remove } as unknown as AppBridge);
  i18n.global.locale.value = 'en';
});
async function render(value = 'pending') {
  return renderToString(createSSRApp(ModelPicker, { value, kind: 'translation', options }).use(i18n));
}
function choice(html: string, name: string) {
  return html.match(new RegExp(`<button[^>]*class="model-choice"[^>]*aria-label="[^"]*: ${name}"[^>]*>`))?.[0];
}

describe('model picker row availability', () => {
  it('keeps selected state independent of download readiness and bridge inUse flags', () => {
    const rows = modelPickerRows(options, models, 'translation', 'pending');
    expect(rows[2]).toMatchObject({ current: false, selectable: true, status: 'downloaded', sizeBytes: 123 });
    expect(rows[3]).toMatchObject({ current: true, selectable: false, status: 'notDownloaded' });
    expect(rows[3].sizeBytes).toBeGreaterThan(4_000_000_000);
  });
  it('allows none/API/system choices without a model and never assumes absent models are downloaded', () => {
    const choices = [...options, { value: 'system', label: 'System translation' }];
    const rows = modelPickerRows(choices, [], 'translation', 'cloud');
    expect(rows.filter((row) => row.selectable).map((row) => row.value)).toEqual(['none', 'cloud', 'system']);
    expect(rows.find((row) => row.value === 'cloud')?.current).toBe(true);
    expect(rows[2]).toMatchObject({ selectable: false, status: 'unavailable' });
  });
  it('makes a completed model selectable from the same snapshot without changing selection', () => {
    const rows = modelPickerRows(options, models.map((model) => ({ ...model, downloaded: true })), 'translation', 'ready');
    expect(rows[3]).toMatchObject({ current: false, selectable: true, status: 'downloaded' });
    expect(rows[2].current).toBe(true);
  });
  it('keeps model kinds separate even when ids coincide', () => {
    const rows = modelPickerRows(options, models.map((model) => ({ ...model, kind: 'asr' })), 'translation', 'ready');
    expect(rows[2]).toMatchObject({ selectable: false, status: 'unavailable' });
  });
});

describe('model picker controls', () => {
  it('marks the selected uncached model while offering download separately from disabled selection', async () => {
    const html = await render();
    expect(choice(html, 'Pending model')).toContain('disabled');
    expect(choice(html, 'Pending model')).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Download: Pending model"');
    expect(html).toContain('Not downloaded');
    expect(html).toContain('4.3 GB');
    expect(html).toContain('Ultra');
    expect(choice(html, 'Ready model')).not.toContain('disabled');
    expect(choice(html, 'API service')).not.toContain('disabled');
    expect(choice(html, 'No translation')).not.toContain('disabled');
    expect(state.refresh).not.toHaveBeenCalled();
  });
  it.each(['recording', 'recordBusy', 'modelLoading'] as const)('disables deletion and selection during %s', async (stateName) => {
    ({ recording, recordBusy, modelLoading })[stateName].value = true;
    const html = await render('ready');
    expect(html.match(/<button[^>]*aria-label="Delete: Ready model"[^>]*>/)?.[0]).toContain('disabled');
    expect(choice(html, 'Ready model')).toContain('disabled');
  });
  it('shows a list failure with an explicit retry action without creating another probe', async () => {
    state.error = 'unavailable';
    const html = await render();
    expect(html).toContain('role="alert"');
    expect(html).toContain('Retry');
    expect(state.refresh).not.toHaveBeenCalled();
  });
});


async function mount() {
  const renderer = createRenderer<any, any>({
    patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}),
    createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
  });
  const update = vi.fn();
  const app = renderer.createApp({ ...ModelPicker, render: () => null }, {
    value: 'pending', kind: 'translation', options, 'onUpdate:value': update,
  });
  app.provide(ssrContextKey, { modules: new Set() });
  const vm = app.use(i18n).mount({}) as any;
  return { app, setup: vm.$.setupState, update };
}

it('confirms downloads without selecting them and allows immediate choice of a downloaded row', async () => {
  const { app, setup, update } = await mount();
  try {
    setup.choose(setup.rows[3]);
    expect(update).not.toHaveBeenCalled();
    setup.requestDownload(setup.rows[3]);
    expect(setup.downloadModalOpen).toBe(true);
    expect(setup.downloadTasks).toEqual([expect.objectContaining({ kind: 'translation', modelId: 'hy-mt2-7b' })]);
    expect(state.downloads).not.toHaveBeenCalled();
    setup.confirmDownload(setup.downloadTasks);
    expect(state.downloads).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    setup.choose(setup.rows[2]);
    expect(update).toHaveBeenCalledWith('ready');
  } finally { app.unmount(); }
});

it('renders cancel and retry in the same model row and requires confirmation again for retry', async () => {
  state.downloadingId = 'hy-mt2-7b';
  expect(await render()).toContain('aria-label="Cancel download: Pending model"');
  state.downloadingId = ''; state.failedId = 'hy-mt2-7b';
  expect(await render()).toContain('aria-label="Retry: Pending model"');
  const { app, setup, update } = await mount();
  try {
    setup.requestDownload(setup.rows[3]);
    expect(setup.downloadModalOpen).toBe(true);
    expect(state.downloads).not.toHaveBeenCalled();
    await setup.cancel('hy-mt2-7b');
    expect(state.cancel).toHaveBeenCalledWith('translation', 'hy-mt2-7b');
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  } finally { app.unmount(); }
});

it('handles deletion rejection and refuses deletion after recording starts', async () => {
  state.remove.mockResolvedValue({ ok: false, error: 'Model files are busy' });
  const { app, setup, update } = await mount();
  try {
    expect(await setup.remove('m2m100')).toBe(false);
    expect(setup.actionError).toBe('Model files are busy');
    expect(state.refresh).not.toHaveBeenCalled();
    recording.value = true;
    expect(await setup.remove('m2m100')).toBe(false);
    expect(state.remove).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  } finally { app.unmount(); }
});

it('refreshes after successful deletion and catches refresh or cancellation failures', async () => {
  state.remove.mockResolvedValue({ ok: true });
  const { app, setup } = await mount();
  try {
    expect(await setup.remove('m2m100')).toBe(true);
    expect(state.refresh).toHaveBeenCalledOnce();
    state.cancel.mockRejectedValue(new Error('Cancellation failed'));
    await expect(setup.cancel('hy-mt2-7b')).resolves.toBeUndefined();
    expect(setup.actionError).toBe('Cancellation failed');
    state.refresh.mockRejectedValue(new Error('List failed'));
    await expect(setup.refresh()).resolves.toBeUndefined();
    expect(setup.actionError).toBe(i18n.global.t('settings.statusUnavailable'));
  } finally { app.unmount(); }
});

it.each(['en', 'ja', 'zh'] as const)('shows ultra quality and registry size together only on HY-MT2 in %s', async (locale) => {
  i18n.global.locale.value = locale;
  const html = await render();
  const rows = html.match(/<li\b[\s\S]*?<\/li>/g)!;
  expect(rows).toHaveLength(options.length);
  const ultra = i18n.global.t('modelsScreen.ultra');
  expect(rows[3]).toContain(ultra);
  expect(rows[3]).toContain('4.3 GB');
  expect(rows[2]).not.toContain(ultra);
});

 it('offers system-managed Apple ASR without a disk entry, size, download or delete action', async () => {
  const apple = { value: 'apple-speech', label: 'Apple Speech', modelId: 'apple-speech', sizeBytes: 0 };
  const [row] = modelPickerRows([apple], [], 'asr', 'apple-speech');
  expect(row).toMatchObject({ selectable: true, current: true, systemManaged: true, status: 'systemManaged' });
  expect(row.sizeBytes).toBeUndefined();
  const html = await renderToString(createSSRApp(ModelPicker, { value: 'apple-speech', kind: 'asr', options: [apple] }).use(i18n));
  expect(html).toContain('Managed by iOS');
  expect(html).not.toContain('0 B');
  expect(html).not.toContain('aria-label="Download: Apple Speech"');
  expect(html).not.toContain('aria-label="Delete: Apple Speech"');
 });
