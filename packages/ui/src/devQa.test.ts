import { afterEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { DevQaBridge } from '@rt/core';
import { configureDevQa, registerDevQaProvider, traceDevQa, transcriptQaSnapshot } from './devQa';

afterEach(() => configureDevQa());
function channel() {
  let request: (value: { requestId: number }) => void = () => {};
  const unsubscribe = vi.fn();
  const api: DevQaBridge = {
    onSnapshotRequest: cb => { request = cb; return unsubscribe; },
    reportSnapshot: vi.fn(), event: vi.fn(),
  };
  return { api, unsubscribe, request: (requestId: number) => request({ requestId }) };
}

it('does no diagnostic work when the host has not opted in', () => {
  configureDevQa();
  const read = vi.fn();
  const payload = vi.fn();
  const dispose = registerDevQaProvider('disabled', read);
  traceDevQa('ui:partial', payload);
  dispose();
  expect(read).not.toHaveBeenCalled();
  expect(payload).not.toHaveBeenCalled();
});

it('reads current providers after Vue updates and removes unmounted providers', async () => {
  const c = channel(); configureDevQa(c.api);
  let text = 'old';
  const dispose = registerDevQaProvider('test', () => ({ text }));
  c.request(17); text = 'new';
  await nextTick();
  expect(c.api.reportSnapshot).toHaveBeenCalledWith(17, {
    capturedAt: expect.any(Number), sections: { test: { text: 'new' } },
  });
  dispose(); c.request(18); await nextTick();
  expect(c.api.reportSnapshot).toHaveBeenLastCalledWith(18, {
    capturedAt: expect.any(Number), sections: {},
  });
});

it('cancels a stale snapshot callback when the host channel is replaced', async () => {
  const first = channel(); configureDevQa(first.api);
  first.request(1);
  const second = channel(); configureDevQa(second.api);
  await nextTick();
  expect(first.unsubscribe).toHaveBeenCalledOnce();
  expect(first.api.reportSnapshot).not.toHaveBeenCalled();
  second.request(2); await nextTick();
  expect(second.api.reportSnapshot).toHaveBeenCalledOnce();
});

it('contains provider and telemetry errors without breaking subtitle handling', async () => {
  const c = channel(); configureDevQa(c.api);
  const dispose = registerDevQaProvider('broken', () => { throw new Error('broken DOM'); });
  c.request(3); await nextTick();
  expect(c.api.reportSnapshot).toHaveBeenCalledWith(3, {
    capturedAt: expect.any(Number), sections: { broken: { unavailable: true } },
  });
  expect(() => traceDevQa('ui:segment', () => { throw new Error('broken QA'); })).not.toThrow();
  dispose();
});

it('bounds text and history while retaining both caption identities and omission metadata', () => {
  const lines = Array.from({ length: 1100 }, (_, id) => ({
    id, displayId: id + 9000, text: 'x'.repeat(5000), translation: 'y'.repeat(5000),
    time: '16:00:00', translating: false, failed: false,
  }));
  const result = transcriptQaSnapshot({
    lines, draft: null, partial: '', recording: false, recordBusy: false, modelLoading: false,
  }) as any;
  expect(result.lineCount).toBe(1100);
  expect(result.omittedIds).toBe(100); expect(result.omittedRows).toBe(1000);
  expect(result.lineIds).toHaveLength(1000);
  expect(result.lineIds.at(-1)).toEqual({ id: 1099, displayId: 10099 });
  expect(result.lines).toHaveLength(100);
  const texts = result.lines.flatMap((line: any) => [line.source, line.translation]);
  expect(texts.reduce((count: number, text: any) => count + text.text.length, 0)).toBeLessThanOrEqual(40000);
  expect(texts.some((text: any) => text.truncated)).toBe(true);
  expect(lines[0].text).toHaveLength(5000);
});
