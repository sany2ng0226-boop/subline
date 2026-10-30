import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AudioAttachment, ArchiveLine } from '@rt/core';

const profile = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => profile.dir } }));
let archives: typeof import('./archives');
beforeEach(async () => {
  vi.resetModules();
  profile.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subline-archive-audio-'));
  archives = await import('./archives');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(profile.dir, { recursive: true, force: true }); });
const attachment: AudioAttachment = { id: 'audio-fixture', source: 'mic', format: 'wav',
  sampleRate: 16000, channels: 1, durationMs: 6000, startedAt: 123, bytes: 192044 };
const lines: ArchiveLine[] = [{ time: '10:00:02', text: '授業', translation: '课堂',
  audio: { recordingId: attachment.id, start: 2.25, duration: 1.5 } }];

it('preserves old records without invented audio and round trips new synchronized attachments', async () => {
  const legacy = { id: 'old', name: 'old class', createdAt: 1, lines: [{ text: '旧', translation: '' }] };
  fs.writeFileSync(path.join(profile.dir, 'archives.json'), JSON.stringify([legacy]));
  expect(archives.getArchive('old')).toEqual(legacy);
  const summaries = await archives.saveArchive('new class', lines, 2, undefined, [attachment]);
  const id = summaries.find(row => row.name === 'new class')!.id;
  vi.resetModules();
  const reopened = await import('./archives');
  expect(reopened.getArchive('old')).toEqual(legacy);
  expect(reopened.getArchive(id)).toEqual(expect.objectContaining({ lines, audio: [attachment] }));
  expect(reopened.archivedRecordingIds()).toEqual(new Set([attachment.id]));
  await reopened.deleteArchive(id);
  expect(reopened.archivedRecordingIds().size).toBe(0);
  expect(reopened.getArchive('old')).toEqual(legacy);
});

it('keeps the last durable archive and attachment references when atomic replacement fails', async () => {
  await archives.saveArchive('saved', lines, 3, undefined, [attachment]);
  const original = fs.readFileSync(path.join(profile.dir, 'archives.json'), 'utf8');
  vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(archives.saveArchive('failed', [], 4, undefined, [{ ...attachment, id: 'unsaved' }]))
    .rejects.toThrow('disk unavailable');
  expect(fs.readFileSync(path.join(profile.dir, 'archives.json'), 'utf8')).toBe(original);
  expect(archives.listArchives().map(row => row.name)).toEqual(['saved']);
  expect(archives.archivedRecordingIds()).toEqual(new Set([attachment.id]));
});
