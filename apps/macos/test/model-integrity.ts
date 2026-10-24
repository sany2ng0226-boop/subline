import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SILERO_VAD, getAsrModel, getTranslationModel } from '@rt/core';
import { asrModelsReady, downloadFile } from '../src/main/model-downloader';
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

test('Missing and truncated pinned GGUF files cannot be reported as ready', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cache-'));
  const original = getTranslationModel('hy-mt2-7b')!;
  const spec = { ...original, files: original.files.map((f) => ({ ...f, expectedBytes: 100 })) };
  try {
    assert.equal(localModelCached(dir, spec), false);
    const dest = path.join(dir, spec.modelId, spec.files[0]!.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'GGUF');
    assert.equal(localModelCached(dir, spec), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A download source with wrong content is skipped and the next source is used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-download-'));
  const server = http.createServer((req, res) => res.end(req.url === '/good' ? 'good' : 'oops'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dest = path.join(dir, 'model.onnx');
  const expected = { expectedBytes: 4, sha256: crypto.createHash('sha256').update('good').digest('hex') };
  try {
    await downloadFile([`${base}/bad`, `${base}/good`], dest, undefined, undefined, expected);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'good');
    fs.rmSync(dest);
    await assert.rejects(downloadFile([`${base}/bad`], dest, undefined, undefined, expected), /校验失败/);
    assert.equal(fs.existsSync(dest), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ASR models with a wrong-size file are not reported as ready', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-asr-'));
  const spec = getAsrModel('sense-voice')!;
  try {
    for (const f of [SILERO_VAD, ...spec.files]) {
      const file = path.join(dir, f.dir, f.filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
    }
    assert.equal(asrModelsReady(dir, 'sense-voice'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Unpinned model downloads remain supported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-unpinned-'));
  const dest = path.join(dir, 'model.gguf');
  const server = http.createServer((_req, res) => res.end('unpinned model'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model`;
  try {
    const spec = {};
    await downloadFile([url], dest, undefined, undefined, spec);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'unpinned model');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HY-MT2 retains its independently verified upstream integrity pin', () => {
  const spec = getTranslationModel('hy-mt2-7b')!.files[0]!;
  assert.equal(spec.expectedBytes, 4624648896);
  assert.equal(spec.sha256, '9f96256500f3fc1ab4d64336b58f52a949a95ad7516b0c229476eef782f9f77b');
});

test('Wrong-size downloads fail without leaving installed or temporary files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-size-'));
  const dest = path.join(dir, 'model.onnx');
  const server = http.createServer((_req, res) => res.end('bad'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model`;
  try {
    await assert.rejects(downloadFile([url], dest, undefined, undefined, { expectedBytes: 4 }), /大小不符/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
