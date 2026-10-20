import type { Llama, LlamaContext, LlamaModel, LlamaOptions } from 'node-llama-cpp';

export interface HyRuntimeStatus {
  backend: 'cuda' | 'cpu' | 'metal';
  fallbackReason?: string;
  memory?: {
    ramTotalBytes: number;
    ramFreeBytes: number;
    vramTotalBytes: number;
    vramFreeBytes: number;
  };
}

export interface HyRuntimeOptions {
  onRuntimeStatus?: (status: HyRuntimeStatus) => void;
}

type GetRuntime = (options: LlamaOptions) => Promise<Llama>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function availableMemory(status: HyRuntimeStatus | undefined): string {
  if (!status?.memory) return '';
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `（装载前可用内存 ${gib(status.memory.ramFreeBytes)} GiB，显存 ${gib(status.memory.vramFreeBytes)} GiB）`;
}

/** Use the allocator's model/context estimates and default OS reserve, never a guessed hardware cutoff. */
export async function loadHyRuntime(
  getLlama: GetRuntime,
  modelPath: string,
  options: HyRuntimeOptions = {},
  platform: NodeJS.Platform = process.platform,
): Promise<{ model: LlamaModel; context: LlamaContext }> {
  const backends = platform === 'darwin' ? ['metal'] as const : platform === 'win32' ? ['cuda', 'cpu'] as const : ['cpu'] as const;
  const failures: string[] = [];
  let lastStatus: HyRuntimeStatus | undefined;
  let lastError: unknown;
  const report = (status: HyRuntimeStatus) => {
    lastStatus = status;
    console.info('[Subline local translation]', JSON.stringify(status));
    options.onRuntimeStatus?.(status);
  };

  for (const backend of backends) {
    let llama: Llama | undefined;
    let model: LlamaModel | undefined;
    let context: LlamaContext | undefined;
    const fallbackReason = failures.length ? `CUDA 本地翻译不可用，已尝试切换到 CPU：${failures.join('；')}` : undefined;
    report({ backend, fallbackReason });
    try {
      // Both switches are needed: never compile, and never download llama.cpp source on user machines.
      llama = await getLlama({ gpu: backend === 'cpu' ? false : backend, build: 'never', skipDownload: true });
      if (backend === 'cuda' && llama.gpu !== 'cuda') throw new Error('未启用 CUDA 运行时');
      const [ram, vram] = await Promise.all([llama.getRamState(), llama.getVramState()]);
      const memory = {
        ramTotalBytes: ram.total, ramFreeBytes: ram.free,
        vramTotalBytes: vram.total, vramFreeBytes: vram.free,
      };
      report({ backend, fallbackReason, memory });
      model = await llama.loadModel({
        modelPath,
        // Reserve for the actual context on Windows while retaining the existing Metal allocation policy.
        ...(platform === 'win32' ? { gpuLayers: { fitContext: { contextSize: 4096 } } } : {}),
        ignoreMemorySafetyChecks: false,
      });
      context = await model.createContext({
        contextSize: 4096, sequences: 1,
        flashAttention: platform === 'darwin' ? true : 'auto',
        ignoreMemorySafetyChecks: false,
      });
      const cpuOnly = backend === 'cuda' && model.gpuLayers === 0;
      report({
        backend: cpuOnly ? 'cpu' : backend,
        fallbackReason: cpuOnly ? '显存分配器未能分配 GPU 层，当前使用 CPU 进行本地翻译' : fallbackReason,
        memory,
      });
      return { model, context };
    } catch (error) {
      lastError = error;
      failures.push(`${backend.toUpperCase()}：${errorText(error)}${availableMemory(lastStatus)}`);
      // Release partial allocations before CPU retry so it sees the actual available RAM.
      await context?.dispose().catch(() => {});
      await model?.dispose().catch(() => {});
      await llama?.dispose().catch(() => {});
    }
  }

  const memoryFailure = failures.some(message => /insufficient|out of memory|not enough|cannot allocate|failed to allocate|资源不足|内存不足|显存不足/i.test(message));
  throw new Error(
    (memoryFailure
      ? '本地翻译资源不足，无法装载 Hy-MT2 7B 或其上下文。请关闭占用内存/显存的程序后重试。'
      : '无法启动本地翻译，请检查应用是否包含适用于此电脑的本地运行时及 NVIDIA 驱动。')
    + ` 未切换到云服务。${failures.join('；')}`,
    { cause: lastError },
  );
}
