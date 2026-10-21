import { describe, expect, it } from 'vitest';
import { createPermissionChangeDetector, mapPermissionState } from './permissions';

describe('permission mapping', () => {
  it.each(['granted', 'denied', 'restricted', 'not-determined', 'unknown'] as const)(
    'preserves %s', (state) => expect(mapPermissionState(state)).toBe(state),
  );
  it('maps browser prompt and fails closed to unknown for unsupported values', () => {
    expect(mapPermissionState('prompt')).toBe('not-determined');
    for (const value of [undefined, null, '', 'undetermined', 'future-value']) {
      expect(mapPermissionState(value)).toBe('unknown');
    }
  });
});

describe('permission changes', () => {
  it('suppresses repeats, tracks each kind separately and reports reversals', () => {
    const initial = { microphone: 'not-determined', systemAudio: 'unknown' } as const;
    const changed = createPermissionChangeDetector(initial);
    expect(changed('microphone', 'not-determined')).toBe(false);
    expect(changed('microphone', 'denied')).toBe(true);
    expect(changed('microphone', 'denied')).toBe(false);
    expect(changed('systemAudio', 'unknown')).toBe(false);
    expect(changed('systemAudio', 'granted')).toBe(true);
    expect(changed('microphone', 'granted')).toBe(true);
    expect(changed('microphone', 'denied')).toBe(true);
    expect(initial.microphone).toBe('not-determined');
  });
});
