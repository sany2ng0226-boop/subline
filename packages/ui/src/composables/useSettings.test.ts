import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { SettingsFontSize } from '@rt/core';

let applyFontSize: typeof import('./useSettings')['applyFontSize'];
const setProperty = vi.fn();

beforeAll(async () => {
  await import('vue');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }));
  vi.stubGlobal('document', { documentElement: { style: { setProperty } } });
  ({ applyFontSize } = await import('./useSettings'));
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
