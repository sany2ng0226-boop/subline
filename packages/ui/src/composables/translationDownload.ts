import { getTranslationModel } from '@rt/core';
import { bridge } from '../bridge';
import type { DownloadTask } from './useModelDownloads';

/** Cached, cloud and system translation do not need a download offer. */
export async function missingTranslationDownload(engine: string): Promise<DownloadTask[]> {
  const spec = getTranslationModel(engine);
  const host = bridge();
  if (!spec || !host.getTranslationSetupStatus || !host.downloadTranslationModel) return [];
  const { ready } = await host.getTranslationSetupStatus(spec.id);
  return ready ? [] : [{
    kind: 'translation', modelId: spec.id, nameKey: spec.nameKey, sizeBytes: spec.approxDownloadBytes,
  }];
}
