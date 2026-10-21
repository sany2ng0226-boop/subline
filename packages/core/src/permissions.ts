import type { PermissionKind, PermissionState } from './types';

export function mapPermissionState(value: unknown): PermissionState {
  switch (value) {
    case 'granted': case 'denied': case 'restricted': case 'not-determined': return value;
    case 'prompt': return 'not-determined';
    default: return 'unknown';
  }
}

/** Seed with current values; only subsequent transitions produce events. */
export function createPermissionChangeDetector(initial: Record<PermissionKind, PermissionState>) {
  const previous = { ...initial };
  return (kind: PermissionKind, state: PermissionState): boolean => {
    if (previous[kind] === state) return false;
    previous[kind] = state;
    return true;
  };
}
