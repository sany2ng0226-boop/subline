export type ArchiveOperation = 'load' | 'open' | 'delete' | 'save' | 'rename';
export type ArchiveErrorCode = 'not-found' | 'io' | 'permission' | 'invalid' | 'unknown';

export class ArchiveOperationError extends Error {
  constructor(
    public readonly op: ArchiveOperation,
    public readonly code: ArchiveErrorCode,
    message: string,
    public readonly id?: string,
  ) {
    super(message);
    this.name = 'ArchiveOperationError';
  }
}

/** Normalize filesystem and browser storage failures without importing Node APIs. */
export function archiveOperationError(error: unknown, op: ArchiveOperation, id?: string): ArchiveOperationError {
  if (error instanceof ArchiveOperationError) {
    return new ArchiveOperationError(op, error.code, error.message, id ?? error.id);
  }
  const source = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code: ArchiveErrorCode = source?.code === 'ENOENT' ? 'not-found'
    : source?.code === 'EACCES' || source?.code === 'EPERM' || source?.name === 'NotAllowedError' || source?.name === 'SecurityError' ? 'permission'
    : error instanceof SyntaxError || error instanceof TypeError || source?.name === 'DataError' ? 'invalid'
    : typeof source?.code === 'string' || source?.name === 'QuotaExceededError' || source?.name === 'AbortError' || source?.name === 'UnknownError' ? 'io'
    : 'unknown';
  return new ArchiveOperationError(op, code, typeof source?.message === 'string' ? source.message : String(error), id);
}

const marker = '__RT_ARCHIVE_ERROR_V1__';

/** Electron invoke preserves only the message; keep the typed payload inside it. */
export function encodeArchiveOperationError(error: unknown, op: ArchiveOperation, id?: string): Error {
  const normalized = archiveOperationError(error, op, id);
  return new Error(marker + JSON.stringify({ op: normalized.op, code: normalized.code, message: normalized.message, id: normalized.id }));
}

export function decodeArchiveOperationError(error: unknown, op: ArchiveOperation, id?: string): ArchiveOperationError {
  const message = error instanceof Error ? error.message : String(error);
  const offset = message.indexOf(marker);
  if (offset >= 0) {
    try {
      const payload = JSON.parse(message.slice(offset + marker.length));
      if (payload && ['load', 'open', 'delete', 'save', 'rename'].includes(payload.op)
        && ['not-found', 'io', 'permission', 'invalid', 'unknown'].includes(payload.code)
        && typeof payload.message === 'string' && (payload.id === undefined || typeof payload.id === 'string')) {
        return new ArchiveOperationError(payload.op, payload.code, payload.message, payload.id);
      }
    } catch { /* An invalid transport payload falls back to an ordinary failure. */ }
  }
  return archiveOperationError(error, op, id);
}

export async function withArchiveOperation<T>(op: ArchiveOperation, id: string | undefined, operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw decodeArchiveOperationError(error, op, id); }
}
