import { describe, expect, it, vi } from 'vitest';
import type { ArchiveRecord, ArchiveRefineOptions, ArchiveRefineProgress, ArchiveRevision } from '@rt/core';
import { ArchiveRefinementManager, validateRefinementOptions } from './archive-refinement';
import type { RefinementJob } from './offline-refinement';

const options: ArchiveRefineOptions = { asrModel: 'sense-voice', language: 'ja', targetLang: 'zh' };
const job: RefinementJob = { archiveId: 'archive', options, recordings: [], modelsDir: '/models', cacheDir: '/cache' };
const original: ArchiveRecord = { id: 'archive', name: 'Original', createdAt: 1,
  lines: [{ text: 'live original', translation: '实时原稿' }] };
const revision: ArchiveRevision = { id: 'revision', createdAt: 2, options, lines: [{ text: 'reviewed', translation: '录后结果' }] };
function fixture() {
  const progress: ArchiveRefineProgress[] = [];
  let resolve!: (value: ArchiveRevision) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<ArchiveRevision>((yes, no) => { resolve = yes; reject = no; });
  const cancel = vi.fn(() => reject(new Error('Cancelled')));
  const save = vi.fn(async (): Promise<ArchiveRecord> => ({ ...original, revisions: [revision] }));
  const prepare = vi.fn(async () => job);
  const manager = new ArchiveRefinementManager({ prepare,
    start: () => ({ result, cancel }), save, progress: (value) => progress.push(value) });
  return { manager, progress, save, prepare, resolve, reject, cancel };
}

describe('archive refinement lifecycle', () => {
  it('keeps the original intact and saves a completed revision only once', async () => {
    const f = fixture();
    const pending = f.manager.run('archive', options);
    await vi.waitFor(() => expect(f.manager.busy).toBe(true));
    f.resolve(revision);
    const saved = await pending;
    expect(saved.lines).toEqual(original.lines);
    expect(saved.revisions).toEqual([revision]);
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.progress.map(p => p.state)).toEqual(['saving', 'done']);
    expect(f.manager.busy).toBe(false);
  });
  it('rejects parallel jobs and prevents cancellation from saving a partial result', async () => {
    const f = fixture();
    const pending = f.manager.run('archive', options);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    await expect(f.manager.run('another', options)).rejects.toThrow('already running');
    f.manager.cancel('archive');
    await expect(pending).rejects.toThrow('Cancelled');
    expect(f.save).not.toHaveBeenCalled();
    expect(f.progress.at(-1)?.state).toBe('cancelled');
  });
  it('leaves the original untouched on native failure and permits retry', async () => {
    const f = fixture();
    const pending = f.manager.run('archive', options);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    f.reject(new Error('Native process failed'));
    await expect(pending).rejects.toThrow('Native process failed');
    expect(f.save).not.toHaveBeenCalled();
    expect(f.progress.at(-1)?.state).toBe('error');
    expect(f.manager.busy).toBe(false);
  });
  it('reports storage failure as failure instead of announcing a durable result', async () => {
    const f = fixture();
    f.save.mockRejectedValueOnce(new Error('Disk full'));
    const pending = f.manager.run('archive', options);
    f.resolve(revision);
    await expect(pending).rejects.toThrow('Disk full');
    expect(f.progress.map(p => p.state)).toEqual(['saving', 'error']);
  });
  it('uses the same lock for local refinement and Codex proofreading jobs', async () => {
    const f = fixture();
    const codex: ArchiveRevision = { ...revision, options: { kind: 'codex', targetLang: 'zh' }, codex: { model: 'gpt-6.1-sol' } };
    const pending = f.manager.runTask('archive', () => ({ result: f.manager.busy ? Promise.resolve(codex) : Promise.reject(new Error('Missing lock')), cancel: vi.fn() }));
    await expect(f.manager.run('another', options)).rejects.toThrow('already running');
    await pending;
    expect(f.save).toHaveBeenCalledWith('archive', codex);
    expect(f.manager.busy).toBe(false);
  });
  it('does not save or leave an unhandled worker after cancellation during preparation', async () => {
    const f = fixture();
    let finish!: (value: typeof job) => void;
    f.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.manager.run('archive', options);
    f.manager.cancel('archive');
    finish(job);
    await expect(pending).rejects.toThrow('Cancelled');
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.manager.busy).toBe(false);
  });
  it('releases the shared lock when a custom job fails before returning a worker', async () => {
    const f = fixture();
    await expect(f.manager.runTask('archive', () => { throw new Error('Login unavailable'); })).rejects.toThrow('Login unavailable');
    expect(f.manager.busy).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.progress.at(-1)?.state).toBe('error');
  });
  it('keeps saving atomic by rejecting cancellation until persistence has finished', async () => {
    const f = fixture();
    let finish!: (value: ArchiveRecord) => void;
    f.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.manager.runTask('archive', () => ({ result: Promise.resolve(revision), cancel: vi.fn() }));
    await vi.waitFor(() => expect(f.progress.at(-1)?.state).toBe('saving'));
    expect(() => f.manager.cancel('archive')).toThrow('being saved');
    expect(f.manager.isActive('archive')).toBe(true);
    finish({ ...original, revisions: [revision] });
    await pending;
    expect(f.progress.at(-1)?.state).toBe('done');
    expect(f.manager.busy).toBe(false);
  });
  it('rejects unsupported source languages, cloud backends, and invalid targets', () => {
    expect(() => validateRefinementOptions({ ...options, asrModel: 'parakeet-tdt-0.6b-v2-en' })).toThrow('language');
    expect(() => validateRefinementOptions({ ...options, translationModel: 'cloud' as never })).toThrow('local');
    expect(() => validateRefinementOptions({ ...options, targetLang: 'xx' as never })).toThrow('target');
    expect(validateRefinementOptions({ ...options, translationModel: 'hy-mt2-7b' })).toEqual({ ...options, translationModel: 'hy-mt2-7b' });
  });
});
