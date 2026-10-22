import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { StartResult } from '@rt/core';
import type { ElectronApi } from '../../shared/types';
import { CAPTURE_FLUSH_TIMEOUT_MS, createMacBridge } from './mac-bridge';

type PortData = Float32Array | { type: 'flushed'; id: number };
type FlushRequest = { type: 'flush'; id: number };
type TestPort = {
  onmessage: ((event: { data: PortData }) => void) | null;
  postMessage?: ReturnType<typeof vi.fn<(message: FlushRequest) => void>>;
};

function fixture(source: 'mic' | 'system' = 'system', hasAudio = true, flush: 'legacy' | 'manual' | 'auto' = 'legacy') {
  const ended: Array<() => void> = [];
  const audio = { readyState: 'live', stop: vi.fn(), addEventListener: vi.fn((_event, cb) => ended.push(cb)) };
  const video = { stop: vi.fn() };
  const stream = { getAudioTracks: () => hasAudio ? [audio] : [], getVideoTracks: () => [video],
    getTracks: () => hasAudio ? [audio, video] : [video] };
  const devices = { getDisplayMedia: vi.fn(async () => stream), getUserMedia: vi.fn(async () => stream) };
  const close = vi.fn(async () => {});
  const captures: Array<{ port: TestPort }> = [];
  vi.stubGlobal('navigator', { mediaDevices: devices });
  vi.stubGlobal('AudioContext', class {
    audioWorklet = { addModule: vi.fn(async () => {}) };
    createMediaStreamSource() { return { connect: vi.fn() }; }
    close = close;
  });
  vi.stubGlobal('AudioWorkletNode', class {
    port: TestPort = { onmessage: null };
    constructor() {
      if (flush !== 'legacy') this.port.postMessage = vi.fn((message: FlushRequest) => {
        if (flush === 'auto') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'flushed', id: message.id } }));
      });
      captures.push(this);
    }
  });
  const api = { startPipeline: vi.fn<() => Promise<StartResult>>(async () => ({ ok: true })), stopPipeline: vi.fn(async () => ({ ok: true })),
    getSettings: vi.fn(async () => ({ audioSource: source })), sendAudio: vi.fn(),
    platform: 'windows', audioSources: ['system', 'mic'], onStatus: vi.fn(() => vi.fn()) };
  return { bridge: createMacBridge(api as unknown as ElectronApi), api, devices, audio, video, ended, close, captures };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function worklet() {
  const messages: PortData[] = [];
  type Processor = {
    process(inputs: Float32Array[][]): boolean;
    port: { onmessage: ((event: { data: FlushRequest }) => void); postMessage(data: PortData): void };
  };
  let Constructor: new () => Processor;
  runInNewContext(readFileSync(new URL('../public/audio-worklet.js', import.meta.url), 'utf8'), {
    Float32Array,
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: (data: PortData) => messages.push(data) };
    },
    registerProcessor: (_name: string, processor: new () => Processor) => { Constructor = processor; },
  });
  return { processor: new Constructor!(), messages };
}
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

describe('worklet stop handshake', () => {
  it('flushes exactly the buffered tail before acknowledging and accepts no later render blocks', () => {
    const { processor, messages } = worklet();
    const input = Float32Array.from({ length: 2300 }, (_, i) => i / 2300);
    processor.process([[input]]);
    expect(messages).toHaveLength(1);
    expect((messages[0] as Float32Array).length).toBe(2048);
    processor.port.onmessage({ data: { type: 'flush', id: 7 } });
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual(input.slice(2048));
    expect(messages[2]).toEqual({ type: 'flushed', id: 7 });
    expect(processor.process([[toneFrame()]])).toBe(false);
    expect(messages).toHaveLength(3);
  });

  it('forwards a real synthetic worklet tail with its capture token before host finalization', async () => {
    const f = fixture('system', true, 'manual');
    f.api.startPipeline.mockResolvedValueOnce({ ok: true, captureSource: 'system', captureToken: 'session-tail' });
    await f.bridge.startPipeline();
    expect(f.api.getSettings).not.toHaveBeenCalled();
    const { processor } = worklet();
    const port = f.captures[0]!.port;
    processor.port.postMessage = (data) => port.onmessage!({ data });
    port.postMessage!.mockImplementation((data) => processor.port.onmessage({ data }));
    const input = toneFrame();
    processor.process([[input]]);
    expect(f.api.sendAudio).not.toHaveBeenCalled();
    await f.bridge.stopPipeline();
    expect(f.api.sendAudio).toHaveBeenCalledExactlyOnceWith(input, 'session-tail');
    expect(f.api.sendAudio.mock.invocationCallOrder[0]).toBeLessThan(f.api.stopPipeline.mock.invocationCallOrder[0]!);
    expect(f.audio.stop).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('waits for the matching acknowledgement before closing capture or finalizing the host', async () => {
    const f = fixture('system', true, 'manual');
    await f.bridge.startPipeline();
    const port = f.captures[0]!.port;
    const stop = f.bridge.stopPipeline();
    expect(f.bridge.stopPipeline()).toBe(stop);
    const { id } = port.postMessage!.mock.calls[0][0];
    port.onmessage!({ data: toneFrame() });
    port.onmessage!({ data: { type: 'flushed', id: id + 1 } });
    await Promise.resolve();
    expect(f.api.stopPipeline).not.toHaveBeenCalled();
    expect(f.audio.stop).not.toHaveBeenCalled();
    port.onmessage!({ data: { type: 'flushed', id } });
    await stop;
    expect(f.api.stopPipeline).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('ignores old frames and track-ended callbacks after a new capture starts', async () => {
    const f = fixture('system', true, 'auto');
    f.api.startPipeline.mockResolvedValueOnce({ ok: true, captureToken: 'old' });
    await f.bridge.startPipeline();
    const oldPort = f.captures[0]!.port;
    await f.bridge.stopPipeline();
    oldPort.onmessage!({ data: toneFrame() });
    f.api.startPipeline.mockResolvedValueOnce({ ok: true, captureToken: 'new' });
    // A fresh stream lets the test also distinguish an old track's ended event.
    const newer = { getAudioTracks: () => [{ readyState: 'live', stop: vi.fn(), addEventListener: vi.fn() }],
      getVideoTracks: () => [], getTracks: () => [] };
    f.devices.getDisplayMedia.mockResolvedValueOnce(newer as unknown as Awaited<ReturnType<typeof f.devices.getDisplayMedia>>);
    await f.bridge.startPipeline();
    oldPort.onmessage!({ data: toneFrame() });
    f.ended[0]!();
    const currentPort = f.captures[1]!.port;
    const input = toneFrame();
    currentPort.onmessage!({ data: input });
    expect(f.api.sendAudio).toHaveBeenCalledExactlyOnceWith(input, 'new');
    expect(f.api.stopPipeline).toHaveBeenCalledOnce();
    await f.bridge.stopPipeline();
  });

  it('still finalizes the host and propagates a missing worklet acknowledgement', async () => {
    vi.useFakeTimers();
    const f = fixture('system', true, 'manual');
    await f.bridge.startPipeline();
    const stop = f.bridge.stopPipeline();
    const failed = expect(stop).rejects.toThrow('final samples');
    await vi.advanceTimersByTimeAsync(CAPTURE_FLUSH_TIMEOUT_MS);
    await failed;
    expect(f.api.stopPipeline).toHaveBeenCalledOnce();
    expect(f.audio.stop).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    f.captures[0]!.port.onmessage!({ data: toneFrame() });
    expect(f.api.sendAudio).not.toHaveBeenCalled();
  });

  it('waits for the previous stop before starting a new capture', async () => {
    const f = fixture('system', true, 'manual');
    await f.bridge.startPipeline();
    const oldPort = f.captures[0]!.port;
    const stop = f.bridge.stopPipeline();
    const start = f.bridge.startPipeline();
    expect(f.api.startPipeline).toHaveBeenCalledOnce();
    const { id } = oldPort.postMessage!.mock.calls[0][0];
    oldPort.onmessage!({ data: { type: 'flushed', id } });
    await stop;
    await start;
    expect(f.api.startPipeline).toHaveBeenCalledTimes(2);
    const finalStop = f.bridge.stopPipeline();
    const newPort = f.captures[1]!.port;
    const nextId = newPort.postMessage!.mock.calls[0][0].id;
    newPort.onmessage!({ data: { type: 'flushed', id: nextId } });
    await finalStop;
  });

  it('still finalizes the host if posting flush fails', async () => {
    const f = fixture('system', true, 'manual');
    await f.bridge.startPipeline();
    f.captures[0]!.port.postMessage!.mockImplementation(() => { throw new Error('port disconnected'); });
    await expect(f.bridge.stopPipeline()).rejects.toThrow('port disconnected');
    expect(f.api.stopPipeline).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('propagates host finalization failure after a successful worklet flush', async () => {
    const f = fixture('system', true, 'auto');
    await f.bridge.startPipeline();
    f.api.stopPipeline.mockRejectedValueOnce(new Error('disk full'));
    await expect(f.bridge.stopPipeline()).rejects.toThrow('disk full');
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('rejects an explicit failed host result instead of letting the UI assume stop succeeded', async () => {
    const f = fixture('system', true, 'auto');
    await f.bridge.startPipeline();
    f.api.stopPipeline.mockResolvedValueOnce({ ok: false });
    await expect(f.bridge.stopPipeline()).rejects.toThrow('finalization failed');
    expect(f.close).toHaveBeenCalledOnce();
  });
});

function toneFrame(): Float32Array {
  return Float32Array.from({ length: 384 }, (_, i) => Math.sin(i * Math.PI / 20));
}

describe('global shortcut passthrough', () => {
  it('forwards onShortcut when preload provides it, and omits it otherwise', () => {
    const off = vi.fn();
    const onShortcut = vi.fn(() => off);
    const bridge = createMacBridge({ platform: 'macos', onStatus: vi.fn(() => vi.fn()), onShortcut } as unknown as ElectronApi);
    const cb = vi.fn();
    expect(bridge.onShortcut!(cb)).toBe(off);
    expect(onShortcut).toHaveBeenCalledWith(cb);
    expect(createMacBridge({ platform: 'macos', onStatus: vi.fn(() => vi.fn()) } as unknown as ElectronApi).onShortcut).toBeUndefined();
  });
});

describe('crash recovery passthrough', () => {
  it('forwards recovery storage to the host when preload provides it', async () => {
    const recovery = { saveRecovery: vi.fn(async () => {}), loadRecovery: vi.fn(async () => '{"v":1}'),
      clearRecovery: vi.fn(async () => {}) };
    const bridge = createMacBridge({ platform: 'macos', onStatus: vi.fn(() => vi.fn()), ...recovery } as unknown as ElectronApi);
    await bridge.saveRecovery!('x');
    expect(await bridge.loadRecovery!()).toBe('{"v":1}');
    await bridge.clearRecovery!();
    expect(recovery.saveRecovery).toHaveBeenCalledWith('x');
    expect(recovery.clearRecovery).toHaveBeenCalledOnce();
  });
  it('leaves recovery undefined without host support so the UI falls back to localStorage', () => {
    const bridge = createMacBridge({ platform: 'macos', onStatus: vi.fn(() => vi.fn()) } as unknown as ElectronApi);
    expect(bridge.saveRecovery).toBeUndefined();
    expect(bridge.loadRecovery).toBeUndefined();
    expect(bridge.clearRecovery).toBeUndefined();
  });
});
