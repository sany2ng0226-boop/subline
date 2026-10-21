import { describe, expect, it, vi } from 'vitest';
import { createDisplaySleepBlocker } from '../src/main/display-sleep';

describe('display sleep blocker', () => {
  it('owns one blocker, including ID zero, and releases only once', () => {
    const blocker = { start: vi.fn().mockReturnValue(0), stop: vi.fn() };
    const sleep = createDisplaySleepBlocker(blocker);
    sleep.stop();
    expect(blocker.stop).not.toHaveBeenCalled();
    sleep.start();
    sleep.start();
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith('prevent-display-sleep');
    sleep.stop();
    sleep.stop();
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
    blocker.start.mockReturnValue(42);
    sleep.start();
    sleep.stop();
    expect(blocker.stop).toHaveBeenLastCalledWith(42);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
