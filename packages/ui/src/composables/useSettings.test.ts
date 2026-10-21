import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeDefaults, type AppBridge, type AppSettings } from '@rt/core';

let saved: AppSettings[];
let fontVar: string;
let mod: typeof import('./useSettings');

beforeEach(async () => {
  vi.resetModules();
  saved = [];
  fontVar = '';
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('document', {
    createElement: () => ({}),
    documentElement: {
      lang: '',
      classList: { toggle() {} },
      style: { setProperty: (_: string, value: string) => { fontVar = value; } },
    },
  });
  const bridge = {
    getSettings: async () => makeDefaults([]),
    // 模拟较慢的落盘：连点时后一次保存不能被前一次的返回值覆盖
    saveSettings: async (s: AppSettings) => {
      await new Promise((r) => setTimeout(r, 5));
      saved.push(s);
      return s;
    },
  } as unknown as AppBridge;
  (await import('../bridge')).setBridge(bridge);
  mod = await import('./useSettings');
  await mod.loadSettings();
});
afterEach(() => vi.unstubAllGlobals());

it('steps through the five caption sizes and stops at the ends', async () => {
  expect(mod.settings.value?.fontSize).toBe('small');
  expect(fontVar).toBe('15px');
  mod.stepFontSize(1);
  mod.stepFontSize(1);
  mod.stepFontSize(1);
  mod.stepFontSize(1);
  expect(fontVar).toBe('24px');
  expect(mod.fontAtMax.value).toBe(true);
  await vi.waitFor(() => expect(saved).toHaveLength(3));
  expect(mod.settings.value?.fontSize).toBe('xl');
  expect(saved.map((s) => s.fontSize)).toEqual(['medium', 'large', 'xl']);
  for (let i = 0; i < 6; i++) mod.stepFontSize(-1);
  expect(fontVar).toBe('13px');
  expect(mod.fontAtMin.value).toBe(true);
});
