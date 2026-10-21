import { describe, expect, it, vi } from 'vitest';
import { createGuardedRelaunch } from './guarded-relaunch';

describe('guarded relaunch', () => {
  it.each(['cancel', 'archive failed'])('does not restart when %s prevents leaving', async () => {
    const flush = vi.fn();
    const proceed = vi.fn();
    await createGuardedRelaunch({
      confirm: async () => false, flush, proceed,
    })();
    expect(flush).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
  });

  it('waits for archive/confirmation and recovery flush; coalesces concurrent requests', async () => {
    let confirm!: (ok: boolean) => void;
    const order: string[] = [];
    const request = createGuardedRelaunch({
      confirm: () => new Promise<boolean>((resolve) => { confirm = resolve; }),
      flush: async () => { order.push('flush'); },
      proceed: () => { order.push('relaunch'); order.push('exit'); },
    });
    const first = request();
    const second = request();
    expect(first).toBe(second);
    expect(order).toEqual([]);
    confirm(true);
    await first;
    expect(order).toEqual(['flush', 'relaunch', 'exit']);
  });

  it('does not restart on flush failure and permits retry', async () => {
    const proceed = vi.fn();
    const flush = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
    const request = createGuardedRelaunch({ confirm: async () => true, flush, proceed });
    await expect(request()).rejects.toThrow('disk');
    expect(proceed).not.toHaveBeenCalled();
    await request();
    expect(proceed).toHaveBeenCalledOnce();
  });
});
