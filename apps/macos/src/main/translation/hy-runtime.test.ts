import { describe, expect, it, vi } from 'vitest';
import type { Llama } from 'node-llama-cpp';
import { loadHyRuntime, type HyRuntimeStatus } from './hy-runtime';

const GiB = 1024 ** 3;

function runtime(gpu: 'cuda' | 'metal' | false, gpuLayers = gpu ? 32 : 0) {
  const context = { dispose: vi.fn().mockResolvedValue(undefined) };
  const model = {
    gpuLayers,
    dispose: vi.fn().mockResolvedValue(undefined),
    createContext: vi.fn().mockResolvedValue(context),
  };
  const llama = {
    gpu,
    getRamState: vi.fn().mockResolvedValue({ total: 16 * GiB, free: 10 * GiB }),
    getVramState: vi.fn().mockResolvedValue({ total: gpu ? 8 * GiB : 0, free: gpu ? 6 * GiB : 0, used: 0, unifiedSize: 0 }),
    loadModel: vi.fn().mockResolvedValue(model),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  return { llama, model, context, asLlama: llama as unknown as Llama };
}

describe('local translation runtime', () => {
  it('uses packaged CUDA with allocator safety and reserves its 4096-token context on Windows', async () => {
    const cuda = runtime('cuda');
    const getLlama = vi.fn().mockResolvedValue(cuda.asLlama);
    const statuses: HyRuntimeStatus[] = [];
    const result = await loadHyRuntime(getLlama, 'model.gguf', { onRuntimeStatus: s => statuses.push(s) }, 'win32');
    expect(result.model).toBe(cuda.model);
    expect(getLlama).toHaveBeenCalledExactlyOnceWith({ gpu: 'cuda', build: 'never', skipDownload: true });
    expect(cuda.model.createContext).toHaveBeenCalledWith({ contextSize: 4096, sequences: 1, flashAttention: 'auto', ignoreMemorySafetyChecks: false });
    expect(cuda.llama.loadModel).toHaveBeenCalledWith({ modelPath: 'model.gguf', gpuLayers: { fitContext: { contextSize: 4096 } }, ignoreMemorySafetyChecks: false });
    expect(statuses.at(-1)).toMatchObject({ backend: 'cuda', memory: { ramTotalBytes: 16 * GiB, ramFreeBytes: 10 * GiB, vramFreeBytes: 6 * GiB } });
  });

  it('falls back to CPU when CUDA initialization fails, keeping the reason on ready diagnostics', async () => {
    const cpu = runtime(false);
    const getLlama = vi.fn().mockRejectedValueOnce(new Error('CUDA driver unavailable')).mockResolvedValueOnce(cpu.asLlama);
    const statuses: HyRuntimeStatus[] = [];
    await loadHyRuntime(getLlama, 'model.gguf', { onRuntimeStatus: s => statuses.push(s) }, 'win32');
    expect(getLlama.mock.calls).toEqual([
      [{ gpu: 'cuda', build: 'never', skipDownload: true }],
      [{ gpu: false, build: 'never', skipDownload: true }],
    ]);
    expect(statuses.at(-1)).toMatchObject({ backend: 'cpu', fallbackReason: expect.stringContaining('CUDA driver unavailable') });
  });

  it('releases a failed CUDA model/context allocation before retrying with CPU', async () => {
    const cuda = runtime('cuda');
    const cpu = runtime(false);
    cuda.model.createContext.mockRejectedValue(new Error('Insufficient VRAM for context'));
    const getLlama = vi.fn().mockResolvedValueOnce(cuda.asLlama).mockImplementationOnce(async () => {
      expect(cuda.model.dispose).toHaveBeenCalledOnce();
      expect(cuda.llama.dispose).toHaveBeenCalledOnce();
      return cpu.asLlama;
    });
    const statuses: HyRuntimeStatus[] = [];
    await loadHyRuntime(getLlama, 'model.gguf', { onRuntimeStatus: s => statuses.push(s) }, 'win32');
    expect(statuses.at(-1)?.fallbackReason).toContain('Insufficient VRAM for context');
    expect(cpu.llama.dispose).not.toHaveBeenCalled();
  });

  it('reports RAM/VRAM diagnostics when neither local allocator can fit the model, without another engine', async () => {
    const cuda = runtime('cuda');
    const cpu = runtime(false);
    cuda.llama.loadModel.mockRejectedValue(new Error('Insufficient memory'));
    cpu.llama.getRamState.mockResolvedValue({ total: 8 * GiB, free: 0.5 * GiB });
    cpu.llama.loadModel.mockRejectedValue(new Error('Insufficient memory'));
    const getLlama = vi.fn().mockResolvedValueOnce(cuda.asLlama).mockResolvedValueOnce(cpu.asLlama);
    await expect(loadHyRuntime(getLlama, 'model.gguf', {}, 'win32')).rejects.toThrow(/资源不足.*未切换到云服务.*0.5 GiB/);
    expect(getLlama).toHaveBeenCalledTimes(2);
    expect(cpu.llama.dispose).toHaveBeenCalledOnce();
    expect(cpu.model.createContext).not.toHaveBeenCalled();
  });

  it('does not present a silently downgraded CUDA runtime as GPU acceleration', async () => {
    const silentCpu = runtime(false);
    const cpu = runtime(false);
    const getLlama = vi.fn().mockResolvedValueOnce(silentCpu.asLlama).mockResolvedValueOnce(cpu.asLlama);
    const statuses: HyRuntimeStatus[] = [];
    await loadHyRuntime(getLlama, 'model.gguf', { onRuntimeStatus: s => statuses.push(s) }, 'win32');
    expect(silentCpu.llama.loadModel).not.toHaveBeenCalled();
    expect(silentCpu.llama.dispose).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toMatchObject({ backend: 'cpu', fallbackReason: expect.stringContaining('未启用 CUDA') });
  });

  it('identifies a CUDA model allocated entirely to the CPU', async () => {
    const cuda = runtime('cuda', 0);
    const statuses: HyRuntimeStatus[] = [];
    await loadHyRuntime(vi.fn().mockResolvedValue(cuda.asLlama), 'model.gguf', { onRuntimeStatus: s => statuses.push(s) }, 'win32');
    expect(statuses.at(-1)).toMatchObject({ backend: 'cpu', fallbackReason: expect.stringContaining('未能分配 GPU 层') });
  });

  it('preserves Metal and flash attention on macOS without CPU retry', async () => {
    const metal = runtime('metal');
    const getLlama = vi.fn().mockResolvedValue(metal.asLlama);
    await loadHyRuntime(getLlama, 'model.gguf', {}, 'darwin');
    expect(getLlama).toHaveBeenCalledExactlyOnceWith({ gpu: 'metal', build: 'never', skipDownload: true });
    expect(metal.llama.loadModel).toHaveBeenCalledWith({ modelPath: 'model.gguf', ignoreMemorySafetyChecks: false });
    expect(metal.model.createContext).toHaveBeenCalledWith({ contextSize: 4096, sequences: 1, flashAttention: true, ignoreMemorySafetyChecks: false });
    const failing = vi.fn().mockRejectedValue(new Error('Metal unavailable'));
    await expect(loadHyRuntime(failing, 'model.gguf', {}, 'darwin')).rejects.toThrow('Metal unavailable');
    expect(failing).toHaveBeenCalledOnce();
  });
});
