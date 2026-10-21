import type { ShortcutAction } from '@rt/core';
import { bridge } from '../bridge';

/**
 * 订阅宿主的全局快捷键（macOS 主进程注册，经 onShortcut 转发），只响应指定动作。
 * 宿主没有快捷键能力（Web / iOS）时为空操作。返回反注册函数，组件卸载时调用。
 */
export function onShortcutAction(action: ShortcutAction, run: () => void): () => void {
  return bridge().onShortcut?.((received) => {
    if (received === action) run();
  }) ?? (() => {});
}
