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
