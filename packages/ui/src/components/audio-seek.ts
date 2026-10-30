// 归档原音的「点行跳转」：最新一次点击生效。
// 每次 seek 先作废上一次（移除其元数据监听、结束其等待）；切换归档/附件或卸载时调用 cancel 同样作废，
// 不留悬空的异步状态。只在用户点击后才按需取元数据，不预取音频内容、不自动播放。

export type SeekResult = 'playing' | 'blocked' | 'failed' | 'cancelled';

/** 播放器里一段原音的当前状态（由播放器提供，seek 只读状态并回报失败/被拦截）。 */
export interface SeekTrack {
  state: 'loading' | 'ready' | 'failed' | 'unavailable';
  /** 取址进行中的 Promise（state 为 loading 时）。 */
  pending?: Promise<void>;
  blocked?: boolean;
}

export interface SeekHost {
  track(recordingId: string): SeekTrack | undefined;
  element(recordingId: string): HTMLMediaElement | undefined;
  /** 等待界面渲染出刚就绪的 <audio>。 */
  tick(): Promise<void>;
  failed(track: SeekTrack): void;
}

export function createSeeker(host: SeekHost) {
  let token = 0;
  let abort: (() => void) | null = null;

  function cancel(): void {
    token++;
    abort?.();
    abort = null;
  }

  /** 等待 task；被新的 seek / cancel 作废时提前以 'cancelled' 结束，并清理 task 注册的监听。 */
  function cancellable<T>(task: (onCleanup: (fn: () => void) => void) => Promise<T>): Promise<T | 'cancelled'> {
    const cleanups: (() => void)[] = [];
    return new Promise<T | 'cancelled'>((resolve) => {
      let settled = false;
      const finish = (value: T | 'cancelled'): void => {
        if (settled) return;
        settled = true;
        if (abort === stop) abort = null;
        for (const fn of cleanups.splice(0)) fn();
        resolve(value);
      };
      const stop = (): void => finish('cancelled');
      abort = stop;
      task((fn) => cleanups.push(fn)).then(finish, () => finish('cancelled'));
    });
  }

  function metadata(el: HTMLMediaElement): Promise<boolean | 'cancelled'> {
    if (el.readyState >= 1 /* HAVE_METADATA */) return Promise.resolve(true);
    return cancellable((onCleanup) => new Promise<boolean>((resolve) => {
      const ok = (): void => resolve(true);
      const bad = (): void => resolve(false);
      el.addEventListener('loadedmetadata', ok);
      el.addEventListener('error', bad);
      onCleanup(() => { el.removeEventListener('loadedmetadata', ok); el.removeEventListener('error', bad); });
      el.preload = 'metadata';
      el.load();
    }));
  }

  /** 从某段录音的 start 秒开始播放（各段以自身起点为 0）。 */
  async function seek(recordingId: string, start: number): Promise<SeekResult> {
    cancel();
    const mine = token;
    const stale = (): boolean => mine !== token;
    const track = host.track(recordingId);
    if (!track || !Number.isFinite(start)) return 'failed';
    track.blocked = false;
    if (track.state === 'loading' && track.pending) {
      const pending = track.pending;
      if (await cancellable(() => pending) === 'cancelled' || stale()) return 'cancelled';
    }
    if (track.state !== 'ready') return 'failed';
    await host.tick();
    if (stale()) return 'cancelled';
    const el = host.element(recordingId);
    if (!el) return 'failed';
    const loaded = await metadata(el);
    if (loaded === 'cancelled' || stale()) return 'cancelled';
    if (!loaded) { host.failed(track); return 'failed'; }
    const target = Math.max(0, start);
    try {
      el.currentTime = Number.isFinite(el.duration) ? Math.min(target, el.duration) : target;
      await el.play();
      return stale() ? 'cancelled' : 'playing';
    } catch (cause) {
      if (stale()) return 'cancelled';
      const name = (cause as { name?: string } | null)?.name;
      // 浏览器拦截播放：保留原生控件让用户手动播放；被新的加载打断不算失败；其余按加载失败处理，可重试。
      if (name === 'NotAllowedError') { track.blocked = true; return 'blocked'; }
      if (name === 'AbortError') return 'cancelled';
      host.failed(track);
      return 'failed';
    }
  }

  return { seek, cancel };
}
