import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { makeDefaults, type AppSettings, type ArchiveProofreadOptions, type ArchiveRecord, type ArchiveRefineProgress, type ArchiveRevision, type ModelInfo } from '@rt/core';
import {
  activeLineIndex, canProofread, canRefine, codexIssue, defaultRefineOptions, describeRevision, formatOffset, isProofreadOptions, lineSeek,
  proofreadOptions, readyAsrModels, readyTranslationModels, revisionOrdinal, validRefineOptions,
} from './archive-review';
import { useArchiveRefine } from './archive-refine';

const mac = { platform: 'macos' as const };
function model(kind: ModelInfo['kind'], id: string, downloaded = true): ModelInfo {
  return { kind, id, downloaded, sizeBytes: 1, inUse: false };
}
function prefs(patch: { asr?: Partial<AppSettings['asr']>; translation?: Partial<AppSettings['translation']>; nativeLang?: AppSettings['nativeLang'] } = {}): AppSettings {
  const base = makeDefaults([]);
  return {
    ...base,
    nativeLang: patch.nativeLang ?? 'zh',
    asr: { ...base.asr, language: 'auto', model: 'sense-voice', ...patch.asr },
    translation: { ...base.translation, enabled: true, engine: 'm2m100', targetLang: 'ja', ...patch.translation },
  };
}

describe('refine model choices only use downloaded local models', () => {
  it('filters recognition models by language, platform and readiness', () => {
    const models = [model('asr', 'sense-voice', false), model('asr', 'paraformer-zh')];
    expect(readyAsrModels(mac, models, 'zh').map((m) => m.id)).toEqual(['paraformer-zh']);
    expect(readyAsrModels(mac, models, 'auto')).toEqual([]);
    expect(readyAsrModels({ platform: 'ios' }, models, 'zh')).toEqual([]);
  });
  it('never offers cloud, undownloaded, platform-excluded or host-disabled translation', () => {
    const models = [model('translation', 'm2m100'), model('translation', 'hy-mt2-7b'), model('translation', 'm2m100-1.2b', false)];
    expect(readyTranslationModels(mac, models, 'ja').map((m) => m.id)).toEqual(['m2m100', 'hy-mt2-7b']);
    expect(readyTranslationModels({ platform: 'web' }, models, 'ja').map((m) => m.id)).toEqual(['m2m100']);
    expect(readyTranslationModels({ platform: 'web', localTranslationAvailable: false }, models, 'ja')).toEqual([]);
  });
});

describe('default refine options', () => {
  const ready = [model('asr', 'sense-voice'), model('asr', 'paraformer-zh'), model('translation', 'm2m100')];
  it('uses settings ASR, source language, target language and current local engine when ready', () => {
    expect(defaultRefineOptions(prefs(), mac, ready)).toEqual({ asrModel: 'sense-voice', language: 'auto', targetLang: 'ja', translationModel: 'm2m100' });
  });
  it('falls back to a ready compatible ASR model instead of downloading the configured one', () => {
    const options = defaultRefineOptions(prefs({ asr: { language: 'zh', model: 'sense-voice' } }), mac, [model('asr', 'sense-voice', false), model('asr', 'paraformer-zh')]);
    expect(options.asrModel).toBe('paraformer-zh');
  });
  it('leaves ASR empty and refuses submission when nothing compatible is downloaded', () => {
    const zhOnly = [model('asr', 'sense-voice', false), model('asr', 'paraformer-zh')];
    const options = defaultRefineOptions(prefs({ asr: { language: 'ja' } }), mac, zhOnly);
    expect(options.asrModel).toBe('');
    expect(validRefineOptions(options, mac, zhOnly)).toBeNull();
  });
  it('defaults to no translation for cloud, disabled, or undownloaded engines', () => {
    expect(defaultRefineOptions(prefs({ translation: { engine: 'cloud' } }), mac, ready).translationModel).toBeUndefined();
    expect(defaultRefineOptions(prefs({ translation: { enabled: false } }), mac, ready).translationModel).toBeUndefined();
    expect(defaultRefineOptions(prefs({ translation: { engine: 'hy-mt2-7b' } }), mac, ready).translationModel).toBeUndefined();
  });
  it('uses the interface language for legacy settings without a translation target', () => {
    expect(defaultRefineOptions(prefs({ nativeLang: 'ko', translation: { targetLang: undefined } }), mac, ready).targetLang).toBe('ko');
  });
  it('submits no translationModel key when not translating', () => {
    const valid = validRefineOptions({ asrModel: 'sense-voice', language: 'auto', targetLang: 'en' }, mac, ready);
    expect(valid).toEqual({ asrModel: 'sense-voice', language: 'auto', targetLang: 'en' });
    expect(valid && 'translationModel' in valid).toBe(false);
    expect(validRefineOptions({ asrModel: 'sense-voice', language: 'auto', targetLang: 'en', translationModel: 'hy-mt2-7b' }, mac, ready)).toBeNull();
  });
});

describe('archive line playback mapping', () => {
  const record: Pick<ArchiveRecord, 'audio'> = {
    audio: [
      { id: 'a', source: 'system', format: 'wav', sampleRate: 16000, channels: 1, startedAt: 0, durationMs: 60000 },
      { id: 'b', source: 'mic', format: 'wav', sampleRate: 16000, channels: 1, startedAt: 0, durationMs: 60000 },
    ] as ArchiveRecord['audio'],
  };
  it('only seeks lines with a precise offset into a saved recording', () => {
    expect(lineSeek({ text: 'x', translation: '', time: '10:00:00' }, record)).toBeNull();
    expect(lineSeek({ text: 'x', translation: '', audio: { recordingId: 'gone', start: 1, duration: 1 } }, record)).toBeNull();
    expect(lineSeek({ text: 'x', translation: '', audio: { recordingId: 'a', start: -1, duration: 1 } }, record)).toBeNull();
    expect(lineSeek({ text: 'x', translation: '', audio: { recordingId: 'b', start: 4.5, duration: 1 } }, record)).toEqual({ recordingId: 'b', start: 4.5 });
    expect(lineSeek({ text: 'x', translation: '', audio: { recordingId: 'a', start: 1, duration: 1 } }, {})).toBeNull();
  });
  it('matches the playing line within its own recording origin', () => {
    const lines = [
      { text: '1', translation: '', audio: { recordingId: 'a', start: 0, duration: 3 } },
      { text: '2', translation: '' },
      { text: '3', translation: '', audio: { recordingId: 'b', start: 0, duration: 3 } },
    ];
    expect(activeLineIndex(lines, 'b', 1)).toBe(2);
    expect(activeLineIndex(lines, 'a', 1)).toBe(0);
    expect(activeLineIndex(lines, 'a', 3)).toBe(-1);
  });
  it('reports which archives can be refined', () => {
    expect(canRefine(record, true)).toBe('yes');
    expect(canRefine({}, true)).toBe('no-audio');
    expect(canRefine(record, false)).toBe('unsupported');
    expect(formatOffset(65)).toBe('1:05');
    expect(formatOffset(3725)).toBe('1:02:05');
  });
});

describe('codex proofreading choices', () => {
  const local = { asrModel: 'sense-voice', language: 'auto' as const, targetLang: 'en' as const };
  const revisions: ArchiveRevision[] = [
    { id: 'r1', createdAt: 0, options: local, lines: [] },
    { id: 'c1', createdAt: 1, options: { kind: 'codex', targetLang: 'ja' }, codex: { model: 'gpt-5-codex' },
      lines: [
        { text: 'a', translation: '', review: { needsReview: true, note: 'name unclear' } },
        { text: 'b', translation: '', review: { needsReview: false, note: '', originalText: 'bb' } },
        { text: 'c', translation: '' },
      ] },
    { id: 'c2', createdAt: 2, options: { kind: 'codex', targetLang: 'zh', sourceRevisionId: 'r1' }, lines: [] },
    { id: 'c3', createdAt: 3, options: { kind: 'codex', targetLang: 'zh', sourceRevisionId: 'gone' }, lines: [] },
  ];

  it('sends the selected version as source and omits it for the live transcript', () => {
    expect(proofreadOptions('live', 'ja')).toEqual({ kind: 'codex', targetLang: 'ja' });
    expect('sourceRevisionId' in proofreadOptions('live', 'ja')).toBe(false);
    expect(proofreadOptions('r1', 'ko')).toEqual({ kind: 'codex', targetLang: 'ko', sourceRevisionId: 'r1' });
  });

  it('only offers the entry on hosts exposing both proofreading and status checks', () => {
    expect(canProofread({ proofreadArchive: vi.fn(), getCodexStatus: vi.fn() })).toBe(true);
    expect(canProofread({ proofreadArchive: vi.fn() })).toBe(false);
    expect(canProofread({})).toBe(false);
  });

  it('turns status into actionable issues without any fallback', () => {
    expect(codexIssue({ available: false, authenticated: false, model: '' })).toBe('missing');
    expect(codexIssue({ available: true, authenticated: false, model: '' })).toBe('login');
    expect(codexIssue({ available: true, authenticated: true, model: 'gpt-5-codex' })).toBeNull();
  });

  it('describes legacy local revisions and Codex revisions from the same list', () => {
    expect(isProofreadOptions(local)).toBe(false);
    expect(describeRevision(revisions[0], revisions)).toEqual({ kind: 'local', asrModel: 'sense-voice', language: 'auto', targetLang: 'en' });
    expect(describeRevision(revisions[1], revisions)).toEqual({ kind: 'codex', model: 'gpt-5-codex', targetLang: 'ja', source: 'live', needsReview: 1 });
    expect(describeRevision(revisions[2], revisions)).toMatchObject({ source: 'r1', model: undefined });
    expect(describeRevision(revisions[3], revisions)).toMatchObject({ source: 'unknown' });
    expect(revisionOrdinal(revisions, 'r1')).toEqual({ kind: 'local', n: 1 });
    expect(revisionOrdinal(revisions, 'c2')).toEqual({ kind: 'codex', n: 2 });
  });
});

describe('archive refine run state', () => {
  const options = { asrModel: 'sense-voice', language: 'auto' as const, targetLang: 'en' as const };
  function setup(
    refineArchive: (id: string, o: typeof options) => Promise<ArchiveRecord>,
    proofreadArchive?: (id: string, o: ArchiveProofreadOptions) => Promise<ArchiveRecord>,
  ) {
    let emit: ((p: ArchiveRefineProgress) => void) | undefined;
    const off = vi.fn();
    const host = {
      refineArchive, proofreadArchive, getArchive: vi.fn(),
      cancelArchiveRefinement: vi.fn(async () => undefined),
      onArchiveRefineProgress: vi.fn((cb: (p: ArchiveRefineProgress) => void) => { emit = cb; return off; }),
    };
    const onRecord = vi.fn();
    const scope = effectScope();
    const state = scope.run(() => useArchiveRefine(host, () => 'mine', onRecord))!;
    return { host, off, onRecord, scope, state, emit: (p: Partial<ArchiveRefineProgress>) => emit!({ archiveId: 'mine', state: 'transcribing', completed: 0, total: 0, ...p }) };
  }

  it('tracks only its own archive, blocks cancel while saving, and unsubscribes', async () => {
    let resolve!: (r: ArchiveRecord) => void;
    const t = setup(vi.fn(() => new Promise<ArchiveRecord>((r) => { resolve = r; })));
    void t.state.start(options);
    t.emit({ archiveId: 'other', state: 'translating', completed: 9, total: 9 });
    expect(t.state.phase.value).toBe('transcribing');
    t.emit({ state: 'translating', completed: 1, total: 4 });
    expect(t.state.percent.value).toBe(25);
    expect(t.state.canCancel.value).toBe(true);
    t.emit({ state: 'saving', completed: 4, total: 4 });
    expect(t.state.canCancel.value).toBe(false);
    const saved = { id: 'mine', revisions: [{ id: 'r1' }] } as ArchiveRecord;
    resolve(saved);
    await vi.waitFor(() => expect(t.state.phase.value).toBe('done'));
    expect(t.onRecord).toHaveBeenCalledWith(saved);
    t.scope.stop();
    expect(t.off).toHaveBeenCalledOnce();
  });

  it('reports cancellation without touching the record', async () => {
    let reject!: (e: Error) => void;
    const t = setup(vi.fn(() => new Promise<ArchiveRecord>((_, r) => { reject = r; })));
    void t.state.start(options);
    await t.state.cancel();
    expect(t.host.cancelArchiveRefinement).toHaveBeenCalledWith('mine');
    reject(new Error('cancelled'));
    await vi.waitFor(() => expect(t.state.phase.value).toBe('cancelled'));
    expect(t.onRecord).not.toHaveBeenCalled();
  });

  it('shows errors and retries with the same options', async () => {
    const refine = vi.fn().mockRejectedValueOnce(new Error('decoder failed')).mockResolvedValueOnce({ id: 'mine' });
    const t = setup(refine);
    await t.state.start(options);
    expect(t.state.phase.value).toBe('error');
    expect(t.state.error.value).toBe('decoder failed');
    await t.state.retry();
    expect(refine).toHaveBeenNthCalledWith(2, 'mine', options);
    expect(t.state.phase.value).toBe('done');
  });

  it('routes Codex tasks to proofreading, shares cancel, and resends the same request on retry', async () => {
    const refine = vi.fn();
    const proofread = vi.fn()
      .mockRejectedValueOnce(new Error('Codex usage limit reached'))
      .mockResolvedValueOnce({ id: 'mine', revisions: [{ id: 'c1' }] });
    const t = setup(refine, proofread);
    const request = { kind: 'codex' as const, targetLang: 'ja' as const, sourceRevisionId: 'r1' };
    const first = t.state.start(request);
    expect(t.state.phase.value).toBe('proofreading');
    expect(t.state.kind.value).toBe('codex');
    expect(t.state.canCancel.value).toBe(true);
    await first;
    expect(refine).not.toHaveBeenCalled();
    expect(t.state.phase.value).toBe('error');
    expect(t.state.error.value).toBe('Codex usage limit reached');
    expect(t.onRecord).not.toHaveBeenCalled();
    await t.state.retry();
    expect(proofread).toHaveBeenNthCalledWith(2, 'mine', request);
    expect(t.state.phase.value).toBe('done');
  });

  it('cancels a Codex task without saving anything', async () => {
    let reject!: (e: Error) => void;
    const t = setup(vi.fn(), vi.fn(() => new Promise<ArchiveRecord>((_, r) => { reject = r; })));
    void t.state.start({ kind: 'codex', targetLang: 'en' });
    t.emit({ state: 'proofreading', completed: 3, total: 10 });
    expect(t.state.percent.value).toBe(30);
    await t.state.cancel();
    reject(new Error('cancelled'));
    await vi.waitFor(() => expect(t.state.phase.value).toBe('cancelled'));
    expect(t.onRecord).not.toHaveBeenCalled();
  });

  it('labels an observed run as Codex from its progress', () => {
    const t = setup(vi.fn());
    t.emit({ state: 'proofreading', completed: 1, total: 2 });
    expect(t.state.running.value).toBe(true);
    expect(t.state.kind.value).toBe('codex');
  });

  it('picks up a run started elsewhere and reloads the record when it finishes', async () => {
    const t = setup(vi.fn());
    t.host.getArchive.mockResolvedValue({ id: 'mine' });
    t.emit({ state: 'transcribing', completed: 2, total: 5 });
    expect(t.state.running.value).toBe(true);
    t.emit({ state: 'done', completed: 5, total: 5 });
    await nextTick();
    await vi.waitFor(() => expect(t.onRecord).toHaveBeenCalledWith({ id: 'mine' }));
  });
});
