import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  readSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const appDir = path.resolve(flag('--app-dir', 'release-windows/win-unpacked'));
const diagnostics = path.resolve(flag('--diagnostics', '../../work/windows-diagnostics'));
const report = { platform: process.platform, arch: process.arch, node: process.versions.node, checks: [] };
mkdirSync(diagnostics, { recursive: true });

function check(name, detail) {
  report.checks.push({ name, detail });
  console.log(`PASS ${name}${detail ? `: ${JSON.stringify(detail)}` : ''}`);
}
function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
    else throw new Error(`Unexpected non-regular packaged entry: ${file}`);
  }
}
function magic(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const count = readSync(fd, buffer, 0, 4, 0);
    return buffer.subarray(0, count).toString('hex');
  } finally { closeSync(fd); }
}

async function nativeChild() {
  const unpacked = path.join(appDir, 'resources', 'app.asar.unpacked');
  const appRequire = createRequire(path.join(unpacked, 'package.json'));
  const sherpa = appRequire('sherpa-onnx-node');
  assert.equal(typeof sherpa.OfflineRecognizer, 'function');
  assert.equal(typeof sherpa.Vad, 'function');
  // readWave calls the same N-API addon as recognizer construction, without a model download.
  const wav = Buffer.alloc(44 + 320);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(320, 40);
  const wavPath = path.join(diagnostics, 'native-silence.wav');
  writeFileSync(wavPath, wav);
  // Electron's memory cage requires copied samples, including in ELECTRON_RUN_AS_NODE mode.
  const wave = sherpa.readWave(wavPath, false);
  assert.equal(wave.sampleRate, 16_000);
  assert.equal(wave.samples.length, 160);
  check('packaged-sherpa-native-call', { sampleRate: wave.sampleRate, samples: wave.samples.length });

  const { getLlama } = await import(pathToFileURL(appRequire.resolve('node-llama-cpp')).href);
  const llama = await getLlama({ gpu: false, build: 'never', skipDownload: true });
  try {
    assert.equal(llama.gpu, false);
    check('packaged-llama-cpu-binding', { gpu: llama.gpu, electron: process.versions.electron });
  } finally { await llama.dispose(); }

  const ort = appRequire('onnxruntime-node');
  assert.equal(typeof ort.InferenceSession.create, 'function');
  check('packaged-onnxruntime-native-binding');
}

async function main() {
  assert.equal(process.platform, 'win32', 'The native smoke must run on Windows.');
  assert.equal(process.arch, 'x64', 'The native smoke must run in an x64 process.');
  if (process.argv.includes('--native-child')) return nativeChild();

  const executable = path.join(appDir, 'Subline.exe');
  const asarPath = path.join(appDir, 'resources', 'app.asar');
  const unpacked = path.join(appDir, 'resources', 'app.asar.unpacked');
  assert.ok(existsSync(executable), 'Packaged Subline.exe missing');
  assert.ok(existsSync(asarPath), 'Packaged app.asar missing');
  assert.ok(magic(executable).startsWith('4d5a'), 'Subline.exe must be a Windows PE executable');
  for (const name of [
    'node-llama-cpp', '@node-llama-cpp/win-x64', '@node-llama-cpp/win-x64-cuda',
    '@node-llama-cpp/win-x64-cuda-ext', 'sherpa-onnx-node', 'sherpa-onnx-win-x64',
  ]) {
    const packageDir = path.join(unpacked, 'node_modules', name);
    const metadata = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    assert.ok(metadata.version, `Missing version for ${name}`);
    if (name.startsWith('@node-llama-cpp/') || name === 'sherpa-onnx-win-x64') {
      const binaries = [...files(packageDir)].filter(file => /\.(node|dll)$/i.test(file));
      assert.ok(binaries.length > 0, `No prebuilt runtime in ${name}`);
      for (const file of binaries) assert.ok(magic(file).startsWith('4d5a'), `Non-PE native runtime: ${file}`);
      check(`runtime-${name}`, { version: metadata.version, binaries: binaries.length });
    }
  }
  // Resolve from the pinned builder graph instead of relying on a global ASAR command.
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const libRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
  const asar = libRequire('@electron/asar');
  const entries = asar.listPackage(asarPath).map(entry => entry.replaceAll('\\', '/').replace(/^\//, ''));
  const foreign = /(?:@node-llama-cpp\/(?:mac-|linux|win-arm64|win-x64-vulkan)|sherpa-onnx-(?:darwin|linux|win-ia32)|onnxruntime-node\/bin\/napi-v\d+\/(?:darwin|linux|win32\/arm64))/i;
  const privateModule = /(?:^|\/)(?:interview|meeting-pilot)(?:[./-]|$)|codex-app-server/i;
  for (const entry of entries) {
    assert.ok(!foreign.test(entry), `Foreign platform runtime in app.asar: ${entry}`);
    assert.ok(!privateModule.test(entry), `Private module in app.asar: ${entry}`);
    assert.ok(!/\.(?:dylib|so)(?:\.\d+)*$/i.test(entry), `Foreign native library: ${entry}`);
    if (/\.(?:node|dll)$/i.test(entry)) {
      assert.equal(asar.statFile(asarPath, path.normalize(entry)).unpacked, true, `Native runtime trapped in app.asar: ${entry}`);
    }
  }
  const metadata = JSON.parse(asar.extractFile(asarPath, path.normalize('package.json')).toString('utf8'));
  assert.equal(metadata.name, 'subline-windows-candidate');
  assert.equal(metadata.productName, 'Subline');
  check('candidate-metadata', { name: metadata.name, version: metadata.version });

  let inspected = 0;
  for (const file of files(appDir)) {
    const relative = path.relative(appDir, file).replaceAll('\\', '/');
    assert.ok(!foreign.test(relative), `Foreign platform runtime: ${relative}`);
    assert.ok(!privateModule.test(relative), `Private module: ${relative}`);
    const signature = magic(file);
    assert.ok(!['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca', '7f454c46'].includes(signature),
      `Mach-O/ELF binary in Windows candidate: ${relative}`);
    inspected++;
  }
  for (const entry of entries.filter(entry => /^out\/.*\.(?:c?js|html)$/i.test(entry))) {
    const content = asar.extractFile(asarPath, path.normalize(entry)).toString('utf8');
    assert.ok(!/Subline Interview|codex-app-server|interview-bridge|meeting-pilot/.test(content), `Private module code in ${entry}`);
  }
  check('windows-only-native-assets', { inspectedFiles: inspected, archiveEntries: entries.length });

  const child = spawnSync(executable, [
    path.resolve(process.argv[1]), '--native-child', '--app-dir', appDir, '--diagnostics', diagnostics,
  ], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true' },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(path.join(diagnostics, 'native-runtime.log'), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `Packaged native runtime failed; see native-runtime.log (${child.status ?? child.signal})`);
  const nativeReport = JSON.parse(readFileSync(path.join(diagnostics, 'native-child.json'), 'utf8'));
  assert.equal(nativeReport.status, 'passed');
  check('packaged-electron-native-process', { checks: nativeReport.checks });

  const guiReportPath = path.join(diagnostics, 'candidate-gui-smoke.json');
  const guiEnv = { ...process.env, NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true' };
  delete guiEnv.ELECTRON_RUN_AS_NODE;
  const gui = spawnSync(executable, ['--candidate-smoke', guiReportPath, '--disable-gpu'], {
    cwd: appDir, env: guiEnv, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(path.join(diagnostics, 'candidate-gui-smoke.log'), `${gui.stdout ?? ''}\n${gui.stderr ?? ''}`);
  if (gui.error) throw gui.error;
  assert.equal(gui.status, 0, `Packaged GUI smoke failed; see candidate-gui-smoke.log (${gui.status ?? gui.signal})`);
  const guiReport = JSON.parse(readFileSync(guiReportPath, 'utf8'));
  assert.equal(guiReport.status, 'passed');
  check('packaged-electron-gui-settings-archives', { checks: guiReport.checks });
}

try {
  await main();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.stack : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(diagnostics, process.argv.includes('--native-child') ? 'native-child.json' : 'native-smoke.json'),
    `${JSON.stringify(report, null, 2)}\n`);
}
