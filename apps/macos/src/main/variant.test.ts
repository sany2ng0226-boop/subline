import { describe, expect, it } from 'vitest';
import { recordingAccelerator, shouldMigrateLegacyProfile, variantIdentity } from './variant';

describe('build variant', () => {
  it('isolates dev identity and profile', () => {
    expect(variantIdentity('dev', '/profiles')).toEqual({ name: 'Subline Dev', appId: 'io.github.sany2ng0226.classroomtranslator.dev', userData: '/profiles/Subline Dev' });
  });
  it('preserves release identity and legacy profile', () => {
    expect(variantIdentity('release', '/profiles')).toEqual({ name: 'Subline', appId: 'io.github.sany2ng0226.classroomtranslator', userData: '/profiles/Classroom Translator' });
  });
  it('never migrates release data into dev, even with a release app name', () => {
    expect(shouldMigrateLegacyProfile('dev', true, 'darwin', 'Subline', false)).toBe(false);
    expect(shouldMigrateLegacyProfile('release', true, 'darwin', 'Subline', false)).toBe(true);
    expect(shouldMigrateLegacyProfile('release', true, 'darwin', 'Subline', true)).toBe(false);
    expect(shouldMigrateLegacyProfile('release', false, 'darwin', 'Subline', false)).toBe(false);
  });
  it.each([undefined, null, 'Alt+Command+R', 'Control+R'])('reserves the dev accelerator regardless of saved setting %s', (configured) => {
    expect(recordingAccelerator('dev', 'darwin', configured)).toBe('Alt+Shift+Command+R');
  });
  it('preserves release defaults and settings', () => {
    expect(recordingAccelerator('release', 'darwin')).toBe('Alt+Command+R');
    expect(recordingAccelerator('release', 'win32')).toBe('Alt+Control+R');
    expect(recordingAccelerator('release', 'darwin', null)).toBeNull();
    expect(recordingAccelerator('release', 'darwin', 'Control+R')).toBe('Control+R');
  });
});
