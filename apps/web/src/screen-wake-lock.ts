type ScreenLock = Pick<WakeLockSentinel, 'released' | 'release'>;
type WakeLockProvider = { request(type: 'screen'): Promise<ScreenLock> };
type Visibility = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

export function createScreenWakeLock(
  provider: WakeLockProvider | undefined,
  visibility: Visibility,
  warn: (error: unknown) => void = (error) => console.warn('[wake-lock]', error),
) {
  let recording = false;
  let generation = 0;
  let lock: ScreenLock | undefined;
  let pending: object | undefined;

  async function release(sentinel: ScreenLock): Promise<void> {
    try {
      await sentinel.release();
    } catch (error) {
      warn(error);
    }
  }

  async function acquire(): Promise<void> {
    if (!provider || !recording || visibility.visibilityState !== 'visible' || pending || (lock && !lock.released)) return;
    const token = {};
    const session = generation;
    pending = token;
    try {
      const sentinel = await provider.request('screen');
      // A request may finish after stop or after a newer recording has started.
      if (!recording || generation !== session || visibility.visibilityState !== 'visible') {
        await release(sentinel);
      } else {
        lock = sentinel;
      }
    } catch (error) {
      warn(error);
    } finally {
      if (pending === token) pending = undefined;
    }
  }

  function onVisibilityChange(): void {
    if (visibility.visibilityState === 'visible') void acquire();
  }

  return {
    start(): void {
      if (!recording) {
        recording = true;
        visibility.addEventListener('visibilitychange', onVisibilityChange);
      }
      void acquire();
    },
    stop(): void {
      recording = false;
      generation++;
      pending = undefined;
      visibility.removeEventListener('visibilitychange', onVisibilityChange);
      const sentinel = lock;
      lock = undefined;
      if (sentinel) void release(sentinel);
    },
  };
}
