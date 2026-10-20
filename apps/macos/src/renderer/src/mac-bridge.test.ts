import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElectronApi } from '../../shared/types';
import { createMacBridge } from './mac-bridge';

function fixture(source: 'mic' | 'system' = 'system', hasAudio = true) {
  const ended: Array<() => void> = [];
  const audio = { readyState: 'live', stop: vi.fn(), addEventListener: vi.fn((_event, cb) => ended.push(cb)) };
  const video = { stop: vi.fn() };
  const stream = { getAudioTracks: () => hasAudio ? [audio] : [], getVideoTracks: () => [video],
    getTracks: () => hasAudio ? [audio, video] : [video] };
  const devices = { getDisplayMedia: vi.fn(async () => stream), getUserMedia: vi.fn(async () => stream) };
  const close = vi.fn(async () => {});
  vi.stubGlobal('navigator', { mediaDevices: devices });
  vi.stubGlobal('AudioContext', class {
    audioWorklet = { addModule: vi.fn(async () => {}) };
    createMediaStreamSource() { return { connect: vi.fn() }; }
    close = close;
  });
  vi.stubGlobal('AudioWorkletNode', class { port = { onmessage: null }; });
  const api = { startPipeline: vi.fn(async () => ({ ok: true })), stopPipeline: vi.fn(async () => ({ ok: true })),
    getSettings: vi.fn(async () => ({ audioSource: source })), sendAudio: vi.fn(),
    platform: 'windows', audioSources: ['system', 'mic'], onStatus: vi.fn(() => vi.fn()) };
  return { bridge: createMacBridge(api as unknown as ElectronApi), api, devices, audio, video, ended, close };
}

afterEach(() => vi.unstubAllGlobals());
describe('desktop audio lifecycle', () => {
  it('captures loopback only, discards screen video, and releases both capture and ASR on stop', async () => {
    const f = fixture();
    expect(await f.bridge.startPipeline()).toEqual({ ok: true });
    expect(f.devices.getUserMedia).not.toHaveBeenCalled();
    expect(f.video.stop).toHaveBeenCalled();
    await f.bridge.stopPipeline();
    expect(f.audio.stop).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.api.stopPipeline).toHaveBeenCalledOnce();
  });
  it('uses only the microphone when selected', async () => {
    const f = fixture('mic');
    await f.bridge.startPipeline();
    expect(f.devices.getUserMedia).toHaveBeenCalledOnce();
    expect(f.devices.getDisplayMedia).not.toHaveBeenCalled();
    await f.bridge.stopPipeline();
  });
  it('rejects a silent video-only capture and rolls ASR back', async () => {
    const f = fixture('system', false);
    const result = await f.bridge.startPipeline();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('audio-capture-failed');
    expect(f.video.stop).toHaveBeenCalled();
    expect(f.api.stopPipeline).toHaveBeenCalledOnce();
  });
  it('maps microphone denial to permission guidance instead of reporting recording', async () => {
    const f = fixture('mic');
    f.devices.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    expect((await f.bridge.startPipeline()).code).toBe('mic-permission');
    expect(f.api.stopPipeline).toHaveBeenCalledOnce();
  });
  it('reports device interruption after releasing the active input', async () => {
    const f = fixture();
    const onStatus = vi.fn();
    f.bridge.onStatus(onStatus);
    await f.bridge.startPipeline();
    f.ended[0]!();
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ code: 'audio-interrupted' })));
    expect(f.audio.stop).toHaveBeenCalledOnce();
    expect(f.api.stopPipeline).toHaveBeenCalledOnce();
  });
  it('waits for an in-flight start before stopping, leaving no late capture running', async () => {
    const f = fixture();
    let resolve!: (result: { ok: boolean }) => void;
    f.api.startPipeline.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const start = f.bridge.startPipeline();
    const stop = f.bridge.stopPipeline();
    resolve({ ok: true });
    await start;
    await stop;
    expect(f.audio.stop).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
});
