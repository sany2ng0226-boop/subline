import { expect, it, vi } from 'vitest';
import type { AppBridge } from '@rt/core';
import { i18n } from '../i18n';
import { micDeniedDescKey, micSettingsOpener, pipelineErrorCode } from './micPermission';

it('reclassifies a denied getUserMedia as a mic permission error', () => {
  expect(pipelineErrorCode('asr-init-failed', 'NotAllowedError: Permission denied')).toBe('mic-permission');
  expect(pipelineErrorCode(undefined, 'PermissionDeniedError')).toBe('mic-permission');
  expect(pipelineErrorCode('mic-permission', 'whatever')).toBe('mic-permission');
});

it('keeps unrelated codes and system audio denial as they are', () => {
  expect(pipelineErrorCode('asr-init-failed', 'model file missing')).toBe('asr-init-failed');
  expect(pipelineErrorCode('system-audio-permission', 'NotAllowedError')).toBe('system-audio-permission');
  expect(pipelineErrorCode(null, 'boom')).toBeNull();
});

it('tells each platform where to turn the microphone back on', () => {
  i18n.global.locale.value = 'en';
  expect(i18n.global.t(micDeniedDescKey('macos'))).toContain('System Settings › Privacy & Security › Microphone');
  expect(i18n.global.t(micDeniedDescKey('web'))).toContain('site settings');
  expect(i18n.global.t(micDeniedDescKey('ios'))).toContain('Settings › Subline › Microphone');
  expect(micDeniedDescKey('windows')).toBe('mic.windowsDeniedDesc');
});

it('offers an open-settings action only when the host can open settings', () => {
  const openMicSettings = vi.fn();
  expect(micSettingsOpener({ platform: 'web', openMicSettings } as unknown as AppBridge)).toBeNull();

  const openPermissionSettings = vi.fn();
  micSettingsOpener({ platform: 'web', openMicSettings, openPermissionSettings } as unknown as AppBridge)!();
  expect(openPermissionSettings).toHaveBeenCalledWith('microphone');

  micSettingsOpener({ platform: 'macos', openMicSettings } as unknown as AppBridge)!();
  expect(openMicSettings).toHaveBeenCalledOnce();
});
