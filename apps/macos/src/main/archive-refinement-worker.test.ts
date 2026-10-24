import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ArchiveRevision } from '@rt/core';
import type { RefinementJob } from './offline-refinement';

const state = vi.hoisted(() => ({ asr: null as any, translation: null as any, automatic: true, forked: 0 }));
vi.mock('electron', () => ({ utilityProcess: { fork: () => state.asr } }));
vi.mock('node:child_process', () => ({ fork: () => { state.forked++; return state.translation; } }));
import { startRefinementWorker } from './archive-refinement-worker';

beforeEach(() => {
  state.forked = 0; state.automatic = true;
  state.asr = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: vi.fn() });
  state.translation = Object.assign(new EventEmitter(), {
    kill: vi.fn(), send: vi.fn((message: { type: string; id: number; text: string }) => {
      if (message.type === 'translate' && state.automatic) {
        queueMicrotask(() => state.translation.emit('message', { type: 'result', id: message.id, text: `译文 ${message.text}` }));
      }
    }),
  });
});
const job: RefinementJob = { archiveId: 'test', recordings: [], modelsDir: '/models', cacheDir: '/cache',
  options: { asrModel: 'sense-voice', language: 'ja', targetLang: 'zh', translationModel: 'hy-mt2-7b' } };
const paths = { asr: '/asr-worker', translation: '/translation-worker', packaged: false };
function revision(): ArchiveRevision {
  return { id: 'review', createdAt: 1, options: { ...job.options, translationModel: undefined },
    lines: [{ text: 'one', lang: 'ja', translation: '' }, { text: 'two', lang: 'ja', translation: '' }] };
}

it('uses utilityProcess only for ASR and translates every line sequentially without context or live queue', async () => {
  const progress = vi.fn();
  const handle = startRefinementWorker(job, progress, paths);
  expect(state.asr.postMessage.mock.calls[0][0].options.translationModel).toBeUndefined();
  state.asr.emit('message', { type: 'result', revision: revision() });
  const result = await handle.result;
  expect(state.asr.kill).toHaveBeenCalledOnce();
  expect(result.options).toEqual(job.options);
  expect(result.lines.map(line => line.translation)).toEqual(['译文 one', '译文 two']);
  const requests = state.translation.send.mock.calls.map((call: any[]) => call[0]);
  expect(requests[0]).toMatchObject({ type: 'configure', engine: 'hy-mt2-7b' });
  expect(requests.slice(1)).toEqual([
    { type: 'translate', id: 0, text: 'one', source: 'ja', target: 'zh' },
    { type: 'translate', id: 1, text: 'two', source: 'ja', target: 'zh' },
  ]);
  handle.cancel();
  expect(state.translation.kill).toHaveBeenCalledOnce();
});

it('does not allocate a translation worker for transcription-only reviews', async () => {
  const handle = startRefinementWorker({ ...job, options: { ...job.options, translationModel: undefined } }, vi.fn(), paths);
  state.asr.emit('message', { type: 'result', revision: revision() });
  expect((await handle.result).lines[0].translation).toBe('');
  expect(state.forked).toBe(0);
  handle.cancel();
});

it('cancels a blocked translation and cannot return a partial version', async () => {
  state.automatic = false;
  const handle = startRefinementWorker(job, vi.fn(), paths);
  state.asr.emit('message', { type: 'result', revision: revision() });
  expect(state.translation.send).toHaveBeenCalledTimes(2);
  handle.cancel();
  await expect(handle.result).rejects.toThrow('Cancelled');
  expect(state.translation.kill).toHaveBeenCalledOnce();
});
