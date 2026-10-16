import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudTranslator, isLoopbackEndpoint } from './cloud-translator';
import { TranslationContext } from './context';

afterEach(() => vi.unstubAllGlobals());
const cfg = (baseURL = 'http://127.0.0.1:1234/v1') => ({ baseURL, apiKey: '', model: 'hy-mt2-1.8b' });

describe('local API translation', () => {
  it('allows keyless loopback only, including IPv6; rejects lookalikes', async () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      await expect(new CloudTranslator(cfg(`http://${host}:1234/v1`)).init()).resolves.toBeUndefined();
    }
    for (const host of ['localhost.evil.test', '192.168.1.2', 'example.com']) {
      await expect(new CloudTranslator(cfg(`http://${host}/v1`)).init()).rejects.toThrow('API Key');
    }
    expect(isLoopbackEndpoint('http://user:pass@localhost:1234/v1')).toBe(false);
    expect(isLoopbackEndpoint('file:///tmp/model')).toBe(false);
  });

  it('passes bounded source context but requests only the current translation', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '在生活过程中' } }] })));
    vi.stubGlobal('fetch', fetch);
    const t = new CloudTranslator(cfg());
    await expect(t.translate('生きていく中で', { source: 'ja', target: 'zh', context: ['神々の世界', '人間の感情'] }))
      .resolves.toBe('在生活过程中');
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(request.redirect).toBe('error');
    expect(request.headers).not.toHaveProperty('Authorization');
    const body = JSON.parse(request.body as string);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toContain('神々の世界');
    expect(body.messages[0].content).toContain('do not translate or repeat');
    expect(body.messages[0].content).toContain('生きていく中で');
  });

  it('marks empty model responses as failures rather than successful blank lines', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [] })));
    await expect(new CloudTranslator(cfg()).translate('こんにちは', { target: 'zh' })).rejects.toThrow('空译文');
  });
});

describe('source context lifetime', () => {
  it('snapshots in source order, caps history and clears on language/session changes', () => {
    const c = new TranslationContext();
    expect(c.take('ja', 'zh', '一')).toEqual([]);
    const snapshot = c.take('ja', 'zh', '二');
    expect(c.take('ja', 'zh', '三')).toEqual(['一', '二']);
    expect(c.take('ja', 'zh', '四')).toEqual(['二', '三']);
    expect(snapshot).toEqual(['一']);
    expect(c.take('en', 'zh', 'new')).toEqual([]);
    c.reset(); expect(c.take('en', 'zh', 'session')).toEqual([]);
  });
});
