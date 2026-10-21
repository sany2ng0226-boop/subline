// 归档操作失败的可读文案：宿主以 ArchiveOperationError（op / code / id）拒绝时按原因细分，
// 其余（旧宿主、未知错误）用调用方给的通用文案。只做鸭子类型判断，不依赖宿主是否实现。
export function archiveErrorKey(error: unknown, fallback: string): string {
  const { op, code } = (error ?? {}) as { op?: unknown; code?: unknown };
  if (typeof op !== 'string') return fallback;
  if (code === 'permission') return 'archive.errorPermission';
  if (code === 'not-found' && (op === 'open' || op === 'delete')) return 'archive.errorNotFound';
  if (code === 'invalid' && op === 'load') return 'archive.errorCorrupt';
  return fallback;
}
