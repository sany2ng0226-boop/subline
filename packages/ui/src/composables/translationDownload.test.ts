import { beforeEach, expect, it, vi } from 'vitest';
import { getTranslationModel, type AppBridge } from '@rt/core';
import { setBridge } from '../bridge';
import { missingTranslationDownload } from './translationDownload';

const getStatus = vi.fn();
const download = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  setBridge({ getTranslationSetupStatus: getStatus, downloadTranslationModel: download } as unknown as AppBridge);
});

it('offers the selected missing model with its size without starting a download', async () => {
  getStatus.mockResolvedValue({ ready: false });
  const spec = getTranslationModel('hy-mt2-7b')!;
  expect(await missingTranslationDownload(spec.id)).toEqual([{
    kind: 'translation', modelId: spec.id, nameKey: spec.nameKey, sizeBytes: spec.approxDownloadBytes,
  }]);
  expect(download).not.toHaveBeenCalled();
});

it('does not offer cached models', async () => {
  getStatus.mockResolvedValue({ ready: true });
  expect(await missingTranslationDownload('hy-mt2-7b')).toEqual([]);
  expect(download).not.toHaveBeenCalled();
});

it('does not offer cloud or unsupported models', async () => {
  expect(await missingTranslationDownload('cloud')).toEqual([]);
  expect(await missingTranslationDownload('unknown')).toEqual([]);
  expect(getStatus).not.toHaveBeenCalled();
});

it('does not offer downloads on hosts with system translation', async () => {
  setBridge({} as AppBridge);
  expect(await missingTranslationDownload('m2m100')).toEqual([]);
});

it('propagates status errors without downloading', async () => {
  getStatus.mockRejectedValue(new Error('offline'));
  await expect(missingTranslationDownload('hy-mt2-7b')).rejects.toThrow('offline');
  expect(download).not.toHaveBeenCalled();
});
