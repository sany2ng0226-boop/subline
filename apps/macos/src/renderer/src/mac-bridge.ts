// macOS（Electron 渲染层）平台桥接：把 preload 暴露的 window.api（ElectronApi）包装成
// @rt/ui 依赖的平台无关 AppBridge。音频采集（getUserMedia + AudioContext + AudioWorklet）
// 在这里完成——@rt/ui 不再感知浏览器采集细节。
//
// startPipeline：先启动 ASR 子进程（api.startPipeline），就绪后开始采集并经 api.sendAudio 送 PCM。
// stopPipeline：先停采集（停轨 + 关闭 AudioContext），再停 ASR 子进程（api.stopPipeline）。
// 其余方法全部直通 window.api。

import { audioLevel } from '@rt/core';
import type { AppBridge, StartResult, PipelineErrorCode, StatusPayload } from '@rt/core';
import type { ElectronApi } from '@shared/types';

export const CAPTURE_FLUSH_TIMEOUT_MS = 2_000;
type CaptureState = {
  node: AudioWorkletNode;
  accepting: boolean;
  flush?: { id: number; complete: () => void };
};

export function createMacBridge(api: ElectronApi): AppBridge {
  let audioContext: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  const levelListeners = new Set<(level: number) => void>();
  const statusListeners = new Set<(status: StatusPayload) => void>();
  const publishLevel = (level: number) => levelListeners.forEach(cb => cb(level));
  // 重入守卫：正在进行的启动 promise，供并发/重复调用复用，避免双路采集与旧流引用被覆盖泄漏
  let starting: Promise<StartResult> | null = null;
  let stopping: Promise<{ ok: boolean; emptyRecordingIds?: string[] }> | null = null;
  let releasing: Promise<void> | null = null;
  let captureState: CaptureState | null = null;
  let nextFlushId = 0;

  function flushCapture(state: CaptureState): Promise<void> {
    // Older injected hosts and lightweight mocks may not expose a bidirectional port.
    if (typeof state.node.port.postMessage !== 'function') return Promise.resolve();
    const id = ++nextFlushId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.accepting = false;
        state.flush = undefined;
        reject(new Error('Audio capture did not flush its final samples before stopping'));
      }, CAPTURE_FLUSH_TIMEOUT_MS);
      state.flush = { id, complete: () => {
        clearTimeout(timer);
        state.accepting = false;
        state.flush = undefined;
        resolve();
      } };
      try { state.node.port.postMessage({ type: 'flush', id }); }
      catch (error) {
        clearTimeout(timer);
        state.accepting = false;
        state.flush = undefined;
        reject(error);
      }
    });
  }

  function releaseCapture(): Promise<void> {
    if (releasing) return releasing;
    const stream = mediaStream;
    const context = audioContext;
    const state = captureState;
    releasing = (async () => {
      try {
        if (state) await flushCapture(state);
      } finally {
        if (state) state.accepting = false;
        if (captureState === state) captureState = null;
        if (mediaStream === stream) mediaStream = null;
        stream?.getTracks().forEach((track) => track.stop());
        if (audioContext === context) audioContext = null;
        await context?.close().catch(() => undefined);
        publishLevel(0);
      }
    })().finally(() => { releasing = null; });
    return releasing;
  }

  async function stopCaptureAndPipeline(): Promise<{ ok: boolean; emptyRecordingIds?: string[] }> {
    let captureError: Error | undefined;
    try { await releaseCapture(); }
    catch (error) { captureError = error instanceof Error ? error : new Error(String(error)); }
    let result: { ok: boolean; emptyRecordingIds?: string[] };
    try { result = await api.stopPipeline(captureError ? { captureIncomplete: true } : undefined); }
    catch (error) {
      if (captureError) throw new AggregateError([captureError, error], 'Audio capture and recording finalization failed');
      throw error;
    }
    if (captureError) throw captureError;
    if (!result.ok) throw new Error('Recording finalization failed');
    return result;
  }

  function stopPipeline(): Promise<{ ok: boolean; emptyRecordingIds?: string[] }> {
    if (stopping) return stopping;
    publishLevel(0);
    // A stop requested during permission/model setup must also release the eventual capture.
    stopping = (async () => {
      if (starting) await starting.catch(() => undefined);
      return stopCaptureAndPipeline();
    })().finally(() => { stopping = null; });
    return stopping;
  }

  /** 权限类采集失败（用户拒绝 / 未授权）。 */
  function isPermissionError(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'NotAllowedError';
  }

  /**
   * 采集系统音频（loopback）。video 必须请求一个 4×4 的微型轨——Electron 近期版本对 0×0
   * video 的 loopback 会返回静音流，故取一个最小 video 轨规避；拿到流后立即停掉 video 轨，
   * 只保留 audio 轨接入识别链路。
   */
  async function captureSystemAudio(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 4, height: 4, frameRate: 1 },
    });
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('未取得电脑声音，请检查默认播放设备后重试。');
    }
    stream.getVideoTracks().forEach((tr) => tr.stop());
    return stream;
  }

  // 启动采集链路：ASR 子进程就绪后，按设置的音源取麦克风或系统音频，接上 AudioWorklet。
  // 任一步失败则释放已获取的 stream/context 并回滚主进程已 start 的 pipeline，返回
  // { ok: false }（StartResult 契约），避免 unhandled rejection、麦克风指示灯常亮与主进程状态残留。
  async function beginCapture(): Promise<StartResult> {
    const r = await api.startPipeline();
    if (!r.ok) return r;
    const source = r.captureSource ?? (await api.getSettings()).audioSource;
    try {
      mediaStream =
        source === 'system'
          ? await captureSystemAudio()
          : await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      const stream = mediaStream;
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (mediaStream !== stream) return;
          void stopPipeline().catch(() => undefined).finally(() => {
            statusListeners.forEach((listener) => listener({ state: 'error', code: 'audio-interrupted',
              error: '音频输入已中断，请检查播放或输入设备后重新开始。' }));
          });
        }, { once: true });
      }
      const context = new AudioContext({ sampleRate: 16000 });
      audioContext = context;
      await context.audioWorklet.addModule('audio-worklet.js');
      const audioSource = context.createMediaStreamSource(mediaStream);
      const capture = new AudioWorkletNode(context, 'capture-processor');
      const state: CaptureState = { node: capture, accepting: true };
      captureState = state;
      capture.port.onmessage = (e: MessageEvent<Float32Array | { type: 'flushed'; id: number }>) => {
        if (audioContext !== context || mediaStream !== stream || !state.accepting) return;
        if (!(e.data instanceof Float32Array)) {
          if (e.data?.type === 'flushed' && state.flush?.id === e.data.id) state.flush.complete();
          return;
        }
        if (r.captureToken) api.sendAudio(e.data, r.captureToken);
        else api.sendAudio(e.data);
        publishLevel(audioLevel(e.data));
      };
      audioSource.connect(capture);
      return r;
    } catch (err) {
      await stopCaptureAndPipeline().catch(() => undefined);
      const error = err instanceof Error ? err.message : String(err);
      // 系统音频路径：区分「录制权限被拒」与「采集链路建立失败」；麦克风路径沿用原语义。
      if (source === 'system') {
        const code: PipelineErrorCode = isPermissionError(err)
          ? 'system-audio-permission'
          : 'audio-capture-failed';
        return { ok: false, error, code };
      }
      return { ok: false, error, code: isPermissionError(err) ? 'mic-permission' : 'audio-capture-failed' };
    }
  }

  return {
    onAudioLevel(cb) { levelListeners.add(cb); return () => { levelListeners.delete(cb); }; },
    platform: api.platform,
    audioSources: api.audioSources,
    // 构建期注入的发布版本串；define 缺失的环境（如单测导入）下不暴露
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
    async startPipeline() {
      if (stopping) await stopping;
      if (starting) return starting;
      if (mediaStream) return { ok: true }; // 已在采集中，重复调用直接返回
      starting = beginCapture();
      try {
        return await starting;
      } finally {
        starting = null;
      }
    },

    stopPipeline,

    // ===== 以下全部直通 window.api =====
    onShortcut: api.onShortcut ? (cb) => api.onShortcut!(cb) : undefined,
    prewarmPipeline: () => api.prewarmPipeline(),
    getMicStatus: () => api.getMicStatus(),
    openMicSettings: () => api.openMicSettings(),
    openSystemAudioSettings: () => api.openSystemAudioSettings?.(),
    setCloseGuard: (guard) => api.setCloseGuard?.(guard),
    onArchiveBeforeClose: (handler) => api.onArchiveBeforeClose?.(handler) ?? (() => {}),
    setAlwaysOnTop: api.setAlwaysOnTop ? (on) => api.setAlwaysOnTop!(on) : undefined,
    onAlwaysOnTopChange: api.onAlwaysOnTopChange ? (cb) => api.onAlwaysOnTopChange!(cb) : undefined,
    // 崩溃暂存写进宿主的 userData；preload 未提供时留空，UI 回退 localStorage
    saveRecovery: api.saveRecovery ? (json) => api.saveRecovery!(json) : undefined,
    loadRecovery: api.loadRecovery ? () => api.loadRecovery!() : undefined,
    clearRecovery: api.clearRecovery ? () => api.clearRecovery!() : undefined,
    getSettings: () => api.getSettings(),
    saveSettings: (settings) => api.saveSettings(settings),
    testCloud: (cfg) => api.testCloud(cfg),
    getSetupStatus: (modelId) => api.getSetupStatus(modelId),
    downloadAsrModels: (modelId) => api.downloadAsrModels(modelId),
    listModels: () => api.listModels(),
    deleteModel: (kind, id) => api.deleteModel(kind, id),
    cancelModelDownload: (kind, id) => api.cancelModelDownload(kind, id),
    getTranslationSetupStatus: (modelId) => api.getTranslationSetupStatus(modelId),
    downloadTranslationModel: (modelId) => api.downloadTranslationModel(modelId),
    saveArchive: (name, lines, folderId, audioIds) => api.saveArchive(name, lines, folderId, audioIds),
    listUnarchivedRecordings: api.listUnarchivedRecordings ? () => api.listUnarchivedRecordings!() : undefined,
    discardRecordings: api.discardRecordings ? (ids) => api.discardRecordings!(ids) : undefined,
    getArchiveAudioUrl: api.getArchiveAudioUrl ? (archiveId, recordingId) => api.getArchiveAudioUrl!(archiveId, recordingId) : undefined,
    getArchiveLibrary: () => api.getArchiveLibrary!(),
    createArchiveFolder: (name) => api.createArchiveFolder!(name),
    renameArchiveFolder: (id, name) => api.renameArchiveFolder!(id, name),
    updateArchive: (id, patch) => api.updateArchive!(id, patch),
    listArchives: () => api.listArchives(),
    getArchive: (id) => api.getArchive(id),
    deleteArchive: (id) => api.deleteArchive(id),
    onSetupProgress: (cb) => api.onSetupProgress(cb),
    onSegment: (cb) => api.onSegment(cb),
    onPartial: (cb) => api.onPartial(cb),
    onTranslation: (cb) => api.onTranslation(cb),
    onStatus: (cb) => {
      statusListeners.add(cb);
      const unsubscribe = api.onStatus(cb);
      return () => { statusListeners.delete(cb); unsubscribe(); };
    },
    onTranslationStatus: (cb) => api.onTranslationStatus(cb),
  };
}
