import { describe, expect, it } from 'vitest';
import { availableAudioSources, systemAudioSupported } from './audio-source';
import { asrModelsFor, translationModelsFor } from '@rt/core';

describe('Windows desktop capabilities', () => {
  it('offers loopback and microphone on Windows 10 and 11 kernel versions', () => {
    expect(availableAudioSources('10.0.19045', 'win32')).toEqual(['system', 'mic']);
    expect(availableAudioSources('10.0.26100', 'win32')).toEqual(['system', 'mic']);
    expect(systemAudioSupported('6.1', 'win32')).toBe(false);
  });
  it('preserves the Mac 14.2 boundary and does not claim Linux capture', () => {
    expect(availableAudioSources('14.1')).toEqual(['mic']);
    expect(availableAudioSources('14.2')).toEqual(['system', 'mic']);
    expect(availableAudioSources('99', 'linux')).toEqual(['mic']);
  });
  it('offers native Windows ASR and local translation without cloud substitution', () => {
    expect(asrModelsFor('ja', 'windows').map(model => model.id)).toContain('sense-voice');
    expect(translationModelsFor('windows').map(model => model.id)).toContain('hy-mt2-7b');
    expect(translationModelsFor('windows').map(model => model.id)).toContain('m2m100');
  });
});
