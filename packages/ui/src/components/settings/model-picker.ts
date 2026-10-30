import { getAsrModel, getTranslationModel, type ModelInfo, type ModelKind } from '@rt/core';

export interface ModelPickerOption {
  value: string;
  label: string;
  modelId?: string;
  sizeBytes?: number;
  ultra?: boolean;
}

export function modelPickerRows(options: ModelPickerOption[], models: ModelInfo[], kind: ModelKind, value: string) {
  return options.map((option) => {
    const model = option.modelId ? models.find((item) => item.kind === kind && item.id === option.modelId) : undefined;
    const systemManaged = kind === 'asr' && !!option.modelId && getAsrModel(option.modelId)?.engine === 'appleSpeech';
    const registryBytes = option.modelId
      ? kind === 'asr' ? getAsrModel(option.modelId)?.approxBytes : getTranslationModel(option.modelId)?.approxDownloadBytes
      : undefined;
    return {
      ...option,
      model,
      systemManaged,
      current: option.value === value,
      selectable: systemManaged || !option.modelId || model?.downloaded === true,
      status: systemManaged ? 'systemManaged' : !option.modelId ? undefined : !model ? 'unavailable' : model.downloaded ? 'downloaded' : 'notDownloaded',
      sizeBytes: systemManaged ? undefined : model?.downloaded ? model.sizeBytes : option.sizeBytes ?? registryBytes,
    };
  });
}
