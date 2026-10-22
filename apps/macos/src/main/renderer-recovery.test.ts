import { describe, expect, it, vi } from 'vitest';
import { createRendererRecovery } from './renderer-recovery';

function setup() {
  const options = {
    isQuitting: vi.fn(() => false), isDestroyed: vi.fn(() => false),
    stopSession: vi.fn(), flushRecovery: vi.fn(async () => {}), reload: vi.fn(),
    reportFailure: vi.fn(), log: vi.fn(), now: vi.fn(() => 0),
  };
  return { options, recovery: createRendererRecovery(options) };
}

describe('renderer recovery', () => {
  it('releases the audio session and persists drafts before reloading', async () => {
    const { options, recovery } = setup();
    let finish!: () => void;
    options.flushRecovery.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = recovery.handle();
    expect(options.stopSession).toHaveBeenCalledOnce();
    expect(options.reload).not.toHaveBeenCalled();
    expect(recovery.handle()).toBe(pending);
    finish();
    await pending;
    expect(options.reload).toHaveBeenCalledOnce();
  });

  it.each(['isQuitting', 'isDestroyed'] as const)('ignores a crash during %s', async (key) => {
    const { options, recovery } = setup();
    options[key].mockReturnValue(true);
    await recovery.handle();
    expect(options.stopSession).not.toHaveBeenCalled();
    expect(options.reload).not.toHaveBeenCalled();
  });

  it('does not reload after shutdown starts while recovery is flushing', async () => {
    const { options, recovery } = setup();
    const pending = recovery.handle();
    options.isQuitting.mockReturnValue(true);
    await pending;
    expect(options.reload).not.toHaveBeenCalled();
  });

  it('caps repeated crashes while allowing a later independent recovery', async () => {
    const { options, recovery } = setup();
    await recovery.handle();
    await recovery.handle();
    await recovery.handle();
    expect(options.reload).toHaveBeenCalledTimes(2);
    expect(options.reportFailure).toHaveBeenCalledOnce();
    options.now.mockReturnValue(60_001);
    await recovery.handle();
    expect(options.reload).toHaveBeenCalledTimes(3);
  });

  it('still offers the persisted draft after a flush error', async () => {
    const { options, recovery } = setup();
    options.flushRecovery.mockRejectedValue(new Error('disk unavailable'));
    await recovery.handle();
    expect(options.log).toHaveBeenCalledOnce();
    expect(options.reload).toHaveBeenCalledOnce();
  });
});
