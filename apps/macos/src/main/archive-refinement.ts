import { getAsrModel, getTranslationModel, type ArchiveRecord, type ArchiveRefineOptions,
  type ArchiveRefineProgress, type ArchiveRevision } from '@rt/core';
import type { RefinementJob } from './offline-refinement';

export function validateRefinementOptions(options: ArchiveRefineOptions): ArchiveRefineOptions {
  if (!options || typeof options !== 'object') throw new Error('Invalid refinement options');
  const asr = getAsrModel(options.asrModel);
  if (!asr?.platforms.includes('macos') || !asr.languages.includes(options.language)) {
    throw new Error('Recognition model does not support this language');
  }
  if (!['zh', 'ja', 'en', 'ko'].includes(options.targetLang)) throw new Error('Invalid translation target');
  const translation = options.translationModel === undefined ? undefined : getTranslationModel(options.translationModel);
  if (options.translationModel !== undefined && !translation?.platforms.includes('macos')) {
    throw new Error('Choose a supported local translation model');
  }
  return { asrModel: asr.id, language: options.language, targetLang: options.targetLang,
    ...(translation ? { translationModel: translation.id } : {}) };
}

interface WorkerHandle { result: Promise<ArchiveRevision>; cancel(): void }
interface Dependencies {
  prepare(id: string, options: ArchiveRefineOptions): Promise<RefinementJob>;
  start(job: RefinementJob, progress: (value: ArchiveRefineProgress) => void): WorkerHandle;
  save(id: string, revision: ArchiveRevision): Promise<ArchiveRecord>;
  progress(value: ArchiveRefineProgress): void;
}

/** One bounded job owns its worker; failed/cancelled output never reaches archive persistence. */
export class ArchiveRefinementManager {
  private active: { id: string; cancelled: boolean; saving: boolean; worker?: WorkerHandle } | null = null;
  constructor(private readonly deps: Dependencies) {}
  get busy(): boolean { return this.active !== null; }
  isActive(id: string): boolean { return this.active?.id === id; }

  async run(id: string, options: ArchiveRefineOptions): Promise<ArchiveRecord> {
    if (this.active) throw new Error('Another recording review is already running');
    const selected = validateRefinementOptions(options);
    const active = { id, cancelled: false, saving: false, worker: undefined as WorkerHandle | undefined };
    this.active = active;
    try {
      const job = await this.deps.prepare(id, selected);
      if (active.cancelled) throw new Error('Cancelled');
      active.worker = this.deps.start(job, (value) => {
        if (!active.cancelled && this.active === active) this.deps.progress({ ...value, archiveId: id });
      });
      const revision = await active.worker.result;
      if (active.cancelled) throw new Error('Cancelled');
      active.saving = true;
      this.deps.progress({ archiveId: id, state: 'saving', completed: 0, total: 1 });
      const saved = await this.deps.save(id, revision);
      this.deps.progress({ archiveId: id, state: 'done', completed: 1, total: 1 });
      return saved;
    } catch (error) {
      this.deps.progress({ archiveId: id, state: active.cancelled ? 'cancelled' : 'error',
        completed: 0, total: 1, ...(active.cancelled ? {} : { error: String(error) }) });
      throw error;
    } finally {
      active.worker?.cancel();
      if (this.active === active) this.active = null;
    }
  }

  cancel(id?: string): void {
    const active = this.active;
    if (!active || (id !== undefined && active.id !== id)) return;
    if (active.saving) throw new Error('The completed result is being saved');
    active.cancelled = true;
    active.worker?.cancel();
  }
}
