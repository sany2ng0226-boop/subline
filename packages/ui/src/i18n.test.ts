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
  const message = i18n.global.getLocaleMessage(locale).download.translationDesc;
  expect(message).toContain('4.5 GB');
  expect(message).toContain('Hy-MT2 7B');
});

it.each([
  ['zh', '超高质量', '翻译质量最好，体积较大'],
  ['ja', '超高品質', '翻訳品質は最高ですが、サイズが大きめです'],
  ['en', 'Ultra quality', 'Best translation quality, larger download'],
] as const)('defines ultra quality copy in %s', (locale, label, description) => {
  const messages = i18n.global.getLocaleMessage(locale).modelsScreen;
  expect(messages.ultra).toBe(label);
  expect(messages.ultraDesc).toBe(description);
});
