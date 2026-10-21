import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyProfile } from './profile-migration';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-migration-'));
  roots.push(root);
  const source = path.join(root, 'old');
  const target = path.join(root, 'new');
  const write = (base: string, name: string, content = name) => {
    const file = path.join(base, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const run = (sourceDirs = [source]) => migrateLegacyProfile({ targetDir: target, sourceDirs, log: vi.fn() });
  return { root, source, target, write, run };
}
function snapshot(dir: string): unknown[] {
  return fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    return [name, stat.size, stat.mtimeMs, stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('hex')];
  });
}

describe('legacy profile migration', () => {
  it('migrates nested models and profile JSON without changing source listing, sizes or mtimes', () => {
    const { source, target, write, run } = fixture();
    const names = ['models/sherpa-onnx-sense-voice/model.onnx', 'models/silero_vad.onnx',
      'models/transformers/tencent/Hy-MT2-7B-GGUF/model.gguf', 'archives.json', 'archive-library.json', 'settings.json'];
    for (const name of names) write(source, name);
    const before = snapshot(source);
    run();
    for (const name of names) expect(fs.readFileSync(path.join(target, name), 'utf8')).toBe(name);
    expect(fs.statSync(path.join(target, names[0])).ino).toBe(fs.statSync(path.join(source, names[0])).ino);
    expect(snapshot(source)).toEqual(before);
    const marker = JSON.parse(fs.readFileSync(path.join(target, '.profile-migrated.json'), 'utf8'));
    expect(marker.sources).toEqual([source]);
    expect(Number.isNaN(Date.parse(marker.time))).toBe(false);
  });

  it('preserves existing target files regardless of size and gives the first source priority', () => {
    const { root, source, target, write, run } = fixture();
    const second = path.join(root, 'older');
    for (const name of ['models/model.onnx', 'archives.json', 'archive-library.json', 'settings.json']) {
      write(source, name, 'legacy');
      write(target, name, 'newer-longer');
      write(second, name, 'oldest');
    }
    write(source, 'models/shared.gguf', 'first');
    write(second, 'models/shared.gguf', 'second');
    write(second, 'models/extra.onnx');
    run([source, second]);
    for (const name of ['models/model.onnx', 'archives.json', 'archive-library.json', 'settings.json']) {
      expect(fs.readFileSync(path.join(target, name), 'utf8')).toBe('newer-longer');
    }
    expect(fs.readFileSync(path.join(target, 'models/shared.gguf'), 'utf8')).toBe('first');
    expect(fs.existsSync(path.join(target, 'models/extra.onnx'))).toBe(true);
  });

  it('ignores partial and temporary files, but restores a final beside a target partial', () => {
    const { source, target, write, run } = fixture();
    for (const name of ['bad.part', 'bad.part.1', 'bad.tmp', 'bad.temp', '.hidden', 'bad~']) write(source, `models/${name}`);
    write(source, 'models/good.onnx');
    write(target, 'models/good.onnx.part', 'unfinished');
    run();
    expect(fs.readdirSync(path.join(target, 'models')).sort()).toEqual(['good.onnx', 'good.onnx.part']);
  });

  it('is a no-op after the marker exists', () => {
    const { source, target, write, run } = fixture();
    write(source, 'settings.json');
    run();
    const before = snapshot(target);
    write(source, 'models/later.onnx');
    run();
    expect(snapshot(target)).toEqual(before);
  });

  it('skips missing sources and the target itself', () => {
    const { root, target, run } = fixture();
    expect(() => run([target, path.join(root, 'missing')])).not.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(target, '.profile-migrated.json'), 'utf8')).sources).toEqual([]);
  });

  it('copies via a temporary file when hard links are unavailable', () => {
    const { source, target, write, run } = fixture();
    write(source, 'models/model.gguf');
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw new Error('EXDEV'); });
    run();
    expect(fs.readFileSync(path.join(target, 'models/model.gguf'), 'utf8')).toBe('models/model.gguf');
    expect(fs.readdirSync(path.join(target, 'models'))).toEqual(['model.gguf']);
    expect(fs.statSync(path.join(target, 'models/model.gguf')).ino).not.toBe(fs.statSync(path.join(source, 'models/model.gguf')).ino);
  });

  it('keeps errors non-fatal and retries failed copies without a marker', () => {
    const { source, target, write, run } = fixture();
    write(source, 'settings.json');
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => run()).not.toThrow();
    expect(fs.existsSync(path.join(target, '.profile-migrated.json'))).toBe(false);
    expect(fs.readdirSync(target)).toEqual([]);
    copy.mockRestore();
    run();
    expect(fs.existsSync(path.join(target, 'settings.json'))).toBe(true);
  });
});
