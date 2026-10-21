// @rt/ui 公共出口：平台无关的 Vue 渲染层。
// 各宿主（macOS Electron / iOS Capacitor）通过 mountApp 注入桥接实现并挂载同一套 UI。
import { createApp } from 'vue';
import type { AppBridge } from '@rt/core';
import App from './App.vue';
import { i18n } from './i18n';
import { setBridge } from './bridge';
import { registerTranscriptionListeners } from './composables/useTranscription';
import { registerModelDownloadListeners } from './composables/useModelDownloads';
import { registerCloseGuard } from './composables/useSessionArchive';
import { initRecovery } from './composables/useRecovery';
import { settings } from './composables/useSettings';
import { isOverlayWindow } from './utils/window';

export { setBridge, bridge } from './bridge';

/**
 * 把渲染层挂载到给定选择器，并注入平台桥接。
 * 顺序：先 setBridge（让 bridge() 可用），再注册转写 + 下载监听，最后挂载 Vue 应用。
 */
export function mountApp(selector: string, b: AppBridge): void {
  setBridge(b);
  // 桥接就绪后再注册一次性 IPC 监听（内部有 registered 守卫，重复调用安全）。
  registerTranscriptionListeners();
  registerModelDownloadListeners();
  // 关闭保护跟随应用整个生命周期（离开主页去设置 / 归档页时内容仍在内存，仍需拦截退出）。
  registerCloseGuard();
  // 崩溃暂存只归主窗管：悬浮窗收到同样的字幕，不能重复写入或弹恢复条。
  if (!isOverlayWindow()) void initRecovery({ lang: () => settings.value?.asr.language });
  createApp(App).use(i18n).mount(selector);
}
