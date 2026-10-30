import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function buildAppleSpeech() {
  if (process.platform !== 'darwin') return null;
  const source = path.join(appDir, 'native/apple-speech.swift');
  const output = path.join(appDir, 'build/apple-speech');
  try {
    if (statSync(output).mtimeMs >= Math.max(statSync(source).mtimeMs, statSync(fileURLToPath(import.meta.url)).mtimeMs)) return output;
  } catch { /* The helper has not been built yet. */ }
  mkdirSync(path.dirname(output), { recursive: true });
  execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', '-target', 'arm64-apple-macos14.2',
    '-module-cache-path', path.join(os.tmpdir(), 'subline-apple-speech-module-cache'), source, '-o', output],
  { stdio: 'inherit' });
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildAppleSpeech();
