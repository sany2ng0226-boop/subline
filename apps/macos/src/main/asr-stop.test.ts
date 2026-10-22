import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createAsrStopController } from './asr-stop';
import type { AsrToMain, MainToAsr } from '../shared/types';

class Child extends EventEmitter {
  postMessage = vi.fn<(message: MainToAsr) => void>();
  message(message: AsrToMain): void { this.emit('message', message); }
  flushId(): number {
    const message = this.postMessage.mock.calls.at(-1)![0];
    if (message.type !== 'flush') throw new Error('Expected flush');
    return message.requestId;
  }
}

afterEach(() => vi.useRealTimers());

it('waits for the final segment to be forwarded before completing stop', async () => {
  const child = new Child();
  const events: string[] = [];
  child.on('message', (message: AsrToMain) => {
    if (message.type === 'segment') events.push(message.payload.text);
  });
  const stop = createAsrStopController().stop(child).then(() => events.push('stopped'));
  await Promise.resolve();
  expect(events).toEqual([]);
  child.message({ type: 'segment', payload: { id: 1, text: 'final sentence', start: 0, duration: 1, lang: 'en' } });
  expect(events).toEqual(['final sentence']);
  child.message({ type: 'flushed', requestId: child.flushId() });
  await stop;
  expect(events).toEqual(['final sentence', 'stopped']);
  expect(child.listenerCount('exit')).toBe(0);
});

it('coalesces concurrent stops and ignores acknowledgements from earlier requests', async () => {
  const child = new Child();
  const controller = createAsrStopController();
  const first = controller.stop(child);
  expect(controller.stop(child)).toBe(first);
  const firstId = child.flushId();
  child.message({ type: 'flushed', requestId: firstId });
  await first;
  const done = vi.fn();
  const second = controller.stop(child).then(done);
  child.message({ type: 'flushed', requestId: firstId });
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  child.message({ type: 'flushed', requestId: child.flushId() });
  await second;
  expect(done).toHaveBeenCalledOnce();
});

it('rejects on worker exit instead of claiming that the tail was saved', async () => {
  const child = new Child();
  const stop = createAsrStopController().stop(child);
  child.emit('exit', 1);
  await expect(stop).rejects.toThrow('ASR exited before finishing');
  expect(child.listenerCount('message')).toBe(0);
});

it('rejects flush errors and allows a later retry', async () => {
  const child = new Child();
  const controller = createAsrStopController();
  const stop = controller.stop(child);
  child.message({ type: 'error', message: 'decode failed' });
  await expect(stop).rejects.toThrow('decode failed');
  const retry = controller.stop(child);
  child.message({ type: 'flushed', requestId: child.flushId() });
  await expect(retry).resolves.toBeUndefined();
});

it('times out and removes listeners rather than hanging an archive request', async () => {
  vi.useFakeTimers();
  const child = new Child();
  const stop = createAsrStopController(100).stop(child);
  const rejected = expect(stop).rejects.toThrow('did not finish');
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(child.listenerCount('message')).toBe(0);
  expect(child.listenerCount('exit')).toBe(0);
});
