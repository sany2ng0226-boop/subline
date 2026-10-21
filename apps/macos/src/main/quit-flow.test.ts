import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQuitFlow, setupSingleInstance } from './quit-flow';

afterEach(() => vi.useRealTimers());

describe('quit flow', () => {
  function setup() {
    vi.useFakeTimers();
    const options = {
      hasUnsavedContent: () => true,
      confirmLeave: vi.fn(async () => true),
      cleanup: vi.fn(), quit: vi.fn(), exit: vi.fn(),
    };
    return { options, flow: createQuitFlow(options), event: { preventDefault: vi.fn() } };
  }
  it.each(['command-Q', 'window close'])('confirmation from %s cleans up and quits once', async () => {
    const { options, flow, event } = setup();
    flow.handle(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(options.cleanup).toHaveBeenCalledOnce();
    expect(options.quit).toHaveBeenCalledOnce();
    // Electron's fresh before-quit and close events must pass through.
    const resumed = { preventDefault: vi.fn() };
    flow.handle(resumed);
    flow.handle(resumed);
    flow.windowsClosed();
    expect(resumed.preventDefault).not.toHaveBeenCalled();
    expect(options.quit).toHaveBeenCalledOnce();
    expect(options.cleanup.mock.invocationCallOrder[0]).toBeLessThan(options.quit.mock.invocationCallOrder[0]!);
  });
  it('cancel keeps running and allows another prompt', async () => {
    const { options, flow, event } = setup();
    options.confirmLeave.mockResolvedValue(false);
    flow.handle(event);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(options.quit).not.toHaveBeenCalled();
    expect(options.cleanup).not.toHaveBeenCalled();
    expect(options.exit).not.toHaveBeenCalled();
    flow.handle(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(options.confirmLeave).toHaveBeenCalledTimes(2);
  });
  it('double command-Q and close share one dialog and one quit', async () => {
    const { options, flow, event } = setup();
    let resolve!: (ok: boolean) => void;
    options.confirmLeave.mockImplementation(() => new Promise((done) => { resolve = done; }));
    flow.handle(event);
    await Promise.resolve();
    flow.handle(event);
    flow.handle(event);
    expect(options.confirmLeave).toHaveBeenCalledOnce();
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(options.quit).toHaveBeenCalledOnce();
  });
  it('forces exit after three seconds if still alive', async () => {
    const { options, flow, event } = setup();
    flow.handle(event);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(options.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(options.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it('defers an unguarded quit until the cancelled event returns', async () => {
    const { options, event } = setup();
    const flow = createQuitFlow({ ...options, hasUnsavedContent: () => false });
    flow.handle(event);
    expect(options.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(options.confirmLeave).not.toHaveBeenCalled();
    expect(options.quit).toHaveBeenCalledOnce();
  });
});

describe('single instance', () => {
  function setup() {
    const window = { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    const options = {
      skip: false, requestLock: vi.fn(() => true), quit: vi.fn(),
      onSecondInstance: vi.fn<(callback: () => void) => void>(),
      whenReady: async () => {}, window: vi.fn(() => window), createWindow: vi.fn(),
    };
    return { window, options };
  }
  it('rejects another instance before creating a window', () => {
    const { options } = setup();
    options.requestLock.mockReturnValue(false);
    expect(setupSingleInstance(options)).toBe(false);
    expect(options.quit).toHaveBeenCalledOnce();
    expect(options.createWindow).not.toHaveBeenCalled();
    expect(options.onSecondInstance).not.toHaveBeenCalled();
  });
  it('skips locking isolated preview and smoke modes', () => {
    const { options } = setup();
    expect(setupSingleInstance({ ...options, skip: true })).toBe(true);
    expect(options.requestLock).not.toHaveBeenCalled();
  });
  it.each([false, true])('focuses second instance, recreating missing window: %s', async (missing) => {
    const { options, window } = setup();
    if (missing) options.window.mockReturnValueOnce(null as unknown as typeof window);
    setupSingleInstance(options);
    options.onSecondInstance.mock.calls[0]![0]();
    await Promise.resolve();
    expect(options.createWindow).toHaveBeenCalledTimes(missing ? 1 : 0);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
