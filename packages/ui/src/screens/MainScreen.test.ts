import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, ssrContextKey } from 'vue';
import { makeDefaults, type AppBridge, type ShortcutAction } from '@rt/core';

afterEach(() => vi.unstubAllGlobals());

it('starts and stops from the MainScreen shortcut subscription, then unsubscribes', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }));
  vi.stubGlobal('localStorage', { getItem: () => null });
  const { setBridge } = await import('../bridge');
  let listener: ((action: ShortcutAction) => void) | undefined;
  const off = vi.fn(() => { listener = undefined; });
  const startPipeline = vi.fn(async () => ({ ok: true }));
  const stopPipeline = vi.fn(async () => ({ ok: true }));
  setBridge({
    platform: 'macos',
    onShortcut: (cb: (action: ShortcutAction) => void) => { listener = cb; return off; },
    getSetupStatus: async () => ({ asrReady: true }),
    getMicStatus: async () => 'granted',
    startPipeline, stopPipeline,
  } as unknown as AppBridge);
  const { settings } = await import('../composables/useSettings');
  settings.value = makeDefaults([]);
  const state = await import('../composables/useTranscription');
  const { i18n } = await import('../i18n');
  const { default: MainScreen } = await import('./MainScreen.vue');
  // Run the real screen setup and lifecycle without rendering browser-only children.
  const renderer = createRenderer<object, object>({
    patchProp() {}, insert() {}, remove() {}, createElement: () => ({}),
    createText: () => ({}), createComment: () => ({}), setText() {},
    setElementText() {}, parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp({ ...MainScreen, render: () => null });
  app.provide(ssrContextKey, { modules: new Set() });
  app.use(i18n).mount({});
  try {
    expect(listener).toBeTypeOf('function');
    listener!('toggleRecording');
    await vi.waitFor(() => expect(startPipeline).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(state.recordBusy.value).toBe(false));
    expect(state.recording.value).toBe(true);
    listener!('toggleRecording');
    await vi.waitFor(() => expect(stopPipeline).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(state.recordBusy.value).toBe(false));
    expect(state.recording.value).toBe(false);
  } finally {
    app.unmount();
  }
  expect(off).toHaveBeenCalledOnce();
  expect(listener).toBeUndefined();
});
