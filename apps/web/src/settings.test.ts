import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDefaults } from '@rt/core';

const storage = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), nativeGet: vi.fn(), nativeSet: vi.fn() }));
vi.mock('idb', () => ({ openDB: vi.fn(async () => ({ get: storage.get, put: storage.put })) }));
vi.mock('./asr/web-asr', () => ({ WebAsr: class { setConfig() {} } }));
vi.mock('./translation/web-local-translator', () => ({ WebLocalTranslator: class {} }));
vi.mock('./screen-wake-lock', () => ({ createScreenWakeLock: vi.fn(() => ({ start() {}, stop() {} })) }));
vi.mock('./translation/model-store', () => ({ isTranslationModelCached: vi.fn(async () => false) }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: storage.nativeGet, set: storage.nativeSet } }));
vi.mock('../../ios/native-plugin', () => ({ RealtimeAsr: { addListener: vi.fn(async () => ({ remove() {} })) }, RealtimeTranslate: {} }));
import { createWebBridge } from './bridge';
import { createIosBridge } from '../../ios/src/bridge';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', {});
  vi.stubGlobal('navigator', { languages: ['ja'], userAgent: '', platform: '' });
  const defaults = makeDefaults(['ja']);
  storage.get.mockResolvedValue(defaults);
  storage.nativeGet.mockResolvedValue({ value: JSON.stringify(defaults) });
  storage.put.mockResolvedValue(undefined);
  storage.nativeSet.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

for (const [name, createBridge, write] of [
  ['web', createWebBridge, storage.put],
  ['ios', createIosBridge, storage.nativeSet],
] as const) {
  describe(`${name} partial settings persistence`, () => {
    it('merges concurrent top-level and nested patches after startup and preserves each response', async () => {
      const bridge = createBridge();
      const first = bridge.saveSettings({ theme: 'dark' });
      const second = bridge.saveSettings({ fontSize: 'large' });
      const third = bridge.saveSettings({ translation: { cloud: { model: 'custom-model' } } });
      const fourth = bridge.saveSettings({ translation: { enabled: true } });
      const [one, two, three, four] = await Promise.all([first, second, third, fourth]);
      expect(one.theme).toBe('dark');
      expect(one.fontSize).not.toBe('large');
      expect(two).toMatchObject({ theme: 'dark', fontSize: 'large' });
      expect(three.translation.cloud.model).toBe('custom-model');
      expect(four).toMatchObject({ theme: 'dark', fontSize: 'large', translation: { enabled: true, cloud: { model: 'custom-model' } } });
      expect(await bridge.getSettings()).toEqual(four);
      expect(write).toHaveBeenCalledTimes(4);
    });
    it('migrates a legacy target and persists target selection independently of interface language', async () => {
      const legacy = { ...makeDefaults(['zh']), translation: { enabled: false, engine: 'cloud',
        cloud: { baseURL: '', apiKey: '', model: '' } } };
      storage.get.mockResolvedValue(legacy);
      storage.nativeGet.mockResolvedValue({ value: JSON.stringify(legacy) });
      const bridge = createBridge();
      expect((await bridge.getSettings()).translation.targetLang).toBe('zh');
      await bridge.saveSettings({ translation: { targetLang: 'ja' } });
      const saved = await bridge.saveSettings({ nativeLang: 'en' });
      expect(saved.translation.targetLang).toBe('ja');
      const args = write.mock.calls.at(-1)!;
      const persisted = name === 'web' ? args[1] : JSON.parse(args[0].value);
      expect(persisted).toMatchObject({ nativeLang: 'en', translation: { targetLang: 'ja' } });
    });
    it('serializes pending writes and snapshots patches before callers mutate them', async () => {
      const bridge = createBridge();
      await bridge.getSettings();
      let release!: () => void;
      write.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      const patch = { theme: 'dark' as const };
      const first = bridge.saveSettings(patch);
      const second = bridge.saveSettings({ fontSize: 'large' });
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      Object.assign(patch, { theme: 'light' });
      const reading = bridge.getSettings();
      release();
      await first;
      expect(await second).toMatchObject({ theme: 'dark', fontSize: 'large' });
      expect(await reading).toMatchObject({ theme: 'dark', fontSize: 'large' });
    });
    it('continues after failed persistence without publishing the failed patch', async () => {
      const bridge = createBridge();
      await bridge.getSettings();
      write.mockRejectedValueOnce(new Error('disk failed'));
      const failed = bridge.saveSettings({ theme: 'dark' });
      const next = bridge.saveSettings({ fontSize: 'medium' });
      await expect(failed).rejects.toThrow('disk failed');
      expect(await next).toMatchObject({ theme: 'system', fontSize: 'medium' });
    });
  });
}
