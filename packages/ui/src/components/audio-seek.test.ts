import { describe, expect, it, vi } from 'vitest';
import { createSeeker, type SeekTrack } from './audio-seek';

// Minimal media element: counts listeners so stale waits can be proven cleaned up.
class FakeMedia extends EventTarget {
  readyState = 0;
  duration = Number.NaN;
  currentTime = 0;
  preload = 'none';
  listeners = 0;
  loads = 0;
  play = vi.fn(async () => undefined);
  load(): void { this.loads++; }
  addEventListener(...args: Parameters<EventTarget['addEventListener']>): void { this.listeners++; super.addEventListener(...args); }
  removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void { this.listeners--; super.removeEventListener(...args); }
  metadataReady(duration = 60): void { this.readyState = 1; this.duration = duration; this.dispatchEvent(new Event('loadedmetadata')); }
}

function setup(states: Record<string, SeekTrack> = { a: { state: 'ready' }, b: { state: 'ready' } }) {
  const media: Record<string, FakeMedia> = { a: new FakeMedia(), b: new FakeMedia() };
  const failed = vi.fn((track: SeekTrack) => { track.state = 'failed'; });
  const seeker = createSeeker({
    track: (id) => states[id],
    element: (id) => media[id] as unknown as HTMLMediaElement,
    tick: async () => undefined,
    failed,
  });
  return { seeker, media, states, failed };
}

describe('archive audio seek', () => {
  it('lets the latest click win before metadata arrives and removes stale listeners', async () => {
    const { seeker, media: { a, b } } = setup();
    const first = seeker.seek('a', 5);
    await vi.waitFor(() => expect(a.loads).toBe(1));
    const second = seeker.seek('a', 12);
    await vi.waitFor(() => expect(a.loads).toBe(2));
    const third = seeker.seek('b', 3);
    await vi.waitFor(() => expect(b.loads).toBe(1));
    expect(await first).toBe('cancelled');
    expect(await second).toBe('cancelled');
    expect(a.listeners).toBe(0);
    a.metadataReady();
    b.metadataReady();
    expect(await third).toBe('playing');
    expect(a.play).not.toHaveBeenCalled();
    expect(a.currentTime).toBe(0);
    expect(b.currentTime).toBe(3);
    expect(b.listeners).toBe(0);
  });

  it('rejects non-finite offsets without loading or playing', async () => {
    const { seeker, media: { a } } = setup();
    expect(await seeker.seek('a', NaN)).toBe('failed');
    expect(await seeker.seek('a', Infinity)).toBe('failed');
    expect(a.loads).toBe(0);
    expect(a.play).not.toHaveBeenCalled();
  });

  it('seeks immediately once metadata is known and clamps to the recording length', async () => {
    const { seeker, media: { a } } = setup();
    a.readyState = 1; a.duration = 10;
    expect(await seeker.seek('a', 25)).toBe('playing');
    expect(a.loads).toBe(0);
    expect(a.currentTime).toBe(10);
  });

  it('settles pending waits on cancel (unmount or attachment switch), including a hanging URL lookup', async () => {
    const states: Record<string, SeekTrack> = { a: { state: 'loading', pending: new Promise(() => {}) }, b: { state: 'ready' } };
    const { seeker, media: { b } } = setup(states);
    const waitingUrl = seeker.seek('a', 1);
    seeker.cancel();
    expect(await waitingUrl).toBe('cancelled');
    const waitingMeta = seeker.seek('b', 1);
    await vi.waitFor(() => expect(b.loads).toBe(1));
    seeker.cancel();
    expect(await waitingMeta).toBe('cancelled');
    expect(b.listeners).toBe(0);
    expect(b.play).not.toHaveBeenCalled();
  });

  it('continues after the URL resolves, and reports a failed lookup without waiting', async () => {
    let resolve!: () => void;
    const states: Record<string, SeekTrack> = { a: { state: 'loading', pending: new Promise<void>((r) => { resolve = r; }) }, b: { state: 'failed' } };
    const { seeker, media: { a } } = setup(states);
    a.readyState = 1; a.duration = 60;
    const pending = seeker.seek('a', 4);
    states.a.state = 'ready';
    resolve();
    expect(await pending).toBe('playing');
    expect(a.currentTime).toBe(4);
    expect(await seeker.seek('b', 1)).toBe('failed');
    expect(await seeker.seek('missing', 1)).toBe('failed');
  });

  it('surfaces blocked playback and media errors cleanly', async () => {
    const { seeker, media: { a, b }, states, failed } = setup();
    a.play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    const blocked = seeker.seek('a', 1);
    await vi.waitFor(() => expect(a.loads).toBe(1));
    a.metadataReady();
    expect(await blocked).toBe('blocked');
    expect(states.a.blocked).toBe(true);
    expect(failed).not.toHaveBeenCalled();
    const broken = seeker.seek('b', 1);
    await vi.waitFor(() => expect(b.loads).toBe(1));
    b.dispatchEvent(new Event('error'));
    expect(await broken).toBe('failed');
    expect(states.b.state).toBe('failed');
    expect(b.listeners).toBe(0);
    // A later successful seek clears the blocked hint on that track.
    a.play.mockResolvedValueOnce(undefined);
    expect(await seeker.seek('a', 2)).toBe('playing');
    expect(states.a.blocked).toBe(false);
  });
});
