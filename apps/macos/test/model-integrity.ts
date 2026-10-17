import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getTranslationModel } from '@rt/core';
import { localModelCached } from '../src/main/translation/model-cache';
import { verifyModelFile } from '../src/main/translation/model-downloader';

test('A corrupt complete-size model is rejected and removed; a valid model survives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-integrity-'));
  const file = path.join(dir, 'model.gguf');
  const spec = { ...getTranslationModel('hy-mt2-7b')!.files[0]!, expectedBytes: 4,
    sha256: crypto.createHash('sha256').update('good').digest('hex') };
  try {
    fs.writeFileSync(file, 'oops');
    await assert.rejects(verifyModelFile(file, spec), /校验失败/);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, 'good');
    await verifyModelFile(file, spec);
    assert.equal(fs.readFileSync(file, 'utf8'), 'good');
    fs.writeFileSync(file, 'bad');
    await assert.rejects(verifyModelFile(file, spec), /大小不符/);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Missing and truncated GGUF files cannot be reported as ready', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cache-'));
  const spec = getTranslationModel('hy-mt2-7b')!;
  try {
    assert.equal(localModelCached(dir, spec), false);
    const dest = path.join(dir, spec.modelId, spec.files[0]!.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'GGUF');
    assert.equal(localModelCached(dir, spec), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
