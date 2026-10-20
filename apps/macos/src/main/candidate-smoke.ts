import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

function loaded(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.webContents.once('did-finish-load', () => resolve());
    window.webContents.once('did-fail-load', (_event, code, reason) => reject(new Error(`${code}: ${reason}`)));
  });
}

/** CI runs against a newly created temporary profile, never the user's settings or recordings. */
export async function runCandidateSmoke(window: BrowserWindow, profile: string, reportFile: string): Promise<boolean> {
  let report: Record<string, unknown>;
  try {
    await loaded(window);
    const saved = await window.webContents.executeJavaScript(`(async () => {
      const api = window.api;
      const settings = await api.getSettings();
      await api.saveSettings({ ...settings, onboarded: true, audioSource: 'system',
        translation: { ...settings.translation, enabled: false } });
      const library = await api.createArchiveFolder('Windows smoke');
      const folderId = library.folders[0].id;
      const archives = await api.saveArchive('Synthetic Windows smoke',
        [{ time: '00:00:01', text: 'これは動作確認です。', translation: '这是功能检查。' }], folderId);
      return { id: archives[0].id, folderId, platform: api.platform, sources: api.audioSources };
    })()`);
    assert.equal(saved.platform, 'windows');
    assert.deepEqual(saved.sources, ['system', 'mic']);
    window.webContents.reload();
    await loaded(window);
    const read = await window.webContents.executeJavaScript(`(async () => {
      const api = window.api;
      return { settings: await api.getSettings(), archives: await api.listArchives(),
        library: await api.getArchiveLibrary(), archive: await api.getArchive(${JSON.stringify(saved.id)}),
        models: await api.listModels(), rendered: document.body.innerText.length > 0 };
    })()`);
    assert.equal(read.settings.audioSource, 'system');
    assert.equal(read.archives.length, 1);
    assert.equal(read.archive.folderId, saved.folderId);
    assert.equal(read.archive.lines[0].translation, '这是功能检查。');
    assert.equal(read.library.folders.length, 1);
    assert.ok(read.models.some((model: { id: string }) => model.id === 'sense-voice'));
    assert.ok(read.models.some((model: { id: string }) => model.id === 'hy-mt2-7b'));
    assert.equal(read.rendered, true);
    const diskSettings = JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8'));
    const diskArchives = JSON.parse(await fs.readFile(path.join(profile, 'archives.json'), 'utf8'));
    const diskLibrary = JSON.parse(await fs.readFile(path.join(profile, 'archive-library.json'), 'utf8'));
    assert.equal(diskSettings.audioSource, 'system');
    assert.equal(diskArchives[0].id, saved.id);
    assert.equal(diskLibrary.folders[0].id, saved.folderId);
    report = { status: 'passed', platform: process.platform, checks: [
      'packaged-window-and-preload', 'windows-audio-source-options', 'settings-ipc-and-disk',
      'archive-ipc-and-disk', 'archive-folder-metadata', 'renderer-reload-readback', 'windows-model-registry',
    ], realAudioAndCudaTested: false };
  } catch (error) {
    report = { status: 'failed', error: error instanceof Error ? error.stack : String(error) };
  }
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  return report.status === 'passed';
}
