import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadFile } from '../src/main/model-downloader';

const data = Buffer.from('a complete model payload');
const spec = { expectedBytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(handler: http.RequestListener) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subline-download-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/model`;
  const dest = path.join(dir, 'model');
  const seed = (size = 5, etag = '"v1"', source = url) => {
    fs.writeFileSync(`${dest}.part`, data.subarray(0, size));
    fs.writeFileSync(`${dest}.part.json`, JSON.stringify({ url: source, etag, lastModified: null, ...spec }));
  };
  return { url, dest, seed };
}
describe('resumable model downloads', () => {
  it('resumes 206 and reports finite speed', async () => {
    const f = await fixture((req, res) => {
      expect(req.headers.range).toBe('bytes=5-');
      expect(req.headers['if-range']).toBe('"v1"');
      res.writeHead(206, { ETag: '"v1"', 'Content-Range': `bytes 5-${data.length - 1}/${data.length}` });
      res.end(data.subarray(5));
    });
    f.seed();
    const speeds: number[] = [];
    await downloadFile([f.url], f.dest, (_l, _t, speed) => speeds.push(speed!), undefined, spec);
    expect(fs.readFileSync(f.dest)).toEqual(data);
    expect(speeds.every(Number.isFinite)).toBe(true);
    expect(fs.existsSync(`${f.dest}.part.json`)).toBe(false);
  });
  it.each(['ignore', 'etag', 'range'])('restarts when server response is %s', async mode => {
    let calls = 0;
    const f = await fixture((req, res) => {
      calls++;
      if (calls === 1 && mode !== 'ignore') {
        res.writeHead(206, { ETag: mode === 'etag' ? '"v2"' : '"v1"', 'Content-Range': `bytes ${mode === 'range' ? 2 : 5}-${data.length - 1}/${data.length}` });
        res.end(data.subarray(5));
      } else { if (calls > 1) expect(req.headers.range).toBeUndefined(); res.end(data); }
    });
    f.seed();
    await downloadFile([f.url], f.dest, undefined, undefined, spec);
    expect(fs.readFileSync(f.dest)).toEqual(data);
    expect(calls).toBe(mode === 'ignore' ? 1 : 2);
  });
  it('verifies 416 as a complete candidate', async () => {
    const f = await fixture((_req, res) => { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }); res.end(); });
    f.seed(data.length);
    await downloadFile([f.url], f.dest, undefined, undefined, spec);
    expect(fs.readFileSync(f.dest)).toEqual(data);
  });
  it('shares one promise and request across concurrent callers', async () => {
    let calls = 0;
    const f = await fixture((_req, res) => { calls++; setTimeout(() => res.end(data), 20); });
    const a = downloadFile([f.url], f.dest, undefined, undefined, spec);
    const b = downloadFile([f.url], f.dest, undefined, undefined, spec);
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
  it('deletes a sha mismatch', async () => {
    const f = await fixture((_req, res) => res.end(Buffer.alloc(data.length)));
    await expect(downloadFile([f.url], f.dest, undefined, undefined, spec)).rejects.toThrow('校验失败');
    expect(fs.existsSync(`${f.dest}.part`)).toBe(false);
    expect(fs.existsSync(f.dest)).toBe(false);
  });
  it('keeps interrupted bytes and resumes a retry', async () => {
    let calls = 0;
    const f = await fixture((req, res) => {
      if (++calls === 1) {
        res.writeHead(200, { ETag: '"v1"', 'Content-Length': data.length });
        res.write(data.subarray(0, 5));
        setTimeout(() => res.destroy(), 30);
      } else {
        expect(req.headers.range).toBe('bytes=5-');
        res.writeHead(206, { ETag: '"v1"', 'Content-Range': `bytes 5-${data.length - 1}/${data.length}` });
        res.end(data.subarray(5));
      }
    });
    await expect(downloadFile([f.url], f.dest, undefined, undefined, spec)).rejects.toThrow();
    expect(fs.statSync(`${f.dest}.part`).size).toBe(5);
    await downloadFile([f.url], f.dest, undefined, undefined, spec);
    expect(fs.readFileSync(f.dest)).toEqual(data);
  });
  it.each([true, false])('mirror continuation requires sha256 (%s)', async known => {
    const f = await fixture((req, res) => {
      expect(req.headers.range).toBe(known ? 'bytes=5-' : undefined);
      if (known) { res.writeHead(206, { ETag: '"v1"', 'Content-Range': `bytes 5-${data.length - 1}/${data.length}` }); res.end(data.subarray(5)); }
      else res.end(data);
    });
    f.seed(5, '"v1"', 'http://old-source/model');
    await downloadFile([f.url], f.dest, undefined, undefined, known ? spec : { expectedBytes: data.length });
    expect(fs.readFileSync(f.dest)).toEqual(data);
  });
});
