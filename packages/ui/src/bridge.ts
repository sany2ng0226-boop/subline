import type { AppBridge } from '@rt/core';
import { configureDevQa } from './devQa';

// 渲染层与宿主平台之间的桥接：由 mountApp 在挂载前通过 setBridge 注入具体实现
// （macOS 下由 createMacBridge 包装 window.api，iOS Capacitor 下为各自的实现），
// UI 代码只通过 bridge() 访问，不再直接引用任何宿主全局对象或采集音频。
let _bridge: AppBridge | null = null;

export function setBridge(b: AppBridge): void {
  _bridge = b;
  configureDevQa(b.devQa);
}

export function bridge(): AppBridge {
  if (!_bridge) throw new Error('bridge not set');
  return _bridge;
}
