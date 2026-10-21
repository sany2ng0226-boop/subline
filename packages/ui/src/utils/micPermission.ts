import type { AppBridge, PipelineErrorCode } from '@rt/core';

// 宿主可能把 getUserMedia 的 DOMException 原文透传上来却不带（或带错）错误码，
// 例如权限被拒却报 asr-init-failed：按 DOMException 名补认成 mic-permission。
const DENIED_TEXT = /\b(NotAllowedError|PermissionDeniedError)\b/;

/** 归一化管线错误码：原文是麦克风权限拒绝时改判为 mic-permission。 */
export function pipelineErrorCode(code: PipelineErrorCode | null | undefined, text: string | undefined): PipelineErrorCode | null {
  if (code === 'mic-permission' || code === 'system-audio-permission') return code;
  if (text && DENIED_TEXT.test(text)) return 'mic-permission';
  return code ?? null;
}

/** 被拒后「去哪里开启」的文案：各端设置入口不同。 */
export function micDeniedDescKey(platform: AppBridge['platform']): string {
  if (platform === 'web') return 'mic.webDeniedDesc';
  if (platform === 'ios') return 'mic.iosDeniedDesc';
  if (platform === 'windows') return 'mic.windowsDeniedDesc';
  return 'mic.deniedDesc';
}

type PermissionSettingsBridge = AppBridge & { openPermissionSettings?: (kind: 'microphone') => unknown };

/**
 * 打开麦克风权限设置的动作；宿主打不开时返回 null（不展示按钮）。
 * 优先用新的 openPermissionSettings（宿主可能尚未提供，按存在检测）；
 * 否则沿用 openMicSettings，但 Web 上它是空实现，不算能打开。
 */
export function micSettingsOpener(b: AppBridge): (() => void) | null {
  const host = b as PermissionSettingsBridge;
  if (typeof host.openPermissionSettings === 'function') return () => void host.openPermissionSettings!('microphone');
  if (b.platform === 'web') return null;
  return () => b.openMicSettings();
}
