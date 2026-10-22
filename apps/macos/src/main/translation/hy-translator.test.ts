import { beforeEach, expect, it, vi } from 'vitest';
import { translationPrompt } from '@rt/core';
import { HyTranslator } from './hy-translator';

const state = vi.hoisted(() => ({ prompts: [] as string[], dispose: vi.fn(), sequences: vi.fn(() => ({})) }));
vi.mock('./model-cache', () => ({ localModelCached: () => true }));
vi.mock('./hy-runtime', () => ({ loadHyRuntime: async () => ({ model: {}, context: { getSequence: state.sequences } }) }));
vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn(),
  LlamaChatSession: class {
    promptWithMeta = vi.fn(async (prompt: string, options: { onTextChunk: (text: string) => void }) => {
      state.prompts.push(prompt);
      options.onTextChunk('当前句译文');
      return { responseText: '当前句译文', stopReason: 'eogToken' };
    });
    dispose = state.dispose;
  },
}));
beforeEach(() => { state.prompts.length = 0; vi.clearAllMocks(); });

it('ignores caller-supplied previous text in both consecutive local requests', async () => {
  const translator = new HyTranslator('/cached-models');
  const first = 'Good morning, everyone. Today we will learn how light and color can change the way we see a painting.';
  const second = 'Please take a moment to look closely and tell meWhich detail catches your attention first.';
  await translator.translate(first, { source: 'en', target: 'ja', context: ['Earlier unrelated source'] });
  await translator.translate(second, { source: 'en', target: 'ja', context: [first] });
  expect(state.prompts).toEqual([translationPrompt(first, 'Japanese'), translationPrompt(second, 'Japanese')]);
  expect(state.prompts[1]).not.toContain(first);
  expect(state.sequences).toHaveBeenCalledTimes(2);
  expect(state.dispose).toHaveBeenCalledTimes(2);
});

it('keeps streaming and the final result while excluding previous source from the prompt', async () => {
  const translator = new HyTranslator('/cached-models');
  const onPartial = vi.fn();
  await expect(translator.translate('Current sentence', { source: 'en', target: 'zh', context: ['Previous sentence'], onPartial })).resolves.toBe('当前句译文');
  expect(onPartial).toHaveBeenCalledWith('当前句译文');
  expect(state.prompts[0]).toBe(translationPrompt('Current sentence', 'Chinese (Simplified)'));
  expect(state.dispose).toHaveBeenCalledOnce();
});
