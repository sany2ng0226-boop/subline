import { expect, it } from 'vitest';
import { i18n } from './i18n';

function keys(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [prefix];
  return Object.entries(node).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k)).sort();
}

it('every locale defines the same message keys', () => {
  const messages = i18n.global.messages.value as Record<string, unknown>;
  const reference = keys(messages.en);
  for (const locale of ['ja', 'ko', 'zh']) expect(keys(messages[locale]), locale).toEqual(reference);
});


it.each(['zh', 'en', 'ja', 'ko'] as const)('warns about translation model size in %s', (locale) => {
  const message = i18n.global.t('download.translationDesc', { modelName: 'Selected model', size: '610 MB' }, { locale });
  expect(message).toContain('610 MB');
  expect(message).toContain('Selected model');
  expect(message).not.toContain('Hy-MT2');
  expect(message).not.toContain('{');
});

it.each(['zh', 'en', 'ja', 'ko'] as const)('interpolates paused subtitle counts in %s', locale => {
  for (const count of [1, 3]) {
    const text = i18n.global.t('main.jumpLatestCount', { count }, { locale, plural: count });
    expect(text).toContain(String(count));
    expect(text).not.toContain('|');
    expect(text).not.toContain('{count}');
  }
  expect(i18n.global.t('main.followPaused', {}, { locale })).not.toBe('main.followPaused');
});
