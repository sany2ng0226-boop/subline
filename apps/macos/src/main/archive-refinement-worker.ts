import { fork, type ChildProcess } from 'node:child_process';
import { utilityProcess } from 'electron';
import { normalizeZh, type ArchiveRefineProgress, type ArchiveRevision } from '@rt/core';
import type { RefinementJob, RefinementWorkerMessage } from './offline-refinement';
import type { TranslateToMain } from '../shared/types';

/** ASR needs utilityProcess buffers; translation needs Node's allocator for its large tensors. */
export function startRefinementWorker(job: RefinementJob, progress: (value: ArchiveRefineProgress) => void,
  paths: { asr: string; translation: string; packaged: boolean }) {
  const asr = utilityProcess.fork(paths.asr);
  let translation: ChildProcess | undefined;
  let settled = false;
  let awaitingAsr = true;
  let rejectPending: (error: Error) => void = () => {};
  let rejectTranslation: ((error: Error) => void) | undefined;
  const result = new Promise<ArchiveRevision>((resolve, reject) => {
    rejectPending = reject;
    const fail = (error: Error): void => { if (!settled) { settled = true; reject(error); } };
    async function finish(revision: ArchiveRevision): Promise<void> {
      try {
        revision.options = { ...job.options };
        const model = job.options.translationModel;
        const lines = revision.lines;
        if (model && lines.some((line) => line.lang !== job.options.targetLang)) {
          const workerPath = paths.packaged ? paths.translation.replace('app.asar', 'app.asar.unpacked') : paths.translation;
          translation = fork(workerPath, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
          let pending: { id: number; resolve(text: string): void; reject(error: Error): void } | undefined;
          rejectTranslation = (error) => { pending?.reject(error); pending = undefined; };
          translation.on('message', (message: TranslateToMain) => {
            if (message.type === 'result' && message.id === pending?.id) { pending.resolve(message.text); pending = undefined; }
            else if (message.type === 'error' && message.id === pending?.id) {
              pending.reject(new Error(message.message)); pending = undefined;
            } else if (message.type === 'status' && message.payload.state === 'error') {
              rejectTranslation?.(new Error(message.payload.error ?? 'Local translation failed'));
            }
          });
          translation.once('error', (error) => { rejectTranslation?.(error); fail(error); });
          translation.once('exit', (code, signal) => {
            if (!settled) {
              const error = new Error(`Recording translation stopped (${signal ?? code})`);
              rejectTranslation?.(error); fail(error);
            }
          });
          translation.send({ type: 'configure', engine: model, cacheDir: job.cacheDir,
            cloud: { baseURL: '', apiKey: '', model: '' } });
          progress({ archiveId: job.archiveId, state: 'translating', completed: 0, total: lines.length });
          for (let index = 0; index < lines.length; index++) {
            if (settled) throw new Error('Cancelled');
            const line = lines[index]!;
            if (line.lang !== job.options.targetLang) {
              const text = await new Promise<string>((yes, no) => {
                pending = { id: index, resolve: yes, reject: no };
                translation!.send({ type: 'translate', id: index, text: line.text,
                  source: line.lang, target: job.options.targetLang }, (error) => { if (error) rejectTranslation?.(error); });
              });
              if (!text.trim()) throw new Error('Local translation returned empty text');
              line.translation = job.options.targetLang === 'zh' ? normalizeZh(text.trim()) : text.trim();
            }
            progress({ archiveId: job.archiveId, state: 'translating', completed: index + 1, total: lines.length });
          }
        }
        if (!settled) { settled = true; resolve(revision); }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    }
    asr.on('message', (message: RefinementWorkerMessage) => {
      if (settled || !awaitingAsr) return;
      if (message.type === 'progress') progress(message.progress);
      else if (message.type === 'result') {
        awaitingAsr = false;
        asr.kill();
        void finish(message.revision);
      } else if (message.type === 'error') fail(new Error(message.message));
    });
    asr.once('exit', (code) => {
      if (awaitingAsr && !settled) fail(new Error(`Recording recognition stopped (${code})`));
    });
    asr.postMessage({ ...job, options: { ...job.options, translationModel: undefined } });
  });
  return { result, cancel() {
    if (!settled) { settled = true; rejectTranslation?.(new Error('Cancelled')); rejectPending(new Error('Cancelled')); }
    asr.kill();
    translation?.kill();
  } };
}
