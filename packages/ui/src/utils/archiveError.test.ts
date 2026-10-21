import { expect, it } from 'vitest';
import { archiveErrorKey } from './archiveError';

it('maps ArchiveOperationError codes and falls back otherwise', () => {
  expect(archiveErrorKey({ op: 'save', code: 'permission' }, 'archive.operationFailed')).toBe('archive.errorPermission');
  expect(archiveErrorKey({ op: 'open', code: 'not-found', id: 'a' }, 'archive.openFailed')).toBe('archive.errorNotFound');
  expect(archiveErrorKey({ op: 'load', code: 'invalid' }, 'archive.loadFailed')).toBe('archive.errorCorrupt');
  expect(archiveErrorKey({ op: 'save', code: 'io' }, 'archive.operationFailed')).toBe('archive.operationFailed');
  // Node fs 原始错误（code 为 EACCES 等、无 op）不按原因细分
  expect(archiveErrorKey(Object.assign(new Error('x'), { code: 'EACCES' }), 'archive.loadFailed')).toBe('archive.loadFailed');
  expect(archiveErrorKey(undefined, 'archive.loadFailed')).toBe('archive.loadFailed');
});
