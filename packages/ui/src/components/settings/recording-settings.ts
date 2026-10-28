import type { SettingsPatch } from '@rt/core';

/** An appearance edit must never carry a stale engine or language change into a live capture. */
export function recordingSettingsPatch(patch: SettingsPatch, locked: boolean): SettingsPatch {
  if (!locked) return patch;
  const { fontSize, theme, announceCaptions } = patch;
  return {
    ...(fontSize !== undefined ? { fontSize } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(announceCaptions !== undefined ? { announceCaptions } : {}),
  };
}
