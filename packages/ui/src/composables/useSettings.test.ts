import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { makeDefaults, mergeSettings, type SettingsPatch, type AppBridge, type AppSettings, type SettingsFontSize } from '@rt/core';

let applyFontSize: typeof import('./useSettings')['applyFontSize'];
let mod: typeof import('./useSettings');
const setProperty = vi.fn();

beforeAll(async () => {
  await import('vue');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }));
  vi.stubGlobal('document', { documentElement: { lang: '', classList: { toggle: vi.fn() }, style: { setProperty } } });
  mod = await import('./useSettings');
  ({ applyFontSize } = mod);
});
afterAll(() => vi.unstubAllGlobals());

it.each([
  ['xs', '13px'], ['small', '15px'], ['medium', '17px'], ['large', '20px'], ['xl', '24px'],
] satisfies [SettingsFontSize, string][])('applies %s as %s', (size, px) => {
  applyFontSize(size);
  expect(setProperty).toHaveBeenLastCalledWith('--transcript-size', px);
});

it.each(['unknown', 'toString'])('falls back to 15px for %s', (size) => {
  applyFontSize(size as SettingsFontSize);
  expect(setProperty).toHaveBeenLastCalledWith('--transcript-size', '15px');
});

it('steps one caption tier per click, stops at the ends and saves in order', async () => {
  const saved: SettingsFontSize[] = [];
  let persisted = makeDefaults([]);
  const bridge = {
    // 模拟较慢的落盘：连点时后一次保存不能被前一次的返回值覆盖
    saveSettings: async (patch: SettingsPatch) => {
      const s = mergeSettings(persisted, patch);
      await new Promise((r) => setTimeout(r, 5));
      saved.push(s.fontSize);
      persisted = s;
      return s;
    },
  } as unknown as AppBridge;
  (await import('../bridge')).setBridge(bridge);
  mod.settings.value = { ...makeDefaults([]), fontSize: 'small' };

  for (let i = 0; i < 4; i++) mod.stepFontSize(1);
  expect(setProperty).toHaveBeenLastCalledWith('--transcript-size', '24px');
  expect(mod.fontAtMax.value).toBe(true);
  await vi.waitFor(() => expect(saved).toEqual(['medium', 'large', 'xl']));
  expect(mod.settings.value?.fontSize).toBe('xl');

  for (let i = 0; i < 6; i++) mod.stepFontSize(-1);
  expect(setProperty).toHaveBeenLastCalledWith('--transcript-size', '13px');
  expect(mod.fontAtMin.value).toBe(true);
  await vi.waitFor(() => expect(saved).toEqual(['medium', 'large', 'xl', 'large', 'medium', 'small', 'xs']));
  expect(mod.settings.value?.fontSize).toBe('xs');
});


it('merges interleaved font and theme patches through slow saves', async () => {
  const initial = { ...makeDefaults([]), fontSize: 'small' as const, theme: 'light' as const };
  const saved: AppSettings[] = [];
  let persisted: AppSettings = initial;
  let active = 0;
  let maxActive = 0;
  const bridge = {
    saveSettings: async (patch: SettingsPatch) => {
      const s = mergeSettings(persisted, patch);
      maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => setTimeout(resolve, saved.length % 2 ? 5 : 15));
      saved.push(s);
      active--;
      persisted = s;
      return s;
    },
  } as unknown as AppBridge;
  (await import('../bridge')).setBridge(bridge);
  mod.settings.value = initial;

  mod.stepFontSize(1);
  mod.cycleTheme();
  // Interleave more changes while the first save is in flight.
  await new Promise((resolve) => setTimeout(resolve, 1));
  mod.stepFontSize(1);
  mod.cycleTheme();
  mod.stepFontSize(1);
  mod.cycleTheme();
  mod.stepFontSize(-1);
  mod.cycleTheme();

  await vi.waitFor(() => expect(saved).toHaveLength(8));
  expect(maxActive).toBe(1);
  expect(mod.settings.value).toMatchObject({ fontSize: 'large', theme: 'dark' });
  expect(saved.at(-1)).toMatchObject({ fontSize: 'large', theme: 'dark' });
});

it('sends only intended fields and accepts the final host normalization', async () => {
  let persisted = { ...makeDefaults([]), alwaysOnTop: true };
  const save = vi.fn(async (patch: SettingsPatch) => {
    persisted = mergeSettings(persisted, patch);
    return { ...persisted, audioSource: 'mic' as const };
  });
  (await import('../bridge')).setBridge({ saveSettings: save } as unknown as AppBridge);
  mod.settings.value = makeDefaults([]);
  await Promise.all([
    mod.saveSettings({ fontSize: 'xl' }),
    mod.saveSettings({ theme: 'dark', audioSource: 'system' }),
  ]);
  expect(save.mock.calls.map(([patch]) => patch)).toEqual([
    { fontSize: 'xl' }, { theme: 'dark', audioSource: 'system' },
  ]);
  expect(mod.settings.value).toMatchObject({ fontSize: 'xl', theme: 'dark', alwaysOnTop: true, audioSource: 'mic' });
});

it('continues saving after a rejected host write', async () => {
  let persisted = makeDefaults([]);
  const save = vi.fn().mockRejectedValueOnce(new Error('disk full'))
    .mockImplementation(async (patch: SettingsPatch) => (persisted = mergeSettings(persisted, patch)));
  (await import('../bridge')).setBridge({ saveSettings: save } as unknown as AppBridge);
  mod.settings.value = persisted;
  await expect(mod.saveSettings({ fontSize: 'xl' })).rejects.toThrow('disk full');
  await mod.saveSettings({ theme: 'dark' });
  expect(mod.settings.value).toMatchObject({ fontSize: 'small', theme: 'dark' });
});

it('rolls back a rejected translation toggle so a failed preparation is not shown as enabled', async () => {
  const before = makeDefaults([]);
  (await import('../bridge')).setBridge({ saveSettings: vi.fn().mockRejectedValue(new Error('model missing')) } as unknown as AppBridge);
  mod.settings.value = before;
  await expect(mod.saveSettings({ translation: { enabled: true } })).rejects.toThrow('model missing');
  expect(mod.settings.value?.translation.enabled).toBe(false);
});
