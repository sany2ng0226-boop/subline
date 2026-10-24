import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ArchiveRevision } from '@rt/core';

const profile = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => profile.root } }));
beforeEach(async () => {
  vi.resetModules();
  profile.root = await fs.mkdtemp(path.join(os.tmpdir(), 'subline-revision-test-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(profile.root, { recursive: true, force: true });
});
const revision: ArchiveRevision = { id: 'test-revision', createdAt: 2000,
  options: { asrModel: 'sense-voice', language: 'ja', targetLang: 'zh' },
  lines: [{ text: '录后识别', translation: '', audio: { recordingId: 'saved-audio', start: 1.2, duration: 0.8 } }] };

it('persists separate revisions across restart without rewriting live transcript or recording attachments', async () => {
  let archives = await import('./archives');
  const original = [{ text: '实时原稿', translation: 'live original',
    audio: { recordingId: 'saved-audio', start: 1, duration: 1 } }];
  await archives.saveArchive('test', original, 1000, undefined, [{ id: 'saved-audio', source: 'mic',
    format: 'wav', sampleRate: 16000, channels: 1, durationMs: 3000, startedAt: 1000, bytes: 96044 }]);
  const id = archives.listArchives()[0].id;
  await archives.appendArchiveRevision(id, revision);
  vi.resetModules();
  archives = await import('./archives');
  expect(archives.getArchive(id)).toMatchObject({ lines: original, revisions: [revision], audio: [{ source: 'mic' }] });
  expect(archives.archivedRecordingIds().has('saved-audio')).toBe(true);
  await expect(archives.appendArchiveRevision(id, revision)).rejects.toThrow('Duplicate');
});

it('keeps durable original and cached record unchanged if saving the new version fails', async () => {
  const archives = await import('./archives');
  await archives.saveArchive('test', [{ text: 'keep', translation: '' }], 1000);
  const id = archives.listArchives()[0].id;
  const original = await fs.readFile(path.join(profile.root, 'archives.json'), 'utf8');
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Disk failure'));
  await expect(archives.appendArchiveRevision(id, revision)).rejects.toThrow('Disk failure');
  expect(archives.getArchive(id)?.revisions).toBeUndefined();
  expect(await fs.readFile(path.join(profile.root, 'archives.json'), 'utf8')).toBe(original);
});
