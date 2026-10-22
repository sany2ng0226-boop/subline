import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileSync, writeFileSync, renameSync, profile } = vi.hoisted(() => ({ readFileSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn(), profile: { path: '/mock-user-data' } }));

vi.mock('node:fs', () => ({ default: { readFileSync, writeFileSync, renameSync } }));
vi.mock('electron', () => ({
  app: {
    getPreferredSystemLanguages: () => ['ja-JP'],
    getSystemLocale: () => 'ja-JP',
    getLocale: () => 'en-US',
    getPath: () => profile.path,
  },
  safeStorage: {},
}));

beforeEach(() => {
  vi.resetModules();
  readFileSync.mockReset();
  writeFileSync.mockReset();
  renameSync.mockReset();
  profile.path = '/mock-user-data';
});

describe('macOS settings defaults', () => {
  it('disables translation on first launch while keeping the local engine selection', async () => {
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const { loadSettings } = await import('./settings');
    const settings = loadSettings();
    expect(settings.translation.enabled).toBe(false);
    expect(settings.translation.engine).toBe('hy-mt2-7b');
  });

  it('disables translation when saved settings omit the preference', async () => {
    readFileSync.mockReturnValue('{}');
    const { loadSettings } = await import('./settings');
    expect(loadSettings().translation.enabled).toBe(false);
  });

  it.each([true, false])('preserves the saved translation preference %s', async (enabled) => {
    readFileSync.mockReturnValue(JSON.stringify({ translation: { enabled } }));
    const { loadSettings } = await import('./settings');
    expect(loadSettings().translation.enabled).toBe(enabled);
  });
});

 it('merges partial saves onto the latest persisted nested settings', async () => {
  readFileSync.mockReturnValue(JSON.stringify({ settingsVersion: 2, theme: 'dark',
    translation: { cloud: { baseURL: 'https://example.test', model: 'custom' } } }));
  const { saveSettings } = await import('./settings');
  saveSettings({ fontSize: 'xl' });
  saveSettings({ translation: { enabled: true, cloud: { model: 'new-model' } } });
  const saved = saveSettings({ theme: 'light' });
  expect(saved).toMatchObject({ fontSize: 'xl', theme: 'light', translation: {
    enabled: true, cloud: { baseURL: 'https://example.test', model: 'new-model' } } });
  expect(JSON.parse(writeFileSync.mock.calls.at(-1)![1])).toEqual(saved);
  expect(renameSync).toHaveBeenCalled();
 });

it.each(['dark', 'light'] as const)('persists follow-system after %s and reloads it on restart', async (theme) => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  profile.path = fs.mkdtempSync(join(tmpdir(), 'subline-theme-'));
  const file = join(profile.path, 'settings.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ settingsVersion: 2, theme }));
    readFileSync.mockImplementation(fs.readFileSync);
    writeFileSync.mockImplementation(fs.writeFileSync);
    renameSync.mockImplementation(fs.renameSync);
    const { loadSettings, saveSettings } = await import('./settings');
    expect(loadSettings().theme).toBe(theme);
    expect(saveSettings({ theme: 'system' }).theme).toBe('system');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).theme).toBe('system');

    vi.resetModules();
    const restarted = await import('./settings');
    expect(restarted.loadSettings().theme).toBe('system');
  } finally {
    fs.rmSync(profile.path, { recursive: true, force: true });
  }
});
