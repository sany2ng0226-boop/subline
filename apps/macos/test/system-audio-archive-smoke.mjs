// Synthetic integration only: never calls OS loopback, microphone, ASR, or translation.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Projects/_tool-output/subline-maintenance', new Date().toISOString().replace(/[:.]/g, '-') + '-synthetic-audio'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'subline-synthetic-audio-'));
const profile = path.join(temporary, 'isolated-profile');
const electron = require('electron');
const report = {
  test: 'synthetic-system-audio-archive', synthetic: true, realOSLoopback: false,
  realMicrophone: false, realASR: false, realTranslation: false, installedApplication: false,
  isolatedTemporaryUserData: true, hiddenWindow: true, mutedPlayback: true,
  electronVersion: require('electron/package.json').version,
  startedAt: new Date().toISOString(), phases: [], passed: false,
};
const modulePath = (relative) => JSON.stringify(path.join(repo, relative));

const main = `
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AudioRecordingStore } from ${modulePath('apps/macos/src/main/audio-recordings.ts')};
import { saveArchive, listArchives, getArchive, archivedRecordingIds } from ${modulePath('apps/macos/src/main/archives.ts')};
import { archiveAudioResponse } from ${modulePath('apps/macos/src/main/archive-audio-response.ts')};
const root = process.env.SUBLINE_SMOKE_DIRECTORY;
const phase = process.env.SUBLINE_SMOKE_PHASE;
app.setName('Subline Synthetic Audio Smoke ' + phase);
app.setPath('userData', path.join(root, 'isolated-profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
protocol.registerSchemesAsPrivileged([{ scheme: 'subline-audio', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
const recordings = new AudioRecordingStore(() => path.join(app.getPath('userData'), 'recordings'));
const frames = [];
const requests = [];
let token;
let captureFailure;
let permissionRequests = 0;
let finished = false;
let window;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function finish(result) {
  if (finished) return;
  finished = true;
  await recordings.finish().catch(() => {});
  await fs.writeFile(path.join(root, phase + '.json'), JSON.stringify({
    phase, pid: process.pid, permissionRequests, protocolRequests: requests, ...result,
  }, null, 2));
  app.exit(result.passed ? 0 : 1);
}
ipcMain.handle('smoke:start', async () => {
  const start = await recordings.start();
  token = randomUUID();
  return { ok: true, recordingId: start.id, captureSource: 'system', captureToken: token };
});
ipcMain.on('smoke:audio', (_event, samples, suppliedToken) => {
  try {
    assert(suppliedToken === token, 'Capture token did not stay bound to the recording');
    assert(samples instanceof Float32Array, 'Audio IPC did not preserve Float32 PCM');
    frames.push(samples.length);
    recordings.append(samples);
  } catch (error) { captureFailure = error; }
});
ipcMain.handle('smoke:stop', async () => {
  await recordings.finish();
  token = undefined;
  if (captureFailure) throw captureFailure;
  window.webContents.send('smoke:status', { state: 'stopped' });
  return { ok: true };
});
ipcMain.handle('smoke:settings', () => ({ audioSource: 'mic' }));
ipcMain.handle('smoke:save', async (_event, name, lines, folderId, audioIds) => {
  const audio = await recordings.resolve(audioIds);
  return saveArchive(name, lines, Date.now(), folderId, audio);
});
ipcMain.handle('smoke:archives', () => listArchives());
ipcMain.handle('smoke:get-archive', () => {
  const summaries = listArchives();
  assert(summaries.length === 1, 'Expected one archive after reopening in another process');
  const archive = getArchive(summaries[0].id);
  assert(archive.lines.length === 0 && archive.audio?.length === 1, 'Audio-only archive did not survive restart');
  return archive;
});
ipcMain.handle('smoke:audio-url', (_event, archiveId, recordingId) => {
  assert(getArchive(archiveId)?.audio?.some(audio => audio.id === recordingId), 'Audio is not attached to this archive');
  return 'subline-audio://archive/' + archiveId + '/' + recordingId;
});
ipcMain.handle('smoke:done', async (_event, renderer) => {
  try {
    assert(permissionRequests === 0, 'Unexpected native capture permission request');
    const summaries = listArchives();
    assert(summaries.length === 1, 'Expected exactly one saved archive');
    const archive = getArchive(summaries[0].id);
    assert(archive.lines.length === 0, 'Fixture unexpectedly created ASR captions');
    assert(archive.audio?.length === 1, 'Audio attachment was not persisted');
    const attachment = archive.audio[0];
    await recordings.resolve([attachment.id]);
    if (phase === 'record') {
      assert(frames.length > 1 && frames.at(-1) > 0 && frames.at(-1) < 2048, 'Worklet final partial frame was not flushed');
      const wav = await fs.readFile(recordings.pathFor(attachment.id));
      const pcmBytes = wav.readUInt32LE(40);
      assert(frames.reduce((sum, length) => sum + length, 0) * 2 === pcmBytes, 'Some accepted PCM samples were lost before WAV finalization');
      let peak = 0;
      for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
      assert(peak > 100, 'Synthetic oscillator produced no nonzero recorded audio');
      assert(attachment.durationMs >= 1000, 'Less than one second of PCM was recorded');
      const unarchived = (await recordings.list()).filter(audio => !archivedRecordingIds().has(audio.id));
      assert(unarchived.length === 0, 'Saved original audio was left in the unarchived set');
      await finish({ passed: true, renderer, archiveLineCount: archive.lines.length,
        attachment, pcmSamples: pcmBytes / 2, frames: frames.length, tailSamples: frames.at(-1), peakPCM16: peak,
        unarchivedAfterSave: unarchived.length });
    } else {
      assert(requests.some(request => request.status === 206), 'Playback did not exercise real protocol range serving');
      await finish({ passed: true, renderer, archiveLineCount: archive.lines.length, attachment });
    }
  } catch (error) { await finish({ passed: false, error: String(error), stack: error.stack }); }
});
ipcMain.on('smoke:fail', (_event, error) => { void finish({ passed: false, error }); });
app.whenReady().then(async () => {
  app.dock?.hide();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => { permissionRequests++; callback(false); });
  protocol.handle('subline-audio', async request => {
    const response = await archiveAudioResponse(request, (archiveId, recordingId) => {
      if (!getArchive(archiveId)?.audio?.some(audio => audio.id === recordingId)) return null;
      return recordings.pathFor(recordingId);
    });
    requests.push({ method: request.method, range: request.headers.get('range'), status: response.status,
      contentType: response.headers.get('content-type'), contentRange: response.headers.get('content-range') });
    return response;
  });
  window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'preload.cjs'), contextIsolation: true, sandbox: false,
    nodeIntegration: false, backgroundThrottling: false,
  } });
  window.webContents.on('render-process-gone', (_event, details) => { void finish({ passed: false, error: 'Renderer exited: ' + details.reason }); });
  await window.loadFile(path.join(root, 'fixture.html'), { query: { phase } });
}).catch(error => { void finish({ passed: false, error: String(error), stack: error.stack }); });
setTimeout(() => { void finish({ passed: false, error: 'Hidden Electron synthetic fixture exceeded 20 seconds' }); }, 20000).unref();
`;

const preload = `
const { contextBridge, ipcRenderer } = require('electron');
const noEvents = () => () => {};
contextBridge.exposeInMainWorld('smoke', {
  platform: 'macos', audioSources: ['system', 'mic'],
  startPipeline: () => ipcRenderer.invoke('smoke:start'),
  stopPipeline: () => ipcRenderer.invoke('smoke:stop'),
  sendAudio: (samples, token) => ipcRenderer.send('smoke:audio', samples, token),
  getSettings: () => ipcRenderer.invoke('smoke:settings'),
  saveArchive: (...args) => ipcRenderer.invoke('smoke:save', ...args),
  listArchives: () => ipcRenderer.invoke('smoke:archives'),
  getSmokeArchive: () => ipcRenderer.invoke('smoke:get-archive'),
  getArchiveAudioUrl: (...args) => ipcRenderer.invoke('smoke:audio-url', ...args),
  onStatus: cb => { const listener = (_event, value) => cb(value); ipcRenderer.on('smoke:status', listener); return () => ipcRenderer.removeListener('smoke:status', listener); },
  onSegment: noEvents, onPartial: noEvents, onTranslation: noEvents, onTranslationStatus: noEvents,
  done: result => ipcRenderer.invoke('smoke:done', result),
  fail: error => ipcRenderer.send('smoke:fail', error),
});
`;

const renderer = `
import { createMacBridge } from ${modulePath('apps/macos/src/renderer/src/mac-bridge.ts')};
import { setBridge } from ${modulePath('packages/ui/src/bridge.ts')};
import { startRecording, recording, recordingIds, lines, hasUnsavedContent } from ${modulePath('packages/ui/src/composables/useTranscription.ts')};
import { archiveSession } from ${modulePath('packages/ui/src/composables/useSessionArchive.ts')};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function event(target, name, action, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for ' + name)); }, timeout);
    const success = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Media error during ' + name + ': ' + (target.error?.message ?? 'unknown'))); };
    function cleanup() { clearTimeout(timer); target.removeEventListener(name, success); target.removeEventListener('error', fail); }
    target.addEventListener(name, success, { once: true }); target.addEventListener('error', fail, { once: true });
    action();
  });
}
async function run() {
  const phase = new URL(location.href).searchParams.get('phase');
  if (phase === 'record') {
    let microphoneCalls = 0;
    let syntheticDisplayCalls = 0;
    let oscillatorContext;
    let oscillator;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      microphoneCalls++; throw new Error('Native microphone access is forbidden in this synthetic fixture');
    } });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      syntheticDisplayCalls++;
      oscillatorContext = new AudioContext({ sampleRate: 16000 });
      const destination = oscillatorContext.createMediaStreamDestination();
      oscillator = oscillatorContext.createOscillator();
      oscillator.frequency.value = 440;
      const gain = oscillatorContext.createGain(); gain.gain.value = 0.08;
      oscillator.connect(gain).connect(destination);
      oscillator.start(); await oscillatorContext.resume();
      return destination.stream;
    } });
    let nextFullFrame;
    setBridge(createMacBridge({ ...window.smoke, sendAudio: (samples, token) => {
      window.smoke.sendAudio(samples, token);
      if (samples.length === 2048 && nextFullFrame) {
        const complete = nextFullFrame; nextFullFrame = undefined; complete();
      }
    } }));
    const started = performance.now();
    await startRecording();
    assert(recording.value && recordingIds.length === 1 && lines.length === 0 && hasUnsavedContent.value, 'Audio-only UI session was not marked unsaved');
    await sleep(1200);
    // Stop just after a full block, so this also exercises a nonempty worklet tail.
    await new Promise(resolve => { nextFullFrame = resolve; });
    await sleep(29);
    // This invokes the production UI stop barrier and four-argument audio-aware save.
    await archiveSession('Synthetic oscillator audio only');
    oscillator.stop(); await oscillatorContext.close();
    assert(microphoneCalls === 0 && syntheticDisplayCalls === 1, 'Capture source drifted to microphone settings');
    assert(!recording.value && recordingIds.length === 0 && lines.length === 0 && !hasUnsavedContent.value, 'Successful audio-only archive did not clear UI session state');
    await window.smoke.done({ microphoneCalls, syntheticDisplayCalls, wallMs: Math.round(performance.now() - started),
      productionUIStart: true, productionUIArchiveSession: true, audioOnlyUnsavedGuard: true, clearedAfterSave: true });
    return;
  }
  const archive = await window.smoke.getSmokeArchive();
  const attachment = archive.audio[0];
  const url = await window.smoke.getArchiveAudioUrl(archive.id, attachment.id);
  const audio = document.createElement('audio');
  audio.controls = true; audio.muted = true; audio.volume = 0; audio.preload = 'auto';
  document.body.append(audio);
  await event(audio, 'loadedmetadata', () => { audio.src = url; audio.load(); });
  assert(Number.isFinite(audio.duration) && audio.duration >= 1, 'Browser did not decode the persisted WAV');
  await audio.play(); await sleep(240);
  const firstTime = audio.currentTime;
  assert(firstTime > 0.05, 'Muted playback clock did not advance');
  audio.pause();
  const seekTarget = audio.duration * 0.55;
  await event(audio, 'seeked', () => { audio.currentTime = seekTarget; });
  assert(Math.abs(audio.currentTime - seekTarget) < 0.1, 'Native audio element seek failed');
  await audio.play(); await sleep(180);
  const afterSeek = audio.currentTime;
  audio.pause();
  assert(afterSeek > seekTarget + 0.04, 'Muted playback did not advance after seeking');
  await window.smoke.done({ freshProcessReopen: true, htmlAudioElement: true, decodedDurationSeconds: audio.duration,
    muted: audio.muted && audio.volume === 0, firstPlaybackTime: firstTime, seekTarget, afterSeekTime: afterSeek,
    readyState: audio.readyState, mediaError: audio.error?.message ?? null });
}
run().catch(error => window.smoke.fail(String(error) + '\\n' + (error.stack ?? '')));
`;

async function phase(name) {
  const environment = { ...process.env, SUBLINE_SMOKE_DIRECTORY: temporary, SUBLINE_SMOKE_PHASE: name };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve) => {
    const child = spawn(electron, [path.join(temporary, 'main.cjs')], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { stderr += String(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  await fs.writeFile(path.join(output, name + '.runtime.log'), result.stdout + result.stderr);
  let details;
  try { details = JSON.parse(await fs.readFile(path.join(temporary, name + '.json'), 'utf8')); }
  catch { details = { phase: name, passed: false, error: 'Electron did not produce a phase result' }; }
  return { ...details, processExitCode: result.code, processExitSignal: result.signal };
}

try {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  await build({ stdin: { contents: main, loader: 'ts', resolveDir: repo, sourcefile: 'synthetic-main.ts' },
    outfile: path.join(temporary, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  await build({ stdin: { contents: renderer, loader: 'ts', resolveDir: repo, sourcefile: 'synthetic-renderer.ts' },
    outfile: path.join(temporary, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
    define: { __INTERNAL_BUILD__: 'false' } });
  await fs.writeFile(path.join(temporary, 'preload.cjs'), preload);
  await fs.writeFile(path.join(temporary, 'fixture.html'), '<!doctype html><meta charset="utf-8"><title>Synthetic audio smoke</title><script defer src="renderer.js"></script>');
  await fs.copyFile(path.join(repo, 'apps/macos/src/renderer/public/audio-worklet.js'), path.join(temporary, 'audio-worklet.js'));
  const recorded = await phase('record');
  report.phases.push(recorded);
  if (recorded.passed && recorded.processExitCode === 0) {
    const playback = await phase('playback');
    report.phases.push(playback);
    report.passed = playback.passed && playback.processExitCode === 0 && recorded.pid !== playback.pid;
  }
} catch (error) {
  report.error = String(error);
  report.stack = error.stack;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, synthetic: true, phases: report.phases.map(({ phase, passed, error }) => ({ phase, passed, error })),
  report: path.join(output, 'report.json') }));
process.exitCode = report.passed ? 0 : 1;
