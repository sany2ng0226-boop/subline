import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLeaveSession } from './leave-session';
import { createRecoveryStore } from './recovery-store';

describe('leave session recovery', () => {
  let dir: string;
  let store: ReturnType<typeof createRecoveryStore>;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subline-leave-'));
    store = createRecoveryStore(() => dir);
    await store.saveRecovery('{"text":"授業"}');
  });
  afterEach(async () => {
    await store.flush();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('clears queued drafts before allowing discard and quit', async () => {
    const pending = store.saveRecovery('{"text":"latest"}');
    const archive = vi.fn();
    expect(await resolveLeaveSession(1, archive, store.clearRecovery)).toBe(true);
    await pending;
    expect(archive).not.toHaveBeenCalled();
    expect(await createRecoveryStore(() => dir).loadRecovery()).toBeNull();
  });

  it('clears recovery only after successful archive', async () => {
    expect(await resolveLeaveSession(0, async () => {
      expect(await store.loadRecovery()).not.toBeNull();
      return true;
    }, store.clearRecovery)).toBe(true);
    expect(await createRecoveryStore(() => dir).loadRecovery()).toBeNull();
  });

  it.each([0, 2])('preserves recovery on failed archive or cancel (%s)', async (response) => {
    const archive = vi.fn(async () => false);
    expect(await resolveLeaveSession(response, archive, store.clearRecovery)).toBe(false);
    expect(archive).toHaveBeenCalledTimes(response === 0 ? 1 : 0);
    expect(await store.loadRecovery()).not.toBeNull();
  });

  it('does not allow leaving when recovery cleanup fails', async () => {
    await expect(resolveLeaveSession(1, vi.fn(), async () => {
      throw new Error('disk error');
    })).rejects.toThrow('disk error');
    expect(await store.loadRecovery()).not.toBeNull();
  });
});
