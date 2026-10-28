import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, ssrContextKey } from 'vue';
import { makeDefaults, type AppBridge, type ShortcutAction } from '@rt/core';

afterEach(() => vi.unstubAllGlobals());

it('keeps settings available during recording without opening disruptive controls or stopping capture', async () => {
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
  const openSettings = vi.fn();
  const app = renderer.createApp({ ...MainScreen, render: () => null }, { onOpenSettings: openSettings });
  app.provide(ssrContextKey, { modules: new Set() });
  app.use(i18n).mount({});
  try {
    expect(listener).toBeTypeOf('function');
    listener!('toggleRecording');
    await vi.waitFor(() => expect(startPipeline).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(state.recordBusy.value).toBe(false));
    expect(state.recording.value).toBe(true);
    const setup = (app as any)._instance.setupState;
    const options = setup.mobileMenuOptions as Array<{ key: string; disabled?: boolean }>;
    expect(options.find(option => option.key === 'settings')?.disabled).toBe(false);
    expect(options.find(option => option.key === 'view-archive')?.disabled).toBe(true);
    setup.onMobileMenuSelect('settings');
    expect(openSettings).toHaveBeenCalledOnce();
    expect(stopPipeline).not.toHaveBeenCalled();
    state.recordBusy.value = true;
    setup.onMobileMenuSelect('settings');
    expect(openSettings).toHaveBeenCalledOnce();
    state.recordBusy.value = false;
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
