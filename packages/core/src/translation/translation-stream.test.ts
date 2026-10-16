import { expect, it, vi, afterEach } from 'vitest';
import { readTranslationStream } from './translation-stream';
import { CloudTranslator } from './cloud-translator';
afterEach(() => vi.unstubAllGlobals());
function response(data: string, splitBytes = false) {
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream({ start(controller) {
    if (splitBytes) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const delta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
const end = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
it('decodes UTF-8 split across arbitrary bytes and ignores role/usage events', async () => {
  const partial = vi.fn();
  const result = await readTranslationStream(response(': keepalive\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
    delta('你好') + delta('，世界。') + 'data: {"choices":[],"usage":{"completion_tokens":5}}\n\n' + end, true), partial);
  expect(result).toBe('你好，世界。');
  expect(partial).toHaveBeenCalled();
  for (const [text] of partial.mock.calls) expect(result.startsWith(text)).toBe(true);
});
it('rejects missing completion markers and length-limited output', async () => {
  await expect(readTranslationStream(response(delta('半句')), () => {})).rejects.toThrow('提前结束');
  await expect(readTranslationStream(response(delta('半句') + 'data: [DONE]\n'), () => {})).rejects.toThrow('未完整生成');
  await expect(readTranslationStream(response(delta('被截断') + 'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n'), () => {})).rejects.toThrow('未完整生成');
});
it('rejects malformed, empty and explicit-error streams', async () => {
  await expect(readTranslationStream(response('data: {broken}\n'), () => {})).rejects.toThrow();
  await expect(readTranslationStream(response(end), () => {})).rejects.toThrow('空译文');
  await expect(readTranslationStream(response('data: {"error":{"message":"server failed"}}\n'), () => {})).rejects.toThrow('server failed');
});
it('changes only transport for verified local Hy7B requests; keeps other APIs unchanged', async () => {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
    const body = JSON.parse(opts.body as string); bodies.push(body);
    return body.stream ? response(delta('原样译文') + end) : new Response(JSON.stringify({ choices: [{ message: { content: '原样译文' } }] }));
  }));
  const opts = { source: 'ja', target: 'zh', context: ['前文'], onPartial: vi.fn() };
  const local = new CloudTranslator({ baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', model: 'hy-mt2-7b' });
  expect(await local.translate('本文', opts)).toBe('原样译文');
  expect(await local.translate('本文', { ...opts, onPartial: undefined })).toBe('原样译文');
  const { stream, ...streamBody } = bodies[0];
  expect(stream).toBe(true); expect(streamBody).toEqual(bodies[1]);
  await new CloudTranslator({ baseURL: 'https://example.com/v1', apiKey: 'test', model: 'hy-mt2-7b' }).translate('本文', opts);
  expect(bodies[2].stream).toBeUndefined();
});
