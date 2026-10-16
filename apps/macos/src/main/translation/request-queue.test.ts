import { afterEach, expect, it, vi } from 'vitest';
import { TranslationRequestQueue } from './request-queue';
afterEach(() => vi.useRealTimers());
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
it('runs one request at a time and preserves FIFO', async () => {
  const releases: Array<(s: string) => void> = [];
  const run = vi.fn(() => new Promise<string>(r => releases.push(r)));
  const q = new TranslationRequestQueue<number, string>(run);
  const a = q.submit(1), b = q.submit(2); await tick();
  expect(run.mock.calls).toHaveLength(1);
  releases.shift()!('one'); await tick();
  expect(run.mock.calls).toHaveLength(2);
  releases.shift()!('two'); expect(await a).toBe('one'); expect(await b).toBe('two');
});
it('evicts oldest waiting request, never active work, when full', async () => {
  let release!: (s: string) => void;
  const q = new TranslationRequestQueue<number,string>(() => new Promise(r => { release = r; }), 1);
  const a=q.submit(1); const b=q.submit(2).catch(e=>e.message); const c=q.submit(3); await tick();
  expect(await b).toContain('积压'); release('a'); await tick(); release('c');
  expect(await a).toBe('a');expect(await c).toBe('c');
});
it('expires waiting requests without dispatching them', async () => {
  vi.useFakeTimers(); let release!: (s: string) => void;
  const run=vi.fn(() => new Promise<string>(r=>{release=r;}));
  const q=new TranslationRequestQueue<number,string>(run);const a=q.submit(1);const b=q.submit(2).catch(e=>e.message);
  await tick();await vi.advanceTimersByTimeAsync(15000);expect(await b).toContain('等待');
  release('a'); await a;await tick();expect(run).toHaveBeenCalledTimes(1);
});
it('cancels queued work and recovers after a synchronous transport failure', async () => {
  const run=vi.fn().mockImplementationOnce(()=>{throw new Error('IPC closed');}).mockResolvedValue('ok');
  const q=new TranslationRequestQueue<number,string>(run);const a=q.submit(1).catch(e=>e.message);const b=q.submit(2).catch(e=>e.message);
  q.cancelWaiting();expect(await b).toContain('配置');expect(await a).toBe('IPC closed');await tick();expect(await q.submit(3)).toBe('ok');
});
