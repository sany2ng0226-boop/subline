import { describe, expect, it, vi } from 'vitest';
import { createScreenWakeLock } from './screen-wake-lock';

function setup() {
  const events = new EventTarget();
  const visibility = Object.assign(events, { visibilityState: 'visible' as DocumentVisibilityState });
  const sentinel = { released: false, release: vi.fn(async () => {}) };
  const request = vi.fn(async (_type: 'screen') => sentinel);
  const warn = vi.fn();
  const lock = createScreenWakeLock({ request }, visibility, warn);
  const changeVisibility = (state: DocumentVisibilityState) => {
    visibility.visibilityState = state;
    events.dispatchEvent(new Event('visibilitychange'));
  };
  return { lock, sentinel, request, warn, changeVisibility, visibility };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('screen wake lock', () => {
  it('requests once during recording and releases on stop', async () => {
    const { lock, request, sentinel, changeVisibility } = setup();
    lock.start();
    lock.start();
    await flush();
    changeVisibility('visible');
    expect(request).toHaveBeenCalledExactlyOnceWith('screen');
    lock.stop();
    lock.stop();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    changeVisibility('visible');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reacquires an automatically released lock on returning visible', async () => {
    const { lock, request, sentinel, changeVisibility } = setup();
    lock.start();
    await flush();
    sentinel.released = true;
    changeVisibility('hidden');
    expect(request).toHaveBeenCalledTimes(1);
    changeVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    lock.stop();
  });

  it('waits until visible when recording starts hidden', async () => {
    const { lock, request, changeVisibility } = setup();
    changeVisibility('hidden');
    lock.start();
    expect(request).not.toHaveBeenCalled();
    changeVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    lock.stop();
  });

  it('releases late requests without replacing a newer session lock', async () => {
    const { lock, request, sentinel } = setup();
    let resolve!: (value: typeof sentinel) => void;
    request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    lock.start();
    lock.stop();
    lock.start();
    await flush();
    const stale = { released: false, release: vi.fn(async () => {}) };
    resolve(stale);
    await flush();
    expect(stale.release).toHaveBeenCalledTimes(1);
    expect(sentinel.release).not.toHaveBeenCalled();
    lock.stop();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('ignores unsupported APIs and logs request and release failures', async () => {
    const { visibility, request, warn, sentinel, lock } = setup();
    const unsupported = createScreenWakeLock(undefined, visibility, warn);
    unsupported.start();
    unsupported.stop();
    expect(warn).not.toHaveBeenCalled();
    request.mockRejectedValueOnce(new Error('denied'));
    lock.start();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    lock.start();
    await flush();
    sentinel.release.mockRejectedValueOnce(new Error('release failed'));
    lock.stop();
    await flush();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
