import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { makeDefaults, type AppBridge, type AppSettings, type SettingsFontSize } from '@rt/core';

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
  const bridge = {
    // 模拟较慢的落盘：连点时后一次保存不能被前一次的返回值覆盖
    saveSettings: async (s: AppSettings) => {
      await new Promise((r) => setTimeout(r, 5));
      saved.push(s.fontSize);
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


it('preserves the last font and theme when slow saves return stale settings', async () => {
  const initial = { ...makeDefaults([]), fontSize: 'small' as const, theme: 'light' as const };
  const saved: AppSettings[] = [];
  let active = 0;
  let maxActive = 0;
  const bridge = {
    saveSettings: async (s: AppSettings) => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => setTimeout(resolve, saved.length % 2 ? 5 : 15));
      saved.push(s);
      active--;
      return { ...initial };
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
