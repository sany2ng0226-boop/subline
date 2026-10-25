import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { DevQaServer, DevQaTrace, devQaEnabled } from './dev-qa';

const directories: string[] = [];
const servers: DevQaServer[] = [];
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subline-qa-test-'));
  directories.push(dir);
  return dir;
}
function server(options: Partial<ConstructorParameters<typeof DevQaServer>[0]> = {}): DevQaServer {
  const qa = new DevQaServer({ identity: { pid: 123, packaged: false }, state: () => ({ recording: false }),
    requestRendererSnapshot: () => {}, rendererTimeoutMs: 10, ...options });
  servers.push(qa);
  return qa;
}
afterEach(() => {
  for (const qa of servers.splice(0)) qa.close();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('opt-in Dev QA', () => {
  it('never enables in a packaged app or without the exact opt-in', () => {
    expect(devQaEnabled(true, { SUBLINE_DEV_QA: '1' })).toBe(false);
    expect(devQaEnabled(false, {})).toBe(false);
    expect(devQaEnabled(false, { SUBLINE_DEV_QA: 'true' })).toBe(false);
    expect(devQaEnabled(false, { SUBLINE_DEV_QA: '1' })).toBe(true);
  });

  it('uses monotonic cursors and reports dropped events instead of pretending complete history', () => {
    const trace = new DevQaTrace(2);
    trace.record('asr.raw-result', { text: 'first' });
    trace.record('asr.raw-result', { text: 'second' });
    trace.record('main.pipeline:segment', { text: 'third' });
    const first = trace.read(0, 1);
    expect(first).toMatchObject({ oldestSeq: 2, latestSeq: 3, nextSeq: 2, dropped: true, hasMore: true });
    expect(first.events[0].payload).toEqual({ text: 'second' });
    const second = trace.read(first.nextSeq, 1);
    expect(second).toMatchObject({ nextSeq: 3, dropped: false, hasMore: false });
    expect(() => trace.read(-1)).toThrow();
    expect(() => trace.read(0, 1001)).toThrow();
  });

  it('bounds event bytes and never silently passes an oversized text payload', () => {
    const trace = new DevQaTrace(10, 500);
    trace.record('asr.raw-result', { text: 'x'.repeat(70_000) });
    expect(trace.read().events[0].payload).toEqual({ omitted: true, reason: 'payload-size-or-serialization' });
    trace.record('asr.raw-result', { text: 'x'.repeat(200) });
    trace.record('asr.raw-result', { text: 'y'.repeat(200) });
    expect(trace.read().dropped).toBe(true);
    expect(trace.read().events).toHaveLength(1);
  });

  it('isolates recording sessions and returns immutable event copies', () => {
    const trace = new DevQaTrace();
    const firstSession = trace.beginSession();
    const input = { text: 'captured' };
    trace.record('asr.raw-result', input);
    input.text = 'changed';
    const read = trace.read();
    (read.events[1].payload as { text: string }).text = 'changed-again';
    expect(trace.read().events[1].payload).toEqual({ text: 'captured' });
    const secondSession = trace.beginSession();
    expect(secondSession).not.toBe(firstSession);
    expect(trace.read().events.map((event) => event.session)).toEqual([firstSession, firstSession, secondSession]);
  });

  it('summarizes audio as levels and counts without retaining PCM', () => {
    const trace = new DevQaTrace();
    trace.beginSession();
    trace.audio(new Float32Array([0.5, -0.5, Number.NaN]));
    trace.flushAudio();
    expect(trace.read().events.at(-1)).toMatchObject({ stage: 'audio.input', payload: {
      chunks: 1, samples: 3, totalSamples: 3, rms: 0.5, peak: 0.5, nonFinite: 1, sampleRate: 16000,
    } });
    expect(JSON.stringify(trace.read())).not.toContain('NaN');
  });

  it('rejects control operations and invalid query arguments', async () => {
    const qa = server();
    expect(await qa.handle({ id: 1, method: 'start' })).toMatchObject({ id: 1, error: expect.stringContaining('Read-only') });
    expect(await qa.handle({ id: 1, method: 'snapshot', script: 'delete' })).toMatchObject({ error: 'Unsupported parameter' });
    expect(await qa.handle({ id: 1, method: 'events', limit: 0 })).toMatchObject({ error: expect.any(String) });
    expect(await qa.handle({ id: 1, method: 'events', after: '0' })).toMatchObject({ error: expect.any(String) });
  });

  it('distinguishes fresh snapshots from cached or unavailable renderer state', async () => {
    let reply = false;
    const qa = server({ requestRendererSnapshot: (id) => { if (reply) qa.acceptRendererSnapshot(id, { sections: { viewport: { followEnd: true } } }); } });
    expect(await qa.handle({ method: 'snapshot' })).toMatchObject({ result: { renderer: { available: false, stale: true, data: null } } });
    reply = true;
    expect(await qa.handle({ method: 'snapshot' })).toMatchObject({ result: { renderer: { available: true, stale: false } } });
    reply = false;
    expect(await qa.handle({ method: 'snapshot' })).toMatchObject({ result: { renderer: { available: true, stale: true,
      data: { sections: { viewport: { followEnd: true } } } } } });
  });

  it('serves only local private sockets and preserves pre-existing files', async () => {
    const dir = directory();
    const socketPath = path.join(dir, 'qa.sock');
    const qa = server({ socketPath });
    await qa.listen();
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    const result = await new Promise<string>((resolve, reject) => {
      const connection = createConnection(socketPath, () => connection.write(JSON.stringify({ id: 7, method: 'identity' }) + '\n'));
      let response = '';
      connection.on('data', (data) => { response += data; });
      connection.on('end', () => resolve(response));
      connection.on('error', reject);
    });
    expect(JSON.parse(result)).toMatchObject({ id: 7, result: { pid: 123, socketPath } });
    const other = server({ socketPath });
    await expect(other.listen()).rejects.toThrow('unused');
    other.close();
    expect(fs.existsSync(socketPath)).toBe(true);
    qa.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('refuses public or symlink parent directories', async () => {
    const dir = directory();
    fs.chmodSync(dir, 0o755);
    await expect(server({ socketPath: path.join(dir, 'qa.sock') }).listen()).rejects.toThrow('private');
    fs.chmodSync(dir, 0o700);
    const link = path.join(dir, 'link');
    fs.symlinkSync(dir, link);
    await expect(server({ socketPath: path.join(link, 'qa.sock') }).listen()).rejects.toThrow('private');
  });
});
