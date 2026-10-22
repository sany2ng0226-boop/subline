import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveAudioResponse } from './archive-audio-response';

describe('archive audio response', () => {
  let dir: string;
  let file: string;
  let wav: Buffer;
  const url = 'subline-audio://archive/a123/recording-1';
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subline-audio-response-'));
    file = path.join(dir, 'fixture.wav');
    wav = Buffer.alloc(44 + 320);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(i * 10, i);
    await fs.writeFile(file, wav);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const request = (range?: string, method = 'GET') => new Request(url, {
    method, headers: range === undefined ? undefined : { Range: range },
  });
  it('streams a complete WAV and reports body-free HEAD metadata', async () => {
    const resolve = vi.fn(() => file);
    const head = await archiveAudioResponse(request(undefined, 'HEAD'), resolve);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(wav.length));
    expect(head.headers.get('content-type')).toBe('audio/wav');
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(await head.text()).toBe('');
    const full = await archiveAudioResponse(request(), resolve);
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer())).toEqual(wav);
    expect(resolve).toHaveBeenCalledWith('a123', 'recording-1');
  });
  it.each([
    ['bytes=44-63', 44, 63], ['bytes=320-', 320, 363], ['bytes=-10', 354, 363],
    ['bytes=360-999', 360, 363], ['bytes=-999', 0, 363],
  ])('supports seeking with %s', async (range, start, end) => {
    const response = await archiveAudioResponse(request(range as string), () => file);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${wav.length}`);
    expect(response.headers.get('content-length')).toBe(String(Number(end) - Number(start) + 1));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wav.subarray(Number(start), Number(end) + 1));
  });
  it.each(['bytes=364-', 'bytes=50-40', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'items=0-1', 'bytes=1.5-2', 'bytes=9007199254740992-'])('rejects invalid or multiple ranges: %s', async (range) => {
    const response = await archiveAudioResponse(request(range), () => file);
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${wav.length}`);
    expect(await response.text()).toBe('');
  });
  it('ignores Range on HEAD and handles an empty file without a stream', async () => {
    expect((await archiveAudioResponse(request('bytes=10-20', 'HEAD'), () => file)).status).toBe(200);
    await fs.writeFile(file, '');
    const response = await archiveAudioResponse(request(), () => file);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect((await archiveAudioResponse(request('bytes=0-'), () => file)).status).toBe(416);
  });
  it.each([
    'file:///etc/passwd', 'subline-audio://other/a123/recording-1',
    'subline-audio://archive/a123/recording-1/extra', 'subline-audio://archive/a123/%2Fetc%2Fpasswd',
    'subline-audio://archive/%61%31%32%33/recording-1', 'subline-audio://archive/a123/%252e%252e',
    'subline-audio://archive/a123/recording-1?path=/etc/passwd', 'subline-audio://archive/a123/recording-1#tail',
    'subline-audio://archive:42/a123/recording-1',
  ])('rejects paths before resolution: %s', async (invalid) => {
    const resolve = vi.fn(() => file);
    expect((await archiveAudioResponse(new Request(invalid), resolve)).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });
  it('never resolves non-read methods or missing archive members', async () => {
    const resolve = vi.fn(() => file);
    const denied = await archiveAudioResponse(request(undefined, 'POST'), resolve);
    expect(denied.status).toBe(405);
    expect(denied.headers.get('allow')).toBe('GET, HEAD');
    expect(resolve).not.toHaveBeenCalled();
    expect((await archiveAudioResponse(request(), () => null)).status).toBe(404);
    expect((await archiveAudioResponse(request(), () => path.join(dir, 'missing.wav'))).status).toBe(404);
    expect((await archiveAudioResponse(request(), () => dir)).status).toBe(404);
  });
});
