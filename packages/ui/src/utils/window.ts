/**
 * 悬浮字幕窗（macOS 以 index.html#overlay 加载同一份渲染层）：只显示字幕，
 * 不走引导、关闭保护、崩溃暂存与各类弹窗，这些都归主窗管。
 */
export function isOverlayWindow(): boolean {
  return typeof location !== 'undefined' && location.hash === '#overlay';
}
