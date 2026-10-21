// iOS（Capacitor）平台桥接：实现 @rt/core 的 AppBridge，注入给 @rt/ui。
//
// 各能力来源：
//  - 设置 / 归档持久化：@capacitor/preferences（异步 KV），纯逻辑复用 @rt/core
//    （makeDefaults / withDefaults / listSummaries / makeArchiveId / toSummary）。
//  - ASR：原生 Capacitor 插件 RealtimeAsr（sherpa-onnx 端上识别 + AVAudioEngine 采集），
//    通过 'partial' / 'segment' / 'status' 事件回吐；startPipeline/stopPipeline 即启停整个会话
//    （含原生采麦），无需 JS 侧送音频。
//  - 翻译：segment 到达且开启翻译时翻成母语并触发 onTranslation，两种引擎：
//    · engine==='cloud'  → JS 侧 @rt/core CloudTranslator（WebView 内 fetch）。
//    · 否则（设备端）     → 原生插件 RealtimeTranslate（Apple Translation 框架，iOS 18+，离线）。
//      不可用（iOS<18 / 不支持语言对 / 语言包缺失）时发 translation:status error 提示改用云翻译。
//    繁體等目标脚本后处理沿用 M2M100_SPEC.toScript（两条路径一致）。
//
// 实现 vs 桩：
//  - 已实现（纯 JS，可在此环境验证类型 + 打包）：设置、归档、云翻译、事件转发、回调注册。
//  - 依赖原生插件（此环境无 iOS 工具链，未编译/未运行）：startPipeline / stopPipeline /
//    getMicStatus / openMicSettings / getSetupStatus / downloadAsrModels / listModels /
//    deleteModel。无原生壳时（如纯浏览器预览）这些调用会 reject，桥接已做兜底，不会崩 UI。

import { forwardRayNeoText } from './rayneo-forwarder';
import { Preferences } from '@capacitor/preferences';
import {
  ArchiveOperationError,
  withArchiveOperation,
  makeDefaults,
  withDefaults,
  listSummaries,
  makeArchiveId,
  CloudTranslator,
  MetricsAggregator,
  M2M100_SPEC,
  translateFinalizedSegment,
  createReverseTranslationContext,
  resetReverseTranslationContext,
  createCallbackHub,
  DEFAULT_ASR_MODEL_ID,
  getAsrModel,
} from '@rt/core';
import type {
  AppBridge,
  PipelineMetrics,
  AppSettings,
  ArchiveLine,
  ArchiveRecord,
  ArchiveSummary,
  CloudTranslationConfig,
  StartResult,
  MicPermission,
  ModelInfo,
  ModelKind,
  SetupStatus,
  SetupProgress,
  SegmentPayload,
  PartialPayload,
  TranslationPayload,
  StatusPayload,
  TranslationStatusPayload,
} from '@rt/core';
import { RealtimeAsr, RealtimeTranslate } from '../native-plugin';

const SETTINGS_KEY = 'realtime-translator.settings';
const ARCHIVES_KEY = 'realtime-translator.archives';

// iOS 平台收敛：不支持系统音频（音源恒为麦克风）；asr.model 若不在 iOS 支持列表内则回落默认模型
// （registry 里 platforms 不含 'ios' 的模型在本端不可用）。所有产出 settings 的路径（读/写）统一
// 经此收口，保证 getSettings 与启动/预热热路径看到的音源与模型一致。
function applyPlatformConstraints(s: AppSettings): AppSettings {
  s.audioSource = 'mic';
  if (!getAsrModel(s.asr.model)?.platforms.includes('ios')) {
    s.asr.model = DEFAULT_ASR_MODEL_ID;
  }
  return s;
}

export function createIosBridge(): AppBridge {
  // —— UI 注册的回调（mountApp → registerTranscriptionListeners 时注入） ——
  const segmentCb = createCallbackHub<SegmentPayload>();
  const partialCb = createCallbackHub<PartialPayload>();
  const translationCb = createCallbackHub<TranslationPayload>();
  const statusCb = createCallbackHub<StatusPayload>();
  const translationStatusCb = createCallbackHub<TranslationStatusPayload>();
  const setupProgressCb = createCallbackHub<SetupProgress>();

  // —— 缓存设置：翻译热路径（segment 到达）同步读开关/引擎/母语，免得每段都 await KV。
  //    翻译开关就是 cachedSettings.translation.enabled，改后即时生效并落盘，不再另存一份布尔。 ——
  let cachedSettings: AppSettings | null = null;

  const metrics = new MetricsAggregator();
  const metricsCb = createCallbackHub<PipelineMetrics>();
  let metricsTimer: ReturnType<typeof setInterval> | undefined;
  let metricsSession = 0;
  let cloudRttMs: number | undefined;
  let cloudDegraded = false;
  let cloudGeneration = 0;
  let cloudConfigKey: string | undefined;

  function syncCloudMetricsConfig(settings: AppSettings): void {
    const { engine, enabled, cloud } = settings.translation;
    const key = JSON.stringify([engine, enabled, cloud.baseURL]);
    if (key !== cloudConfigKey) {
      cloudConfigKey = key;
      cloudGeneration++;
      cloudRttMs = undefined;
      cloudDegraded = false;
    }
  }

  // WebView connectivity uses the browser signal, not native NWPathMonitor.
  // Cloud RTT is the full translation request duration, including server inference.
  function emitMetrics(): void {
    if (metricsTimer === undefined) return;
    const cloud = cachedSettings?.translation.enabled && cachedSettings.translation.engine === 'cloud';
    metricsCb.emit({
      ...metrics.snapshot(),
      network: !navigator.onLine ? 'offline' : cloud && cloudDegraded ? 'degraded' : 'online',
      engine: cloud ? 'cloud' : 'local',
      ...(cloud && cloudRttMs !== undefined ? { cloudRttMs } : {}),
    });
  }

  function stopMetrics(): void {
    if (metricsTimer !== undefined) clearInterval(metricsTimer);
    metricsTimer = undefined;
    window.removeEventListener('online', emitMetrics);
    window.removeEventListener('offline', emitMetrics);
  }

  function startMetrics(): void {
    if (metricsTimer !== undefined) return;
    metricsTimer = setInterval(emitMetrics, 1000);
    window.addEventListener('online', emitMetrics);
    window.addEventListener('offline', emitMetrics);
  }

  function emitTranslationMetrics(payload: TranslationPayload, session: number): void {
    if (session === metricsSession) {
      const id = String(payload.id);
      if (payload.pending) metrics.requested(id, payload.requestedAt ?? Date.now());
      else if (!payload.partial) {
        if (payload.requestedAt !== undefined) metrics.requested(id, payload.requestedAt);
        metrics.completed(id, Date.now(), payload.failed);
      }
    }
    translationCb.emit(payload);
  }

  async function translateCloud(
    config: CloudTranslationConfig,
    text: string,
    options: { source: string; target: string },
    session: number,
  ): Promise<string> {
    const generation = cloudGeneration;
    const startedAt = Date.now();
    try {
      const result = await new CloudTranslator(config).translate(text, options);
      if (session === metricsSession && generation === cloudGeneration) {
        cloudRttMs = Date.now() - startedAt;
        cloudDegraded = false;
      }
      return result;
    } catch (error) {
      if (session === metricsSession && generation === cloudGeneration) cloudDegraded = true;
      throw error;
    }
  }


  // ---- 持久化：设置 ----
  async function readSettings(): Promise<AppSettings> {
    const defaults = makeDefaults(navigator.languages ? [...navigator.languages] : []);
    const { value } = await Preferences.get({ key: SETTINGS_KEY });
    let raw: unknown = null;
    if (value) {
      try {
        raw = JSON.parse(value);
      } catch {
        raw = null;
      }
    }
    cachedSettings = applyPlatformConstraints(withDefaults(raw, defaults));
    syncCloudMetricsConfig(cachedSettings);
    return cachedSettings;
  }

  // 写设置：补齐/校验后落盘并刷新缓存。所有写入路径（保存设置、切翻译开关）都走这里。
  async function writeSettings(next: AppSettings): Promise<AppSettings> {
    cachedSettings = applyPlatformConstraints(withDefaults(next, makeDefaults([])));
    syncCloudMetricsConfig(cachedSettings);
    await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(cachedSettings) });
    return cachedSettings;
  }

  // 首次读取去重：启动预读与 UI 首次 getSettings() 并发触发，共享同一次 Preferences 读；
  // 读完即释放，之后再调用会重新读盘（保存后仍能拿到最新值）。
  let readInFlight: Promise<AppSettings> | null = null;
  function readSettingsOnce(): Promise<AppSettings> {
    if (!readInFlight) {
      readInFlight = readSettings().finally(() => {
        readInFlight = null;
      });
    }
    return readInFlight;
  }

  // ---- 持久化：归档 ----
  async function readArchives(): Promise<ArchiveRecord[]> {
    const { value } = await Preferences.get({ key: ARCHIVES_KEY });
    if (value === null) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new SyntaxError('Invalid archive storage');
    return parsed as ArchiveRecord[];
  }

  async function writeArchives(records: ArchiveRecord[]): Promise<void> {
    await Preferences.set({ key: ARCHIVES_KEY, value: JSON.stringify(records) });
  }

  // 反向翻译会话状态：识别语言为 auto 时，听到母语的段翻成上一次识别到的外语；每次开始录音清空（见 startPipeline）。
  const reverseCtx = createReverseTranslationContext();

  // ---- 翻译：segment 到达时按当前设置翻成母语（识别语言为 auto 时母语段反向翻成上一次的外语）。
  //      编排（是否翻 / pending / 字形归一化 / 错误上报）统一在 @rt/core.translateFinalizedSegment，
  //      三端一致；这里只注入引擎调用：设备端 Apple Translation（iOS 18+）或云端 CloudTranslator。 ----
  async function translateSegment(seg: SegmentPayload): Promise<void> {
    const session = metricsSession;
    const s = cachedSettings ?? (await readSettingsOnce());
    await translateFinalizedSegment({
      spec: M2M100_SPEC,
      segment: seg,
      enabled: s.translation.enabled,
      nativeLang: s.nativeLang,
      asrLanguage: s.asr.language,
      reverse: reverseCtx,
      translate: async (req) => {
        if (s.translation.engine !== 'cloud') {
          // 设备端翻译：原生框架只认模型短码；不可用/空结果按失败抛出（提示改用云翻译），
          // 繁體等字形归一化由编排层的 toScript 兜底。
          const r = await RealtimeTranslate.translate({
            text: req.text,
            source: req.source,
            target: req.targetCode,
          });
          if (r.unavailable || !r.text) {
            throw new Error(
              `On-device translation unavailable (${r.reason ?? 'unknown'}); switch to cloud translation in settings.`,
            );
          }
          return r.text;
        }
        // 云端传母语 app 语言键（en/ja/ko/zh），让 LLM 直接产出母语文本。
        return translateCloud(s.translation.cloud, req.text, {
          source: req.source,
          target: req.targetLang,
        }, session);
      },
      emitTranslation: (p) => emitTranslationMetrics(p, session),
    });
  }

  // ---- 订阅原生 ASR 插件事件，转发给 UI 注册的回调 ----
  // 纯浏览器预览（无原生壳）下 addListener 会 reject，吞掉即可，不影响 UI 挂载。
  // 行 id 由桥接层统一分配，跨录音会话单调递增：原生每次 start 都把 segmentId 归零、其 id 从 0 计数，
  // 而 UI 的行与译文回填都按 id 对应，必须全局唯一，故在此改写后再上抛。翻译编排（translateSegment
  // → translateFinalizedSegment）也用改写后的 id，保证译文/等待动画事件回填到当前会话的正确行。
  let nextLineId = 0;
  function subscribeNative(): void {
    void RealtimeAsr.addListener('partial', (p) => { partialCb.emit(p); void forwardRayNeoText(p.text, false); }).catch(() => undefined);
    void RealtimeAsr.addListener('segment', (seg) => {
      // Native events expose no capture epoch; receipt is the closest available endpoint.
      const line: SegmentPayload = { ...seg, id: nextLineId++ };
      line.speechEndAt ??= Date.now();
      // Missing capture timestamps cannot provide a meaningful ASR latency sample.
      metrics.segment(seg.speechEndAt, Date.now());
      segmentCb.emit(line);
      void forwardRayNeoText(line.text, true);
      void translateSegment(line);
    }).catch(() => undefined);
    void RealtimeAsr.addListener('status', (s) => {
      if (s.state === 'running') startMetrics();
      else if (s.state === 'stopped' || s.state === 'error') stopMetrics();
      statusCb.emit(s);
    }).catch(() => undefined);
    void RealtimeAsr.addListener('setupProgress', (p) => setupProgressCb.emit(p)).catch(
      () => undefined,
    );
  }
  subscribeNative();

  // ---- MicPermission 归一化（原生返回的字符串 → @rt/core 联合类型） ----
  function asMicPermission(v: string): MicPermission {
    return v === 'granted' ||
      v === 'denied' ||
      v === 'restricted' ||
      v === 'not-determined'
      ? v
      : 'unknown';
  }

  // 取当前 ASR 设置（模型 + 识别语言），供启动/预热透传给原生。缓存未就绪时读盘一次。
  async function currentAsrOptions(): Promise<{ modelId: string; language: string }> {
    const s = cachedSettings ?? (await readSettingsOnce());
    return { modelId: s.asr.model, language: s.asr.language };
  }

  const api: AppBridge = {
    // iOS 平台标识：UI 据此按平台过滤可用模型、决定音源开关等。
    platform: 'ios',
    // 不声明 audioSources → UI 视为仅 ['mic']（iOS 不支持系统音频），不渲染音源开关。
    // 构建期注入的发布版本串；define 缺失的环境（如单测导入）下不暴露
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,

    // ===== ASR 管线（原生）=====
    async startPipeline(): Promise<StartResult> {
      metricsSession++;
      metrics.reset();
      cloudRttMs = undefined;
      cloudDegraded = false;
      resetReverseTranslationContext(reverseCtx); // 外语历史只在本次会话内有效
      try {
        const r = await RealtimeAsr.start(await currentAsrOptions());
        if (!r.ok) stopMetrics();
        return { ok: r.ok, error: r.error };
      } catch (e) {
        stopMetrics();
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    prewarmPipeline(): void {
      // 进主界面即后台装载当前 ASR 模型（不采麦、不申请权限）：fire-and-forget。
      // UI 在调用前先行禁用录音按钮、等终态 status 解禁；原生侧保证一切路径以终态收尾，
      // 调用本身 reject（纯浏览器预览无原生壳）时由这里补发 stopped，避免按钮永久禁用。
      void currentAsrOptions()
        .then((opts) => RealtimeAsr.prewarm(opts))
        .catch(() => statusCb.emit({ state: 'stopped' }));
    },
    async stopPipeline(): Promise<{ ok: boolean }> {
      stopMetrics();
      try {
        return await RealtimeAsr.stop();
      } catch {
        return { ok: false };
      }
    },
    // ===== 麦克风权限（原生）=====
    async getMicStatus(): Promise<MicPermission> {
      try {
        const r = await RealtimeAsr.getMicStatus();
        return asMicPermission(r.status);
      } catch {
        return 'unknown';
      }
    },
    getPermission: async (kind) => kind === 'microphone' ? api.getMicStatus() : 'unknown',
    onPermissionChange(cb) {
      let disposed = false;
      const handle = RealtimeAsr.addListener('permissionChange', ({ kind, state }) => {
        if (!disposed) cb(kind, state);
      }).catch(() => undefined);
      return () => {
        disposed = true;
        void handle.then((listener) => listener?.remove());
      };
    },
    openPermissionSettings(kind): void {
      if (kind === 'microphone') void RealtimeAsr.openPermissionSettings().catch(() => undefined);
    },
    openMicSettings(): void {
      api.openPermissionSettings?.('microphone');
    },

    // ===== 设置（Preferences）=====
    getSettings(): Promise<AppSettings> {
      return readSettingsOnce();
    },
    saveSettings(settings: AppSettings): Promise<AppSettings> {
      return writeSettings(settings);
    },
    async testCloud(cfg: CloudTranslationConfig): Promise<{ ok: boolean; error?: string }> {
      // 真打一次最小翻译请求验证端点/密钥/模型；source≠target 避免被同语言短路直接返回原文。
      try {
        await new CloudTranslator(cfg).translate('hello', { source: 'en', target: 'ja' });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    // ===== 首次安装 / 模型下载（原生）=====
    async getSetupStatus(modelId: string): Promise<SetupStatus> {
      try {
        return await RealtimeAsr.getSetupStatus({ modelId });
      } catch {
        // 无原生壳（纯浏览器预览）：当作就绪，避免卡在首启引导。
        return { asrReady: true };
      }
    },
    async downloadAsrModels(modelId: string): Promise<{ ok: boolean; error?: string }> {
      try {
        return await RealtimeAsr.downloadModels({ modelId });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    // ===== 模型管理（原生）=====
    // iOS 只有 ASR 模型可自行下载/删除；翻译走 Apple Translation（语言包由系统管理），故不返回翻译条目
    //（模型管理页翻译分组为空则不渲染）。inUse 由此处按当前设置的 asr.model 判定，原生只给磁盘状态。
    async listModels(): Promise<ModelInfo[]> {
      const s = cachedSettings ?? (await readSettingsOnce());
      try {
        const { models } = await RealtimeAsr.listModels();
        return models.map((m) => ({
          kind: 'asr' as ModelKind,
          id: m.id,
          sizeBytes: m.sizeBytes,
          downloaded: m.downloaded,
          inUse: m.id === s.asr.model,
        }));
      } catch {
        // 无原生壳（纯浏览器预览）：无本地模型信息可列。
        return [];
      }
    },
    async deleteModel(kind: ModelKind, id: string): Promise<{ ok: boolean; error?: string }> {
      // 翻译语言包由系统管理，iOS 无可删的翻译模型（listModels 也不会返回翻译条目）。
      if (kind !== 'asr') {
        return { ok: false, error: 'no deletable translation models on iOS' };
      }
      try {
        return await RealtimeAsr.deleteModel({ id });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async cancelModelDownload(kind: ModelKind, id: string): Promise<void> {
      // iOS 仅 ASR 有自研下载可取消（翻译走系统翻译，无下载）。中止在途 + 删除该模型残留。
      if (kind !== 'asr') return;
      try {
        await RealtimeAsr.cancelDownload({ id });
      } catch {
        /* 无原生壳/未在途：忽略 */
      }
    },

    // ===== 归档（Preferences）=====
    async saveArchive(name: string, lines: ArchiveLine[]): Promise<ArchiveSummary[]> {
      return withArchiveOperation('save', undefined, async () => {
        const records = await readArchives();
        const createdAt = Date.now();
        const record: ArchiveRecord = { id: makeArchiveId(createdAt), name, createdAt, lines };
        records.push(record);
        await writeArchives(records);
        return listSummaries(records);
      });
    },
    async listArchives(): Promise<ArchiveSummary[]> {
      return withArchiveOperation('load', undefined, async () => listSummaries(await readArchives()));
    },
    async getArchive(id: string): Promise<ArchiveRecord | null> {
      return withArchiveOperation('open', id, async () => {
        const record = (await readArchives()).find((r) => r.id === id);
        if (!record) throw new ArchiveOperationError('open', 'not-found', 'Archive not found', id);
        return record;
      });
    },
    async deleteArchive(id: string): Promise<ArchiveSummary[]> {
      return withArchiveOperation('delete', id, async () => {
        const records = await readArchives();
        if (!records.some((r) => r.id === id)) {
          throw new ArchiveOperationError('delete', 'not-found', 'Archive not found', id);
        }
        const remaining = records.filter((r) => r.id !== id);
        await writeArchives(remaining);
        return listSummaries(remaining);
      });
    },

    // ===== 回调注册（与 macOS preload 的 on* 语义一致：仅记录，事件由 subscribeNative 转发）=====
    onSetupProgress(cb: (progress: SetupProgress) => void): (() => void) {
      return setupProgressCb.on(cb);
    },
    onSegment(cb: (segment: SegmentPayload) => void): (() => void) {
      return segmentCb.on(cb);
    },
    onPartial(cb: (partial: PartialPayload) => void): (() => void) {
      return partialCb.on(cb);
    },
    onTranslation(cb: (translation: TranslationPayload) => void): (() => void) {
      return translationCb.on(cb);
    },
    onStatus(cb: (status: StatusPayload) => void): (() => void) {
      return statusCb.on(cb);
    },
    onMetrics(cb: (metrics: PipelineMetrics) => void): (() => void) {
      return metricsCb.on(cb);
    },
    onTranslationStatus(cb: (status: TranslationStatusPayload) => void): (() => void) {
      return translationStatusCb.on(cb);
    },
  };

  // 预读一次设置，填充缓存（异步，不阻塞返回）。与 UI 首次 getSettings() 共享同一次读。
  void readSettingsOnce();

  return api;
}
