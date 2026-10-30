import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppleSpeechClient, assertAppleSpeechSupported, queryAppleSpeechSetup } from './apple-speech-client';
import type { AsrToMain } from '../shared/types';

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  messages: Record<string, unknown>[] = [];
  kill = vi.fn(() => true);
  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) if (line) this.messages.push(JSON.parse(line));
    });
  }
  send(message: Record<string, unknown>) { this.stdout.write(JSON.stringify(message) + '\n'); }
}

const clients: AppleSpeechClient[] = [];
function fixture() {
  const helper = new FakeHelper();
  const events: AsrToMain[] = [];
  const client = new AppleSpeechClient('/helper', 'ja', (message) => events.push(message), () => helper);
  clients.push(client);
  return { helper, events, client };
}
afterEach(() => { for (const c of clients.splice(0)) c.dispose(); vi.useRealTimers(); });

describe('Apple native speech adapter', () => {
  it('keeps pending source visible and flushes native tail through shared assembly before stop acknowledgement', async () => {
    const { helper, client, events } = fixture();
    expect(helper.messages[0]).toEqual({ type: 'init', language: 'ja', prepare: false });
    helper.send({ type: 'ready' });
    await client.ready;
    client.acceptWaveform(new Float32Array([1]));
    expect(helper.messages).toHaveLength(1);
    client.reset();
    client.acceptWaveform(new Float32Array([0.25, -0.5]));
    const audio = helper.messages.find((m) => m.type === 'audio')!;
    const bytes = Buffer.from(String(audio.samples), 'base64');
    expect(bytes.readFloatLE(0)).toBe(0.25);
    expect(bytes.readFloatLE(4)).toBe(-0.5);
    helper.send({ type: 'segment', sessionId: 1, text: 'こんにちは', lang: 'ja', start: 0, duration: 1 });
    helper.send({ type: 'partial', sessionId: 1, text: '世界' });
    expect(events.at(-1)).toEqual({ type: 'partial', payload: { text: 'こんにちは世界', stableText: 'こんにちは' } });
    const flushed = client.flush(4).then(() => events.push({ type: 'flushed', requestId: 4 }));
    helper.send({ type: 'segment', sessionId: 1, text: '世界', lang: 'ja', start: 1, duration: 1 });
    helper.send({ type: 'flushed', requestId: 4 });
    await flushed;
    expect(events.filter((e) => e.type === 'segment')).toEqual([
      { type: 'segment', payload: { id: expect.any(Number), text: 'こんにちは世界', lang: 'ja', start: 0, duration: 2 } },
    ]);
    expect(events.at(-1)).toEqual({ type: 'flushed', requestId: 4 });
    expect(events.at(-2)).toEqual({ type: 'partial', payload: { text: '', stableText: '' } });
  });

  it('rejects old flushes on a new recording and filters late native captions by session', async () => {
    const { helper, client, events } = fixture();
    helper.send({ type: 'ready' }); await client.ready;
    client.reset();
    const oldFlush = client.flush(8);
    const rejection = expect(oldFlush).rejects.toThrow('录音会话已切换');
    client.reset();
    await rejection;
    helper.send({ type: 'partial', sessionId: 1, text: '旧字幕' });
    helper.send({ type: 'segment', sessionId: 1, text: '旧字幕。', lang: 'ja', start: 0, duration: 1 });
    helper.send({ type: 'flushed', requestId: 8 });
    helper.send({ type: 'error', sessionId: 1, message: '旧会话取消' });
    expect(events).toEqual([]);
    helper.send({ type: 'partial', sessionId: 2, text: '新字幕' });
    expect(events.at(-1)).toEqual({ type: 'partial', payload: { text: '新字幕', stableText: '' } });
  });

  it('fails a pending stop on helper exit and ignores later output', async () => {
    const { helper, client, events } = fixture();
    helper.send({ type: 'ready' }); await client.ready;
    client.reset();
    const flushed = client.flush(3);
    const rejection = expect(flushed).rejects.toThrow('异常退出');
    helper.emit('exit', 7);
    await rejection;
    helper.send({ type: 'segment', sessionId: 1, text: '迟到。', lang: 'ja', start: 0, duration: 1 });
    expect(events).toEqual([{ type: 'error', message: 'Apple 语音识别服务异常退出 (7)' }]);
  });

  it('rejects startup if the helper reports unavailable assets and disposes its process', async () => {
    const { helper, client, events } = fixture();
    const rejection = expect(client.ready).rejects.toThrow('需准备语言模型');
    helper.send({ type: 'error', message: '需准备语言模型' });
    await rejection;
    expect(helper.kill).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: 'error', message: '需准备语言模型' }]);
  });
});

describe('Apple system assets', () => {
  it('uses a bounded read-only probe and only downloads when explicitly requested', async () => {
    const readHelper = new FakeHelper();
    const ready = queryAppleSpeechSetup('/helper', 'ja', false, () => readHelper);
    expect(readHelper.messages).toEqual([{ type: 'setup', language: 'ja', download: false }]);
    readHelper.send({ type: 'setup', asrReady: true, supported: true });
    await expect(ready).resolves.toEqual({ asrReady: true, supported: true });
    expect(readHelper.kill).toHaveBeenCalledOnce();
    const downloadHelper = new FakeHelper();
    const download = queryAppleSpeechSetup('/helper', 'ko', true, () => downloadHelper);
    expect(downloadHelper.messages[0]).toEqual({ type: 'setup', language: 'ko', download: true });
    downloadHelper.send({ type: 'error', message: '系统下载失败' });
    await expect(download).rejects.toThrow('系统下载失败');
  });

  it('terminates an unresponsive setup helper and rejects unsupported hosts', async () => {
    vi.useFakeTimers();
    const helper = new FakeHelper();
    const result = queryAppleSpeechSetup('/helper', 'ja', false, () => helper, 100);
    const rejection = expect(result).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(helper.kill).toHaveBeenCalledOnce();
    expect(() => assertAppleSpeechSupported('win32', '27.0')).toThrow('macOS 26');
    expect(() => assertAppleSpeechSupported('darwin', '24.0')).toThrow('macOS 26');
    expect(() => assertAppleSpeechSupported('darwin', '25.0')).not.toThrow();
  });
});
