import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecoveryStore, MAX_RECOVERY_BYTES } from './recovery-store';

describe('recovery store', () => {
  let dir: string;
  let store: ReturnType<typeof createRecoveryStore>;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subline-recovery-'));
    store = createRecoveryStore(() => dir);
  });
  afterEach(async () => {
    await store.flush();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('round trips JSON across store instances and removes temporary files', async () => {
    expect(await store.loadRecovery()).toBeNull();
    await store.saveRecovery('{"text":"授業"}');
    expect(await createRecoveryStore(() => dir).loadRecovery()).toBe('{"text":"授業"}');
    expect(await fs.readdir(dir)).toEqual(['recovery.json']);
    await store.clearRecovery();
    await store.clearRecovery();
    expect(await store.loadRecovery()).toBeNull();
  });
  it('quarantines corrupt JSON and tolerates unreadable files', async () => {
    await fs.writeFile(path.join(dir, 'recovery.json'), '{broken');
    expect(await store.loadRecovery()).toBeNull();
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^recovery\.corrupt-\d+\.json$/);
    expect(await fs.readFile(path.join(dir, files[0]), 'utf8')).toBe('{broken');
    await fs.mkdir(path.join(dir, 'recovery.json'));
    expect(await store.loadRecovery()).toBeNull();
  });
  it('rejects invalid input and measures the size limit in UTF-8 bytes', async () => {
    await store.saveRecovery('null');
    await expect(store.saveRecovery('bad')).rejects.toThrow();
    await expect(store.saveRecovery('"' + '界'.repeat(Math.floor(MAX_RECOVERY_BYTES / 3) + 1) + '"')).rejects.toThrow('20 MiB');
    await expect(store.saveRecovery(42 as unknown as string)).rejects.toThrow();
    expect(await store.loadRecovery()).toBe('null');
  });
  it('writes the in-flight snapshot then only the newest pending snapshot, and flush waits', async () => {
    const rename = vi.spyOn(fs, 'rename');
    const first = store.saveRecovery('1');
    const second = store.saveRecovery('2');
    const third = store.saveRecovery('3');
    await store.flush();
    await Promise.all([first, second, third]);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(await store.loadRecovery()).toBe('3');
  });
  it('orders clear and load barriers against pending saves', async () => {
    const operations = [store.saveRecovery('1'), store.saveRecovery('2'), store.clearRecovery()];
    const read = store.loadRecovery();
    operations.push(store.saveRecovery('3'));
    expect(await read).toBeNull();
    await Promise.all(operations);
    expect(await store.loadRecovery()).toBe('3');
  });
  it('preserves the old snapshot on rename failure and accepts later writes', async () => {
    await store.saveRecovery('1');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk error'));
    await expect(store.saveRecovery('2')).rejects.toThrow('disk error');
    expect(await store.loadRecovery()).toBe('1');
    expect(await fs.readdir(dir)).toEqual(['recovery.json']);
    await store.saveRecovery('3');
    expect(await store.loadRecovery()).toBe('3');
  });
});
