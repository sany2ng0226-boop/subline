import path from 'node:path';

export type BuildVariant = 'dev' | 'release';

export function variantIdentity(variant: BuildVariant, appData: string) {
  return variant === 'dev'
    ? { name: 'Subline Dev', appId: 'io.github.sany2ng0226.classroomtranslator.dev', userData: path.join(appData, 'Subline Dev') }
    : { name: 'Subline', appId: 'io.github.sany2ng0226.classroomtranslator', userData: path.join(appData, 'Classroom Translator') };
}

export function shouldMigrateLegacyProfile(variant: BuildVariant, packaged: boolean, platform: string, name: string, isolated: boolean): boolean {
  return variant !== 'dev' && packaged && platform !== 'win32' && name === 'Subline' && !isolated;
}

export function recordingAccelerator(variant: BuildVariant, platform: string, configured?: string | null): string | null {
  // Dev reserves a distinct accelerator even when a saved setting contains the release shortcut.
  if (variant === 'dev') return 'Alt+Shift+Command+R';
  if (configured === null) return null;
  return configured ?? `Alt+${platform === 'darwin' ? 'Command' : 'Control'}+R`;
}
