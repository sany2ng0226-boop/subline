// macOS（Electron 渲染层）平台桥接：把 preload 暴露的 window.api（ElectronApi）包装成
// @rt/ui 依赖的平台无关 AppBridge。音频采集（getUserMedia + AudioContext + AudioWorklet）
// 在这里完成——@rt/ui 不再感知浏览器采集细节。
//
// startPipeline：先启动 ASR 子进程（api.startPipeline），就绪后开始采集并经 api.sendAudio 送 PCM。
// stopPipeline：先停采集（停轨 + 关闭 AudioContext），再停 ASR 子进程（api.stopPipeline）。
// 其余方法全部直通 window.api。

import { audioLevel, withArchiveOperation } from '@rt/core';
import type { AppBridge, StartResult, PipelineErrorCode, StatusPayload } from '@rt/core';
import type { ElectronApi } from '@shared/types';

export function createMacBridge(api: ElectronApi): AppBridge {
  let audioContext: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  const levelListeners = new Set<(level: number) => void>();
  const statusListeners = new Set<(status: StatusPayload) => void>();
  const publishLevel = (level: number) => levelListeners.forEach(cb => cb(level));
  // 重入守卫：正在进行的启动 promise，供并发/重复调用复用，避免双路采集与旧流引用被覆盖泄漏
  let starting: Promise<StartResult> | null = null;

  async function releaseCapture(): Promise<void> {
    const stream = mediaStream;
    mediaStream = null;
    stream?.getTracks().forEach((track) => track.stop());
    const context = audioContext;
    audioContext = null;
    await context?.close().catch(() => undefined);
    publishLevel(0);
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
    const source = (await api.getSettings()).audioSource;
    try {
      mediaStream =
        source === 'system'
          ? await captureSystemAudio()
          : await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      for (const track of mediaStream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (!mediaStream) return;
          void releaseCapture().then(() => api.stopPipeline()).catch(() => undefined).finally(() => {
            statusListeners.forEach((listener) => listener({ state: 'error', code: 'audio-interrupted',
              error: '音频输入已中断，请检查播放或输入设备后重新开始。' }));
          });
        }, { once: true });
      }
      audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.audioWorklet.addModule('audio-worklet.js');
      const audioSource = audioContext.createMediaStreamSource(mediaStream);
      const capture = new AudioWorkletNode(audioContext, 'capture-processor');
      capture.port.onmessage = (e: MessageEvent<Float32Array>) => {
        api.sendAudio(e.data);
        publishLevel(audioLevel(e.data));
      };
      audioSource.connect(capture);
      return r;
    } catch (err) {
      await releaseCapture();
      await api.stopPipeline();
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
      if (starting) return starting;
      if (mediaStream) return { ok: true }; // 已在采集中，重复调用直接返回
      starting = beginCapture();
      try {
        return await starting;
      } finally {
        starting = null;
      }
    },

    async stopPipeline() {
      publishLevel(0);
      // 等在途启动先完成再拆除：保证「stop 晚于 start 调用」必然「stop 晚于 start 生效」，
      // 不会在 beginCapture 取到麦克风前拆了个寂寞、留下持续采集的流。
      if (starting) {
        await starting.catch(() => undefined);
      }
      await releaseCapture();
      return api.stopPipeline();
    },

    // ===== 以下全部直通 window.api =====
    prewarmPipeline: () => api.prewarmPipeline(),
    getPermission: api.getPermission,
    onPermissionChange: api.onPermissionChange,
    openPermissionSettings: api.openPermissionSettings,
    relaunchApp: api.relaunchApp,
    getMicStatus: () => api.getMicStatus(),
    openMicSettings: () => api.openPermissionSettings?.('microphone'),
    openSystemAudioSettings: () => api.openPermissionSettings?.('systemAudio'),
    setCloseGuard: (guard) => api.setCloseGuard?.(guard),
    onArchiveBeforeClose: (handler) => api.onArchiveBeforeClose?.(handler) ?? (() => {}),
    setAlwaysOnTop: api.setAlwaysOnTop ? (on) => api.setAlwaysOnTop!(on) : undefined,
    onAlwaysOnTopChange: api.onAlwaysOnTopChange ? (cb) => api.onAlwaysOnTopChange!(cb) : undefined,
    isOverlayWindow: () => window.location.hash === '#overlay',
    openOverlay: () => api.openOverlay!(),
    closeOverlay: () => api.closeOverlay!(),
    setOverlayClickThrough: (on) => api.setOverlayClickThrough!(on),
    onOverlayState: (cb) => api.onOverlayState!(cb),
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
    saveRecovery: (json) => api.saveRecovery!(json),
    loadRecovery: () => api.loadRecovery!(),
    clearRecovery: () => api.clearRecovery!(),
    saveArchive: (name, lines, folderId) => withArchiveOperation('save', undefined, () => api.saveArchive(name, lines, folderId)),
    getArchiveLibrary: () => withArchiveOperation('load', undefined, () => api.getArchiveLibrary!()),
    createArchiveFolder: (name) => withArchiveOperation('save', undefined, () => api.createArchiveFolder!(name)),
    renameArchiveFolder: (id, name) => withArchiveOperation('rename', id, () => api.renameArchiveFolder!(id, name)),
    updateArchive: (id, patch) => withArchiveOperation('rename', id, () => api.updateArchive!(id, patch)),
    listArchives: () => withArchiveOperation('load', undefined, () => api.listArchives()),
    getArchive: (id) => withArchiveOperation('open', id, () => api.getArchive(id)),
    deleteArchive: (id) => withArchiveOperation('delete', id, () => api.deleteArchive(id)),
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
