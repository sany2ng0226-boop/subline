import { describe, expect, it } from 'vitest';
import { ArchiveOperationError, archiveOperationError, encodeArchiveOperationError, decodeArchiveOperationError, withArchiveOperation } from './archive-errors';

describe('archive error transport', () => {
  it.each(['load', 'open', 'delete', 'save', 'rename'] as const)('round trips %s through Electron message wrapping', (op) => {
    const original = new ArchiveOperationError(op, 'permission', 'Cannot access "授業"\narchive', 'a1');
    const wire = encodeArchiveOperationError(original, op);
    const decoded = decodeArchiveOperationError(new Error(`Error invoking remote method 'archive:test': Error: ${wire.message}`), op);
    expect(decoded).toBeInstanceOf(ArchiveOperationError);
    expect(decoded).toMatchObject({ op, code: 'permission', message: original.message, id: 'a1' });
  });
  it.each([['ENOENT', 'not-found'], ['EACCES', 'permission'], ['EPERM', 'permission'], ['EIO', 'io'], ['ENOSPC', 'io']])('maps fs %s to %s', (code, expected) => {
    expect(archiveOperationError(Object.assign(new Error('fs failure'), { code }), 'delete', 'a')).toMatchObject({ op: 'delete', code: expected, id: 'a' });
  });
  it('classifies malformed storage and preserves outer operation', () => {
    expect(archiveOperationError(new SyntaxError('bad JSON'), 'open').code).toBe('invalid');
    expect(archiveOperationError(new ArchiveOperationError('load', 'io', 'read failed'), 'delete', 'a')).toMatchObject({ op: 'delete', code: 'io', id: 'a' });
  });
  it.each(['plain error', '__RT_ARCHIVE_ERROR_V1__{', '__RT_ARCHIVE_ERROR_V1__{"op":"oops","code":"io","message":"x"}'])('handles untrusted message %s', (message) => {
    expect(decodeArchiveOperationError(new Error(message), 'open', 'a')).toMatchObject({ op: 'open', code: 'unknown', id: 'a', message });
  });
  it('rejects async and sync failures and returns successful values', async () => {
    await expect(withArchiveOperation('delete', 'a', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); })).rejects.toMatchObject({ op: 'delete', code: 'permission', id: 'a' });
    await expect(withArchiveOperation('load', undefined, () => Promise.reject(new Error('failed')))).rejects.toBeInstanceOf(ArchiveOperationError);
    await expect(withArchiveOperation('load', undefined, () => 42)).resolves.toBe(42);
  });
});
