import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveRecord } from '@rt/core';
import { CODEX_PROOFREAD_MODEL, codexSubscriptionEnvironment, getCodexSubscriptionStatus, proofreadBatches,
  proofreadingSource, runCodexProcess, startCodexProofreading, validateCodexEvents, validateProofreadOptions,
  validateProofreadResponse, type CodexProofreadDependencies } from './codex-proofreading';

afterEach(() => { vi.unstubAllEnvs(); });
const source: ArchiveRecord = { id: 'private-archive', name: 'private name', createdAt: 1, lines: [
  { text: '本日の授業わ午後3時です。', translation: 'old', time: '15:00:00', lang: 'ja', audio: { recordingId: 'private-recording', start: 2.25, duration: 3 } },
  { text: '締切は［不明］です。', translation: '', time: '15:00:03', lang: 'ja', audio: { recordingId: 'other-private-recording', start: 0, duration: 2 } },
] };
const options = { kind: 'codex' as const, targetLang: 'zh' as const };
const events = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n';
type Request = Parameters<CodexProofreadDependencies['run']>[2];
interface Row { id: string; text: string; contextGroup: string; language: string }
function output(rows: Row[]) {
  return { lines: rows.map(row => ({ id: row.id, corrected: row.text.replace('授業わ', '授業は'),
    translation: row.text.includes('3') ? '今天的课程下午3点开始。' : '截止时间不明。', needsReview: false, note: '' })) };
}
function fixture(change?: (data: ReturnType<typeof output>, invocation: number) => void) {
  const requests: { args: string[]; input: Request; rows: Row[] }[] = [];
  let invocation = 0;
  const run = vi.fn(async (_binary: string, args: string[], input: Request) => {
    if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
    const rows = JSON.parse(input.input.split('Input rows:\n')[1]!) as Row[];
    requests.push({ args, input, rows });
    const data = output(rows);
    change?.(data, ++invocation);
    await fs.writeFile(args[args.indexOf('-o') + 1]!, JSON.stringify(data));
    return { code: 0, stdout: events, stderr: '' };
  });
  const deps: CodexProofreadDependencies = { findCli: vi.fn(async () => '/opt/homebrew/bin/codex'), run };
  return { deps, run, requests };
}

describe('Codex subscription proofreading', () => {
  it('passes only subtitle text and anonymous grouping, preserves original timing and source, and removes temporary output', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-api-key');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'test-token');
    const original = JSON.stringify(source);
    const f = fixture();
    const progress: string[] = [];
    const revision = await startCodexProofreading(source, options, value => progress.push(value.state), f.deps).result;
    expect(JSON.stringify(source)).toBe(original);
    expect(revision.options).toEqual(options);
    expect(revision.codex).toEqual({ model: CODEX_PROOFREAD_MODEL });
    expect(revision.lines[0]).toMatchObject({ time: source.lines[0]!.time, lang: 'ja', audio: source.lines[0]!.audio,
      text: '本日の授業は午後3時です。', review: { originalText: source.lines[0]!.text } });
    expect(revision.lines[1]!.review?.needsReview).toBe(true);
    expect(progress).toEqual(['proofreading', 'proofreading']);
    const request = f.requests[0]!;
    expect(request.rows.map(row => row.contextGroup)).toEqual(['0', '1']);
    expect(request.input.input).not.toMatch(/private-archive|private name|private-recording|15:00|duration|filePath/);
    expect(request.input.env.OPENAI_API_KEY).toBeUndefined();
    expect(request.input.env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(request.input.env.PATH).toContain('/opt/homebrew/bin');
    expect(request.args).toContain('--ignore-user-config');
    expect(request.args).toContain('--ephemeral');
    expect(request.args).toContain('forced_login_method="chatgpt"');
    expect(request.args).toContain('features.shell_tool=false');
    expect(request.args).toContain('features.multi_agent=false');
    expect(request.args).toContain('features.hooks=false');
    expect(request.args).toContain('features.apps=false');
    expect(request.args).toContain('web_search="disabled"');
    expect(request.args).not.toContain('--ignore-rules');
    await expect(fs.access(request.input.cwd)).rejects.toThrow();
  });

  it('can proofread a selected text-only local revision without an audio file or model download', async () => {
    const record: ArchiveRecord = { ...source, revisions: [{ id: 'local', createdAt: 2,
      options: { asrModel: 'sense-voice', language: 'ja', targetLang: 'zh' },
      lines: [{ text: '本日の授業は午後3時です。', translation: '', lang: 'ja' }] }] };
    const f = fixture();
    const result = await startCodexProofreading(record, { ...options, sourceRevisionId: 'local' }, () => {}, f.deps).result;
    expect(f.requests[0]!.rows).toHaveLength(1);
    expect(result.lines[0]!.audio).toBeUndefined();
    expect(result.options).toEqual({ ...options, sourceRevisionId: 'local' });
    expect(record.revisions).toHaveLength(1);
  });

  it('rejects missing, duplicate, reordered, malformed and overlong rows', () => {
    const input = proofreadBatches(source.lines)[0]!;
    for (const mutate of [
      (data: ReturnType<typeof output>) => { data.lines.pop(); },
      (data: ReturnType<typeof output>) => { data.lines[1]!.id = '0'; },
      (data: ReturnType<typeof output>) => { data.lines.reverse(); },
      (data: ReturnType<typeof output>) => { data.lines[0]!.corrected = ''; },
      (data: ReturnType<typeof output>) => { data.lines[0]!.translation = ''; },
      (data: ReturnType<typeof output>) => { data.lines[0]!.corrected = 'x'.repeat(501); },
      (data: ReturnType<typeof output>) => { (data.lines[0] as unknown as Record<string, unknown>).needsReview = 'false'; },
    ]) {
      const data = output(input); mutate(data);
      expect(() => validateProofreadResponse(data, input)).toThrow();
    }
  });

  it('rejects changed numbers, negation, unknown markers, and dropped numeric translation values', () => {
    const lines = [{ text: '締切は17時30分ではありません。担当者は［不明］です。', translation: '' }];
    const input = proofreadBatches(lines)[0]!;
    const make = () => ({ lines: [{ id: '0', corrected: lines[0]!.text, translation: '截止不是17点30分。负责人不明。', needsReview: true, note: '' }] });
    for (const corrected of [lines[0]!.text.replace('17', '18'), lines[0]!.text.replace('ありません', 'あります'), lines[0]!.text.replace('［不明］', '山田')]) {
      const data = make(); data.lines[0]!.corrected = corrected;
      expect(() => validateProofreadResponse(data, input)).toThrow('protected');
    }
    const data = make(); data.lines[0]!.translation = '截止不是18点30分。负责人不明。';
    expect(() => validateProofreadResponse(data, input)).toThrow('numeric');
  });

  it('rejects any unsuccessful completion or unexpected tool use', () => {
    for (const stdout of ['', JSON.stringify({ type: 'turn.failed' }), JSON.stringify({ type: 'error' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }) + '\n' + events,
      JSON.stringify({ type: 'item.completed', item: { type: 'error' } }) + '\n' + events]) {
      expect(() => validateCodexEvents(stdout)).toThrow();
    }
    expect(() => validateCodexEvents(events)).not.toThrow();
  });

  it('does not return partial revisions if a later batch fails validation', async () => {
    const record: ArchiveRecord = { ...source, lines: Array.from({ length: 121 }, () => ({ text: '本日の授業は午後3時です。', translation: '' })) };
    const original = JSON.stringify(record);
    const f = fixture((data, invocation) => { if (invocation === 2) data.lines = []; });
    await expect(startCodexProofreading(record, options, () => {}, f.deps).result).rejects.toThrow('incomplete');
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(record)).toBe(original);
    await expect(fs.access(f.requests[0]!.input.cwd)).rejects.toThrow();
  });

  it('rejects nonzero CLI exit even if it left a plausible structured response', async () => {
    const f = fixture();
    const successful = f.deps.run;
    f.deps.run = async (binary, args, input) => {
      const response = await successful(binary, args, input);
      return args[0] === 'login' ? response : { ...response, code: 1 };
    };
    await expect(startCodexProofreading(source, options, () => {}, f.deps).result).rejects.toThrow('subscription limits');
  });

  it('refuses API key authentication without falling back or starting a model run', async () => {
    const f = fixture();
    f.deps.run = vi.fn(async () => ({ code: 0, stdout: 'Logged in using an API key', stderr: '' }));
    await expect(startCodexProofreading(source, options, () => {}, f.deps).result).rejects.toThrow('ChatGPT');
    expect(f.deps.run).toHaveBeenCalledOnce();
    expect(f.requests).toHaveLength(0);
  });

  it('cancels before CLI discovery returns without starting a process', async () => {
    const f = fixture();
    let finish!: (value: string) => void;
    f.deps.findCli = () => new Promise(resolve => { finish = resolve; });
    const worker = startCodexProofreading(source, options, () => {}, f.deps);
    worker.cancel(); finish('/opt/homebrew/bin/codex');
    await expect(worker.result).rejects.toThrow('Cancelled');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('cancels an in-flight CLI request and removes its temporary files', async () => {
    const f = fixture();
    let cwd = '';
    f.deps.run = async (_binary, args, input) => {
      if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
      cwd = input.cwd;
      return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
    };
    const worker = startCodexProofreading(source, options, () => {}, f.deps);
    await vi.waitFor(() => expect(cwd).not.toBe(''));
    worker.cancel();
    await expect(worker.result).rejects.toThrow('Cancelled');
    await expect(fs.access(cwd)).rejects.toThrow();
  });

  it('reports unavailable or unauthenticated CLI status without credentials', async () => {
    const f = fixture();
    f.deps.findCli = async () => null;
    expect(await getCodexSubscriptionStatus(f.deps)).toMatchObject({ available: false, authenticated: false, model: CODEX_PROOFREAD_MODEL });
    expect(f.run).not.toHaveBeenCalled();
    f.deps.findCli = async () => '/opt/homebrew/bin/codex';
    f.deps.run = async () => ({ code: 1, stdout: '', stderr: 'Not logged in' });
    expect(await getCodexSubscriptionStatus(f.deps)).toMatchObject({ available: true, authenticated: false });
  });

  it('rejects missing revisions, unsupported targets, and invalid or empty source rows', () => {
    expect(() => validateProofreadOptions({ ...options, targetLang: 'xx' as never })).toThrow('Invalid');
    expect(() => proofreadingSource(source, { ...options, sourceRevisionId: 'missing' })).toThrow('no longer exists');
    expect(() => proofreadingSource({ ...source, lines: [] }, options)).toThrow('empty');
    expect(() => proofreadingSource({ ...source, lines: [{ text: '', translation: '' }] }, options)).toThrow('invalid');
  });

  it('builds a Finder-compatible environment without API secrets or Node injection', () => {
    const env = codexSubscriptionEnvironment('/opt/homebrew/bin/codex', { PATH: '/usr/bin', OPENAI_API_KEY: 'key', CODEX_API_KEY: 'key',
      CODEX_ACCESS_TOKEN: 'token', NODE_OPTIONS: '--require malicious.js', CODEX_HOME: '/auth-location' });
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.CODEX_HOME).toBe('/auth-location');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('terminates a stalled child on timeout', async () => {
    await expect(runCodexProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: process.cwd(), env: process.env, input: '', timeoutMs: 30, signal: new AbortController().signal,
    })).rejects.toThrow('timed out');
  });
});
