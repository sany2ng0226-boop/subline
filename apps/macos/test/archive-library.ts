import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ArchiveLibraryStore } from '../src/main/archive-library';
import type { ArchiveRecord } from '@rt/core';

test('legacy records survive folder creation, rename, move, reload and concurrent updates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-library-'));
  try {
    const file = path.join(dir, 'archive-library.json');
    const legacy: ArchiveRecord[] = [{ id: 'old', name: '旧记录', createdAt: 1,
      lines: [{ time: '10:00', text: '原文', translation: '译文' }] }];
    const original = JSON.stringify(legacy);
    const store = new ArchiveLibraryStore(file);
    assert.equal((await store.decorate(legacy))[0].folderId, null);
    await assert.rejects(fs.access(file)); // Reading old data never writes a migration.
    const { folders } = await store.createFolder('设计');
    const id = folders[0].id;
    await Promise.all([store.update('old', { name: '包豪斯' }), store.update('old', { folderId: id })]);
    await store.remember(id);
    await store.renameFolder(id, '艺术与设计');
    const reloaded = new ArchiveLibraryStore(file);
    const record = (await reloaded.decorate(legacy))[0];
    assert.equal(record.name, '包豪斯');
    assert.equal(record.folderId, id);
    assert.deepEqual(record.lines, legacy[0].lines);
    assert.equal(JSON.stringify(legacy), original);
    assert.equal((await reloaded.library()).lastFolderId, id);
    await reloaded.update('old', { folderId: null });
    assert.equal((await reloaded.decorate(legacy))[0].folderId, null);
    await assert.rejects(reloaded.createFolder('艺术与设计'));
    await assert.rejects(reloaded.renameFolder(id, ' '));
    await assert.rejects(reloaded.update('old', { folderId: 'missing' }));
    assert.equal((await reloaded.library()).folders[0].name, '艺术与设计');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('corrupt metadata is preserved and writes fail without replacing it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-library-'));
  try {
    const file = path.join(dir, 'archive-library.json');
    await fs.writeFile(file, '{broken');
    const store = new ArchiveLibraryStore(file);
    await assert.rejects(store.library());
    await assert.rejects(store.createFolder('New'));
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
