import { describe, expect, it } from 'vitest';
import type { ArchiveLine, ArchiveRecord } from '@rt/core';
import { activeLineIndex, lineSeek } from './archive-playback';

const line = (audio?: ArchiveLine['audio']): ArchiveLine => ({ time: '10:00:00', text: 'text', translation: '', ...(audio ? { audio } : {}) });
const record: Pick<ArchiveRecord, 'audio'> = { audio: [{ id: 'a', source: 'mic', startedAt: 0, durationMs: 10000, format: 'wav', sampleRate: 16000, channels: 1, bytes: 320044 }] };

describe('archive playback mapping', () => {
  it('never fabricates audio or offsets for legacy records', () => {
    expect(lineSeek(line(), record)).toBeNull();
    expect(lineSeek(line({ recordingId: 'a', start: 2, duration: 1 }), {})).toBeNull();
    expect(lineSeek(line({ recordingId: 'missing', start: 2, duration: 1 }), record)).toBeNull();
  });
  it('accepts exact recording-relative offsets and rejects invalid positions', () => {
    expect(lineSeek(line({ recordingId: 'a', start: 2, duration: 1 }), record)).toEqual({ recordingId: 'a', start: 2 });
    for (const start of [-1, NaN, Infinity, 10, 11]) {
      expect(lineSeek(line({ recordingId: 'a', start, duration: 1 }), record)).toBeNull();
    }
  });
  it('keeps repeated offsets after a pause tied to their own recording', () => {
    const second = { ...record.audio![0], id: 'b' };
    const multi = { audio: [...record.audio!, second] };
    const firstLine = line({ recordingId: 'a', start: 2, duration: 1 });
    const secondLine = line({ recordingId: 'b', start: 2, duration: 1 });
    expect(lineSeek(secondLine, multi)).toEqual({ recordingId: 'b', start: 2 });
    expect(activeLineIndex([firstLine, secondLine], 'b', 2.5)).toBe(1);
  });
  it('highlights only the matching recording and half-open sentence interval', () => {
    const lines = [line(), line({ recordingId: 'a', start: 2, duration: 1 }), line({ recordingId: 'a', start: 3, duration: 2 })];
    expect(activeLineIndex(lines, 'a', 2.5)).toBe(1);
    expect(activeLineIndex(lines, 'a', 3)).toBe(2);
    expect(activeLineIndex(lines, 'a', 5)).toBe(-1);
    expect(activeLineIndex(lines, 'b', 2.5)).toBe(-1);
  });
});
