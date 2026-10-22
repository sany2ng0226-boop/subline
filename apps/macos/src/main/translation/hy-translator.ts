import path from 'node:path';
import type { LlamaModel, LlamaContext, LlamaChatSession } from 'node-llama-cpp';
import { getTranslationModel, translationPrompt, normalizeZh, type Translator } from '@rt/core';
import { localModelCached } from './model-cache';
import { loadHyRuntime, type HyRuntimeOptions } from './hy-runtime';

const LANG_NAMES: Record<string, string> = { zh: 'Chinese (Simplified)', ja: 'Japanese', en: 'English', ko: 'Korean', yue: 'Cantonese' };

export class HyTranslator implements Translator {
  private loading: Promise<void> | null = null;
  private model: LlamaModel | undefined;
  private context: LlamaContext | undefined;
  private Session: typeof LlamaChatSession | undefined;

  constructor(private readonly cacheDir: string, private readonly runtimeOptions: HyRuntimeOptions = {}) {}

  init(): Promise<void> {
    if (!this.loading) this.loading = this.load().catch(error => { this.loading = null; throw error; });
    return this.loading;
  }

  private async load(): Promise<void> {
    const spec = getTranslationModel('hy-mt2-7b')!;
    if (!localModelCached(this.cacheDir, spec)) throw new Error('Hy-MT2 7B 未下载，请先在模型管理中下载');
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    const runtime = await loadHyRuntime(getLlama,
      path.join(this.cacheDir, spec.modelId, spec.files[0]!.filename), this.runtimeOptions);
    this.model = runtime.model;
    this.context = runtime.context;
    this.Session = LlamaChatSession;
  }

  async translate(text: string, opts: { source?: string; target: string; context?: string[]; onPartial?: (text: string) => void }): Promise<string> {
    if (!text.trim() || opts.source === opts.target) return text;
    await this.init();
    // HY-MT2 can translate reference context instead of the current sentence; keep each request source-only.
    const session = new this.Session!({ contextSequence: this.context!.getSequence(), autoDisposeSequence: true, systemPrompt: '' });
    let partial = '';
    try {
      const result = await session.promptWithMeta(translationPrompt(text, LANG_NAMES[opts.target] ?? opts.target), {
        temperature: 0, maxTokens: 1024, signal: AbortSignal.timeout(30_000),
        onTextChunk: (chunk: string) => {
          partial += chunk;
          opts.onPartial?.(opts.target === 'zh' ? normalizeZh(partial) : partial);
        },
      });
      if (!['eogToken', 'stopGenerationTrigger'].includes(result.stopReason)) throw new Error(`本地翻译未完整结束: ${result.stopReason}`);
      const output = result.responseText;
      if (!output.trim()) throw new Error('本地模型返回空译文');
      return opts.target === 'zh' ? normalizeZh(output.trim()) : output.trim();
    } finally { await session.dispose(); }
  }
}
