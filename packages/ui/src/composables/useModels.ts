// Share one metadata snapshot across model pickers; avoid repeated cache probes.
import { ref, type Ref } from 'vue';
import type { ModelInfo } from '@rt/core';
import { bridge } from '../bridge';
import { onDownloadDone } from './useModelDownloads';

// —— 单例状态 ——
// 模型列表快照（跨组件挂载共享）、首次加载标记、在途探测句柄（并发去重）。
const models = ref<ModelInfo[]>([]);
const error = ref('');
let loaded = false;
let inFlight: Promise<void> | null = null;

/** 重新探测并更新模型列表。并发调用共享同一次探测（去重），避免同时打开选择器时重复探测缓存。 */
export function refreshModels(): Promise<void> {
  if (inFlight) return inFlight;
  error.value = '';
  inFlight = bridge()
    .listModels()
    .then((list) => {
      models.value = list;
      loaded = true;
    })
    .catch((cause) => {
      error.value = 'unavailable';
      throw cause;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// 应用级只注册一次：下载完成/失败/取消后刷新列表，保持展示与实际缓存一致
// （取消失败态是同步清理、不发 done 事件，由删除/取消处显式 refreshModels 兜底）。
let doneRegistered = false;
function ensureDoneListener(): void {
  if (doneRegistered) return;
  doneRegistered = true;
  onDownloadDone(() => {
    void refreshModels().catch(() => undefined);
  });
}

/**
 * 模型选择器数据源：返回共享的 models 快照与刷新方法。
 * 首次使用触发一次探测（此后进入页面直接用快照，秒开）；删除/取消等本地变更由调用方显式 refreshModels()。
 */
export function useModels(): { models: Ref<ModelInfo[]>; error: Ref<string>; refreshModels: () => Promise<void> } {
  ensureDoneListener();
  if (!loaded && !inFlight) void refreshModels().catch(() => undefined);
  return { models, error, refreshModels };
}
